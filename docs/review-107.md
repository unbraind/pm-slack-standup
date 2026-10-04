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

Final local validation: the tracker-linked `npm run release:check` passed with
exit code 0, 235 tests and zero failed or skipped tests. All 11 executable source
files measured 100/100/100/100. The gate reported:

```text
duplication-gate: 0% duplicated lines (0/8918), 36 source(s), 0 clone pair(s), threshold 0%
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
