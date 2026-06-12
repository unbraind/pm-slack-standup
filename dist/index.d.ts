export declare class CommandError extends Error {
    exitCode: number;
    constructor(message: string, exitCode?: number);
}
export interface PmDependency {
    id?: string;
    kind?: string;
    [key: string]: unknown;
}
export interface PmItem {
    id: string;
    title: string;
    status: string;
    type?: string;
    priority?: number;
    tags?: string[];
    milestone?: string;
    release?: string;
    sprint?: string;
    assignee?: string;
    author?: string;
    body?: string;
    created_at?: string;
    updated_at?: string;
    blocked_by?: string;
    dependencies?: PmDependency[];
}
export type Format = "slack" | "blockkit" | "markdown" | "plain";
export type GroupBy = "status" | "assignee" | "sprint" | "type" | "milestone";
export type SectionKey = "in_progress" | "blocked" | "done" | "up_next";
export declare const ALL_SECTIONS: readonly SectionKey[];
export interface StandupData {
    wip: PmItem[];
    blocked: PmItem[];
    done: PmItem[];
    upNext: PmItem[];
    total: number;
    doneYesterday?: PmItem[];
    doneToday?: PmItem[];
}
export interface StandupOptions {
    channel?: string;
    format: Format;
    includeDone: boolean;
    since?: string;
    groupBy: GroupBy;
    sections: SectionKey[];
    mentionMap: Record<string, string>;
    splitYesterday: boolean;
    sectionLabels: Partial<Record<SectionKey, SectionLabelOverride>>;
    upNextCount: number;
    trend?: SectionDelta[];
    history?: SnapshotEntry[];
}
/** Default number of items shown in the "Up Next" section. */
export declare const DEFAULT_UP_NEXT = 3;
export interface SectionLabelOverride {
    emoji?: string;
    title?: string;
}
/** Per-section item counts, keyed by the canonical SectionKey. */
export type SectionCounts = Record<SectionKey, number>;
/** One section's delta vs. a prior standup: signed numeric change + direction. */
export interface SectionDelta {
    key: SectionKey;
    prior: number;
    current: number;
    delta: number;
    direction: "up" | "down" | "flat";
}
/** Direction → indicator glyph used in trend output. */
export declare const TREND_GLYPH: Record<SectionDelta["direction"], string>;
/** One historical standup snapshot: a short label (date) + section counts. */
export interface SnapshotEntry {
    /** Human label for the snapshot, e.g. "2026-06-10" (from the export date). */
    label: string;
    counts: SectionCounts;
}
/** How many snapshots the history footer shows at most (newest last). */
export declare const HISTORY_MAX_SNAPSHOTS = 8;
export declare function readBoolOption(options: Record<string, unknown>, key: string): boolean;
export declare function readStrOption(options: Record<string, unknown>, key: string): string | undefined;
/**
 * Parse a `--mention-map` spec mapping pm authors to Slack handles.
 * Accepts `author=@handle,other=@h2` (commas) or semicolon separators.
 * A leading `@` on the handle is optional and normalized on.
 */
export declare function parseMentionMap(spec: string | undefined): Record<string, string>;
/**
 * Normalize a `--format` value. Accepts the four public formats plus the
 * legacy `text` alias (== `plain`). Unknown values raise a USAGE CommandError.
 */
export declare function parseFormat(raw: string | undefined): Format;
export declare function parseGroupBy(raw: string | undefined): GroupBy;
/**
 * Parse a `--sections` spec (comma/semicolon list) into an ordered, de-duped
 * list of section keys. Empty spec → all sections in default order. An
 * unknown token is a USAGE error rather than a silent drop.
 */
export declare function parseSections(spec: string | undefined): SectionKey[];
/**
 * Parse a `--section-labels` spec overriding section titles (and optionally
 * an emoji). Accepts `key=Label,other=Label2` (comma/semicolon separated).
 * The label value may itself lead with an emoji + space, e.g.
 * `blocked=🔥 On Fire` sets emoji "🔥" and title "On Fire"; a label with no
 * leading emoji keeps the section's default emoji and only changes the title.
 * Keys use the same aliases as `--sections` (wip→in_progress, etc.).
 * Unknown keys are a USAGE error rather than a silent drop.
 */
export declare function parseSectionLabels(spec: string | undefined): Partial<Record<SectionKey, SectionLabelOverride>>;
/**
 * Parse a `--channels` spec (comma/semicolon list) into an ordered, de-duped
 * list of channel targets. Each target is either a Slack channel name
 * (e.g. `#team-eng`) or a full webhook URL — multi-channel posting accepts
 * both (a name is shown in the message; a URL is POSTed to). Empty → [].
 */
export declare function parseChannels(spec: string | undefined): string[];
/** True when a channel token is a full webhook URL rather than a name. */
export declare function isWebhookUrl(token: string): boolean;
/**
 * Resolve the "recently closed" window start (ms epoch) from `--since` and/or
 * `--days`. `--since` is an explicit ISO date/time; `--days <n>` is N days
 * before now. If both are given the *later* (more restrictive) bound wins.
 * Returns NaN when neither is set (no windowing). An invalid `--days` is a
 * USAGE error; an unparseable `--since` is NOT fatal — it emits a warning and
 * is ignored (no window from `--since`), so a typo surfaces loudly instead of
 * silently scoping the Done section to nothing. A `warn` sink is injectable
 * for testing.
 */
export declare function resolveSinceMs(since: string | undefined, days: number | undefined, now?: number, warn?: (msg: string) => void): number;
/**
 * Resolve how many "Up Next" items to show. `--all-open` (boolean) wins and
 * returns Infinity (show the whole open backlog). Otherwise `--up-next <n>` is
 * a positive integer count; an absent value uses the default. A non-positive
 * or non-integer `--up-next` is a USAGE error rather than a silent fallback.
 */
export declare function resolveUpNextCount(upNextRaw: string | undefined, allOpen: boolean, fallback?: number): number;
export declare function parseDays(raw: string | undefined): number | undefined;
/**
 * Translate a raw `writeFileSync` failure into a friendly {@link CommandError}
 * (so the exporter aborts with a clean exit 1 + actionable message rather than
 * leaking a Node fs stack trace). Recognizes the common errno cases (missing
 * directory, permission, is-a-directory) and falls back to the raw message.
 */
export declare function writeError(path: string, err: unknown): CommandError;
/**
 * Read every item once via `list-all --json --include-body`, then bucket by
 * status locally. This is a single pm invocation (vs. four list-by-status
 * calls) and gives us bodies + assignee + timestamps for grouping/windowing.
 */
export declare function fetchAllItems(pmRoot: string): PmItem[];
/**
 * True when an item's last activity falls within the [sinceMs, now] window.
 * NaN sinceMs means "no window" → always true.
 */
export declare function withinWindow(item: PmItem, sinceMs: number): boolean;
/**
 * True when an item carries a `blocked_by` dependency, regardless of its
 * status. pm surfaces this either as a top-level `blocked_by` string (item ID
 * or free-text reason) or as one/more `dependencies` entries with
 * `kind: "blocked_by"`. Used to surface impediments that are NOT explicitly
 * status=blocked under the Blocked section.
 */
export declare function hasBlockedByDep(item: PmItem): boolean;
export declare function blockedAgeDays(item: PmItem, now?: number): number | undefined;
/**
 * Local-day key (YYYY-MM-DD in the host's local timezone) for an item's last
 * activity. Used by the `--yesterday` split. Falls back to created_at, then
 * to the empty string when no timestamp is parseable.
 */
export declare function localDayKey(item: PmItem): string;
/** Local-day key (YYYY-MM-DD) for a given epoch-ms instant. */
export declare function localDayKeyOf(ms: number): string;
/**
 * Bucket items into standup sections.
 * `sinceMs` (epoch ms, NaN = no window) filters the Done section to items
 * updated within the window; WIP/blocked/up-next always reflect current state.
 */
export declare function buildStandupData(items: PmItem[], opts: StandupOptions, sinceMs?: number, now?: number): StandupData;
interface SectionDef {
    key: SectionKey;
    emoji: string;
    title: string;
    items: PmItem[];
    emptyNote: string | null;
    withPriority: boolean;
}
/**
 * Resolve the ordered, selected section definitions for the given data.
 * `in_progress` and `blocked` always render (even empty, with their note);
 * `done` and `up_next` only render when they hold items — preserving the
 * historical message shape. `--sections` filters which keys are eligible.
 *
 * When `--yesterday` is active and Done has items, the single Done section is
 * expanded into "Done Yesterday" + "Done Today" (only the non-empty subsets
 * render), preserving the section's position in the ordering.
 */
export declare function resolveSections(data: StandupData, opts: StandupOptions): SectionDef[];
export declare function itemText(item: PmItem, mentionMap: Record<string, string>, withPriority?: boolean): string;
/**
 * Group a list of items by the configured field (assignee, sprint, type or
 * milestone). Items missing the field bucket under a synthetic "_none" key
 * (rendered as a friendly label). Returns entries sorted by group key for
 * stable output.
 */
export declare function groupItems(items: PmItem[], groupBy: GroupBy): Array<[string, PmItem[]]>;
/**
 * Render the standup as a single text blob for the chosen non-Block-Kit
 * format. `slack` is byte-identical to the historical output (mrkdwn);
 * `plain` drops emphasis punctuation; `markdown` uses `#`/`**`/`-`.
 */
export declare function buildTextMessage(data: StandupData, opts: StandupOptions): string;
export interface SlackBlock {
    type: string;
    [key: string]: unknown;
}
/**
 * Build a Slack Block Kit `blocks` array: a header, a section per selected
 * standup bucket and a context footer. Returns the blocks plus a plain-text
 * `fallback` Slack renders in notifications and old clients.
 *
 * Block Kit schema choices: a single `header` block (plain_text, capped at
 * Slack's 150-char limit), one `section`/`mrkdwn` block per bucket (Slack
 * caps section text at 3000 chars — long buckets are truncated with an
 * ellipsis to stay valid), a `divider`, then a `context` footer summarizing
 * counts / window / grouping.
 */
export declare function buildBlockKit(data: StandupData, opts: StandupOptions): {
    blocks: SlackBlock[];
    fallback: string;
};
/**
 * Render the standup in whichever `--format` was selected, as the string the
 * command prints (dry-run) or the exporter writes. `blockkit` returns the
 * pretty-printed `{ blocks }` JSON; everything else returns text.
 */
export declare function renderStandup(data: StandupData, opts: StandupOptions): string;
/** One resolved post target: the webhook URL to POST to + the channel name. */
export interface PostTarget {
    webhookUrl: string;
    /** Channel name shown in the message (may differ per target). */
    channel?: string;
}
export interface PostResultEntry {
    channel?: string;
    ok: boolean;
    error?: string;
}
/** A poster sends one payload to one webhook. Injectable for testing. */
export type Poster = (webhookUrl: string, payload: Record<string, unknown>) => Promise<void>;
/**
 * Resolve the ordered list of post targets from `--webhook`/env + `--channel`
 * + `--channels`. Each `--channels` token is either a `#name` (posted to the
 * base webhook, just changing the displayed channel) or a full webhook URL
 * (posted to that URL). When no `--channels` is given, a single target using
 * the base webhook + `--channel` is returned. De-dupes (webhook,channel) pairs.
 */
export declare function resolvePostTargets(baseWebhook: string, baseChannel: string | undefined, channels: string[]): PostTarget[];
/**
 * Post the standup to every resolved target, re-rendering per target so each
 * channel's message shows its own channel name. Returns a per-target result;
 * never throws — the caller decides how to treat failures (e.g. fallback to
 * stdout). The `poster` is injectable so this is testable without a network.
 */
export declare function postStandupTargets(targets: PostTarget[], data: StandupData, baseOpts: StandupOptions, poster: Poster): Promise<PostResultEntry[]>;
/**
 * Decide whether the `standup` invocation is actually going to *post* to Slack.
 *
 * The command has two non-posting shapes that must NOT be gated:
 *   - `--dry-run`           : build + print the message, never touches Slack.
 * Every other shape is a real post attempt (the default), including
 * `--fallback-to-stdout` — that flag only means "print instead of erroring *if
 * the network post fails*", it still REQUIRES a webhook to attempt the post.
 */
export declare function isPostRequested(options: Record<string, unknown>): boolean;
/**
 * Resolve whether a *base* Slack webhook is required for this post. `--channels`
 * may carry full webhook URLs that are self-sufficient targets; but if there is
 * no `--channels` at all, or any `--channels` entry is a bare `#name`, the base
 * webhook (`--webhook` / `PM_SLACK_WEBHOOK`) is needed to actually deliver.
 */
export declare function needsBaseWebhook(channels: string[]): boolean;
/**
 * Fail-fast credential preflight for the standup *post* path.
 *
 * Fires ONLY when a Slack post is actually requested (not `--dry-run`) AND the
 * credentials needed to deliver it are missing. In that case it throws a
 * structured {@link CommandError} (USAGE / exit 2) BEFORE any pm data is read
 * or any message is rendered — a clean, actionable, non-zero abort.
 *
 * It deliberately does NOT block the legitimate non-posting shapes:
 *   - `--dry-run` (preview to stdout) is never gated.
 * This keeps the existing stdout-fallback behaviour intact while turning a
 * "we got all the way to the transport layer and then discovered there's no
 * webhook" failure into an immediate, obvious one.
 *
 * NOTE: this is invoked from the command HANDLER (not from `registerPreflight`)
 * on purpose. pm's runtime wraps `registerPreflight` overrides in a try/catch
 * and downgrades any thrown error to a non-fatal warning, so a throw there does
 * NOT abort the command. Throwing from the handler is the only reliable way to
 * fail-fast with a non-zero exit. The `registerPreflight` registration below is
 * a scoped pass-through that exists to surface the `preflight` capability.
 */
export declare function preflightSlackCredentials(options: Record<string, unknown>): void;
/**
 * Resolve every standup option except the render `format`, which differs
 * between the command (slack|blockkit|markdown|plain) and the exporter
 * (md|json file format). Callers supply the format they want.
 */
export declare function resolveStandupOptions(options: Record<string, unknown>, format: Format): {
    opts: StandupOptions;
    sinceMs: number;
};
/** Extract the current per-section counts from computed standup data. */
export declare function currentCounts(data: StandupData): SectionCounts;
/**
 * Parse per-section counts out of a prior standup JSON object. The exporter
 * (`standup export --format json`) writes a top-level `counts` object keyed
 * `wip/blocked/done/upNext`; we also accept the canonical SectionKey spellings
 * (`in_progress`/`up_next`) and a fallback of counting `sections_data`/
 * `sections` arrays. Returns the counts (every section present, missing → 0)
 * or undefined when nothing usable is found, so the caller can warn + skip.
 */
export declare function extractPriorCounts(parsed: unknown): SectionCounts | undefined;
/**
 * Read a prior standup's per-section counts from a local file at `path`.
 * Purely a local file read (no network). Any failure — missing/unreadable
 * file, invalid JSON, or a shape without recognizable counts — emits a single
 * stderr warning via `warn` and returns undefined so the caller renders the
 * standup normally WITHOUT deltas (never throws).
 */
export declare function readPriorCounts(path: string, warn?: (msg: string) => void): SectionCounts | undefined;
/**
 * True when `path` exists and is a directory (a snapshot history directory
 * written by `standup export --history-dir`). Never throws.
 */
export declare function isDirectory(path: string): boolean;
/**
 * List the standup snapshot JSON files inside a history directory, oldest
 * first. Snapshot files are sorted by filename (the exporter writes
 * `standup-YYYY-MM-DD.json`, so lexicographic order IS chronological order);
 * non-JSON entries are ignored. Returns absolute paths.
 */
export declare function listSnapshotFiles(dir: string): string[];
/**
 * Read a multi-snapshot history from a `--compare <dir>` directory. Each
 * `*.json` file is parsed with the same tolerant count extraction as a single
 * `--compare <file>`; unreadable/unrecognizable snapshots are skipped with one
 * stderr warning each. At most {@link HISTORY_MAX_SNAPSHOTS} newest snapshots
 * are kept (oldest first). Labels prefer the snapshot's own `date` field and
 * fall back to the file name. Returns an empty array when nothing is usable.
 */
export declare function readSnapshotHistory(dir: string, warn?: (msg: string) => void): SnapshotEntry[];
/**
 * Build the one-line history summary shown below the trend footer when
 * `--compare` points at a snapshot directory with 2+ snapshots, e.g.
 * "History (3 snapshots → today): In Progress 2→3→1 · Done 4→6→9".
 * Sections whose counts never change across the window are still shown so the
 * line stays positionally stable. Returns "" for fewer than 2 snapshots.
 */
export declare function renderHistoryLine(history: SnapshotEntry[], current: SectionCounts): string;
/**
 * Compute per-section deltas (current − prior) for every standup section.
 * A positive delta is "up", negative "down", zero "flat". The ordering
 * follows ALL_SECTIONS so output is stable.
 */
export declare function computeDeltas(prior: SectionCounts, current: SectionCounts): SectionDelta[];
/** Render one section delta as e.g. "In Progress ▲+2" / "Blocked ▼-1" / "Done →0". */
export declare function formatDelta(d: SectionDelta): string;
/**
 * Build the one-line trend summary shown in the standup footer, e.g.
 * "Trend vs prior: In Progress ▲+2 · Blocked ▼-1 · Done →0 · Up Next →0".
 * Returns the empty string when there are no deltas to show.
 */
export declare function renderTrendLine(deltas: SectionDelta[]): string;
declare const _default: {
    name: string;
    version: string;
    activate(api: import("@unbrained/pm-cli/sdk").ExtensionApi): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map