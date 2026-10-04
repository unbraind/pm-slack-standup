import assert from "node:assert/strict";
import test from "node:test";
import { readCompleteStandupItems, CommandError } from "../index.ts";
import { runtimeFixture, removeRuntimeFixture } from "./runtime-fixture.ts";

test("real SDK complete-list receipts reject malformed fields and preserve absent optional metadata", async () => {
  const fixture = await runtimeFixture();
  try {
    const receipt = structuredClone(fixture.envelope);
    const items = receipt.items as Record<string, unknown>[];
    const first = items[0];
    for (const key of ["priority", "dependencies", "tags", "type", "milestone", "release", "sprint", "assignee", "author", "body", "created_at", "updated_at", "blocked_by"]) {
      Reflect.deleteProperty(first, key);
    }
    assert.equal(readCompleteStandupItems(receipt)[0].priority, undefined);
    assert.equal(readCompleteStandupItems(receipt)[0].dependencies, undefined);
    first.dependencies = [{ id: "synthetic" }, { kind: "blocked_by" }];
    assert.deepEqual(readCompleteStandupItems(receipt)[0].dependencies, first.dependencies);
    first.dependencies = [{ kind: 7 }];
    assert.throws(() => readCompleteStandupItems(receipt), /dependency id and kind must be strings/);
    first.dependencies = [null];
    assert.throws(() => readCompleteStandupItems(receipt), /dependency id and kind must be strings/);
    first.dependencies = "invalid";
    assert.throws(() => readCompleteStandupItems(receipt), /dependency id and kind must be strings/);
    Reflect.deleteProperty(first, "dependencies");
    first.tags = [7];
    assert.throws(() => readCompleteStandupItems(receipt), /tags must be strings/);
    Reflect.deleteProperty(first, "tags");
    first.priority = "high";
    assert.throws(() => readCompleteStandupItems(receipt), /priority must be a number/);
    Reflect.deleteProperty(first, "priority");
    const omissions = receipt.omission_receipt as Record<string, unknown>;
    omissions.has_omissions = true;
    assert.throws(() => readCompleteStandupItems(receipt), /omission_receipt.has_omissions=true/);
    /** Non-JSON input to the public validator must still produce a usable refusal. */
    omissions.has_omissions = function invalidReceiptValue(): boolean { return true; };
    assert.throws(() => readCompleteStandupItems(receipt), (error: unknown) => error instanceof CommandError && /invalidReceiptValue/.test(error.message));
  } finally { await removeRuntimeFixture(fixture); }
});
