import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionTestHarness, runRegisteredServiceOverrideForTest, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers at least one capability", () => {
  const registered: string[] = [];
  const noop = () => {};
  // Mirror the full ExtensionApi surface so activate() can register every
  // capability the extension uses (command + standup exporter).
  const api = {
    registerCommand: (command: { name?: string }) => {
      registered.push(`command:${command?.name ?? "unknown"}`);
    },
    registerParser: noop, registerPreflight: noop, registerService: noop,
    registerFlags: noop, registerItemFields: noop, registerItemTypes: noop,
    registerMigration: noop, registerRenderer: noop,
    registerImporter: () => { registered.push("importer"); },
    registerExporter: () => { registered.push("exporter"); },
    registerSearchProvider: noop, registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  extension.activate(api as any);
  assert.ok(registered.includes("command:standup"), "should register the standup command");
  assert.ok(registered.includes("command:slack-standup"), "should register the alias command");
  assert.ok(registered.includes("exporter"), "should register the standup exporter");
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
 * the scope. Driven through the SDK harness, because the api double above
 * registers the override and then never inspects what was registered.
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
    ["slack-standup", "standup", "standup export"],
    "the registered command paths this scope is derived from",
  );
});
