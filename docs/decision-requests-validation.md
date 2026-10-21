# Decision request validation

Public snapshot: `unbraind/pm-slack-standup` main
`765b440ce656692c73bbcbafb5102ac3b3c8324b` (2026-10-21).

The tracked `.agents/pm` snapshot was extracted with `git archive` into a fresh
non-git scratch directory. Its 198 files were made read-only. The package's
canonical complete-list reader read the copy, then `collectDecisionRequests`
and a plain standup with decisions and completed work enabled were rendered.
SHA-256 hashes of every copied tracker file were identical before and after.
A Git discovery ceiling confirmed that the copy was outside a repository; a
second complete read with only Node on PATH also returned 96 items and zero requests.
No declaration was added to the public snapshot to fabricate a positive result.

| Measurement | Result |
| --- | ---: |
| Complete tracker items | 96 |
| In progress / open / closed / canceled | 5 / 5 / 84 / 2 |
| Decision items | 2 |
| Explicitly declared requests | 0 |
| Emitted / omitted requests | 0 / 0 |
| Compact JSON decision report | 201 bytes |
| Plain standup with decisions and completed work | 8172 bytes |
| Tracker files unchanged by SHA-256 | 198 / 198 |

This validates that existing Decision items are not inferred as requests. Positive
requests, private alternatives, existing acknowledgment links, supersession,
closure and malformed declarations are covered separately by synthetic data in
real SDK-created non-git trackers. The registered CLI is exercised in JSON and
TOON, with a PATH containing only Node and the pm launcher, and a Git discovery
ceiling above the scratch directory. The test reconciles TOON and JSON output
and checks that invalid options exit 2.

Targeted verification:

```sh
npm run typecheck
npm run build:test
npm run lint
npm run docstring
npm run duplication
node --test test/decision-requests.test.ts
node --test test/runtime-export.test.ts test/units.test.ts
```

The new module's targeted V8/c8 run measures 100% statements, branches,
functions and lines. This is module evidence; the complete authored-source
thresholds remain 100% in the CI release gates for npm and Bun.
