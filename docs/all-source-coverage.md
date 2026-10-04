# All-source standup coverage

Work item: [pm-slack-standup-7t31](../.agents/pm/issues/pm-slack-standup-7t31.toon).

The gate inventories every executable authored TypeScript file from the package
root, including operational scripts. Dependencies, test fixtures, generated
output, Git metadata and tracker data are outside this runtime-source inventory.
Declaration files are excluded; other type-only files must erase completely
through Node's native TypeScript stripping before they can leave the inventory.
There are no configured ignored files or coverage-ignore directives.

`coverageGate.thresholds` requires 100% lines, statements, branches and functions.
c8 uses explicit package-owned configuration and fresh counters. Unloaded source
files contribute zero coverage. The report's file inventory must match the
independent source walk. A failed run removes both LCOV and the JSON summary,
including when a file disappears during the suite or a behavioral assertion fails.
Hostile ambient c8 configuration cannot narrow the inventory.

Behavior tests create real disposable PM projects with `pm init`, use the actual
SDK and extension command/service entry points, and assert observable documents,
receipts, filesystem effects and HTTPS wire requests. Tooling tests run actual
Node processes and the installed lint, duplication and prepare policies. Packed
acceptance installs the real tarball with npm and Bun against current and minimum
supported hosts, plus an external host without project `node_modules`.

Three runtime bugs were reproduced before fixes: explicit webhook ports were
dropped; stdout ownership leaked between extension activations; Windows launch
validation and composition collected caller arguments separately. The fixes
preserve the port, keep stdout ownership within an activation, and validate and
compose one argument snapshot. Gate fixtures also reproduced inherited
`NODE_TEST_CONTEXT` suppressing a nested test run; the gate clears that marker
for its child runner.

Proofs for removal of unreachable runtime paths are in the corresponding commit
message and [runtime evidence](runtime-coverage-2026-10-04.md). They cover an
unused local cron helper, quote handling after validation of the same snapshot,
native-only Error catch paths, and transport failure diagnostics whose values
are always populated. Reachable credential and grouping fallbacks remain tested.

## Manual README acceptance

In a disposable project initialized by the pinned installed CLI, create one
in-progress, blocked, open and closed synthetic task, then install the packed
extension with `pm install <tarball> --project`. The closed fixture includes an
explicit author-controlled closing reason. Exercise the README commands:

```sh
pm standup --dry-run --format plain --include-done --days 7
pm standup export --format markdown --include-done --days 7
```

The export writes this standalone document to stdout:

```markdown
# 📊 pm standup — 2026-10-04

## 🏃 In Progress (1)
- [Task] Implement standup coverage

## 🚫 Blocked (1)
- [Task] Wait for fixture dependency

## ✅ Done (1)
- [Task] Create standup fixture

## 📋 Up Next (1)
- [Task] Review observable outputs (priority 2)
```

Its stderr receipt is `standup export: rendered 4 item(s) as md.` The preview
returns four section counts and the rendered text/Block Kit fallback. These
synthetic checks establish local package behavior; they do not establish hosted
Slack delivery, deployment, Windows execution or privacy remediation.

## Integrated release gate

`npm run release:check` passed with exit 0 on Node 24.19.0 and the installed
CLI/SDK 2026.10.4. The compiler enforces `erasableSyntaxOnly` for source and test
compilation. The complete coverage suite reports 241 passing tests and no skips.

| Dimension | Covered / total | Percent |
| --- | --- | --- |
| Lines | 4002 / 4002 | 100 |
| Statements | 4002 / 4002 | 100 |
| Branches | 1066 / 1066 | 100 |
| Functions | 130 / 130 | 100 |

The eleven measured files are:

- `index.ts`: all four metrics 100%.
- `scripts/accept-canonical-reader.ts`: all four metrics 100%.
- `scripts/accept-packed.ts`: all four metrics 100%.
- `scripts/coverage-gate.ts`: all four metrics 100%.
- `scripts/docstring-gate.ts`: all four metrics 100%.
- `scripts/duplication-gate.ts`: all four metrics 100%.
- `scripts/lint.ts`: all four metrics 100%.
- `scripts/main-invocation.ts`: all four metrics 100%.
- `scripts/prepare-merge-driver.ts`: all four metrics 100%.
- `scripts/verify-release-changelog-date.ts`: all four metrics 100%.
- `scripts/verify-release-publish-attestation.ts`: all four metrics 100%.

Exact pass lines from the integrated run:

```text
ℹ tests 241
ℹ pass 241
ℹ fail 0
ℹ skipped 0
duplication-gate: 0% duplicated lines (0/9440), 36 source(s), 0 clone pair(s), threshold 0%
docstring-gate: 11 file(s), 90 declaration(s) documented.
coverage-gate: 11 source file(s) reported; lines/statements/branches/functions thresholds met.
found 0 vulnerabilities
verify-release-publish-attestation: every publish invocation is attested.
```

Typecheck, lint, build, test compilation, dry-run packing and canonical-reader
acceptance also exited 0. No changelog regeneration was needed: its check passed.
The exact packed npm/Bun receipt is:

```json
{"ok":true,"receipts":[{"scenario":"npm-current","host_version":"2026.10.4","tracker_items":2,"rendered_items":2,"stderr_bytes":44,"fixtures_present":true},{"scenario":"bun-current","host_version":"2026.10.4","tracker_items":2,"rendered_items":2,"stderr_bytes":44,"fixtures_present":true},{"scenario":"npm-minimum","host_version":"2026.8.20","tracker_items":2,"rendered_items":2,"stderr_bytes":44,"fixtures_present":true},{"scenario":"bun-minimum","host_version":"2026.8.20","tracker_items":2,"rendered_items":2,"stderr_bytes":44,"fixtures_present":true},{"scenario":"npm-global-current","host_version":"2026.10.4","tracker_items":1,"rendered_items":1,"stderr_bytes":44,"fixtures_present":true}]}
```

## Tracker integration

The original coverage item was reused and remains open. Independent histories
from the runtime and tooling worktrees are preserved verbatim in
[evidence/runtime-coverage-history.jsonl](evidence/runtime-coverage-history.jsonl)
and [evidence/tooling-coverage-history.jsonl](evidence/tooling-coverage-history.jsonl).
The field-aware history driver refused one redundant remove after concurrent
collection edits. Receipt reconciliation could not prove the candidate, so that
tracker union was abandoned. The exact original tracker item/history was restored
and verified, and the integrated files, documents, tests and results were recorded
through normal audited PM mutations. No history repair was forced. The failed
hash-only receipt is preserved separately in
[evidence/runtime-abandoned-merge-receipt.json](evidence/runtime-abandoned-merge-receipt.json);
it describes an abandoned candidate, not an applied merge.

Both original source commits used SteveBot identity:
`09fa83763956c6fdaee3694cbb542b751f4988a5` and
`45e68dbfce46575ce3d245affa358b4adea991be`. The integrated code was reviewed before
the combined gate. A caller-context fixture additionally verifies that inherited
tracker overrides cannot redirect its disposable project's initialization.

The existing development-dependency audit and reachable-history privacy items
remain separate from this coverage result. The PR remains open; no publishing,
merging, hosted-data access or deployment is part of this change.
