/** Reproducible read-only validation against the committed public tracker; output contains aggregate numbers only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { readProgressDeltas } from "../index.ts";

const root = mkdtempSync(join(tmpdir(), "standup-public-progress-"));
const files: string[] = [];
const directories: string[] = [];
const oldPath = process.env.PATH;
const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
/** Inventory only the explicitly created scratch tracker. */
function walk(directory: string): void {
  directories.push(directory);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) walk(target); else files.push(target);
  }
}
/** Hash ordered source bytes before and after SDK reads. */
function fingerprint(): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(readFileSync(file));
  return hash.digest("hex");
}
try {
  const sourceHead = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim();
  const archive = execFileSync("git", ["archive", "origin/main", ".agents/pm"], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", root], { input: archive });
  const pmRoot = join(root, ".agents", "pm");
  walk(pmRoot);
  const before = fingerprint();
  for (const file of files) chmodSync(file, 0o444);
  for (const directory of directories) chmodSync(directory, 0o555);
  process.env.PATH = root;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  const client = new PmClient({ pmRoot, noExtensions: true });
  const corpus = await client.listAllComplete({ includeBody: true });
  const numbers = { items: corpus.items.length, pages: 0, events: 0, gains: 0, passingCommands: 0, acceptedCriteria: 0, readinessChanges: 0,
    statusActivity: 0, commentActivity: 0, invalid: 0, foreign: 0, replayGains: 0, refusals: 0, unchangedFiles: 0 };
  for (const item of corpus.items) {
    let after: string | undefined;
    try {
      let remaining: number;
      do {
        const report = await readProgressDeltas({ pm_root: pmRoot }, item.id, { after, events: 500, outputBytes: 32768 });
        numbers.pages++; numbers.events += report.through - report.from; numbers.gains += report.gains.length;
        numbers.statusActivity += report.activity.status; numbers.commentActivity += report.activity.comments;
        numbers.invalid += report.ignored.invalid; numbers.foreign += report.ignored.foreign;
        for (const gain of report.gains) {
          if (gain.kind === "passing_tests") numbers.passingCommands += gain.count;
          else if (gain.kind === "criterion") numbers.acceptedCriteria++; else numbers.readinessChanges++;
        }
        after = report.next; remaining = report.remaining;
      } while (remaining > 0);
      numbers.replayGains += (await readProgressDeltas({ pm_root: pmRoot }, item.id, { after })).gains.length;
    } catch { numbers.refusals++; }
  }
  assert.equal(fingerprint(), before);
  numbers.unchangedFiles = files.length;
  assert.equal(numbers.replayGains, 0);
  process.stdout.write(JSON.stringify({ ok: true, source: "unbraind/pm-slack-standup", sourceHead, gitAvailable: false, ...numbers }) + "\n");
} finally {
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
  for (const directory of directories) chmodSync(directory, 0o755);
  rmSync(root, { recursive: true, force: true });
}
