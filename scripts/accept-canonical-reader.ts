/** Exercise the complete reader against a disposable workspace initialized by the real PM CLI. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { COMPLETE_LIST_COMMAND_ARGUMENTS, fetchAllItems, type PmLaunch } from "../index.ts";

test("canonical reader acceptance issues exactly one complete-list read against a real PM workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-slack-standup-canonical-reader-"));
  const pmRoot = join(root, ".agents", "pm");
  const hostCli = resolve(import.meta.dirname, "..", "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  const env: NodeJS.ProcessEnv = { ...process.env, PM_PATH: pmRoot, PM_GLOBAL_PATH: join(root, "global-pm"), PM_TELEMETRY_DISABLED: "1" };
  const invocations: string[][] = [];
  const launch: PmLaunch = {
    command: process.execPath,
    args: (pmArgs) => {
      invocations.push([...pmArgs]);
      return [hostCli, ...pmArgs];
    },
    windowsVerbatimArguments: false,
  };
  try {
    for (const args of [
      ["init", "--defaults", "--agent-guidance", "skip", "--prefix", "reader"],
      ["create", "task", "Tracked standup work", "--status", "in_progress", "--create-mode", "progressive"],
    ]) {
      const result = spawnSync(process.execPath, [hostCli, ...args], { cwd: root, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const items = fetchAllItems(pmRoot, launch);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Tracked standup work");
    assert.equal(items[0].status, "in_progress");
    assert.match(items[0].id, /^reader-/u);
    assert.deepEqual(invocations, [["--path", pmRoot, ...COMPLETE_LIST_COMMAND_ARGUMENTS]],
      "the real host must receive exactly one canonical complete-list invocation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
