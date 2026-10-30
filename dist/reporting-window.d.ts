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
import type { MutationEvent, MutationEventPage } from "@unbrained/pm-cli/sdk";
import type { SectionKey } from "./index.ts";
/** Typed refusal codes emitted by the standup window surface. */
export type StandupWindowRefusalCode = 
/** `--cursor-file` was not supplied. */
"window_cursor_file_missing"
/** `--max-events` is not a positive bounded integer. */
 | "window_max_events_invalid"
/** The state file exists but is not readable UTF-8 JSON object content. */
 | "window_state_unreadable"
/** The state file carries an unknown state-file version. */
 | "window_state_version_unsupported"
/** The state file decodes but violates the strict boundary schema. */
 | "window_state_invalid_shape"
/** The atomic boundary write failed at the filesystem level. */
 | "window_state_write_failed"
/** An event page violated the SDK pagination contract. */
 | "window_page_cursor_missing";
/** Operator remedies, keyed by {@link StandupWindowRefusalCode}. */
export declare const STANDUP_WINDOW_REFUSAL_REMEDIES: Readonly<Record<StandupWindowRefusalCode, string>>;
/**
 * Render one typed refusal as the operator-facing message.
 *
 * @param code - The refusal code.
 * @param detail - Concrete context for this occurrence.
 * @returns The full message including the code and its remedy.
 */
export declare function standupWindowRefusalMessage(code: StandupWindowRefusalCode, detail: string): string;
/**
 * Throw one typed standup-window refusal as a pm expected error.
 *
 * @param code - The refusal code; also carried in the error's `code` context.
 * @param detail - Concrete context for this occurrence.
 * @param exitCode - Process exit code for the refusal (USAGE for input
 *                   problems, GENERIC_FAILURE for environmental ones).
 */
export declare function refuseStandupWindow(code: StandupWindowRefusalCode, detail: string, exitCode?: number): never;
/** State-file version this package writes and strictly accepts. */
export declare const STANDUP_WINDOW_STATE_VERSION = 1;
/** Byte-shape every retained opaque cursor must satisfy (SDK cursor framing). */
export declare const STANDUP_WINDOW_CURSOR_PATTERN: RegExp;
/** Longest retained opaque cursor accepted (mirrors the SDK cursor bound). */
export declare const STANDUP_WINDOW_CURSOR_MAX_LENGTH = 4096;
/** Longest accepted history stream id (item ids are short slugs). */
export declare const STANDUP_WINDOW_STREAM_ID_MAX_LENGTH = 256;
/**
 * One certified standup reporting boundary.
 *
 * Retained atomically by {@link admitStandupWindowBoundary} after a window is
 * rendered. `cursor` is the SDK mutation-event cursor resuming strictly after
 * the last admitted event; the position and per-stream coverage let the next
 * report detect both forward appends and late/backdated ones.
 */
export interface StandupWindowBoundary {
    /** Opaque SDK mutation-event cursor for the last admitted event; null before any admission. */
    cursor: string | null;
    /** Mutation timestamp of the last admitted event in canonical journal order. */
    last_ts: string;
    /** History stream (item id or `_workspace`) of the last admitted event. */
    last_stream_id: string;
    /** Zero-based offset of the last admitted event within its stream. */
    last_stream_offset: number;
    /** Highest admitted zero-based offset per history stream, so late appends are never skipped. */
    covered_streams: ReadonlyMap<string, number>;
    /** Total events admitted across all windows so far. */
    admitted_events: number;
    /** ISO timestamp of the admission that produced this boundary. */
    admitted_at: string;
}
/** The state file as read at window start: its boundary, plus exact bytes for admission CAS. */
export interface StandupWindowStateSnapshot {
    /** Parsed boundary, or null when no state file exists yet. */
    boundary: StandupWindowBoundary | null;
    /** Exact file bytes at read time (empty string when absent); admission compares against them. */
    bytes: string;
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
export declare function parseStandupWindowBoundaryState(parsed: unknown): StandupWindowBoundary;
/**
 * Serialize a boundary to the exact state-file JSON this package writes.
 *
 * @param boundary - The boundary to persist.
 * @returns The newline-terminated state-file bytes.
 */
export declare function serializeStandupWindowBoundary(boundary: StandupWindowBoundary): string;
/**
 * Read the retained boundary at window start.
 *
 * @param path - Absolute path of the `--cursor-file` state file.
 * @returns The parsed boundary (null when no file exists) and its exact bytes.
 */
export declare function readStandupWindowBoundary(path: string): StandupWindowStateSnapshot;
/**
 * The tracker lock id serializing admissions for one cursor file.
 *
 * Derived from the resolved state-file path so two reporters sharing a cursor
 * file contend on the same lease even across processes.
 *
 * @param path - Absolute path of the `--cursor-file` state file.
 * @returns The fs-safe lock id.
 */
export declare function standupWindowLockId(path: string): string;
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
 * @returns Whether the boundary was retained; a concurrent admission is
 *          reported as `{ admitted: false }`, never thrown.
 */
export declare function admitStandupWindowBoundary(path: string, snapshot: StandupWindowStateSnapshot, boundary: StandupWindowBoundary, lock: {
    pmRoot: string;
    owner: string;
    waitMs: number;
}): Promise<{
    admitted: boolean;
}>;
/** Canonical journal position of one event, the same ordering the SDK cursors use. */
export interface StandupWindowEventPosition {
    /** Mutation timestamp. */
    ts: string;
    /** History stream (item id or `_workspace`). */
    stream_id: string;
    /** Zero-based offset within the stream. */
    stream_offset: number;
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
export declare function compareStandupWindowPositions(left: StandupWindowEventPosition, right: StandupWindowEventPosition): number;
/**
 * Whether an event sorts strictly after the boundary's last admitted event.
 *
 * @param event - The event position to test.
 * @param boundary - The retained boundary (null means nothing admitted yet).
 * @returns True when the event is a forward append past the boundary.
 */
export declare function eventAfterBoundary(event: StandupWindowEventPosition, boundary: StandupWindowBoundary | null): boolean;
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
export declare function eventInStandupWindow(event: StandupWindowEventPosition, boundary: StandupWindowBoundary | null): boolean;
/** Page reader injectable for tests; production binds the SDK mutation-event reader. */
export type StandupWindowPageReader = (since?: string) => Promise<MutationEventPage>;
/** Result of one complete journal scan partitioned against a boundary. */
export interface StandupWindowEventScan {
    /** Events belonging to this window, in canonical journal order. */
    windowEvents: MutationEvent[];
    /** Window events appended after the boundary but positioned at or before it (backdated). */
    lateEvents: number;
    /** Window events on the `_workspace` stream (no item row). */
    workspaceEvents: number;
    /** All events seen during the scan (window plus previously admitted). */
    totalEvents: number;
    /** Highest zero-based offset seen per stream across the whole scan. */
    maxOffsets: ReadonlyMap<string, number>;
    /** Position of the last event seen, or null when the journal is empty. */
    lastEvent: StandupWindowEventPosition | null;
    /** Opaque SDK cursor resuming strictly after the last event seen. */
    nextCursor: string | null;
    /** Whether the scan stopped at the `--max-events` window cap. */
    capped: boolean;
    /** Persistence source the SDK read from. */
    source: string;
    /** Number of SDK pages read. */
    pages: number;
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
export declare function scanStandupWindowEvents(readPage: StandupWindowPageReader, boundary: StandupWindowBoundary | null, maxEvents: number): Promise<StandupWindowEventScan>;
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
export declare function standupWindowCoverageRegressions(boundary: StandupWindowBoundary | null, scan: StandupWindowEventScan): string[];
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
export declare function standupWindowUnknownStreams(windowEvents: readonly MutationEvent[], corpusIds: ReadonlySet<string>): string[];
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
export declare function standupWindowDeletedStreams(windowEvents: readonly MutationEvent[], corpusIds: ReadonlySet<string>): string[];
/** One compact item row in a window packet section. */
export interface StandupWindowItemRow {
    /** Item id. */
    id: string;
    /** Item title. */
    title: string;
    /** Lifecycle status name as stored. */
    status: string;
}
/** Window metadata block of the packet. */
export interface StandupWindowInfo {
    /** Opaque boundary cursor this window started from; null for the first window. */
    boundary_before: string | null;
    /** Exact next boundary to retain; resumable with `pm history events --since`. */
    boundary_next: string | null;
    /** Mutation events in this window. */
    events: number;
    /** Window events that were late or backdated relative to the boundary. */
    late_events: number;
    /** Window events on the `_workspace` stream. */
    workspace_events: number;
    /** Distinct item streams touched in this window. */
    touched_items: number;
    /** Distinct mutation operation names in this window, sorted. */
    ops: string[];
    /** Whether the packet is complete and safe to treat as final. */
    incomplete: boolean;
    /** Machine-readable reasons the packet is incomplete; empty when complete. */
    incomplete_reasons: string[];
    /** Item streams named by window events but missing from the certified corpus. */
    unknown_streams?: string[];
    /** Item streams whose deletion this window recorded (no corpus row can exist). */
    deleted_items?: string[];
    /** History streams that shrank below the admitted boundary coverage. */
    regressed_streams?: string[];
    /** Whether this run retained the next boundary. */
    admitted: boolean;
}
/** Compact TOON/JSON window packet sized for agents. */
export interface StandupWindowPacket {
    /** Window metadata. */
    window: StandupWindowInfo;
    /** Bucketed item rows for the four standup sections. */
    sections: Record<SectionKey, StandupWindowItemRow[]>;
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
export declare function buildStandupWindowPacket(input: {
    boundaryBefore: string | null;
    scan: StandupWindowEventScan;
    sections: Readonly<Record<SectionKey, readonly StandupWindowItemRow[]>>;
    incompleteReasons: readonly string[];
    unknownStreams: readonly string[];
    deletedStreams: readonly string[];
    regressedStreams: readonly string[];
    admitted: boolean;
}): StandupWindowPacket;
/** Default window cap when `--max-events` is not supplied. */
export declare const DEFAULT_STANDUP_WINDOW_MAX_EVENTS = 10000;
/** Largest window cap accepted. */
export declare const MAX_STANDUP_WINDOW_EVENTS = 1000000;
/**
 * Parse the `--max-events` window cap.
 *
 * @param raw - The raw flag value, or undefined for the default.
 * @returns The validated cap.
 */
export declare function parseStandupWindowMaxEvents(raw: string | undefined): number;
//# sourceMappingURL=reporting-window.d.ts.map