import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { decodeToon, getHistoryPath, getItemAt, locateItem } from "@unbrained/pm-cli/sdk";
import { commitmentVarianceSteps, readProgressDeltas, readSdkStandupItems } from "../index.ts";
import type { CommitmentVarianceReport } from "../index.ts";
import { readVerifiedStandupHistory } from "../verified-history.ts";
import { acceptanceEnvironment, acceptanceLaunchers, packedTarball, run } from "../scripts/accept-packed.ts";
import { nativeVersion, varianceFixture } from "./commitment-fixture.ts";
import { refused } from "./progress-fixture.ts";
import { treeState } from "./tracker-state.ts";

/** Resolve only the native item selected by the disposable fixture, without assuming its format or folder. */
async function itemPath(pmRoot: string, id: string): Promise<string> {
  const item = await locateItem(pmRoot, id);
  assert.ok(item);
  return item.itemPath;
}
/** Reject materialized item projections and rendered titles, while allowing explicit historical links to an unavailable target. */
function noLiveOutcome(value: unknown, id: string, title: string): void {
  if (typeof value === "string") { assert.ok(!value.includes(title), "unavailable item title must not be rendered"); return; }
  if (value === null || typeof value !== "object") return;
  if (!Array.isArray(value) && "id" in value && "status" in value) assert.notEqual(value.id, id, "unavailable native item must not be reported as live");
  for (const entry of Object.values(value)) noLiveOutcome(entry, id, title);
}

test("retained materialization cannot certify an unavailable target in any SDK report", async () => {
  const f = await varianceFixture();
  const target = f.targets[0];
  const path = await itemPath(f.pmRoot, target);
  const original = readFileSync(path);
  try {
    await f.client.close(target, "Observed completion");
    const closed = readFileSync(path);
    assert.equal((await f.report(["c0"])).rows[0].state, "completed");
    const history = getHistoryPath(f.pmRoot, target);
    const bytes = readFileSync(history);
    rmSync(path);
    const before = treeState(f.pmRoot, true);
    const report = await f.report(["c0"]);
    assert.equal(report.rows[0].state, "unsupported");
    assert.equal(report.counts.completed, 0);
    await assert.rejects(readVerifiedStandupHistory(f.pmRoot, target), refused("history_unavailable"));
    await assert.rejects(readProgressDeltas(f.ctx, target), refused("history_unavailable"));
    assert.deepEqual(readFileSync(history), bytes, "availability checks must not manufacture deletion history");
    assert.equal(treeState(f.pmRoot, true), before);
    // Native historical reconstruction remains possible, and is deliberately not present-state evidence.
    assert.ok((await getItemAt(target, String(await nativeVersion(f.pmRoot, target)), { pmRoot: f.pmRoot })).document.metadata.id);
    try { noLiveOutcome(await readSdkStandupItems(f.ctx), target, "Commitment 0"); }
    catch (error) { assert.ok(refused("history_unavailable")(error)); }
    const commands = f.harness.activation.commands.handlers.map(({ command }) => command);
    for (const command of commands) {
      try {
        const response = await f.harness.runCommand({ command, pmRoot: f.pmRoot,
          args: [command === "standup progress" ? target : f.source],
          options: { revision: f.selection.revision, dryRun: true, includeDone: true, allOpen: true, format: "plain" } });
        noLiveOutcome(response.result, target, "Commitment 0");
        if (command === "standup variance") assert.equal((response.result as CommitmentVarianceReport).rows[0].state, "unsupported");
      } catch (error) { assert.ok(refused("history_unavailable")(error)); }
    }
    for (const format of ["json", "md"]) {
      const response = await f.harness.runExporter({ exporter: "standup", pmRoot: f.pmRoot, options: { format, includeDone: true, allOpen: true } });
      noLiveOutcome(response.result, target, "Commitment 0");
    }
    writeFileSync(path, closed);
    assert.equal((await f.report(["c0"])).rows[0].state, "completed", "restoring real current storage restores support");
    await f.client.delete(target);
    assert.equal((await readProgressDeltas(f.ctx, target)).id, target, "supported native deleted-history reads survive");
    assert.equal((await f.report(["c0"])).rows[0].state, "unsupported");
  } finally { writeFileSync(path, original); await f.close(); }
});

test("source and target disappearance at every read boundary is observed or refused", async () => {
  const f = await varianceFixture();
  try {
    await f.client.close(f.targets[0], "Boundary completion");
    const input = { source: f.selection, keys: ["c0"] };
    const boundaries = [];
    const initial = commitmentVarianceSteps(f.ctx, input);
    let first = await initial.next();
    while (!first.done) { boundaries.push(first.value); first = await initial.next(); }
    for (const role of ["source", "target"] as const) {
      const id = role === "source" ? f.source : f.targets[0];
      const path = await itemPath(f.pmRoot, id);
      const bytes = readFileSync(path);
      const history = readFileSync(getHistoryPath(f.pmRoot, id));
      const observedAt = boundaries.findIndex((boundary) => boundary.phase === role);
      const checkedAt = boundaries.findIndex((boundary) => boundary.phase === "recheck" && boundary.id === id);
      for (let cut = 0; cut < boundaries.length; cut++) {
        const iterator = commitmentVarianceSteps(f.ctx, input);
        let index = 0;
        let next = await iterator.next();
        try {
          while (!next.done) {
            if (index === cut) rmSync(path);
            next = await iterator.next(); index++;
          }
          if (cut <= observedAt) {
            assert.equal(role, "target", "a missing source cannot produce a report");
            assert.equal(next.value.rows[0].state, "unsupported");
          } else {
            assert.ok(cut > checkedAt, "disappearance before that stream's final recheck must refuse");
            assert.equal(next.value.rows[0].state, "completed", "only the documented post-check window may retain the prior observation");
          }
        } catch (error) {
          assert.ok(cut <= checkedAt);
          assert.ok(refused(cut <= observedAt && role === "source" ? "history_unavailable" : "source_changed")(error));
        } finally {
          await iterator.return({} as CommitmentVarianceReport);
          writeFileSync(path, bytes);
        }
        assert.deepEqual(readFileSync(getHistoryPath(f.pmRoot, id)), history);
      }
    }
  } finally { await f.close(); }
});

test("every installed command and export excludes unavailable outcomes in JSON and TOON without git", async () => {
  const f = await varianceFixture();
  try {
    const launcher = acceptanceLaunchers(process.platform, process.env.npm_execpath, process.execPath, process.env.PATH).npm;
    run(launcher.command, [...launcher.prefix, "pack", "--ignore-scripts", "--pack-destination", f.directory], resolve("."));
    await f.client.packageInstall(packedTarball(f.directory), { project: true });
    await f.client.close(f.targets[0], "Installed completion");
    rmSync(await itemPath(f.pmRoot, f.targets[0]));
    const environment = { ...acceptanceEnvironment(process.env), PM_GLOBAL_PATH: join(f.directory, "isolated-global"),
      GIT_CEILING_DIRECTORIES: dirname(f.directory), PATH: f.directory };
    const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
    const names = f.harness.activation.commands.handlers.map(({ command }) => command);
    for (const command of names) for (const json of [false, true]) {
      const args = command.split(" ");
      if (command === "standup variance") args.push(f.source, "--revision", String(f.selection.revision));
      else if (command === "standup progress") args.push(f.targets[0]);
      else if (["standup", "slack-standup"].includes(command)) args.push("--dry-run", "--include-done", "--all-open", "--format", "plain");
      else if (command === "standup export") args.push("--include-done", "--all-open", "--format", "json");
      if (json) args.push("--json");
      const before = treeState(f.pmRoot);
      const output = spawnSync(process.execPath, [cli, "--path", f.pmRoot, ...args], { cwd: f.directory, env: environment, encoding: "utf8", timeout: 60000 });
      if (command === "standup progress" || output.status === 2) {
        assert.equal(output.status, 2, output.stderr);
        assert.match(output.stderr, /history_unavailable/);
      } else {
        assert.equal(output.status, 0, output.stderr);
        noLiveOutcome(output.stdout, f.targets[0], "Commitment 0");
        if (command === "standup variance") {
          const report = (json ? JSON.parse(output.stdout) : decodeToon(output.stdout)) as CommitmentVarianceReport;
          assert.equal(report.rows[0].state, "unsupported");
          assert.equal(report.counts.completed, 0);
        }
      }
      assert.equal(treeState(f.pmRoot), before, "reports never repair missing native storage");
    }
  } finally { await f.close(); }
});
