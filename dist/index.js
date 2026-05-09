import https from "node:https";
import { defineExtension } from "@unbrained/pm-cli/sdk";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function typeLabel(item) {
    if (!item.type)
        return "";
    const label = item.type.charAt(0).toUpperCase() + item.type.slice(1);
    return `[${label}]`;
}
function itemLine(item, format) {
    const label = typeLabel(item);
    const title = label ? `${label} ${item.title}` : item.title;
    return format === "slack" ? `• ${title}` : `• ${title}`;
}
function todayISO() {
    return new Date().toISOString().slice(0, 10);
}
function buildMessage(wip, blocked, done, upNext, opts) {
    const { format } = opts;
    const lines = [];
    // Header
    const dateStr = todayISO();
    if (format === "slack") {
        lines.push(`📊 *pm standup* — ${dateStr}`);
    }
    else {
        lines.push(`📊 pm standup — ${dateStr}`);
    }
    // Channel prefix (prepended at the very top when posting to Slack)
    // It's added to the message body so dry-run also shows it.
    if (opts.channel) {
        lines.unshift(`> Channel: ${opts.channel}`);
    }
    lines.push("");
    // In Progress
    if (format === "slack") {
        lines.push(`🏃 *In Progress* (${wip.length})`);
    }
    else {
        lines.push(`🏃 In Progress (${wip.length})`);
    }
    if (wip.length === 0) {
        lines.push("• _nothing in progress_");
    }
    else {
        for (const item of wip)
            lines.push(itemLine(item, format));
    }
    lines.push("");
    // Blocked
    if (format === "slack") {
        lines.push(`🚫 *Blocked* (${blocked.length})`);
    }
    else {
        lines.push(`🚫 Blocked (${blocked.length})`);
    }
    if (blocked.length === 0) {
        lines.push("• _nothing blocked_");
    }
    else {
        for (const item of blocked)
            lines.push(itemLine(item, format));
    }
    // Done Today (optional)
    if (done.length > 0) {
        lines.push("");
        if (format === "slack") {
            lines.push(`✅ *Done Today* (${done.length})`);
        }
        else {
            lines.push(`✅ Done Today (${done.length})`);
        }
        for (const item of done)
            lines.push(itemLine(item, format));
    }
    // Up Next
    if (upNext.length > 0) {
        lines.push("");
        if (format === "slack") {
            lines.push(`📋 *Up Next* (${upNext.length})`);
        }
        else {
            lines.push(`📋 Up Next (${upNext.length})`);
        }
        upNext.forEach((item, i) => {
            const label = typeLabel(item);
            const title = label ? `${label} ${item.title}` : item.title;
            const prio = item.priority != null ? ` (priority ${item.priority})` : "";
            lines.push(`• ${title}${prio}`);
        });
    }
    return lines.join("\n");
}
function postToSlack(webhookUrl, text) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ text, mrkdwn: true });
        const url = new URL(webhookUrl);
        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
            },
        };
        const req = https.request(options, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk.toString()));
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve();
                }
                else {
                    reject(new Error(`Slack webhook returned HTTP ${res.statusCode ?? "unknown"}: ${body}`));
                }
            });
        });
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default defineExtension({
    name: "pm-ext-slack-standup",
    version: "0.1.0",
    activate(api) {
        api.registerCommand({
            name: "standup",
            description: "Post pm context as a Slack standup message",
            intent: "Share current work status (in-progress, blocked, up-next) to a Slack channel via webhook",
            examples: [
                "pm standup --webhook https://hooks.slack.com/services/...",
                "pm standup --channel '#team-eng' --dry-run",
                "pm standup --include-done --format text",
                "PM_SLACK_WEBHOOK=https://... pm standup --channel '#standups'",
            ],
            flags: {
                webhook: {
                    type: "string",
                    description: "Slack incoming webhook URL (overrides PM_SLACK_WEBHOOK env var)",
                },
                channel: {
                    type: "string",
                    description: "Channel name to prepend to the standup message (e.g. #team-eng)",
                },
                "dry-run": {
                    type: "boolean",
                    description: "Print the message without posting to Slack",
                    default: false,
                },
                "include-done": {
                    type: "boolean",
                    description: "Include items with 'done' status in a Done Today section",
                    default: false,
                },
                format: {
                    type: "string",
                    description: "Output format: 'slack' uses mrkdwn bold/italic, 'text' is plain (default: slack)",
                    default: "slack",
                },
            },
            async run(ctx) {
                const args = ctx.args;
                // Resolve webhook
                const webhookUrl = args.webhook ?? process.env["PM_SLACK_WEBHOOK"] ?? "";
                const dryRun = args["dry-run"] ?? false;
                const includeDone = args["include-done"] ?? false;
                const format = args.format === "text" ? "text" : "slack";
                const channel = args.channel;
                if (!dryRun && !webhookUrl) {
                    ctx.log.info("No webhook URL provided. Set --webhook or PM_SLACK_WEBHOOK env var, or use --dry-run.");
                    return { error: "missing_webhook" };
                }
                // Fetch items
                ctx.log.info("Fetching pm items…");
                const [wipItems, blockedItems, todoItems, doneItems] = await Promise.all([
                    ctx.pm.listItems({ status: "wip" }),
                    ctx.pm.listItems({ status: "blocked" }),
                    ctx.pm.listItems({ status: "todo" }),
                    includeDone ? ctx.pm.listItems({ status: "done" }) : Promise.resolve([]),
                ]);
                // Sort todo by priority (lower number = higher priority), take top 3
                const upNext = [...todoItems]
                    .sort((a, b) => {
                    const pa = a.priority ?? 9999;
                    const pb = b.priority ?? 9999;
                    return pa - pb;
                })
                    .slice(0, 3);
                const message = buildMessage(wipItems, blockedItems, doneItems, upNext, { channel, format, includeDate: true });
                if (dryRun) {
                    ctx.log.info("--- DRY RUN (message not posted) ---");
                    ctx.log.info(message);
                    ctx.log.info("--- END ---");
                    return {
                        dryRun: true,
                        message,
                        wip: wipItems.length,
                        blocked: blockedItems.length,
                        done: doneItems.length,
                        upNext: upNext.length,
                    };
                }
                ctx.log.info("Posting standup to Slack…");
                await postToSlack(webhookUrl, message);
                ctx.log.info("Standup posted successfully.");
                return {
                    posted: true,
                    wip: wipItems.length,
                    blocked: blockedItems.length,
                    done: doneItems.length,
                    upNext: upNext.length,
                };
            },
        });
    },
});
//# sourceMappingURL=index.js.map