export declare class CommandError extends Error {
    exitCode: number;
    constructor(message: string, exitCode?: number);
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
}
export type Format = "slack" | "blockkit" | "markdown" | "plain";
export type GroupBy = "status" | "assignee" | "sprint" | "type";
export type SectionKey = "in_progress" | "blocked" | "done" | "up_next";
export declare const ALL_SECTIONS: readonly SectionKey[];
export interface StandupData {
    wip: PmItem[];
    blocked: PmItem[];
    done: PmItem[];
    upNext: PmItem[];
    total: number;
}
export interface StandupOptions {
    channel?: string;
    format: Format;
    includeDone: boolean;
    since?: string;
    groupBy: GroupBy;
    sections: SectionKey[];
    mentionMap: Record<string, string>;
}
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
 * Resolve the "recently closed" window start (ms epoch) from `--since` and/or
 * `--days`. `--since` is an explicit ISO date/time; `--days <n>` is N days
 * before now. If both are given the *later* (more restrictive) bound wins.
 * Returns NaN when neither is set (no windowing). Invalid input → USAGE error.
 */
export declare function resolveSinceMs(since: string | undefined, days: number | undefined, now?: number): number;
export declare function parseDays(raw: string | undefined): number | undefined;
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
 * Bucket items into standup sections.
 * `sinceMs` (epoch ms, NaN = no window) filters the Done section to items
 * updated within the window; WIP/blocked/up-next always reflect current state.
 */
export declare function buildStandupData(items: PmItem[], opts: StandupOptions, sinceMs?: number): StandupData;
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
 */
export declare function resolveSections(data: StandupData, opts: StandupOptions): SectionDef[];
export declare function itemText(item: PmItem, mentionMap: Record<string, string>, withPriority?: boolean): string;
/**
 * Group a list of items by the configured field (assignee, sprint or type).
 * Items missing the field bucket under a synthetic "_none" key (rendered as a
 * friendly label). Returns entries sorted by group key for stable output.
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
/**
 * Resolve every standup option except the render `format`, which differs
 * between the command (slack|blockkit|markdown|plain) and the exporter
 * (md|json file format). Callers supply the format they want.
 */
export declare function resolveStandupOptions(options: Record<string, unknown>, format: Format): {
    opts: StandupOptions;
    sinceMs: number;
};
declare const _default: {
    name: string;
    version: string;
    activate(api: import("@unbrained/pm-cli/sdk").ExtensionApi): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map