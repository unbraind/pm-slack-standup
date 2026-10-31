/**
 * Cursor-complete standup reporting windows.
 *
 * @module reporting-window
 *
 * A standup "window" is the set of tracker mutations appended since the last
 * admitted report. The boundary between two windows is certified from the
 * pm event journal (the same streams `pm history events` reads): it retains
 * the exact journal position of the last admitted event plus the highest
 * admitted offset of every history stream. Because admission records
 * per-stream coverage — not just a timestamp — a late or backdated append
 * (an event appended after the boundary with an older mutation timestamp)
 * still lands in the next window instead of being skipped forever, and a
 * crash between rendering and admission simply re-renders the same window.
 *
 * The boundary is persisted as a small JSON state file supplied by
 * `--cursor-file`; no second event journal is created. All event reads go
 * through the pm SDK's mutation-event reader, so the window inherits the
 * SDK's cursor framing, ordering, and integrity refusal behaviour.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { acquireLock, createPmCliExpectedError, EXIT_CODE, isPmCliExpectedError, writeFileAtomic, } from "@unbrained/pm-cli/sdk";
/** Operator remedies, keyed by {@link StandupWindowRefusalCode}. */
export const STANDUP_WINDOW_REFUSAL_REMEDIES = {
    window_output_conflict: "Choose an --output path different from --cursor-file.",
    window_cursor_file_missing: "Pass --cursor-file <path> naming where the retained boundary is stored.",
    window_max_events_invalid: "Pass --max-events as an integer from 1 to 1000000, or omit it for the default.",
    window_state_unreadable: "Restore the state file from the reporter that wrote it, or delete it to restart windows from the beginning (the next report then covers the whole journal once).",
    window_state_version_unsupported: "The state file was written by a newer pm-slack-standup; upgrade this package, or delete the file to restart windows from the beginning.",
    window_state_invalid_shape: "Restore the state file from the reporter that wrote it, or delete it to restart windows from the beginning (the next report then covers the whole journal once).",
    window_state_write_failed: "Check that the --cursor-file directory exists and is writable, then re-run; nothing was admitted.",
    window_page_cursor_missing: "The pm event stream ended a page without a resumption cursor; re-run the report. If it persists, inspect the tracker with `pm validate`.",
};
/**
 * Render one typed refusal as the operator-facing message.
 *
 * @param code - The refusal code.
 * @param detail - Concrete context for this occurrence.
 * @returns The full message including the code and its remedy.
 */
export function standupWindowRefusalMessage(code, detail) {
    return `Standup window refused (${code}): ${detail} Remedy: ${STANDUP_WINDOW_REFUSAL_REMEDIES[code]}`;
}
/**
 * Throw one typed standup-window refusal as a pm expected error.
 *
 * @param code - The refusal code; also carried in the error's `code` context.
 * @param detail - Concrete context for this occurrence.
 * @param exitCode - Process exit code for the refusal (USAGE for input
 *                   problems, GENERIC_FAILURE for environmental ones).
 */
export function refuseStandupWindow(code, detail, exitCode = EXIT_CODE.USAGE) {
    throw createPmCliExpectedError(standupWindowRefusalMessage(code, detail), {
        exitCode,
        context: { code },
    });
}
// ---------------------------------------------------------------------------
// Boundary state
// ---------------------------------------------------------------------------
/** State-file version this package writes and strictly accepts. */
export const STANDUP_WINDOW_STATE_VERSION = 1;
/** Byte-shape every retained opaque cursor must satisfy (SDK cursor framing). */
export const STANDUP_WINDOW_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/u;
/** Longest retained opaque cursor accepted (mirrors the SDK cursor bound). */
export const STANDUP_WINDOW_CURSOR_MAX_LENGTH = 4096;
/** Longest accepted history stream id (item ids are short slugs). */
export const STANDUP_WINDOW_STREAM_ID_MAX_LENGTH = 256;
/**
 * Whether a raw value is a plain JSON object (not null, not an array).
 *
 * @param value - The decoded state-file fragment to test.
 * @returns True for a plain object.
 */
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/**
 * Require a string field that is a parseable RFC-3339 timestamp.
 *
 * @param record - The object holding the field.
 * @param key - The field name.
 * @returns The trimmed timestamp string.
 */
function requireTimestamp(record, key) {
    const value = record[key];
    if (typeof value !== "string" || Number.isNaN(Date.parse(value.trim()))) {
        refuseStandupWindow("window_state_invalid_shape", `field ${key} must be a parseable ISO timestamp.`);
    }
    return value.trim();
}
/**
 * Require a history stream id field: non-empty, path-free, bounded.
 *
 * @param record - The object holding the field.
 * @param key - The field name.
 * @returns The stream id string.
 */
function requireStreamId(record, key) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0 || value.length > STANDUP_WINDOW_STREAM_ID_MAX_LENGTH
        || value.includes("/") || value.includes("\\") || value !== value.trim()) {
        refuseStandupWindow("window_state_invalid_shape", `field ${key} must be a non-empty stream id.`);
    }
    return value;
}
/**
 * Require a non-negative safe-integer field.
 *
 * @param record - The object holding the field.
 * @param key - The field name.
 * @returns The validated integer.
 */
function requireNonNegativeInteger(record, key) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        refuseStandupWindow("window_state_invalid_shape", `field ${key} must be a non-negative integer.`);
    }
    return value;
}
/**
 * Validate one decoded state file into a {@link StandupWindowBoundary}.
 *
 * Strict by design: the file is operator-owned input, everything earlier or
 * foreign is refused with a typed code rather than silently reinterpreted.
 *
 * @param parsed - The decoded JSON value of the state file.
 * @returns The validated boundary.
 */
export function parseStandupWindowBoundaryState(parsed) {
    if (!isRecord(parsed)) {
        refuseStandupWindow("window_state_invalid_shape", "the state file must contain a JSON object.");
    }
    const boundary = parsed.boundary;
    if (!isRecord(boundary)) {
        refuseStandupWindow("window_state_invalid_shape", "the state file must carry a `boundary` object.");
    }
    const cursor = boundary.cursor;
    if (cursor !== null) {
        if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > STANDUP_WINDOW_CURSOR_MAX_LENGTH
            || !STANDUP_WINDOW_CURSOR_PATTERN.test(cursor)) {
            refuseStandupWindow("window_state_invalid_shape", "boundary.cursor must be null or an opaque cursor token.");
        }
    }
    const covered = boundary.covered_streams;
    if (!isRecord(covered)) {
        refuseStandupWindow("window_state_invalid_shape", "boundary.covered_streams must be an object.");
    }
    const coveredStreams = new Map();
    for (const key of Object.keys(covered)) {
        const streamId = requireStreamId({ stream_id: key }, "stream_id");
        coveredStreams.set(streamId, requireNonNegativeInteger(covered, key));
    }
    return {
        cursor,
        last_ts: requireTimestamp(boundary, "last_ts"),
        last_stream_id: requireStreamId(boundary, "last_stream_id"),
        last_stream_offset: requireNonNegativeInteger(boundary, "last_stream_offset"),
        covered_streams: coveredStreams,
        admitted_events: requireNonNegativeInteger(boundary, "admitted_events"),
        admitted_at: requireTimestamp(boundary, "admitted_at"),
    };
}
/**
 * Serialize a boundary to the exact state-file JSON this package writes.
 *
 * @param boundary - The boundary to persist.
 * @returns The newline-terminated state-file bytes.
 */
export function serializeStandupWindowBoundary(boundary) {
    const coveredStreams = {};
    for (const [streamId, offset] of boundary.covered_streams)
        coveredStreams[streamId] = offset;
    return `${JSON.stringify({
        version: STANDUP_WINDOW_STATE_VERSION,
        boundary: {
            cursor: boundary.cursor,
            last_ts: boundary.last_ts,
            last_stream_id: boundary.last_stream_id,
            last_stream_offset: boundary.last_stream_offset,
            covered_streams: coveredStreams,
            admitted_events: boundary.admitted_events,
            admitted_at: boundary.admitted_at,
        },
    })}\n`;
}
/**
 * Read the retained boundary at window start.
 *
 * @param path - Absolute path of the `--cursor-file` state file.
 * @returns The parsed boundary (null when no file exists) and its exact bytes.
 */
export function readStandupWindowBoundary(path) {
    if (!existsSync(path))
        return { boundary: null, bytes: "" };
    let bytes;
    try {
        bytes = readFileSync(path, "utf8");
    }
    catch {
        refuseStandupWindow("window_state_unreadable", `the state file at ${path} could not be read.`, EXIT_CODE.GENERIC_FAILURE);
    }
    let parsed;
    try {
        parsed = JSON.parse(bytes);
    }
    catch {
        refuseStandupWindow("window_state_unreadable", `the state file at ${path} is not valid JSON.`);
    }
    if (!isRecord(parsed) || parsed.version !== STANDUP_WINDOW_STATE_VERSION) {
        refuseStandupWindow("window_state_version_unsupported", `the state file at ${path} does not declare version ${STANDUP_WINDOW_STATE_VERSION}.`);
    }
    return { boundary: parseStandupWindowBoundaryState(parsed), bytes };
}
/**
 * The tracker lock id serializing admissions for one cursor file.
 *
 * Derived from the resolved state-file path so two reporters sharing a cursor
 * file contend on the same lease even across processes.
 *
 * @param path - Absolute path of the `--cursor-file` state file.
 * @returns The fs-safe lock id.
 */
export function standupWindowLockId(path) {
    return `standup-window-cursor-${createHash("sha256").update(path).digest("hex").slice(0, 12)}`;
}
/**
 * Admit a new boundary: compare-and-set under the tracker's lock, then atomically replace the file.
 *
 * The state file is re-read inside the lease and compared byte-for-byte with
 * the {@link StandupWindowStateSnapshot} taken at window start, so a second
 * reporter that admitted its own window in the meantime is reported truthfully
 * instead of being overwritten.
 *
 * @param path - Absolute path of the `--cursor-file` state file.
 * @param snapshot - The state as this window read it at start.
 * @param boundary - The exact next boundary to retain.
 * @param lock - Tracker root used for the admission lease, plus its wait budget.
 * @param deliver - Optional packet delivery executed under the lease before retaining coverage.
 * @returns Whether the boundary was retained; a concurrent admission is
 *          reported as `{ admitted: false }`, never thrown.
 */
export async function admitStandupWindowBoundary(path, snapshot, boundary, lock, deliver) {
    const lockId = standupWindowLockId(path);
    let release;
    try {
        release = await acquireLock(lock.pmRoot, lockId, 60, lock.owner, false, true, lock.waitMs);
    }
    catch (error) {
        if (isPmCliExpectedError(error) && error.code === "lock_conflict") {
            return { admitted: false };
        }
        throw error;
    }
    try {
        const current = readStandupWindowBoundary(path);
        if (current.bytes !== snapshot.bytes)
            return { admitted: false };
        if (deliver)
            await deliver();
        try {
            await writeFileAtomic(path, serializeStandupWindowBoundary(boundary));
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            refuseStandupWindow("window_state_write_failed", `writing the state file at ${path} failed: ${reason}`, EXIT_CODE.GENERIC_FAILURE);
        }
        return { admitted: true };
    }
    finally {
        await release();
    }
}
/**
 * Compare two journal positions with the SDK's canonical mutation-event order.
 *
 * Order is (timestamp, stream id, stream offset) — exactly the order
 * `listMutationEvents` pages in and `encodeMutationEventCursor` resumes from,
 * so a boundary position computed here is interchangeable with an SDK cursor.
 *
 * @param left - First position.
 * @param right - Second position.
 * @returns Negative, zero, or positive as `left` sorts before, equal, or after.
 */
export function compareStandupWindowPositions(left, right) {
    return left.ts.localeCompare(right.ts)
        || left.stream_id.localeCompare(right.stream_id)
        || (left.stream_offset - right.stream_offset);
}
/**
 * Whether an event sorts strictly after the boundary's last admitted event.
 *
 * @param event - The event position to test.
 * @param boundary - The retained boundary (null means nothing admitted yet).
 * @returns True when the event is a forward append past the boundary.
 */
export function eventAfterBoundary(event, boundary) {
    if (boundary === null)
        return true;
    return compareStandupWindowPositions(event, {
        ts: boundary.last_ts,
        stream_id: boundary.last_stream_id,
        stream_offset: boundary.last_stream_offset,
    }) > 0;
}
/**
 * Whether an event belongs to the current window.
 *
 * An event is in the window when it either sorts after the boundary (a
 * forward append) or was appended to a stream beyond its admitted coverage
 * (a late or backdated append). Together the two rules partition the journal:
 * every event lands in exactly one admitted window, and none is skipped.
 *
 * @param event - The event position to test.
 * @param boundary - The retained boundary (null means nothing admitted yet).
 * @returns True when the event must appear in this window.
 */
export function eventInStandupWindow(event, boundary) {
    if (eventAfterBoundary(event, boundary))
        return true;
    if (boundary === null)
        return true;
    return event.stream_offset > (boundary.covered_streams.get(event.stream_id) ?? -1);
}
/**
 * Scan the whole mutation-event journal and partition it against a boundary.
 *
 * The scan pages through the SDK reader from the very beginning so late or
 * backdated appends are always observed; the retained cursor plus per-stream
 * coverage of the NEXT boundary come from the events actually seen, so an
 * admission never claims coverage it did not read.
 *
 * @param readPage - Bound SDK reader; called with the previous page's cursor.
 * @param boundary - The retained boundary (null when nothing is admitted yet).
 * @param maxEvents - Window cap; the scan stops and reports `capped` when exceeded.
 * @returns The partitioned scan result.
 */
export async function scanStandupWindowEvents(readPage, boundary, maxEvents) {
    const windowEvents = [];
    const maxOffsets = new Map();
    let lateEvents = 0;
    let workspaceEvents = 0;
    let totalEvents = 0;
    let lastEvent = null;
    let nextCursor = null;
    let capped = false;
    let source = "";
    let pages = 0;
    let since;
    for (;;) {
        const page = await readPage(since);
        pages += 1;
        source = page.source;
        for (const event of page.events) {
            const position = {
                ts: event.ts,
                stream_id: event.item_id,
                stream_offset: event.version - 1,
            };
            totalEvents += 1;
            const covered = maxOffsets.get(event.item_id) ?? -1;
            if (position.stream_offset > covered)
                maxOffsets.set(event.item_id, position.stream_offset);
            lastEvent = position;
            if (eventInStandupWindow(position, boundary)) {
                windowEvents.push(event);
                if (!eventAfterBoundary(position, boundary))
                    lateEvents += 1;
                if (event.item_id === "_workspace")
                    workspaceEvents += 1;
            }
        }
        nextCursor = page.next_cursor ?? nextCursor;
        if ((page.events.length > 0 || page.has_more)
            && (typeof page.next_cursor !== "string" || page.next_cursor.length === 0 || page.next_cursor === since)) {
            refuseStandupWindow("window_page_cursor_missing", `page ${pages} did not provide a progressing resumption cursor.`, EXIT_CODE.GENERIC_FAILURE);
        }
        if (!page.has_more && windowEvents.length <= maxEvents)
            break;
        if (windowEvents.length >= maxEvents) {
            capped = true;
            break;
        }
        since = page.next_cursor;
    }
    return {
        windowEvents, lateEvents, workspaceEvents, totalEvents,
        maxOffsets, lastEvent, nextCursor, capped, source, pages,
    };
}
// ---------------------------------------------------------------------------
// Coverage certification
// ---------------------------------------------------------------------------
/**
 * Verify retained cursor coverage accounts for every admitted event and its last position.
 * @param boundary - Retained boundary, or null before the first admission.
 * @returns Whether coverage is complete enough to certify another window.
 */
export function standupWindowHasCursorCoverage(boundary) {
    if (boundary === null)
        return true;
    const count = [...boundary.covered_streams.values()].reduce((total, offset) => total + offset + 1, 0);
    return boundary.cursor !== null && Number.isSafeInteger(count) && count === boundary.admitted_events
        && (boundary.covered_streams.get(boundary.last_stream_id) ?? -1) >= boundary.last_stream_offset;
}
/**
 * Streams whose history shrank below the admitted coverage.
 *
 * History is append-only, so an offset below the retained coverage means
 * events the boundary already certified have gone missing; the report is
 * marked incomplete rather than silently rendering a smaller window.
 *
 * @param boundary - The retained boundary.
 * @param scan - The fresh scan to compare against.
 * @returns The regressed stream ids, sorted.
 */
export function standupWindowCoverageRegressions(boundary, scan) {
    if (boundary === null)
        return [];
    const regressed = [];
    for (const [streamId, coveredOffset] of boundary.covered_streams) {
        if ((scan.maxOffsets.get(streamId) ?? -1) < coveredOffset)
            regressed.push(streamId);
    }
    return regressed.sort();
}
/**
 * Window event streams that no corpus item backs.
 *
 * A mutation naming a stream that the certified complete read does not carry
 * (and that is not the workspace stream) means coverage cannot be certified
 * for that work; the report is marked incomplete with the stream ids listed.
 * A stream whose window carries a `delete` event is NOT unknown: `pm delete`
 * removes the item while retaining its history stream, so the deletion itself
 * explains the missing corpus row (see {@link standupWindowDeletedStreams}).
 *
 * @param windowEvents - The events of this window.
 * @param corpusIds - Every item id in the certified complete read.
 * @returns The unknown stream ids, sorted and capped at ten entries.
 */
export function standupWindowUnknownStreams(windowEvents, corpusIds) {
    const deleted = new Set(windowEvents.filter((event) => event.type === "delete").map((event) => event.item_id));
    const unknown = new Set();
    for (const event of windowEvents) {
        if (event.item_id === "_workspace" || corpusIds.has(event.item_id) || deleted.has(event.item_id))
            continue;
        unknown.add(event.item_id);
    }
    return [...unknown].sort().slice(0, 10);
}
/**
 * Streams deleted in this window whose items the corpus can no longer carry.
 *
 * `pm delete` appends a `delete` history event and removes the item file, so
 * the packet surfaces the deletion by stream id instead of silently losing
 * the work from the report.
 *
 * @param windowEvents - The events of this window.
 * @param corpusIds - Every item id in the certified complete read.
 * @returns The deleted stream ids, sorted and capped at ten entries.
 */
export function standupWindowDeletedStreams(windowEvents, corpusIds) {
    const deleted = new Set();
    for (const event of windowEvents) {
        if (event.type === "delete" && event.item_id !== "_workspace" && !corpusIds.has(event.item_id)) {
            deleted.add(event.item_id);
        }
    }
    return [...deleted].sort().slice(0, 10);
}
/**
 * Assemble the window packet from a certified scan and bucketed rows.
 *
 * Pure: the same scan, reasons, and admission outcome always produce the same
 * packet bytes, which is what makes "restart after rendering" reproduce the
 * packet exactly.
 *
 * @param input - The scan, boundary cursors, section rows, reasons, and admission outcome.
 * @returns The assembled packet.
 */
export function buildStandupWindowPacket(input) {
    const ops = [...new Set(input.scan.windowEvents.map((event) => event.type))].sort();
    const info = {
        boundary_before: input.boundaryBefore,
        boundary_next: input.scan.nextCursor,
        events: input.scan.windowEvents.length,
        late_events: input.scan.lateEvents,
        workspace_events: input.scan.workspaceEvents,
        touched_items: new Set(input.scan.windowEvents
            .filter((event) => event.item_id !== "_workspace")
            .map((event) => event.item_id)).size,
        ops,
        incomplete: input.incompleteReasons.length > 0,
        incomplete_reasons: [...input.incompleteReasons],
        admitted: input.admitted,
    };
    if (input.unknownStreams.length > 0)
        info.unknown_streams = [...input.unknownStreams];
    if (input.deletedStreams.length > 0)
        info.deleted_items = [...input.deletedStreams];
    if (input.regressedStreams.length > 0)
        info.regressed_streams = [...input.regressedStreams];
    return {
        window: info,
        sections: {
            in_progress: [...input.sections.in_progress],
            blocked: [...input.sections.blocked],
            done: [...input.sections.done],
            up_next: [...input.sections.up_next],
        },
    };
}
// ---------------------------------------------------------------------------
// Option parsing
// ---------------------------------------------------------------------------
/** Default window cap when `--max-events` is not supplied. */
export const DEFAULT_STANDUP_WINDOW_MAX_EVENTS = 10000;
/** Largest window cap accepted. */
export const MAX_STANDUP_WINDOW_EVENTS = 1000000;
/**
 * Parse the `--max-events` window cap.
 *
 * @param raw - The raw flag value, or undefined for the default.
 * @returns The validated cap.
 */
export function parseStandupWindowMaxEvents(raw) {
    if (raw === undefined)
        return DEFAULT_STANDUP_WINDOW_MAX_EVENTS;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_STANDUP_WINDOW_EVENTS) {
        refuseStandupWindow("window_max_events_invalid", `--max-events '${raw}' is out of range.`);
    }
    return value;
}
//# sourceMappingURL=reporting-window.js.map