import assert from "node:assert/strict";
import test from "node:test";
import { canonicalDocument, getItemAt, readSettings } from "@unbrained/pm-cli/sdk";
import type { ItemDocument } from "@unbrained/pm-cli/sdk";
import { COMMITMENT_PREFIX, encodeStandupCommitment, readCommitmentVariance } from "../index.ts";
import { progressFixture, progressScope, changeProgress } from "./progress-fixture.ts";
import { nativeVersion } from "./commitment-fixture.ts";

/** Independent deterministic operation plans, reproducible by the reported seed. */
function generator(seed: number): () => number {
  let state = seed;
  return () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state / 4294967296; };
}
/** SDK full read-back retains native relationships and bodies rather than CLI brief projections. */
async function nativeDocument(f: Awaited<ReturnType<typeof progressFixture>>, id: string): Promise<ItemDocument> {
  return (await getItemAt(id, String(await nativeVersion(f.pmRoot, id)), { pmRoot: f.pmRoot })).document;
}
const fields = ["title", "type", "parent", "sprint", "release", "dependencies", "blocked_by", "deadline", "status", "comments"] as const;

test("500 seeded SDK state sequences replay old captures and native fields under random registries and ambient focus", async () => {
  const f = await progressFixture();
  let mutations = 0;
  try {
    // Random registries are authored by the SDK; an independent role plan is the oracle.
    const semantic = ["completed", "changed_scope", "still_pending", "still_pending", "unsupported"] as const;
    const roles = [["terminal_done"], ["terminal_canceled"], ["active"], ["blocked"], ["terminal"]] as const;
    const statuses: string[][] = [];
    for (let registry = 1; registry <= 8; registry++) {
      const random = generator(registry * 19);
      const names: string[] = [];
      for (let role = 0; role < roles.length; role++) {
        const name = `role_${registry}_${Math.floor(random() * 1000000)}`;
        await f.client.schemaAddStatus(name, { role: [...roles[role]], alias: [`alias_${name}`] });
        names.push(name);
      }
      statuses.push(names);
    }
    const settings = await readSettings(f.pmRoot);
    for (let seed = 1; seed <= 500; seed++) {
      const random = generator(seed);
      await f.client.focus(f.items[Math.floor(random() * f.items.length)].id);
      const target = (await f.client.create({ title: `Target ${seed}`, type: "Task", body: `  intent ${seed}\r\nline\n`, ...progressScope })).item.id;
      const source = (await f.client.create({ title: `Plan ${seed}`, type: "Plan", ...progressScope })).item.id;
      const initial = await nativeDocument(f, target);
      const baseline = canonicalDocument({ metadata: { ...initial.metadata, parent: f.id, sprint: undefined, release: undefined,
        dependencies: [{ id: f.items[Math.floor(random() * f.items.length)].id, kind: "relates_to" }],
        blocked_by: undefined, deadline: "2026-12-01T12:00:00.000Z" }, body: initial.body });
      await changeProgress(f, settings, target, (doc) => { doc.metadata = baseline.metadata; doc.body = baseline.body; }); mutations++;
      const baseVersion = await nativeVersion(f.pmRoot, target);
      const declaration = { version: 1 as const, key: seed % 11 === 0 ? "__proto__" : `key-${seed}`, target: { id: target, revision: baseVersion } };
      await f.client.comments(source, { add: encodeStandupCommitment(declaration) }); mutations++;
      const selection = { id: source, revision: await nativeVersion(f.pmRoot, source) };
      const selectedRole = Math.floor(random() * roles.length);
      const status = statuses[Math.floor(random() * statuses.length)][selectedRole];
      let model = canonicalDocument({ metadata: { ...baseline.metadata, status }, body: baseline.body }, { schema: settings.schema });
      await changeProgress(f, settings, target, (doc) => { doc.metadata.status = status; }); mutations++;
      const changedField = Math.floor(random() * 10);
      const reviseScope = random() < 0.75;
      if (reviseScope) {
        const next = structuredClone(model);
        switch (changedField) {
          case 0: next.body = ` new scope ${seed}\r\ncontinued `; break;
          case 1: next.metadata.title = `Revised ${seed}`; break;
          case 2: next.metadata.type = "Issue"; break;
          case 3: next.metadata.parent = f.items[0].id; break;
          case 4: next.metadata.sprint = f.items[1].id; break;
          case 5: next.metadata.release = f.items[2].id; break;
          case 6: next.metadata.dependencies = [{ id: f.id, kind: "blocked_by" }]; break;
          case 7: next.metadata.blocked_by = f.items[3].id; break;
          case 8: next.metadata.deadline = "2027-01-02T12:00:00.000Z"; break;
          case 9: next.metadata.comments = [{ author: "model", created_at: "2026-10-25T00:00:00.000Z", text: "foreign outcome annotation" }]; break;
        }
        model = canonicalDocument(next, { schema: settings.schema });
        await changeProgress(f, settings, target, (doc) => { doc.metadata = model.metadata; doc.body = model.body; }); mutations++;
      }
      const verify = async (expected: ItemDocument): Promise<void> => {
        const actual = await nativeDocument(f, target);
        for (const field of fields) assert.deepEqual(actual.metadata[field], expected.metadata[field], `seed ${seed}/${field}`);
        assert.equal(actual.body, expected.body, `seed ${seed}/body`);
        assert.equal(actual.metadata.assignee, initial.metadata.assignee, "ambient focus cannot invent assignment");
      };
      await verify(model);
      const changed = reviseScope && changedField !== 9;
      const report = await readCommitmentVariance(f.ctx, { source: selection });
      assert.equal(report.rows[0].state, changed ? "changed_scope" : semantic[selectedRole], `seed ${seed}/outcome`);
      const historical = await getItemAt(target, String(baseVersion), { pmRoot: f.pmRoot });
      for (const field of fields) assert.deepEqual(historical.document.metadata[field], baseline.metadata[field], `historical ${seed}/${field}`);
      assert.equal(historical.document.body, baseline.body);
      // Replay older native state and a CRLF/whitespace variant of the original declaration.
      const replayModel = canonicalDocument(baseline, { schema: settings.schema });
      await changeProgress(f, settings, target, (doc) => { doc.metadata = replayModel.metadata; doc.body = replayModel.body; }); mutations++;
      await f.client.comments(source, { add: COMMITMENT_PREFIX + JSON.stringify({ ...declaration, key: ` ${declaration.key} ` }, null, 2).replaceAll("\n", "\r\n") }); mutations++;
      await verify(replayModel);
      const replay = await readCommitmentVariance(f.ctx, { source: selection });
      assert.equal(replay.rows.length, 1);
      assert.equal(replay.rows[0].state, changed ? "changed_scope" : "still_pending", `replay ${seed}`);
      assert.equal(replay.rows[0].baseline!.version, baseVersion);
      // Same target content at a different explicit revision is a different commitment.
      if (random() < 0.5) {
        await f.client.comments(source, { add: encodeStandupCommitment({ ...declaration, target: { id: target, revision: await nativeVersion(f.pmRoot, target) } }) }); mutations++;
        await f.client.comments(source, { add: encodeStandupCommitment(declaration) }); mutations++;
        assert.equal((await readCommitmentVariance(f.ctx, { source: selection })).rows[0].state, "changed_scope", `revision binding ${seed}`);
      }
      const nativeComments = (await nativeDocument(f, source)).metadata.comments!;
      assert.ok(nativeComments.some((comment) => comment.text.includes("\r\n")), "native source bytes retain CRLF serialization");
      await f.client.delete(source); await f.client.delete(target);
      if (seed % 100 === 0) console.log(`commitment-model: ${seed}/500 sequences checked`);
    }
    console.log(`commitment-model: 500 sequences, ${mutations} native mutations, eight random registries, zero SDK read-back mismatches`);
  } finally { await f.close(); }
});
