# index.ts runtime coverage evidence

Work item: `pm-slack-standup-7t31`; author: `codex-sol-runtime`.

The historical focused receipt below measures only `index.ts`. It does not certify all package
scripts, deployment, Slack-hosted delivery, Windows execution, or release readiness.
All PM data is synthetic, initialized through `pm init --defaults` in disposable
temporary projects and mutated/read through the installed package SDK. The real
SDK activation engine and `runCommand` dispatch execute the actual extension.
HTTPS tests use a loopback server and a generated certificate explicitly trusted
by the test process; normal TLS verification remains enabled.

## Test-first bugs

1. HTTPS transport discarded the explicit webhook URL port. The actual local
   HTTPS listener received no request before the fix; preserving `url.port`
   makes the asserted POST body, channel, path, and query arrive at that listener.
2. `exportStdoutViaService` leaked between activations. Activating a modern host
   before a legacy API host caused the latter to mark stdout as service-owned
   and emit no document. The regression failed with `raw_stdout: true` and an
   empty captured stream. Each activation now retains its own capability state.
3. Windows launch validation and quoting traversed caller arguments separately.
   A changing accessor supplied a quote-containing argument only on the second
   traversal. The regression failed with two reads. One snapshot must be both
   validated and composed so no unchecked value reaches the command tail.
   This command-tail implementation was subsequently superseded by the
   shell-free launch. One snapshot is now validated and passed as discrete argv;
   [PR 107 review evidence](review-107.md) describes the current launch.

## Unreachable-code proofs before removal

The stage-three c8 report measured 99.72% statements/lines, 99.04% branches,
99% functions. The following proofs refer to the implementation before the
removal commit and do not rely on coverage ignores or replacing `index.ts`.

- `parseCronField` declares the local `all` function but never references it.
  Wildcards already call `expandRange(min, max, step)`, including unstepped `*`.
  Tests assert 60 minute values and exercise empty parts, ranges, and cron OR.
  Removing the unused declaration cannot change a call result.
- `quoteWindowsArg` has exactly one call site: the Windows argument composition
  in `pmLaunchPlan`. Once that launch captures one snapshot, the same snapshot
  is first checked by `assertNoCmdVariableExpansion`, which throws for every
  literal double quote, then mapped through `quoteWindowsArg`. Its internal
  literal-quote escaping branch can therefore never run. Quote refusals and
  allowed metacharacter/backslash quoting remain tested. The snapshot fix is
  necessary before this proof holds; the old second traversal defeated it.
  This proof describes the earlier implementation. The shell-free launch later
  removed `quoteWindowsArg` entirely; see [PR 107 review evidence](review-107.md).
- `parseSchedule` catches only its own `fields.map(parseCronField)` call, on
  fields obtained by splitting a string. `parseCronField` throws only `Error`
  instances; native string/number/set/array operations also throw Error
  instances. Its non-Error diagnostic fallback has no native input path.
- `readPriorCounts` catches native `readFileSync(resolve(path), "utf-8")`,
  with a string path. Both operations throw Error instances, including actual
  missing-file/read failures tested here. Its non-Error fallback cannot occur.
- `readSnapshotHistory` catches only native `readFileSync` and `JSON.parse`,
  over string filenames from `readdirSync`. Filesystem exceptions and syntax
  errors are Error instances. Real malformed snapshots exercise this catch;
  there is no native non-Error catch path. Monkeypatching these native
  functions is outside this proof and is not used in the tests.
- `postToSlack`'s `https.request` response callback receives a numeric status
  from Node's HTTP parser. The local Node `_http_common` implementation sets
  `incoming.statusCode = statusCode` before dispatching the client callback;
  `@types/node/http.d.ts` describes `statusCode` as valid for a client response.
  A malformed status is a request error, not a response with a missing status.
  Thus the `?? "unknown"` status diagnostic fallback is unreachable over the
  real transport. Actual success, 503, reset, and timeout remain exercised.
- Every failure pushed by `postStandupTargets` has an own `error` string,
  obtained from an Error message or `String(err)`. The command passes only the
  private real `postToSlack`, whose rejection values are newly constructed
  Errors with string messages. The returned array is local to the command,
  filtered synchronously, and is never handed to a caller before formatting.
  Missing-error defaults in command fallback/error output cannot occur.

The credential defense and `groupLabel` fallback are retained: changing valid
accessors can reach them. Tests exercise both through actual activated handlers
or exported render functions on real disposable tracker data.

## Validation and boundaries

The final PR 107 review-fix tree passed `npm run release:check` against the
pinned SDK/CLI 2026.10.4: 238 tests passed, zero failed or skipped, and 89
declarations documented across 11 executable source files. All four package
coverage dimensions are 100%. In that same all-source run, `index.ts` reports
2723/2723 lines and statements, 839/839 branches, and 100/100 functions.
See the [all-source report](all-source-coverage.md) for the complete pass lines
and [PR 107 review evidence](review-107.md) for current shell-free launch tests.
The focused counts and declaration totals below are historical, before those
review fixes; they are not counts for the final head.

Baseline external c8: 90.44% statements/lines, 88.40% branches, 92.07% functions.
The focused receipt below used the installed SDK/CLI 2026.9.28. The combined
package gate subsequently passed against the pinned installed SDK/CLI 2026.10.4,
including the unchanged canonical merge-driver template check. See the
[all-source report](all-source-coverage.md) for the integrated receipt.

The PM-linked run completed with status `passed`, exit 0, 155/155 tests,
zero failures/cancellations/skips/todos, and 36.071490722 seconds of test time
(38.357 seconds for the linked command). The explicit 100% threshold check
passed for all four dimensions:

| Dimension | Covered / total | Percent | Skipped |
| --- | --- | --- | --- |
| Lines | 2946 / 2946 | 100 | 0 |
| Statements | 2946 / 2946 | 100 | 0 |
| Branches | 833 / 833 | 100 | 0 |
| Functions | 100 / 100 | 100 | 0 |

These are c8's V8-derived measurements, including its source-to-statement
mapping, over the complete `index.ts` file. There are no coverage ignore
directives and no mocked module-under-test exports.

Historical focused command, shown with repository-relative scratch tool and
report locations:

```sh
coverage/tools/node_modules/.bin/c8 --include=index.ts --check-coverage --lines=100 --statements=100 --branches=100 --functions=100 --reporter=json-summary --reporter=json --reporter=text --reports-dir=coverage/runtime-pm-verified node --test test/runtime-coverage.test.ts test/runtime-export.test.ts test/runtime-options.test.ts test/runtime-receipts.test.ts test/runtime-transport.test.ts test/units.test.ts test/complete-list.test.ts test/fetch-all-items.test.ts test/smoke.test.ts
```

Required tracker invocation:

```sh
PM_AUTHOR=codex-sol-runtime pm test pm-slack-standup-7t31 --run --progress --only-last
```

The run was trusted through local mutation provenance. PM's existing
test-result-tracking policy is disabled, so automatic result history recording
reported `tracking_disabled`; this document and the item comments preserve the
verified result without changing workspace policy.

Additional validation: `npm run typecheck`, `npm run lint`,
`npm run docstring` (11 files, 81 documented declarations),
`npm run duplication` (0%, zero clone pairs across 32 sources), and
`node_modules/.bin/tsc --noEmit --erasableSyntaxOnly -p tsconfig.test.json`
all passed. `git diff --check` passed.

The historical local scratch receipts were not committed. Historical measured
`index.ts` SHA-256:
`2d11d8fec88e2ab24266dabfd023de158653e1d54b90ea571abd62fc6d04ee82`.

The fixtures require OpenSSL to generate their disposable TLS certificate.
Windows argument validation and discrete argv launches are tested on Linux; no Windows process is
executed. The integrated package gate reruns these tests against the combined checkout
and pinned SDK/CLI 2026.10.4.
