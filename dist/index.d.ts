/**
 * Error type that carries the numeric exit code pm's command runtime expects.
 *
 * pm's extension runtime only treats a thrown error as a cleanly-handled
 * non-zero exit when the error exposes a numeric `exitCode`; a plain
 * {@link Error} makes the runtime re-invoke the handler and exit with a generic
 * code, so every intentional failure path in this package throws a
 * {@link CommandError} instead.
 */
export declare class CommandError extends Error {
    /** Numeric exit code pm's runtime reads off the thrown error (see EXIT_CODE). */
    exitCode: number;
    constructor(message: string, exitCode?: number);
}
/**
 * One edge in an item's dependency list, as decoded from `pm list-all --json`.
 *
 * Carries the target item id and the relationship kind (e.g. `blocked_by`); the
 * index signature keeps any extra fields the host may add visible without a
 * parse error.
 */
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
/**
 * Field a standup's items are sub-grouped within each section by.
 *
 * `status` (the default) leaves sections flat; the others nest a sub-header per
 * assignee, sprint, type, or milestone so a reader can scan their own slice.
 */
export type GroupBy = "status" | "assignee" | "sprint" | "type" | "milestone";
/**
 * Canonical name of one standup section.
 *
 * The four fixed buckets the standup renders: work in progress, blocked, done,
 * and up next. Aliases (e.g. `wip`, `closed`, `next`) normalize to these via
 * `SECTION_ALIASES`.
 */
export type SectionKey = "in_progress" | "blocked" | "done" | "up_next";
/**
 * The four standup sections in their canonical render order.
 *
 * Used as the default selection and to iterate sections in a stable order
 * independent of how `--sections` lists them.
 */
export declare const ALL_SECTIONS: readonly SectionKey[];
/**
 * The bucketed items a standup renders, produced by filtering and grouping pm items.
 *
 * Holds the four section populations plus a total; when `--yesterday` is set,
 * the done bucket is additionally split into items closed yesterday vs. today
 * (both still subsets of `done`).
 */
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
    includeBlockers?: boolean;
    team?: string[];
    compact?: boolean;
}
/** Default number of items shown in the "Up Next" section. */
export declare const DEFAULT_UP_NEXT = 3;
/**
 * Per-section override of the default emoji and/or title.
 *
 * Set from `--section-label` so a team can rename, say, the "Up Next" bucket or
 * swap its emoji without touching code. Either field is optional; an unset
 * field keeps the built-in default.
 */
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
/**
 * Read a boolean option under both the kebab-case and camelCase spellings.
 *
 * pm normalizes CLI flags to camelCase at runtime, so reading only one key
 * silently misses the value; this tries `key` then its {@link camelCase} form
 * and accepts either a real boolean or a truthy/falsy string (`true`/`1`/`yes`/
 * `on` vs `false`/`0`/`no`/`off`). A missing or unrecognized option resolves to
 * `false` so an unset flag never blocks behavior.
 *
 * @param options - The raw flag record handed to the command.
 * @param key - The flag name, in its kebab-case form (e.g. `include-done`).
 * @returns The resolved boolean, or `false` when the option is unset.
 */
export declare function readBoolOption(options: Record<string, unknown>, key: string): boolean;
/**
 * Read a trimmed, non-empty string option under both flag spellings.
 *
 * Like {@link readBoolOption}, this tries the kebab-case and camelCase keys so a
 * value set under either form is found. A blank or whitespace-only value is
 * treated as absent and skipped, so callers can rely on a non-empty return.
 *
 * @param options - The raw flag record handed to the command.
 * @param key - The flag name, in its kebab-case form.
 * @returns The trimmed value, or `undefined` when the option is unset or blank.
 */
export declare function readStrOption(options: Record<string, unknown>, key: string): string | undefined;
/**
 * Parse a `--mention-map` spec mapping pm authors to Slack handles.
 * Accepts `author=@handle,other=@h2` (commas) or semicolon separators.
 * A leading `@` on the handle is optional and normalized on.
 */
export declare function parseMentionMap(spec: string | undefined): Record<string, string>;
/**
 * Normalize a `--format` value. Accepts the four public formats plus the
 * legacy `text` alias (== `plain`) and `blocks` (== `blockkit`, the Slack Block
 * Kit `blocks` JSON). Unknown values raise a USAGE CommandError.
 */
export declare function parseFormat(raw: string | undefined): Format;
/**
 * Parse the `--group-by` value into a {@link GroupBy}, defaulting to `status`.
 *
 * Accepts the canonical field names (and `owner` as an alias for `assignee`).
 * A blank or omitted value resolves to `status`; anything else throws a
 * {@link CommandError} (USAGE) listing the valid choices.
 *
 * @param raw - The raw `--group-by` value, possibly undefined.
 * @returns The resolved grouping field.
 */
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
 * Parse a `--team` spec (comma/semicolon list of assignees) into an ordered,
 * trimmed, de-duped list. Empty spec → [] (no filter). Used by `--team` to
 * filter the standup to items assigned to one of the named team members.
 */
export declare function parseTeam(spec: string | undefined): string[];
/**
 * A parsed post schedule. `daily` fires every day at HH:MM (local). `cron` is
 * a 5-field cron expression (minute hour day-of-month month day-of-week).
 */
export interface ScheduleSpec {
    kind: "daily" | "cron";
    /** Daily hour (0-23). */
    hour?: number;
    /** Daily minute (0-59). */
    minute?: number;
    /** Cron: per-field sorted unique lists of valid values, `*` → all. */
    fields?: number[][];
    /** Raw user input (for messages / debugging). */
    raw: string;
}
/**
 * Parse a `--schedule` value. Accepts `HH:MM` (daily, local time) or a 5-field
 * cron expression (minute hour dom month dow). Raises a USAGE CommandError for
 * anything unparseable so a typo is loud rather than silently posting now.
 */
export declare function parseSchedule(spec: string | undefined): ScheduleSpec | undefined;
/**
 * Compute the next epoch-ms fire time at/after `now` (exclusive: the next fire
 * is always strictly after `now`). For cron, day-of-month vs day-of-week use
 * standard cron OR semantics when both are restricted. Returns the epoch ms.
 */
export declare function nextFireTime(spec: ScheduleSpec, now?: number): number;
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
/**
 * Parse the `--days` value into a number of days, or undefined when omitted.
 *
 * A blank value resolves to `undefined` (the caller's default applies); a
 * non-numeric value throws a {@link CommandError} (USAGE). Unlike a coercing
 * parse, `Number` rejects trailing junk so `5d` fails loudly rather than
 * silently becoming 5.
 *
 * @param raw - The raw `--days` value, possibly undefined.
 * @returns The parsed day count, or `undefined` when no value was given.
 */
export declare function parseDays(raw: string | undefined): number | undefined;
/**
 * Translate a raw `writeFileSync` failure into a friendly {@link CommandError}
 * (so the exporter aborts with a clean exit 1 + actionable message rather than
 * leaking a Node fs stack trace). Recognizes the common errno cases (missing
 * directory, permission, is-a-directory) and falls back to the raw message.
 */
export declare function writeError(path: string, err: unknown): CommandError;
/** Read-buffer cap for `pm` output, in bytes. 64 MiB by default; override with the
 * `PM_JSON_MAX_BUFFER` env var. Resolved per call so the override takes effect
 * without an import-order dependency. Invalid or non-positive values fall back to
 * the default rather than silently disabling the guard. */
export declare function pmJsonMaxBuffer(): number;
/** Name the real cause of a failed `pm` read. A stdout overrun kills the child
 * with `status: null` and EMPTY stderr, so without this the failure surfaces as
 * an unexplained error (or, worse, as an empty result set). Exposed so the
 * wording can be regression-tested directly with synthetic errors, mirroring the
 * `describePmNullStatus` convention the sibling pm-csv package uses. */
export declare function describePmReadFailure(error: Error, limitBytes: number): string;
/**
 * Resolve the `pm` executable this package's own `@unbrained/pm-cli` declared,
 * walking up from `moduleUrl` to the nearest `node_modules/.bin/pm` shim, and
 * falling back to `pm` on `PATH` only when no local install is found.
 *
 * `spawnSync("pm", ...)` runs whichever `pm` comes first on `PATH`, which need
 * not be the `@unbrained/pm-cli` this package declared — that is what produced
 * the version skew this fix addresses. Resolving from the package's own
 * `node_modules` keeps the read against the same CLI the package pins, and the
 * walk handles both the source layout (`index.ts` at the package root) and the
 * built layout (`dist/index.js`), as well as a consumer install where the
 * nearest `.bin/pm` shim is the host CLI that loaded this extension. `moduleUrl`
 * defaults to this module's URL and is a parameter only so the resolution can be
 * exercised against synthetic locations without touching the real tree.
 */
export declare function resolvePmBin(moduleUrl?: string): string;
/**
 * Wall-clock ceiling for one `pm` read, in milliseconds. 60s by default;
 * override with `PM_READ_TIMEOUT_MS`.
 *
 * `spawnSync` without a `timeout` waits forever, so a wedged `pm` turns a
 * scheduled standup into a hung process rather than a failed one — and a hang
 * is the one failure mode a scheduler cannot report. A kill surfaces as
 * `result.error` with code `ETIMEDOUT`, which the existing failure path already
 * classifies. Resolved per call, and invalid or non-positive values fall back to
 * the default rather than disabling the ceiling.
 */
export declare function pmReadTimeoutMs(): number;
/**
 * Read every item once via `list-all --json --include-body`, then bucket by
 * status locally. This is a single pm invocation (vs. four list-by-status
 * calls) and gives us bodies + assignee + timestamps for grouping/windowing.
 *
 * A failed read THROWS a {@link CommandError} rather than degrading to an empty
 * success. The fleet convention (pm-csv, pm-gantt-chart, pm-jira, pm-linear,
 * pm-todos, pm-beads) is to refuse on this condition so a scheduled standup
 * never posts "nothing in progress, nothing blocked" in place of a real read
 * failure; this package previously returned `[]` and exited 0, which is
 * indistinguishable from a genuinely quiet day. The thrown message carries the
 * exit status and stderr, and — when `status` is `null` with empty stderr (a
 * stdout overrun) — an explicit statement that the output exceeded the
 * `maxBuffer` ceiling, via {@link describePmReadFailure}.
 *
 * `pmBin` defaults to {@link resolvePmBin} so the read runs against the
 * `@unbrained/pm-cli` this package declared rather than whichever `pm` comes
 * first on `PATH`; it is a parameter only so a caller (or test) can pin a
 * specific binary.
 */
export declare function fetchAllItems(pmRoot: string, pmBin?: string): PmItem[];
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
/**
 * Whole days an item has been blocked, for stale-impediment highlighting.
 *
 * Only items that are blocked (by status or a `blocked_by` dependency) are
 * measured; anything else returns `undefined`. The age is measured from the
 * item's `updated_at` (falling back to `created_at`) to `now`, floored to whole
 * days and clamped at zero; an unparseable timestamp yields `undefined`.
 *
 * @param item - The item to measure.
 * @param now - Reference epoch-ms instant (defaults to the current time).
 * @returns The age in whole days, or `undefined` when the item is not blocked or undated.
 */
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
/**
 * Render a single item as one compact text line for the standup.
 *
 * Composes an optional type label, the title, an optional priority suffix, and
 * — for blocked items — a parenthesized context naming the blocker and flagging
 * staleness once the block age crosses three days. A mapped assignee mention is
 * appended when present. This is the per-item unit the text/markdown renderers
 * concatenate.
 *
 * @param item - The item to render.
 * @param mentionMap - Assignee → Slack mention token map.
 * @param withPriority - When true, append the numeric priority.
 * @returns The composed one-line item string.
 */
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
/**
 * One entry in a Slack Block Kit `blocks` array.
 *
 * Every block carries a `type` and format-specific fields; the index signature
 * keeps the loose structure the Slack API expects without enumerating every
 * block shape this package emits (header, section, context, divider, actions).
 */
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
 * unrelated JSON entries are ignored. Returns absolute paths.
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
    activate(api: import("@unbrained/pm-cli/sdk/authoring").ExtensionApi): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map