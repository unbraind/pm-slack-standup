# Evidence-bearing progress deltas

`pm standup progress ITEM --json` reads one item's verified native history. Default output is compact TOON. It never runs linked tests, posts to Slack, changes tracker state, or makes a review judgment. Iterate explicit item ids from the host SDK's certified `listAllComplete` when reporting a whole project.

Lifecycle counts and ordinary comments are `activity`. Only newly observed native passing run summaries or explicit versioned evidence declarations enter `gains`. A passing run reports its recorded linked-command count, not an inferred number of test assertions. Runs with failures, skips, zero passes or invalid counts (passes must be an integer in 1..1000000; failures and skips must be exactly zero) supply no gains. Historical results describe their recorded revision, not current code health.

Each gain includes `evidenceRevision`, `targetRevision` and `revision: {version,digest}`. The last pair identifies the immutable native history entry using the SDK canonical record hash that first introduced it. `pm get ITEM --at VERSION --full` retrieves that state. Native runs use `run:RUN_ID` as their evidence revision and the owning item version as their target revision. Explicit assessments preserve their supplied artifact revisions.

## Windows and retries

```sh
pm standup progress sample-task --events 20 --json > first.json
# Retain the exact next string from first.json in the caller's own delivery state.
pm standup progress sample-task --after TOKEN --events 20 --json
```

`from` is the exclusive lower history version, `through` is inclusive, and `remaining` counts events beyond this page. The `next` token binds a digest of the canonical item id, through version and complete immutable prefix digest. Events appended later, including backdated events, remain after that boundary. Reusing a token reproduces the same page when its selected history has not grown. Advancing to the returned token avoids recounting evidence. Reading without a token deliberately replays historical progress; it is not a new delivery window.

All preceding history is replayed through the SDK before evaluating a window. Reimporting an old run id, or replaying a declaration with different JSON indentation, CRLF or surrounding field whitespace, supplies no new gain. Declaration identity includes kind, subject, target revision, evidence revision and value. The same evidence applied to a different target revision is distinct. Exact duplicate comments are ignored. Tokens are receipts, not authorization secrets or tamper-proof signatures; callers must retain the returned token and never fabricate it.

No checkpoint or outbox is written by this package. The caller owns delivery, checkpoint persistence and any lease needed to coordinate its own competing consumers. Independent readers can safely inspect the same tracker. If a peer appends during a read, the SDK either returns a verified immutable prefix or refuses; retry using the original token. Do not advance a delivery checkpoint until its corresponding page is delivered.

## Explicit assessments

Core acceptance criteria are text; pm-review's `reviewed` means attention, not acceptance. To report an accepted criterion or readiness assessment, record an explicit attributable comment with the native `client.comments` API. The package supplies one strict schema shared by its producer and validator:

```ts
import { encodeProgressEvidence, readProgressDeltas } from 'pm-slack-standup';

// client is the host SDK client; the assessor, not this report, decides acceptance.
await client.comments('sample-task', {
  add: encodeProgressEvidence({
    version: 1,
    kind: 'criterion',
    subject: 'AC1',
    targetRevision: 'artifact-v2',
    evidenceRevision: 'acceptance-receipt-v3',
    value: 'accepted',
  }),
});
const report = await readProgressDeltas(context, 'sample-task', { events: 20 });
```

The comment prefix is `standup-progress/v1 ` followed by that JSON object. Only those six keys are allowed. `kind` is `criterion` or `readiness`; `value` is respectively `accepted` or `ready|not_ready`. Each string is nonempty after trimming, at most 256 UTF-16 units and has no control characters or Unicode line separators. This is an explicit declared assessment, not independent verification, automatic review approval or a claim inferred from status names. Readiness includes regressions (`not_ready`) as well as gains. Use a new evidence revision for a new assessment. A readiness assessment with the same value for the same subject and target is counted as `ignored.unchanged`, not a readiness change. A declaration comment is bounded to 8192 characters.

`encodeProgressEvidence`, `parseProgressEvidence`, `parseProgressOptions`, `readProgressDeltas`, `ProgressEvidence`, `ProgressGain`, `ProgressRevision`, `ProgressReport`, `ProgressOptions` and `ProgressRefusal`, `inspectProgressComment` and `validateProgressNumbers` are public typed exports. `readProgressDeltas` accepts the host context's `pm_root` and optional injected `sdk`; standalone consumers use the existing supported SDK adapter. No executable or symlink discovery occurs.

## Bounds and refusals

`events` is an integer in 1..500 (default 100). `outputBytes` is an integer in 1024..32768 (default 8192), measured as UTF-8 JSON projection bytes. TOON presentation may have different byte length. `after` is at most 1024 characters. Invalid options refuse before any tracker read. Pages never truncate a gain or advance past omitted evidence: an oversized page refuses, and the caller reduces `events` or increases the budget.

| Code | Remedy |
| --- | --- |
| `invalid_input` | Use the documented strict schema and finite bounded options. |
| `checkpoint_mismatch` | Select this item's original token and append-only history, or explicitly restart a historical replay. |
| `history_unavailable` | Inspect full verified history and recover missing, corrupt or compacted coverage before reporting. |
| `invalid_output` | Retry and check the installed package; output counters failed finite bounded integer validation. |
| `output_limit` | Increase the budget or reduce the event page; retain the original checkpoint. |

Refusals have `code`, `remedy` and CLI `exitCode: 2`. Missing items and every native history lookup, I/O, parsing, verification or current-document mismatch return `history_unavailable`. SDK errors retain `remedy`; JSON CLI problems expose the same guidance as `required`, and plain/TOON invocations print it with the refusal. Compacted history refuses conservatively because an omitted earlier observation could otherwise be counted twice. Individual invalid declarations and malformed passing-run summaries are counted in `ignored.invalid`; ordinary comments are `ignored.foreign`. Their bodies never enter the output. Preexisting records remain readable and untouched. All counts are finite safe integers; no ratio or floating threshold decision is used.

## Without git

History reads use SDK `locateItem`, `readHistorySnapshot`, `readLocatedItem` and `verifyHistoryEntries`; they never invoke the maintenance-capable `history` command. Missing streams refuse under both `auto_create` and `strict_error`, without creating a baseline or invoking write hooks. Ordinary standups, decisions, aliases and exports use this same verified reader; their existing certified list calls may rebuild native derived runtime caches, while authoritative item, configuration and history bytes remain unchanged.

The report, schema producer and SDK read-back work in plain directory trackers and require no git executable. Delivery and external artifact verification remain the caller's responsibility.
