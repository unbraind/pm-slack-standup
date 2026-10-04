import assert from "node:assert/strict";
import test from "node:test";
import { CommandError } from "../index.ts";
import { runtimeFixture, runtimeCommand, removeRuntimeFixture, runtimeWebhook, runtimeStdout } from "./runtime-fixture.ts";

test("real HTTPS failures, timeout, and multi-target fallback preserve delivery receipts", async (context) => {
  const fixture = await runtimeFixture();
  const webhook = await runtimeWebhook(fixture.directory);
  const stdout = runtimeStdout(context);
  try {
    const multi = await runtimeCommand(fixture, "standup", { webhook: `${webhook.url}/ok`, channels: "#one,#two" });
    assert.equal(multi.posted, true); assert.deepEqual(multi.channels, ["#one", "#two"]);
    assert.match(String(webhook.requests[0].body.text), /#one/);
    assert.match(String(webhook.requests[1].body.text), /#two/);
    const fallback = await runtimeCommand(fixture, "standup", {
      channels: `${webhook.url}/refuse,${webhook.url}/ok`, fallbackToStdout: true,
    });
    assert.equal(fallback.posted, true); assert.equal(fallback.fallbackToStdout, true);
    assert.deepEqual(fallback.results, [
      { channel: undefined, ok: false, error: "Slack webhook returned HTTP 503: synthetic refusal" },
      { channel: undefined, ok: true },
    ]);
    assert.match(stdout.join(""), /Runtime parser integration/);
    const failed = await runtimeCommand(fixture, "standup", { webhook: `${webhook.url}/reset`, channel: "#reset", fallbackToStdout: true });
    assert.equal(failed.posted, false);
    assert.match(JSON.stringify(failed.results), /Slack webhook request failed/);
    await assert.rejects(runtimeCommand(fixture, "standup", { webhook: `${webhook.url}/refuse`, channel: "#refuse" }),
      (error: unknown) => error instanceof CommandError && error.exitCode === 1 && /#refuse: Slack webhook returned HTTP 503/.test(error.message));
    await assert.rejects(runtimeCommand(fixture, "standup", { webhook: `${webhook.url}/hang` }), /request timed out after 10s/);
  } finally { await webhook.stop(); await removeRuntimeFixture(fixture); }
});

test("scheduled posting waits in bounded timer chunks and reads PM state at fire time", async (context) => {
  const fixture = await runtimeFixture();
  const webhook = await runtimeWebhook(fixture.directory);
  try {
    const now = new Date(2026, 0, 1, 0).getTime();
    context.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
    const preview = await runtimeCommand(fixture, "standup", { dryRun: true, schedule: "00:01" });
    assert.equal(preview.scheduledAt, new Date(2026, 0, 1, 0, 1).toISOString());
    assert.equal(webhook.requests.length, 0);
    const scheduled = runtimeCommand(fixture, "standup", { webhook: `${webhook.url}/ok`, schedule: "0 0 1 4 *" });
    const added = await fixture.client.create({ title: "Created during the schedule wait", type: "Task", status: "in_progress" });
    assert.ok(added.item.id);
    assert.equal(webhook.requests.length, 0);
    const chunk = 24 * 86_400_000;
    for (let index = 0; index < 4; index += 1) {
      context.mock.timers.tick(chunk);
      await Promise.resolve();
    }
    const result = await scheduled;
    assert.equal(result.scheduledAt, new Date(2026, 3, 1, 0).toISOString());
    assert.equal(result.wip, 2);
    assert.match(String(webhook.requests[0].body.text), /Created during the schedule wait/);
  } finally { context.mock.timers.reset(); await webhook.stop(); await removeRuntimeFixture(fixture); }
});
