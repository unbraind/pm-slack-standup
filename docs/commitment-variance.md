# Commitment variance receipts

`pm standup variance SOURCE --revision VERSION` compares explicit intentions in a
selected historical standup/Plan item with the linked native outcomes. It reads
existing history only. There is no automatic “previous standup,” session-focus
default, assignment, reminder, acknowledgment, or Slack delivery.

Capture one intention per native comment using `encodeStandupCommitment`. The
comment has this strict versioned shape:

```text
standup-commitment/v1 {"version":1,"key":"build","target":{"id":"demo-build","revision":2}}
```

The native comment explicitly links the source to a target **revision**. A Plan
can carry these annotations alongside its ordinary prose. Existing prose and
unannotated relationships are never guessed to be commitments. Use native
`comments` and `history` APIs to persist annotations and obtain revision numbers;
the encoder itself writes nothing. See the [SDK example](commitment-variance-example.md).

```sh
pm standup variance demo-plan --revision 4
pm standup variance demo-plan --revision 4 --keys build,docs --json
pm standup variance demo-plan --revision 4 --output-bytes 16384 --json
```

The SDK exports `readCommitmentVariance(context, input)`, its input/report/row
types, `parseStandupCommitment`, `encodeStandupCommitment`, and
`CommitmentRefusal`. Context supplies `pm_root` and optionally the host SDK. All
history, settings, status, identity, patch replay, and digest operations use the
supported pm SDK package exports. No executable discovery is used. The optional
`commitmentVarianceSteps` async iterator yields read boundaries for cooperative
hosts and returns the same report when drained. Discard an interrupted read and
start again; it is not a persisted replay plan.

| State | Evidence and precedence |
| --- | --- |
| `completed` | Linked target currently has the configured SDK `terminal_done` role; no observed scope revision or cancellation |
| `changed_scope` | Source/target scope changed after the selected revision, the key's linked target revision changed/was removed, or target has `terminal_canceled` role |
| `unsupported` | Missing capture, missing/corrupt/compacted/deleted target history, unavailable target revision/status, or terminal status without a done role |
| `still_pending` | A supported nonterminal target has no linked completion and no observed scope change |

Completion reports a recorded lifecycle outcome, not passing tests or independent
verification. Use `standup progress` for revision-cited test/criterion evidence.
Changed scope takes precedence over completion; canceled takes precedence over
done when a registry assigns both roles. Missing capture/history never implies
failure. An unannotated source returns `capture: missing` and no inferred rows;
explicitly requested missing keys return individual `unsupported/missing_capture`
rows. Each malformed annotation is skipped independently; valid neighbors survive,
and ignored foreign/invalid counts are returned.

Scope is the SDK-normalized body, title, type, parent, sprint, release,
dependencies, blocked_by, and deadline. Any intervening difference counts, even
if later reverted. Source scope changes use names such as `source.body`. Status,
comments, test results and timestamps alone do not change scope. At a selected
revision the last valid declaration for a key in native canonical comment order
is selected. Replaying its whitespace/CRLF variant keeps the same meaning;
selecting another target revision changes the commitment even if body content is
identical. Source and target revisions are one-based, uncompacted stream positions;
each returned reference includes the SDK history-record digest.
Sources and targets with more than 10,000 retained events are outside this bounded
reader: select a smaller source capture/tracker or use native history inspection;
no partial history is interpreted as a complete comparison.

Inputs are strict objects: unknown fields, sparse arrays, duplicate normalized
keys, controls/empty labels, unsafe/fractional/nonfinite numbers, and oversized
values refuse before reading the tracker. Keys are 1..64 characters, IDs 1..128,
revision integers 1..1,000,000, and selections 1..20 distinct keys. The default
selects all declared keys, refusing more than twenty instead of truncating them.
Historical native records retain the host's own validation contract. Every output
count/revision is checked; counts form an exact integer partition with no floating
point decision threshold.

The JSON projection budget is 1,024..32,768 bytes (default 16,384). Whole reports
either fit or refuse; bodies and titles are absent. The twenty-target large-body
fixture measures about 6.6 KB JSON. This budget measures the SDK JSON projection;
the host's envelope and TOON representation have their own overhead. TOON uses
the host's lossless `rows_encoding` metadata for nested revision/changes cells;
SDK consumers restore those rows with `decodePmTableRows`. Prefer `--json` when
literal JSON state is needed.

SDK refusals expose `code` and `remedy`; CLI refusals exit 2, with `code` and
`required` under `--json`. Codes are `invalid_input`, `history_unavailable`,
`revision_unavailable`, `selection_limit`, `source_changed`, `output_limit`, and
`invalid_output`. Recover source history separately; reporting never creates,
repairs, compacts or restores it. Missing targets are row-level uncertainty.

The reader rechecks all source/target streams (including absent targets) and
settings before returning. Detected changes refuse with `source_changed`, so
callers retry the complete read against the same selection. These are per-stream
observations, not an atomic workspace snapshot: an ordinary writer can still
change a previously checked stream while other checks finish or after return.
No workspace transaction lock is claimed to exclude ordinary SDK/CLI writers
([core concurrency limitation](https://github.com/unbraind/pm-cli/issues/1620)).
Reports contain explicit observed revisions so consumers can assess that window.

The feature introduces no import/export/sync writer, journal, checkpoint, lease,
outbox or idempotency store. JSON/TOON are read projections. Native annotations
are revision-bound declarations, not content-addressed mutation keys. The model
regression drives real SDK native writes and SDK state read-back through at least
500 seeded sequences, including older-input replay, CRLF serialization,
relationships, all inspected scope fields, random role registries and ambient
focus. Concurrent peer transitions are injected at every yielded read boundary.
