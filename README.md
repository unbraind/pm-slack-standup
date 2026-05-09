# pm-ext-slack-standup

A [pm-cli](https://github.com/unbraind/pm-cli) extension that posts your current project context as a formatted Slack standup message.

## Features

- Posts WIP, Blocked, and Up Next items to a Slack channel via incoming webhook
- Optional Done Today section (`--include-done`)
- Dry-run mode to preview the message without posting
- Slack mrkdwn formatting or plain text output
- Channel prefix support
- Webhook URL configurable via flag or environment variable

## Installation

Place the built extension in your pm-cli extensions directory, or install via npm (when published):

```bash
npm install pm-ext-slack-standup
```

Then register it in your pm-cli config.

## Setup

### 1. Create a Slack Incoming Webhook

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create (or select) an app.
2. Under **Incoming Webhooks**, activate and add a new webhook to your workspace.
3. Copy the webhook URL (`https://hooks.slack.com/services/T.../B.../...`).

### 2. Configure the webhook

Either pass it directly as a flag:

```bash
pm standup --webhook https://hooks.slack.com/services/T.../B.../...
```

Or set the environment variable (recommended — add to `.env` or shell profile):

```bash
export PM_SLACK_WEBHOOK=https://hooks.slack.com/services/T.../B.../...
```

## Usage

```
pm standup [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--webhook <url>` | string | — | Slack incoming webhook URL (overrides `PM_SLACK_WEBHOOK`) |
| `--channel <name>` | string | — | Channel name to prepend to the message (e.g. `#team-eng`) |
| `--dry-run` | boolean | `false` | Print the message without posting to Slack |
| `--include-done` | boolean | `false` | Include items with `done` status in a Done Today section |
| `--format <slack\|text>` | string | `slack` | Output format: `slack` uses mrkdwn, `text` is plain |

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
  --webhook https://hooks.slack.com/services/T.../B.../... \
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

1. Fetches items from pm-cli with statuses `wip`, `blocked`, `todo`, and optionally `done`.
2. Sorts `todo` items by priority (ascending) and takes the top 3 as "Up Next".
3. Formats a message using either Slack mrkdwn or plain text.
4. Posts the message to the configured Slack webhook using Node.js native `https`.

## License

MIT
