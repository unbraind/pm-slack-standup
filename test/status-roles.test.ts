import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { isPmCliExpectedError, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import type { PmSettings } from "@unbrained/pm-cli/sdk";
import {
  ALL_SECTIONS, classifyStandupItem, collectDecisionRequests, DECISION_REQUEST_TAG,
  buildStandupData, blockedAgeDays, resolveSections, resolveStandupOptions,
} from "../index.ts";
import type { PmItem, SectionKey } from "../index.ts";
import { runtimeFixture, removeRuntimeFixture, runtimeCommand, runtimeStdout } from "./runtime-fixture.ts";

type Kind = "active" | "open" | "draft" | "blocked" | "done" | "canceled" | "terminal";
type StatusDefinition = PmSettings["schema"]["statuses"][number];
const kinds: Kind[] = ["active", "open", "draft", "blocked", "done", "canceled", "terminal"];
const now = Date.parse("2026-10-25T12:00:00.000Z");
const requestBody = "```standup-decision-request\n" + JSON.stringify({
  version: 1, state: "pending", disclosure: "public", prompt: "Choose a route", audience: "human",
  responseBy: "2026-10-26T12:00:00.000Z", evidence: ["https://example.org/evidence"],
  acknowledgeAt: "https://example.org/ack", alternatives: [
    { label: "Proceed", disclosure: "public" }, { label: "Wait", disclosure: "public" },
  ],
}) + "\n```";

/** Seeded reproducible generator; failures identify the registry seed. */
function randomFor(seed: number): () => number {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

/** Independent declared role plans, before the SDK constructs a real registry. */
function declaredRoles(kind: Kind, random: () => number): NonNullable<StatusDefinition["roles"]> {
  switch (kind) {
    case "open": return ["active", "default_open"];
    case "draft": return ["draft"];
    case "done": return ["terminal_done", "default_close", ...(random() < 0.5 ? ["active" as const, "blocked" as const] : [])];
    case "canceled": return ["terminal_canceled", "default_cancel", ...(random() < 0.5 ? ["terminal_done" as const, "active" as const] : [])];
    case "terminal": return ["terminal"];
    case "blocked": return ["blocked", ...(random() < 0.5 ? ["active" as const, "default_open" as const] : [])];
    case "active": return ["active"];
  }
}

/** Build a renamed multi-status-per-role schema through the real SDK resolver. */
function corpus(seed: number): { registry: ReturnType<typeof resolveRuntimeStatusRegistry>; records: Array<{ item: PmItem; kind: Kind; blocker: boolean }> } {
  const random = randomFor(seed);
  const definitions: StatusDefinition[] = [];
  const records: Array<{ item: PmItem; kind: Kind; blocker: boolean }> = [];
  const selected = new Map<Kind, string>();
  for (const kind of kinds) {
    const count = 2 + Math.floor(random() * 3);
    for (let index = 0; index < count; index++) {
      const id = `r${seed}_${Math.floor(random() * 1000000)}_${definitions.length}`;
      const alias = `alias_${id}`;
      selected.set(kind, id);
      definitions.push({ id, aliases: [alias], roles: declaredRoles(kind, random) });
      for (let sample = 0; sample < 3; sample++) {
        const blocker = random() < 0.3;
        records.push({ kind, blocker, item: {
          id: `${id}_item_${sample}`, title: `${id} sample ${sample}`,
          status: sample === 0 ? id : ` ${alias.toUpperCase()} `,
          assignee: [undefined, "alpha", "beta"][Math.floor(random() * 3)],
          priority: Math.floor(random() * 6),
          updated_at: sample === 2 ? undefined : new Date(now - sample * 86_400_000).toISOString(),
          ...(blocker ? sample === 0 ? { blocked_by: "synthetic-blocker" }
            : { dependencies: [{ id: "synthetic-blocker", kind: "blocked_by" }] } : {}),
        } });
      }
    }
  }
  const schema: PmSettings["schema"] = {
    version: 1, files: {}, statuses: definitions, fields: [], unknown_field_policy: "allow",
    workflow: { open_status: selected.get("open"), draft_status: selected.get("draft"),
      in_progress_status: selected.get("active"), blocked_status: selected.get("blocked"),
      close_status: selected.get("done"), canceled_status: selected.get("canceled") },
  };
  return { registry: resolveRuntimeStatusRegistry(schema), records };
}

/** Oracle uses the generated role plan rather than production registry/classifier output. */
function expectedSection(kind: Kind, blocker: boolean): SectionKey | undefined {
  if (kind === "done") return "done";
  if (kind === "canceled" || kind === "terminal") return undefined;
  if (kind === "blocked" || blocker) return "blocked";
  return kind === "active" ? "in_progress" : "up_next";
}

test("property: arbitrary role registries preserve every eligible item under all selection flags and filters", () => {
  let bucketCases = 0;
  let sectionCases = 0;
  let itemCases = 0;
  for (let seed = 1; seed <= 64; seed++) {
    const { registry, records } = corpus(seed);
    const items = records.map(({ item }) => item);
    for (const allOpen of [false, true]) for (const includeDone of [false, true]) {
      for (const team of [undefined, [], ["alpha"], ["beta"], ["alpha", "beta"]]) for (const since of [NaN, now - 43_200_000, now + 1]) {
        const { opts } = resolveStandupOptions({ "all-open": allOpen, "include-done": includeDone }, "plain");
        Object.assign(opts, { statusRegistry: registry, team });
        const expected: Record<SectionKey, PmItem[]> = { in_progress: [], blocked: [], done: [], up_next: [] };
        let visible = 0;
        for (const { item, kind, blocker } of records) {
          if (team && team.length > 0 && (!item.assignee || !team.includes(item.assignee))) continue;
          visible++;
          const section = expectedSection(kind, blocker);
          if (!section || section === "done" && (!includeDone || !Number.isNaN(since) && !(Date.parse(item.updated_at ?? "") >= since))) continue;
          expected[section].push(item);
        }
        expected.up_next.sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));
        if (!allOpen) expected.up_next = expected.up_next.slice(0, 3);
        const data = buildStandupData(items, opts, since, now);
        const actual = { in_progress: data.wip, blocked: data.blocked, done: data.done, up_next: data.upNext };
        assert.deepEqual(actual, expected, `registry seed ${seed}, allOpen=${allOpen}, includeDone=${includeDone}, team=${team}, since=${since}`);
        assert.equal(data.total, visible);
        const admitted = Object.values(actual).flat().map((item) => item.id);
        assert.equal(new Set(admitted).size, admitted.length, "an eligible item belongs to exactly one bucket");
        for (let mask = 0; mask < 16; mask++) {
          const sections = ALL_SECTIONS.filter((_section, bit) => (mask & (1 << bit)) !== 0);
          const selected = resolveSections(data, { ...opts, sections }).flatMap((section) => section.items);
          assert.deepEqual(selected, sections.flatMap((section) => expected[section]), `section mask ${mask}, seed ${seed}`);
          sectionCases++;
        }
        bucketCases++;
        itemCases += items.length;
      }
    }
    for (const { item, kind, blocker } of records) {
      const roles = classifyStandupItem(item, registry);
      const expected = expectedSection(kind, blocker);
      assert.equal(roles.active, expected === "in_progress");
      assert.equal(roles.blocked, expected === "blocked");
      assert.equal(roles.open, expected === "up_next");
      assert.equal(roles.done, kind === "done");
      assert.equal(roles.canceled, kind === "canceled");
      assert.equal(roles.terminal, ["done", "canceled", "terminal"].includes(kind));
      const expectedTerminal = ["done", "canceled", "terminal"].includes(kind);
      const decision = { ...item, type: "Decision", tags: [DECISION_REQUEST_TAG], body: expectedTerminal ? undefined : requestBody };
      const report = collectDecisionRequests([decision], { statusRegistry: registry });
      assert.equal(report.total, expectedTerminal ? 0 : 1);
      assert.equal(blockedAgeDays(item, now, registry) !== undefined, expected === "blocked" && item.updated_at !== undefined);
    }
  }
  console.log(`Property proof: 64 SDK registries, ${bucketCases} bucket cases, ${sectionCases} section selections, ${itemCases} item classifications; zero missing or duplicate eligible items`);
});

test("configured names and aliases never override declared lifecycle roles; unknown roles refuse", () => {
  const { registry } = corpus(101);
  const schema: PmSettings["schema"] = {
    version: 1, files: {}, fields: [], workflow: {}, unknown_field_policy: "allow", statuses: [
      { id: "closed", roles: ["active"], aliases: ["done"] },
      { id: "in_progress", roles: ["terminal_done"] },
      { id: "blocked", roles: ["draft"] },
      { id: "open", roles: ["blocked"] },
      { id: "canceled", roles: ["active", "default_open"] },
      { id: "opaque", roles: [] },
    ],
  };
  const configured = resolveRuntimeStatusRegistry(schema);
  assert.equal(classifyStandupItem({ status: "done" }, configured).active, true);
  assert.equal(classifyStandupItem({ status: "in_progress" }, configured).done, true);
  assert.equal(classifyStandupItem({ status: "blocked" }, configured).open, true);
  assert.equal(classifyStandupItem({ status: "open" }, configured).blocked, true);
  assert.equal(classifyStandupItem({ status: "canceled" }, configured).open, true);
  for (const [status, selected] of [["unregistered", registry], ["opaque", configured]] as const) {
    assert.throws(() => classifyStandupItem({ status }, selected), (error: unknown) => isPmCliExpectedError(error) && error.exitCode === 2);
  }
});

test("reviewing active-role work survives hosted reports and exports without git", async (context) => {
  const fixture = await runtimeFixture();
  const savedEnvironment = { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES };
  runtimeStdout(context);
  try {
    await fixture.client.schemaAddStatus("reviewing", { role: ["active"], alias: ["peer-review"] });
    await fixture.client.schemaAddStatus("queued_again", { role: ["active", "default_open"] });
    await fixture.client.schemaAddStatus("quiet_terminal", { role: ["terminal_canceled"] });
    const reviewing = await fixture.client.create({ type: "Task", title: "Reviewing custom work", status: "reviewing" });
    const queued = await fixture.client.create({ type: "Task", title: "Additional open role", status: "queued_again" });
    await fixture.client.create({ type: "Decision", title: "Suppressed custom terminal request", status: "quiet_terminal", tags: DECISION_REQUEST_TAG });
    process.env.PATH = fixture.directory;
    process.env.GIT_CEILING_DIRECTORIES = dirname(fixture.directory);
    for (const allOpen of [false, true]) for (const includeDone of [false, true]) {
      const options = { "all-open": allOpen, "include-done": includeDone, "include-decisions": true, format: "plain", "dry-run": true };
      const preview = await runtimeCommand(fixture, "standup", options);
      assert.match(String(preview.rendered), /Reviewing custom work/);
      const receipt = await fixture.harness.runExporter({ exporter: "standup", pmRoot: fixture.pmRoot, options: { ...options, format: "json" } });
      const snapshot = JSON.parse(String((receipt.result as Record<string, unknown>).output)) as { sections_data: Record<string, PmItem[]> };
      assert.ok(snapshot.sections_data.in_progress.some((item) => item.id === reviewing.item.id));
      if (allOpen) assert.ok(snapshot.sections_data.up_next.some((item) => item.id === queued.item.id));
    }
    const decisions = await runtimeCommand(fixture, "standup decisions");
    assert.equal(decisions.total, 0, "the direct decision command must receive configured terminal roles");
  } finally {
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await removeRuntimeFixture(fixture);
  }
});
