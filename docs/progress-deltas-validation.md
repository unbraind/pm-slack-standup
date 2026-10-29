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

Full source gates run in CI with npm and Bun at unchanged 100/100/100/100 coverage and zero duplication thresholds. Packed acceptance exercises the progress command through project-local npm/Bun hosts, npx/bunx, an actual npm global symlink and a Bun global installation. Initial local checks were focused because the shared host is saturated; the re-review also ran both full local gates serially with at most two workers.

Focused checks: `node --test --test-concurrency=1 test/progress-deltas.test.ts test/smoke.test.ts` passed **13/13**; the new module measured **100% statements, branches, functions and lines**. The seeded real-SDK model passed **500 sequences / 1500 state mutations**, with no mismatches. Random operation selection, ambient focus and per-sequence cleanup keep scope explicit and fixture storage bounded. Native item normalization comes from `canonicalDocument`, not a test-owned normalizer.

Three behavioral reverts in disposable copies each failed the selected native-results regression: remove evidence deduplication, omit the target revision from evidence identity, or cite the final window revision for every gain. Restoring the implementation passed that regression. No mutated implementation remained in the package worktree.

The native linked test runner passed **1/1 commands, 7/7 tests**. Existing project policy disables automatic result persistence; no settings were changed to manufacture a recorded result. The receipt and source test command are linked on the feature tracker item.

## Read-only history review regression

The re-review found that the native `history` command can bootstrap a missing stream under `history.missing_stream=auto_create`, and that its JSONL parser error escaped the progress refusal contract. The same command appeared in the ordinary standup reader. Both now use one shared SDK primitive path: locate the canonical item, read an existing history snapshot, read the current document, and verify their agreement. No history maintenance or write-hook dispatch belongs to this path.

`test/history-readonly.test.ts` passed **3/3**. It checks six missing/empty/JSONL/shape/conflict/hash cases under both history policies, discovers every registered report command, covers both exporter formats, and checks SDK and CLI JSON/default output. It compares authoritative file bytes, names, modes and mtimes, and additionally checks derived files for direct progress reads. The ordinary reader retains core certified-list behavior, including native rebuildable runtime caches. An installed native on-write extension remains silent during report refusals and fires for an explicit native auto-create control. Valid current and retained deleted histories remain readable; ordinary standups still accept verified compacted streams while progress refuses them conservatively.

Two independent behavioral reverts in disposable copies each failed the SDK adversarial regression: restoring the maintenance-capable history command or letting `history_json_invalid` escape. Restoring the shared primitive reader passed. Every packed npm/Bun local/global and npx/bunx scenario repeats missing-stream and malformed-JSONL refusals in both output modes with automatic history creation enabled.

The public read-only probe was repeated with the fix: **106 items, 1008 events, 0 refusals, 0 replay gains, 218/218 unchanged files**. The minimum supported SDK **2026.10.20** loaded every required read primitive and the native error class. No dependency or host floor changed.

The re-review full local commands, `npm run release:check` and `bun run release:check`, each completed **297/299 passing tests**, with **2 packed-matrix subprocess timeouts**, zero skips and zero cancellations. Both retained the existing 290-second matrix limit. All runtime modules measured **100/100/100/100**; whole-package coverage was incomplete because those matrix subprocesses did not finish. These are failed local gates, not release certification. Scenario diagnostics locate the timeouts in the early npm/Bun installed-host phases. Exact-head CI must provide the remaining full-matrix evidence.
