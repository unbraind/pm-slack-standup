import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodeToon, getItemAt } from "@unbrained/pm-cli/sdk";
import { encodeProgressEvidence, inspectProgressComment, parseProgressEvidence, parseProgressOptions, readProgressDeltas, validateProgressNumbers, PROGRESS_EVIDENCE_PREFIX } from "../index.ts";
import { progressFixture, evidence, passingRun, refused } from "./progress-fixture.ts";

/** Revision claims are compared with independent SDK historical read-back. */
test("native results and explicit assessments name their original revision; status and comments supply zero gains", async () => {
  const f = await progressFixture();
  try {
    const baseline = await f.read();
    await f.client.update(f.id, { status: "in_progress" });
    await f.client.comments(f.id, { add: "Status is green; all tests passed" });
    const activity = await f.read({ after: baseline.next });
    assert.deepEqual(activity.gains, []);
    assert.equal(activity.activity.status, 1);
    assert.equal(activity.activity.comments, 1);
    await f.change((doc) => { doc.metadata.test_runs = [passingRun()]; });
    await f.client.comments(f.id, { add: encodeProgressEvidence(evidence()) });
    await f.client.comments(f.id, { add: encodeProgressEvidence(evidence({ kind: "readiness", value: "ready" })) });
    const report = await f.read({ after: activity.next });
    assert.deepEqual(report.gains.map((gain) => gain.revision.version), [activity.through + 1, activity.through + 2, activity.through + 3]);
    validateProgressNumbers(report);
    for (const value of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_VALUE]) {
      for (const path of ["count", "version", "activity"]) {
        const invalid = structuredClone(report);
        if (path === "count") invalid.gains[0].count = value;
        else if (path === "version") invalid.gains[0].revision.version = value;
        else invalid.activity.status = value;
        assert.throws(() => validateProgressNumbers(invalid), refused("invalid_output"));
      }
    }
    const backwards = structuredClone(report); backwards.from = backwards.through + 1;
    assert.throws(() => validateProgressNumbers(backwards), refused("invalid_output"));
    for (const count of [0, 1000001]) {
      const invalid = structuredClone(report); invalid.gains[0].count = count;
      assert.throws(() => validateProgressNumbers(invalid), refused("invalid_output"));
    }
    const future = structuredClone(report); future.gains[0].revision.version = future.through + 1;
    assert.throws(() => validateProgressNumbers(future), refused("invalid_output"));
    assert.deepEqual(report.gains.map((row) => [row.kind, row.count]), [["passing_tests", 3], ["criterion", 1], ["readiness", 1]]);
    for (const row of report.gains) {
      assert.equal(row.revision.digest.length, 64);
      assert.ok(row.evidenceRevision);
      const at = await getItemAt(f.id, String(row.revision.version), { pmRoot: f.pmRoot });
      assert.equal(at.as_of_version, row.revision.version);
      assert.equal(at.document.metadata.id, f.id);
    }
    assert.deepEqual(await f.read({ after: activity.next }), report, "render retry is deterministic");
    assert.deepEqual((await f.read({ after: report.next })).gains, []);
    await f.change((doc) => { doc.metadata.test_runs = []; });
    await f.change((doc) => { doc.metadata.test_runs = [passingRun()]; });
    // Whitespace/CRLF input serialization remains equivalent through the producer's schema.
    await f.client.comments(f.id, { add: PROGRESS_EVIDENCE_PREFIX + JSON.stringify(evidence({ subject: " AC1 " }), null, 2).replaceAll("\n", "\r\n") });
    const replay = await f.read({ after: report.next });
    assert.deepEqual(replay.gains, []);
    assert.equal(replay.ignored.duplicate, 2);
    await f.client.comments(f.id, { add: encodeProgressEvidence(evidence({ targetRevision: "artifact-v2" })) });
    const newTarget = await f.read({ after: replay.next });
    assert.equal(newTarget.gains.length, 1, "new target revision is a distinct assessment");
    await f.client.comments(f.id, { add: encodeProgressEvidence(evidence({ kind: "readiness", value: "ready", evidenceRevision: "test-v2" })) });
    const unchanged = await f.read({ after: newTarget.next });
    assert.deepEqual(unchanged.gains, []);
    assert.equal(unchanged.ignored.unchanged, 1);
    // Replaying the unchanged assessment before the next boundary also remains silent.
    await f.read({ after: unchanged.next });
    await f.client.comments(f.id, { add: encodeProgressEvidence(evidence({ kind: "readiness", value: "not_ready", evidenceRevision: "test-v3" })) });
    assert.equal((await f.read({ after: unchanged.next })).gains[0].value, "not_ready");
  } finally { await f.close(); }
});

test("strict shared schema rejects extreme inputs and accepts all producer round trips", () => {
  const bad: unknown[] = [null, [], new Array(4), {}, { ...evidence(), extra: 1 }, { ...evidence(), version: 2 },
    { ...evidence(), kind: "test" }, { ...evidence(), value: "reviewed" }, { ...evidence(), kind: "readiness", value: "accepted" }];
  for (const field of ["subject", "targetRevision", "evidenceRevision"]) {
    for (const value of [null, [], Infinity, NaN, "", " ", "x".repeat(257), "bad\r\ntext", "\u0000"]) bad.push({ ...evidence(), [field]: value });
  }
  for (const value of bad) assert.throws(() => parseProgressEvidence(value), refused("invalid_input"));
  for (const value of [null, [], { extra: 1 }, { after: 1 }, { after: "" }, { after: " " }, { events: true }, { events: null }, { outputBytes: null }, { events: " " }, { outputBytes: " " }, { after: "x".repeat(1025) },
    ...[NaN, Infinity, -Infinity, -1, 0, 501, 0.5, Number.MAX_VALUE].map((events) => ({ events })),
    ...[NaN, Infinity, -1, 1023, 32769, 1024.5].map((outputBytes) => ({ outputBytes }))]) {
    assert.throws(() => parseProgressOptions(value), refused("invalid_input"));
  }
  assert.deepEqual(parseProgressOptions({}), { after: undefined, events: 100, outputBytes: 8192 });
  for (const value of [evidence(), evidence({ kind: "readiness", value: "not_ready", subject: " constructor " }), evidence({ subject: "__proto__" })]) {
    const produced = encodeProgressEvidence(value);
    assert.deepEqual(parseProgressEvidence(JSON.parse(produced.slice(PROGRESS_EVIDENCE_PREFIX.length))), parseProgressEvidence(value));
  }
});

test("historical native comment inspection isolates malformed records without rejecting their item", () => {
  const valid = { text: encodeProgressEvidence(evidence()), author: "legacy", created_at: "2026-10-25T00:00:00Z" };
  for (const comment of [null, undefined, 1, [], {}, { text: 1 }, { ...valid, author: "" }, { ...valid, created_at: "" },
    { ...valid, text: PROGRESS_EVIDENCE_PREFIX + " ".repeat(8192) }]) {
    assert.equal(inspectProgressComment(comment).kind, "invalid");
  }
  assert.equal(inspectProgressComment({ text: "legacy free-form annotation" }).kind, "foreign");
  assert.deepEqual(inspectProgressComment(valid), { kind: "evidence", evidence: evidence() });
});

test("bad native and declared records fail alone; foreign comments are skipped", async () => {
  const f = await progressFixture();
  try {
    const baseline = await f.read();
    await f.change((doc) => {
      doc.metadata.test_runs = [passingRun("bad", 0), { ...passingRun("failed"), status: "failed" }, passingRun("valid")];
    });
    for (const text of ["foreign/v1 {}", PROGRESS_EVIDENCE_PREFIX + "{broken", PROGRESS_EVIDENCE_PREFIX + JSON.stringify({ version: 9 }),
      encodeProgressEvidence(evidence({ kind: "readiness", value: "not_ready" }))]) await f.client.comments(f.id, { add: text });
    const report = await f.read({ after: baseline.next });
    assert.equal(report.gains.length, 2);
    assert.ok(report.ignored.invalid >= 3);
    assert.equal(report.ignored.foreign, 1);
    const path = join(f.pmRoot, "history", `${f.id}.jsonl`);
    const source = readFileSync(path, "utf8");
    try {
      writeFileSync(path, source.replace(/"after_hash":"[a-f0-9]+"/, '"after_hash":"broken"'));
      await assert.rejects(f.read(), refused("history_unavailable"));
    } finally { writeFileSync(path, source); }
    rmSync(path);
    await assert.rejects(f.read(), refused("history_unavailable"));
  } finally { await f.close(); }
});

test("checkpoint pagination refuses wrong items, changed prefixes and unbounded output without advancing", async () => {
  const f = await progressFixture();
  try {
    const first = await f.read({ events: 1 });
    assert.equal(first.through, 1);
    await f.client.comments(f.id, { add: encodeProgressEvidence(evidence({ subject: "😀".repeat(120) })) });
    const full = await f.read();
    assert.ok(full.through > first.through);
    assert.deepEqual((await f.read({ after: first.next })).gains, full.gains);
    await f.client.comments(f.id, { add: encodeProgressEvidence(evidence({ subject: "another assessment" })) });
    await assert.rejects(f.read({ outputBytes: 1024 }), refused("output_limit"));
    const decoded = JSON.parse(Buffer.from(full.next, "base64url").toString("utf8")) as unknown[];
    for (const token of ["{", "e30", ...[[2, ...decoded.slice(1)], [1, "other", ...decoded.slice(2)], [1, f.id, 0, ""],
      [1, f.id, Infinity, ""], [1, f.id, 99999, ""], [1, f.id, 1, "wrong"], [...decoded, 1]].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")), full.next + "="]) {
      await assert.rejects(f.read({ after: token }), refused("checkpoint_mismatch"));
    }
    await assert.rejects(readProgressDeltas(f.ctx, ""), refused("invalid_input"));
    await assert.rejects(f.read({ events: Infinity }), refused("invalid_input"));
    assert.equal((await readProgressDeltas({ pm_root: f.pmRoot }, f.id)).gains.length, 2);
  } finally { await f.close(); }
});

test("real CLI JSON and TOON work without git and reuse returned checkpoints", async () => {
  const f = await progressFixture();
  try {
    const sourceRoot = join(f.directory, "package-source");
    mkdirSync(sourceRoot);
    for (const entry of ["package.json", "manifest.json", "README.md", "docs", "dist"]) {
      cpSync(resolve(entry), join(sourceRoot, entry), { recursive: true });
    }
    execFileSync(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", f.pmRoot,
      "package", "install", sourceRoot, "--project"], { cwd: f.directory, stdio: "pipe",
      env: { ...process.env, PM_GLOBAL_PATH: join(f.directory, "global") } });
    const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
    const args = [cli, "--path", f.pmRoot, "standup", "progress", f.id];
    const options = { cwd: f.directory, encoding: "utf8" as const, env: { ...process.env, PATH: f.directory,
      GIT_CEILING_DIRECTORIES: dirname(f.directory), PM_GLOBAL_PATH: join(f.directory, "global") } };
    await f.client.comments(f.id, { add: encodeProgressEvidence(evidence()) });
    const json = JSON.parse(execFileSync(process.execPath, [...args, "--events", "100", "--output-bytes", "32768", "--json"], options));
    assert.deepEqual(decodeToon(execFileSync(process.execPath, args, options)), json);
    assert.equal(json.gains.length, 1);
    const next = JSON.parse(execFileSync(process.execPath, [...args, "--after", json.next, "--json"], options));
    assert.deepEqual(next.gains, []);
    assert.throws(() => execFileSync(process.execPath, [...args, "--after", " "], { ...options, stdio: "pipe" }),
      (error: unknown) => error instanceof Error && "status" in error && error.status === 2);
    assert.throws(() => execFileSync(process.execPath, [...args, "--events", "Infinity"], { ...options, stdio: "pipe" }),
      (error: unknown) => error instanceof Error && "status" in error && error.status === 2);
    const receipt = await f.harness.runCommand({ command: "standup progress", args: [f.id], pmRoot: f.pmRoot, options: {} });
    assert.ok(receipt.handled);
    await assert.rejects(f.harness.runCommand({ command: "standup progress", args: [], pmRoot: f.pmRoot, options: {} }), refused("invalid_input"));
  } finally { await f.close(); }
});


test("peer appends at each read boundary are observed once across returned prefixes", async () => {
  const f = await progressFixture();
  try {
    for (const cut of ["before", "during", "after"]) {
      const baseline = await f.read();
      const add = () => f.client.comments(f.id, { add: encodeProgressEvidence(evidence({ evidenceRevision: cut })) });
      if (cut === "before") await add();
      const pending = f.read({ after: baseline.next });
      if (cut === "during") await add();
      let page;
      try { page = await pending; }
      catch (error) { assert.ok(refused("history_unavailable")(error)); page = await f.read({ after: baseline.next }); }
      if (cut === "after") await add();
      const tail = await f.read({ after: page.next });
      assert.equal(page.gains.length + tail.gains.length, 1, cut);
      assert.deepEqual((await f.read({ after: tail.next })).gains, []);
    }
  } finally { await f.close(); }
});
