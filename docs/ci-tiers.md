# CI tiers

Required checks retain the exact names `test (22.18.0)` and `test (26)`.
PR and dispatch runs use quick depth on GitHub-hosted Ubuntu, cancel superseded
PRs, and cap every job at 30 minutes. The native Windows launcher job remains.

| Check | Code PR 22.18.0 | Code PR 26 | Docs/tracker PR (both) | Deep |
| --- | --- | --- | --- | --- |
| npm ci / prepare merge drivers | yes | yes | yes | four legs |
| Strict pm health / merge drivers | — | yes | yes | four legs |
| Build + build:test + tests | quick | quick via coverage | applicable docs suites | full |
| Committed dist existence / fresh-build drift proof | — | yes | pack builds tracked output | all four legs |
| Typecheck, lint, duplication, docstrings | — | yes | — | full gate |
| Coverage: unchanged 100% statements/lines/branches/functions | — | quick | — | full |
| Canonical complete-reader acceptance | — | yes | — | full gate |
| Production audit | — | yes | — | full gate |
| Pack file list / dry-run (README and changelog ship) | — | yes | yes | full gate |
| Packed npm/Bun minimum/current local/global and npx/bunx acceptance | suite | suite + gate | — | full gate |
| Changelog, release date and publish attestation | — | yes | yes | full gate |
| Identity audit, packaging, action-pin changelog/tracker provenance, decision guide | suite | suite | yes | full suite |
| Bun package-graph install smoke | — | yes | — | four legs |
| Windows argv/launcher tests and packed hosts | separate native job | same job | checkout/detection only | retained PR platform contract |
| CodeQL | separate matching-path workflow | same | filtered | matching main pushes + weekly schedule |

Deep runs main pushes, dispatch and daily at 02:29 UTC, separate from release
and weekly CodeQL. Four distinct `deep (node, package-manager)` jobs each run
one complete release gate. They use full depth, time scale 3, a 120-minute
ceiling and per-ref cancellation. The local pool is selected unless
`PM_LOCAL_DEEP=off`; local runners keep their npm cache and image-provided Bun.
Hosted fallback restores npm cache and sets up Bun. Every job logs Bun's version.
Literal conditional npm/Bun commands preserve publish-attestation auditability.

Default/unset depth remains full. Quick keeps the same deterministic prefix:
500-case corpora become 50; the 64-registry model becomes 25; the 150-window
property corpus becomes 25. All per-case assertions stay. Native progress
mutation counts derive from generated sequences; journal operation accounting
matches generated batches and retains a positive minimum. Large input, journal
limit, output-size, deadline and relationship contracts remain unchanged.

Only harness watchdogs and performance measurement ceilings scale. The packed
acceptance default command deadline validates a finite positive multiplier
before any child starts and rounds with Math.ceil. Explicit per-command test
budgets and product read timeouts remain unscaled; the test runner and outer
acceptance child timeout scale independently. The packed gate already proves
Bun and bunx paths, so a second full Bun release gate is unnecessary on PRs.
The engines-floor suite retains its embedded acceptance tests without separate
coverage, changelog or pack commands.

The owner measured 39,929 fleet runner-minutes/day and 45–90 minute PR wall time,
including about 28 minutes queueing. Successful main run 43681221535 showed
packed acceptance tests at 168–213 seconds, the commitment 500-seed model at
138 seconds and the progress model at 107 seconds. New quick measurements are
recorded in the tracker/PR as available; cross-host times do not prove a speedup.
Full local depth is reserved for post-merge CI Deep. Existing release workflows,
release verifier scripts and action SHA/version-comment contracts are unchanged.
