import assert from "node:assert/strict";
import { mutateItemWithHistoryContext, readSettings, createExtensionCommandSdk, canonicalDocument } from "@unbrained/pm-cli/sdk";
import type { ItemDocument, ItemMetadata, PmSettings } from "@unbrained/pm-cli/sdk";
import { runtimeFixture, removeRuntimeFixture } from "./runtime-fixture.ts";
import type { RuntimeFixture } from "./runtime-fixture.ts";
import { readProgressDeltas } from "../index.ts";
import type { ProgressEvidence, ProgressOptions } from "../index.ts";

/** Explicit unset scope prevents ambient session focus from choosing fixture relationships. */
export const progressScope = { parent: "none", sprint: "none", release: "none", assignee: "none" };
/** Public, revision-bound assessment; callers may override one field for boundary cases. */
export function evidence(overrides: Partial<ProgressEvidence> = {}): ProgressEvidence {
  return { version: 1, kind: "criterion", subject: "AC1", targetRevision: "artifact-v1", evidenceRevision: "test-v1", value: "accepted", ...overrides };
}
/** A real non-git tracker with SDK-only mutation and read-back helpers. */
export async function progressFixture() {
  const runtime = await runtimeFixture();
  const settings = await readSettings(runtime.pmRoot);
  const ctx = { pm_root: runtime.pmRoot, sdk: createExtensionCommandSdk(runtime.pmRoot, runtime.client) };
  const created = await runtime.client.create({ title: "Progress evidence", type: "Task", ...progressScope });
  return { ...runtime, settings, ctx, id: created.item.id,
    read: (options: ProgressOptions = {}) => readProgressDeltas(ctx, created.item.id, options),
    change: (mutate: (document: ItemDocument) => void) => changeProgress(runtime, settings, created.item.id, mutate),
    close: () => removeRuntimeFixture(runtime),
  };
}
/** Seed native facts through the SDK's leased mutation path, never a mocked client or a hand-written history. */
export async function changeProgress(runtime: RuntimeFixture, settings: PmSettings, id: string, mutate: (document: ItemDocument) => void): Promise<void> {
  await mutateItemWithHistoryContext({ pmRoot: runtime.pmRoot, settings, id, author: "progress-fixture", op: "update",
    mutate(document) { mutate(document); return { changedFields: ["test_runs", "comments", "body", "status", "dependencies"] }; } });
}
/** Read the complete native item through the same SDK that production consumers use. */
export async function currentProgress(runtime: RuntimeFixture, id: string): Promise<ItemMetadata> {
  const item = (await runtime.client.get(id, { full: true })).item;
  return canonicalDocument({ metadata: item as ItemMetadata, body: typeof item.body === "string" ? item.body : "" }).metadata;
}
/** Canonical finite native run summary, including its producing revision identity. */
export function passingRun(id = "run-1", passed = 3): NonNullable<ItemMetadata["test_runs"]>[number] {
  return { run_id: id, kind: "test", status: "passed", started_at: "2026-10-25T00:00:00.000Z",
    finished_at: "2026-10-25T00:00:01.000Z", recorded_at: "2026-10-25T00:00:02.000Z", passed, failed: 0, skipped: 0 };
}
/** Require an actionable typed refusal without matching mutable human wording. */
export function refused(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof Error && "code" in error && "remedy" in error);
    return error.code === code && typeof error.remedy === "string" && error.remedy.length > 10;
  };
}
