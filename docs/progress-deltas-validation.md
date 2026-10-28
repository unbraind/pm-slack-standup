# Progress delta validation

## Public tracker

Reproduce with `node test/progress-public.ts`. The probe archives only the public package tracker at `origin/main`, places it in a non-git scratch directory, makes its files and directories read-only, removes git from PATH, and verifies source byte hashes after all reads. It never accesses hosted tracker data.

Measured against `unbraind/pm-slack-standup` at `5c10bafbca1b9d0399a562cf8d4ac503ab345d99`:

| Measurement | Count |
| --- | ---: |
| Certified items | 106 |
| History pages | 106 |
| Verified history events | 1008 |
| Status activity events | 258 |
| Comment activity events | 222 |
| Foreign annotations | 235 |
| Passing-test / accepted-criterion / readiness gains | 0 / 0 / 0 |
| Invalid evidence / history refusals | 0 / 0 |
| Gains after final returned checkpoint | 0 |
| Source files byte-unchanged | 218 / 218 |

This tracker has no native recorded passing runs or explicit acceptance/readiness declarations. Comments describing tests remain activity. These measurements validate historical reads and honest absence; the synthetic real-SDK fixtures exercise positive evidence gains.

## Scope of state testing

The feature adds no import, export, sync, mutation plan, delivery journal, checkpoint file, lease or outbox. The explicit comment encoder is pure; owners persist it through native SDK comments. The regression model writes native state through SDK leased mutations and reads it back through the SDK, including old run/declaration replay, CRLF/whitespace variations, relationships and the native fields inspected by this package. It uses the SDK's own canonical item producer for normalization.

Status meaning is never inferred by this projection. It counts raw status edits as activity and makes no active/done/terminal decision. The existing random custom-registry role regression remains applicable to ordinary standup lifecycle sections.

Full source gates run in CI with npm and Bun at unchanged 100/100/100/100 coverage and zero duplication thresholds. Packed acceptance exercises the progress command through project-local npm/Bun hosts, npx/bunx, an actual npm global symlink and a Bun global installation. Local checks are focused because the shared host is saturated.

Focused checks: `node --test --test-concurrency=1 test/progress-deltas.test.ts test/smoke.test.ts` passed **13/13**; the new module measured **100% statements, branches, functions and lines**. The seeded real-SDK model passed **500 sequences / 1500 state mutations**, with no mismatches. Random operation selection, ambient focus and per-sequence cleanup keep scope explicit and fixture storage bounded. Native item normalization comes from `canonicalDocument`, not a test-owned normalizer.

Three behavioral reverts in disposable copies each failed the selected native-results regression: remove evidence deduplication, omit the target revision from evidence identity, or cite the final window revision for every gain. Restoring the implementation passed that regression. No mutated implementation remained in the package worktree.

The native linked test runner passed **1/1 commands, 7/7 tests**. Existing project policy disables automatic result persistence; no settings were changed to manufacture a recorded result. The receipt and source test command are linked on the feature tracker item.
