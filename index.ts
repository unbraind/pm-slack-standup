import https from "node:https";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property
// (see @unbrained/pm-cli runCommandHandler). A plain `Error` makes the runtime
// fall through to its "unhandled" path, which RE-INVOKES the command handler a
// second time and exits with a generic code. We mirror the SDK's EXIT_CODE
// contract here rather than importing it: standalone-installed extensions load
// only their own `dist/`, so `@unbrained/pm-cli` is not resolvable at runtime.
const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
} as const;

export class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  // A `blocked_by` dependency can surface either as a top-level string
  // (item ID or free-text reason) or as one/more entries in `dependencies`
  // with `kind: "blocked_by"`. We surface either under the Blocked section.
  blocked_by?: string;
  dependencies?: PmDependency[];
}

// The text/preview renderer: `slack` uses Slack mrkdwn (`*bold*`), `plain` is
// punctuation-free plain text, `markdown` is GitHub/CommonMark (`**bold**`,
// `#` headings), and `blockkit` emits the Slack Block Kit `blocks` array JSON.
export type Format = "slack" | "blockkit" | "markdown" | "plain";
export type GroupBy = "status" | "assignee" | "sprint" | "type" | "milestone";
export type SectionKey = "in_progress" | "blocked" | "done" | "up_next";

export const ALL_SECTIONS: readonly SectionKey[] = [
  "in_progress",
  "blocked",
  "done",
  "up_next",
] as const;

export interface StandupData {
  wip: PmItem[];
  blocked: PmItem[];
  done: PmItem[];
  upNext: PmItem[];
  total: number;
  // When `--yesterday` is requested, `done` is split into items closed
  // yesterday (local day) vs. today. Both subsets are subsets of `done`.
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
  // Split the Done section into "Done Yesterday" / "Done Today" by the local
  // day boundary. Additive; off by default (single Done section).
  splitYesterday: boolean;
  // Override the default emoji/title for any section. Keyed by SectionKey.
  sectionLabels: Partial<Record<SectionKey, SectionLabelOverride>>;
  // How many open items the "Up Next" section shows (top-N by priority).
  // Defaults to DEFAULT_UP_NEXT (3). `--all-open` sets this to Infinity so the
  // whole open backlog is shown rather than being silently truncated.
  upNextCount: number;
  // Per-section trend deltas vs. a prior standup (from `--compare <path>`).
  // When present and non-empty, a one-line trend summary is rendered in the
  // footer (Block Kit context block / markdown + text output). Absent/empty
  // means no `--compare` was given (or the prior file degraded gracefully).
  trend?: SectionDelta[];
}

/** Default number of items shown in the "Up Next" section. */
export const DEFAULT_UP_NEXT = 3;

export interface SectionLabelOverride {
  emoji?: string;
  title?: string;
}

// ---------------------------------------------------------------------------
// Trend comparison (`--compare`)
// ---------------------------------------------------------------------------

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
export const TREND_GLYPH: Record<SectionDelta["direction"], string> = {
  up: "▲",
  down: "▼",
  flat: "→",
} as const;

// ---------------------------------------------------------------------------
// Option helpers
// ---------------------------------------------------------------------------

/**
 * pm normalizes CLI flags to camelCase at runtime (e.g. `--dry-run` becomes
 * `dryRun`), so reading only the kebab-case key silently misses the value.
 * Read both forms (plus any explicit aliases) to be robust.
 */
function camelCase(key: string): string {
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function readBoolOption(
  options: Record<string, unknown>,
  key: string
): boolean {
  for (const candidate of [key, camelCase(key)]) {
    const value = options[candidate];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
      if (v === "false" || v === "0" || v === "no" || v === "off") return false;
    }
  }
  return false;
}

export function readStrOption(
  options: Record<string, unknown>,
  key: string
): string | undefined {
  for (const candidate of [key, camelCase(key)]) {
    const value = options[candidate];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Parse a `--mention-map` spec mapping pm authors to Slack handles.
 * Accepts `author=@handle,other=@h2` (commas) or semicolon separators.
 * A leading `@` on the handle is optional and normalized on.
 */
export function parseMentionMap(spec: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!spec) return map;
  for (const pair of spec.split(/[,;]/)) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const author = pair.slice(0, eq).trim();
    let handle = pair.slice(eq + 1).trim();
    if (!author || !handle) continue;
    if (!handle.startsWith("@")) handle = `@${handle}`;
    map[author] = handle;
  }
  return map;
}

/**
 * Normalize a `--format` value. Accepts the four public formats plus the
 * legacy `text` alias (== `plain`). Unknown values raise a USAGE CommandError.
 */
export function parseFormat(raw: string | undefined): Format {
  if (raw == null) return "slack";
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "slack") return "slack";
  if (v === "blockkit" || v === "block-kit" || v === "blocks") return "blockkit";
  if (v === "markdown" || v === "md") return "markdown";
  if (v === "plain" || v === "text" || v === "txt") return "plain";
  throw new CommandError(
    `Unknown --format '${raw}'. Valid: slack | blockkit | markdown | plain.`,
    EXIT_CODE.USAGE
  );
}

export function parseGroupBy(raw: string | undefined): GroupBy {
  if (raw == null) return "status";
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "status") return "status";
  if (v === "assignee" || v === "owner") return "assignee";
  if (v === "sprint") return "sprint";
  if (v === "type") return "type";
  if (v === "milestone") return "milestone";
  throw new CommandError(
    `Unknown --group-by '${raw}'. Valid: status | assignee | sprint | type | milestone.`,
    EXIT_CODE.USAGE
  );
}

const SECTION_ALIASES: Record<string, SectionKey> = {
  in_progress: "in_progress",
  "in-progress": "in_progress",
  wip: "in_progress",
  progress: "in_progress",
  blocked: "blocked",
  done: "done",
  closed: "done",
  up_next: "up_next",
  "up-next": "up_next",
  upnext: "up_next",
  next: "up_next",
};

/**
 * Parse a `--sections` spec (comma/semicolon list) into an ordered, de-duped
 * list of section keys. Empty spec → all sections in default order. An
 * unknown token is a USAGE error rather than a silent drop.
 */
export function parseSections(spec: string | undefined): SectionKey[] {
  if (!spec || !spec.trim()) return [...ALL_SECTIONS];
  const out: SectionKey[] = [];
  for (const raw of spec.split(/[,;]/)) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    const key = SECTION_ALIASES[token];
    if (!key) {
      throw new CommandError(
        `Unknown --sections value '${raw.trim()}'. Valid: in_progress | blocked | done | up_next.`,
        EXIT_CODE.USAGE
      );
    }
    if (!out.includes(key)) out.push(key);
  }
  return out.length > 0 ? out : [...ALL_SECTIONS];
}

/**
 * Parse a `--section-labels` spec overriding section titles (and optionally
 * an emoji). Accepts `key=Label,other=Label2` (comma/semicolon separated).
 * The label value may itself lead with an emoji + space, e.g.
 * `blocked=🔥 On Fire` sets emoji "🔥" and title "On Fire"; a label with no
 * leading emoji keeps the section's default emoji and only changes the title.
 * Keys use the same aliases as `--sections` (wip→in_progress, etc.).
 * Unknown keys are a USAGE error rather than a silent drop.
 */
export function parseSectionLabels(
  spec: string | undefined
): Partial<Record<SectionKey, SectionLabelOverride>> {
  const out: Partial<Record<SectionKey, SectionLabelOverride>> = {};
  if (!spec || !spec.trim()) return out;
  for (const pair of spec.split(/[,;]/)) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const rawKey = pair.slice(0, eq).trim().toLowerCase();
    const rawVal = pair.slice(eq + 1).trim();
    if (!rawKey || !rawVal) continue;
    const key = SECTION_ALIASES[rawKey];
    if (!key) {
      throw new CommandError(
        `Unknown --section-labels key '${rawKey}'. Valid: in_progress | blocked | done | up_next.`,
        EXIT_CODE.USAGE
      );
    }
    // Split on the first space; treat the head as an emoji override only
    // when it carries a non-ASCII codepoint (emoji/symbol). A plain ASCII
    // word is part of the title, so the section keeps its default emoji.
    const spaceIdx = rawVal.indexOf(" ");
    const override: SectionLabelOverride = {};
    if (spaceIdx > 0) {
      const head = rawVal.slice(0, spaceIdx);
      const tail = rawVal.slice(spaceIdx + 1).trim();
      const headHasNonAscii = [...head].some((ch) => ch.codePointAt(0)! > 127);
      if (tail && headHasNonAscii) {
        override.emoji = head;
        override.title = tail;
      } else {
        override.title = rawVal;
      }
    } else {
      override.title = rawVal;
    }
    out[key] = override;
  }
  return out;
}

/**
 * Parse a `--channels` spec (comma/semicolon list) into an ordered, de-duped
 * list of channel targets. Each target is either a Slack channel name
 * (e.g. `#team-eng`) or a full webhook URL — multi-channel posting accepts
 * both (a name is shown in the message; a URL is POSTed to). Empty → [].
 */
export function parseChannels(spec: string | undefined): string[] {
  if (!spec || !spec.trim()) return [];
  const out: string[] = [];
  for (const raw of spec.split(/[,;]/)) {
    const token = raw.trim();
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

/** True when a channel token is a full webhook URL rather than a name. */
export function isWebhookUrl(token: string): boolean {
  return /^https?:\/\//i.test(token.trim());
}

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
export function resolveSinceMs(
  since: string | undefined,
  days: number | undefined,
  now: number = Date.now(),
  warn: (msg: string) => void = (m) => console.error(m)
): number {
  let bound = NaN;
  if (since != null && since.trim() !== "") {
    const ms = Date.parse(since);
    if (isNaN(ms)) {
      warn(
        `warning: ignoring unparseable --since '${since}' (expected an ISO date/time, e.g. 2026-06-01). ` +
          `The Done window from --since is not applied.`
      );
    } else {
      bound = ms;
    }
  }
  if (days != null) {
    if (!Number.isFinite(days) || days < 0) {
      throw new CommandError(`Invalid --days value '${days}' (expected a non-negative number).`, EXIT_CODE.USAGE);
    }
    const daysBound = now - days * 86_400_000;
    bound = isNaN(bound) ? daysBound : Math.max(bound, daysBound);
  }
  return bound;
}

/**
 * Resolve how many "Up Next" items to show. `--all-open` (boolean) wins and
 * returns Infinity (show the whole open backlog). Otherwise `--up-next <n>` is
 * a positive integer count; an absent value uses the default. A non-positive
 * or non-integer `--up-next` is a USAGE error rather than a silent fallback.
 */
export function resolveUpNextCount(
  upNextRaw: string | undefined,
  allOpen: boolean,
  fallback: number = DEFAULT_UP_NEXT
): number {
  if (allOpen) return Infinity;
  if (upNextRaw == null || upNextRaw.trim() === "") return fallback;
  const n = Number(upNextRaw.trim());
  if (!Number.isInteger(n) || n < 1) {
    throw new CommandError(
      `Invalid --up-next value '${upNextRaw}' (expected a positive integer, or use --all-open).`,
      EXIT_CODE.USAGE
    );
  }
  return n;
}

export function parseDays(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) {
    throw new CommandError(`Invalid --days value '${raw}' (expected a number).`, EXIT_CODE.USAGE);
  }
  return n;
}

/**
 * Translate a raw `writeFileSync` failure into a friendly {@link CommandError}
 * (so the exporter aborts with a clean exit 1 + actionable message rather than
 * leaking a Node fs stack trace). Recognizes the common errno cases (missing
 * directory, permission, is-a-directory) and falls back to the raw message.
 */
export function writeError(path: string, err: unknown): CommandError {
  const code = (err as { code?: string } | null)?.code;
  const detail =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  let hint: string;
  if (code === "ENOENT") {
    hint = `the parent directory does not exist — create it first or choose an existing path`;
  } else if (code === "EACCES" || code === "EPERM") {
    hint = `permission denied — check write access to that location`;
  } else if (code === "EISDIR") {
    hint = `that path is a directory, not a file`;
  } else {
    hint = detail;
  }
  return new CommandError(
    `standup export: could not write to '${path}': ${hint}.`,
    EXIT_CODE.GENERIC_FAILURE
  );
}

// ---------------------------------------------------------------------------
// Data fetch
// ---------------------------------------------------------------------------

/**
 * Read every item once via `list-all --json --include-body`, then bucket by
 * status locally. This is a single pm invocation (vs. four list-by-status
 * calls) and gives us bodies + assignee + timestamps for grouping/windowing.
 */
export function fetchAllItems(pmRoot: string): PmItem[] {
  const result = spawnSync(
    "pm",
    ["--path", pmRoot, "list-all", "--json", "--include-body"],
    { encoding: "utf-8" }
  );
  if (result.error || result.status !== 0) {
    console.error(`pm list-all failed: ${result.stderr ?? result.error?.message ?? ""}`);
    return [];
  }
  try {
    return (JSON.parse(result.stdout).items ?? []) as PmItem[];
  } catch (err: unknown) {
    console.error(`pm list-all returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

const WIP_STATUSES = new Set(["in_progress", "wip", "doing"]);
const BLOCKED_STATUSES = new Set(["blocked", "on_hold"]);
const OPEN_STATUSES = new Set(["open", "todo", "new", "draft"]);
const DONE_STATUSES = new Set(["closed", "done", "complete", "completed"]);

function statusOf(item: PmItem): string {
  return (item.status ?? "").trim().toLowerCase();
}

/**
 * True when an item's last activity falls within the [sinceMs, now] window.
 * NaN sinceMs means "no window" → always true.
 */
export function withinWindow(item: PmItem, sinceMs: number): boolean {
  if (isNaN(sinceMs)) return true;
  const ts = Date.parse(item.updated_at ?? item.created_at ?? "");
  return isNaN(ts) ? false : ts >= sinceMs;
}

/**
 * True when an item carries a `blocked_by` dependency, regardless of its
 * status. pm surfaces this either as a top-level `blocked_by` string (item ID
 * or free-text reason) or as one/more `dependencies` entries with
 * `kind: "blocked_by"`. Used to surface impediments that are NOT explicitly
 * status=blocked under the Blocked section.
 */
export function hasBlockedByDep(item: PmItem): boolean {
  const top = item.blocked_by;
  if (typeof top === "string" && top.trim().length > 0) return true;
  const deps = item.dependencies;
  if (Array.isArray(deps)) {
    for (const d of deps) {
      if (d && typeof d.kind === "string" && d.kind.trim().toLowerCase() === "blocked_by") {
        return true;
      }
    }
  }
  return false;
}

export function blockedAgeDays(item: PmItem, now: number = Date.now()): number | undefined {
  if (!BLOCKED_STATUSES.has(statusOf(item)) && !hasBlockedByDep(item)) return undefined;
  const ts = Date.parse(item.updated_at ?? item.created_at ?? "");
  if (isNaN(ts)) return undefined;
  return Math.max(0, Math.floor((now - ts) / 86_400_000));
}

/**
 * Local-day key (YYYY-MM-DD in the host's local timezone) for an item's last
 * activity. Used by the `--yesterday` split. Falls back to created_at, then
 * to the empty string when no timestamp is parseable.
 */
export function localDayKey(item: PmItem): string {
  const ts = Date.parse(item.updated_at ?? item.created_at ?? "");
  if (isNaN(ts)) return "";
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local-day key (YYYY-MM-DD) for a given epoch-ms instant. */
export function localDayKeyOf(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Bucket items into standup sections.
 * `sinceMs` (epoch ms, NaN = no window) filters the Done section to items
 * updated within the window; WIP/blocked/up-next always reflect current state.
 */
export function buildStandupData(
  items: PmItem[],
  opts: StandupOptions,
  sinceMs: number = NaN,
  now: number = Date.now()
): StandupData {
  const isDone = (i: PmItem) => DONE_STATUSES.has(statusOf(i));
  // An item is "blocked" for standup purposes when its status is blocked/
  // on_hold OR it carries a blocked_by dependency — but a done item is never
  // re-surfaced as blocked (a closed impediment is no longer an impediment).
  const isBlocked = (i: PmItem) =>
    !isDone(i) && (BLOCKED_STATUSES.has(statusOf(i)) || hasBlockedByDep(i));

  const wip = items.filter((i) => WIP_STATUSES.has(statusOf(i)) && !isBlocked(i));
  const blocked = items.filter(isBlocked);
  const open = items.filter((i) => OPEN_STATUSES.has(statusOf(i)) && !isBlocked(i));
  const done = opts.includeDone
    ? items.filter((i) => isDone(i) && withinWindow(i, sinceMs))
    : [];

  const sortedOpen = [...open].sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));
  const upNextCount = opts.upNextCount ?? DEFAULT_UP_NEXT;
  const upNext = upNextCount === Infinity ? sortedOpen : sortedOpen.slice(0, upNextCount);

  const data: StandupData = { wip, blocked, done, upNext, total: items.length };

  if (opts.splitYesterday && done.length > 0) {
    const todayKey = localDayKeyOf(now);
    const yesterdayKey = localDayKeyOf(now - 86_400_000);
    data.doneToday = done.filter((i) => localDayKey(i) === todayKey);
    data.doneYesterday = done.filter((i) => localDayKey(i) === yesterdayKey);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Section model
// ---------------------------------------------------------------------------

interface SectionDef {
  key: SectionKey;
  emoji: string;
  title: string;
  items: PmItem[];
  emptyNote: string | null;
  withPriority: boolean;
}

const SECTION_META: Record<
  SectionKey,
  { emoji: string; title: string; emptyNote: string | null; withPriority: boolean }
> = {
  in_progress: { emoji: "🏃", title: "In Progress", emptyNote: "nothing in progress", withPriority: false },
  blocked: { emoji: "🚫", title: "Blocked", emptyNote: "nothing blocked", withPriority: false },
  done: { emoji: "✅", title: "Done", emptyNote: null, withPriority: false },
  up_next: { emoji: "📋", title: "Up Next", emptyNote: null, withPriority: true },
};

/**
 * Apply any `--section-labels` override for `key` to the given emoji/title.
 */
function labeled(
  key: SectionKey,
  emoji: string,
  title: string,
  opts: StandupOptions
): { emoji: string; title: string } {
  const ov = opts.sectionLabels[key];
  if (!ov) return { emoji, title };
  return { emoji: ov.emoji ?? emoji, title: ov.title ?? title };
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
export function resolveSections(data: StandupData, opts: StandupOptions): SectionDef[] {
  const itemsFor: Record<SectionKey, PmItem[]> = {
    in_progress: data.wip,
    blocked: data.blocked,
    done: data.done,
    up_next: data.upNext,
  };
  const alwaysShow: Record<SectionKey, boolean> = {
    in_progress: true,
    blocked: true,
    done: false,
    up_next: false,
  };
  const out: SectionDef[] = [];
  for (const key of opts.sections) {
    const items = itemsFor[key];
    const meta = SECTION_META[key];

    if (key === "done" && opts.splitYesterday && data.doneYesterday && data.doneToday) {
      const subsets: Array<[string, PmItem[]]> = [
        ["Done Yesterday", data.doneYesterday],
        ["Done Today", data.doneToday],
      ];
      // The day distinction owns the title here, so a --section-labels
      // override for `done` contributes only its emoji (not its title).
      const doneEmoji = opts.sectionLabels.done?.emoji ?? meta.emoji;
      for (const [subTitle, subItems] of subsets) {
        if (subItems.length === 0) continue;
        out.push({ key, emoji: doneEmoji, title: subTitle, items: subItems, emptyNote: meta.emptyNote, withPriority: meta.withPriority });
      }
      continue;
    }

    if (!alwaysShow[key] && items.length === 0) continue;
    const { emoji, title } = labeled(key, meta.emoji, meta.title, opts);
    out.push({ key, emoji, title, items, emptyNote: meta.emptyNote, withPriority: meta.withPriority });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function typeLabel(item: PmItem): string {
  if (!item.type) return "";
  const label = item.type.charAt(0).toUpperCase() + item.type.slice(1);
  return `[${label}]`;
}

function mentionFor(item: PmItem, mentionMap: Record<string, string>): string {
  const author = item.assignee ?? item.author;
  if (author && mentionMap[author]) return ` (${mentionMap[author]})`;
  return "";
}

export function itemText(item: PmItem, mentionMap: Record<string, string>, withPriority = false): string {
  const label = typeLabel(item);
  const title = label ? `${label} ${item.title}` : item.title;
  const prio = withPriority && item.priority != null ? ` (priority ${item.priority})` : "";
  const context: string[] = [];
  if (typeof item.blocked_by === "string" && item.blocked_by.trim()) {
    context.push(`blocked by ${item.blocked_by.trim()}`);
  } else if (Array.isArray(item.dependencies)) {
    const blockers = item.dependencies
      .filter((d) => d?.kind?.trim().toLowerCase() === "blocked_by")
      .map((d) => d.id?.trim())
      .filter((id): id is string => Boolean(id));
    if (blockers.length > 0) context.push(`blocked by ${blockers.join(", ")}`);
  }
  const ageDays = blockedAgeDays(item);
  if (ageDays !== undefined && ageDays >= 3) context.push(`stale ${ageDays}d`);
  const blockedContext = context.length > 0 ? ` (${context.join("; ")})` : "";
  return `${title}${prio}${blockedContext}${mentionFor(item, mentionMap)}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Group a list of items by the configured field (assignee, sprint, type or
 * milestone). Items missing the field bucket under a synthetic "_none" key
 * (rendered as a friendly label). Returns entries sorted by group key for
 * stable output.
 */
export function groupItems(items: PmItem[], groupBy: GroupBy): Array<[string, PmItem[]]> {
  const groups = new Map<string, PmItem[]>();
  for (const item of items) {
    let key: string;
    if (groupBy === "assignee") key = item.assignee ?? "_none";
    else if (groupBy === "sprint") key = item.sprint ?? "_none";
    else if (groupBy === "type") key = item.type ?? "_none";
    else if (groupBy === "milestone") key = item.milestone ?? "_none";
    else key = "_none";
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function groupLabel(key: string, groupBy: GroupBy): string {
  if (key !== "_none") return key;
  if (groupBy === "assignee") return "Unassigned";
  if (groupBy === "sprint") return "No sprint";
  if (groupBy === "type") return "Untyped";
  if (groupBy === "milestone") return "(no milestone)";
  return key;
}

const isGrouped = (opts: StandupOptions): boolean => opts.groupBy !== "status";

// ---------------------------------------------------------------------------
// Plain-text / mrkdwn / markdown message (fallback + dry-run preview)
// ---------------------------------------------------------------------------

function bold(text: string, format: Format): string {
  if (format === "slack") return `*${text}*`;
  if (format === "markdown") return `**${text}**`;
  return text;
}

function italic(text: string, format: Format): string {
  if (format === "slack") return `_${text}_`;
  if (format === "markdown") return `_${text}_`;
  return text;
}

function renderSection(lines: string[], def: SectionDef, opts: StandupOptions): void {
  const count = `(${def.items.length})`;
  if (opts.format === "markdown") {
    lines.push(`## ${def.emoji} ${def.title} ${count}`);
  } else {
    lines.push(`${def.emoji} ${bold(def.title, opts.format)} ${count}`);
  }
  if (def.items.length === 0) {
    if (def.emptyNote) {
      const bullet = opts.format === "markdown" ? "- " : "• ";
      lines.push(`${bullet}${italic(def.emptyNote, opts.format)}`);
    }
    return;
  }
  if (isGrouped(opts)) {
    for (const [key, group] of groupItems(def.items, opts.groupBy)) {
      const name = groupLabel(key, opts.groupBy);
      if (opts.format === "markdown") lines.push(`- ${bold(name, opts.format)}`);
      else lines.push(`  ${bold(name, opts.format)}`);
      for (const item of group) {
        const bullet = opts.format === "markdown" ? "  - " : "    • ";
        lines.push(`${bullet}${itemText(item, opts.mentionMap, def.withPriority)}`);
      }
    }
  } else {
    const bullet = opts.format === "markdown" ? "- " : "• ";
    for (const item of def.items) lines.push(`${bullet}${itemText(item, opts.mentionMap, def.withPriority)}`);
  }
}

/**
 * Render the standup as a single text blob for the chosen non-Block-Kit
 * format. `slack` is byte-identical to the historical output (mrkdwn);
 * `plain` drops emphasis punctuation; `markdown` uses `#`/`**`/`-`.
 */
export function buildTextMessage(data: StandupData, opts: StandupOptions): string {
  const lines: string[] = [];
  const dateStr = todayISO();

  if (opts.channel) {
    lines.push(opts.format === "markdown" ? `> Channel: ${opts.channel}` : `> Channel: ${opts.channel}`);
  }
  const title = `📊 ${bold("pm standup", opts.format)} — ${dateStr}`;
  lines.push(opts.format === "markdown" ? `# 📊 pm standup — ${dateStr}` : title);
  lines.push("");

  const sections = resolveSections(data, opts);
  sections.forEach((def, idx) => {
    if (idx > 0) lines.push("");
    renderSection(lines, def, opts);
  });

  // Trend footer (from `--compare`): a single directional summary line.
  if (opts.trend && opts.trend.length > 0) {
    const trendLine = renderTrendLine(opts.trend);
    if (trendLine) {
      lines.push("");
      lines.push(opts.format === "markdown" ? `_${trendLine}_` : trendLine);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Block Kit rendering
// ---------------------------------------------------------------------------

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

function mrkdwnList(items: PmItem[], opts: StandupOptions, withPriority = false): string {
  if (items.length === 0) return "_none_";
  if (isGrouped(opts)) {
    const parts: string[] = [];
    for (const [key, group] of groupItems(items, opts.groupBy)) {
      const name = groupLabel(key, opts.groupBy);
      parts.push(`*${name}*`);
      for (const item of group) parts.push(`• ${itemText(item, opts.mentionMap, withPriority)}`);
    }
    return parts.join("\n");
  }
  return items.map((item) => `• ${itemText(item, opts.mentionMap, withPriority)}`).join("\n");
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
export function buildBlockKit(data: StandupData, opts: StandupOptions): { blocks: SlackBlock[]; fallback: string } {
  const blocks: SlackBlock[] = [];
  const dateStr = todayISO();

  const truncate = (text: string, max: number): string =>
    text.length <= max ? text : text.slice(0, max - 1) + "…";

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: truncate(`📊 pm standup — ${dateStr}`, 150), emoji: true },
  });

  if (opts.channel) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Channel: ${opts.channel}` }],
    });
  }

  for (const def of resolveSections(data, opts)) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(
          `${def.emoji} *${def.title}* (${def.items.length})\n${mrkdwnList(def.items, opts, def.withPriority)}`,
          3000
        ),
      },
    });
  }

  blocks.push({ type: "divider" });
  const groupNote: Record<GroupBy, string | null> = {
    status: null,
    assignee: "grouped by assignee",
    sprint: "grouped by sprint",
    type: "grouped by type",
    milestone: "grouped by milestone",
  };
  const footerBits = [
    `${data.total} item(s) total`,
    opts.since ? `since ${opts.since}` : null,
    groupNote[opts.groupBy],
  ].filter(Boolean);
  const footerElements: Array<{ type: string; text: string }> = [
    { type: "mrkdwn", text: `🤖 pm-slack-standup · ${footerBits.join(" · ")}` },
  ];
  // Trend footer (from `--compare`): a second context element so the
  // directional summary stays visually distinct from the meta line.
  if (opts.trend && opts.trend.length > 0) {
    const trendLine = renderTrendLine(opts.trend);
    if (trendLine) footerElements.push({ type: "mrkdwn", text: trendLine });
  }
  blocks.push({
    type: "context",
    elements: footerElements,
  });

  // Plain-text fallback mirrors the slack-mrkdwn text message.
  const fallback = buildTextMessage(data, { ...opts, format: "slack" });
  return { blocks, fallback };
}

/**
 * Render the standup in whichever `--format` was selected, as the string the
 * command prints (dry-run) or the exporter writes. `blockkit` returns the
 * pretty-printed `{ blocks }` JSON; everything else returns text.
 */
export function renderStandup(data: StandupData, opts: StandupOptions): string {
  if (opts.format === "blockkit") {
    const { blocks } = buildBlockKit(data, opts);
    return JSON.stringify({ blocks }, null, 2);
  }
  return buildTextMessage(data, opts);
}

// ---------------------------------------------------------------------------
// Slack transport
// ---------------------------------------------------------------------------

function postToSlack(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL(webhookUrl);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let respBody = "";
      res.on("data", (chunk: Buffer) => (respBody += chunk.toString()));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolvePromise();
        } else {
          reject(new Error(`Slack webhook returned HTTP ${res.statusCode ?? "unknown"}: ${respBody}`));
        }
      });
    });

    req.on("error", (err: Error) => reject(new Error(`Slack webhook request failed: ${err.message}`)));
    req.setTimeout(10_000, () => req.destroy(new Error("Slack webhook request timed out after 10s")));
    req.write(body);
    req.end();
  });
}

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
export function resolvePostTargets(
  baseWebhook: string,
  baseChannel: string | undefined,
  channels: string[]
): PostTarget[] {
  if (channels.length === 0) {
    return [{ webhookUrl: baseWebhook, channel: baseChannel }];
  }
  const out: PostTarget[] = [];
  const seen = new Set<string>();
  for (const token of channels) {
    const target: PostTarget = isWebhookUrl(token)
      ? { webhookUrl: token, channel: baseChannel }
      : { webhookUrl: baseWebhook, channel: token };
    const dedupeKey = `${target.webhookUrl} ${target.channel ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(target);
  }
  return out;
}

/**
 * Post the standup to every resolved target, re-rendering per target so each
 * channel's message shows its own channel name. Returns a per-target result;
 * never throws — the caller decides how to treat failures (e.g. fallback to
 * stdout). The `poster` is injectable so this is testable without a network.
 */
export async function postStandupTargets(
  targets: PostTarget[],
  data: StandupData,
  baseOpts: StandupOptions,
  poster: Poster
): Promise<PostResultEntry[]> {
  const results: PostResultEntry[] = [];
  for (const target of targets) {
    const opts: StandupOptions = { ...baseOpts, channel: target.channel };
    const { blocks, fallback } = buildBlockKit(data, opts);
    try {
      await poster(target.webhookUrl, { text: fallback, blocks, mrkdwn: true });
      results.push({ channel: target.channel, ok: true });
    } catch (err: unknown) {
      results.push({
        channel: target.channel,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Preflight credential gate
// ---------------------------------------------------------------------------

/**
 * Decide whether the `standup` invocation is actually going to *post* to Slack.
 *
 * The command has two non-posting shapes that must NOT be gated:
 *   - `--dry-run`           : build + print the message, never touches Slack.
 * Every other shape is a real post attempt (the default), including
 * `--fallback-to-stdout` — that flag only means "print instead of erroring *if
 * the network post fails*", it still REQUIRES a webhook to attempt the post.
 */
export function isPostRequested(options: Record<string, unknown>): boolean {
  return !readBoolOption(options, "dry-run");
}

/**
 * Resolve whether a *base* Slack webhook is required for this post. `--channels`
 * may carry full webhook URLs that are self-sufficient targets; but if there is
 * no `--channels` at all, or any `--channels` entry is a bare `#name`, the base
 * webhook (`--webhook` / `PM_SLACK_WEBHOOK`) is needed to actually deliver.
 */
export function needsBaseWebhook(channels: string[]): boolean {
  return channels.length === 0 || channels.some((c) => !isWebhookUrl(c));
}

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
export function preflightSlackCredentials(options: Record<string, unknown>): void {
  if (!isPostRequested(options)) return;

  const webhookUrl =
    readStrOption(options, "webhook") ?? process.env["PM_SLACK_WEBHOOK"] ?? "";
  const channels = parseChannels(readStrOption(options, "channels"));

  if (!webhookUrl && needsBaseWebhook(channels)) {
    throw new CommandError(
      "Slack post requested but no webhook is configured. " +
        "Set PM_SLACK_WEBHOOK or pass --webhook <url> (or provide full webhook " +
        "URLs via --channels). To preview without posting, use --dry-run.",
      EXIT_CODE.USAGE
    );
  }
}

// ---------------------------------------------------------------------------
// Shared option resolution
// ---------------------------------------------------------------------------

/**
 * Resolve every standup option except the render `format`, which differs
 * between the command (slack|blockkit|markdown|plain) and the exporter
 * (md|json file format). Callers supply the format they want.
 */
export function resolveStandupOptions(
  options: Record<string, unknown>,
  format: Format
): {
  opts: StandupOptions;
  sinceMs: number;
} {
  const since = readStrOption(options, "since");
  const days = parseDays(readStrOption(options, "days"));
  const splitYesterday = readBoolOption(options, "yesterday");
  const opts: StandupOptions = {
    channel: readStrOption(options, "channel"),
    format,
    // `--yesterday` is meaningless without a Done section, so it implies
    // `--include-done` (additive: passing only `--include-done` is unchanged).
    includeDone: readBoolOption(options, "include-done") || splitYesterday,
    since,
    groupBy: parseGroupBy(readStrOption(options, "group-by")),
    sections: parseSections(readStrOption(options, "sections")),
    mentionMap: parseMentionMap(readStrOption(options, "mention-map")),
    splitYesterday,
    sectionLabels: parseSectionLabels(readStrOption(options, "section-labels")),
    upNextCount: resolveUpNextCount(
      readStrOption(options, "up-next"),
      readBoolOption(options, "all-open")
    ),
  };
  // `--days` implies windowing the Done section; surface it even without
  // `--include-done` being set so the footer/window stays accurate.
  const sinceMs = resolveSinceMs(since, days);
  return { opts, sinceMs };
}

// ---------------------------------------------------------------------------
// Trend comparison: read a prior standup, compute per-section deltas
// ---------------------------------------------------------------------------

/** Extract the current per-section counts from computed standup data. */
export function currentCounts(data: StandupData): SectionCounts {
  return {
    in_progress: data.wip.length,
    blocked: data.blocked.length,
    done: data.done.length,
    up_next: data.upNext.length,
  };
}

/** A safe non-negative integer count, or undefined when not a usable number. */
function coerceCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/**
 * Parse per-section counts out of a prior standup JSON object. The exporter
 * (`standup export --format json`) writes a top-level `counts` object keyed
 * `wip/blocked/done/upNext`; we also accept the canonical SectionKey spellings
 * (`in_progress`/`up_next`) and a fallback of counting `sections_data`/
 * `sections` arrays. Returns the counts (every section present, missing → 0)
 * or undefined when nothing usable is found, so the caller can warn + skip.
 */
export function extractPriorCounts(parsed: unknown): SectionCounts | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const root = parsed as Record<string, unknown>;

  const fromCountsObject = (obj: unknown): SectionCounts | undefined => {
    if (!obj || typeof obj !== "object") return undefined;
    const c = obj as Record<string, unknown>;
    const inProg = coerceCount(c["in_progress"]) ?? coerceCount(c["wip"]);
    const blocked = coerceCount(c["blocked"]);
    const done = coerceCount(c["done"]);
    const upNext = coerceCount(c["up_next"]) ?? coerceCount(c["upNext"]);
    if (inProg === undefined && blocked === undefined && done === undefined && upNext === undefined) {
      return undefined;
    }
    return { in_progress: inProg ?? 0, blocked: blocked ?? 0, done: done ?? 0, up_next: upNext ?? 0 };
  };

  // Preferred: the exporter's top-level `counts` object.
  const fromCounts = fromCountsObject(root["counts"]);
  if (fromCounts) return fromCounts;

  // Fallback: count the per-section item arrays the exporter also writes.
  const sd = root["sections_data"] ?? root["sections"];
  if (sd && typeof sd === "object" && !Array.isArray(sd)) {
    const s = sd as Record<string, unknown>;
    const len = (k: string, alt?: string): number | undefined => {
      const v = Array.isArray(s[k]) ? (s[k] as unknown[]).length : alt && Array.isArray(s[alt]) ? (s[alt] as unknown[]).length : undefined;
      return v;
    };
    const inProg = len("in_progress", "wip");
    const blocked = len("blocked");
    const done = len("done");
    const upNext = len("up_next", "upNext");
    if (inProg !== undefined || blocked !== undefined || done !== undefined || upNext !== undefined) {
      return { in_progress: inProg ?? 0, blocked: blocked ?? 0, done: done ?? 0, up_next: upNext ?? 0 };
    }
  }
  return undefined;
}

/**
 * Read a prior standup's per-section counts from a local file at `path`.
 * Purely a local file read (no network). Any failure — missing/unreadable
 * file, invalid JSON, or a shape without recognizable counts — emits a single
 * stderr warning via `warn` and returns undefined so the caller renders the
 * standup normally WITHOUT deltas (never throws).
 */
export function readPriorCounts(
  path: string,
  warn: (msg: string) => void = (m) => console.error(m)
): SectionCounts | undefined {
  let raw: string;
  try {
    raw = readFileSync(resolve(path), "utf-8");
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    warn(`warning: --compare '${path}' could not be read (${detail}); rendering standup without trend deltas.`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`warning: --compare '${path}' is not valid JSON; rendering standup without trend deltas.`);
    return undefined;
  }
  const counts = extractPriorCounts(parsed);
  if (!counts) {
    warn(
      `warning: --compare '${path}' has no recognizable standup counts ` +
        `(expected a 'counts' object from 'standup export --format json'); rendering standup without trend deltas.`
    );
    return undefined;
  }
  return counts;
}

/**
 * Compute per-section deltas (current − prior) for every standup section.
 * A positive delta is "up", negative "down", zero "flat". The ordering
 * follows ALL_SECTIONS so output is stable.
 */
export function computeDeltas(prior: SectionCounts, current: SectionCounts): SectionDelta[] {
  return ALL_SECTIONS.map((key) => {
    const p = prior[key] ?? 0;
    const c = current[key] ?? 0;
    const delta = c - p;
    const direction: SectionDelta["direction"] = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    return { key, prior: p, current: c, delta, direction };
  });
}

/** Render one section delta as e.g. "In Progress ▲+2" / "Blocked ▼-1" / "Done →0". */
export function formatDelta(d: SectionDelta): string {
  const glyph = TREND_GLYPH[d.direction];
  const num = d.delta > 0 ? `+${d.delta}` : `${d.delta}`;
  return `${SECTION_META[d.key].title} ${glyph}${num}`;
}

/**
 * Build the one-line trend summary shown in the standup footer, e.g.
 * "Trend vs prior: In Progress ▲+2 · Blocked ▼-1 · Done →0 · Up Next →0".
 * Returns the empty string when there are no deltas to show.
 */
export function renderTrendLine(deltas: SectionDelta[]): string {
  if (deltas.length === 0) return "";
  return `Trend vs prior: ${deltas.map(formatDelta).join(" · ")}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default defineExtension({
  name: "pm-slack-standup",
  version: "2026.6.7",

  activate(api) {
    const standupFlags = [
      { long: "--webhook", value_name: "url", description: "Slack incoming webhook URL (overrides PM_SLACK_WEBHOOK env var)" },
      { long: "--channel", value_name: "name", description: "Channel name shown in the message (e.g. #team-eng)" },
      { long: "--dry-run", description: "Build and print the message in the chosen format WITHOUT posting to Slack" },
      { long: "--format", value_name: "fmt", description: "Output format: slack (mrkdwn, default) | blockkit (JSON) | markdown | plain" },
      { long: "--include-done", description: "Include recently-closed items in a Done section" },
      { long: "--since", value_name: "iso", description: "ISO date/time window; scopes the Done section to items updated since then" },
      { long: "--days", value_name: "n", description: "Relative window: scope Done to items updated in the last N days" },
      { long: "--group-by", value_name: "field", description: "Group section items by status (default) | assignee | sprint | type | milestone" },
      { long: "--up-next", value_name: "n", description: "How many open items the Up Next section shows (default 3)" },
      { long: "--all-open", description: "Show ALL open items in Up Next (no truncation); overrides --up-next" },
      { long: "--sections", value_name: "list", description: "Comma list of sections to render: in_progress,blocked,done,up_next" },
      { long: "--mention-map", value_name: "map", description: "Map pm authors to Slack handles, e.g. 'alice=@alice,bob=@bob'" },
      { long: "--yesterday", description: "Split the Done section into 'Done Yesterday' / 'Done Today' by local day (implies --include-done)" },
      { long: "--channels", value_name: "list", description: "Post the same standup to multiple targets: comma list of #channel names and/or webhook URLs" },
      { long: "--fallback-to-stdout", description: "If the Slack post fails, print the rendered standup to stdout instead of exiting non-zero" },
      { long: "--section-labels", value_name: "map", description: "Override section titles/emoji, e.g. 'in_progress=Rolling,blocked=🔥 On Fire'" },
      { long: "--compare", value_name: "path", description: "Show trend deltas vs a PRIOR standup JSON (from 'standup export --format json'); local file read, never posts" },
    ];

    const runStandupCommand = async (ctx: any) => {
      // Fail-fast credential gate: if a Slack post is actually requested
      // (i.e. NOT --dry-run) but no webhook is configured, abort immediately
      // with a clear, actionable, non-zero error — before reading any pm data
      // or rendering anything. The non-posting --dry-run preview path is never
      // gated, so the legitimate stdout-fallback shape keeps working.
      preflightSlackCredentials(ctx.options);

      const webhookUrl =
        readStrOption(ctx.options, "webhook") ?? process.env["PM_SLACK_WEBHOOK"] ?? "";
      const dryRun = readBoolOption(ctx.options, "dry-run");
      const { opts, sinceMs } = resolveStandupOptions(
        ctx.options,
        parseFormat(readStrOption(ctx.options, "format"))
      );

      const items = fetchAllItems(ctx.pm_root);
      const data = buildStandupData(items, opts, sinceMs);

      // `--compare <path>`: read a PRIOR standup JSON and attach per-section
      // trend deltas. Pure local file read; a missing/malformed/wrong-shape
      // file warns to stderr and leaves `opts.trend` unset (normal render).
      const comparePath = readStrOption(ctx.options, "compare");
      if (comparePath) {
        const prior = readPriorCounts(comparePath);
        if (prior) opts.trend = computeDeltas(prior, currentCounts(data));
      }

      if (dryRun) {
        // No network call happens on this path.
        const rendered = renderStandup(data, opts);
        console.error(`--- DRY RUN (${opts.format}, message not posted) ---`);
        process.stdout.write(rendered + "\n");
        console.error("--- END ---");
        const { blocks, fallback } = buildBlockKit(data, opts);
        return {
          dryRun: true,
          format: opts.format,
          rendered,
          blocks,
          fallback,
          wip: data.wip.length,
          blocked: data.blocked.length,
          done: data.done.length,
          upNext: data.upNext.length,
        };
      }

      const channels = parseChannels(readStrOption(ctx.options, "channels"));
      const fallbackToStdout = readBoolOption(ctx.options, "fallback-to-stdout");

      // Defense-in-depth: the credential preflight above already aborted any
      // post with a missing base webhook. Re-assert here so this branch is
      // never reached with an unusable webhook even if the gate is bypassed.
      if (!webhookUrl && needsBaseWebhook(channels)) {
        throw new CommandError(
          "Slack post requested but no webhook is configured. " +
            "Set PM_SLACK_WEBHOOK or pass --webhook <url>, " +
            "or use --dry-run to preview the message without posting.",
          EXIT_CODE.USAGE
        );
      }

      const targets = resolvePostTargets(webhookUrl, opts.channel, channels);
      const results = await postStandupTargets(targets, data, opts, postToSlack);
      const failures = results.filter((r) => !r.ok);

      if (failures.length > 0 && fallbackToStdout) {
        // Print the rendered standup so the work isn't lost on a transport
        // failure. We exit 0 here: stdout delivery is the requested fallback.
        for (const f of failures) {
          console.error(
            `Slack post to ${f.channel ?? "(default channel)"} failed: ${f.error ?? "unknown error"} — falling back to stdout.`
          );
        }
        const rendered = renderStandup(data, opts);
        process.stdout.write(rendered + "\n");
        return {
          posted: results.some((r) => r.ok),
          fallbackToStdout: true,
          results,
          wip: data.wip.length,
          blocked: data.blocked.length,
          done: data.done.length,
          upNext: data.upNext.length,
        };
      }

      if (failures.length > 0) {
        throw new CommandError(
          `Slack post failed for ${failures.length} of ${targets.length} target(s): ` +
            failures.map((f) => `${f.channel ?? "(default)"}: ${f.error ?? "unknown"}`).join("; "),
          EXIT_CODE.GENERIC_FAILURE
        );
      }

      return {
        posted: true,
        channel: opts.channel,
        channels: targets.length > 1 ? targets.map((t) => t.channel) : undefined,
        wip: data.wip.length,
        blocked: data.blocked.length,
        done: data.done.length,
        upNext: data.upNext.length,
      };
    };

    api.registerCommand({
      name: "standup",
      description: "Post pm context as a rich Slack standup (Block Kit) message",
      intent: "Share current work status (in-progress, blocked, up-next, done) to a Slack channel via webhook",
      examples: [
        "pm standup --webhook https://hooks.slack.com/services/...",
        "pm standup --channel '#team-eng' --dry-run",
        "pm standup --dry-run --format blockkit",
        "pm standup --dry-run --format markdown --include-done --days 7",
        "pm standup --group-by assignee --mention-map 'alice=@alice.s,bob=@bob'",
        "pm standup --group-by sprint --sections in_progress,blocked",
        "pm standup --dry-run --group-by milestone",
        "pm standup --dry-run --up-next 5",
        "pm standup --dry-run --all-open",
        "pm standup --dry-run --yesterday --format plain",
        "pm standup --channels '#team-eng,#standups' --dry-run",
        "pm standup --section-labels 'in_progress=Rolling,blocked=🔥 On Fire' --dry-run",
        "PM_SLACK_WEBHOOK=https://... pm standup --channel '#standups'",
      ],
      flags: standupFlags,
      run: runStandupCommand,
    });

    api.registerCommand({
      name: "slack-standup",
      description: "Alias for `pm standup` (same behavior and flags)",
      intent: "Run the standup workflow using a package-name-aligned command path for agent discoverability",
      examples: [
        "pm slack-standup --dry-run",
        "pm slack-standup --channel '#team-eng' --include-done",
      ],
      flags: standupFlags,
      run: runStandupCommand,
    });

    // -----------------------------------------------------------------------
    // Scoped preflight registration.
    //
    // The authoritative fail-fast credential gate lives in the `standup`
    // command handler (see preflightSlackCredentials) because pm's runtime
    // swallows errors thrown from a registerPreflight override (try/catch →
    // non-fatal warning), so a throw here would NOT abort the command. This
    // registration is therefore a scoped PASS-THROUGH: it surfaces the
    // `preflight` capability and gives the standup command a place to assert
    // credential readiness on the runtime preflight pass, while leaving the
    // runtime's preflight decision untouched (empty delta) for every other
    // command. The hard abort is enforced in the handler.
    // -----------------------------------------------------------------------
    api.registerPreflight((pctx) => {
      if (pctx.command === "standup") {
        // Mirror the handler's contract without aborting here (the runtime
        // swallows throws from preflight). Returning an empty delta is an
        // explicit, scoped pass-through.
        return {};
      }
      return {};
    });

    // -----------------------------------------------------------------------
    // Exporter: standup  →  `pm standup export`
    // Writes the standup to a file (or stdout) as Markdown or JSON. JSON emits
    // the full Block Kit payload so it can be POSTed elsewhere or archived.
    // (No collision with the `pm standup` command — different invocation.)
    // -----------------------------------------------------------------------
    api.registerExporter("standup", async (ctx) => {
      const rawFormat = (readStrOption(ctx.options, "format") ?? "md").toLowerCase();
      // For the exporter, --format selects the file format (md|json); the text
      // rendering is always markdown. We resolve options with markdown rather
      // than routing the exporter's md|json through the command's --format
      // validator (which only knows slack|blockkit|markdown|plain).
      const fileFormat: "md" | "json" = rawFormat === "json" ? "json" : "md";
      const { opts, sinceMs } = resolveStandupOptions(ctx.options, "markdown");
      const exportOpts: StandupOptions = opts;

      const items = fetchAllItems(ctx.pm_root);
      const data = buildStandupData(items, exportOpts, sinceMs);

      let output: string;
      if (fileFormat === "json") {
        const { blocks, fallback } = buildBlockKit(data, opts);
        output = JSON.stringify(
          {
            date: todayISO(),
            channel: opts.channel,
            since: opts.since,
            groupBy: opts.groupBy,
            sections: opts.sections,
            counts: {
              wip: data.wip.length,
              blocked: data.blocked.length,
              done: data.done.length,
              upNext: data.upNext.length,
              total: data.total,
            },
            sections_data: {
              in_progress: data.wip,
              blocked: data.blocked,
              up_next: data.upNext,
              done: data.done,
            },
            slack: { text: fallback, blocks },
          },
          null,
          2
        );
      } else {
        output = buildTextMessage(data, exportOpts);
      }

      const outputPath = readStrOption(ctx.options, "output");
      if (outputPath) {
        const absolutePath = resolve(outputPath);
        try {
          writeFileSync(absolutePath, output + "\n", "utf-8");
        } catch (err: unknown) {
          throw writeError(absolutePath, err);
        }
        console.error(`standup export: wrote ${data.total} item(s) as ${fileFormat} to ${absolutePath}`);
        return { exported: data.total, format: fileFormat, file: absolutePath };
      }

      console.log(output);
      console.error(`standup export: rendered ${data.total} item(s) as ${fileFormat}.`);
      return { exported: data.total, format: fileFormat, output };
    });
  },
});
