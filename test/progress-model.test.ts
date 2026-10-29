import assert from "node:assert/strict";
import test from "node:test";
import { canonicalDocument } from "@unbrained/pm-cli/sdk";
import { encodeProgressEvidence, parseProgressEvidence, readProgressDeltas, PROGRESS_EVIDENCE_PREFIX } from "../index.ts";
import { evidence, passingRun, progressFixture, progressScope, changeProgress, currentProgress } from "./progress-fixture.ts";

/** Deterministic generator makes failing operation sequences reproducible without a dependency. */
function randomFor(seed: number): () => number {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

test("500 seeded native-state sequences preserve relationships and reject evidence replays across windows", async () => {
  const f = await progressFixture();
  let operations = 0;
  try {
    for (let seed = 1; seed <= 500; seed++) {
      const random = randomFor(seed);
      await f.client.focus(f.items[Math.floor(random() * f.items.length)].id);
      const id = (await f.client.create({ title: `Sequence ${seed}`, type: "Task", ...progressScope })).item.id;
      const native = await currentProgress(f, id);
      const target = `target-${Math.floor(random() * 5)}`;
      const assessment = evidence({ kind: random() < 0.5 ? "criterion" : "readiness", subject: seed % 7 === 0 ? "__proto__" : `AC${seed}`,
        targetRevision: target, evidenceRevision: `evidence-${seed}` });
      if (assessment.kind === "readiness") assessment.value = random() < 0.5 ? "ready" : "not_ready";
      const encoded = encodeProgressEvidence(assessment);
      const normalized = parseProgressEvidence(JSON.parse(encoded.slice(PROGRESS_EVIDENCE_PREFIX.length)));
      const body = random() < 0.5 ? `Native body\r\nseed ${seed}` : `Native body\nseed ${seed}`;
      const dependencies = [{ id: f.id, kind: "relates_to" as const }];
      const run = passingRun(`run-${seed}`, 1 + Math.floor(random() * 20));
      const expected = canonicalDocument({ metadata: { ...native, dependencies, test_runs: [run] }, body });
      const initial = await readProgressDeltas(f.ctx, id);
      // A native run identity exists before it becomes usable passing evidence.
      const rejectedRun = { ...run, ...[
        { status: "failed" as const }, { status: "canceled" as const }, { passed: 0 },
        { passed: 1000001 }, { failed: 1 }, { skipped: 1 },
      ][Math.floor(random() * 6)] };
      await changeProgress(f, f.settings, id, (doc) => { doc.metadata.test_runs = [rejectedRun]; });
      operations++;
      assert.deepEqual((await currentProgress(f, id)).test_runs,
        canonicalDocument({ metadata: { ...native, test_runs: [rejectedRun] }, body: "" }).metadata.test_runs);
      const base = await readProgressDeltas(f.ctx, id, { after: initial.next });
      assert.deepEqual(base.gains, [], `unqualified seed ${seed}`);
      const comments = [{ author: "model", created_at: "2026-10-25T00:00:00.000Z", text: encoded }];
      await changeProgress(f, f.settings, id, (doc) => {
        doc.body = body; doc.metadata.dependencies = dependencies;
        doc.metadata.test_runs = [run]; doc.metadata.comments = comments;
      });
      operations++;
      // The oracle keeps the exact native values written. SDK read-back owns normalization.
      let current = await currentProgress(f, id);
      assert.deepEqual(current.dependencies, expected.metadata.dependencies, `relationships seed ${seed}`);
      assert.deepEqual(current.test_runs, expected.metadata.test_runs);
      assert.deepEqual(current.comments, comments);
      const first = await readProgressDeltas(f.ctx, id, { after: base.next });
      assert.deepEqual(first.gains.map((gain) => [gain.kind, gain.evidenceRevision, gain.count]),
        [["passing_tests", `run:run-${seed}`, run.passed], [normalized.kind, normalized.evidenceRevision, 1]]);
      assert.equal(first.gains[0].revision.version, first.through, `first qualifying revision seed ${seed}`);
      assert.deepEqual(await readProgressDeltas(f.ctx, id, { after: base.next }), first);
      // Remove inputs, then replay older native data with whitespace/CRLF serialization changes.
      const operation = Math.floor(random() * 4);
      await changeProgress(f, f.settings, id, (doc) => {
        if (operation === 0 || operation === 1) doc.metadata.comments = [];
        if (operation === 0 || operation === 2) doc.metadata.test_runs = [];
        if (operation === 3) doc.metadata.status = "in_progress";
      });
      operations++;
      const intermediate = await currentProgress(f, id);
      const intermediateExpected = canonicalDocument({ metadata: { ...expected.metadata,
        status: operation === 3 ? "in_progress" : expected.metadata.status,
        comments: operation === 0 || operation === 1 ? [] : comments,
        test_runs: operation === 0 || operation === 2 ? [] : expected.metadata.test_runs }, body }).metadata;
      assert.equal(intermediate.status, intermediateExpected.status);
      assert.deepEqual(intermediate.comments, intermediateExpected.comments);
      assert.deepEqual(intermediate.test_runs, intermediateExpected.test_runs);
      assert.deepEqual(intermediate.dependencies, expected.metadata.dependencies);
      const replayText = PROGRESS_EVIDENCE_PREFIX + JSON.stringify({ ...assessment, subject: ` ${assessment.subject} ` }, null, 2).replaceAll("\n", "\r\n");
      const replayStatus = random() < 0.5 ? "in_progress" : "open";
      await changeProgress(f, f.settings, id, (doc) => {
        doc.metadata.comments = [{ ...comments[0], text: replayText }]; doc.metadata.test_runs = [run];
        doc.metadata.status = replayStatus;
      });
      operations++;
      const replay = await readProgressDeltas(f.ctx, id, { after: first.next });
      assert.deepEqual(replay.gains, [], `replay seed ${seed}`);
      current = await currentProgress(f, id);
      assert.equal(current.status, replayStatus);
      assert.deepEqual(current.dependencies, expected.metadata.dependencies);
      assert.deepEqual(current.test_runs, expected.metadata.test_runs);
      assert.equal(current.comments?.[0].text, replayText);
      assert.equal(current.parent, native.parent, "ambient relationships remain explicit");
      const after = await f.client.get(id, { full: true });
      assert.equal(after.item.body, expected.body, "body round-trips through the SDK");
      for (const number of [first.from, first.through, first.remaining, ...first.gains.map((gain) => gain.count)]) {
        assert.ok(Number.isSafeInteger(number) && number >= 0);
      }
      await f.client.delete(id);
      if (seed % 100 === 0) console.log(`progress-model: ${seed}/500 sequences checked`);
    }
    assert.equal(operations, 2000);
    console.log("progress-model: 500 sequences, 2000 native mutations, SDK read-back after replay, zero mismatches");
  } finally { await f.close(); }
});
