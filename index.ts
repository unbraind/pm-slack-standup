import https from "node:https";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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

// The text/preview renderer: `slack` uses Slack mrkdwn (`*bold*`), `plain` is
// punctuation-free plain text, `markdown` is GitHub/CommonMark (`**bold**`,
// `#` headings), and `blockkit` emits the Slack Block Kit `blocks` array JSON.
export type Format = "slack" | "blockkit" | "markdown" | "plain";
export type GroupBy = "status" | "assignee" | "sprint" | "type";
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
  throw new CommandError(
    `Unknown --group-by '${raw}'. Valid: status | assignee | sprint | type.`,
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
 * Resolve the "recently closed" window start (ms epoch) from `--since` and/or
 * `--days`. `--since` is an explicit ISO date/time; `--days <n>` is N days
 * before now. If both are given the *later* (more restrictive) bound wins.
 * Returns NaN when neither is set (no windowing). Invalid input → USAGE error.
 */
export function resolveSinceMs(
  since: string | undefined,
  days: number | undefined,
  now: number = Date.now()
): number {
  let bound = NaN;
  if (since != null) {
    const ms = Date.parse(since);
    if (isNaN(ms)) {
      throw new CommandError(`Invalid --since value '${since}' (expected an ISO date/time).`, EXIT_CODE.USAGE);
    }
    bound = ms;
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

export function parseDays(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) {
    throw new CommandError(`Invalid --days value '${raw}' (expected a number).`, EXIT_CODE.USAGE);
  }
  return n;
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
 * Bucket items into standup sections.
 * `sinceMs` (epoch ms, NaN = no window) filters the Done section to items
 * updated within the window; WIP/blocked/up-next always reflect current state.
 */
export function buildStandupData(
  items: PmItem[],
  opts: StandupOptions,
  sinceMs: number = NaN
): StandupData {
  const wip = items.filter((i) => WIP_STATUSES.has(statusOf(i)));
  const blocked = items.filter((i) => BLOCKED_STATUSES.has(statusOf(i)));
  const open = items.filter((i) => OPEN_STATUSES.has(statusOf(i)));
  const done = opts.includeDone
    ? items.filter((i) => DONE_STATUSES.has(statusOf(i)) && withinWindow(i, sinceMs))
    : [];

  const upNext = [...open]
    .sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999))
    .slice(0, 3);

  return { wip, blocked, done, upNext, total: items.length };
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
 * Resolve the ordered, selected section definitions for the given data.
 * `in_progress` and `blocked` always render (even empty, with their note);
 * `done` and `up_next` only render when they hold items — preserving the
 * historical message shape. `--sections` filters which keys are eligible.
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
    if (!alwaysShow[key] && items.length === 0) continue;
    const meta = SECTION_META[key];
    out.push({ key, emoji: meta.emoji, title: meta.title, items, emptyNote: meta.emptyNote, withPriority: meta.withPriority });
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
  return `${title}${prio}${mentionFor(item, mentionMap)}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Group a list of items by the configured field (assignee, sprint or type).
 * Items missing the field bucket under a synthetic "_none" key (rendered as a
 * friendly label). Returns entries sorted by group key for stable output.
 */
export function groupItems(items: PmItem[], groupBy: GroupBy): Array<[string, PmItem[]]> {
  const groups = new Map<string, PmItem[]>();
  for (const item of items) {
    let key: string;
    if (groupBy === "assignee") key = item.assignee ?? "_none";
    else if (groupBy === "sprint") key = item.sprint ?? "_none";
    else if (groupBy === "type") key = item.type ?? "_none";
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
  };
  const footerBits = [
    `${data.total} item(s) total`,
    opts.since ? `since ${opts.since}` : null,
    groupNote[opts.groupBy],
  ].filter(Boolean);
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `🤖 pm-slack-standup · ${footerBits.join(" · ")}` }],
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
  const opts: StandupOptions = {
    channel: readStrOption(options, "channel"),
    format,
    includeDone: readBoolOption(options, "include-done"),
    since,
    groupBy: parseGroupBy(readStrOption(options, "group-by")),
    sections: parseSections(readStrOption(options, "sections")),
    mentionMap: parseMentionMap(readStrOption(options, "mention-map")),
  };
  // `--days` implies windowing the Done section; surface it even without
  // `--include-done` being set so the footer/window stays accurate.
  const sinceMs = resolveSinceMs(since, days);
  return { opts, sinceMs };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default defineExtension({
  name: "pm-slack-standup",
  version: "2026.6.2",

  activate(api) {
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
        "PM_SLACK_WEBHOOK=https://... pm standup --channel '#standups'",
      ],
      flags: [
        { long: "--webhook", value_name: "url", description: "Slack incoming webhook URL (overrides PM_SLACK_WEBHOOK env var)" },
        { long: "--channel", value_name: "name", description: "Channel name shown in the message (e.g. #team-eng)" },
        { long: "--dry-run", description: "Build and print the message in the chosen format WITHOUT posting to Slack" },
        { long: "--format", value_name: "fmt", description: "Output format: slack (mrkdwn, default) | blockkit (JSON) | markdown | plain" },
        { long: "--include-done", description: "Include recently-closed items in a Done section" },
        { long: "--since", value_name: "iso", description: "ISO date/time window; scopes the Done section to items updated since then" },
        { long: "--days", value_name: "n", description: "Relative window: scope Done to items updated in the last N days" },
        { long: "--group-by", value_name: "field", description: "Group section items by status (default) | assignee | sprint | type" },
        { long: "--sections", value_name: "list", description: "Comma list of sections to render: in_progress,blocked,done,up_next" },
        { long: "--mention-map", value_name: "map", description: "Map pm authors to Slack handles, e.g. 'alice=@alice,bob=@bob'" },
      ],

      async run(ctx) {
        const webhookUrl =
          readStrOption(ctx.options, "webhook") ?? process.env["PM_SLACK_WEBHOOK"] ?? "";
        const dryRun = readBoolOption(ctx.options, "dry-run");
        const { opts, sinceMs } = resolveStandupOptions(
          ctx.options,
          parseFormat(readStrOption(ctx.options, "format"))
        );

        const items = fetchAllItems(ctx.pm_root);
        const data = buildStandupData(items, opts, sinceMs);

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

        // Real post path: a missing webhook is a hard, structured error (exit 1)
        // rather than a crash or silent success. Use --dry-run to preview.
        if (!webhookUrl) {
          throw new CommandError(
            "No Slack webhook configured. Set PM_SLACK_WEBHOOK or pass --webhook <url>, " +
              "or use --dry-run to preview the message without posting.",
            EXIT_CODE.GENERIC_FAILURE
          );
        }

        const { blocks, fallback } = buildBlockKit(data, opts);
        try {
          await postToSlack(webhookUrl, { text: fallback, blocks, mrkdwn: true });
        } catch (err: unknown) {
          throw new CommandError(
            `Slack post failed: ${err instanceof Error ? err.message : String(err)}`,
            EXIT_CODE.GENERIC_FAILURE
          );
        }

        return {
          posted: true,
          channel: opts.channel,
          wip: data.wip.length,
          blocked: data.blocked.length,
          done: data.done.length,
          upNext: data.upNext.length,
        };
      },
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
        writeFileSync(absolutePath, output + "\n", "utf-8");
        console.error(`standup export: wrote ${data.total} item(s) as ${fileFormat} to ${absolutePath}`);
        return { exported: data.total, format: fileFormat, file: absolutePath };
      }

      console.log(output);
      console.error(`standup export: rendered ${data.total} item(s) as ${fileFormat}.`);
      return { exported: data.total, format: fileFormat, output };
    });
  },
});
