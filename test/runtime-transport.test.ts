import assert from "node:assert/strict";
import net from "node:net";
import dns from "node:dns";
import https from "node:https";
import test from "node:test";
import { CommandError } from "../index.ts";
import { runtimeFixture, runtimeCommand, removeRuntimeFixture, runtimeWebhook, runtimeStdout } from "./runtime-fixture.ts";

test("HTTPS fixture remains reachable when localhost resolves to different listener and client families", async (context) => {
  type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
  const originalLookup = dns.lookup as unknown as (hostname: string, options: dns.LookupOptions | LookupCallback, callback?: LookupCallback) => void;
  let localhostCalls = 0;
  context.mock.method(dns, "lookup", ((hostname: string, options: dns.LookupOptions | LookupCallback, callback?: LookupCallback) => {
    if (hostname !== "localhost") return originalLookup(hostname, options, callback);
    const address = localhostCalls++ === 0 ? "::1" : "127.0.0.1";
    const family = address === "::1" ? 6 : 4;
    const complete = typeof options === "function" ? options : callback;
    assert.ok(complete);
    process.nextTick(() => {
      if (typeof options === "object" && options?.all) complete(null, [{ address, family }]);
      else complete(null, address, family);
    });
  }) as typeof dns.lookup);
  const fixture = await runtimeFixture();
  const webhook = await runtimeWebhook(fixture.directory);
  try {
    const result = await new Promise<number | undefined>((resolveRequest, rejectRequest) => {
      const request = https.request(webhook.url, { method: "POST" }, response => {
        response.resume();
        response.on("end", () => resolveRequest(response.statusCode));
      });
      request.on("error", rejectRequest);
      request.end("{}");
    });
    assert.equal(result, 200);
    assert.equal(localhostCalls, 0, "literal loopback transport must not resolve localhost");
  } finally {
    await webhook.stop();
    await removeRuntimeFixture(fixture);
  }
});

test("the synthetic webhook advertises the exact loopback address it listens on", async () => {
  // Regression guard for the CI Deep failures: a listener that binds one family
  // of "localhost" while advertising the name forces the client to resolve the
  // name a second time, and wherever the two resolutions disagree the client
  // meets `connect ECONNREFUSED 127.0.0.1` instead of the listener. The URL must
  // carry the literal bound address, so no second resolution exists.
  const fixture = await runtimeFixture();
  const webhook = await runtimeWebhook(fixture.directory);
  try {
    const advertised = new URL(webhook.url);
    assert.notEqual(net.isIP(advertised.hostname), 0, `the advertised host must be a literal IP address, never a resolvable name: ${advertised.hostname}`);
    assert.equal(advertised.hostname, webhook.address, "the URL must advertise the address the listener is bound to");
    assert.equal(advertised.port, String(webhook.port), "the URL must advertise the port the listener is bound to");
  } finally {
    await webhook.stop();
    await removeRuntimeFixture(fixture);
  }
});

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
