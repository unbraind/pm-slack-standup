/** Reproduce public-tracker measurements without modifying the public source or its copied records. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { listAllComplete, listMutationEvents } from "@unbrained/pm-cli/sdk";
import extension, { scanStandupWindowEvents } from "../index.ts";
import type { StandupWindowPacket } from "../index.ts";

/** Hash every copied authoritative file and make it read-only. */
function records(root: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of records(path)) result.set(`${entry.name}/${key}`, value);
    } else {
      result.set(entry.name, createHash("sha256").update(readFileSync(path)).digest("hex"));
      chmodSync(path, 0o444);
    }
  }
  return result;
}

const directory = mkdtempSync(join(tmpdir(), "standup-public-"));
const head = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim();
const archive = execFileSync("git", ["archive", head, ".agents/pm"], { maxBuffer: 32 * 1024 * 1024 });
execFileSync("tar", ["-x", "-C", directory], { input: archive });
const pmRoot = join(directory, ".agents", "pm");
const before = records(pmRoot);
const harness = await createExtensionTestHarness(extension, { name: "pm-slack-standup", capabilities: ["commands", "schema", "importers", "preflight", "services"] });
const ceiling = process.env.GIT_CEILING_DIRECTORIES;
process.env.GIT_CEILING_DIRECTORIES = dirname(directory);
try {
  const corpus = await listAllComplete({}, { pmRoot, cwd: directory, noExtensions: true });
  const scan = await scanStandupWindowEvents((since) => listMutationEvents({ pmRoot, since, limit: 1000, verify: true }), null, 1000000);
  const invoke = async (): Promise<StandupWindowPacket> => {
    const receipt = await harness.runCommand({ command: "standup window", pmRoot, options: { "cursor-file": join(directory, "cursor.json"), "no-advance": true } });
    assert.equal(receipt.handled, true);
    return receipt.result as StandupWindowPacket;
  };
  const first = await invoke();
  const restarted = await invoke();
  assert.deepEqual(restarted, first);
  for (const [file, digest] of before) assert.equal(createHash("sha256").update(readFileSync(join(pmRoot, file))).digest("hex"), digest);
  console.log(JSON.stringify({ source: "unbraind/pm-slack-standup", head, items: corpus.items.length, authoritative_files: before.size,
    events: scan.totalEvents, streams: scan.maxOffsets.size, pages: scan.pages, window: first.window,
    section_counts: Object.fromEntries(Object.entries(first.sections).map(([key, rows]) => [key, rows.length])),
    packet_bytes: Buffer.byteLength(JSON.stringify(first)), restart_identical: true, authoritative_files_unchanged: true }));
} finally {
  if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  await harness.deactivate();
  rmSync(directory, { recursive: true, force: true });
}
