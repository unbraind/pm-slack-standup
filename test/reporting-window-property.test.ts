import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendHistoryEntry, createHistoryEntry, getHistoryPath, isPmCliExpectedError,
  listMutationEvents, locateItem, readLocatedItem,
} from "@unbrained/pm-cli/sdk";
import type { StandupWindowPacket } from "../index.ts";
import type { MutationEvent } from "@unbrained/pm-cli/sdk";
import { runtimeCommand, runtimeFixture, removeRuntimeFixture } from "./runtime-fixture.ts";
import type { RuntimeFixture } from "./runtime-fixture.ts";

/**
 * Deterministic seeded PRNG (mulberry32) so every CI run replays the exact
 * same operation sequences, and a failure can be reproduced from the seed.
 *
 * @param seed - The 32-bit seed.
 * @returns A stateful random integer generator.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed seeds: one per property-test tracker, printed on failure paths. */
const SEED = 0x20261027;

/** Pick one element uniformly at random. */
function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length) % values.length];
}

/** Pick a small random integer in [min, max]. */
function pickInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/** Title fragments including unicode, punctuation, and whitespace shapes. */
const TITLES = [
  "Fix the parser", "修复解析器", "Ünïcode standup", "tabs\tand\tspaces", "  padded  ",
  "emoji 🚀 window", "quote's \"path\"", "back`tick", "CRLF\r\nin title", "long " + "x".repeat(80),
];

/** Body fragments covering CRLF, LF, trailing whitespace, and unicode variants. */
const BODIES = [
  "line one\r\nline two\r\n", "single line\n", "  leading and trailing  ", "日本語の本文",
  "mixed\r\nline\n\r\n", "", "🧪 test body with \r\n windows", "a\r\n\r\nb",
];

/** Custom lifecycle statuses the property run registers, by role. */
const CUSTOM_STATUSES = [
  { name: "review", role: ["active"], alias: ["in-review"] },
  { name: "parked", role: ["blocked"], alias: ["on-park"] },
  { name: "landed", role: ["terminal", "terminal_done"], alias: ["shipped"] },
  { name: "abandoned", role: ["terminal", "terminal_canceled"], alias: ["dropped"] },
] as const;

/** Default lifecycle statuses random updates draw from (plus customs). */
const DEFAULT_STATUSES = ["open", "in_progress", "blocked"];

/** One window packet result as produced by the registered command. */
type WindowPacket = StandupWindowPacket;

/**
 * Read the whole journal through the SDK, paging to the end.
 *
 * @param pmRoot - Tracker root to read.
 * @returns Every committed mutation event, in canonical journal order.
 */
async function readAllEvents(pmRoot: string): Promise<MutationEvent[]> {
  const events: MutationEvent[] = [];
  let since: string | undefined;
  for (;;) {
    const page = await listMutationEvents({ pmRoot, since, limit: 1000 });
    events.push(...page.events);
    if (!page.has_more || page.next_cursor === undefined) return events;
    since = page.next_cursor;
  }
}

/**
 * The reference model: journal events observed through the SDK, the events
 * still pending a window admission, and the retained-boundary chain.
 *
 * The model predicts window membership by APPEND ORDER (everything the journal
 * gained since the last admission), which is independent of the package's
 * position-or-latness partition: if the implementation ever skipped or
 * double-counted work, these assertions fail. New events are identified by
 * their exact (stream, version) identity, never by comparing against a
 * running maximum: a backdated append carries a high version but sorts early
 * by timestamp, so a max-based diff would silently swallow the forward events
 * that follow it.
 */
class WindowModel {
  /** Every (stream, version) event identity ever observed through the SDK. */
  seen = new Set<string>();
  /** Journal events observed since the last admitted window. */
  pending: MutationEvent[] = [];
  /** Backdated appends among the pending events (minimum late-event bound). */
  pendingBackdated = 0;
  /** Sum of admitted window event counts; must equal the journal at the end. */
  admittedTotal = 0;
  /** The boundary_next of the last admitted packet (chain continuity oracle). */
  lastBoundaryNext: string | null = null;
  /** Whether any window has been admitted yet (boundary_before chain start). */
  anyAdmission = false;

  /**
   * Absorb a fresh full-journal SDK read: classify unseen events as pending.
   *
   * @param events - Every event currently in the journal.
   */
  refresh(events: readonly MutationEvent[]): void {
    for (const event of events) {
      const key = `${event.item_id}:${event.version}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.pending.push(event);
    }
  }

  /** Restore the reference pending tail while replaying a crash boundary. */
  restorePending(events: readonly MutationEvent[], backdated: number, cursor: string | null): void {
    this.pending = [...events];
    this.pendingBackdated = backdated;
    this.lastBoundaryNext = cursor;
  }

  /** The distinct non-workspace streams among the pending events. */
  pendingTouchedStreams(): Set<string> {
    return new Set(this.pending.filter((event) => event.item_id !== "_workspace").map((event) => event.item_id));
  }

  /** The pending delete-event streams, as the packet must report them. */
  pendingDeletedStreams(corpusIds: ReadonlySet<string>): string[] {
    const deleted = new Set<string>();
    for (const event of this.pending) {
      if (event.type === "delete" && event.item_id !== "_workspace" && !corpusIds.has(event.item_id)) {
        deleted.add(event.item_id);
      }
    }
    return [...deleted].sort();
  }

  /**
   * Record one admitted window and verify the chain against its packet.
   *
   * @param packet - The admitted window packet.
   * @param events - The full journal read at assertion time.
   */
  admit(packet: WindowPacket, events: readonly MutationEvent[]): void {
    this.admittedTotal += packet.window.events;
    this.pending = [];
    this.pendingBackdated = 0;
    this.lastBoundaryNext = packet.window.boundary_next;
    this.anyAdmission = true;
    assert.equal(this.admittedTotal + this.pending.length, events.length, "admitted windows plus the pending tail must partition the journal");
  }
}

/**
 * Append one genuine late, backdated history event with a valid chain.
 *
 * @param fixture - The runtime fixture owning the tracker.
 * @param itemId - The item whose history stream grows.
 * @param nowIso - The backdated mutation timestamp to record.
 */
async function appendBackdatedEvent(fixture: RuntimeFixture, itemId: string, nowIso: string): Promise<void> {
  const located = await locateItem(fixture.pmRoot, itemId);
  assert.ok(located, "the item must exist for a backdated append");
  const { document } = await readLocatedItem(located);
  const entry = createHistoryEntry({
    nowIso, author: "property-fixture", op: "update",
    before: document, after: document, message: "late backdated append",
  });
  await appendHistoryEntry(getHistoryPath(fixture.pmRoot, itemId), entry);
}

test("seeded model-based property: windows partition the journal with no skips or duplicates", async () => {
  const random = mulberry32(SEED);
  console.error(`property seed: ${SEED.toString(16)}`);
  const fixture = await runtimeFixture();
  const cursorFile = join(fixture.directory, "prop-window-state.json");
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(fixture.directory);
  const model = new WindowModel();
  /** The most recent update options, for replay-of-older-input operations. */
  let lastUpdate: { id: string; options: Record<string, unknown> } | undefined;
  const customStatuses: string[] = [];
  const createdIds: string[] = [];
  let deletesUsed = 0;
  let operations = 0;
  let windows = 0;
  try {
    model.refresh(await readAllEvents(fixture.pmRoot));

    /** Apply one random mutation through the real SDK client. */
    const applyRandomOperation = async (): Promise<void> => {
      const liveIds = createdIds.length > 0 ? createdIds : fixture.items.map((item) => item.id);
      const roll = random();
      const id = liveIds.length > 0 ? pick(random, liveIds) : undefined;
      try {
        if (roll < 0.13 && createdIds.length < 12) {
          const title = `${pick(random, TITLES)} #${operations}`;
          const status = customStatuses.length > 0 && random() < 0.3 ? pick(random, [...DEFAULT_STATUSES, ...customStatuses]) : pick(random, DEFAULT_STATUSES);
          const created = await fixture.client.create({
            title, type: pick(random, ["Task", "Issue", "Chore", "Feature"]), status,
            body: pick(random, BODIES), priority: pickInt(random, 1, 4),
            tags: pick(random, ["alpha,beta", "area:window", "spaced , tags", "solo"]),
            assignee: pick(random, ["alice", "bob", "carol"]),
            author: "property-fixture",
          });
          createdIds.push(created.item.id);
        } else if (id === undefined) {
          return;
        } else if (roll < 0.45) {
          const options: Record<string, unknown> = {
            title: `${pick(random, TITLES)} r${operations}`,
            body: pick(random, BODIES),
            status: pick(random, [...DEFAULT_STATUSES, ...customStatuses, "closed", "canceled"]),
            priority: pickInt(random, 1, 4),
            addTags: [pick(random, ["tag-one", "area:prop", "spaced  tag"])],
            removeTags: [pick(random, ["tag-one", "area:prop"])],
            assignee: pick(random, ["alice", "bob"]),
            message: `property update ${operations}`,
            deadline: pick(random, ["2026-12-01", "2027-01-15"]),
            author: "property-fixture",
          };
          await fixture.client.update(id, options);
          lastUpdate = { id, options };
        } else if (roll < 0.55) {
          await fixture.client.comments(id, { add: `${pick(random, BODIES)} (comment ${operations})` });
        } else if (roll < 0.63) {
          await fixture.client.append(id, `${pick(random, BODIES)}\r\nappended ${operations}`);
        } else if (roll < 0.71) {
          await fixture.client.close(id, `property close ${operations}`);
        } else if (roll < 0.75) {
          await fixture.client.reopen(id, `property reopen ${operations}`);
        } else if (roll < 0.81) {
          const target = pick(random, liveIds);
          await fixture.client.update(id, { dep: [`id=${target},kind=blocked_by`], author: "property-fixture" });
        } else if (roll < 0.85 && customStatuses.length < CUSTOM_STATUSES.length) {
          const custom = CUSTOM_STATUSES[customStatuses.length];
          if (custom !== undefined) {
            await fixture.client.schemaAddStatus(custom.name, { role: [...custom.role], alias: [...custom.alias] });
            customStatuses.push(custom.name);
          }
        } else if (roll < 0.93) {
          await appendBackdatedEvent(fixture, id, `20${pickInt(random, 10, 19)}-01-01T00:00:00.000Z`);
          model.pendingBackdated += 1;
        } else if (roll < 0.95 && deletesUsed < 2 && createdIds.length > 4) {
          await fixture.client.run("delete", { id });
          createdIds.splice(createdIds.indexOf(id), 1);
          deletesUsed += 1;
        } else if (lastUpdate !== undefined) {
          // Replay of an older input: re-applying a previous update verbatim is
          // idempotent or appends; the SDK read-back decides, never the model.
          await fixture.client.update(lastUpdate.id, lastUpdate.options);
        }
      } catch (error) {
        // A legitimately refused random operation (guards, ownership, invalid
        // state) is part of the input space: the SDK diff is the only truth.
        if (!isPmCliExpectedError(error)) throw error;
      }
    };

    /** Build one window through the real command and verify it against the model. */
    const buildWindow = async (options: Record<string, unknown> = {}): Promise<WindowPacket> => {
      const events = await readAllEvents(fixture.pmRoot);
      model.refresh(events);
      const packet = await runtimeCommand(fixture, "standup window", { "cursor-file": cursorFile, output: join(fixture.directory, "property-packet.json"), ...options }) as unknown as WindowPacket;
      windows += 1;
      const touched = model.pendingTouchedStreams();
      const corpus = new Map((await fixture.client.listAllComplete({ includeBody: false })).items.map(
        (item: { id: string; title?: unknown; status?: unknown }) => [item.id, { title: item.title, status: item.status }] as const,
      ));
      // Membership oracle: the window is exactly the journal growth since the last admission.
      assert.equal(packet.window.events, model.pending.length, "window events must equal the journal growth since the last admission");
      assert.equal(packet.window.touched_items, touched.size, "touched items must equal the distinct new streams");
      assert.equal(packet.window.workspace_events,
        model.pending.filter((event) => event.item_id === "_workspace").length, "workspace events must match the journal growth");
      assert.ok(!model.anyAdmission || packet.window.late_events >= model.pendingBackdated,
        "every backdated append must be counted as late once a boundary exists");
      assert.equal(packet.window.incomplete, false, "a seeded model window must certify coverage");
      assert.deepEqual(packet.window.incomplete_reasons, [], "no seeded model window may be incomplete");
      assert.equal("unknown_streams" in packet.window, false, "every model event stream is certified");
      assert.equal("regressed_streams" in packet.window, false, "no model history regresses");
      assert.deepEqual(packet.window.deleted_items ?? [], model.pendingDeletedStreams(new Set(corpus.keys())), "deletions must be reported by stream");
      // Chain continuity: a missing report is detectable from the boundary chain.
      assert.equal(packet.window.boundary_before, model.lastBoundaryNext, "windows must chain boundary_next to boundary_before");
      // Read-back: every section row matches the SDK's certified corpus.
      for (const rows of Object.values(packet.sections)) {
        for (const row of rows) {
          const corpusRow = corpus.get(row.id);
          assert.ok(corpusRow, `section row ${row.id} must exist in the corpus`);
          assert.equal(row.title, corpusRow.title, `section row ${row.id} title must match the corpus`);
          assert.equal(row.status, corpusRow.status, `section row ${row.id} status must match the corpus`);
        }
      }
      return packet;
    };

    /** Assert the just-admitted boundary claims exactly the journal it read. */
    const assertRetainedCoverage = async (): Promise<void> => {
      const stateBytes = readFileSync(cursorFile, "utf8");
      const state = JSON.parse(stateBytes) as { boundary: { covered_streams: Record<string, number>; admitted_events: number } };
      const events = await readAllEvents(fixture.pmRoot);
      const expected = new Map<string, number>();
      for (const event of events) {
        expected.set(event.item_id, Math.max(expected.get(event.item_id) ?? -1, event.version - 1));
      }
      assert.deepEqual(new Map(Object.entries(state.boundary.covered_streams)), expected,
        "the retained coverage must equal the journal's per-stream offsets");
      assert.equal(state.boundary.admitted_events, events.length, "the retained event total must equal the journal");
    };

    for (let iteration = 0; iteration < 150; iteration += 1) {
      const batch = pickInt(random, 2, 5);
      for (let op = 0; op < batch; op += 1) {
        await applyRandomOperation();
        operations += 1;
      }
      model.refresh(await readAllEvents(fixture.pmRoot));
      if (iteration % 8 === 7) {
        if (random() < 0.3) {
          // Crash before admission: a preview run must not retain anything.
          const previewA = await buildWindow({ "no-advance": true });
          const previewB = await buildWindow({ "no-advance": true });
          assert.deepEqual(previewB, previewA, "restart after rendering must reproduce the same packet");
        } else if (random() < 0.35 && model.anyAdmission) {
          // Crash between rendering and admission: restoring the prior boundary
          // must re-render the same packet byte for byte.
          const priorBytes = readFileSync(cursorFile, "utf8");
          const priorBoundaryNext = model.lastBoundaryNext;
          const pendingBefore = [...model.pending];
          const backdatedBefore = model.pendingBackdated;
          const first = await buildWindow();
          assert.equal(first.window.admitted, pendingBefore.length > 0, "admission follows a non-empty window");
          if (first.window.admitted) model.admit(first, await readAllEvents(fixture.pmRoot));
          writeFileSync(cursorFile, priorBytes, "utf8");
          model.restorePending(pendingBefore, backdatedBefore, priorBoundaryNext);
          const replayed = await buildWindow();
          assert.deepEqual(replayed, first, "replaying from the pre-admission boundary must reproduce the packet");
          // The replay admitted the same coverage again; the model keeps the
          // single admission and the chain continues from the first packet.
          model.restorePending([], 0, first.window.boundary_next);
          await assertRetainedCoverage();
        } else {
          const packet = await buildWindow();
          assert.equal(packet.window.admitted, model.pending.length > 0, "admission follows a non-empty window");
          if (packet.window.admitted) {
            model.admit(packet, await readAllEvents(fixture.pmRoot));
            await assertRetainedCoverage();
          } else {
            assert.equal(packet.window.events, 0, "only an empty window may go unadmitted");
            assert.equal(packet.window.boundary_next, model.lastBoundaryNext, "an empty window keeps the boundary");
          }
        }
      }
    }

    // Final admission: every journal event lands in exactly one admitted window.
    const finalWindow = await buildWindow();
    if (finalWindow.window.admitted) model.admit(finalWindow, await readAllEvents(fixture.pmRoot));
    else assert.equal(model.pending.length, 0, "the final window must be empty when everything is admitted");
    const totalEvents = (await readAllEvents(fixture.pmRoot)).length;
    assert.equal(model.admittedTotal, totalEvents, "admitted windows must partition the journal exactly: no skips, no duplicates");
    assert.ok(operations >= 500, `the property run must apply at least 500 operations (applied ${operations})`);
    console.error(`property summary: ${operations} operations, ${windows} windows, ${totalEvents} events partitioned`);
  } finally {
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
    await removeRuntimeFixture(fixture);
  }
});