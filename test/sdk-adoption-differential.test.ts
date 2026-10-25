import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { runtimeStdout } from "./runtime-fixture.ts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { ExtensionModule } from "@unbrained/pm-cli/sdk/authoring";
import extension, { readSdkStandupItems } from "../index.ts";

/** Immutable origin/main build audited on 2026-10-25, before adoption. */
const baseline = "523c0786f085db52d585a7714598c90d38eeb3d0";
const root = resolve(import.meta.dirname, "..");

/** Hash authoritative tracker bytes; derived SDK caches are deliberately excluded. */
function trackerDigest(directory: string): string {
  const hash = createHash("sha256");
  /** Walk bounded tracker contents in stable path order. */
  function visit(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (["runtime", "search", "locks", "extensions"].includes(entry.name)) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) hash.update(relative(directory, file)).update(readFileSync(file));
    }
  }
  visit(directory);
  return hash.digest("hex");
}

test("origin/main build and SDK adoption produce identical reports on immutable public tracker copies", async (context) => {
  const stdout = runtimeStdout(context);
  const directory = mkdtempSync(join(tmpdir(), "standup-sdk-differential-"));
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    const archive = execFileSync("git", ["archive", baseline], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", directory], { input: archive });
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc")], { cwd: directory });
    const before = createRequire(import.meta.url)(join(directory, "dist/index.js")) as { default: ExtensionModule };
    const modules = [before.default, extension];
    const sources = [join(directory, ".agents/pm"), ...JSON.parse(process.env.STANDUP_DIFFERENTIAL_TRACKERS ?? "[]") as string[]];
    process.env.GIT_CEILING_DIRECTORIES = dirname(directory);
    let comparisons = 0;
    for (const [index, source] of sources.entries()) {
      const pmRoot = join(directory, `tracker-${index}`);
      cpSync(source, pmRoot, { recursive: true });
      const digest = trackerDigest(pmRoot);
      const harnesses = await Promise.all(modules.map((module) => createExtensionTestHarness(module, {
        name: "pm-slack-standup", capabilities: ["commands", "schema", "importers", "preflight", "services"],
      })));
      try {
        assert.deepEqual(harnesses.map((harness) => harness.activation.failed), [[], []]);
        const items = await readSdkStandupItems({ pm_root: pmRoot });
        assert.ok(items.length > 0, "the public corpus must contain real items");
        for (const command of ["standup", "slack-standup", "standup decisions"]) {
          for (const format of command === "standup decisions" ? ["plain"] : ["plain", "markdown", "slack", "blockkit"]) {
            const outputs = [];
            for (const harness of harnesses) {
              stdout.length = 0;
              const result = await harness.runCommand({ command, pmRoot,
                options: { "dry-run": true, "include-done": true, "all-open": true, "include-blockers": true, format } });
              outputs.push({ result, stdout: stdout.join("") });
            }
            assert.deepEqual(outputs[1], outputs[0], `${command} ${format} public corpus ${index}`);
            comparisons++;
          }
        }
        for (const format of ["md", "json"]) {
          const outputs = [];
          for (const harness of harnesses) {
            stdout.length = 0;
            const result = await harness.runExporter({ exporter: "standup", pmRoot,
              options: { format, "include-done": true, "all-open": true } });
            outputs.push({ result, stdout: stdout.join("") });
          }
          assert.deepEqual(outputs[1], outputs[0], `export ${format} public corpus ${index}`);
          comparisons++;
        }
        assert.equal(trackerDigest(pmRoot), digest, "reads must preserve authoritative tracker bytes");
        console.error(`Differential corpus ${index}: ${items.length} items, 11 identical reports, tracker bytes unchanged`);
      } finally { for (const harness of harnesses) await harness.deactivate(); }
    }
    console.error(`Differential baseline ${baseline}: ${comparisons} identical command/export outputs across ${sources.length} public tracker copies`);
  } finally {
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
    rmSync(directory, { recursive: true, force: true });
  }
});
