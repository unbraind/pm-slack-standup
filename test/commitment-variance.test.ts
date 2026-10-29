import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { decodeToon, decodePmTableRows, getHistoryPath, getItemAt, getSettingsPath, hashHistoryRecord, readHistorySnapshot } from "@unbrained/pm-cli/sdk";
import type { PmEncodedTableRows } from "@unbrained/pm-cli/sdk";
import {
  COMMITMENT_PREFIX, commitmentCliNumber, commitmentVarianceSteps, encodeStandupCommitment,
  parseCommitmentVarianceInput, parseStandupCommitment, readCommitmentVariance, validateCommitmentNumbers,
  inspectStandupCommitments,
} from "../index.ts";
import type { CommitmentVarianceInput, CommitmentVarianceReport } from "../index.ts";
import { nativeVersion, varianceFixture } from "./commitment-fixture.ts";
import { refused, changeProgress, progressScope } from "./progress-fixture.ts";
import { treeState } from "./tracker-state.ts";

test("selected native intent separates completion, revised scope, absent support and pending outcomes", async () => {
  const f = await varianceFixture();
  try {
    await f.client.close(f.targets[0], "Native linked outcome");
    await f.client.update(f.targets[1], { body: "New scope", ...progressScope });
    await f.client.update(f.targets[1], { body: "Original scope\n", ...progressScope });
    const missingHistory = getHistoryPath(f.pmRoot, f.targets[2]);
    rmSync(missingHistory);
    const before = treeState(f.pmRoot, true);
    const report = await f.report();
    assert.deepEqual(report.rows.map((row) => row.state), ["completed", "changed_scope", "unsupported", "still_pending"]);
    assert.deepEqual(report.counts, { completed: 1, changed_scope: 1, unsupported: 1, still_pending: 1 });
    assert.deepEqual(report.rows[1].changes, ["body"]);
    assert.equal(report.rows[2].reason, "target_history_unavailable");
    assert.equal(report.capture, "available");
    assert.equal(treeState(f.pmRoot, true), before, "no authoritative or derived writes");
    for (const row of report.rows.filter((row) => row.observed !== null)) {
      const history = await readHistorySnapshot(getHistoryPath(f.pmRoot, row.target!), row.target!);
      assert.equal(row.observed!.digest, hashHistoryRecord(history.entries[row.observed!.version - 1]));
      const at = await getItemAt(row.target!, String(row.baseline!.version), { pmRoot: f.pmRoot });
      assert.equal(at.document.body, (await getItemAt(f.targets[0], "1", { pmRoot: f.pmRoot })).document.body);
    }
    await f.capture("c0", f.targets[3]);
    await f.capture("c0", f.targets[0]);
    assert.equal((await f.report()).rows[0].reason, "scope_revised", "later declaration ABA is retained");
    assert.deepEqual((await f.report(["absent"])).rows.map((row) => [row.state, row.reason]), [["unsupported", "missing_capture"]]);
    assert.deepEqual(await readCommitmentVariance({ pm_root: f.pmRoot }, { source: f.selection }), await f.report());
    await f.client.update(f.source, { body: "Revised periodic scope", ...progressScope });
    assert.deepEqual((await f.report(["c3"])).rows[0].changes, ["source.body"]);
  } finally { await f.close(); }
});

test("foreign and malformed records fail alone; latest valid declaration at the explicit revision wins", async () => {
  const f = await varianceFixture();
  try {
    await changeProgress(f, f.settings, f.source, (doc) => {
      doc.metadata.comments!.push({ author: "legacy", created_at: "2026-10-25T00:00:00.000Z", text: "Ordinary legacy comment" });
      for (const text of [COMMITMENT_PREFIX + "{", COMMITMENT_PREFIX + "x".repeat(2050), COMMITMENT_PREFIX + JSON.stringify({ version: 1 })]) {
        doc.metadata.comments!.push({ author: "model", created_at: "2026-10-25T00:00:00.000Z", text });
      }
    });
    const input = { source: { id: f.source, revision: await nativeVersion(f.pmRoot, f.source) } };
    const report = await readCommitmentVariance(f.ctx, input);
    assert.equal(report.rows.length, 4);
    assert.deepEqual(report.ignored, { foreign: 1, invalid: 3 });
    const old = inspectStandupCommitments([null, 5, {}, { text: null }, { text: "Legacy" },
      { text: encodeStandupCommitment({ version: 1, key: "valid", target: { id: f.targets[0], revision: 1 } }) }]);
    assert.deepEqual(old.ignored, { foreign: 1, invalid: 4 });
    assert.equal(old.declarations.size, 1, "a bad record never rejects valid neighbors");
    assert.equal(inspectStandupCommitments(undefined).declarations.size, 0);
    // Native schema permits legacy comments without strings; no stricter item schema is imposed.
    await changeProgress(f, f.settings, f.source, (doc) => { doc.metadata.comments = []; });
    assert.equal((await f.report()).rows[0].state, "changed_scope", "removed declaration is scope evidence");
    const empty = await readCommitmentVariance(f.ctx, { source: { id: f.source, revision: await nativeVersion(f.pmRoot, f.source) } });
    assert.equal(empty.capture, "missing");
    assert.equal(empty.rows.length, 0);
    const beforeCapture = await readCommitmentVariance(f.ctx, { source: { id: f.source, revision: 1 }, keys: ["c0"] });
    assert.equal(beforeCapture.rows[0].reason, "missing_capture");
    await f.capture("constructor", f.targets[0]);
    await f.capture("__proto__", f.targets[1]);
    await f.capture("constructor", f.targets[3]);
    const selected = await readCommitmentVariance(f.ctx, { source: { id: f.source, revision: await nativeVersion(f.pmRoot, f.source) } });
    assert.equal(selected.rows[0].target, f.targets[3]);
    assert.equal(selected.rows[1].key, "__proto__");
  } finally { await f.close(); }
});

test("schema refuses extreme inputs before reads; every producer validates and round-trips", async () => {
  const valid = { version: 1 as const, key: "AC", target: { id: "legacy-id", revision: 1 } };
  const invalid: unknown[] = [null, [], {}, { ...valid, version: 2 }, { ...valid, extra: true }, { ...valid, target: [] },
    { ...valid, target: { ...valid.target, extra: true } }];
  for (const key of [null, 1, "", " ", "a\r\nb", "a".repeat(65)]) invalid.push({ ...valid, key });
  for (const revision of [undefined, null, "1", NaN, Infinity, -Infinity, -1, 0, 0.1, 1000001, Number.MAX_VALUE]) invalid.push({ ...valid, target: { id: "x", revision } });
  for (const value of invalid) assert.throws(() => parseStandupCommitment(value), refused("invalid_input"));
  const source = valid.target;
  const denseWithExtra = ["a"]; Object.assign(denseWithExtra, { extra: "x" });
  for (const input of [null, [], {}, { source, extra: 1 }, ...[null, [], ["a", " a "], [""], new Array(2), Array(21).fill("a"), denseWithExtra].map((keys) => ({ source, keys })),
    ...[NaN, Infinity, -Infinity, 0, 1023, 32769, "8192", null].map((outputBytes) => ({ source, outputBytes }))]) {
    await assert.rejects(readCommitmentVariance({ pm_root: "nonexistent-tracker" }, input as CommitmentVarianceInput), refused("invalid_input"));
  }
  for (let index = 0; index < 500; index++) {
    const declaration = { ...valid, key: ` key-${index} `, target: { id: " legacy-id ", revision: 1 + index } };
    const encoded = encodeStandupCommitment(declaration);
    const parsed = parseStandupCommitment(JSON.parse(encoded.slice(COMMITMENT_PREFIX.length)));
    assert.equal(encodeStandupCommitment(parsed), encoded);
    const pretty = JSON.stringify(declaration, null, 2).replaceAll("\n", "\r\n");
    assert.deepEqual(parseStandupCommitment(JSON.parse(pretty)), parsed);
  }
  for (const value of [undefined, null, 1, "", " ", Infinity]) assert.equal(commitmentCliNumber(value), value);
  assert.equal(commitmentCliNumber("123"), 123);
  assert.equal(parseCommitmentVarianceInput({ source, keys: [" a "] }).keys![0], "a");
});

test("twenty large source bodies produce one bounded report; all emitted numbers are guarded", async () => {
  const f = await varianceFixture();
  try {
    for (let index = 4; index < 20; index++) {
      const id = (await f.client.create({ type: "Task", title: `Large ${index}`, body: "private-body-".repeat(5000), ...progressScope })).item.id;
      await f.capture(`c${index}`, id);
    }
    f.selection.revision = await nativeVersion(f.pmRoot, f.source);
    const report = await f.report();
    assert.equal(report.rows.length, 20);
    const bytes = Buffer.byteLength(JSON.stringify(report));
    assert.ok(bytes < 16384);
    assert.doesNotMatch(JSON.stringify(report), /private-body|Original scope/);
    await assert.rejects(f.report(undefined, 1024), refused("output_limit"));
    assert.deepEqual(await f.report(undefined, bytes), report);
    await assert.rejects(f.report(undefined, bytes - 1), refused("output_limit"));
    for (const number of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_VALUE]) {
      for (const field of ["count", "ignored", "revision"] as const) {
        const bad = structuredClone(report);
        if (field === "count") bad.counts.completed = number;
        else if (field === "ignored") bad.ignored.foreign = number;
        else bad.rows[0].baseline!.version = number;
        assert.throws(() => validateCommitmentNumbers(bad), refused("invalid_output"));
      }
    }
    for (const value of [0, 1000001]) {
      const bad = structuredClone(report); bad.source.selected.version = value;
      assert.throws(() => validateCommitmentNumbers(bad), refused("invalid_output"));
    }
    const unpartitioned = structuredClone(report); unpartitioned.counts.completed++;
    assert.throws(() => validateCommitmentNumbers(unpartitioned), refused("invalid_output"));
    const wrongPartition = structuredClone(report); wrongPartition.counts.completed = 1; wrongPartition.counts.still_pending--;
    assert.throws(() => validateCommitmentNumbers(wrongPartition), refused("invalid_output"));
    const tooMany = structuredClone(report); tooMany.rows.push(report.rows[0]);
    assert.throws(() => validateCommitmentNumbers(tooMany), refused("invalid_output"));
    await f.capture("c20", f.targets[0]); f.selection.revision = await nativeVersion(f.pmRoot, f.source);
    await assert.rejects(f.report(), refused("selection_limit"));
    assert.equal((await f.report(["c0"])).rows.length, 1);
    console.log(`commitment bounded fixture: 20 commitments, ${bytes} JSON bytes, no source bodies`);
  } finally { await f.close(); }
});

test("missing, corrupt, compacted and deleted captures retain uncertainty and preserve native bytes", async () => {
  const f = await varianceFixture();
  try {
    await assert.rejects(readCommitmentVariance(f.ctx, { source: { id: "missing", revision: 1 } }), refused("history_unavailable"));
    await assert.rejects(readCommitmentVariance(f.ctx, { source: { id: f.source, revision: 10000 } }), refused("revision_unavailable"));
    await f.capture("future", f.targets[0], 1000000);
    f.selection.revision = await nativeVersion(f.pmRoot, f.source);
    assert.equal((await f.report(["future"])).rows[0].reason, "target_history_unavailable");
    await f.client.historyCompact(f.targets[1], { force: true });
    assert.equal((await f.report(["c1"])).rows[0].state, "unsupported");
    await f.client.delete(f.targets[2]);
    assert.equal((await f.report(["c2"])).rows[0].reason, "target_state_unavailable");
    const path = getHistoryPath(f.pmRoot, f.targets[3]); const original = readFileSync(path, "utf8");
    try {
      for (const bytes of ["{broken\n", "null\n", ""]) {
        writeFileSync(path, bytes);
        const before = treeState(f.pmRoot, true);
        assert.equal((await f.report(["c3"])).rows[0].state, "unsupported");
        assert.equal(treeState(f.pmRoot, true), before);
      }
    } finally { writeFileSync(path, original); }
    await f.client.historyCompact(f.source, { force: true });
    await assert.rejects(f.report(), refused("revision_unavailable"));
  } finally { await f.close(); }
});

test("SDK status roles decide outcomes for custom done, canceled, active, blocked and opaque terminal states", async () => {
  const f = await varianceFixture();
  try {
    for (const [name, roles, state, reason] of [
      ["review_complete", ["terminal_done"], "completed", "linked_done_status"],
      ["done_but_abandoned", ["terminal_done", "terminal_canceled"], "changed_scope", "canceled"],
      ["not_done", ["active"], "still_pending", "no_linked_completion"],
      ["waiting_custom", ["blocked"], "still_pending", "no_linked_completion"],
      ["draft_custom", ["draft"], "still_pending", "no_linked_completion"],
      ["open_role_only", ["default_open"], "still_pending", "no_linked_completion"],
      ["close_role_only", ["default_close"], "unsupported", "status_without_lifecycle_role"],
      ["opaque", ["terminal"], "unsupported", "terminal_without_done_role"],
    ] as const) {
      await f.client.schemaAddStatus(name, { role: [...roles] });
      await f.client.update(f.targets[0], { status: name, ...progressScope });
      const row = (await f.report(["c0"])).rows[0];
      assert.equal(row.state, state); assert.equal(row.reason, reason);
    }
    await f.client.schemaRemoveStatus("opaque", { force: true });
    assert.equal((await f.report(["c0"])).rows[0].state, "unsupported");
  } finally { await f.close(); }
});

test("unreadable settings refuse safely at initial and final boundaries", async () => {
  const f = await varianceFixture();
  const path = getSettingsPath(f.pmRoot);
  const original = readFileSync(path, "utf8");
  try {
    writeFileSync(path, "{broken JSON");
    await assert.rejects(f.report(), refused("history_unavailable"));
    writeFileSync(path, JSON.stringify({ ...JSON.parse(original), item_format: "json_markdown" }));
    assert.equal((await f.report()).rows.length, 4, "legacy format warning is compatible");
    writeFileSync(path, original);
    rmSync(path); mkdirSync(path);
    await assert.rejects(f.report(), refused("history_unavailable"));
    rmSync(path, { recursive: true }); writeFileSync(path, original);
    const steps = commitmentVarianceSteps(f.ctx, { source: f.selection, keys: ["c0"] });
    let step = await steps.next();
    while (!step.done && step.value.phase !== "settings_recheck") step = await steps.next();
    rmSync(path); mkdirSync(path);
    await assert.rejects(steps.next(), refused("source_changed"));
  } finally { rmSync(path, { recursive: true, force: true }); writeFileSync(path, original); await f.close(); }
});

test("same-content target revisions remain different declared intentions", async () => {
  const f = await varianceFixture();
  try {
    await f.client.comments(f.targets[0], { add: "Activity preserves scope" });
    const revision = await nativeVersion(f.pmRoot, f.targets[0]);
    assert.equal((await f.report(["c0"])).rows[0].state, "still_pending");
    await f.capture("c0", f.targets[0], revision);
    await f.capture("c0", f.targets[0], 1);
    const row = (await f.report(["c0"])).rows[0];
    assert.equal(row.state, "changed_scope");
    assert.deepEqual(row.changes, ["declaration"]);
  } finally { await f.close(); }
});

test("competing SDK transitions at every read boundary are observed or refused without a write", async () => {
  const f = await varianceFixture();
  try {
    const input = { source: f.selection, keys: ["c0"] };
    const boundaries = [];
    const discovery = commitmentVarianceSteps(f.ctx, input);
    let found = await discovery.next();
    while (!found.done) { boundaries.push(found.value); found = await discovery.next(); }
    const targetBoundary = boundaries.findIndex((boundary) => boundary.phase === "target");
    const finalTargetCheck = boundaries.findIndex((boundary) => boundary.phase === "recheck" && boundary.id === f.targets[0]);
    for (let cut = 0; cut < boundaries.length; cut++) {
      const steps = commitmentVarianceSteps(f.ctx, input);
      let observedTarget = false;
      let index = 0;
      let step = await steps.next();
      let injected = false;
      try {
        while (!step.done) {
          if (index === cut) {
            await f.client.update(f.targets[0], { body: `Peer ${cut}`, ...progressScope });
            injected = true;
          }
          if (step.value.phase === "target") observedTarget = true;
          step = await steps.next(); index++;
        }
        assert.equal(injected, true);
        assert.ok(cut <= targetBoundary || cut > finalTargetCheck, "a peer before its final target check must refuse");
        const row = step.value.rows[0];
        assert.equal(row.state, "changed_scope");
        // A peer after this target's final check is the documented remaining window.
        if (cut <= targetBoundary) {
          assert.equal(row.observed!.version, await nativeVersion(f.pmRoot, f.targets[0]));
        }
      } catch (error) {
        assert.ok(observedTarget && refused("source_changed")(error));
      } finally { await steps.return({} as CommitmentVarianceReport); }
    }
    for (const kind of ["source", "settings", "missing_target"]) {
      const steps = commitmentVarianceSteps(f.ctx, { source: f.selection, keys: ["c0"] });
      const advance = async (): Promise<void> => {
        let next = await steps.next();
        while (!next.done && next.value.phase !== "recheck") next = await steps.next();
      };
      await advance();
      if (kind === "source") await f.client.comments(f.source, { add: "Peer source append" });
      if (kind === "settings") await f.client.schemaAddStatus("peer_status", { role: ["active"] });
      if (kind === "missing_target") rmSync(getHistoryPath(f.pmRoot, f.targets[0]));
      await assert.rejects(async () => { for await (const boundary of steps) assert.ok(boundary); }, refused("source_changed"));
    }
  } finally { await f.close(); }
});

test("installed CLI JSON and TOON work without git, validate supplied guards, and share SDK results", async () => {
  const f = await varianceFixture();
  try {
    const source = join(f.directory, "extension");
    await mkdir(source);
    await Promise.all(["dist", "docs", "README.md", "manifest.json", "package.json"].map((file) => cp(resolve(file), join(source, file), { recursive: true })));
    await f.client.packageInstall(source, { project: true });
    const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
    const base = [cli, "--path", f.pmRoot, "standup", "variance", f.source, "--revision", String(f.selection.revision)];
    const options = { encoding: "utf8" as const, cwd: f.directory, env: { ...process.env,
      PM_GLOBAL_PATH: join(f.directory, "global"), PATH: f.directory, GIT_CEILING_DIRECTORIES: dirname(f.directory) } };
    const json = JSON.parse(execFileSync(process.execPath, [...base, "--json"], options));
    const toon = decodeToon(execFileSync(process.execPath, base, options)) as Record<string, unknown>;
    toon.rows = decodePmTableRows({ rows: toon.rows, encoding: toon.rows_encoding } as PmEncodedTableRows);
    delete toon.rows_encoding;
    assert.deepEqual(toon, json);
    assert.deepEqual(json, await f.report());
    for (const suffix of [["--revision", " "], ["--revision", "Infinity"], ["--output-bytes", ""], ["--keys", "c0,,c1"]]) {
      const result = spawnSync(process.execPath, [...base, ...suffix, "--json"], options);
      assert.equal(result.status, 2); assert.equal(JSON.parse(result.stderr).code, "invalid_input");
    }
    const receipt = await f.harness.runCommand({ command: "standup variance", args: [f.source], pmRoot: f.pmRoot,
      options: { revision: f.selection.revision, keys: "c0,c1", outputBytes: 32768 } });
    assert.deepEqual(receipt.result, await f.report(["c0", "c1"], 32768));
    await assert.rejects(f.harness.runCommand({ command: "standup variance", args: [], pmRoot: f.pmRoot, options: {} }), refused("invalid_input"));
  } finally { await f.close(); }
});
