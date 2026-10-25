# SDK adoption validation

Tracker: [pm-slack-standup-jti0](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-jti0.toon).
Related adoption: [pm-slack-standup-xms9](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-xms9.toon).

| Audit finding | Replacement | Regression evidence |
| --- | --- | --- |
| `index.ts:1114-1142`: executable resolution, subprocess limits and JSON reads | Hosted commands and exporter use the invocation's `PmClient.listAllComplete({ includeBody: true })`; existing `certifyCompleteListResult` and presentation-field checks remain | Real tracker with neither Git nor PM on PATH; all command/export variants compared against the original build |
| `index.ts:1145-1148`: fixed lifecycle sets | `readSettings`, `resolveRuntimeStatusRegistry`, SDK alias normalization and `statusIsTerminal`; presentation aliases and section grouping remain package policy | Custom `terminal_done` alias, custom blocked role, canceled blocker, compact/text/Block Kit checks |
| `index.ts:41-70`: expected errors and exit map | SDK `EXIT_CODE` and `createPmCliExpectedError`; public `CommandError` constructor preserves `instanceof` compatibility | Expected-error discriminator, context and existing numeric exit codes |

The public synchronous `fetchAllItems(pmRoot, pmBin)` remains the standalone
adapter for callers explicitly selecting a PM executable or launch plan. The
asynchronous SDK client cannot preserve that synchronous API or executable
selection contract. Hosted commands never select this adapter. There is no
missing SDK API blocking the hosted replacements.

Every SDK read is certified, then each item's SDK `history` action freshly
verifies the chain and current document before the rows drive a report, post or
snapshot. This action invokes `verifyHistoryEntries` over authoritative history,
rather than treating the derived event index as integrity evidence. The
regression primes both complete reads and `listMutationEvents`, corrupts an
existing history hash, then checks command/export refusal and absence of output
and snapshot files. Malformed JSONL is also rejected.

## Differential proof

`test/sdk-adoption-differential.test.ts` rebuilds immutable pre-adoption main
commit `523c0786f085db52d585a7714598c90d38eeb3d0`, using the same pinned
dependencies as the refactor. Both builds run on non-git copies of public
tracker archives. The test compares stdout and complete returned receipts and
hashes authoritative tracker files before and after. SDK runtime caches are
excluded from that authoritative-byte inventory.

Public repositories and immutable input revisions:

| Tracker | Revision | Items | Identical outputs |
| --- | --- | ---: | ---: |
| pm-slack-standup | `523c0786f085db52d585a7714598c90d38eeb3d0` | 100 | 11 |
| pm-slack | `5c0bd37fa16a42956c6b2e33e491163f04a3d9a9` | 89 | 11 |

The 22 comparisons cover `standup` and `slack-standup` in plain, Markdown,
Slack and Block Kit formats, `standup decisions`, and Markdown/JSON exports.
All outputs match and both authoritative byte inventories remain unchanged.
Set `STANDUP_DIFFERENTIAL_TRACKERS` to a JSON array of additional archived public
tracker roots to repeat the additional-corpus proof; the baseline package
tracker is always tested.

Intentional differences, exercised with synthetic real trackers: configured
custom lifecycle roles and aliases now apply; canceled work with stale blocker
links stays out of Blocked; invalid history refuses the report even after cache
priming. Expected errors gain the SDK discriminator/context while preserving
messages, valid numeric exits and `instanceof CommandError`; the SDK constructor rejects nonpositive or nonfinite exit codes. The peer and manifest
host floor is 2026.10.20; the development dependency pin is unchanged.

## Behavioural revert proof

Each experiment restores the named pre-adoption behavior while retaining the
same tests. Each selected regression exits nonzero; restoring the refactor
passes all four focused regressions. Details are also recorded on the tracker.

| Reverted implementation | Selected test | Observed failure |
| --- | --- | --- |
| `readSdkStandupItems` delegates to the previous subprocess reader | `host SDK reads work` | The no-executable tracker read fails with exit 127 |
| Original `buildStandupData` and its removed status constants | `configured lifecycle roles` | Custom completed work disappears from Done |
| Original `CommandError` class | `SDK expected errors preserve` | Public SDK expected-error discriminator is absent |
| Fresh history verification loop removed | `history corruption after priming` | Corrupted cached history no longer refuses the report |

Commands use `node --test --test-name-pattern='<selected test>'
test/sdk-adoption.test.ts`. Normal verification uses
`node --test test/sdk-adoption.test.ts test/sdk-adoption-differential.test.ts`,
`npm run typecheck`, `npm run lint`, and the unchanged npm/Bun release gates.

## Measured gates

Both `npm run release:check` and `bun run release:check` pass with an isolated
home and global Git configuration disabled. Each runs 280 passing tests, one
canonical-reader acceptance test and five packed acceptance scenarios:
`npm-current`, `bun-current`, `npm-minimum`, `bun-minimum`, `npm-global-current`.
The pinned and minimum hosts are both 2026.10.20. The development pin was not
changed to the registry's current 2026.10.25 host.

Coverage inventories all 12 executable source files without exclusions:
4,055/4,055 lines and statements, 143/143 functions and 1,245/1,245 branches.
Every dimension remains at 100%. Typecheck, lint, zero duplication, docstrings,
production dependency audit, packaging, changelog and publish-attestation
checks also pass. Isolated-home strict tracker health passes; inherited global
extensions are outside this package's gate environment.

The patch removes 56 lines from `index.ts`, including the replaced status and
error ownership code and obsolete explanations. Generated declarations and
JavaScript are rebuilt with the source.
