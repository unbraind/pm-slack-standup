import { getHistoryPath, readHistorySnapshot } from "@unbrained/pm-cli/sdk";
import { readCommitmentVariance, encodeStandupCommitment } from "../index.ts";
import type { CommitmentTarget } from "../index.ts";
import { progressFixture, progressScope } from "./progress-fixture.ts";

/** Read native revision positions through the SDK, including repeated same-content writes. */
export async function nativeVersion(pmRoot: string, id: string): Promise<number> {
  return (await readHistorySnapshot(getHistoryPath(pmRoot, id), id)).entries.length;
}
/** A plain-directory Plan and linked targets with explicit relationship/scope fields. */
export async function varianceFixture() {
  const f = await progressFixture();
  const source = (await f.client.create({ title: "Periodic intent", type: "Plan", ...progressScope })).item.id;
  const targets: string[] = [];
  for (let index = 0; index < 4; index++) {
    const created = await f.client.create({ title: `Commitment ${index}`, type: "Task", body: "Original scope\n", ...progressScope });
    targets.push(created.item.id);
  }
  const capture = async (key: string, id: string, revision = 1): Promise<void> => {
    await f.client.comments(source, { add: encodeStandupCommitment({ version: 1, key, target: { id, revision } }) });
  };
  for (const [index, id] of targets.entries()) await capture(`c${index}`, id);
  const selection: CommitmentTarget = { id: source, revision: await nativeVersion(f.pmRoot, source) };
  return { ...f, source, targets, selection, capture,
    report: (keys?: string[], outputBytes?: number) => readCommitmentVariance(f.ctx, { source: selection, keys, outputBytes }),
  };
}
