/** Read-only public-data probe. Emits aggregate counts, never source bodies or operator paths. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { PmClient, getHistoryPath, readHistorySnapshot } from "@unbrained/pm-cli/sdk";
import { readCommitmentVariance } from "../index.ts";
import { treeState } from "./tracker-state.ts";

const scratch = mkdtempSync(join(tmpdir(), "standup-public-variance-"));
const leaves: string[] = [];
const folders: string[] = [];
const previousPath = process.env.PATH;
const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
/** Bound the inventory to the public tracker extracted by this probe. */
function inventory(directory: string): void {
  folders.push(directory);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inventory(path); else leaves.push(path);
  }
}
try {
  const visibility = JSON.parse(execFileSync("gh", ["repo", "view", "unbraind/pm-slack-standup", "--json", "visibility"], { encoding: "utf8" })) as { visibility: string };
  assert.equal(visibility.visibility, "PUBLIC");
  const head = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim();
  const bytes = execFileSync("git", ["archive", head, ".agents/pm"], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", scratch], { input: bytes });
  const pmRoot = join(scratch, ".agents", "pm");
  inventory(pmRoot);
  for (const path of leaves) chmodSync(path, 0o444);
  for (const path of folders) chmodSync(path, 0o555);
  const before = treeState(pmRoot, true);
  process.env.PATH = scratch;
  process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
  const client = new PmClient({ pmRoot, noExtensions: true });
  const corpus = await client.listAllComplete({ includeBody: true });
  const result = { items: corpus.items.length, reports: 0, events: 0, missingCaptures: 0, declaredCommitments: 0,
    completed: 0, changedScope: 0, unsupported: 0, pending: 0, foreign: 0, invalid: 0, refusals: 0,
    twentyMissingRows: 0, jsonBytes: 0, unchangedFiles: 0 };
  for (const item of corpus.items) {
    try {
      const history = await readHistorySnapshot(getHistoryPath(pmRoot, item.id), item.id);
      result.events += history.entries.length;
      const report = await readCommitmentVariance({ pm_root: pmRoot }, { source: { id: item.id, revision: history.entries.length } });
      result.reports++; result.missingCaptures += Number(report.capture === "missing"); result.declaredCommitments += report.rows.length;
      result.completed += report.counts.completed; result.changedScope += report.counts.changed_scope;
      result.unsupported += report.counts.unsupported; result.pending += report.counts.still_pending;
      result.foreign += report.ignored.foreign; result.invalid += report.ignored.invalid;
    } catch { result.refusals++; }
  }
  const id = corpus.items[0].id;
  const history = await readHistorySnapshot(getHistoryPath(pmRoot, id), id);
  const absent = await readCommitmentVariance({ pm_root: pmRoot }, { source: { id, revision: history.entries.length },
    keys: Array.from({ length: 20 }, (_, index) => `missing-${index + 1}`) });
  result.twentyMissingRows = absent.counts.unsupported;
  result.jsonBytes = Buffer.byteLength(JSON.stringify(absent));
  assert.equal(absent.capture, "missing"); assert.equal(result.twentyMissingRows, 20);
  assert.equal(treeState(pmRoot, true), before);
  result.unchangedFiles = leaves.length;
  const digest = createHash("sha256");
  for (const path of leaves.sort()) digest.update(readFileSync(path));
  process.stdout.write(JSON.stringify({ ok: true, repository: "unbraind/pm-slack-standup", head, gitAvailable: false,
    ...result, trackerSha256: digest.digest("hex") }) + "\n");
} finally {
  if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  for (const path of folders) chmodSync(path, 0o755);
  rmSync(scratch, { recursive: true, force: true });
}
