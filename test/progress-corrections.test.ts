import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalDocument, decodeToon, getItemAt } from "@unbrained/pm-cli/sdk";
import type { ItemMetadata } from "@unbrained/pm-cli/sdk";
import { readProgressDeltas } from "../index.ts";
import type { ProgressReport } from "../index.ts";
import { passingRun, progressFixture, currentProgress } from "./progress-fixture.ts";

type NativeRun = NonNullable<ItemMetadata["test_runs"]>[number];

/** Previously unqualified runs must not reserve evidence identity before a correction. */
const unqualified: Array<Partial<NativeRun>> = [
  { status: "failed" }, { status: "stopped" }, { status: "canceled" }, { passed: 0 },
  { passed: 1000001 }, { passed: Number.MAX_SAFE_INTEGER }, { failed: 1 }, { skipped: 1 },
];

test("corrected native results retain their first qualifying revision through every window and replay", async () => {
  const f = await progressFixture();
  try {
    const native = await currentProgress(f, f.id);
    const write = async (runs: NativeRun[]): Promise<void> => {
      await f.change((document) => { document.metadata.test_runs = runs; });
      const expected = canonicalDocument({ metadata: { ...native, test_runs: runs }, body: "" }).metadata.test_runs;
      assert.deepEqual((await currentProgress(f, f.id)).test_runs, expected, "native SDK owns all normalization");
    };
    for (const [index, patch] of unqualified.entries()) {
      const run = passingRun(index % 2 === 0 ? `constructor-${index}` : `__proto__-${index}`, index + 1);
      const other = passingRun(`neighbor-${index}`);
      const old = { ...run, ...patch };
      const before = await f.read({ outputBytes: 32768 });
      await write([old, other]);
      const rejected = await f.read({ after: before.next });
      assert.deepEqual(rejected.gains.map((gain) => gain.subject), [other.run_id], "bad run fails alone");
      await write([run, other]);
      const corrected = await f.read({ after: rejected.next });
      assert.equal(corrected.gains.length, 1, `correction ${index} qualifies immediately`);
      const gain = corrected.gains[0];
      assert.equal(gain.subject, run.run_id);
      assert.equal(gain.count, run.passed);
      assert.equal(gain.revision.version, corrected.through);
      assert.equal(gain.targetRevision, `item:${f.id}:v${corrected.through}`);
      const historical = await getItemAt(f.id, String(gain.revision.version), { pmRoot: f.pmRoot });
      assert.deepEqual(historical.document.metadata.test_runs, [run, other]);
      // An unchanged qualifying result is not duplicate input activity.
      await f.client.comments(f.id, { add: "Ordinary activity after the correction" });
      const unchanged = await f.read({ after: corrected.next });
      assert.deepEqual(unchanged.gains, []);
      assert.equal(unchanged.ignored.duplicate, 0);
      await write([old]);
      await write([]);
      await write([run]);
      const replay = await f.read({ after: corrected.next });
      assert.deepEqual(replay.gains, [], "older failed and passing input cannot create another gain");
      const full = await f.read({ after: before.next });
      assert.deepEqual(full.gains, [rejected.gains[0], gain], "replay never moves first-passing provenance");
      for (const events of [1, 2, 3]) {
        let after = before.next;
        const gains: ProgressReport["gains"] = [];
        let remaining: number;
        do {
          const page = await f.read({ after, events });
          gains.push(...page.gains); after = page.next; remaining = page.remaining;
        } while (remaining > 0);
        assert.deepEqual(gains, full.gains, `all page boundaries preserve correction ${index}`);
      }
      assert.deepEqual(await readProgressDeltas({ pm_root: f.pmRoot }, f.id, { after: rejected.next }),
        await f.read({ after: rejected.next }), "standalone and injected SDK entry points agree");
    }
  } finally { await f.close(); }
});

test("installed CLI JSON and TOON attribute corrected results before removal and readdition without git", async () => {
  const f = await progressFixture();
  try {
    const source = join(f.directory, "source"); mkdirSync(source);
    for (const entry of ["package.json", "manifest.json", "README.md", "docs", "dist"]) cpSync(resolve(entry), join(source, entry), { recursive: true });
    await f.client.packageInstall(source, { project: true });
    const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
    const invoke = (after: string, json: boolean): ProgressReport => {
      const output = execFileSync(process.execPath, [cli, "--path", f.pmRoot, "standup", "progress", f.id, "--after", after,
        ...(json ? ["--json"] : [])], { cwd: f.directory, encoding: "utf8", timeout: 60000,
        env: { ...process.env, PATH: f.directory, GIT_CEILING_DIRECTORIES: dirname(f.directory), PM_GLOBAL_PATH: join(f.directory, "global") } });
      return (json ? JSON.parse(output) : decodeToon(output)) as ProgressReport;
    };
    const run = passingRun("corrected-cli");
    await f.change((document) => { document.metadata.test_runs = [{ ...run, status: "failed" }]; });
    const baseline = await f.read();
    await f.change((document) => { document.metadata.test_runs = [run]; });
    const corrected = await f.read({ after: baseline.next });
    assert.equal(corrected.gains.length, 1);
    const json = invoke(baseline.next, true);
    assert.deepEqual(invoke(baseline.next, false), json, "both CLI formats retain host continuation metadata");
    for (const key of Object.keys(corrected) as Array<keyof ProgressReport>) assert.deepEqual(json[key], corrected[key]);
    await f.change((document) => { document.metadata.test_runs = []; });
    await f.change((document) => { document.metadata.test_runs = [run]; });
    for (const json of [true, false]) {
      assert.deepEqual(invoke(baseline.next, json).gains, corrected.gains);
      const tail = invoke(corrected.next, json);
      if (json) assert.deepEqual(tail.gains, []);
      else assert.ok(tail.gains === undefined || tail.gains.length === 0, "native compact TOON can omit empty collections");
    }
  } finally { await f.close(); }
});
