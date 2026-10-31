import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  acquireLock, appendHistoryEntry, createHistoryEntry, emptyImportedDocument, getHistoryPath,
  isPmCliExpectedError, locateItem, readLocatedItem,
} from "@unbrained/pm-cli/sdk";
import type { ItemDocument, MutationEvent, MutationEventPage, PmCliExpectedError } from "@unbrained/pm-cli/sdk";
import {
  admitStandupWindowBoundary, buildStandupWindowPacket, compareStandupWindowPositions,
  DEFAULT_STANDUP_WINDOW_MAX_EVENTS, eventAfterBoundary, eventInStandupWindow,
  parseStandupWindowBoundaryState, parseStandupWindowMaxEvents, readStandupWindowBoundary,
  scanStandupWindowEvents, serializeStandupWindowBoundary, standupWindowCoverageRegressions,
  standupWindowDeletedStreams, standupWindowHasCursorCoverage, standupWindowLockId, standupWindowRefusalMessage,
  standupWindowUnknownStreams, STANDUP_WINDOW_REFUSAL_REMEDIES, STANDUP_WINDOW_STATE_VERSION,
} from "../index.ts";
import type { StandupWindowPacket, StandupWindowBoundary } from "../index.ts";
import { runtimeFixture, removeRuntimeFixture, runtimeCommand } from "./runtime-fixture.ts";
import type { RuntimeFixture } from "./runtime-fixture.ts";

/** Whether a thrown value is a pm expected error carrying the given typed refusal code. */
function isWindowRefusal(error: unknown, code: string): error is PmCliExpectedError {
  return isPmCliExpectedError(error) && error.code === code;
}

/** One synthetic journal event for scan-level tests (only position fields matter). */
function eventAt(streamId: string, version: number, ts: string, type = "update"): MutationEvent {
  return { item_id: streamId, version, ts, author: "tester", type, patch_count: 0 };
}

/** One synthetic SDK page for scan-level tests. */
function page(events: MutationEvent[], hasMore: boolean, nextCursor?: string): MutationEventPage {
  return {
    events, count: events.length, has_more: hasMore, cursor_mode: "batch", integrity: "verified",
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
    source: "authoritative_history",
  };
}

/** A boundary built from a plain position plus coverage, for membership tests. */
function boundaryAt(ts: string, streamId: string, offset: number, covered: Record<string, number> = {}): StandupWindowBoundary {
  return {
    cursor: "boundary", last_ts: ts, last_stream_id: streamId, last_stream_offset: offset,
    covered_streams: new Map(Object.entries(covered)), admitted_events: 1, admitted_at: "2026-10-27T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Refusal contract
// ---------------------------------------------------------------------------

test("every typed refusal code renders its code and remedy", () => {
  for (const code of Object.keys(STANDUP_WINDOW_REFUSAL_REMEDIES) as Array<keyof typeof STANDUP_WINDOW_REFUSAL_REMEDIES>) {
    const message = standupWindowRefusalMessage(code, "detail here");
    assert.match(message, new RegExp(`\\(${code}\\)`), code);
    assert.ok(message.includes(STANDUP_WINDOW_REFUSAL_REMEDIES[code]), `${code} remedy`);
    assert.ok(message.includes("detail here"), `${code} detail`);
  }
});

test("the state version is pinned and the max-events default is bounded", () => {
  assert.equal(STANDUP_WINDOW_STATE_VERSION, 1);
  assert.equal(DEFAULT_STANDUP_WINDOW_MAX_EVENTS, 10000);
  assert.equal(parseStandupWindowMaxEvents(undefined), DEFAULT_STANDUP_WINDOW_MAX_EVENTS);
  assert.equal(parseStandupWindowMaxEvents("500"), 500);
  for (const bad of ["", "  ", "0", "-3", "1.5", "1000001", "junk", "NaN", "Infinity"]) {
    assert.throws(() => parseStandupWindowMaxEvents(bad), (error: unknown) =>
      isWindowRefusal(error, "window_max_events_invalid") && error.exitCode === 2, bad);
  }
});

// ---------------------------------------------------------------------------
// Boundary state validation
// ---------------------------------------------------------------------------

test("a serialized boundary round-trips through the strict parser", () => {
  const boundary = boundaryAt("2026-10-27T01:02:03.000Z", "item-1", 4, { "item-1": 4, _workspace: 9 });
  const parsed = parseStandupWindowBoundaryState(JSON.parse(serializeStandupWindowBoundary(boundary)));
  assert.deepEqual(parsed, { ...boundary, covered_streams: new Map(Object.entries({ "item-1": 4, _workspace: 9 })) });
  assert.equal(serializeStandupWindowBoundary(parsed), serializeStandupWindowBoundary(boundary));
});

test("state producer preserves reserved object keys through SDK-facing serialization", () => {
  const boundary = boundaryAt("2026-10-27T00:00:00Z", "constructor", 0);
  boundary.covered_streams = new Map([["constructor", 0], ["__proto__", 2]]);
  assert.deepEqual(parseStandupWindowBoundaryState(JSON.parse(serializeStandupWindowBoundary(boundary))), boundary);
});

test("the strict parser refuses every invalid boundary shape with a typed code", () => {
  const valid = JSON.parse(serializeStandupWindowBoundary(boundaryAt("2026-10-27T00:00:00.000Z", "item-1", 1, { "item-1": 1 })));
  const cases: Array<[string, unknown]> = [
    ["bare array", []],
    ["null", null],
    ["missing boundary", { version: STANDUP_WINDOW_STATE_VERSION }],
    ["boundary not object", { version: STANDUP_WINDOW_STATE_VERSION, boundary: 3 }],
    ["cursor not string", { ...valid, boundary: { ...valid.boundary, cursor: 7 } }],
    ["cursor empty", { ...valid, boundary: { ...valid.boundary, cursor: "" } }],
    ["cursor too long", { ...valid, boundary: { ...valid.boundary, cursor: "x".repeat(4097) } }],
    ["cursor bad charset", { ...valid, boundary: { ...valid.boundary, cursor: "not base64url+padding!" } }],
    ["covered not object", { ...valid, boundary: { ...valid.boundary, covered_streams: [] } }],
    ["covered stream id empty", { ...valid, boundary: { ...valid.boundary, covered_streams: { " ": 1 } } }],
    ["covered stream id path", { ...valid, boundary: { ...valid.boundary, covered_streams: { "a/b": 1 } } }],
    ["covered offset negative", { ...valid, boundary: { ...valid.boundary, covered_streams: { "item-1": -1 } } }],
    ["covered offset float", { ...valid, boundary: { ...valid.boundary, covered_streams: { "item-1": 0.5 } } }],
    ["covered offset string", { ...valid, boundary: { ...valid.boundary, covered_streams: { "item-1": "2" } } }],
    ["last_ts not a date", { ...valid, boundary: { ...valid.boundary, last_ts: "yesterday" } }],
    ["last_stream_id missing", (() => { const value = { ...valid, boundary: { ...valid.boundary } }; delete value.boundary.last_stream_id; return value; })()],
    ["last_stream_offset negative", { ...valid, boundary: { ...valid.boundary, last_stream_offset: -2 } }],
    ["admitted_events string", { ...valid, boundary: { ...valid.boundary, admitted_events: "4" } }],
    ["admitted_at not a date", { ...valid, boundary: { ...valid.boundary, admitted_at: "" } }],
  ];
  for (const [name, value] of cases) {
    assert.throws(() => parseStandupWindowBoundaryState(value), (error: unknown) =>
      isWindowRefusal(error, "window_state_invalid_shape"), name);
  }
});

test("reading the state file distinguishes absent, unreadable, wrong-version, and valid", () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-window-state-"));
  try {
    const absent = join(directory, "absent.json");
    assert.deepEqual(readStandupWindowBoundary(absent), { boundary: null, bytes: "" });

    const unreadable = join(directory, "unreadable.json");
    writeFileSync(unreadable, "{not json", "utf8");
    assert.throws(() => readStandupWindowBoundary(unreadable), (error: unknown) =>
      isWindowRefusal(error, "window_state_unreadable") && error.exitCode === 2);

    const wrongVersion = join(directory, "wrong-version.json");
    writeFileSync(wrongVersion, JSON.stringify({ version: 99, boundary: {} }), "utf8");
    assert.throws(() => readStandupWindowBoundary(wrongVersion), (error: unknown) =>
      isWindowRefusal(error, "window_state_version_unsupported"));

    const valid = join(directory, "valid.json");
    const boundary = boundaryAt("2026-10-27T00:00:00.000Z", "item-1", 1, { "item-1": 1 });
    writeFileSync(valid, serializeStandupWindowBoundary(boundary), "utf8");
    const snapshot = readStandupWindowBoundary(valid);
    assert.equal(snapshot.boundary?.cursor, "boundary");
    assert.equal(snapshot.bytes, serializeStandupWindowBoundary(boundary));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reading a directory-named state file refuses as unreadable", () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-window-dir-"));
  try {
    assert.throws(() => readStandupWindowBoundary(directory), (error: unknown) =>
      isWindowRefusal(error, "window_state_unreadable") && error.exitCode === 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Admission: compare-and-set under the tracker lock
// ---------------------------------------------------------------------------

test("admission writes the exact next boundary when the state is unchanged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-window-admit-"));
  try {
    const statePath = join(directory, "window.json");
    const snapshot = readStandupWindowBoundary(statePath);
    assert.equal(snapshot.boundary, null);
    const boundary = boundaryAt("2026-10-27T00:00:00.000Z", "item-1", 1, { "item-1": 1 });
    const admission = await admitStandupWindowBoundary(statePath, snapshot, boundary, { pmRoot: directory, owner: "test", waitMs: 100 });
    assert.deepEqual(admission, { admitted: true });
    const after = readStandupWindowBoundary(statePath);
    assert.equal(after.boundary?.last_stream_id, "item-1");
    assert.equal(after.bytes, serializeStandupWindowBoundary(boundary));
    assert.equal(basename(statePath), "window.json");
    assert.equal(standupWindowLockId(statePath), standupWindowLockId(`${directory}/./window.json`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admission reports a concurrent writer instead of overwriting it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-window-cas-"));
  try {
    const statePath = join(directory, "window.json");
    const first = boundaryAt("2026-10-27T00:00:00.000Z", "item-1", 1, { "item-1": 1 });
    assert.deepEqual(await admitStandupWindowBoundary(statePath, { boundary: null, bytes: "" }, first, { pmRoot: directory, owner: "peer", waitMs: 100 }), { admitted: true });
    // A second reporter read the pre-admission (absent) state; its admission
    // must detect the peer's bytes and report them truthfully.
    const second = boundaryAt("2026-10-27T02:00:00.000Z", "item-2", 3, { "item-2": 3 });
    const stale = await admitStandupWindowBoundary(statePath, { boundary: null, bytes: "" }, second, { pmRoot: directory, owner: "test", waitMs: 100 });
    assert.deepEqual(stale, { admitted: false });
    assert.equal(readStandupWindowBoundary(statePath).bytes, serializeStandupWindowBoundary(first));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("admission reports a peer that holds the lease, and rethrows hard lock failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-window-lock-"));
  const filePath = join(directory, "file.txt");
  try {
    const statePath = join(directory, "window.json");
    const snapshot = { boundary: null, bytes: "" };
    const release = await acquireLock(directory, standupWindowLockId(statePath), 60, "peer-owner", false, true, 0);
    try {
      const boundary = boundaryAt("2026-10-27T00:00:00.000Z", "item-1", 1);
      const contended = await admitStandupWindowBoundary(statePath, snapshot, boundary, { pmRoot: directory, owner: "test", waitMs: 0 });
      assert.deepEqual(contended, { admitted: false });
      assert.equal(existsSync(statePath), false);
    } finally {
      await release();
    }
    // A pmRoot that cannot host locks (a plain file) is a hard failure, not contention.
    writeFileSync(filePath, "not a tracker", "utf8");
    await assert.rejects(admitStandupWindowBoundary(join(directory, "other.json"), snapshot, boundaryAt("2026-10-27T00:00:00.000Z", "i", 0), { pmRoot: filePath, owner: "test", waitMs: 100 }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Root writes through a 0o500 directory, so permission-based failures cannot be provoked. */
const cannotEnforceModes = typeof process.getuid === "function" && process.getuid() === 0;

test("admission refuses with a typed code when the atomic write fails", { skip: cannotEnforceModes }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-window-write-"));
  const stateDirectory = join(directory, "state");
  try {
    mkdirSync(stateDirectory);
    const statePath = join(stateDirectory, "window.json");
    const snapshot = { boundary: null, bytes: "" };
    chmodSync(stateDirectory, 0o500);
    try {
      await assert.rejects(admitStandupWindowBoundary(statePath, snapshot, boundaryAt("2026-10-27T00:00:00.000Z", "i", 0), { pmRoot: directory, owner: "test", waitMs: 100 }), (error: unknown) =>
        isWindowRefusal(error, "window_state_write_failed") && error.exitCode === 1);
    } finally {
      chmodSync(stateDirectory, 0o700);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Window membership
// ---------------------------------------------------------------------------

test("positions compare with the SDK's canonical (ts, stream, offset) order", () => {
  const base = { ts: "2026-10-27T00:00:00.000Z", stream_id: "a", stream_offset: 0 };
  assert.equal(compareStandupWindowPositions(base, { ...base }), 0);
  assert.ok(compareStandupWindowPositions(base, { ...base, ts: "2026-10-27T00:00:00.001Z" }) < 0);
  assert.ok(compareStandupWindowPositions({ ...base, ts: "2026-10-27T00:00:00.001Z" }, base) > 0);
  assert.ok(compareStandupWindowPositions(base, { ...base, stream_id: "b" }) < 0);
  assert.ok(compareStandupWindowPositions(base, { ...base, stream_offset: 1 }) < 0);
});

test("membership admits forward, late, and backdated events, and nothing else", () => {
  const boundary = boundaryAt("2026-10-27T12:00:00.000Z", "item-1", 2, { "item-1": 2, "item-2": 1 });
  // Forward append: after the boundary position.
  assert.equal(eventAfterBoundary({ ts: "2026-10-27T13:00:00.000Z", stream_id: "item-2", stream_offset: 1 }, boundary), true);
  assert.equal(eventInStandupWindow({ ts: "2026-10-27T13:00:00.000Z", stream_id: "item-2", stream_offset: 1 }, boundary), true);
  // Late append: new offset beyond coverage, but positioned before the boundary (backdated ts).
  const late = { ts: "2020-01-01T00:00:00.000Z", stream_id: "item-1", stream_offset: 3 };
  assert.equal(eventAfterBoundary(late, boundary), false);
  assert.equal(eventInStandupWindow(late, boundary), true);
  // Already admitted: position at or before the boundary AND offset covered.
  const admitted = { ts: "2026-10-27T11:00:00.000Z", stream_id: "item-1", stream_offset: 1 };
  assert.equal(eventAfterBoundary(admitted, boundary), false);
  assert.equal(eventInStandupWindow(admitted, boundary), false);
  // The boundary event itself is not re-admitted.
  const boundaryEvent = { ts: boundary.last_ts, stream_id: boundary.last_stream_id, stream_offset: boundary.last_stream_offset };
  assert.equal(eventAfterBoundary(boundaryEvent, boundary), false);
  assert.equal(eventInStandupWindow(boundaryEvent, boundary), false);
  // A brand-new stream is always new work (no coverage entry).
  assert.equal(eventInStandupWindow({ ts: "2020-01-01T00:00:00.000Z", stream_id: "item-3", stream_offset: 0 }, boundary), true);
  // Without a boundary everything is in the first window.
  assert.equal(eventInStandupWindow(admitted, null), true);
  assert.equal(eventAfterBoundary(admitted, null), true);
});

// ---------------------------------------------------------------------------
// Journal scan
// ---------------------------------------------------------------------------

test("the scan partitions multi-page journals and keeps the last page's cursor", async () => {
  const boundary = boundaryAt("2026-10-27T12:00:00.000Z", "item-1", 2, { "item-1": 2, "item-2": 1, _workspace: 0 });
  const calls: Array<[string | undefined]> = [];
  const readPage = async (since?: string): Promise<MutationEventPage> => {
    calls.push([since]);
    if (since === undefined) return page([eventAt("_workspace", 1, "2026-10-27T10:00:00.000Z", "settings:write"), eventAt("item-1", 1, "2026-10-27T11:00:00.000Z")], true, "cursor-1");
    if (since === "cursor-1") return page([eventAt("item-2", 2, "2026-10-27T13:00:00.000Z"), eventAt("item-1", 3, "2026-10-27T13:30:00.000Z", "comment")], false, "cursor-2");
    throw new Error("unexpected page cursor");
  };
  const scan = await scanStandupWindowEvents(readPage, boundary, DEFAULT_STANDUP_WINDOW_MAX_EVENTS);
  assert.deepEqual(calls, [[undefined], ["cursor-1"]]);
  assert.equal(scan.pages, 2);
  assert.equal(scan.source, "authoritative_history");
  assert.equal(scan.capped, false);
  assert.equal(scan.totalEvents, 4);
  assert.equal(scan.windowEvents.length, 2);
  assert.deepEqual(scan.windowEvents.map((event) => event.item_id), ["item-2", "item-1"]);
  assert.equal(scan.lateEvents, 0);
  assert.equal(scan.workspaceEvents, 0);
  assert.deepEqual(scan.maxOffsets, new Map([["_workspace", 0], ["item-1", 2], ["item-2", 1]]));
  assert.deepEqual(scan.lastEvent, { ts: "2026-10-27T13:30:00.000Z", stream_id: "item-1", stream_offset: 2 });
  assert.equal(scan.nextCursor, "cursor-2");
});

test("the scan counts backdated late events, workspace events, and empty journals", async () => {
  const boundary = boundaryAt("2026-10-27T12:00:00.000Z", "item-1", 2, { "item-1": 2 });
  const readPage = async (): Promise<MutationEventPage> => page([
    eventAt("item-1", 4, "2020-01-01T00:00:00.000Z"),
    eventAt("_workspace", 5, "2026-10-27T12:30:00.000Z", "settings:write"),
  ], false, "cursor-late");
  const scan = await scanStandupWindowEvents(readPage, boundary, DEFAULT_STANDUP_WINDOW_MAX_EVENTS);
  assert.equal(scan.lateEvents, 1);
  assert.equal(scan.workspaceEvents, 1);
  assert.equal(scan.windowEvents.length, 2);
  const empty = await scanStandupWindowEvents(async () => page([], false), null, DEFAULT_STANDUP_WINDOW_MAX_EVENTS);
  assert.equal(empty.totalEvents, 0);
  assert.equal(empty.windowEvents.length, 0);
  assert.equal(empty.lastEvent, null);
  assert.equal(empty.nextCursor, null);
  const first = await scanStandupWindowEvents(async () => page([eventAt("item-1", 1, "2026-10-27T09:00:00.000Z")], false, "cursor-first"), null, DEFAULT_STANDUP_WINDOW_MAX_EVENTS);
  assert.equal(first.windowEvents.length, 1);
  assert.equal(first.lateEvents, 0);
});

test("the scan stops at the window cap and reports it, and refuses cursorless continuation pages", async () => {
  const boundary = boundaryAt("2026-10-27T12:00:00.000Z", "item-1", 0, { "item-1": 0 });
  const readPage = async (since?: string): Promise<MutationEventPage> => {
    if (since === undefined) return page([eventAt("item-1", 1, "2026-10-27T13:00:00.000Z")], true, "cursor-1");
    if (since === "cursor-1") return page([eventAt("item-1", 2, "2026-10-27T14:00:00.000Z")], true, "cursor-2");
    if (since === "cursor-2") return page([eventAt("item-1", 3, "2026-10-27T15:00:00.000Z")], false, "cursor-3");
    throw new Error("unexpected page cursor");
  };
  const capped = await scanStandupWindowEvents(readPage, boundary, 2);
  assert.equal(capped.capped, true);
  assert.equal(capped.windowEvents.length, 3);
  assert.equal(capped.pages, 3);
  await assert.rejects(
    scanStandupWindowEvents(async () => page([eventAt("item-9", 1, "2026-10-27T13:00:00.000Z")], true), null, DEFAULT_STANDUP_WINDOW_MAX_EVENTS),
    (error: unknown) => isWindowRefusal(error, "window_page_cursor_missing") && error.exitCode === 1,
  );
});

test("a non-final page that reaches exactly the cap keeps scanning covered pages and is not capped", async () => {
  const boundary = boundaryAt("2026-10-27T12:00:00.000Z", "item-1", 2, { "item-1": 2 });
  const readPage = async (since?: string): Promise<MutationEventPage> => {
    if (since === undefined) return page([eventAt("item-2", 1, "2026-10-27T13:00:00.000Z"), eventAt("item-2", 2, "2026-10-27T14:00:00.000Z")], true, "cursor-1");
    // Only events the boundary already covers follow, so the window holds exactly the cap.
    if (since === "cursor-1") return page([eventAt("item-1", 1, "2026-10-27T10:00:00.000Z"), eventAt("item-1", 3, "2026-10-27T11:00:00.000Z")], false, "cursor-2");
    throw new Error("unexpected page cursor");
  };
  const scan = await scanStandupWindowEvents(readPage, boundary, 2);
  assert.equal(scan.capped, false);
  assert.equal(scan.windowEvents.length, 2);
  assert.equal(scan.pages, 2);
  assert.equal(scan.nextCursor, "cursor-2");
});

// ---------------------------------------------------------------------------
// Coverage certification and packet assembly
// ---------------------------------------------------------------------------

test("missing final-page or non-progressing cursor coverage refuses certification", async () => {
  for (const cursor of [undefined, ""]) {
    for (const hasMore of [false, true]) {
      await assert.rejects(scanStandupWindowEvents(async () => page([eventAt("item", 1, "2026-10-27T00:00:00Z")], hasMore, cursor), null, 100),
        (error: unknown) => isWindowRefusal(error, "window_page_cursor_missing"));
    }
  }
  await assert.rejects(scanStandupWindowEvents(async () => page([], true), null, 100),
    (error: unknown) => isWindowRefusal(error, "window_page_cursor_missing"));
  await assert.rejects(scanStandupWindowEvents(async () => page([], true, "same-cursor"), null, 100),
    (error: unknown) => isWindowRefusal(error, "window_page_cursor_missing"));
});

test("deletion certification considers every stream before bounding display receipts", () => {
  const events = Array.from({ length: 15 }, (_, index) => eventAt(`deleted-${index}`, 2, "2026-10-27T00:00:00Z", "delete"));
  assert.deepEqual(standupWindowUnknownStreams(events, new Set()), []);
  assert.equal(standupWindowDeletedStreams(events, new Set()).length, 10);
});

test("cursor coverage must account for the admitted event count and last position", () => {
  const boundary = boundaryAt("2026-10-27T00:00:00Z", "item", 0, { item: 0 });
  assert.equal(standupWindowHasCursorCoverage(null), true);
  assert.equal(standupWindowHasCursorCoverage(boundary), true);
  for (const change of [
    { cursor: null }, { admitted_events: 2 }, { last_stream_id: "missing" }, { last_stream_offset: 1 },
    { covered_streams: new Map([["item", Number.MAX_SAFE_INTEGER]]) },
  ]) assert.equal(standupWindowHasCursorCoverage({ ...boundary, ...change }), false);
});

test("lost cursor coverage is incomplete and never advanced", async () => {
  const fixture = await runtimeFixture();
  try {
    await runWindow(fixture, fixture.directory);
    const statePath = join(fixture.directory, "window-state.json");
    const snapshot = readStandupWindowBoundary(statePath);
    assert.ok(snapshot.boundary);
    const damaged = { ...snapshot.boundary, covered_streams: new Map<string, number>() };
    writeFileSync(statePath, serializeStandupWindowBoundary(damaged));
    const packet = await runWindow(fixture, fixture.directory);
    assert.equal(packet.window.incomplete, true);
    assert.deepEqual(packet.window.incomplete_reasons, ["cursor_coverage_missing"]);
    assert.equal(packet.window.admitted, false);
    assert.equal(readStandupWindowBoundary(statePath).bytes, serializeStandupWindowBoundary(damaged));
  } finally { await removeRuntimeFixture(fixture); }
});

test("coverage regressions report streams that shrank below the admitted boundary", async () => {
  const boundary = boundaryAt("2026-10-27T12:00:00.000Z", "item-1", 2, { "item-1": 2, "gone": 5 });
  const scan = await scanStandupWindowEvents(async () => page([eventAt("item-1", 3, "2026-10-27T11:00:00.000Z")], false, "c"), boundary, DEFAULT_STANDUP_WINDOW_MAX_EVENTS);
  assert.deepEqual(standupWindowCoverageRegressions(boundary, scan), ["gone"]);
  assert.deepEqual(standupWindowCoverageRegressions(null, scan), []);
  const intact = boundaryAt("2026-10-27T12:00:00.000Z", "item-1", 2, { "item-1": 1 });
  assert.deepEqual(standupWindowCoverageRegressions(intact, scan), []);
});

test("unknown and deleted streams are certified against the corpus", () => {
  const corpus = new Set(["item-1"]);
  const events = [
    eventAt("item-1", 3, "2026-10-27T13:00:00.000Z"),
    eventAt("_workspace", 2, "2026-10-27T13:00:00.000Z", "settings:write"),
    eventAt("ghost-1", 1, "2026-10-27T13:00:00.000Z"),
    eventAt("deleted-1", 9, "2026-10-27T13:00:00.000Z", "delete"),
    eventAt("deleted-1", 8, "2026-10-27T12:30:00.000Z", "update"),
  ];
  assert.deepEqual(standupWindowUnknownStreams(events, corpus), ["ghost-1"]);
  assert.deepEqual(standupWindowDeletedStreams(events, corpus), ["deleted-1"]);
  const unknown: MutationEvent[] = [];
  for (let index = 0; index < 14; index += 1) unknown.push(eventAt(`ghost-${index}`, 1, "2026-10-27T13:00:00.000Z"));
  assert.equal(standupWindowUnknownStreams(unknown, corpus).length, 10);
});

test("the packet maps the scan and sections into a deterministic compact shape", async () => {
  const boundary = boundaryAt("2026-10-27T12:00:00.000Z", "item-1", 2, { "item-1": 2 });
  const scan = await scanStandupWindowEvents(async () => page([
    eventAt("item-2", 2, "2026-10-27T13:00:00.000Z", "update"),
    eventAt("_workspace", 5, "2026-10-27T13:30:00.000Z", "settings:write"),
    eventAt("item-2", 3, "2026-10-27T14:00:00.000Z", "comment"),
  ], false, "cursor-next"), boundary, DEFAULT_STANDUP_WINDOW_MAX_EVENTS);
  const sections = {
    in_progress: [{ id: "item-2", title: "Rolling", status: "in_progress" }],
    blocked: [],
    done: [],
    up_next: [{ id: "item-3", title: "Queued", status: "open" }],
  };
  const packet = buildStandupWindowPacket({
    boundaryBefore: "prior", scan, sections,
    incompleteReasons: [], unknownStreams: ["ghost-1"], deletedStreams: ["deleted-1"], unsectionedStreams: ["canceled-1"], regressedStreams: [], admitted: true,
  });
  assert.deepEqual(packet, {
    window: {
      boundary_before: "prior",
      boundary_next: "cursor-next",
      events: 3,
      late_events: 0,
      workspace_events: 1,
      touched_items: 1,
      ops: ["comment", "settings:write", "update"],
      incomplete: false,
      incomplete_reasons: [],
      unknown_streams: ["ghost-1"],
      deleted_items: ["deleted-1"],
      unsectioned_items: ["canceled-1"],
      admitted: true,
    },
    sections,
  });
  const incomplete = buildStandupWindowPacket({
    boundaryBefore: null, scan, sections,
    incompleteReasons: ["event_cap_exceeded"], unknownStreams: [], deletedStreams: [], unsectionedStreams: [], regressedStreams: ["gone"], admitted: false,
  });
  assert.equal(incomplete.window.incomplete, true);
  assert.deepEqual(incomplete.window.incomplete_reasons, ["event_cap_exceeded"]);
  assert.deepEqual(incomplete.window.regressed_streams, ["gone"]);
  assert.equal("unknown_streams" in incomplete.window, false);
  assert.equal("deleted_items" in incomplete.window, false);
  assert.equal("unsectioned_items" in incomplete.window, false);
});

// ---------------------------------------------------------------------------
// Command behaviour on a real, non-git tracker
// ---------------------------------------------------------------------------

/** The window command result asserted as a packet. */
type WindowResult = StandupWindowPacket;

/** Run the real registered window command with a cursor file inside a disposable directory. */
async function runWindow(
  fixture: RuntimeFixture,
  directory: string,
  options: Record<string, unknown> = {}
): Promise<WindowResult> {
  return runtimeCommand(fixture, "standup window", {
    "cursor-file": join(directory, "window-state.json"),
    output: join(directory, "delivered-packet.json"),
    ...options,
  }) as unknown as Promise<WindowResult>;
}

test("the first window covers the whole journal and admits the exact next boundary", async () => {
  const fixture = await runtimeFixture();
  try {
    const first = await runWindow(fixture, fixture.directory);
    // Fixture: 5 item creates, 1 close, plus the init settings write = 7 events.
    assert.equal(first.window.events, 7);
    assert.equal(first.window.late_events, 0);
    assert.equal(first.window.workspace_events, 1);
    assert.equal(first.window.touched_items, 5);
    assert.equal(first.window.boundary_before, null);
    assert.ok(typeof first.window.boundary_next === "string");
    assert.deepEqual(first.window.incomplete_reasons, []);
    assert.equal(first.window.incomplete, false);
    assert.equal(first.window.admitted, true);
    assert.deepEqual(first.window.ops, ["close", "create", "settings:write"]);
    assert.equal(first.sections.in_progress.map((row) => row.id).length, 1);
    assert.equal(first.sections.blocked.length, 1);
    assert.equal(first.sections.done.length, 1);
    const state = readStandupWindowBoundary(join(fixture.directory, "window-state.json"));
    assert.equal(state.boundary?.cursor, first.window.boundary_next);
    assert.equal(state.boundary?.admitted_events, 7);
    assert.equal(state.boundary?.covered_streams.get("_workspace"), 0);
    // A restart with no new work renders an empty window and retains nothing new.
    const second = await runWindow(fixture, fixture.directory);
    assert.equal(second.window.events, 0);
    assert.equal(second.window.admitted, false);
    assert.equal(second.window.boundary_before, first.window.boundary_next);
    assert.equal(second.window.boundary_next, first.window.boundary_next);
    assert.deepEqual(readStandupWindowBoundary(join(fixture.directory, "window-state.json")).bytes, state.bytes);
  } finally {
    await removeRuntimeFixture(fixture);
  }
});

test("a restart reproduces the same packet until the boundary is admitted", async () => {
  const fixture = await runtimeFixture();
  try {
    const stdoutA = await runWindow(fixture, fixture.directory, { output: undefined });
    const stdoutB = await runWindow(fixture, fixture.directory, { output: undefined });
    assert.deepEqual(stdoutA, stdoutB, "stdout rendering cannot advance before the host emits it");
    assert.equal(stdoutA.window.admitted, false);
    const previewA = await runWindow(fixture, fixture.directory, { "no-advance": true });
    const previewB = await runWindow(fixture, fixture.directory, { "no-advance": true });
    assert.deepEqual(previewB, previewA);
    assert.equal(existsSync(join(fixture.directory, "window-state.json")), false);
    const admitted = await runWindow(fixture, fixture.directory);
    assert.equal(admitted.window.events, previewA.window.events);
    assert.equal(admitted.window.boundary_next, previewA.window.boundary_next);
    assert.deepEqual(admitted.sections, previewA.sections);
    assert.equal(admitted.window.admitted, true);
    // Crash simulation: replay the same window from a copy of the prior state.
    const statePath = join(fixture.directory, "window-state.json");
    const priorBytes = readFileSync(statePath, "utf8");
    const replayCopy = join(fixture.directory, "window-state-copy.json");
    const newWork = await fixture.client.create({ title: "Post-admission work", type: "Task" });
    const windowWithNewWork = await runWindow(fixture, fixture.directory);
    assert.equal(windowWithNewWork.window.events, 1);
    writeFileSync(replayCopy, priorBytes, "utf8");
    const replayed = await runtimeCommand(fixture, "standup window", { "cursor-file": replayCopy, output: join(fixture.directory, "replayed-packet.json") }) as unknown as WindowResult;
    assert.deepEqual(replayed, windowWithNewWork, "the entire replayed packet is identical");
    assert.equal(replayed.window.events, 1);
    assert.equal(replayed.window.boundary_before, windowWithNewWork.window.boundary_before);
    assert.equal(replayed.window.boundary_next, windowWithNewWork.window.boundary_next);
    assert.deepEqual(replayed.sections, windowWithNewWork.sections);
    assert.deepEqual(replayed.window.ops, windowWithNewWork.window.ops);
    assert.equal(replayed.window.admitted, true);
    assert.ok(newWork.item.id.length > 0);
  } finally {
    await removeRuntimeFixture(fixture);
  }
});

test("a late backdated append appears exactly once in the next admitted window", async () => {
  const fixture = await runtimeFixture();
  try {
    await runWindow(fixture, fixture.directory);
    const target = fixture.items.find((item) => item.status === "in_progress")?.id;
    assert.ok(target, "the fixture must contain an in-progress item");
    const lateEntry = await appendBackdatedEvent(fixture, target, "2020-01-01T00:00:00.000Z");
    assert.ok(lateEntry);
    const window = await runWindow(fixture, fixture.directory);
    assert.equal(window.window.events, 1);
    assert.equal(window.window.late_events, 1);
    assert.equal(window.window.touched_items, 1);
    assert.equal(window.sections.in_progress.map((row) => row.id).includes(target), true);
    assert.equal(window.window.admitted, true);
    const again = await runWindow(fixture, fixture.directory);
    assert.equal(again.window.events, 0, "the late append must appear exactly once");
    assert.equal(again.window.admitted, false);
  } finally {
    await removeRuntimeFixture(fixture);
  }
});

test("a window lists every touched open item and names touched items no section shows", async () => {
  const fixture = await runtimeFixture();
  try {
    await runWindow(fixture, fixture.directory);
    const open: string[] = [];
    for (let index = 0; index < 5; index += 1) open.push((await fixture.client.create({ title: `Open window work ${index}`, type: "Task", priority: index })).item.id);
    const canceled = (await fixture.client.create({ title: "Dropped window work", type: "Task", status: "canceled" })).item.id;
    const window = await runWindow(fixture, fixture.directory);
    assert.deepEqual(window.sections.up_next.map((row) => row.id), open, "every touched open item is listed, in priority order");
    assert.deepEqual(window.window.unsectioned_items, [canceled]);
    assert.equal(window.window.touched_items, 6);
    assert.equal(window.window.admitted, true);
  } finally {
    await removeRuntimeFixture(fixture);
  }
});

test("an item deletion is reported as deleted work, and lost history coverage marks the report incomplete", async () => {
  const fixture = await runtimeFixture();
  try {
    await runWindow(fixture, fixture.directory);
    const doomed = await fixture.client.create({ title: "Doomed work", type: "Task" });
    await fixture.client.run("delete", { id: doomed.item.id });
    const deleted = await runWindow(fixture, fixture.directory);
    assert.equal(deleted.window.events, 2);
    assert.deepEqual(deleted.window.deleted_items, [doomed.item.id]);
    assert.deepEqual(deleted.window.incomplete_reasons, []);
    assert.deepEqual(deleted.window.ops, ["create", "delete"]);
    assert.equal(deleted.window.touched_items, 1);
    assert.equal(deleted.window.admitted, true);
    // Losing an admitted stream's history and item together is missing coverage:
    // the report must be incomplete and must not admit the boundary.
    const admitted = await runWindow(fixture, fixture.directory);
    assert.equal(admitted.window.events, 0);
    const survivor = fixture.items.find((item) => item.type === "Task")?.id;
    assert.ok(survivor, "the fixture must contain a task item");
    rmSync(getHistoryPath(fixture.pmRoot, survivor));
    rmSync(join(fixture.pmRoot, "tasks", `${survivor}.toon`), { force: true });
    const missing = await runWindow(fixture, fixture.directory);
    assert.equal(missing.window.incomplete, true);
    assert.deepEqual(missing.window.incomplete_reasons, ["history_regression"]);
    assert.deepEqual(missing.window.regressed_streams, [survivor]);
    assert.equal(missing.window.admitted, false);
  } finally {
    await removeRuntimeFixture(fixture);
  }
});

test("an event naming an unknown stream marks the report incomplete without admitting", async () => {
  const fixture = await runtimeFixture();
  try {
    await runWindow(fixture, fixture.directory);
    const ghostDoc: ItemDocument = {
      metadata: { id: "ghost-9", title: "Ghost", description: "", type: "Task", status: "open", priority: 2, tags: [], created_at: "2026-10-27T00:00:00.000Z", updated_at: "2026-10-27T00:00:00.000Z", author: "window-fixture" },
      body: "",
    };
    const entry = createHistoryEntry({ nowIso: "2026-10-27T09:00:00.000Z", author: "window-fixture", op: "create", before: emptyImportedDocument(), after: ghostDoc, message: "orphan stream event" });
    await appendHistoryEntry(getHistoryPath(fixture.pmRoot, "ghost-9"), entry);
    const window = await runWindow(fixture, fixture.directory);
    assert.equal(window.window.events, 1);
    assert.equal(window.window.incomplete, true);
    assert.deepEqual(window.window.incomplete_reasons, ["unknown_event_stream"]);
    assert.deepEqual(window.window.unknown_streams, ["ghost-9"]);
    assert.equal(window.window.admitted, false);
  } finally {
    await removeRuntimeFixture(fixture);
  }
});

test("the window cap reports an incomplete window that is never admitted", async () => {
  const fixture = await runtimeFixture();
  try {
    const capped = await runWindow(fixture, fixture.directory, { "max-events": "1" });
    assert.equal(capped.window.incomplete, true);
    assert.deepEqual(capped.window.incomplete_reasons, ["event_cap_exceeded"]);
    assert.equal(capped.window.admitted, false);
    assert.equal(existsSync(join(fixture.directory, "window-state.json")), false);
    const recovered = await runWindow(fixture, fixture.directory);
    assert.equal(recovered.window.incomplete, false);
    assert.equal(recovered.window.admitted, true);
  } finally {
    await removeRuntimeFixture(fixture);
  }
});

test("durable delivery writes the packet before admitting and reports contention honestly", async () => {
  const fixture = await runtimeFixture();
  try {
    const outputPath = join(fixture.directory, "window-packet.json");
    const first = await runWindow(fixture, fixture.directory, { output: outputPath });
    const written = JSON.parse(readFileSync(outputPath, "utf8")) as unknown as WindowResult;
    assert.deepEqual(written, first);
    // A peer holds the admission lease for this cursor file across the whole
    // run: the packet is complete, but admission must report the peer honestly
    // instead of blocking or silently claiming the boundary.
    const newWork = await fixture.client.create({ title: "Peer work", type: "Task" });
    const statePath = join(fixture.directory, "window-state.json");
    const release = await acquireLock(fixture.pmRoot, standupWindowLockId(statePath), 60, "peer-reporter", false, true, 0);
    try {
      const contended = await runWindow(fixture, fixture.directory, { output: outputPath });
      assert.equal(contended.window.incomplete, true);
      assert.deepEqual(contended.window.incomplete_reasons, ["window_contended"]);
      assert.equal(contended.window.admitted, false);
      assert.equal(contended.window.events, 1);
      const rewritten = JSON.parse(readFileSync(outputPath, "utf8")) as unknown as WindowResult;
      assert.deepEqual(rewritten, written, "a contending reporter cannot overwrite the admitted packet");
    } finally {
      await release();
    }
    assert.ok(newWork.item.id);
  } finally {
    await removeRuntimeFixture(fixture);
  }
});

test("empty and preview reporters preserve peer output while the cursor lease is held", async () => {
  const fixture = await runtimeFixture();
  const output = join(fixture.directory, "shared-packet.json");
  try {
    await runWindow(fixture, fixture.directory, { output });
    const delivered = readFileSync(output, "utf8");
    const release = await acquireLock(fixture.pmRoot, standupWindowLockId(join(fixture.directory, "window-state.json")), 60, "peer", false, true, 0);
    try {
      for (const options of [{}, { "no-advance": true }]) {
        const packet = await runWindow(fixture, fixture.directory, { output, ...options });
        assert.equal(packet.window.incomplete, true);
        assert.deepEqual(packet.window.incomplete_reasons, ["window_contended"]);
        assert.equal(readFileSync(output, "utf8"), delivered);
      }
    } finally { await release(); }
  } finally { await removeRuntimeFixture(fixture); }
});

test("delivery failure retains the old boundary and crash replay preserves the delivered packet", { skip: cannotEnforceModes }, async () => {
  const fixture = await runtimeFixture();
  const stateDirectory = join(fixture.directory, "state");
  mkdirSync(stateDirectory);
  const statePath = join(stateDirectory, "cursor.json");
  const output = join(fixture.directory, "crash-packet.json");
  try {
    chmodSync(stateDirectory, 0o500);
    try {
      await assert.rejects(runWindow(fixture, fixture.directory, { "cursor-file": statePath, output }),
        (error: unknown) => isWindowRefusal(error, "window_state_write_failed"));
      assert.equal(existsSync(statePath), false);
    } finally { chmodSync(stateDirectory, 0o700); }
    const delivered = JSON.parse(readFileSync(output, "utf8"));
    const recovered = await runWindow(fixture, fixture.directory, { "cursor-file": statePath, output });
    assert.deepEqual(recovered, delivered, "restart after delivery but before admission reproduces every packet field");
    const blocker = join(fixture.directory, "not-a-directory");
    writeFileSync(blocker, "blocking output parent");
    const before = readStandupWindowBoundary(statePath).bytes;
    await fixture.client.create({ title: "Work after recovery", type: "Task" });
    await assert.rejects(runWindow(fixture, fixture.directory, { "cursor-file": statePath, output: join(blocker, "packet.json") }), /could not write/);
    assert.equal(readStandupWindowBoundary(statePath).bytes, before);
    await assert.rejects(runWindow(fixture, fixture.directory, { "no-advance": true, output: join(blocker, "preview.json") }), /could not write/);
  } finally {
    chmodSync(stateDirectory, 0o700);
    await removeRuntimeFixture(fixture);
  }
});

test("a peer at the delivery boundary cannot admit or release the owning reporter lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-window-interleave-"));
  const path = join(directory, "cursor.json");
  const snapshot = { boundary: null, bytes: "" };
  const boundary = boundaryAt("2026-10-27T00:00:00Z", "item", 0, { item: 0 });
  const lock = { pmRoot: directory, owner: "reporter", waitMs: 0 };
  try {
    const result = await admitStandupWindowBoundary(path, snapshot, boundary, lock, async () => {
      assert.equal(existsSync(path), false, "delivery precedes boundary retention");
      for (let step = 0; step < 2; step += 1) {
        const peer = await admitStandupWindowBoundary(path, snapshot, boundary, { ...lock, owner: "peer" });
        assert.equal(peer.admitted, false);
      }
    });
    assert.equal(result.admitted, true);
    const fresh = readStandupWindowBoundary(path);
    await assert.rejects(admitStandupWindowBoundary(path, fresh, boundary, lock, async () => { throw new Error("delivery interrupted"); }), /delivery interrupted/);
    assert.equal(readStandupWindowBoundary(path).bytes, fresh.bytes);
    assert.equal((await admitStandupWindowBoundary(path, fresh, boundary, lock)).admitted, true, "failure releases the owner's lease last");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the command refuses typed input errors and needs no git executable", async () => {
  const fixture = await runtimeFixture();
  const originalEnvironment = { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES };
  try {
    process.env.PATH = fixture.directory;
    process.env.GIT_CEILING_DIRECTORIES = dirname(fixture.directory);
    await assert.rejects(runtimeCommand(fixture, "standup window", {}), (error: unknown) =>
      isWindowRefusal(error, "window_cursor_file_missing") && error.exitCode === 2);
    const collision = join(fixture.directory, "collision.json");
    await assert.rejects(runWindow(fixture, fixture.directory, { "cursor-file": collision, output: collision }),
      (error: unknown) => isWindowRefusal(error, "window_output_conflict"));
    assert.equal(existsSync(collision), false);
    const statePath = join(fixture.directory, "broken-state.json");
    writeFileSync(statePath, "{oops", "utf8");
    await assert.rejects(runtimeCommand(fixture, "standup window", { "cursor-file": statePath }), (error: unknown) =>
      isWindowRefusal(error, "window_state_unreadable"));
    await assert.rejects(runtimeCommand(fixture, "standup window", { "cursor-file": join(fixture.directory, "ok.json"), "max-events": "0" }), (error: unknown) =>
      isWindowRefusal(error, "window_max_events_invalid"));
    for (const raw of ["", "  ", null, 2, []]) {
      await assert.rejects(runWindow(fixture, fixture.directory, { maxEvents: raw }),
        (error: unknown) => isWindowRefusal(error, "window_max_events_invalid"));
    }
    // With git unreachable the window still renders, admits, and re-renders empty.
    const first = await runWindow(fixture, fixture.directory);
    assert.equal(first.window.admitted, true);
    const second = await runWindow(fixture, fixture.directory);
    assert.equal(second.window.events, 0);
  } finally {
    for (const key of ["PATH", "GIT_CEILING_DIRECTORIES"] as const) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await removeRuntimeFixture(fixture);
  }
});

/**
 * Append a genuine late, backdated history event to a live item.
 *
 * Uses the SDK's own entry factory and appender so the record chain and the
 * current-document proof stay valid (`history verify` still passes): the
 * event is a real new offset on the stream with an old mutation timestamp —
 * exactly the late/backdated append a timestamp-only cursor would skip.
 *
 * @param fixture - The runtime fixture owning the tracker.
 * @param itemId - The item whose history stream grows.
 * @param nowIso - The backdated mutation timestamp to record.
 * @returns Whether the append completed.
 */
async function appendBackdatedEvent(fixture: RuntimeFixture, itemId: string, nowIso: string): Promise<boolean> {
  const located = await locateItem(fixture.pmRoot, itemId);
  assert.ok(located, "the item must exist for a backdated append");
  const { document } = await readLocatedItem(located);
  const entry = createHistoryEntry({
    nowIso, author: "window-fixture", op: "update",
    before: document, after: document, message: "late backdated append for window coverage",
  });
  await appendHistoryEntry(getHistoryPath(fixture.pmRoot, itemId), entry);
  return true;
}