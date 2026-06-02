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

class CommandError extends Error {
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

interface PmItem {
  id: string;
  title: string;
  status: string;
  type?: string;
  priority?: number;
  tags?: string[];
  milestone?: string;
  assignee?: string;
  body?: string;
  created_at?: string;
  updated_at?: string;
}

type Format = "slack" | "text";
type GroupBy = "status" | "assignee";

interface StandupData {
  wip: PmItem[];
  blocked: PmItem[];
  done: PmItem[];
  upNext: PmItem[];
  total: number;
}

interface StandupOptions {
  channel?: string;
  format: Format;
  includeDone: boolean;
  since?: string;
  groupBy: GroupBy;
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

function readBoolOption(
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

function readStrOption(
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
function parseMentionMap(spec: string | undefined): Record<string, string> {
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

// ---------------------------------------------------------------------------
// Data fetch
// ---------------------------------------------------------------------------

/**
 * Read every item once via `list-all --json --include-body`, then bucket by
 * status locally. This is a single pm invocation (vs. four list-by-status
 * calls) and gives us bodies + assignee + timestamps for grouping/windowing.
 */
function fetchAllItems(pmRoot: string): PmItem[] {
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
 * Bucket items into standup sections.
 * `since` (ISO date/time) filters the Done section to items updated within the
 * window; WIP/blocked/up-next always reflect current state.
 */
function buildStandupData(items: PmItem[], opts: StandupOptions): StandupData {
  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  const withinWindow = (item: PmItem): boolean => {
    if (isNaN(sinceMs)) return true;
    const ts = Date.parse(item.updated_at ?? item.created_at ?? "");
    return isNaN(ts) ? false : ts >= sinceMs;
  };

  const wip = items.filter((i) => WIP_STATUSES.has(statusOf(i)));
  const blocked = items.filter((i) => BLOCKED_STATUSES.has(statusOf(i)));
  const open = items.filter((i) => OPEN_STATUSES.has(statusOf(i)));
  const done = opts.includeDone
    ? items.filter((i) => DONE_STATUSES.has(statusOf(i)) && withinWindow(i))
    : [];

  const upNext = [...open]
    .sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999))
    .slice(0, 3);

  return { wip, blocked, done, upNext, total: items.length };
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
  const author = item.assignee;
  if (author && mentionMap[author]) return ` (${mentionMap[author]})`;
  return "";
}

function itemText(item: PmItem, mentionMap: Record<string, string>, withPriority = false): string {
  const label = typeLabel(item);
  const title = label ? `${label} ${item.title}` : item.title;
  const prio = withPriority && item.priority != null ? ` (priority ${item.priority})` : "";
  return `${title}${prio}${mentionFor(item, mentionMap)}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Group a list of items by assignee. Items with no assignee bucket under
 * "_unassigned". Returns entries sorted by assignee name for stable output.
 */
function groupByAssignee(items: PmItem[]): Array<[string, PmItem[]]> {
  const groups = new Map<string, PmItem[]>();
  for (const item of items) {
    const key = item.assignee ?? "_unassigned";
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(item);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------------------
// Plain-text / mrkdwn message (fallback + dry-run preview)
// ---------------------------------------------------------------------------

function renderSection(
  lines: string[],
  emoji: string,
  title: string,
  items: PmItem[],
  emptyNote: string | null,
  opts: StandupOptions,
  withPriority = false
): void {
  const heading = opts.format === "slack" ? `${emoji} *${title}* (${items.length})` : `${emoji} ${title} (${items.length})`;
  lines.push(heading);
  if (items.length === 0) {
    if (emptyNote) lines.push(opts.format === "slack" ? `• _${emptyNote}_` : `• ${emptyNote}`);
    return;
  }
  if (opts.groupBy === "assignee") {
    for (const [assignee, group] of groupByAssignee(items)) {
      const name = assignee === "_unassigned" ? "Unassigned" : assignee;
      lines.push(opts.format === "slack" ? `  *${name}*` : `  ${name}`);
      for (const item of group) lines.push(`    • ${itemText(item, opts.mentionMap, withPriority)}`);
    }
  } else {
    for (const item of items) lines.push(`• ${itemText(item, opts.mentionMap, withPriority)}`);
  }
}

function buildTextMessage(data: StandupData, opts: StandupOptions): string {
  const lines: string[] = [];
  const dateStr = todayISO();

  if (opts.channel) lines.push(`> Channel: ${opts.channel}`);
  lines.push(opts.format === "slack" ? `📊 *pm standup* — ${dateStr}` : `📊 pm standup — ${dateStr}`);
  lines.push("");

  renderSection(lines, "🏃", "In Progress", data.wip, "nothing in progress", opts);
  lines.push("");
  renderSection(lines, "🚫", "Blocked", data.blocked, "nothing blocked", opts);

  if (data.done.length > 0) {
    lines.push("");
    renderSection(lines, "✅", "Done", data.done, null, opts);
  }
  if (data.upNext.length > 0) {
    lines.push("");
    renderSection(lines, "📋", "Up Next", data.upNext, null, opts, true);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Block Kit rendering
// ---------------------------------------------------------------------------

interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

function mrkdwnList(items: PmItem[], opts: StandupOptions, withPriority = false): string {
  if (items.length === 0) return "_none_";
  if (opts.groupBy === "assignee") {
    const parts: string[] = [];
    for (const [assignee, group] of groupByAssignee(items)) {
      const name = assignee === "_unassigned" ? "Unassigned" : assignee;
      parts.push(`*${name}*`);
      for (const item of group) parts.push(`• ${itemText(item, opts.mentionMap, withPriority)}`);
    }
    return parts.join("\n");
  }
  return items.map((item) => `• ${itemText(item, opts.mentionMap, withPriority)}`).join("\n");
}

/**
 * Build a Slack Block Kit `blocks` array: a header, a section per standup
 * bucket (In Progress / Blocked / Up Next / optional Done) and a context
 * footer. Returns the blocks plus a plain-text `fallback` Slack renders in
 * notifications and old clients.
 */
function buildBlockKit(data: StandupData, opts: StandupOptions): { blocks: SlackBlock[]; fallback: string } {
  const blocks: SlackBlock[] = [];
  const dateStr = todayISO();

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `📊 pm standup — ${dateStr}`, emoji: true },
  });

  if (opts.channel) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Channel: ${opts.channel}` }],
    });
  }

  const section = (emoji: string, title: string, items: PmItem[], withPriority = false): void => {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *${title}* (${items.length})\n${mrkdwnList(items, opts, withPriority)}`,
      },
    });
  };

  section("🏃", "In Progress", data.wip);
  section("🚫", "Blocked", data.blocked);
  section("📋", "Up Next", data.upNext, true);
  if (data.done.length > 0) section("✅", "Done", data.done);

  blocks.push({ type: "divider" });
  const footerBits = [
    `${data.total} item(s) total`,
    opts.since ? `since ${opts.since}` : null,
    opts.groupBy === "assignee" ? "grouped by assignee" : null,
  ].filter(Boolean);
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `🤖 pm-slack-standup · ${footerBits.join(" · ")}` }],
  });

  // Plain-text fallback mirrors the text message (slack mrkdwn variant).
  const fallback = buildTextMessage(data, { ...opts, format: "slack" });
  return { blocks, fallback };
}

// ---------------------------------------------------------------------------
// Slack transport
// ---------------------------------------------------------------------------

function postToSlack(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
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
          resolve();
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

function resolveStandupOptions(options: Record<string, unknown>): StandupOptions {
  const rawFormat = readStrOption(options, "format");
  const rawGroup = readStrOption(options, "group-by");
  return {
    channel: readStrOption(options, "channel"),
    format: rawFormat === "text" ? "text" : "slack",
    includeDone: readBoolOption(options, "include-done"),
    since: readStrOption(options, "since"),
    groupBy: rawGroup === "assignee" ? "assignee" : "status",
    mentionMap: parseMentionMap(readStrOption(options, "mention-map")),
  };
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
        "pm standup --include-done --since 2026-06-01",
        "pm standup --group-by assignee --mention-map 'alice=@alice.s,bob=@bob'",
        "PM_SLACK_WEBHOOK=https://... pm standup --channel '#standups'",
      ],
      flags: [
        { long: "--webhook", value_name: "url", description: "Slack incoming webhook URL (overrides PM_SLACK_WEBHOOK env var)" },
        { long: "--channel", value_name: "name", description: "Channel name shown in the message (e.g. #team-eng)" },
        { long: "--dry-run", description: "Print the message without posting to Slack" },
        { long: "--include-done", description: "Include recently-closed items in a Done section" },
        { long: "--since", value_name: "iso", description: "ISO date/time window; filters the Done section to items updated since then" },
        { long: "--group-by", value_name: "field", description: "Group section items by 'status' (default) or 'assignee'" },
        { long: "--mention-map", value_name: "map", description: "Map pm authors to Slack handles, e.g. 'alice=@alice,bob=@bob'" },
        { long: "--format", value_name: "fmt", description: "Plain-text rendering: 'slack' uses mrkdwn, 'text' is plain (default: slack)" },
      ],

      async run(ctx) {
        const webhookUrl =
          readStrOption(ctx.options, "webhook") ?? process.env["PM_SLACK_WEBHOOK"] ?? "";
        const dryRun = readBoolOption(ctx.options, "dry-run");
        const opts = resolveStandupOptions(ctx.options);

        if (!dryRun && !webhookUrl) {
          // Graceful no-op when no webhook is configured: warn and exit 0 so the
          // command never blocks a workflow on a missing/unset webhook.
          console.error(
            "PM_SLACK_WEBHOOK not set and no --webhook provided — Slack posting disabled. " +
              "Use --dry-run to preview the message."
          );
          return { posted: false, disabled: true, reason: "no-webhook" };
        }

        const items = fetchAllItems(ctx.pm_root);
        const data = buildStandupData(items, opts);
        const { blocks, fallback } = buildBlockKit(data, opts);
        const textPreview = opts.format === "text" ? buildTextMessage(data, opts) : fallback;

        if (dryRun) {
          console.error("--- DRY RUN (message not posted) ---");
          process.stdout.write(textPreview + "\n");
          console.error("--- Block Kit payload ---");
          process.stdout.write(JSON.stringify({ blocks }, null, 2) + "\n");
          console.error("--- END ---");
          return {
            dryRun: true,
            blocks,
            fallback,
            wip: data.wip.length,
            blocked: data.blocked.length,
            done: data.done.length,
            upNext: data.upNext.length,
          };
        }

        try {
          await postToSlack(webhookUrl, { text: fallback, blocks, mrkdwn: true });
        } catch (err: unknown) {
          // Never throw on network failure: warn and exit 0 so a flaky Slack
          // endpoint doesn't break the caller's workflow.
          console.error(
            `Slack post failed (continuing): ${err instanceof Error ? err.message : String(err)}`
          );
          return { posted: false, error: err instanceof Error ? err.message : String(err) };
        }

        return {
          posted: true,
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
      const opts = resolveStandupOptions(ctx.options);
      const rawFormat = (readStrOption(ctx.options, "format") ?? "md").toLowerCase();
      // For the exporter, --format selects the file format (md|json); the
      // mrkdwn-vs-plain text choice is irrelevant here so default text to plain.
      const fileFormat: "md" | "json" = rawFormat === "json" ? "json" : "md";
      const exportOpts: StandupOptions = { ...opts, format: "text" };

      const items = fetchAllItems(ctx.pm_root);
      const data = buildStandupData(items, exportOpts);

      let output: string;
      if (fileFormat === "json") {
        const { blocks, fallback } = buildBlockKit(data, opts);
        output = JSON.stringify(
          {
            date: todayISO(),
            channel: opts.channel,
            since: opts.since,
            groupBy: opts.groupBy,
            counts: {
              wip: data.wip.length,
              blocked: data.blocked.length,
              done: data.done.length,
              upNext: data.upNext.length,
              total: data.total,
            },
            sections: {
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
        // Markdown: reuse the plain-text renderer, upgrade headings to `##`.
        const md = buildTextMessage(data, exportOpts)
          .replace(/^📊 pm standup — (.+)$/m, "# pm standup — $1")
          .replace(/^(🏃|🚫|✅|📋) (.+)$/gm, "## $1 $2");
        output = md;
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
