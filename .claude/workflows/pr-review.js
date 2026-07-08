export const meta = {
  name: 'pr-review',
  description:
    'PR code review that finds real defects from the diff (intent-blind fan-out), then judges each once against both the code and the PR’s stated intent, producing a final disposition (inline / summary / dropped) so no second triage pass is needed.',
  whenToUse:
    'Launched by the Claude Code Review CI workflow. Reads a pre-computed review scope from files and returns findings already sorted into inline / minor / dropped buckets. Pass args as a JSON object of scope paths.',
  phases: [
    { title: 'Scope' },
    { title: 'Find' },
    { title: 'Judge' },
    { title: 'Synthesize' },
  ],
}

// ---------------------------------------------------------------------------
// Design (see code-review-skill-extracted/ for the rationale):
//   Find is intent-blind and high-recall  —  it surfaces every real behavior
//   change, including intended ones.  Judge is the single verification pass:
//   it sees the code AND the PR intent, and answers both "is it real?" and
//   "does it matter for this PR?" at once, emitting the final disposition.
//   There is deliberately no second triage step and no effort lever.
// ---------------------------------------------------------------------------

const A = typeof args === 'object' && args ? args : {}
const PR = A.pr || '(unknown)'
const DIFF = A.diff
const FILES = A.files
const META = A.meta
const BASE = A.base
const HEAD = A.head
const REFS = Array.isArray(A.references) ? A.references : []

if (!DIFF || !META || !FILES) {
  return {
    error:
      'pr-review requires args.diff, args.meta and args.files (paths to the pre-computed review scope).',
  }
}

const PER_ANGLE = 8
const CLEANUP_CAP = 12
const INLINE_CAP = 15

// ─── Finder angles (intent-blind lenses) ─────────────────────────────

const ANGLE_A = `### Line-by-line diff scan
Read every hunk in the diff, line by line. Then read the enclosing function for
each hunk — bugs in unchanged lines of a touched function are in scope. For every
line ask: what input, state, timing, or platform makes this line wrong? Look for
inverted/wrong conditions, off-by-one, null/undefined deref, missing await,
falsy-zero checks, wrong-variable copy-paste, error swallowed in catch, unescaped
regex metachars.`

const ANGLE_B = `### Removed-behavior auditor
For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established. If
you can't find it, that's a candidate: a removed guard, a dropped error path, a
narrowed validation, a deleted test that was covering a real case.`

const ANGLE_C = `### Cross-file tracer
For each function the diff changes, find its callers (Grep for the symbol) and
check whether the change breaks any call site: a new precondition, a changed
return shape, a new exception, a timing/ordering dependency. Also check callees:
does a parallel change in the same PR make a call unsafe?`

const ANGLE_D = `### Language-pitfall specialist
Scan for the classic pitfalls of the diff's language/framework — JS falsy-zero,
== coercion, closure-captured loop var; Java NPE on autoboxing, mutable static
state, equals/hashCode; timezone/DST drift; float equality; resource not closed.
Flag any instance the diff introduces.`

const ANGLE_E = `### Wrapper/proxy correctness
When the PR adds or modifies a type that wraps another (cache, proxy, decorator,
adapter, connector): check that every method routes to the wrapped instance and
not back through a registry/session/global. Check that mutable flags read off a
shared object (e.g. item.selected, item.detailsOpened) reflect the intended state
at the moment they are read, and that the wrapper forwards all methods callers
actually use.`

const CLEANUP = `### Cleanup (reuse, simplification, efficiency)
Review the changed code through EACH of these lenses; you do not need findings
from every lens — prioritize the highest-cost issues.
- Reuse: new code that re-implements something the codebase already has. Grep
  shared/utility modules and files adjacent to the change; name the existing
  helper to call instead.
- Simplification: redundant or derivable state, copy-paste with slight variation,
  deep nesting, dead code left behind. Name the simpler form that does the same job.
- Efficiency: redundant computation or repeated I/O, independent operations run
  sequentially, blocking work on hot paths, objects that retain a whole enclosing
  scope. Name the cheaper alternative.`

const ALTITUDE = `### Altitude
Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix isn't
deep enough — prefer generalizing the underlying mechanism over adding special
cases.`

const CONVENTIONS = `### Conventions (CLAUDE.md)
Find the CLAUDE.md files that govern the changed code (repo-root CLAUDE.md plus
any CLAUDE.md in a directory that is an ancestor of a changed file). Read each one
and check the diff for clear violations. Only flag a violation when you can quote
the exact rule and the exact line that breaks it — no style preferences. Name the
CLAUDE.md path and quote the rule. If no CLAUDE.md applies, return nothing.`

const FINDERS = [
  { label: 'A-line-scan', kind: 'correctness', cap: PER_ANGLE, text: ANGLE_A },
  { label: 'B-removed-behavior', kind: 'correctness', cap: PER_ANGLE, text: ANGLE_B },
  { label: 'C-cross-file', kind: 'correctness', cap: PER_ANGLE, text: ANGLE_C },
  { label: 'D-language-pitfalls', kind: 'correctness', cap: PER_ANGLE, text: ANGLE_D },
  { label: 'E-wrapper-proxy', kind: 'correctness', cap: PER_ANGLE, text: ANGLE_E },
  { label: 'cleanup', kind: 'cleanup', cap: CLEANUP_CAP, text: CLEANUP },
  { label: 'altitude', kind: 'altitude', cap: 6, text: ALTITUDE },
  { label: 'conventions', kind: 'conventions', cap: 6, text: CONVENTIONS },
]

// ─── Schemas ───────────────────────────────────────────────

const SCOPE_SCHEMA = {
  type: 'object',
  required: ['intentSummary', 'changeSummary', 'files'],
  properties: {
    intentSummary: { type: 'string', description: 'What the PR is trying to achieve, from its title/description, including any behavior changes it documents as intended.' },
    changeSummary: { type: 'string', description: 'Neutral one-paragraph description of what the diff actually changes.' },
    files: { type: 'array', items: { type: 'string' }, description: 'repo-relative changed file paths' },
    claudeMdFiles: { type: 'array', items: { type: 'string' } },
  },
}

const CANDIDATES_SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'summary', 'failure_scenario'],
        properties: {
          file: { type: 'string', description: 'repo-relative path exactly as listed in the changed-files list' },
          line: { type: 'number' },
          summary: { type: 'string' },
          failure_scenario: { type: 'string', description: 'concrete inputs/state → user-visible consequence' },
        },
      },
    },
  },
}

const JUDGE_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'category', 'reality', 'relevance', 'impact', 'reason', 'evidence'],
        properties: {
          index: { type: 'number', description: 'the [i] label of the candidate this verdict is for' },
          category: { enum: ['correctness', 'simplification', 'efficiency', 'reuse', 'altitude', 'conventions', 'test-coverage'] },
          reality: { enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'], description: 'is the mechanism real and reachable from the code?' },
          relevance: { enum: ['INTRODUCED', 'PRE_EXISTING', 'INTENDED'], description: 'INTRODUCED: caused by this PR; PRE_EXISTING: present before this PR; INTENDED: a real change the PR description documents as its goal' },
          impact: { enum: ['HIGH', 'LOW'], description: 'HIGH: a maintainer would act on it (wrong behavior, crash, leak, broken API, regression); LOW: minor/cosmetic/theoretical' },
          reason: { type: 'string', description: 'why this verdict; for INTENDED/PRE_EXISTING quote the PR line or the pre-existing code that proves it' },
          evidence: { type: 'string', description: 'quote the relevant code line(s)' },
        },
      },
    },
  },
}

const SYNTH_SCHEMA = {
  type: 'object',
  required: ['overview', 'decisions'],
  properties: {
    overview: { type: 'string', description: '2-3 sentence overview of what the PR does and the review outcome' },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index'],
        properties: {
          index: { type: 'number', description: 'the [i] label of a finding to keep' },
          merge: { type: 'array', items: { type: 'number' }, description: '[i] labels of findings describing the same root cause, folded into this one' },
        },
      },
    },
  },
}

// ─── Phase 0: Scope ────────────────────────────────────────

phase('Scope')
const scope = await agent(
  'Establish the scope of a pull-request review from pre-computed files. Do not run git diff — the diff is already captured.\n\n' +
    '1. Read the PR metadata JSON at ' + META + ' (fields: title, body, author, labels). From title + body, write intentSummary: what the PR is trying to achieve, INCLUDING any behavior change it documents as intended or acceptable (quote such statements).\n' +
    '2. Read the changed-files list at ' + FILES + ' and the unified diff at ' + DIFF + '. Write changeSummary: a neutral paragraph of what the diff changes (no judgement).\n' +
    '3. List the changed files (repo-relative).\n' +
    '4. List the CLAUDE.md files that apply to the changed files (repo-root CLAUDE.md plus any CLAUDE.md in an ancestor directory of a changed file).\n\n' +
    'Structured output only.',
  { label: 'scope', schema: SCOPE_SCHEMA }
)

const emptyResult = (msg, stats) => ({
  pr: PR,
  summaryMarkdown: '## Code review\n\n' + msg + '\n\n---\n\n🤖 Reviewed with the `pr-review` workflow',
  inlineComments: [],
  overview: msg,
  inline: [],
  minor: [],
  dropped: [],
  stats: stats,
})

if (!scope) return { pr: PR, error: 'Scope agent returned no result.', summaryMarkdown: '## Code review\n\nThe review could not establish scope and did not run.\n\n---\n\n🤖 Reviewed with the `pr-review` workflow', inlineComments: [] }
if (!scope.files || scope.files.length === 0) {
  return emptyResult('No changed files found to review.', { finders: 0, candidates: 0, judged: 0 })
}
log('pr-review #' + PR + ': ' + scope.files.length + ' changed files')

const claudeMd = scope.claudeMdFiles || []
const refsLine = REFS.length ? REFS.map((r) => '  - ' + r).join('\n') : '  (none)'

// Neutral scope block for finders — deliberately WITHOUT the PR intent, so
// finders stay high-recall and never self-censor a real change as "intended".
const FINDER_SCOPE =
  '## Review scope\n' +
  'Unified diff (the complete review scope): ' + DIFF + '\n' +
  'Changed files:\n' + scope.files.map((f) => '  - ' + f).join('\n') + '\n' +
  'Head checkout (read related/surrounding code here): ' + (HEAD || '(current working directory)') + '\n' +
  'Base checkout (pre-change state): ' + (BASE || '(not provided)') + '\n' +
  'Upstream reference checkouts (read-only, for framework/web-component context):\n' + refsLine + '\n\n' +
  '## What changed\n' + scope.changeSummary + '\n'

// Full scope block for judges — includes the PR intent so they can rule a real
// change INTENDED.
const JUDGE_SCOPE =
  FINDER_SCOPE +
  '\n## PR intent (what the author set out to do)\n' + scope.intentSummary + '\n' +
  'Full PR description: ' + META + ' (read it when a candidate may be an intended change).\n'

// ─── Phase 1: Find (intent-blind, barrier) ──────────────────────

const canonFile = (raw) => {
  if (!raw) return ''
  const p = String(raw).replace(/\\/g, '/')
  let best = ''
  for (const sf of scope.files) {
    if ((p === sf || p.endsWith('/' + sf)) && sf.length > best.length) best = sf
  }
  return best || p
}
const loc = (c) => c.file + (c.line != null ? ':' + c.line : '')
const inBounds = (i, n) => Number.isInteger(i) && i >= 0 && i < n

const FINDER_PROMPT = (f) =>
  '## Code-review finder — ' + f.label + '\n\n' + FINDER_SCOPE + '\n' +
  'Review ONLY through the lens below. Judge nothing about whether a change is intended — that is decided later; your job is recall.\n\n' +
  f.text + '\n\n' +
  'Surface up to ' + f.cap + ' candidate findings, each with file, line, a one-line summary, and a concrete failure_scenario (the user-visible consequence). ' +
  'Pass through every candidate with a nameable failure scenario — do not drop half-believed ones; an independent judge evaluates them next. ' +
  'If nothing qualifies, return an empty list.\n\nStructured output only.'

phase('Find')
const finderOuts = await parallel(
  FINDERS.map((f) => () =>
    agent(FINDER_PROMPT(f), { label: f.label, phase: 'Find', schema: CANDIDATES_SCHEMA }).then((r) => {
      if (!r) return []
      log(f.label + ': ' + r.candidates.length + ' candidates')
      return r.candidates.slice(0, f.cap).map((c) => ({ ...c, file: canonFile(c.file), finderKind: f.kind }))
    })
  )
)
const candidates = finderOuts.filter(Boolean).flat()
if (candidates.length === 0) {
  return emptyResult((scope.changeSummary || '') + '\n\nNo issues surfaced in the changed code.', { finders: FINDERS.length, candidates: 0, judged: 0 })
}

// ─── Phase 2: Judge (single intent-aware pass, one agent per location) ───

const JUDGE_PROMPT = (group) =>
  '## Code-review judge\n\n' + JUDGE_SCOPE + '\n' +
  '## Candidate findings at ' + loc(group[0]) + '\n' +
  group.map((c, i) => '[' + i + '] ' + c.summary + '\n    Failure scenario: ' + c.failure_scenario).join('\n') + '\n\n' +
  'Read the diff, the relevant file(s) in the head checkout, and the base checkout when a candidate depends on prior behavior. Judge EACH candidate independently on its own claim and return one verdict per candidate, referenced by its [i] index.\n\n' +
  'For each candidate decide four things:\n' +
  '- reality: CONFIRMED (you can name inputs/state that trigger the wrong output/crash — quote the line), PLAUSIBLE (mechanism real, trigger uncertain), or REFUTED (factually wrong, guarded elsewhere, or provably impossible — quote the proof). Default to PLAUSIBLE for realistic-but-uncertain states; REFUTE only when constructible from the code.\n' +
  '- relevance: INTRODUCED (this PR causes it), PRE_EXISTING (it was already true before this PR — check the base checkout), or INTENDED (a real change the PR description documents as its goal or explicitly accepts — quote the PR line).\n' +
  '- impact: HIGH (a maintainer would act on it: wrong runtime behavior, crash, leak, broken API contract, regression) or LOW (minor, cosmetic, or theoretical).\n' +
  '- category: correctness, simplification, efficiency, reuse, altitude, conventions, or test-coverage.\n\n' +
  'Structured output only. reason must justify the verdict (for INTENDED/PRE_EXISTING quote the PR line or the pre-existing code); evidence must quote the relevant code line(s).'

phase('Judge')
const byLoc = Object.create(null)
for (const c of candidates) (byLoc[loc(c)] || (byLoc[loc(c)] = [])).push(c)
const groups = Object.values(byLoc)

const judged = (
  await parallel(
    groups.map((g) => async () => {
      const short = (g[0].file.split('/').pop() || g[0].file)
      const r = await agent(JUDGE_PROMPT(g), { label: 'judge:' + short + '(' + g.length + ')', phase: 'Judge', schema: JUDGE_SCHEMA })
      if (!r) return []
      const byIdx = {}
      for (const v of r.verdicts) if (inBounds(v.index, g.length)) byIdx[v.index] = v
      // A candidate the judge did not render a verdict on is dropped, same as the
      // built-in review — never surface an unjudged candidate.
      return g.flatMap((c, i) => (byIdx[i] ? [{ ...c, ...byIdx[i] }] : []))
    })
  )
)
  .filter(Boolean)
  .flat()

// ─── Disposition (deterministic, no model judgement) ───────────────

const dispose = (v) => {
  const reason = (v.reason || '').trim()
  if (v.reality === 'REFUTED') return { disposition: 'DROP', dropReason: 'Not a real issue — ' + (reason || v.evidence || '') }
  if (v.relevance === 'INTENDED') return { disposition: 'DROP', dropReason: 'Intended by this PR — ' + reason }
  if (v.relevance === 'PRE_EXISTING') return { disposition: 'DROP', dropReason: 'Pre-existing, not introduced by this PR — ' + reason }
  if (v.category === 'correctness' && v.impact === 'HIGH') return { disposition: 'INLINE' }
  return { disposition: 'SUMMARY' }
}

for (const f of judged) Object.assign(f, dispose(f))
const kept = judged.filter((f) => f.disposition !== 'DROP')
const dropped = judged.filter((f) => f.disposition === 'DROP')

// ─── Phase 3: Synthesize (merge dupes, order, overview) ─────────────

phase('Synthesize')
const rank = (c) => (c.category === 'correctness' ? 0 : 2) + (c.reality === 'PLAUSIBLE' ? 1 : 0)
const ordered = kept.slice().sort((a, b) => rank(a) - rank(b))

let overview = scope.changeSummary || ''
let finalKept = ordered

if (ordered.length > 0) {
  const block = ordered
    .map((c, i) => '### [' + i + '] ' + loc(c) + ' (' + c.category + ', ' + c.reality + ', ' + c.disposition + ')\n' + c.summary + '\nFailure scenario: ' + c.failure_scenario + '\nEvidence: ' + c.evidence)
    .join('\n\n')
  const synth = await agent(
    '## Synthesis: final PR-review report\n\n' +
      'PR intent: ' + scope.intentSummary + '\n\n' +
      ordered.length + ' findings survived judgement, numbered [0]-[' + (ordered.length - 1) + ']:\n\n' + block + '\n\n' +
      '## Instructions\n' +
      'Return decisions BY INDEX — never re-emit finding text.\n' +
      '1. For each distinct defect emit one decision with its index. When several findings describe the same root cause, keep one and list the rest in its merge array.\n' +
      '2. Order decisions most-severe first (correctness before cleanup).\n' +
      '3. Write a 2-3 sentence overview: what the PR does and the review outcome.\n\nStructured output only.',
    { label: 'synthesize', schema: SYNTH_SCHEMA }
  )
  if (synth) {
    if (synth.overview) overview = synth.overview
    const merged = new Set()
    for (const d of synth.decisions || []) for (const m of d.merge || []) if (inBounds(m, ordered.length)) merged.add(m)
    const picked = []
    const seen = new Set()
    for (const d of synth.decisions || []) {
      const i = d.index
      if (inBounds(i, ordered.length) && !merged.has(i) && !seen.has(i)) { picked.push(i); seen.add(i) }
    }
    // Never silently drop a survivor the synthesizer forgot to list: append any
    // kept finding that was neither picked nor merged, preserving rank order.
    for (let i = 0; i < ordered.length; i++) if (!seen.has(i) && !merged.has(i)) picked.push(i)
    if (picked.length) finalKept = picked.map((i) => ordered[i])
  }
}

const toOut = (c) => ({ file: c.file, line: c.line, summary: c.summary, failure_scenario: c.failure_scenario, category: c.category, reality: c.reality })
const inline = finalKept.filter((c) => c.disposition === 'INLINE').slice(0, INLINE_CAP).map(toOut)
const minor = finalKept.filter((c) => c.disposition === 'SUMMARY').map(toOut)
const droppedOut = dropped.map((c) => ({ file: c.file, line: c.line, summary: c.summary, dropReason: c.dropReason }))

log('pr-review #' + PR + ': ' + inline.length + ' inline, ' + minor.length + ' minor, ' + droppedOut.length + ' dropped')

// ─── Render the deliverables in JS (deterministic) ─────────────────
// The launcher agent posts these verbatim; no formatting decisions are left
// to the model.

const at = (c) => '`' + c.file + (c.line != null ? ':' + c.line : '') + '`'
const bullet = (c) => '- ' + at(c) + ' — ' + c.summary

const summaryParts = ['## Code review', '', overview || 'Reviewed the changes in this PR.', '']
if (inline.length) {
  summaryParts.push('**Findings**', '')
  for (const c of inline) summaryParts.push(bullet(c))
} else {
  summaryParts.push('No blocking issues found in the changed code.')
}
if (minor.length) {
  summaryParts.push('', '<details>', '<summary>Minor suggestions</summary>', '')
  for (const c of minor) summaryParts.push(bullet(c))
  summaryParts.push('', '</details>')
}
if (droppedOut.length) {
  summaryParts.push('', '<details>', '<summary>Dropped findings</summary>', '')
  for (const c of droppedOut) summaryParts.push('- ' + at(c) + ' — ' + c.summary + ' (' + c.dropReason + ')')
  summaryParts.push('', '</details>')
}
summaryParts.push('', '---', '', '🤖 Reviewed with the `pr-review` workflow')
const summaryMarkdown = summaryParts.join('\n')

// Inline comments only for findings that carry a line to anchor to; any without
// one still appear in the summary "Findings" list, so nothing is lost.
const inlineComments = inline
  .filter((c) => c.line != null)
  .map((c) => ({ path: c.file, line: c.line, body: c.summary + (c.failure_scenario ? '\n\n' + c.failure_scenario : '') }))

return {
  pr: PR,
  summaryMarkdown,
  inlineComments,
  overview,
  inline,
  minor,
  dropped: droppedOut,
  stats: {
    finders: FINDERS.length,
    candidates: candidates.length,
    judged: judged.length,
    locations: groups.length,
    inline: inline.length,
    minor: minor.length,
    droppedCount: droppedOut.length,
  },
}
