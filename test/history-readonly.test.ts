import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { writeSettings, readSettings, isPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import { CommitmentRefusal, ProgressRefusal, readProgressDeltas, readSdkStandupItems } from "../index.ts";
import { treeState } from "./tracker-state.ts";
import { progressFixture, refused } from "./progress-fixture.ts";


test("every SDK and registered report refuses adversarial history without authoritative maintenance", async () => {
  const f = await progressFixture();
  const harness = f.harness;
  const path = join(f.pmRoot, "history", `${f.id}.jsonl`);
  const original = readFileSync(path, "utf8");
  const faults: Array<[string, string | null]> = [["missing", null], ["empty", " \r\n"], ["JSONL", "{broken\n"],
    ["shape", "null\n"], ["conflict", "<<<<<<< left\n=======\n>>>>>>> right\n"],
    ["hash", original.replace(/"after_hash":"[a-f0-9]+"/, '"after_hash":"broken"')]];
  try {
    assert.deepEqual(harness.activation.failed, []);
    for (const policy of ["strict_error", "auto_create"] as const) {
      const settings = await readSettings(f.pmRoot); settings.history.missing_stream = policy;
      await writeSettings(f.pmRoot, settings);
      for (const [name, source] of faults) {
        if (source === null) rmSync(path); else writeFileSync(path, source);
        const before = treeState(f.pmRoot);
        const attempts: Array<() => Promise<unknown>> = [
          () => readProgressDeltas(f.ctx, f.id), () => readProgressDeltas({ pm_root: f.pmRoot }, f.id),
          () => readSdkStandupItems(f.ctx), () => readSdkStandupItems({ pm_root: f.pmRoot }),
          ...f.harness.activation.commands.handlers.map(({ command }) => () => harness.runCommand({ command, args: [f.id], pmRoot: f.pmRoot,
            options: { "cursor-file": join(f.directory, "window.json"), revision: 1, dryRun: true, format: command === "standup" || command === "slack-standup" ? "plain" : "json", output: join(f.directory, "refused.json"), historyDir: join(f.directory, "refused-snapshots") } })),
          ...["json", "md"].map((format) => () => harness.runExporter({ exporter: "standup", pmRoot: f.pmRoot,
            options: { format, output: join(f.directory, "refused.json") } })),
        ];
        for (const [index, attempt] of attempts.entries()) {
          const allBytes = treeState(f.pmRoot, true);
          await assert.rejects(attempt(), (error: unknown) => {
            assert.ok((error instanceof ProgressRefusal || error instanceof CommitmentRefusal) && isPmCliExpectedError(error), `${policy}/${name}`);
            assert.equal(error.exitCode, 2);
            assert.equal(error.context.required, error.remedy);
            return refused("history_unavailable")(error);
          });
          assert.equal(treeState(f.pmRoot), before, `${policy}/${name}: refused reads must not change authoritative tracker bytes or mtimes`);
          if (index < 2) assert.equal(treeState(f.pmRoot, true), allBytes, "progress reads preserve derived files too");
          assert.equal(existsSync(join(f.directory, "refused.json")), false);
          assert.equal(existsSync(join(f.directory, "refused-snapshots")), false);
        }
        writeFileSync(path, original);
        assert.equal((await f.read()).id, f.id, "restored valid history remains readable");
      }
    }
    // The detector must observe native auto-create; this is a real SDK maintenance action, not a mock.
    rmSync(path);
    await f.client.run("history", { id: f.id, options: { verify: true } });
    assert.ok(existsSync(path), "native auto-create control created a stream");
  } finally { await f.close(); }
});

/** Install the actual packed-style package and an observable native on-write extension. */
async function installReadProbe(f: Awaited<ReturnType<typeof progressFixture>>): Promise<string> {
  const source = join(f.directory, "report-source"); mkdirSync(source);
  for (const entry of ["dist", "docs", "README.md", "package.json", "manifest.json"]) cpSync(resolve(entry), join(source, entry), { recursive: true });
  await f.client.packageInstall(source, { project: true });
  const probe = join(f.directory, "write-probe"); mkdirSync(probe);
  const marker = join(f.directory, "write-hook-marker");
  writeFileSync(join(probe, "manifest.json"), JSON.stringify({ name: "history-write-probe", version: "1.0.0", manifest_version: 2,
    entry: "./index.ts", capabilities: ["hooks"], permissions: { fs_write: true }, trusted: true }));
  writeFileSync(join(probe, "index.ts"), 'import { appendFileSync } from "node:fs";\nimport type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";\nexport default { activate(api: ExtensionApi) { api.hooks.onWrite(() => appendFileSync(' + JSON.stringify(marker) + ', "write\\n")); } };\n');
  await f.client.packageInstall(probe, { project: true });
  return marker;
}

test("CLI JSON and TOON refusals preserve history and never invoke native write hooks", async () => {
  const f = await progressFixture();
  try {
    const marker = await installReadProbe(f);
    const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
    const history = join(f.pmRoot, "history", `${f.id}.jsonl`);
    const original = readFileSync(history, "utf8");
    const environment = { ...process.env, PM_GLOBAL_PATH: join(f.directory, "global"), GIT_CEILING_DIRECTORIES: dirname(f.directory), PATH: f.directory };
    const invoke = (args: string[]) => spawnSync(process.execPath, [cli, "--path", f.pmRoot, ...args], {
      cwd: f.directory, env: environment, encoding: "utf8", timeout: 60000,
    });
    for (const policy of ["strict_error", "auto_create"] as const) {
      assert.equal(invoke(["config", "project", "set", "history-missing-stream-policy", "--policy", policy]).status, 0);
      if (existsSync(marker)) rmSync(marker);
      for (const bytes of [null, "{invalid JSONL\n"]) {
        if (bytes === null) rmSync(history); else writeFileSync(history, bytes);
        const before = treeState(f.pmRoot);
        for (const format of [[], ["--json"]]) {
          for (const args of [["standup", "progress", f.id], ["standup", "--dry-run"], ["slack-standup", "--dry-run"],
            ["standup", "decisions"], ["standup", "export", "--format", "json"]]) {
            const result = invoke([...args, ...format]);
            assert.equal(result.status, 2, result.stderr);
            if (format.length > 0) {
              const error = JSON.parse(result.stderr) as { code: string; required: string };
              assert.equal(error.code, "history_unavailable");
              assert.match(error.required, /read-only SDK/);
            } else {
              assert.match(result.stderr, /history_unavailable/);
              assert.match(result.stderr, /read-only SDK/);
            }
            assert.doesNotMatch(result.stderr, /history_json_invalid|history_stream_missing/);
            assert.equal(treeState(f.pmRoot), before);
            assert.equal(existsSync(marker), false, "reporting never triggers onWrite");
          }
        }
        writeFileSync(history, original);
      }
    }
    rmSync(history);
    assert.equal(invoke(["history", f.id, "--verify", "--json"]).status, 0);
    assert.ok(existsSync(marker), "native history auto-create invokes the actual installed write hook");
    assert.ok(existsSync(history));
  } finally { await f.close(); }
});

test("valid current, legacy readback and retained deleted history keep their supported behavior", async () => {
  const f = await progressFixture();
  try {
    const first = await f.read();
    assert.equal(first.id, f.id);
    await f.client.comments(f.id, { add: "Legacy annotation without declaration" });
    await f.client.delete(f.id);
    assert.equal((await f.read()).id, f.id, "retained deleted-item history remains readable");
    await assert.rejects(readProgressDeltas(f.ctx, "missing-item"), refused("history_unavailable"));
    const id = f.items[0].id;
    await f.client.comments(id, { add: "Native compaction fixture" });
    const compact = await f.client.historyCompact(id, { force: true });
    assert.equal(compact.changed, true);
    await assert.rejects(readProgressDeltas(f.ctx, id), refused("history_unavailable"));
    assert.ok((await readSdkStandupItems(f.ctx)).length > 0, "ordinary reports still accept verified compacted streams");
  } finally { await f.close(); }
});
