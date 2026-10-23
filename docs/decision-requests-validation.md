# Decision request validation

Public snapshot: `unbraind/pm-slack-standup` main
`72775d7df1f6471243bbda349a3212b65e048a65` (2026-10-23), package version
`2026.10.23`, pinned pm SDK `2026.10.20`.

The feature already shipped through [PR #142](https://github.com/unbraind/pm-slack-standup/pull/142).
This refresh verifies that implementation against the current public snapshot;
it adds no duplicate command or decision storage. Core `pm plan` owns recorded
decisions and core `pm next` separates human-gated decisions. `pm-brief` composes
general decision context and compares declared alternatives; `pm-slack` owns
delivery receipts. This package owns periodic presentation of explicitly declared
requests and links to the canonical place to respond or find an acknowledgment.

The tracked `.agents/pm` snapshot was extracted with `git archive` into a fresh
non-git scratch directory. Its 202 files and tracker directories were made
read-only. The package's canonical complete-list reader and the pinned SDK's
`PmClient.listAllComplete({ includeBody: true })`, certified by
`certifyCompleteListResult`, independently returned the same 98 canonical IDs.
Then `collectDecisionRequests` and a plain standup with decisions and completed
work enabled were rendered.
SHA-256 hashes of every copied tracker file were identical before and after.
A Git discovery ceiling confirmed that the copy was outside a repository.
Complete reads and rendering with only Node on PATH returned 98 items and zero
requests. Only aggregate measurements are recorded here.
No declaration was added to the public snapshot to fabricate a positive result.

| Measurement | Result |
| --- | ---: |
| Complete tracker items, package reader / native SDK | 98 / 98 |
| In progress / open / closed / canceled | 2 / 2 / 92 / 2 |
| Decision items | 2 |
| Explicitly declared requests | 0 |
| Emitted / omitted requests | 0 / 0 |
| Compact JSON decision report | 201 bytes |
| Plain standup with decisions and completed work | 8456 bytes |
| Tracker files unchanged by SHA-256 | 202 / 202 |

This validates that existing Decision items are not inferred as requests. Positive
requests, private alternatives, existing acknowledgment links, supersession,
closure and malformed declarations are covered separately by synthetic data in
real SDK-created non-git trackers. The registered CLI is exercised in JSON and
TOON, with a PATH containing only Node and the pm launcher, and a Git discovery
ceiling above the scratch directory. The test reconciles TOON and JSON output
and checks that invalid options exit 2.

| Acceptance criterion | Current evidence |
| --- | --- |
| Only declared requests appear | Two existing public Decision items produce zero requests without the exact opt-in tag and declaration; the positive SDK/CLI fixture emits one explicitly tagged request. |
| Closed/superseded requests disappear deterministically | Real SDK updates suppress a superseded declaration, restore a pending declaration, then suppress the closed item; pure regressions cover terminal aliases and deadline/ID ordering. |
| Private alternatives respect disclosure policy | JSON, TOON, ordinary exports, periodic text and Block Kit exclude the private sentinel; private requests are withheld entirely and alternative counts remain explicit. |
| Typed, bounded agent output and remedies | Public SDK contracts compile; registered CLI JSON and TOON agree; byte/row caps retain whole rows and omissions; invalid declarations/options return typed refusals and CLI exit 2. |
| Documentation and no-git operation | README usage and the packaged schema/example are exercised through the actual installed CLI in a non-git tracker without Git on PATH. |

Local targeted validation passed typecheck, lint, both builds, and 102 tests
(9 decision-request tests plus 93 export/unit tests), with zero failures,
skips, cancellations or todo cases. The same 102 tests passed through the
pinned `pm test` runner; existing project policy disables result persistence,
so the receipt is recorded in tracker comments.

Fresh behavioral revert proof: replacing only `collectDecisionRequests` with
an empty-section implementation made both selected declaration/presentation
regressions fail (0/2 passed). The original source was restored byte-identically
in a `finally` block and both selected regressions passed again. This refresh
changes documentation and tracker evidence only; runtime source and committed
distribution output remain identical to the delivered feature.

Targeted verification:

```sh
npm run typecheck
npm run build
npm run build:test
npm run lint
npm run docstring
npm run duplication
node --test test/decision-requests.test.ts
node --test test/runtime-export.test.ts test/units.test.ts
```

The earlier module-specific V8/c8 measurement was 100% statements, branches,
functions and lines. That is historical module evidence. Current full-source
evidence comes from the CI release gates for npm and Bun at unchanged 100%
thresholds; the PR records the exact run URL and counts after completion.
URL syntax validation cannot establish that a linked resource is public;
authors must approve disclosure. The byte budget covers compact JSON, while
the host's TOON whitespace can differ.
