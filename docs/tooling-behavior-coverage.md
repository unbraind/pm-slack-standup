# Tooling behavior coverage

PM item: [pm-slack-standup-7t31](../.agents/pm/issues/pm-slack-standup-7t31.toon).

The tooling suite measures every `scripts/*.ts` file except the separately owned
`scripts/coverage-gate.ts`. The exact nine-file inventory includes packed and
canonical-reader acceptance, prepare, lint, duplication, docstrings, entry-point
selection, changelog dates and publish attestation. It does not establish coverage
of `index.ts`, test support sources, or the coverage gate itself; the orchestrator
verifies the combined all-authored-source scope after integrating the workers.

`accept-packed.ts` exposes platform selection, environment isolation, artifact
selection and receipt validation without packing on import. Its guarded entry
still runs all five real npm/Bun current, minimum and external-host scenarios.
Host versions are checked before initializing fixtures. Real Node subprocesses
exercise success, both diagnostic streams, missing executables, nonzero exits,
signals and deadlines. A real failing npm pack verifies removal of its temporary
workspace. The optional temporary parent lets that assertion own its directory
without inspecting or racing other acceptance runs.

Canonical-reader acceptance initializes a disposable workspace with the actual
installed PM CLI, creates a task, and asserts its title, status and generated ID.
The launch argument composer records the single complete-list invocation while
executing the real host. No fake PM response or parent environment mutation is
needed. Thin-launcher fixtures execute the installed ESLint and jscpd policies
and assert both success and actual violation diagnostics. Existing verifier and
prepare fixtures remain part of the measured suite; the prepare launcher stays
byte-identical to the installed pm-ops template.

The focused command is linked to the PM item with a 900-second timeout and runs
through `pm test pm-slack-standup-7t31 --run --progress --only-last`:

```sh
/tmp/standup-coverage-tools/node_modules/.bin/c8 \
  --all --extension .ts --include 'scripts/**' \
  --exclude 'scripts/coverage-gate.ts' \
  --reporter json --reporter text --check-coverage --per-file \
  --statements 100 --branches 100 --functions 100 --lines 100 \
  --reports-dir /tmp/standup-tooling-final \
  node --test test/accept-packed.test.ts test/tooling-launchers.test.ts \
  test/docstring-gate.test.ts test/prepare-merge-driver.test.ts \
  test/verify-release-changelog-date.test.ts \
  test/verify-release-publish-attestation.test.ts
```

The tool is the caller-provided temporary c8 installation. `NODE_V8_COVERAGE`
survives fixture environment cleaning, so the JSON report includes Node child
processes executing the original script paths. `--all` includes unexecuted
in-scope files, and per-file thresholds prevent a better-covered script from
covering a deficit elsewhere. Statement evidence comes from the JSON `s`
counters; branch and function counters are checked separately.

The final focused PM-linked run passed 58/58 tests with zero skipped tests and
exit code 0. Each file independently reports 100/100/100/100. The retained JSON
report is `/tmp/standup-tooling-final/coverage-final.json`, with the child V8
coverage files in `/tmp/standup-tooling-final/tmp`.

| Script | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| accept-canonical-reader.ts | 43/43 | 4/4 | 1/1 | 43/43 |
| accept-packed.ts | 278/278 | 93/93 | 10/10 | 278/278 |
| docstring-gate.ts | 84/84 | 8/8 | 2/2 | 84/84 |
| duplication-gate.ts | 6/6 | 1/1 | 0/0 | 6/6 |
| lint.ts | 6/6 | 1/1 | 0/0 | 6/6 |
| main-invocation.ts | 50/50 | 4/4 | 1/1 | 50/50 |
| prepare-merge-driver.ts | 65/65 | 10/10 | 0/0 | 65/65 |
| verify-release-changelog-date.ts | 341/341 | 74/74 | 10/10 | 341/341 |
| verify-release-publish-attestation.ts | 56/56 | 6/6 | 2/2 | 56/56 |
| Total | 929/929 | 201/201 | 26/26 | 929/929 |

`npm run build:test`, `npm run lint`, `npm run duplication` and
`npm run docstring` passed. Duplication found zero clone pairs across 28 sources;
docstrings cover 89 declarations in 11 source files.
The final `npm test` run also passed all 221 tests with zero skipped tests,
including the complete existing product suite and all five packed scenarios.

Windows and POSIX command names and npm JavaScript launcher paths are tested with
explicit platform inputs. Operational acceptance runs on Linux with Node 24.19.0;
these configuration assertions do not establish Windows subprocess acceptance.
Real packed tests require npm/Bun and registry access. The existing full
development-audit blocker remains tracked separately in
[pm-slack-standup-2sjh](../.agents/pm/issues/pm-slack-standup-2sjh.toon).

No product bug fix is claimed. The initial prepare identity failure was caused by
stale canonical dependencies and passed after `npm ci --ignore-scripts`; the
launcher was not changed. No package thresholds, source ignores, product entry,
coverage-gate implementation, publishing, or hosted state were changed.
