# Extension host tests

The positive registration smoke test uses `createExtensionTestHarness` through
`test/runtime-fixture.ts`. The SDK owns activation, registration validation and
handler dispatch; there is no package-owned `ExtensionApi` capture host.

`assertCommandContract`, `assertExporter` and `assertServiceOverride` check the
registered commands, alias, flags, exporter and output service. `runCommand`,
`runExporter` and `runServiceOverride` then exercise those registrations against a
real disposable tracker initialized outside Git. The fixture creates native items
with `PmClient`; the smoke test adds an active status with `schemaAddStatus` and
updates an item with `update`. Both command names and the exporter must report
that mutation through the host SDK context, honor presentation flags and return
successful dispatch/output receipts. Native item, schema and history storage must
remain unchanged by reporting; derived SDK runtime caches may be populated.

This extension registers no custom item fields, item types or mutation hooks.
Its status-role classification, Slack rendering, team/section selection and
raw-stdout ownership rules remain package responsibilities: the SDK dispatches
commands but does not define standup presentation or Slack output semantics.
Pure presentation unit tests therefore remain appropriate. The intentional
legacy-host test in `test/runtime-export.test.ts` removes only `registerService`
from the real SDK activation API to verify older-host stdout compatibility.

Run the focused contracts with:

```sh
node --test --test-concurrency=2 test/smoke.test.ts test/runtime-export.test.ts
```

This migration changes tests, not production behavior. Behavioral withdrawal
checks in a disposable copy remove the dry-run flag, alias registration, host
tracker read or raw-stdout receipt separately. Each must make the new smoke test
fail; restoring the production implementation must pass. These negative controls
verify the added coverage without claiming a production bug was fixed.
