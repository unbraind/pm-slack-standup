# pm-slack-standup

A [pm-cli](https://github.com/unbraind/pm-cli) extension that posts your current project context as a formatted Slack standup message.

## Features

- Posts WIP, Blocked, Up Next (and optional Done) items to Slack as a rich **Block Kit** message (header, one section per bucket, context footer) with an automatic plain-text fallback
- **Four output formats** (`--format`): `slack` (Slack mrkdwn, the default), `blockkit` (the raw Block Kit `blocks` JSON), `markdown` (GitHub/CommonMark), and `plain` text
- **`--dry-run`** — build and print the message in the chosen format **without** posting to Slack (no network call is made)
- Group section items by `status` (default), `assignee`, `sprint`, or `type` (`--group-by`)
- Choose which sections to render and in what order with `--sections` (`in_progress`, `blocked`, `done`, `up_next`); a dedicated **Blocked** section always surfaces blocked items
- **Impediment inference** — the Blocked section surfaces not only `status=blocked` items but any open/in-progress item carrying a `blocked_by` dependency (top-level or in `dependencies[]`), so dependency-blocked work is never hidden
- **Yesterday/Today split** (`--yesterday`) — split the Done section into **Done Yesterday** / **Done Today** by the local-day boundary (implies `--include-done`)
- **Multi-channel posting** (`--channels #a,#b`) — post the same standup to several channel names and/or webhook URLs in one run, each message labelled with its own channel
- **`--fallback-to-stdout`** — if a Slack post fails, print the rendered standup to stdout (exit 0) instead of erroring out, so the work isn't lost on a transport failure
- **Custom section labels** (`--section-labels`) — override any section's title and/or emoji, e.g. `in_progress=Rolling,blocked=🔥 On Fire`
- Scope the "recently closed / Done" window with `--since <iso>` **or** `--days <n>` (relative)
- Map pm authors to Slack handles so they get mentioned (`--mention-map`)
- `pm standup export` — write the standup to a file as Markdown or JSON (the JSON form includes the full Block Kit payload for archiving or re-posting)
- `--channel` override; webhook URL configurable via flag or environment variable. A real post with **no webhook configured** fails with a clear, structured error (exit 1) rather than crashing — use `--dry-run` to preview without credentials

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
| `--dry-run` | boolean | `false` | Build and print the message in the chosen format **without** posting |
| `--format <fmt>` | string | `slack` | Output format: `slack` (mrkdwn) \| `blockkit` (JSON) \| `markdown` \| `plain` |
| `--include-done` | boolean | `false` | Include recently-closed items in a Done section |
| `--since <iso>` | string | — | ISO date/time window; scopes the Done section to items updated since then |
| `--days <n>` | number | — | Relative window: scope Done to items updated in the last N days (combines with `--since`, more restrictive bound wins) |
| `--group-by <field>` | string | `status` | Group section items by `status` \| `assignee` \| `sprint` \| `type` |
| `--sections <list>` | string | all | Comma list of sections to render/order: `in_progress`, `blocked`, `done`, `up_next` |
| `--mention-map <map>` | string | — | Map pm authors to Slack handles, e.g. `alice=@alice,bob=@bob` |
| `--yesterday` | boolean | `false` | Split Done into **Done Yesterday** / **Done Today** by local day (implies `--include-done`) |
| `--channels <list>` | string | — | Post the same standup to multiple targets: comma list of `#channel` names and/or full webhook URLs |
| `--fallback-to-stdout` | boolean | `false` | If the Slack post fails, print the rendered standup to stdout (exit 0) instead of erroring |
| `--section-labels <map>` | string | — | Override section titles/emoji, e.g. `in_progress=Rolling,blocked=🔥 On Fire` |

> **Note on `text`:** the legacy `--format text` value is still accepted as an alias for `plain`.

### Output formats

`--format` selects what the command prints (in `--dry-run`) and how it renders the Slack message text:

- **`slack`** (default) — Slack mrkdwn (`*bold*`, `_italic_`). The message posted to Slack is unchanged from previous versions.
- **`blockkit`** — the raw Slack Block Kit `{ "blocks": [...] }` JSON, ready to POST to `chat.postMessage` or paste into Block Kit Builder.
- **`markdown`** — GitHub/CommonMark with `#`/`##` headings and `-` bullets, for issues, wikis, or PR comments.
- **`plain`** — emphasis-free plain text for email or terminals.

```bash
pm standup --dry-run --format blockkit                 # raw Block Kit JSON
pm standup --dry-run --format markdown --include-done   # CommonMark
pm standup --dry-run --format plain --days 7            # plain text, last 7 days
```

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
pm standup --include-done --format plain
```

**Group by sprint, only In Progress + Blocked:**
```bash
pm standup --dry-run --group-by sprint --sections in_progress,blocked
```

**Split Done by yesterday/today:**
```bash
pm standup --dry-run --yesterday --format plain
```

**Post to multiple channels at once:**
```bash
pm standup --channels '#team-eng,#standups'
pm standup --channels 'https://hooks.slack.com/services/AAA,https://hooks.slack.com/services/BBB'
```

**Never lose the standup if Slack is down:**
```bash
pm standup --fallback-to-stdout   # prints the message to stdout (exit 0) if the post fails
```

**Rename sections / change emoji:**
```bash
pm standup --dry-run --section-labels 'in_progress=Rolling,blocked=🔥 On Fire'
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

### Plain Text (`--format plain`)

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

1. Reads every item once via `pm --path <root> list-all --json --include-body` and buckets them locally into In Progress, Blocked, open (Up Next) and optionally Done. Any open/in-progress item with a `blocked_by` dependency (top-level or in `dependencies[]`) is re-bucketed into Blocked; closed items are never re-surfaced as blocked.
2. Sorts open items by priority (ascending) and takes the top 3 as "Up Next".
3. Builds a Slack Block Kit `blocks` array (header + a section per bucket + context footer) plus a plain-text `fallback`, optionally grouped by assignee and annotated with Slack mentions. Section titles/emoji can be overridden with `--section-labels`, and `--yesterday` expands Done into Done Yesterday / Done Today.
4. In `--dry-run`, prints the message in the chosen `--format` and exits without any network call. Otherwise posts `{ text, blocks }` to each target (the base webhook plus any `--channels`) using Node.js native `https`. A missing webhook (on a real post) raises a structured `CommandError`; a failed post does too **unless** `--fallback-to-stdout` is set, in which case the rendered standup is printed to stdout and the command exits 0.

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.
