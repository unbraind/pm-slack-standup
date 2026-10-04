/** Assert that a caller's tracker override cannot redirect disposable fixture initialization. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runtimeFixture, removeRuntimeFixture } from "./runtime-fixture.ts";

test("runtime fixture initializes its own PM project despite inherited tracker overrides", async () => {
  const parent = mkdtempSync(join(tmpdir(), "standup-parent-context-"));
  const previousPath = process.env.PM_PATH;
  process.env.PM_PATH = join(parent, ".agents", "pm");
  try {
    const fixture = await runtimeFixture();
    try {
      assert.ok(fixture.items.length > 0);
      assert.ok(fixture.items.every((item) => item.id.startsWith("runtime-")), "pm init must initialize the fixture's prefix, not the inherited tracker");
    } finally { await removeRuntimeFixture(fixture); }
  } finally {
    if (previousPath === undefined) delete process.env.PM_PATH;
    else process.env.PM_PATH = previousPath;
    rmSync(parent, { recursive: true, force: true });
  }
});
