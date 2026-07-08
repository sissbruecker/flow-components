---
name: pr-review
description: Review a GitHub pull request end to end — find, verify with PR intent, triage, and post inline + summary comments. Used by claude-review.yml.
argument-hint: <path to review overview file>
---

# PR review

Review a pull request and deliver the result **as GitHub comments** — a summary
comment plus one inline comment per kept finding. The comments are the
deliverable; do not also print the review as response text.

You review for **recall**: catch every real bug a careful reviewer would catch
in one sitting. Surfacing a real bug matters more than avoiding a false
positive, because a later verify pass removes the false positives.

## Review inputs

The single argument is the path to a review **overview file**:

$ARGUMENTS

Read that file first. It names the PR number and the absolute path to every
prepared input. Use those paths; do not compute your own diff or fetch your own
metadata. The PR number is needed to post the review (`gh pr comment <PR>`). The
overview points at:

- **PR metadata** (`pr-meta.json`): title, description, author, labels. The
  description states the intent the change is reviewed against.
- **Diff** (`pr.diff`): the complete review scope. **Changed files**
  (`pr-files.txt`).
- **Head**: the working tree is the PR head checkout — read related and
  surrounding code here.
- **Base**: the pre-change state, checked out separately — consult it when a
  finding depends on prior behavior.
- **Reference checkouts** (`reference/flow`, `reference/web-components`):
  read-only upstream context. `flow` is the Vaadin Flow framework (base
  component classes, `Element` API); `web-components` is the client-side Lit
  components this repo wraps. Pass a reference directory explicitly to any
  search; never mix it into a repo-wide search.

Pass these paths through to every subagent you launch — finders and verifiers
must be able to read the diff, the head/base trees, and the reference checkouts.

## Phase 1 — Find (5 finders, in parallel)

Launch **five finder subagents via the Agent tool, in one batch** so they run
concurrently. Each returns up to **6 candidates**, every candidate shaped
`{ file, line, summary, failure_scenario }` where `failure_scenario` is a
concrete inputs/state → wrong-output/crash trace (for cleanup, the concrete cost
instead).

Finders are **intent-light**: give each one the diff, the head/base trees, the
reference checkouts, and the PR *title* for orientation only. Tell them to
surface freely — intent-based filtering happens later, not in the finder. A
finder that silently drops a half-believed candidate defeats the verify step and
is the main cause of misses.

### Finder A — line-by-line diff scan
Read every hunk, line by line. Then read the enclosing function for each hunk —
bugs in unchanged lines of a touched function are in scope. For every line ask:
what input, state, timing, or platform makes this line wrong? Look for
inverted/wrong conditions, off-by-one, null/undefined deref, missing `await`,
falsy-zero checks, wrong-variable copy-paste, errors swallowed in catch,
unescaped regex metachars.

### Finder B — removed-behavior auditor
For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established.
If you can't find it, that's a candidate: a removed guard, a dropped error path,
a narrowed validation, a deleted test that covered a real case. Consult the base
checkout to see the prior behavior.

### Finder C — cross-file tracer
For each function the diff changes, find its callers (Grep the head tree,
including the integration-test IT modules and TS) and callees, and check whether
the change breaks any call site: a new precondition, a changed return shape, a
new exception, a timing/ordering dependency, or a parallel change in the same PR
that makes a call unsafe.

### Finder D — cleanup (reuse / simplification / efficiency)
Look only at code the diff adds or changes. Flag: new code that re-implements
something the codebase already has (Grep shared/utility modules and adjacent
files; name the existing helper); unnecessary complexity (redundant or derivable
state, copy-paste with slight variation, deep nesting, dead code left behind;
name the simpler form); wasted work (redundant computation or repeated I/O,
independent operations run sequentially, blocking work on a hot path; long-lived
objects built from closures that pin a large enclosing scope). State the
concrete cost, not a crash.

### Finder E — Vaadin wrapper-contract
This repo is Java Flow wrappers over web components. Check that the Java
wrapper's (and connector's) assumptions about the web component's
**properties, events, and DOM behavior** match the actual component. Use
`reference/web-components` for client-side property/event/DOM behavior and
`reference/flow` for base component and `Element` API behavior. Look for: an
event the connector listens for that the component does not dispatch in the
assumed shape; a property or model field the code reads that the component does
not populate; a DOM state assumption the component contradicts; an
attach-handler / connector-initialization convention (see `CLAUDE.md`) the
change violates. Treat these as **correctness** candidates.

## Phase 2 — Verify (intent-aware, one verifier per location)

Pool the candidates from finders **A, B, C, and E** (correctness and
wrapper-contract). Cleanup candidates from finder D **skip verification** and go
straight to triage.

Dedup the correctness pool by `(file, line)` (same defect, same location, same
reason → keep one). For each **distinct location**, launch **one adversarial
verifier subagent** via the Agent tool. Give every verifier:

- the diff and the relevant file(s),
- the **PR metadata** (title, description, labels) from `pr-meta.json`, and
- **reference-repo access** — instruct it to consult `reference/flow` /
  `reference/web-components` whenever the finding depends on framework or
  web-component behavior.

Each verifier returns exactly one verdict with evidence quoting real lines:

- **CONFIRMED** — can name the inputs/state that trigger it and the wrong output
  or crash. Quote the line.
- **PLAUSIBLE** — mechanism is real, trigger uncertain (timing, env, config).
  Default to PLAUSIBLE for realistic-but-uncertain bugs: concurrency races,
  nil/undefined on a rare-but-reachable path (error handler, cold cache, missing
  optional field), falsy-zero treated as missing, off-by-one on a boundary the
  code does not exclude, a regex/allowlist that lost an anchor.
- **REFUTED** — only when constructible from the code: factually wrong (quote
  the line), provably impossible (type/constant/invariant — show it), already
  guarded in this diff (cite the guard), pure style with no observable effect,
  **or explicitly documented in the PR description as intended behavior**.

Keep **CONFIRMED** and **PLAUSIBLE**. Drop **REFUTED**. A candidate whose
verifier returns no verdict is dropped.

## Phase 3 — Triage (significance and placement only)

Do **not** re-verify whether a finding is real — Phase 2 already did, with
intent. Only decide, for each survivor:

1. **Merge** semantic duplicates across the surviving set.
2. **Route** each finding:
    - **inline** — substantial correctness issues and regressions a maintainer
      would act on (wrong runtime behavior, crashes, leaks, broken API
      contracts, regressions this PR introduces).
    - **minor** — cleanup and low-severity nits → collapsed summary section, no
      inline comment.
    - **drop** — with a one-line reason (pre-existing code this PR does not
      change; failure scenario you cannot confirm by reading the code).
      Investigate before dropping when unsure. Cleanup candidates, which had no
      verifier, are first filtered here against the PR intent.

Rank when trimming: correctness > cleanup; CONFIRMED > PLAUSIBLE. Cap inline
findings at 10.

## Phase 4 — Post

1. **One summary comment** with `gh pr comment <PR>` (write the body to a file
   and use `--body-file` to avoid quoting issues): a 2–3 sentence overview of
   what the PR does, then the kept findings as a `file:line — summary` list.
   Below that, two collapsed `<details>` sections (omit either when empty):
   **"Minor suggestions"** (the minor set) and **"Dropped findings"** (one line
   per dropped finding with the reason). Leave a blank line after each
   `<summary>` tag so the markdown inside renders.
2. **One inline comment per kept finding** with
   `mcp__github_inline_comment__create_inline_comment` (confirmed: true),
   anchored to the finding's file and line: state what is wrong in one sentence,
   then the concrete failure scenario. Add a ` ```suggestion ` block only when
   it fully fixes the issue within the commented line range.
3. If **nothing** survives triage, post only the summary comment saying the
   review found no significant issues.
