# PR 107 review fixes

CodeQL alert 5 and review 4178833820 identified library input joined into a
cmd.exe command tail. Windows PM reads now run the installed PM JavaScript
entry with the current Node executable and separate argv elements. Local npm
shims resolve beside their scoped package, global npm shims resolve below the
npm prefix, and the bare PM fallback searches Windows PATH in order. Explicit
JavaScript entries and native executables are supported. Unresolved wrappers
fail with a command error instead of invoking a shell.

The existing Windows refusal policy for double quotes, CR/LF and percent-named
variables remains. One captured argument snapshot is validated and passed to
the child. Shell quoting and the old command-tail parser tests were removed
with the command processor; argv preservation, shim layout, PATH lookup,
unresolved-entry refusal and real child execution replace those contracts.

Test-first evidence:

- `node --test --test-name-pattern='Windows PM entry receives hostile' test/fetch-all-items.test.ts`
  failed with a command-processor spawn error before the fix. It now executes a
  real Node child and proves `tracker with space & calc | whoami` arrives as
  exactly one argument with the complete canonical reader arguments intact.
- Greptile review 4178844811: `node --test --test-name-pattern='npm_execpath unset' test/accept-packed.test.ts`
  failed before packing because the old test guessed a nonexistent npm entry.
  The test now preserves the environment and runs both inherited and unset
  npm_execpath cases. The unset case uses a copied Node executable outside its
  installation tree, proving PATH lookup works without a guessed npm layout.
  Windows PATH configuration also resolves npm and npx JavaScript entries
  below the actual npm prefix, with a real-child fixture test for both entries.
  A supplied npm_execpath keeps precedence over PATH.
- Review 4178833812 was already fixed in commit 8217431. Grouping labels use
  literal `includes` matching instead of a partially escaped regular expression.
  `node --test test/runtime-options.test.ts` checks all four grouping labels.

The release gate retains all-source 100 percent lines, statements, branches
and functions, with no coverage ignores. Local execution establishes behavior
on the test host; Windows CI execution and the new CodeQL analysis remain
separate evidence. The alert is neither suppressed nor dismissed.

## Seven CodeRabbit follow-up findings

- 4179454059: removed the three generated `dist/` file links through `pm files`.
  A fresh `pm get --full` confirms none remain in the coverage item's files.
- 4179454064 and 4179454069: refreshed the all-source and runtime documents
  from the final release run and marked command-tail/`quoteWindowsArg` evidence
  as historical, superseded by the shell-free implementation described here.
- 4179454075: the global npm candidate already existed. Added real temporary
  local `.bin` and standard global prefix layouts to the bare PM PATH test;
  both entries execute real Node children and preserve discrete hostile argv.
  The refusal now names both supported layouts and the existing `fetchAllItems`
  `pmBin` parameter. This package has no `PM_BIN` environment override.
- 4179454080: a missing Windows npm/npx pair now throws an actionable error
  naming `npm_execpath` and `PATH`, instead of returning `.cmd` launchers.
  PATH candidates must contain both JavaScript entries; incomplete prefixes
  are skipped for a later complete pair. POSIX fallbacks remain supported.
- 4179454089: canonicalized the coverage root for inventory, c8 source/cwd and
  report comparison. A real directory-alias fixture failed with a report/source
  mismatch before the fix and now reports both sources at 100 percent.
- 4179454096: removed the timing ratio assertion. The warm-up and generous
  5,000 ms median ceiling guard argv copying/validation; Node's native quoting
  occurs in the later child launch and is not measured by this check.

The behavior-changing tests failed before their fixes. The PM PATH regression
already executed both supported layouts successfully before failing on the
missing refusal guidance. Missing npm and missing sibling npx cases both
returned unsupported launchers before the fix. The tracker-linked targeted
launch suite passed five tests; the directory-alias suite passed separately.

Exact targeted commands:

```sh
node --test --test-name-pattern="Windows bare pm PATH|Windows argv preserves|packed launch configuration|incomplete installations|Windows npm PATH lookup launches" test/fetch-all-items.test.ts test/accept-packed.test.ts
node --test --test-name-pattern="directory alias" test/coverage-gate.test.ts
```

Final local validation for the PR 107 review-fix tree: the tracker-linked
`npm run release:check` passed with exit code 0, 238 tests and zero failed or
skipped tests. All 11 executable source
files measured 100/100/100/100. The gate reported:

```text
ℹ tests 238
ℹ pass 238
ℹ fail 0
ℹ skipped 0
duplication-gate: 0% duplicated lines (0/9005), 36 source(s), 0 clone pair(s), threshold 0%
docstring-gate: 11 file(s), 89 declaration(s) documented.
coverage-gate: 11 source file(s) reported; lines/statements/branches/functions thresholds met.
found 0 vulnerabilities
verify-release-publish-attestation: every publish invocation is attested.
```

Both complete packed matrices passed, including current/minimum npm and Bun
hosts and an external npm host. Typecheck, lint, build, canonical-reader
acceptance, pack dry run, changelog consistency and release-date checks passed.
`tsc --noEmit --erasableSyntaxOnly -p tsconfig.test.json`, tracker health and
tracker validation also passed. The changelog required no regeneration.
