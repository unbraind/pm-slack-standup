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
      const base = await readProgressDeltas(f.ctx, id);
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
      assert.deepEqual(await readProgressDeltas(f.ctx, id, { after: base.next }), first);
      // Remove inputs, then replay older native data with whitespace/CRLF serialization changes.
      await changeProgress(f, f.settings, id, (doc) => { doc.metadata.comments = []; doc.metadata.test_runs = []; });
      operations++;
      const replayText = PROGRESS_EVIDENCE_PREFIX + JSON.stringify({ ...assessment, subject: ` ${assessment.subject} ` }, null, 2).replaceAll("\n", "\r\n");
      await changeProgress(f, f.settings, id, (doc) => {
        doc.metadata.comments = [{ ...comments[0], text: replayText }]; doc.metadata.test_runs = [run];
        doc.metadata.status = random() < 0.5 ? "in_progress" : "open";
      });
      operations++;
      const replay = await readProgressDeltas(f.ctx, id, { after: first.next });
      assert.deepEqual(replay.gains, [], `replay seed ${seed}`);
      current = await currentProgress(f, id);
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
    assert.equal(operations, 1500);
    console.log("progress-model: 500 sequences, 1500 native mutations, SDK read-back after replay, zero mismatches");
  } finally { await f.close(); }
});
