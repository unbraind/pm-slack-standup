import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  collectDecisionRequests, renderDecisionRequests, DecisionRequestRefusal, DECISION_REQUEST_TAG,
  buildStandupData, buildTextMessage, buildBlockKit, resolveStandupOptions, fetchAllItems,
} from "../index.ts";
import type { DecisionRequestDeclaration, PmItem } from "../index.ts";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import { runtimeFixture, runtimeCommand, removeRuntimeFixture } from "./runtime-fixture.ts";

/** A fully explicit synthetic declaration, including one deliberately withheld alternative. */
function declaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, state: "pending", disclosure: "public", prompt: "Choose the release route", audience: "human",
    responseBy: "2026-10-22T09:00:00.000Z", evidence: ["https://example.org/evidence#canonical"],
    acknowledgeAt: "https://example.org/decision", alternatives: [
      { label: "Ship now", disclosure: "public" }, { label: "SECRET-ALTERNATIVE", disclosure: "private" },
    ], ...overrides,
  };
}

/** Place a declaration in its documented body fence without involving tracker storage. */
function body(value: unknown): string { return `\`\`\`standup-decision-request\n${JSON.stringify(value)}\n\`\`\``; }

/** Construct a pure presentation input; runtime tests below use the real SDK and tracker. */
function item(value: unknown = declaration(), overrides: Partial<PmItem> = {}): PmItem {
  return { id: "decision-1", title: "PRIVATE-TITLE", type: "Decision", status: "open", tags: [DECISION_REQUEST_TAG], body: body(value), ...overrides };
}

test("only declared active requests appear; disclosure and lifecycle suppression are deterministic", () => {
  const active = item(declaration({ acknowledgment: "https://example.org/ack", audience: "agent" }));
  const inputs = [active, item(null, { tags: [] }), item(null, { type: "Task" }), item(null, { type: undefined }),
    item(null, { tags: undefined }), ...["closed", "done", "completed", "canceled", "cancelled", "superseded", "archived", "resolved", "rejected"]
      .map((status) => item(null, { status })),
    item({ version: 1, state: "closed" }), item({ version: 1, state: "superseded" }), item({ version: 1, disclosure: "private" })];
  const report = collectDecisionRequests(inputs);
  assert.equal(report.total, 1);
  assert.equal(report.omitted, 0);
  assert.deepEqual(report.requests[0], {
    id: "decision-1", prompt: "Choose the release route", audience: "agent", responseBy: "2026-10-22T09:00:00.000Z",
    evidence: ["https://example.org/evidence#canonical"], acknowledgeAt: "https://example.org/decision", acknowledgment: "https://example.org/ack",
    alternatives: ["Ship now"], withheldAlternatives: 1,
  });
  assert.doesNotMatch(JSON.stringify(report), /SECRET|PRIVATE-TITLE/);
  assert.doesNotMatch(renderDecisionRequests(report), /SECRET|PRIVATE-TITLE/);
  assert.match(renderDecisionRequests(report), /Acknowledgment: https:/);
  assert.equal(collectDecisionRequests([item(declaration({ alternatives: [
    { label: "secret one", disclosure: "private" }, { label: "secret two", disclosure: "private" },
  ] }))]).requests[0].alternatives.length, 0);
});

test("deadline and ID ordering, complete-row byte budgets and row caps retain honest omissions", () => {
  const early = item(declaration({ responseBy: "2020-01-01T00:00:00.000Z" }), { id: "a" });
  const later = item(declaration(), { id: "z" });
  const sameDeadline = item(declaration(), { id: "b" });
  const report = collectDecisionRequests([later, sameDeadline, early, early], { limit: 3, outputBytes: 32768 });
  assert.deepEqual(report.requests.map((request) => request.id), ["a", "a", "b"]);
  assert.equal(report.omitted, 1);
  assert.deepEqual(collectDecisionRequests([later, sameDeadline, early]).requests.map((request) => request.id), ["a", "b", "z"]);
  assert.equal(collectDecisionRequests([later, early]).requests[0].id, "a");
  assert.equal(collectDecisionRequests([early, later]).requests[1].id, "z");
  const bounded = collectDecisionRequests([later, sameDeadline, early], { outputBytes: 512 });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 512);
  assert.equal(bounded.requests.length, 1);
  assert.equal(bounded.omitted, 2);
  assert.match(bounded.remedy, /--output-bytes/);
  assert.equal(collectDecisionRequests([]).total, 0);
});

test("invalid options and declarations have typed, actionable refusals with no private payload", () => {
  for (const options of [{ limit: 0 }, { limit: 11 }, { limit: 1.5 }, { limit: NaN }, { outputBytes: 511 }, { outputBytes: 32769 }, { outputBytes: NaN }]) {
    assert.throws(() => collectDecisionRequests([], options), (error: unknown) => error instanceof DecisionRequestRefusal
      && error.code === "invalid_options" && error.exitCode === 2 && error.remedy.includes("Use --") && error.itemId === undefined);
  }
  for (const value of [null, [], 1, { version: 2 }]) {
    assert.throws(() => collectDecisionRequests([item(value)]), (error: unknown) => error instanceof DecisionRequestRefusal
      && error.itemId === "decision-1" && error.code === (value && !Array.isArray(value) && typeof value === "object" ? "unsupported_version" : "invalid_request"));
  }
  const changes: Record<string, unknown>[] = [
    { state: "unknown" }, { disclosure: undefined }, { prompt: 1 }, { prompt: " " }, { prompt: "a".repeat(161) }, { prompt: "a\nb" },
    { audience: "unknown" }, { responseBy: 1 }, { responseBy: "tomorrow" }, { responseBy: "2026-99-99T00:00:00.000Z" },
    { responseBy: "2026-02-30T00:00:00.000Z" }, { evidence: null }, { evidence: [] }, { evidence: Array(4).fill("https://example.org") },
    { evidence: [1] }, { evidence: ["bad"] }, { evidence: ["https://example.org/" + "a".repeat(513)] },
    { evidence: ["http://example.org"] }, { evidence: ["https://name:password@example.org"] },
    { evidence: ["https://example.org/has space"] }, { evidence: ["https://example.org/<bad>"] }, { evidence: ["https://example.org/|bad"] },
    { acknowledgeAt: "bad" }, { acknowledgment: "bad" }, { alternatives: null }, { alternatives: [] }, { alternatives: Array(7).fill({}) },
    { alternatives: [null, {}] }, { alternatives: [{ label: "valid", disclosure: "public" }, { label: "SECRET", disclosure: "unknown" }] },
    { alternatives: [{ label: "valid", disclosure: "public" }, { label: "", disclosure: "private" }] },
  ];
  for (const change of changes) assert.throws(() => collectDecisionRequests([item(declaration(change))]), (error: unknown) =>
    error instanceof DecisionRequestRefusal && error.code === "invalid_request" && error.remedy.includes("README") && !error.message.includes("SECRET"));
  for (const malformed of [undefined, "", "```standup-decision-request\n{invalid}\n```", body(declaration()) + "\n" + body(declaration())]) {
    assert.throws(() => collectDecisionRequests([item(undefined, { body: malformed })]), DecisionRequestRefusal);
  }
});

test("periodic text and Block Kit carry only public alternatives and safe acknowledgment links", () => {
  const { opts } = resolveStandupOptions({ includeDecisions: true }, "plain");
  const value = declaration({ prompt: "Choose <route> & @channel 😀", audience: "either" });
  const inputs = [item(value)];
  const data = buildStandupData(inputs, opts);
  const text = buildTextMessage(data, opts);
  assert.match(text, /Decision requests/);
  assert.match(text, /Choose <route> & @channel/);
  assert.match(text, /respond by 2026-10-22/);
  assert.match(text, /Acknowledge: https:/);
  assert.doesNotMatch(text, /SECRET|PRIVATE-TITLE/);
  assert.doesNotMatch(JSON.stringify(data), /SECRET|PRIVATE-TITLE/);
  const blocks = buildBlockKit(data, opts);
  assert.match(blocks.fallback, /&lt;route&gt; &amp; ＠channel/);
  assert.equal(blocks.fallback, buildTextMessage(data, { ...opts, format: "slack" }));
  assert.ok(blocks.blocks.some((block) => block.type === "section" && "text" in block && (block.text as { type: string }).type === "plain_text"));
  assert.doesNotMatch(JSON.stringify(blocks), /SECRET/);
  assert.equal(buildStandupData(inputs, { ...opts, includeDecisions: false }).decisions, undefined);
  assert.doesNotMatch(buildTextMessage(buildStandupData(inputs, { ...opts, includeDecisions: false }), opts), /Decision requests/);
  const long = collectDecisionRequests(Array.from({ length: 10 }, (_, index) => item(declaration({
    prompt: "😀".repeat(70), evidence: ["https://example.org/" + "a".repeat(400)],
  }), { id: `decision-${index}` })), { outputBytes: 32768 });
  const rendered = buildBlockKit({ ...data, decisions: long }, opts);
  for (const block of rendered.blocks) {
    if (block.type === "section" && "text" in block && (block.text as { type: string }).type === "plain_text") {
      assert.ok((block.text as { text: string }).text.length <= 2400);
      assert.equal(Buffer.from((block.text as { text: string }).text).toString(), (block.text as { text: string }).text);
    }
  }
});

test("real SDK and registered CLI read and suppress requests in a non-git tracker with no git on PATH", async () => {
  const fixture = await runtimeFixture();
  const oldPath = process.env.PATH;
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    const created = await fixture.client.create({ type: "Decision", title: "Explicit release input", tags: DECISION_REQUEST_TAG, body: body(declaration()) });
    const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
    const source = join(fixture.directory, "extension-source"); mkdirSync(source);
    for (const file of ["dist", "package.json", "manifest.json", "README.md"]) cpSync(resolve(file), join(source, file), { recursive: true });
    execFileSync(process.execPath, [cli, "--path", fixture.pmRoot, "package", "install", source, "--project"], {
      cwd: fixture.directory, encoding: "utf8", env: { ...process.env, PM_GLOBAL_PATH: join(fixture.directory, "global") },
    });
    const noGit = join(fixture.directory, "tools"); mkdirSync(noGit);
    symlinkSync(process.execPath, join(noGit, process.platform === "win32" ? "node.exe" : "node"));
    symlinkSync(cli, join(noGit, "pm"));
    process.env.PATH = noGit;
    process.env.GIT_CEILING_DIRECTORIES = dirname(fixture.directory);
    assert.throws(() => execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: fixture.directory, stdio: "ignore" }));
    const items = fetchAllItems(fixture.pmRoot, resolve("node_modules/@unbrained/pm-cli/dist/cli.js"));
    assert.equal(collectDecisionRequests(items).total, 1);
    const args = [cli, "--path", fixture.pmRoot, "standup", "decisions"];
    const cliOptions = { cwd: fixture.directory, encoding: "utf8" as const,
      env: { ...process.env, PM_GLOBAL_PATH: join(fixture.directory, "global") } };
    const json = JSON.parse(execFileSync(process.execPath, [...args, "--json"], cliOptions)) as Record<string, unknown>;
    const toon = decodeToon(execFileSync(process.execPath, args, cliOptions));
    assert.deepEqual(toon, json);
    assert.equal(json.total, 1);
    const exported = await runtimeCommand(fixture, "standup export", { format: "json", includeDecisions: true });
    assert.doesNotMatch(String(exported.output), /SECRET/);
    assert.equal(JSON.parse(String(exported.output)).decisions.total, 1);
    assert.doesNotMatch(JSON.stringify(json), /SECRET/);
    assert.throws(() => execFileSync(process.execPath, [...args, "--limit", "no", "--json"], { ...cliOptions, stdio: "pipe" }),
      (error: unknown) => error instanceof Error && "status" in error && error.status === 2 && "stderr" in error && /invalid_options/.test(String(error.stderr)));
    const result = await runtimeCommand(fixture, "standup decisions");
    assert.equal(result.total, 1);
    assert.equal(result.omitted, 0);
    const limited = await runtimeCommand(fixture, "standup decisions", { limit: "1", outputBytes: "512" });
    assert.equal(Number(limited.omitted) + (limited.requests as unknown[]).length, 1);
    await assert.rejects(runtimeCommand(fixture, "standup decisions", { limit: "no" }), DecisionRequestRefusal);
    await fixture.client.update(created.item.id, { body: body(declaration({ state: "superseded" })) });
    assert.equal((await runtimeCommand(fixture, "standup decisions")).total, 0);
    await fixture.client.update(created.item.id, { body: body(declaration({ acknowledgment: "https://example.org/ack" })) });
    assert.equal((await runtimeCommand(fixture, "standup decisions")).total, 1);
    await fixture.client.close(created.item.id, "Synthetic decision resolved");
    assert.equal((await runtimeCommand(fixture, "standup decisions")).total, 0);
    await fixture.client.create({ type: "Decision", title: "Invalid declared request", tags: DECISION_REQUEST_TAG, body: "invalid" });
    await assert.rejects(runtimeCommand(fixture, "standup decisions"), DecisionRequestRefusal);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
    await removeRuntimeFixture(fixture);
  }
});

// Compile-time consumer proof: the SDK declaration is importable from the public package entry.
const typedDeclaration: DecisionRequestDeclaration = declaration() as unknown as DecisionRequestDeclaration;
assert.equal(typedDeclaration.version, 1);
