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
