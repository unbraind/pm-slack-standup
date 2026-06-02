# pm-slack-standup

A [pm-cli](https://github.com/unbraind/pm-cli) extension that posts your current project context as a formatted Slack standup message.

## Features

- Posts WIP, Blocked, Up Next (and optional Done) items to Slack as a rich **Block Kit** message (header, one section per bucket, context footer) with an automatic plain-text fallback
- `pm standup export` — write the standup to a file as Markdown or JSON (the JSON form includes the full Block Kit payload for archiving or re-posting)
- Group section items by `status` (default) or `assignee` (`--group-by`)
- Map pm authors to Slack handles so they get mentioned (`--mention-map`)
- Restrict the Done section to a recent window (`--since <iso>`, with `--include-done`)
- Dry-run mode to preview both the rendered message and the Block Kit JSON
- Webhook URL configurable via flag or environment variable; missing webhook is a graceful no-op (never blocks a workflow)

## Installation

```bash
pm install github.com/unbraind/pm-slack-standup --global
```

Or install per-project:

```bash
pm install github.com/unbraind/pm-slack-standup --project
```

## Setup

### 1. Create a Slack Incoming Webhook

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create (or select) an app.
2. Under **Incoming Webhooks**, activate and add a new webhook to your workspace.
3. Copy the webhook URL into your shell environment.

### 2. Configure the webhook

Either pass it directly as a flag:

```bash
pm standup --webhook <slack-webhook-url>
```

Or set the environment variable (recommended — add to `.env` or shell profile):

```bash
export PM_SLACK_WEBHOOK=<slack-webhook-url>
```

## Usage

```
pm standup [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--webhook <url>` | string | — | Slack incoming webhook URL (overrides `PM_SLACK_WEBHOOK`) |
| `--channel <name>` | string | — | Channel name shown in the message (e.g. `#team-eng`) |
| `--dry-run` | boolean | `false` | Print the rendered message and the Block Kit JSON without posting |
| `--include-done` | boolean | `false` | Include recently-closed items in a Done section |
| `--since <iso>` | string | — | ISO date/time window; filters the Done section to items updated since then |
| `--group-by <status\|assignee>` | string | `status` | Group section items by status (default) or assignee |
| `--mention-map <map>` | string | — | Map pm authors to Slack handles, e.g. `alice=@alice,bob=@bob` |
| `--format <slack\|text>` | string | `slack` | Plain-text rendering used for the fallback / preview |

## Export

`pm standup export` writes the standup to a file (or stdout) instead of posting it to Slack:

```bash
pm standup export --format md   --output standup.md --include-done
pm standup export --format json --output standup.json --group-by assignee
pm standup export                       # Markdown to stdout
```

| Flag | Default | Description |
|------|---------|-------------|
| `--format <md\|json>` | `md` | File format. `json` includes the full Block Kit payload under `slack.blocks` |
| `--output <file>` | stdout | Output file path |

The `--since`, `--group-by`, `--include-done`, `--channel` and `--mention-map` flags above also apply to the export.

### Examples

**Basic standup (webhook from env):**
```bash
pm standup
```

**Post to a specific channel with dry-run preview:**
```bash
pm standup --channel '#team-eng' --dry-run
```

**Include done items and use plain text format:**
```bash
pm standup --include-done --format text
```

**Full explicit invocation:**
```bash
pm standup \
  --webhook <slack-webhook-url> \
  --channel '#standups' \
  --include-done
```

## Message Format

### Slack (mrkdwn)

```
> Channel: #team-eng

📊 *pm standup* — 2026-05-09

🏃 *In Progress* (2)
• [Epic] Dashboard redesign
• [Feature] User auth flow

🚫 *Blocked* (1)
• [Issue] Login redirect bug

✅ *Done Today* (1)
• [Task] Write unit tests

📋 *Up Next* (3)
• [Feature] Email notifications (priority 1)
• [Task] Write API tests (priority 2)
• [Chore] Update dependencies (priority 3)
```

### Plain Text (`--format text`)

```
📊 pm standup — 2026-05-09

🏃 In Progress (2)
• [Epic] Dashboard redesign
• [Feature] User auth flow

🚫 Blocked (1)
• [Issue] Login redirect bug

📋 Up Next (3)
• [Feature] Email notifications (priority 1)
• [Task] Write API tests (priority 2)
• [Chore] Update dependencies (priority 3)
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PM_SLACK_WEBHOOK` | Slack incoming webhook URL (used when `--webhook` flag is not provided) |

## Building

```bash
npm install
npm run build
```

This compiles `index.ts` to `dist/index.js`.

## Development

```bash
npm run dev   # watch mode
```

## How It Works

1. Reads every item once via `pm --path <root> list-all --json --include-body` and buckets them locally into In Progress, Blocked, open (Up Next) and optionally Done.
2. Sorts open items by priority (ascending) and takes the top 3 as "Up Next".
3. Builds a Slack Block Kit `blocks` array (header + a section per bucket + context footer) plus a plain-text `fallback`, optionally grouped by assignee and annotated with Slack mentions.
4. Posts `{ text, blocks }` to the configured Slack webhook using Node.js native `https`. A missing webhook or a network failure is a non-blocking no-op (warns and exits 0).

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.
