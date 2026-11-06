import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionTestHarness, runRegisteredServiceOverrideForTest, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";
import { runtimeFixture, runtimeCommand, removeRuntimeFixture, runtimeStdout } from "./runtime-fixture.ts";
import { treeState } from "./tracker-state.ts";

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers and dispatches its public contracts against a real tracker", async (context) => {
  const fixture = await runtimeFixture();
  const stdout = runtimeStdout(context);
  try {
    const { harness, pmRoot, client } = fixture;
    assert.equal(harness.activationSummary().preflight_overrides, 1);
    for (const name of ["standup", "slack-standup"]) {
      harness.assertCommandContract({ name, flags: ["--dry-run", "--format", "--team", "--sections"] });
    }
    harness.assertExporter({ name: "standup" });
    harness.assertCommandContract({ name: "standup export", flags: ["--format", "--team", "--output"] });
    harness.assertServiceOverride({ name: "output_format" });
    // Reports use native item schema and read-only host SDK context; this
    // extension owns no item fields, types or mutation hooks to emulate.
    const summary = harness.activationSummary();
    assert.deepEqual(summary.item_fields, []);
    assert.deepEqual(summary.item_types, []);
    assert.deepEqual(summary.hooks, []);

    const active = fixture.items.find((item) => item.status === "in_progress");
    assert.ok(active);
    await client.schemaAddStatus("reviewing", { role: ["active"] });
    await client.update(active.id, { title: "SDK mutation visible in standup", status: "reviewing" });
    const before = treeState(pmRoot);
    for (const command of ["standup", "slack-standup"]) {
      stdout.length = 0;
      const result = await runtimeCommand(fixture, command,
        { dryRun: true, format: "plain", team: "alice", sections: "in_progress" });
      assert.equal(result.dryRun, true);
      assert.equal(result.format, "plain");
      assert.equal(result.wip, 1);
      assert.match(String(result.rendered), /SDK mutation visible in standup/);
      assert.doesNotMatch(String(result.rendered), /Waiting for local fixture/);
      assert.ok(stdout.join("").includes(String(result.rendered)));
    }
    stdout.length = 0;
    const receipt = await harness.runExporter({ exporter: "standup", pmRoot,
      options: { format: "json", team: "alice", sections: "in_progress" } });
    assert.equal(receipt.handled, true);
    assert.deepEqual(receipt.warnings, []);
    assert.ok(receipt.result && typeof receipt.result === "object");
    const result = receipt.result as Record<string, unknown>;
    assert.equal(result.raw_stdout, true);
    assert.deepEqual(stdout, [], "the service owns stdout delivery on a modern host");
    const snapshot = JSON.parse(String(result.output));
    assert.equal(snapshot.counts.total, 1);
    assert.equal(snapshot.sections_data.in_progress[0].title, "SDK mutation visible in standup");
    const output = await harness.runServiceOverride({ service: "output_format", command: "standup export",
      payload: { command: "standup export", result } });
    assert.equal(output.handled, true);
    assert.deepEqual(output.warnings, []);
    assert.equal(output.result, result.output);
    assert.equal(treeState(pmRoot), before, "dispatch must preserve native items, history and schema");
  } finally { await removeRuntimeFixture(fixture); }
});

// ---------------------------------------------------------------------------
// Regression: the `output_format` service override must CLAIM only its own
// `standup export` raw-stdout payload and DECLINE everything else via the
// `{ handled: false }` decision.
//
// Before pm-cli 2026.7.27 an override could decline by returning the inbound
// `context.payload`, and this extension did exactly that. In 2026.7.27 an
// override's bare return value IS what the host renders, so echoing the payload
// made EVERY command in a workspace with this extension installed print the
// whole command context (`global`, `format`, `options`, ...) instead of its own
// result. Filed upstream as unbraind/pm-cli#776.
//
// Driven through pm's REAL service runner, because a hand-rolled api double
// registers the override and then never evaluates its return value — which is
// precisely why this bug class was invisible to the suite.
// ---------------------------------------------------------------------------

/** Activate the package through the real SDK for service contract checks. */
async function activateForServiceTest(): Promise<ExtensionTestHarness> {
  const harness = await createExtensionTestHarness(extension, {
    name: "pm-slack-standup",
    capabilities: ["commands", "schema", "importers", "preflight", "services"],
  });
  assert.deepEqual(harness.activation.failed, [], "activation must not fail");
  return harness;
}

test("output_format override declines non-standup-export payloads", async () => {
  const harness = await activateForServiceTest();
  harness.assertServiceOverride({ name: "output_format" });

  const payload = { command: "list", format: "toon", result: { items: [{ id: "probe-1" }], count: 1 } };
  const outcome = await runRegisteredServiceOverrideForTest(harness.activation.services, {
    service: "output_format",
    command: "list",
    payload,
  } as Parameters<typeof runRegisteredServiceOverrideForTest>[1]);

  assert.equal(outcome.handled, false, "an unrelated command's payload must be declined");
  assert.deepEqual(outcome.result, payload, "a declined payload must reach the host untouched");
  assert.deepEqual(outcome.warnings, [], "declining must not emit service-override warnings");
});

test("output_format override still claims standup export raw stdout verbatim", async () => {
  const harness = await activateForServiceTest();
  const exported = '{"date":"2026-07-27","items":[]}';
  const outcome = await runRegisteredServiceOverrideForTest(harness.activation.services, {
    service: "output_format",
    command: "standup export",
    payload: { command: "standup export", result: { raw_stdout: true, output: exported } },
  } as Parameters<typeof runRegisteredServiceOverrideForTest>[1]);

  assert.equal(outcome.handled, true, "standup export must still claim its own payload");
  assert.equal(outcome.result, exported, "the export string must be handed to the host verbatim");
});

test("output_format override declines a standup export that is not raw stdout", async () => {
  const harness = await activateForServiceTest();
  const payload = { command: "standup export", result: { raw_stdout: false, output: "ignored" } };
  const outcome = await runRegisteredServiceOverrideForTest(harness.activation.services, {
    service: "output_format",
    command: "standup export",
    payload,
  } as Parameters<typeof runRegisteredServiceOverrideForTest>[1]);

  assert.equal(outcome.handled, false, "without the raw-stdout marker the payload must be declined");
  assert.deepEqual(outcome.result, payload, "a declined payload must reach the host untouched");
});

/**
 * The preflight scope must name every command path this package registers.
 *
 * `slack-standup` is registered as a full command sharing `runStandupCommand`,
 * not as a Commander alias, so the runtime matches it by its own exact
 * normalized name. A scope naming only `standup` therefore leaves the alias
 * outside the override entirely. The registration is a pass-through today, so
 * nothing misbehaves at runtime — but the declared scope is what `pm health`
 * reads as this package's ownership claim, and if the override ever becomes
 * authoritative the alias would silently escape its gate.
 *
 * Derived from the real activation rather than a hand-maintained list, so a
 * newly registered command path fails here instead of quietly falling outside
 * the scope. Driven through the SDK harness, so the assertion observes the host
 * registry used for actual command dispatch.
 */
test("the preflight scope covers every registered command path", async () => {
  const harness = await activateForServiceTest();
  const override = harness.assertPreflightOverride();
  const registered = harness.activation.commands.handlers.map((handler) => handler.command).sort();
  assert.deepEqual(
    [...(override.commands ?? [])].sort(),
    registered,
    "every command this extension registers must appear in the preflight scope",
  );
  assert.deepEqual(
    registered,
    ["slack-standup", "standup", "standup decisions", "standup export", "standup progress", "standup variance", "standup window"],
    "the registered command paths this scope is derived from",
  );
});
