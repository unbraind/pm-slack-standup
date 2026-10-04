import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeFixture, runtimeCommand, removeRuntimeFixture, runtimeWebhook } from "./runtime-fixture.ts";

test("real HTTPS webhook honors its explicit port, query, and JSON request body", async () => {
  const fixture = await runtimeFixture();
  const webhook = await runtimeWebhook(fixture.directory);
  const { requests } = webhook;
  try {
    const result = await runtimeCommand(fixture, "standup", { webhook: `${webhook.url}/standup?probe=1`, channel: "#synthetic" });
    assert.equal(result.posted, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].path, "/standup?probe=1");
    assert.equal(requests[0].body.mrkdwn, true);
    assert.match(String(requests[0].body.text), /Runtime parser integration/);
    assert.match(String(requests[0].body.text), /#synthetic/);
    assert.equal(Number(requests[0].length), Buffer.byteLength(JSON.stringify(requests[0].body)));
  } finally {
    await webhook.stop();
    await removeRuntimeFixture(fixture);
  }
});

test("real SDK command preview and exported snapshots round-trip through comparison", async () => {
  const fixture = await runtimeFixture();
  try {
    const preview = await runtimeCommand(fixture, "slack-standup", { dryRun: true, format: "plain", includeDone: true });
    assert.equal(preview.wip, 1); assert.equal(preview.blocked, 1); assert.equal(preview.done, 1); assert.equal(preview.upNext, 2);
    assert.match(String(preview.rendered), /Runtime parser integration/);
    const output = join(fixture.directory, "standup.json");
    const history = join(fixture.directory, "history");
    const exported = await runtimeCommand(fixture, "standup export", { format: "json", output, historyDir: history, includeDone: true });
    assert.equal(exported.exported, 5);
    const snapshot = JSON.parse(readFileSync(output, "utf8")) as Record<string, unknown>;
    assert.deepEqual(snapshot.counts, { wip: 1, blocked: 1, done: 1, upNext: 2, total: 5 });
    assert.equal(readFileSync(String(exported.history_file), "utf8"), readFileSync(output, "utf8"));
    const compared = await runtimeCommand(fixture, "standup", { dryRun: true, compare: output, includeDone: true });
    assert.match(String(compared.rendered), /Trend.*In Progress →0/);
    const markdown = await runtimeCommand(fixture, "standup export", { historyDir: history });
    assert.equal(markdown.raw_stdout, true);
    assert.match(String(markdown.output), /^# 📊 pm standup/);
    const oneSnapshot = await runtimeCommand(fixture, "standup", { dryRun: true, compare: history });
    assert.match(String(oneSnapshot.rendered), /Trend/);
    writeFileSync(join(history, "standup-2001-01-01.json"), JSON.stringify({ counts: { wip: 3 } }));
    const multiple = await runtimeCommand(fixture, "standup", { dryRun: true, format: "markdown", compare: history });
    assert.match(String(multiple.rendered), /History \(2 snapshots/);
    const emptyHistory = join(fixture.directory, "empty"); mkdirSync(emptyHistory);
    const empty = await runtimeCommand(fixture, "standup", { dryRun: true, compare: emptyHistory });
    assert.doesNotMatch(String(empty.rendered), /Trend|History/);
    const missing = await runtimeCommand(fixture, "standup", { dryRun: true, compare: join(fixture.directory, "missing.json") });
    assert.doesNotMatch(String(missing.rendered), /Trend/);
  } finally { await removeRuntimeFixture(fixture); }
});
