#!/usr/bin/env node
/**
 * Post the code-review findings to the PR as one review.
 *
 * Runs in code-review.yml as a plain workflow step (NOT by Claude), after
 * the claude-code-action step. Reads the action's execution file (a JSON array
 * of events) and takes the input of the LAST ReportFindings tool call — never the result
 * event text. No ReportFindings call at all means the review was lost
 * (background-subagent failure mode): the script exits non-zero instead of
 * posting, so a lost review is never mistaken for a clean one. An empty
 * findings array is a real result and posts a body-only "no findings" review.
 *
 * Routing (category first, then verdict — verdict measures confidence,
 * category measures whether a finding is worth an interruption):
 *   issue tier (correctness, altitude) + CONFIRMED → inline review thread,
 *     demoted line-level → file-level → summary list as anchoring fails
 *   issue tier + PLAUSIBLE → collapsed "Possible issues" section
 *   everything else (cleanup tier, unknown categories) → collapsed
 *     "Suggestions" section
 *
 * Posting uses the GraphQL pending-review flow so all threads and the summary
 * land as ONE review (single notification), and a per-thread anchoring failure
 * demotes that finding instead of breaking the whole review:
 *   delete stale pending reviews → addPullRequestReview (pending) →
 *   addPullRequestReviewThread per inline finding → submitPullRequestReview.
 * Runs without inline findings post a body-only review in one call.
 *
 * Reads from the environment (set by GitHub Actions):
 *   PR_NUMBER / argv[2]  pull request number reviewed
 *   EXECUTION_FILE       JSON transcript of the review run
 *   GITHUB_REPOSITORY    owner/repo
 *   GH_TOKEN             token for the gh CLI; its identity is the review
 *                        author
 *   DRY_RUN              if set, print the routing and rendered bodies and
 *                        exit without calling the GitHub API
 *
 * Usage:
 *   node .github/claude/post-review.js <pr-number>
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const MAX_BUFFER = 100 * 1024 * 1024;

// Categories worth interrupting a reviewer for; everything else — reuse,
// simplification, efficiency, conventions, unknown slugs, missing category —
// is cleanup. Allowlist, so new/unexpected slugs land in the quiet tier.
const ISSUE_CATEGORIES = new Set(['correctness', 'altitude']);

function capture(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} must be set`);
    process.exit(2);
  }
  return value;
}

// Run a GraphQL query/mutation via gh. Numbers go through -F so they arrive
// typed; everything else as strings (valid over the wire for enums and IDs).
function graphql(query, variables = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  }
  return JSON.parse(capture('gh', args)).data;
}

// The action writes the execution file as a single JSON array of events.
function readEvents(executionFile) {
  const events = JSON.parse(fs.readFileSync(executionFile, 'utf8'));
  if (!Array.isArray(events)) {
    throw new Error('Execution file is not a JSON array of events');
  }
  return events;
}

// The input of the LAST ReportFindings tool_use in the transcript. Keyed on
// the tool call, never on result events: --fix re-reporting and stray extra
// result events both produce earlier/other candidates.
function extractReport(executionFile) {
  let report = null;
  for (const event of readEvents(executionFile)) {
    if (event.type !== 'assistant') continue;
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use' && block.name === 'ReportFindings') {
        report = block.input;
      }
    }
  }
  return report;
}

function normalize(finding) {
  return {
    ...finding,
    category: (finding.category || 'uncategorized').toLowerCase(),
    verdict: (finding.verdict || 'PLAUSIBLE').toUpperCase(),
  };
}

function route(findings) {
  const inline = [];
  const possible = [];
  const suggestions = [];
  for (const finding of findings.map(normalize)) {
    if (!ISSUE_CATEGORIES.has(finding.category)) {
      suggestions.push(finding);
    } else if (finding.verdict === 'CONFIRMED') {
      inline.push(finding);
    } else {
      possible.push(finding);
    }
  }
  return { inline, possible, suggestions };
}

// --- Rendering ------------------------------------------------------------
// Raw category and verdict appear on every finding, inline and in sections:
// the tiering is an experiment and real runs need to show what landed where.

function badge(finding) {
  return `\`${finding.category}\` · ${finding.verdict.toLowerCase()}`;
}

function fileLabel(finding) {
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

// Link to the blob at the head SHA so collapsed findings stay clickable.
function fileLink(repo, headSha, finding) {
  if (!finding.file) return '`unknown file`';
  const anchor = finding.line ? `#L${finding.line}` : '';
  return `[\`${fileLabel(finding)}\`](https://github.com/${repo}/blob/${headSha}/${encodeURI(finding.file)}${anchor})`;
}

// Continuation lines are indented so multi-line failure scenarios stay inside
// the list item.
function listItem(repo, headSha, finding) {
  const scenario = (finding.failure_scenario || '').trim().replace(/\n/g, '\n  ');
  return `- **${fileLink(repo, headSha, finding)}** ${badge(finding)} — ${finding.summary}\n  ${scenario}`;
}

function section(title, items) {
  // Blank line after </summary> or the markdown inside won't render.
  return [
    '<details>',
    `<summary>${title} (${items.length})</summary>`,
    '',
    items.join('\n'),
    '',
    '</details>',
  ].join('\n');
}

function threadBody(finding, { aroundLine } = {}) {
  const parts = [];
  if (aroundLine) {
    parts.push(`_Around line ${aroundLine} — could not attach to the exact diff line._`);
  }
  parts.push(`**${finding.summary}**`, finding.failure_scenario || '', badge(finding));
  return parts.filter(Boolean).join('\n\n');
}

// Summary body: unanchored confirmed issues stay visible (not collapsed);
// PLAUSIBLE issues and cleanup fold into counted sections; empty sections are
// omitted. Zero-findings runs still post, so "reviewed, nothing found" is
// distinguishable from "review never happened".
function summaryBody(repo, headSha, { unanchored, possible, suggestions }, inlineCount) {
  const parts = [];
  if (unanchored.length) {
    parts.push(
      '**Confirmed issues that could not be attached to the diff:**\n\n' +
        unanchored.map((f) => listItem(repo, headSha, f)).join('\n')
    );
  }
  if (possible.length) {
    parts.push(section('Possible issues', possible.map((f) => listItem(repo, headSha, f))));
  }
  if (suggestions.length) {
    parts.push(section('Suggestions', suggestions.map((f) => listItem(repo, headSha, f))));
  }
  if (!parts.length) {
    parts.push(inlineCount > 0 ? `${inlineCount} finding(s) posted as review comments.` : 'No findings.');
  }
  return parts.join('\n\n');
}

// --- Posting ----------------------------------------------------------------

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      headRefOid
      reviews(states: PENDING, first: 10) { nodes { id } }
    }
  }
}`;

// Only works on PENDING reviews, and pending reviews are only visible to
// their author — so everything the query above returns is a leftover of ours
// (a crashed previous run would otherwise block creating a new one forever).
const DELETE_PENDING = `mutation($reviewId: ID!) {
  deletePullRequestReview(input: {pullRequestReviewId: $reviewId}) {
    pullRequestReview { id }
  }
}`;

const ADD_PENDING = `mutation($prId: ID!) {
  addPullRequestReview(input: {pullRequestId: $prId}) {
    pullRequestReview { id }
  }
}`;

const ADD_BODY_ONLY = `mutation($prId: ID!, $body: String!) {
  addPullRequestReview(input: {pullRequestId: $prId, event: COMMENT, body: $body}) {
    pullRequestReview { url author { login } }
  }
}`;

const ADD_LINE_THREAD = `mutation($reviewId: ID!, $path: String!, $line: Int!, $body: String!) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $reviewId, path: $path, line: $line, side: RIGHT,
    subjectType: LINE, body: $body
  }) { thread { id } }
}`;

const ADD_FILE_THREAD = `mutation($reviewId: ID!, $path: String!, $body: String!) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $reviewId, path: $path, subjectType: FILE, body: $body
  }) { thread { id } }
}`;

const SUBMIT_REVIEW = `mutation($reviewId: ID!, $body: String!) {
  submitPullRequestReview(input: {pullRequestReviewId: $reviewId, event: COMMENT, body: $body}) {
    pullRequestReview { url author { login } }
  }
}`;

// Try-then-demote: line-level → file-level → summary list. Anchoring rules
// (line must be in the PR diff; renamed/deleted/binary files) are GitHub's to
// judge — any error demotes, nothing breaks the review.
function postThread(reviewId, finding) {
  if (finding.file && finding.line) {
    try {
      graphql(ADD_LINE_THREAD, {
        reviewId,
        path: finding.file,
        line: finding.line,
        body: threadBody(finding),
      });
      return true;
    } catch {
      console.warn(`Line thread failed for ${fileLabel(finding)}, retrying file-level`);
    }
  }
  if (finding.file) {
    try {
      graphql(ADD_FILE_THREAD, {
        reviewId,
        path: finding.file,
        body: threadBody(finding, { aroundLine: finding.line }),
      });
      return true;
    } catch {
      console.warn(`File thread failed for ${finding.file}, demoting to summary`);
    }
  }
  return false;
}

function logPosted(review) {
  console.log(`Posted review ${review.url} as ${review.author.login}`);
  if (review.author.login !== 'claude') {
    console.warn(
      'Review was NOT attributed to claude[bot] — is the Claude GitHub App installed on this repository?'
    );
  }
}

function main() {
  const prNumber = process.argv[2] || process.env.PR_NUMBER;
  if (!prNumber) {
    console.error('PR number required (argv[2] or PR_NUMBER)');
    process.exit(2);
  }
  const repo = requireEnv('GITHUB_REPOSITORY');
  const executionFile = requireEnv('EXECUTION_FILE');

  const report = extractReport(executionFile);
  if (!report) {
    console.error(
      'No ReportFindings call in the execution file — the review was lost; refusing to post.'
    );
    process.exit(1);
  }
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const routed = route(findings);
  console.log(
    `Findings: ${findings.length} total — ${routed.inline.length} inline candidate(s), ` +
      `${routed.possible.length} possible issue(s), ${routed.suggestions.length} suggestion(s)`
  );

  if (process.env.DRY_RUN) {
    const sections = { unanchored: [], ...routed };
    console.log('\n--- inline thread bodies ---');
    for (const finding of routed.inline) {
      console.log(`\n[${fileLabel(finding)}]\n${threadBody(finding)}`);
    }
    console.log('\n--- summary body ---\n');
    console.log(summaryBody(repo, 'HEAD', sections, routed.inline.length));
    return;
  }

  const [owner, name] = repo.split('/');
  const pr = graphql(PR_QUERY, { owner, name, number: Number(prNumber) }).repository.pullRequest;

  for (const stale of pr.reviews.nodes) {
    console.warn(`Deleting stale pending review ${stale.id}`);
    graphql(DELETE_PENDING, { reviewId: stale.id });
  }

  if (!routed.inline.length) {
    const body = summaryBody(repo, pr.headRefOid, { unanchored: [], ...routed }, 0);
    const result = graphql(ADD_BODY_ONLY, { prId: pr.id, body });
    logPosted(result.addPullRequestReview.pullRequestReview);
    return;
  }

  const pending = graphql(ADD_PENDING, { prId: pr.id });
  const reviewId = pending.addPullRequestReview.pullRequestReview.id;

  const unanchored = [];
  let posted = 0;
  for (const finding of routed.inline) {
    if (postThread(reviewId, finding)) {
      posted += 1;
    } else {
      unanchored.push(finding);
    }
  }

  const body = summaryBody(repo, pr.headRefOid, { unanchored, ...routed }, posted);
  const result = graphql(SUBMIT_REVIEW, { reviewId, body });
  logPosted(result.submitPullRequestReview.pullRequestReview);
}

main();
