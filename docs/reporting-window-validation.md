# Cursor-complete reporting window evidence

Tracker: [pm-slack-standup-kovw](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-kovw.toon).

The `standup window` command reads the native mutation-event journal through the
SDK. It retains an opaque cursor and per-stream offsets instead of introducing
another journal. Stdout-only calls preview; `--output` atomically delivers a
packet under the SDK generation-fenced admission lease before retaining the exact next boundary.
The host floor is pm CLI 2026.10.27, whose public `acquireLockLease().fence()`
prevents a lost lock generation from publishing with the built-in lock provider; an extension `lock_acquire`
override runs `fence()` unfenced and must exclude or fence concurrent commits itself. The development SDK pin
is unchanged.
Use a separate cursor for each independent reporting consumer. Consume a delivered
packet before requesting the next window with the same output file.

| Acceptance criterion | Regression evidence | Behavioral revert proof |
| --- | --- | --- |
| Restart after rendering produces the same packet | `a restart reproduces the same packet until the boundary is admitted` compares complete packets; `delivery failure retains the old boundary and crash replay preserves the delivered packet` interrupts boundary retention after delivery and compares the recovery packet | Ignoring preview protection makes restart equality fail; restored test passes |
| Late or backdated append appears exactly once in a later admitted window | `a late backdated append appears exactly once in the next admitted window` appends a valid native event dated before the retained boundary, admits it, and proves the following window is empty | Returning only timestamp/position membership drops the event and fails the test; restored test passes |
| Missing history or cursor coverage is incomplete | `an item deletion is reported as deleted work, and lost history coverage marks the report incomplete`; `lost cursor coverage is incomplete and never advanced`; final-page/continuation cursor tests | Disabling history regression detection or cursor coverage certification makes the respective regression fail; all restored tests pass |

Selected regression commands use `node --test --test-concurrency=2` with
`--test-name-pattern` and `test/reporting-window.test.ts`. The four patterns are
`a restart reproduces`, `a late backdated append`, `an item deletion is reported`,
and `lost cursor coverage`.

Reverts run only in a disposable non-git copy. The five mutants each exit 1;
the restored five-test selection exits 0. The fifth mutant moves empty/preview
file delivery outside the shared lease and fails the peer-output regression. Real SDK fixtures are used throughout.
Malformed or missing history on a live corpus item remains a typed
`history_unavailable` refusal, consistent with other standup reports; it never
produces a complete packet. Missing pagination cursors refuse before admission.
Lost retained stream/count coverage produces an incomplete packet.

The seeded model test (`0x20261027`) uses a non-git tracker and independently
models unseen `(stream, version)` identities read through the SDK. It exercises
older-input replay, CRLF/whitespace/unicode values, relationships, status changes,
custom lifecycle roles, deletion, backdated events, previews, and crash replay.
The measured run uses 521 operations and 27 windows, partitioning 458 SDK
events without omissions or duplicates. The window module independently measures
100% lines, statements, branches and functions across 37 focused window tests, plus the seeded model test.

Public-data validation is reproducible with:

```sh
node test/reporting-window-public.ts
```

Source: public `unbraind/pm-slack-standup` tracker at
`57cc37afb12b9334778d8a2c529ce8b8c4763d89`. Only tracked files from that commit are
copied into a non-git temporary directory; copied authoritative files are made
read-only. The source checkout is never modified. Measurements:

| Measurement | Result |
| --- | ---: |
| Corpus items | 109 |
| Mutation events | 1,099 |
| Streams | 110 |
| SDK pages at limit 1,000 | 2 |
| Copied authoritative files, all unchanged | 224 |
| Compact JSON packet bytes | 15,036 |
| Section rows: active / blocked / done / up next | 0 / 0 / 102 / 5 |
| Touched items named in `unsectioned_items` (both canceled) | 2 |
| Incomplete reasons | 0 |
| Restart packet equality | exact |

The six packed acceptance scenarios exercise the exact fresh tarball with npm
and Bun, current and minimum hosts, project-local `npx`/`bunx`, and npm/Bun global
host installations. Each verifies window preview replay, TOON/JSON agreement,
atomic delivery before admission, boundary chaining, and empty replay.


## Local release-gate results

Before the CI timing remediation below, both `npm run release:check` and
`bun run release:check` ran with isolated Git
identity and at most two workers. Each completed **348/350 passing tests**, with
only the two instrumented packed matrices exceeding their unchanged 290-second
subprocess deadline. All nine runtime modules measured **100% in all four
coverage dimensions**. The interrupted acceptance-script paths left global
coverage at **96.17% lines/statements, 99.88% branches, 97.59% functions**; both
release gates correctly failed their unchanged 100% thresholds. Follow-up:
[pm-slack-standup-packed-timing](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-packed-timing.toon).

Fresh `node scripts/accept-packed.ts` and `bun scripts/accept-packed.ts` each
passed all six installed-host scenarios for source commit `415328b`
(historical: the later window changes are covered by fresh CI on the reviewed
head). Their
129,382-byte tarballs were byte-identical, contained 45 entries and all four
window module artifacts, and declared host floor 2026.10.27. The
[artifact receipt](evidence/reporting-window-artifact.json) records the SHA-256
and immutable source commit; no tarball is committed.

Actual installed-CLI probes separately passed five checks: a capped window,
three invalid-limit refusals, and explicit `--no-advance --output` delivering a
preview without admitting a cursor. The final five behavioral mutants each
failed; restoring the implementation passed the five-case selection.

Typecheck, lint, zero-duplication (69 TypeScript files, zero clone pairs), and
docstrings (139 declarations in 19 source files) passed. Canonical-reader,
production audit (zero vulnerabilities), pack inventory, changelog, release-date
and publish-attestation checks passed. Exact-head CI remains the complete release
validation; local timing failures are not presented as passing gates.


## CI timing remediation

The first pushed head's Node 22 CI completed 349/350 tests: one packed matrix
hit the unchanged 290-second deadline, while the other finished in 264.544
seconds. Its complete 19-source coverage report met 100% in every dimension,
but the failed test correctly kept the job red.

The acceptance driver now shares only package download caches within its own
temporary run. Every installation, tracker, configuration and global-data path
remains separate. Fixture audit/funding work is disabled; the independent
production audit gate remains enabled. Installed consumers no longer inherit the
canonical V8 counter directory, since their copies are outside the source
inventory. The acceptance driver and canonical source-helper subprocesses retain
profiling. No assertions, six-scenario matrix, launcher mode, worker limit,
290-second timeout, source inventory or 100% threshold was removed or reduced.

The linked window/model suite passes 35/35 and focused driver contracts pass
12/12. Reverting consumer counter isolation fails its regression; restoration
passes 1/1. Types, lint and zero duplication pass; docstrings now cover 140
declarations in the same 19 source files. Shipped runtime files and the exact
recorded artifact are unchanged. The replacement pushed head requires fresh CI.
