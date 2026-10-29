# Commitment variance validation

The overlap check covered the current core SDK declarations, package progress
and lifecycle contracts, pm-brief acknowledged handoffs, pm-slack delivery
acknowledgments, and the earlier impediment acknowledgment proposal. These
receipts compare explicitly captured periodic intent with linked outcomes; they
do not assign work, request acknowledgment or send reminders.

## Public tracker

Reproduce with `node test/commitment-public.ts`. It verifies public repository
visibility, archives only the committed tracker from `origin/main`, extracts it
into a non-git scratch directory, makes every file and directory read-only,
removes git from PATH, and compares names, bytes, modes and mtimes after reading.
No hosted data is accessed.

Measured at `unbraind/pm-slack-standup` commit
`83f4e1ee5d2fde97254c6fa8044f5cc017314691`:

| Measurement | Count |
| --- | ---: |
| Certified items / successful reports | 107 / 107 |
| Native history events | 1,048 |
| Sources without explicit captures | 107 |
| Declared commitments / inferred completions or failures | 0 / 0 |
| Foreign annotations / invalid annotations / refusals | 252 / 0 / 0 |
| Explicit missing-key control | 20 unsupported rows |
| Missing-key control JSON bytes | 2,967 |
| Unchanged files | 220 / 220 |

The public corpus has no versioned commitment declarations. This validates
honest absence and read-only operation, not positive completion prevalence.
The positive real-SDK fixtures cover all four states, including a single bounded
report with twenty linked commitments and large native bodies: 6,561 JSON bytes,
with no bodies emitted.

## Verification contract

The feature is read-only; it has no import/apply/sync or durable recovery path.
Producers and readers share the same strict declaration schema. The seeded state
model reads native documents through SDK `getItemAt`, uses SDK `canonicalDocument`
for its reference values, and never feeds a CLI projection's derived count fields
back into native metadata. It checks every native field this feature inspects,
older-input replays, normalized whitespace/CRLF annotations, relationships,
custom status roles and ambient focus. Declaration identities include the target
revision, so same-content newer revisions do not collapse.

The interleaving regression uses the production async read iterator and real SDK
peer writes on one non-git tracker. Each boundary either admits the peer's
observed revision or reports `source_changed`; a peer after a target's final
check remains the explicitly documented observation window. No SDK clients are
mocked, and no transaction isolation is asserted.

Local validation is focused to respect shared-host CPU limits. The unchanged CI
release gate provides npm and Bun full-suite/coverage/packed evidence. Exact-head
CI run links and measured counts are recorded in the pull request.

Measured local checks:

- `npm run build && npm run build:test`, lint, docstrings and zero duplication passed.
- `node --test --test-concurrency=1 test/commitment-variance.test.ts`: **10/10**,
  also **1/1** linked native pm test commands. Automatic result recording is
  disabled by the inherited project policy; it was left unchanged.
- `node --test --test-concurrency=1 test/commitment-model.test.ts`: **500 seeded
  sequences, 3,363 native mutations, eight generated registries, zero mismatches**.
- Focused c8 measurement: **100/100/100/100** on `commitment-schema.ts` and
  `commitment-variance.ts`. This is explicitly a two-module measurement;
  whole-package certification belongs to CI.
- Four changed-function behavioral reverts in a disposable copy each failed
  an assertion: omit scope/body detection, omit target revision binding,
  misclassify absent support as pending, or omit read-witness validation.
  Restoring fixed code passed **3/3** selected regressions. The package
  worktree's implementation remained untouched throughout.

Settings reads use SDK `readSettingsWithMetadata`: fallback warnings indicating
unavailable configuration refuse safely, while the legacy format warning remains
compatible. This avoids interpreting default status roles after a failed read.
