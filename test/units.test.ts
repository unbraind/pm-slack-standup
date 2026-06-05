import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFormat,
  parseGroupBy,
  parseSections,
  parseDays,
  parseMentionMap,
  resolveSinceMs,
  resolveUpNextCount,
  writeError,
  DEFAULT_UP_NEXT,
  withinWindow,
  groupItems,
  buildStandupData,
  buildTextMessage,
  buildBlockKit,
  renderStandup,
  itemText,
  ALL_SECTIONS,
  hasBlockedByDep,
  localDayKey,
  parseSectionLabels,
  parseChannels,
  isWebhookUrl,
  resolvePostTargets,
  postStandupTargets,
  isPostRequested,
  needsBaseWebhook,
  preflightSlackCredentials,
  type PmItem,
  type StandupOptions,
  type Poster,
} from "../dist/index.js";

const baseOpts: StandupOptions = {
  format: "slack",
  includeDone: false,
  groupBy: "status",
  sections: [...ALL_SECTIONS],
  mentionMap: {},
  splitYesterday: false,
  sectionLabels: {},
  upNextCount: 3,
};

function item(p: Partial<PmItem>): PmItem {
  return { id: p.id ?? "pm-x", title: p.title ?? "T", status: p.status ?? "open", ...p };
}

// --- parseFormat -----------------------------------------------------------
test("parseFormat accepts the four formats + aliases", () => {
  assert.equal(parseFormat(undefined), "slack");
  assert.equal(parseFormat("slack"), "slack");
  assert.equal(parseFormat("BlockKit"), "blockkit");
  assert.equal(parseFormat("block-kit"), "blockkit");
  assert.equal(parseFormat("md"), "markdown");
  assert.equal(parseFormat("markdown"), "markdown");
  assert.equal(parseFormat("plain"), "plain");
  assert.equal(parseFormat("text"), "plain");
});

test("parseFormat rejects unknown with USAGE exit code", () => {
  assert.throws(() => parseFormat("yaml"), (e: any) => e.exitCode === 2 && /Unknown --format/.test(e.message));
});

// --- parseGroupBy ----------------------------------------------------------
test("parseGroupBy supports status|assignee|sprint|type", () => {
  assert.equal(parseGroupBy(undefined), "status");
  assert.equal(parseGroupBy("assignee"), "assignee");
  assert.equal(parseGroupBy("sprint"), "sprint");
  assert.equal(parseGroupBy("type"), "type");
  assert.throws(() => parseGroupBy("foo"), (e: any) => e.exitCode === 2);
});

// --- parseSections ---------------------------------------------------------
test("parseSections defaults to all, dedupes, preserves order, aliases", () => {
  assert.deepEqual(parseSections(undefined), [...ALL_SECTIONS]);
  assert.deepEqual(parseSections("blocked,in_progress"), ["blocked", "in_progress"]);
  assert.deepEqual(parseSections("wip,wip,next"), ["in_progress", "up_next"]);
  assert.throws(() => parseSections("nope"), (e: any) => e.exitCode === 2);
});

// --- parseDays / resolveSinceMs / withinWindow -----------------------------
test("parseDays parses numbers and rejects non-numeric", () => {
  assert.equal(parseDays(undefined), undefined);
  assert.equal(parseDays("7"), 7);
  assert.throws(() => parseDays("abc"), (e: any) => e.exitCode === 2);
});

test("resolveSinceMs: --since, --days, and the more-restrictive combination", () => {
  const now = Date.parse("2026-06-10T00:00:00Z");
  assert.ok(isNaN(resolveSinceMs(undefined, undefined, now)));
  assert.equal(resolveSinceMs("2026-06-01T00:00:00Z", undefined, now), Date.parse("2026-06-01T00:00:00Z"));
  assert.equal(resolveSinceMs(undefined, 3, now), now - 3 * 86_400_000);
  // since=June 1 vs days=3 (June 7) -> June 7 is later/more restrictive
  assert.equal(resolveSinceMs("2026-06-01T00:00:00Z", 3, now), now - 3 * 86_400_000);
  // an invalid --days is still a hard USAGE error
  assert.throws(() => resolveSinceMs(undefined, -1, now), (e: any) => e.exitCode === 2);
});

test("resolveSinceMs warns (does not throw) on an unparseable --since and ignores it", () => {
  const now = Date.parse("2026-06-10T00:00:00Z");
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  // unparseable --since: warns + falls back to no-window (NaN), does NOT throw
  const result = resolveSinceMs("not-a-date", undefined, now, warn);
  assert.ok(isNaN(result), "invalid --since should yield NaN (no window)");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ignoring unparseable --since/i);
  // a valid --since still wins even when --since was the only field
  warnings.length = 0;
  assert.equal(resolveSinceMs("2026-06-01T00:00:00Z", undefined, now, warn), Date.parse("2026-06-01T00:00:00Z"));
  assert.equal(warnings.length, 0);
  // invalid --since but a valid --days: the days bound still applies, with a warning
  warnings.length = 0;
  assert.equal(resolveSinceMs("nope", 3, now, warn), now - 3 * 86_400_000);
  assert.equal(warnings.length, 1);
});

// --- resolveUpNextCount ----------------------------------------------------
test("resolveUpNextCount: default 3, explicit N, --all-open => Infinity, invalid => USAGE", () => {
  assert.equal(resolveUpNextCount(undefined, false), DEFAULT_UP_NEXT);
  assert.equal(resolveUpNextCount("", false), DEFAULT_UP_NEXT);
  assert.equal(resolveUpNextCount("5", false), 5);
  assert.equal(resolveUpNextCount("1", false), 1);
  // --all-open wins over any --up-next value
  assert.equal(resolveUpNextCount("5", true), Infinity);
  assert.equal(resolveUpNextCount(undefined, true), Infinity);
  assert.throws(() => resolveUpNextCount("0", false), (e: any) => e.exitCode === 2);
  assert.throws(() => resolveUpNextCount("-2", false), (e: any) => e.exitCode === 2);
  assert.throws(() => resolveUpNextCount("2.5", false), (e: any) => e.exitCode === 2);
  assert.throws(() => resolveUpNextCount("abc", false), (e: any) => e.exitCode === 2);
});

test("buildStandupData honors upNextCount and --all-open shows the whole backlog", () => {
  const open = Array.from({ length: 8 }, (_, i) =>
    item({ id: `o-${i}`, status: "open", priority: i + 1, title: `Open ${i}` })
  );
  // default 3
  assert.equal(buildStandupData(open, baseOpts).upNext.length, 3);
  // explicit 5
  assert.equal(buildStandupData(open, { ...baseOpts, upNextCount: 5 }).upNext.length, 5);
  // --all-open (Infinity) shows all 8
  assert.equal(buildStandupData(open, { ...baseOpts, upNextCount: Infinity }).upNext.length, 8);
  // still sorted by priority ascending
  const five = buildStandupData(open, { ...baseOpts, upNextCount: 5 }).upNext;
  assert.deepEqual(five.map((i) => i.priority), [1, 2, 3, 4, 5]);
});

// --- group-by milestone ----------------------------------------------------
test("parseGroupBy accepts milestone", () => {
  assert.equal(parseGroupBy("milestone"), "milestone");
  assert.equal(parseGroupBy("MILESTONE"), "milestone");
});

test("groupItems groups by milestone with (no milestone) fallback, sorted", () => {
  const items = [
    item({ id: "1", milestone: "v2" }),
    item({ id: "2", milestone: "v1" }),
    item({ id: "3" }), // no milestone
    item({ id: "4", milestone: "v1" }),
  ];
  const byMilestone = groupItems(items, "milestone");
  assert.deepEqual(byMilestone.map(([k]) => k), ["_none", "v1", "v2"]);
  assert.equal(byMilestone.find(([k]) => k === "v1")![1].length, 2);
});

test("milestone grouping renders milestone buckets + (no milestone) label in text", () => {
  const items = [
    item({ id: "1", status: "in_progress", title: "Alpha", milestone: "v1" }),
    item({ id: "2", status: "in_progress", title: "Beta" }), // no milestone
  ];
  const data = buildStandupData(items, baseOpts);
  const msg = buildTextMessage(data, { ...baseOpts, groupBy: "milestone" });
  assert.match(msg, /v1/);
  assert.match(msg, /\(no milestone\)/);
  // both items appear under their buckets
  assert.match(msg, /Alpha/);
  assert.match(msg, /Beta/);
});

test("Block Kit footer notes milestone grouping", () => {
  const data = buildStandupData([item({ status: "in_progress", milestone: "v1" })], baseOpts);
  const { blocks } = buildBlockKit(data, { ...baseOpts, groupBy: "milestone" });
  const footer = blocks[blocks.length - 1] as any;
  assert.match(footer.elements[0].text, /grouped by milestone/);
});

// --- writeError (friendly export output errors) ----------------------------
test("writeError maps fs errno codes to friendly CommandError messages", () => {
  const enoent = writeError("/nope/x.md", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  assert.equal(enoent.exitCode, 1);
  assert.match(enoent.message, /could not write to '\/nope\/x\.md'/);
  assert.match(enoent.message, /parent directory does not exist/);

  const eacces = writeError("/root/x.md", Object.assign(new Error("EACCES"), { code: "EACCES" }));
  assert.match(eacces.message, /permission denied/);

  const eisdir = writeError("/tmp", Object.assign(new Error("EISDIR"), { code: "EISDIR" }));
  assert.match(eisdir.message, /is a directory/);

  // unknown errno falls back to the raw message, still a clean CommandError
  const other = writeError("/x", new Error("disk on fire"));
  assert.equal(other.exitCode, 1);
  assert.match(other.message, /disk on fire/);
});

test("withinWindow honors the bound and treats NaN as no-window", () => {
  const it = item({ updated_at: "2026-06-05T00:00:00Z" });
  assert.equal(withinWindow(it, NaN), true);
  assert.equal(withinWindow(it, Date.parse("2026-06-01T00:00:00Z")), true);
  assert.equal(withinWindow(it, Date.parse("2026-06-09T00:00:00Z")), false);
});

// --- parseMentionMap -------------------------------------------------------
test("parseMentionMap normalizes handles and separators", () => {
  assert.deepEqual(parseMentionMap("alice=@a,bob=b"), { alice: "@a", bob: "@b" });
  assert.deepEqual(parseMentionMap("x=@x;y=@y"), { x: "@x", y: "@y" });
  assert.deepEqual(parseMentionMap(undefined), {});
});

// --- groupItems ------------------------------------------------------------
test("groupItems groups by assignee/sprint/type with _none fallback, sorted", () => {
  const items = [
    item({ id: "1", assignee: "bob", sprint: "S2", type: "Task" }),
    item({ id: "2", assignee: "alice", sprint: "S1", type: "Bug" }),
    item({ id: "3", type: "Task" }), // no assignee / no sprint
  ];
  const byAssignee = groupItems(items, "assignee");
  assert.deepEqual(byAssignee.map(([k]) => k), ["_none", "alice", "bob"]);
  const bySprint = groupItems(items, "sprint");
  assert.deepEqual(bySprint.map(([k]) => k), ["_none", "S1", "S2"]);
  const byType = groupItems(items, "type");
  assert.deepEqual(byType.map(([k]) => k), ["Bug", "Task"]);
  assert.equal(byType.find(([k]) => k === "Task")![1].length, 2);
});

// --- buildStandupData ------------------------------------------------------
test("buildStandupData buckets by status and windows Done", () => {
  const items = [
    item({ id: "1", status: "in_progress" }),
    item({ id: "2", status: "blocked" }),
    item({ id: "3", status: "open", priority: 1 }),
    item({ id: "4", status: "closed", updated_at: "2026-06-05T00:00:00Z" }),
    item({ id: "5", status: "closed", updated_at: "2026-05-01T00:00:00Z" }),
  ];
  const noDone = buildStandupData(items, baseOpts);
  assert.equal(noDone.wip.length, 1);
  assert.equal(noDone.blocked.length, 1);
  assert.equal(noDone.upNext.length, 1);
  assert.equal(noDone.done.length, 0); // includeDone false
  assert.equal(noDone.total, 5);

  const windowed = buildStandupData(
    items,
    { ...baseOpts, includeDone: true },
    Date.parse("2026-06-01T00:00:00Z")
  );
  assert.equal(windowed.done.length, 1); // only the June-05 close is in window
  assert.equal(windowed.done[0].id, "4");
});

// --- formatters: slack byte-identical core ---------------------------------
test("slack format renders mrkdwn headings + bullets (backward compatible)", () => {
  const data = buildStandupData([item({ status: "in_progress", title: "Foo", type: "task" })], baseOpts);
  const msg = buildTextMessage(data, baseOpts);
  assert.match(msg, /^📊 \*pm standup\* — \d{4}-\d{2}-\d{2}$/m);
  assert.match(msg, /^🏃 \*In Progress\* \(1\)$/m);
  assert.match(msg, /^• \[Task\] Foo$/m);
  assert.match(msg, /^🚫 \*Blocked\* \(0\)$/m);
  assert.match(msg, /^• _nothing blocked_$/m);
});

test("plain format drops emphasis punctuation", () => {
  const data = buildStandupData([item({ status: "blocked", title: "Bar" })], baseOpts);
  const msg = buildTextMessage(data, { ...baseOpts, format: "plain" });
  assert.match(msg, /^📊 pm standup — /m);
  assert.match(msg, /^🚫 Blocked \(1\)$/m);
  assert.ok(!/\*/.test(msg), "plain output should contain no asterisks");
});

test("markdown format uses # heading and ** bold", () => {
  const data = buildStandupData([item({ status: "in_progress", title: "Baz", type: "task" })], baseOpts);
  const msg = buildTextMessage(data, { ...baseOpts, format: "markdown" });
  assert.match(msg, /^# 📊 pm standup — /m);
  assert.match(msg, /^## 🏃 In Progress \(1\)$/m);
  assert.match(msg, /^- \[Task\] Baz$/m);
});

// --- Block Kit -------------------------------------------------------------
test("buildBlockKit produces a valid blocks array with header + sections + footer", () => {
  const data = buildStandupData(
    [
      item({ status: "in_progress", title: "A" }),
      item({ status: "blocked", title: "B" }),
    ],
    baseOpts
  );
  const { blocks, fallback } = buildBlockKit(data, baseOpts);
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "header");
  assert.equal((blocks[0] as any).text.type, "plain_text");
  const types = blocks.map((b) => b.type);
  assert.ok(types.includes("section"));
  assert.ok(types.includes("divider"));
  assert.equal(blocks[blocks.length - 1].type, "context");
  assert.ok(typeof fallback === "string" && fallback.includes("pm standup"));
  // round-trips through JSON cleanly
  assert.deepEqual(JSON.parse(JSON.stringify({ blocks })).blocks.length, blocks.length);
});

test("renderStandup returns valid JSON with a blocks array for blockkit", () => {
  const data = buildStandupData([item({ status: "in_progress" })], baseOpts);
  const out = renderStandup(data, { ...baseOpts, format: "blockkit" });
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.blocks));
  assert.equal(parsed.blocks[0].type, "header");
});

test("Block Kit truncates section text to Slack's 3000-char limit", () => {
  const many = Array.from({ length: 400 }, (_, i) =>
    item({ id: `pm-${i}`, status: "in_progress", title: "X".repeat(40) })
  );
  const data = buildStandupData(many, baseOpts);
  const { blocks } = buildBlockKit(data, baseOpts);
  for (const b of blocks) {
    if (b.type === "section") {
      assert.ok(((b as any).text.text as string).length <= 3000);
    }
  }
});

// --- sections selection ----------------------------------------------------
test("resolved sections honor --sections selection and ordering", () => {
  const data = buildStandupData(
    [item({ status: "in_progress" }), item({ status: "blocked" })],
    baseOpts
  );
  const onlyBlocked = buildTextMessage(data, { ...baseOpts, sections: parseSections("blocked") });
  assert.match(onlyBlocked, /Blocked/);
  assert.ok(!/In Progress/.test(onlyBlocked), "in_progress should be filtered out");
});

// --- itemText --------------------------------------------------------------
test("itemText adds type label, priority, and mention", () => {
  const it = item({ title: "Ship", type: "feature", priority: 1, assignee: "alice" });
  assert.equal(itemText(it, { alice: "@a" }, true), "[Feature] Ship (priority 1) (@a)");
  assert.equal(itemText(it, {}, false), "[Feature] Ship");
});

// --- blocked_by inference --------------------------------------------------
test("hasBlockedByDep detects top-level string and dependencies[].kind", () => {
  assert.equal(hasBlockedByDep(item({})), false);
  assert.equal(hasBlockedByDep(item({ blocked_by: "pm-123" })), true);
  assert.equal(hasBlockedByDep(item({ blocked_by: "   " })), false);
  assert.equal(
    hasBlockedByDep(item({ dependencies: [{ id: "pm-9", kind: "blocked_by" }] })),
    true
  );
  assert.equal(
    hasBlockedByDep(item({ dependencies: [{ id: "pm-9", kind: "relates_to" }] })),
    false
  );
});

test("buildStandupData surfaces blocked_by items under Blocked even when not status=blocked", () => {
  const items = [
    item({ id: "1", status: "in_progress", title: "Plain WIP" }),
    item({ id: "2", status: "in_progress", title: "WIP w/ dep", blocked_by: "pm-x" }),
    item({ id: "3", status: "open", title: "Open w/ dep", dependencies: [{ kind: "blocked_by" }] }),
    item({ id: "4", status: "blocked", title: "Hard blocked" }),
    // A closed item with a stale blocked_by must NOT re-surface as blocked.
    item({ id: "5", status: "closed", title: "Done", blocked_by: "pm-y" }),
  ];
  const data = buildStandupData(items, { ...baseOpts, includeDone: true });
  const blockedIds = data.blocked.map((i) => i.id).sort();
  assert.deepEqual(blockedIds, ["2", "3", "4"]);
  // re-bucketed: the blocked_by WIP item left the wip bucket
  assert.deepEqual(data.wip.map((i) => i.id), ["1"]);
  // the blocked_by open item left the up-next pool
  assert.ok(!data.upNext.some((i) => i.id === "3"));
  // closed item stays in Done, not Blocked
  assert.ok(data.done.some((i) => i.id === "5"));
});

// --- yesterday/today split -------------------------------------------------
test("localDayKey renders a local YYYY-MM-DD", () => {
  const it = item({ updated_at: "2026-06-04T12:00:00Z" });
  assert.match(localDayKey(it), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(localDayKey(item({})), "");
});

test("buildStandupData splits Done into yesterday/today by local day", () => {
  const now = Date.parse("2026-06-04T18:00:00Z");
  const yest = new Date(now - 86_400_000).toISOString();
  const tod = new Date(now - 3_600_000).toISOString();
  const items = [
    item({ id: "y", status: "closed", title: "Closed yesterday", updated_at: yest }),
    item({ id: "t", status: "closed", title: "Closed today", updated_at: tod }),
    item({ id: "old", status: "closed", title: "Closed long ago", updated_at: "2026-05-01T00:00:00Z" }),
  ];
  const data = buildStandupData(items, { ...baseOpts, includeDone: true, splitYesterday: true }, NaN, now);
  assert.deepEqual(data.doneYesterday!.map((i) => i.id), ["y"]);
  assert.deepEqual(data.doneToday!.map((i) => i.id), ["t"]);
  // split is off by default → no subsets
  const noSplit = buildStandupData(items, { ...baseOpts, includeDone: true }, NaN, now);
  assert.equal(noSplit.doneYesterday, undefined);
});

test("yesterday split renders distinct Done Yesterday / Done Today headings", () => {
  const now = Date.parse("2026-06-04T18:00:00Z");
  const yest = new Date(now - 86_400_000).toISOString();
  const tod = new Date(now - 3_600_000).toISOString();
  const items = [
    item({ id: "y", status: "closed", title: "Yfix", updated_at: yest }),
    item({ id: "t", status: "closed", title: "Tfix", updated_at: tod }),
  ];
  const data = buildStandupData(items, { ...baseOpts, includeDone: true, splitYesterday: true }, NaN, now);
  const msg = buildTextMessage(data, { ...baseOpts, includeDone: true, splitYesterday: true });
  assert.match(msg, /Done Yesterday/);
  assert.match(msg, /Done Today/);
});

// --- section label overrides -----------------------------------------------
test("parseSectionLabels parses title-only and emoji+title, rejects unknown keys", () => {
  assert.deepEqual(parseSectionLabels(undefined), {});
  assert.deepEqual(parseSectionLabels("in_progress=Rolling"), {
    in_progress: { title: "Rolling" },
  });
  assert.deepEqual(parseSectionLabels("blocked=🔥 On Fire"), {
    blocked: { emoji: "🔥", title: "On Fire" },
  });
  // alias keys (wip) resolve to canonical
  assert.deepEqual(parseSectionLabels("wip=Doing"), { in_progress: { title: "Doing" } });
  assert.throws(() => parseSectionLabels("nope=X"), (e: any) => e.exitCode === 2);
});

test("section label overrides apply to rendered headings", () => {
  const data = buildStandupData([item({ status: "blocked", title: "B" })], baseOpts);
  const msg = buildTextMessage(data, {
    ...baseOpts,
    sectionLabels: parseSectionLabels("blocked=🔥 On Fire,in_progress=Rolling"),
  });
  assert.match(msg, /🔥 \*On Fire\* \(1\)/);
  assert.match(msg, /🏃 \*Rolling\* \(0\)/); // emoji kept, title overridden
});

// --- multi-channel ---------------------------------------------------------
test("parseChannels splits, trims, de-dupes", () => {
  assert.deepEqual(parseChannels(undefined), []);
  assert.deepEqual(parseChannels("#a, #b ;#a"), ["#a", "#b"]);
});

test("isWebhookUrl distinguishes URLs from channel names", () => {
  assert.equal(isWebhookUrl("#team"), false);
  assert.equal(isWebhookUrl("https://hooks.slack.com/x"), true);
});

test("resolvePostTargets: default single target, #names reuse base webhook, URLs override", () => {
  assert.deepEqual(resolvePostTargets("https://hook", "#base", []), [
    { webhookUrl: "https://hook", channel: "#base" },
  ]);
  assert.deepEqual(resolvePostTargets("https://hook", undefined, ["#a", "#b"]), [
    { webhookUrl: "https://hook", channel: "#a" },
    { webhookUrl: "https://hook", channel: "#b" },
  ]);
  assert.deepEqual(resolvePostTargets("https://base", "#base", ["https://other"]), [
    { webhookUrl: "https://other", channel: "#base" },
  ]);
});

test("postStandupTargets posts to each target and reports per-target results", async () => {
  const data = buildStandupData([item({ status: "in_progress" })], baseOpts);
  const calls: Array<{ url: string; text: unknown }> = [];
  const poster: Poster = async (url, payload) => {
    calls.push({ url, text: (payload as any).text });
  };
  const targets = resolvePostTargets("https://hook", undefined, ["#a", "#b"]);
  const results = await postStandupTargets(targets, data, baseOpts, poster);
  assert.equal(calls.length, 2);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(results.map((r) => r.channel), ["#a", "#b"]);
  // each rendered message shows its own channel name
  assert.ok(calls[0].text!.toString().includes("#a"));
  assert.ok(calls[1].text!.toString().includes("#b"));
});

// --- preflight credential gate ---------------------------------------------
test("isPostRequested is true unless --dry-run", () => {
  assert.equal(isPostRequested({}), true);
  assert.equal(isPostRequested({ channel: "#x" }), true);
  // --fallback-to-stdout still posts (it only changes failure handling)
  assert.equal(isPostRequested({ "fallback-to-stdout": true }), true);
  assert.equal(isPostRequested({ "dry-run": true }), false);
  assert.equal(isPostRequested({ dryRun: true }), false); // camelCase form
});

test("needsBaseWebhook: empty channels or any bare #name requires base webhook", () => {
  assert.equal(needsBaseWebhook([]), true);
  assert.equal(needsBaseWebhook(["#a"]), true);
  assert.equal(needsBaseWebhook(["https://hooks.slack.com/x"]), false);
  // mixed: a bare name still needs the base webhook
  assert.equal(needsBaseWebhook(["https://hooks.slack.com/x", "#b"]), true);
});

test("preflightSlackCredentials aborts (USAGE) when a post is requested but no webhook is set", () => {
  const saved = process.env["PM_SLACK_WEBHOOK"];
  delete process.env["PM_SLACK_WEBHOOK"];
  try {
    assert.throws(
      () => preflightSlackCredentials({}),
      (e: any) => e.exitCode === 2 && /no webhook is configured/i.test(e.message)
    );
    // bare #name channel still requires the base webhook → aborts
    assert.throws(
      () => preflightSlackCredentials({ channels: "#team" }),
      (e: any) => e.exitCode === 2
    );
  } finally {
    if (saved !== undefined) process.env["PM_SLACK_WEBHOOK"] = saved;
  }
});

test("preflightSlackCredentials does NOT block --dry-run even with no webhook", () => {
  const saved = process.env["PM_SLACK_WEBHOOK"];
  delete process.env["PM_SLACK_WEBHOOK"];
  try {
    assert.doesNotThrow(() => preflightSlackCredentials({ "dry-run": true }));
  } finally {
    if (saved !== undefined) process.env["PM_SLACK_WEBHOOK"] = saved;
  }
});

test("preflightSlackCredentials passes when --webhook is provided", () => {
  assert.doesNotThrow(() =>
    preflightSlackCredentials({ webhook: "https://hooks.slack.com/services/x" })
  );
});

test("preflightSlackCredentials passes when --channels carries only full webhook URLs", () => {
  const saved = process.env["PM_SLACK_WEBHOOK"];
  delete process.env["PM_SLACK_WEBHOOK"];
  try {
    assert.doesNotThrow(() =>
      preflightSlackCredentials({ channels: "https://hooks.slack.com/services/a" })
    );
  } finally {
    if (saved !== undefined) process.env["PM_SLACK_WEBHOOK"] = saved;
  }
});

// --- fallback-to-stdout (simulated transport failure) ----------------------
test("postStandupTargets captures a failing poster without throwing", async () => {
  const data = buildStandupData([item({ status: "in_progress" })], baseOpts);
  const failing: Poster = async () => {
    throw new Error("HTTP 500: boom");
  };
  const targets = resolvePostTargets("https://hook", "#x", []);
  const results = await postStandupTargets(targets, data, baseOpts, failing);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? "", /HTTP 500/);
  // The caller (run handler) would then render to stdout on this signal.
  const rendered = buildTextMessage(data, baseOpts);
  assert.ok(rendered.includes("pm standup"));
});
