import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readBoolOption, parseMentionMap, parseGroupBy, parseSections, parseSectionLabels,
  parseSchedule, nextFireTime, resolveSinceMs, writeError, resolvePmBin, pmLaunchPlan, withinWindow,
  buildStandupData, resolveSections, itemText, groupItems, buildTextMessage, buildBlockKit,
  renderStandup, resolvePostTargets, postStandupTargets, extractPriorCounts,
  readPriorCounts, readSnapshotHistory, computeDeltas, renderHistoryLine, CommandError,
  resolveStandupOptions,
} from "../index.ts";
import type { GroupBy, PmItem, SectionCounts } from "../index.ts";
import { runtimeFixture, removeRuntimeFixture } from "./runtime-fixture.ts";

test("runtime option parsing preserves boolean aliases, sparse lists, and cron semantics", () => {
  for (const value of ["true", "1", "yes", "on"]) assert.equal(readBoolOption({ dryRun: value }, "dry-run"), true);
  for (const value of ["false", "0", "no", "off"]) assert.equal(readBoolOption({ dryRun: value }, "dry-run"), false);
  assert.equal(readBoolOption({ dryRun: "unrecognized" }, "dry-run"), false);
  assert.deepEqual(parseMentionMap("ignored,=empty,alice=,alice=@a"), { alice: "@a" });
  assert.equal(parseGroupBy(""), "status");
  assert.deepEqual(parseSections(", ;"), ["in_progress", "blocked", "done", "up_next"]);
  assert.deepEqual(parseSectionLabels("ignored,=label,blocked=,wip=Rolling team,next=Next"), {
    in_progress: { title: "Rolling team" }, up_next: { title: "Next" },
  });
  assert.equal(parseSchedule("*, * * * *")?.fields?.[0].length, 60);
  for (const expression of [", * * * *", "9-3 * * * *", "0-60 * * * *", "0 0 0-3 * *"]) {
    assert.throws(() => parseSchedule(expression), (error: unknown) => error instanceof CommandError && error.exitCode === 2);
  }
  const now = new Date(2026, 0, 5, 12).getTime();
  assert.equal(nextFireTime({ kind: "daily", raw: "missing fields" }, now), now + 86_400_000);
  const orSchedule = parseSchedule("0 0 6 1 1"); assert.ok(orSchedule);
  assert.equal(nextFireTime(orSchedule, now), new Date(2026, 0, 6, 0).getTime());
  const mondaySchedule = parseSchedule("0 0 31 1 1"); assert.ok(mondaySchedule);
  assert.equal(nextFireTime(mondaySchedule, now), new Date(2026, 0, 12, 0).getTime());
  const impossible = parseSchedule("0 0 31 2 *"); assert.ok(impossible);
  assert.equal(nextFireTime(impossible, now), now + 86_400_000);
  assert.ok(Number.isNaN(resolveSinceMs("not-a-date", undefined)));
  assert.match(writeError("synthetic", "plain failure").message, /plain failure/);
  assert.match(writeError("synthetic", 7).message, /7/);
  assert.equal(resolvePmBin(pathToFileURL("/index.ts").href).command, "pm");
});

test("real tracker records exercise dependency context, grouping, windows, and render formats", async () => {
  const fixture = await runtimeFixture();
  try {
    const { opts } = resolveStandupOptions({ includeDone: true }, "plain");
    const bare: PmItem = { ...fixture.items[0] };
    Reflect.deleteProperty(bare, "created_at"); Reflect.deleteProperty(bare, "updated_at");
    assert.equal(withinWindow(bare, 0), false);
    bare.created_at = "2026-01-01";
    assert.equal(withinWindow(bare, 0), true);
    bare.updated_at = "invalid";
    assert.equal(withinWindow(bare, 0), false);
    Reflect.deleteProperty(bare, "status");
    assert.equal(buildStandupData([bare], opts).wip.length, 0);
    const open = fixture.items.filter((item) => item.status === "open").map((item) => ({ ...item }));
    for (const item of open) Reflect.deleteProperty(item, "priority");
    Reflect.deleteProperty(opts, "upNextCount");
    assert.deepEqual(buildStandupData(open, opts).upNext.map((item) => item.id), open.map((item) => item.id));
    const dependent = { ...fixture.items[0], dependencies: [
      { kind: "blocked_by", id: " fixture-a " }, { kind: "blocked_by" }, { kind: "related_to", id: "ignored" }, {},
    ] };
    assert.match(itemText(dependent, {}), /blocked by fixture-a/);
    assert.doesNotMatch(itemText({ ...dependent, dependencies: [{}] }, {}), /blocked by/);
    const data = buildStandupData(fixture.items, opts);
    const groups: GroupBy[] = ["assignee", "sprint", "type", "milestone"];
    const labels = ["Unassigned", "No sprint", "Untyped", "(no milestone)"];
    const missingType = { ...fixture.items[0] }; Reflect.deleteProperty(missingType, "type");
    for (const [index, groupBy] of groups.entries()) {
      const groupingOpts = { ...opts, groupBy, channel: "#preview", since: "2026-01-01" };
      const groupingData = { ...data, wip: [missingType] };
      assert.match(buildTextMessage(groupingData, groupingOpts), new RegExp(labels[index].replace(/[()]/g, "\\$&")));
      const markdown = buildTextMessage(groupingData, { ...groupingOpts, format: "markdown" });
      assert.match(markdown, /- \*\*.*\*\*\n  - /);
      assert.match(buildBlockKit(groupingData, groupingOpts).fallback, /#preview/);
    }
    assert.deepEqual(groupItems([missingType], "status"), [["_none", [missingType]]]);
    let groupReads = 0;
    const changingGrouping = {
      ...opts,
      /** Public render options may be accessors; preserve the fallback when grouping changes. */
      get groupBy(): GroupBy { groupReads += 1; return groupReads === 1 ? "assignee" : "status"; },
    };
    assert.match(buildTextMessage(data, changingGrouping), /_none/);
    const overrides = { ...opts, sectionLabels: { in_progress: { emoji: "🎯" }, done: { title: "Completed" } } };
    assert.equal(resolveSections(data, overrides)[0].title, "In Progress");
    const done = fixture.items.find((item) => item.status === "closed"); assert.ok(done);
    const split = { ...data, doneYesterday: [], doneToday: [done] };
    assert.deepEqual(resolveSections(split, { ...opts, splitYesterday: true }).filter((section) => section.key === "done").map((section) => section.title), ["Done Today"]);
    assert.equal(resolveSections(split, { ...opts, splitYesterday: true, sectionLabels: { done: { emoji: "🎉" } } }).find((section) => section.key === "done")?.emoji, "🎉");
    const counts = { in_progress: 1, blocked: 1, done: 1, up_next: 2 };
    const history = [{ label: "first", counts }, { label: "second", counts }];
    assert.match(buildTextMessage(data, { ...opts, history }), /\n\nHistory/);
    assert.match(buildTextMessage(data, { ...opts, history, trend: [] }), /History/);
    assert.match(renderStandup(data, opts), /Runtime parser integration/);
    assert.ok(Array.isArray((JSON.parse(renderStandup(data, { ...opts, format: "blockkit" })) as { blocks: unknown[] }).blocks));
    assert.deepEqual(resolvePostTargets("unused", undefined, ["https://localhost/a", "https://localhost/a"]), [{ webhookUrl: "https://localhost/a", channel: undefined }]);
    const results = await postStandupTargets([{ webhookUrl: "synthetic" }], data, opts, async () => { throw "transport string"; });
    assert.deepEqual(results, [{ channel: undefined, ok: false, error: "transport string" }]);
  } finally { await removeRuntimeFixture(fixture); }
});

test("Windows launch validates and quotes one argument snapshot", () => {
  const values = ["safe"];
  let reads = 0;
  Object.defineProperty(values, "0", {
    /** Model an argument supplier that changes after the first read. */
    get(): string { reads += 1; return reads === 1 ? "safe" : 'unsafe" & echo injected'; },
  });
  const args = pmLaunchPlan("pm.cmd", "win32").args(values);
  assert.equal(reads, 1, "validated arguments must be reused, never collected a second time");
  assert.equal(args[4], '"pm.cmd safe"');
});

test("partial prior snapshots keep valid sections and warn on actual filesystem failures", async () => {
  const fixture = await runtimeFixture();
  try {
    const empty: SectionCounts = { in_progress: 0, blocked: 0, done: 0, up_next: 0 };
    for (const [key, canonical] of [["wip", "in_progress"], ["blocked", "blocked"], ["done", "done"], ["upNext", "up_next"]] as const) {
      assert.deepEqual(extractPriorCounts({ counts: { [key]: 2 } }), { ...empty, [canonical]: 2 });
      assert.deepEqual(extractPriorCounts({ sections_data: { [key]: [{ id: "synthetic" }] } }), { ...empty, [canonical]: 1 });
    }
    assert.equal(extractPriorCounts({ sections_data: {} }), undefined);
    const bad = join(fixture.directory, "malformed.json"); writeFileSync(bad, "{");
    assert.equal(readPriorCounts(bad), undefined);
    const wrong = join(fixture.directory, "wrong.json"); writeFileSync(wrong, "{}");
    assert.equal(readPriorCounts(wrong), undefined);
    const history = join(fixture.directory, "history"); mkdirSync(history);
    writeFileSync(join(history, "standup-2001-01-01.json"), "{");
    writeFileSync(join(history, "standup-2001-01-02.json"), "{}");
    assert.deepEqual(readSnapshotHistory(history), []);
    const sparse = { ...empty }; Reflect.deleteProperty(sparse, "done");
    assert.equal(computeDeltas(sparse, empty)[2].delta, 0);
    assert.equal(computeDeltas(empty, sparse)[2].delta, 0);
    assert.match(renderHistoryLine([{ label: "first", counts: sparse }, { label: "second", counts: empty }], sparse), /Done 0→0→0/);
  } finally { await removeRuntimeFixture(fixture); }
});
