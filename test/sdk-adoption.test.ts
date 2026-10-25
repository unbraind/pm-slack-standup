import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createExtensionCommandSdk, isPmCliExpectedError, listMutationEvents } from "@unbrained/pm-cli/sdk";
import {
  CommandError, parseFormat, readSdkStandupItems, readStandupStatusRegistry,
  buildStandupData, buildTextMessage, buildBlockKit, resolveStandupOptions,
} from "../index.ts";
import { runtimeFixture, removeRuntimeFixture, runtimeCommand } from "./runtime-fixture.ts";

/** Require integrity failure without permitting a successful posting or snapshot write. */
async function assertIntegrityRefusal(fixture: Awaited<ReturnType<typeof runtimeFixture>>): Promise<void> {
  const destination = join(fixture.directory, "must-not-exist.json");
  await assert.rejects(runtimeCommand(fixture, "standup", { "dry-run": true }), /history|integrity|hash/i);
  await assert.rejects(fixture.harness.runExporter({ exporter: "standup", pmRoot: fixture.pmRoot,
    options: { format: "json", output: destination, "history-dir": join(fixture.directory, "snapshots") } }), /history|integrity|hash/i);
  assert.equal(existsSync(destination), false);
  assert.equal(existsSync(join(fixture.directory, "snapshots")), false);
}

test("SDK expected errors preserve exit codes and gain the public expected-error discriminator", () => {
  for (const error of [new CommandError("read failure"), new CommandError("not found", 3)]) {
    assert.ok(error instanceof CommandError);
    assert.ok(isPmCliExpectedError(error));
    assert.deepEqual(error.context, {});
  }
  for (const exitCode of [0, -1, NaN, Infinity]) {
    assert.throws(() => new CommandError("invalid exit", exitCode));
  }
  assert.throws(() => parseFormat("unsupported"), (error: unknown) =>
    isPmCliExpectedError(error) && error.exitCode === 2 && /Unknown --format/.test(error.message));
});

test("host SDK reads work in a non-git tracker without a git executable or PM subprocess", async () => {
  const fixture = await runtimeFixture();
  const savedPath = process.env.PATH;
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    process.env.PATH = fixture.directory;
    process.env.GIT_CEILING_DIRECTORIES = dirname(fixture.directory);
    const items = await readSdkStandupItems({ pm_root: fixture.pmRoot,
      sdk: createExtensionCommandSdk(fixture.pmRoot, fixture.client) });
    assert.equal(items.length, 5);
    assert.deepEqual(await readSdkStandupItems({ pm_root: fixture.pmRoot }), items);
    await assert.rejects(readSdkStandupItems({ pm_root: join(fixture.directory, "missing") }), /not initialized|tracker_not_initialized/i);
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
    await removeRuntimeFixture(fixture);
  }
});

test("history corruption after priming SDK caches still refuses commands and snapshot publication", async () => {
  const fixture = await runtimeFixture();
  try {
    await readSdkStandupItems({ pm_root: fixture.pmRoot, sdk: createExtensionCommandSdk(fixture.pmRoot, fixture.client) });
    const page = await listMutationEvents({ pmRoot: fixture.pmRoot, full: true });
    assert.ok(page.count > 0);
    const id = fixture.items[0].id;
    const path = join(fixture.pmRoot, "history", `${id}.jsonl`);
    const raw = readFileSync(path, "utf8");
    const entries = raw.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    entries[0].after_hash = "0".repeat(64);
    writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    await assertIntegrityRefusal(fixture);
    writeFileSync(path, "malformed history\n");
    await assertIntegrityRefusal(fixture);
  } finally { await removeRuntimeFixture(fixture); }
});

test("configured lifecycle roles suppress terminal blockers and include custom done statuses", async () => {
  const fixture = await runtimeFixture();
  try {
    await fixture.client.schemaAddStatus("shipped", { role: ["terminal", "terminal_done"], alias: ["landed"] });
    await fixture.client.schemaAddStatus("paused", { role: ["blocked"] });
    const registry = await readStandupStatusRegistry(fixture.pmRoot);
    const { opts } = resolveStandupOptions({ "include-done": true, "include-blockers": true, compact: true }, "plain");
    opts.statusRegistry = registry;
    const items = [
      { id: "custom-done", title: "Shipped", status: "landed", blocked_by: "old" },
      { id: "custom-blocked", title: "Paused", status: "paused", updated_at: "2020-01-01T00:00:00Z" },
      { id: "canceled", title: "Canceled", status: "canceled", blocked_by: "old" },
    ];
    const data = buildStandupData(items, opts, NaN);
    assert.deepEqual(data.done.map((item) => item.id), ["custom-done"]);
    assert.deepEqual(data.blocked.map((item) => item.id), ["custom-blocked"]);
    assert.doesNotMatch(buildTextMessage(data, opts), /🚨 Shipped|Canceled/);
    assert.doesNotMatch(JSON.stringify(buildBlockKit(data, opts)), /🚨 Shipped|Canceled/);
    opts.compact = false;
    assert.match(buildTextMessage(data, opts), /stale/);
  } finally { await removeRuntimeFixture(fixture); }
});
