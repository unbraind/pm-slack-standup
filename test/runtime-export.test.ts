import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { createExtensionCommandSdk } from "@unbrained/pm-cli/sdk";
import extension, { CommandError } from "../index.ts";
import { runtimeFixture, runtimeCommand, removeRuntimeFixture, runtimeStdout } from "./runtime-fixture.ts";

test("real exporter reports actual output and history filesystem failures", async () => {
  const fixture = await runtimeFixture();
  try {
    const absentParent = join(fixture.directory, "missing", "snapshot.json");
    await assert.rejects(runtimeCommand(fixture, "standup export", { output: absentParent }), /parent directory does not exist/);
    const directoryOutput = join(fixture.directory, "output-directory"); mkdirSync(directoryOutput);
    await assert.rejects(runtimeCommand(fixture, "standup export", { output: directoryOutput }), /that path is a directory/);
    const fileHistory = join(fixture.directory, "history-file"); writeFileSync(fileHistory, "unchanged");
    await assert.rejects(runtimeCommand(fixture, "standup export", { historyDir: fileHistory }), /could not write/);
    assert.equal(readFileSync(fileHistory, "utf8"), "unchanged");
    const snapshot = await runtimeCommand(fixture, "standup export", { format: "json" });
    const service = await fixture.harness.runServiceOverride({ service: "output_format", payload: { command: "standup export", result: snapshot } });
    assert.equal(service.handled, true);
    assert.equal(service.result, snapshot.output);
    const decline = await fixture.harness.runServiceOverride({ service: "output_format", payload: null });
    assert.equal(decline.handled, false);
    const noResult = await fixture.harness.runServiceOverride({ service: "output_format", command: "standup export", payload: {} });
    assert.equal(noResult.handled, false);
  } finally { await removeRuntimeFixture(fixture); }
});

test("legacy host stdout remains correct after a modern host activated the same module", async (context) => {
  const fixture = await runtimeFixture();
  const legacy = await createExtensionTestHarness({
    ...extension,
    /** Activate the real package with the actual SDK API minus the newer service capability. */
    activate(api: ExtensionApi): void {
      extension.activate({ ...api, registerService: undefined } as unknown as ExtensionApi);
    },
  }, { name: "pm-slack-standup", capabilities: ["commands", "schema", "importers", "preflight"] });
  const stdout = runtimeStdout(context);
  try {
    assert.deepEqual(legacy.activation.failed, []);
    const receipt = await legacy.runCommand({ command: "standup export", pmRoot: fixture.pmRoot, options: { format: "json" } });
    assert.equal(receipt.handled, true);
    const result = receipt.result as Record<string, unknown>;
    assert.equal(result.raw_stdout, undefined);
    assert.deepEqual(JSON.parse(stdout.join("")), JSON.parse(String(result.output)));
    const modern = await runtimeCommand(fixture, "standup export", { format: "json" });
    assert.equal(modern.raw_stdout, true, "each activation must retain its own output capability");
  } finally { await legacy.deactivate(); await removeRuntimeFixture(fixture); }
});

test("real preflight passes through and both credential checks reject before a post", async () => {
  const fixture = await runtimeFixture();
  const savedWebhook = process.env["PM_SLACK_WEBHOOK"];
  delete process.env["PM_SLACK_WEBHOOK"];
  try {
    const decision = { enforce_item_format_gate: true, run_preflight_item_format_sync: true,
      run_extension_migrations: true, enforce_mandatory_migration_gate: true };
    const preflight = await fixture.harness.runPreflightOverride({ command: "standup", args: [], options: {}, global: {}, pm_root: fixture.pmRoot, decision });
    assert.deepEqual(preflight.warnings, []);
    assert.deepEqual(preflight.decision, decision);
    await assert.rejects(fixture.harness.runCommand({ command: "standup", pmRoot: join(fixture.directory, "nonexistent") }),
      (error: unknown) => error instanceof CommandError && error.exitCode === 2 && /no webhook/.test(error.message));
    const handler = fixture.harness.activation.commands.handlers.find((entry) => entry.command === "standup");
    assert.ok(handler);
    let reads = 0;
    const options = {
      /** A custom host can provide an accessor whose credential disappears between checks. */
      get webhook(): string | undefined { reads += 1; return reads === 1 ? "https://localhost/synthetic" : undefined; },
    };
    await assert.rejects(Promise.resolve(handler.run({ command: "standup", args: [], options, global: {}, pm_root: fixture.pmRoot,
      sdk: createExtensionCommandSdk(fixture.pmRoot, fixture.client) })),
    (error: unknown) => error instanceof CommandError && error.exitCode === 2 && /no webhook/.test(error.message));
    assert.equal(reads, 3);
  } finally {
    if (savedWebhook === undefined) delete process.env["PM_SLACK_WEBHOOK"]; else process.env["PM_SLACK_WEBHOOK"] = savedWebhook;
    await removeRuntimeFixture(fixture);
  }
});
