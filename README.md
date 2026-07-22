# pm-slack-standup

A [pm-cli](https://github.com/unbraind/pm-cli) extension that posts your current project context as a formatted Slack standup message.

## Features

- Posts WIP, Blocked, Up Next (and optional Done) items to Slack as a rich **Block Kit** message (header, one section per bucket, context footer) with an automatic plain-text fallback
- **Four output formats** (`--format`): `slack` (Slack mrkdwn, the default), `blockkit` (the raw Block Kit `blocks` JSON), `markdown` (GitHub/CommonMark), and `plain` text
- **`--dry-run`** — build and print the message in the chosen format **without** posting to Slack (no network call is made)
- Group section items by `status` (default), `assignee`, `sprint`, `type`, or `milestone` (`--group-by`); items without the field bucket under a friendly fallback label (e.g. `(no milestone)`)
- **Configurable "Up Next" size** — `--up-next <n>` sets how many open items the Up Next section shows (default 3), or `--all-open` shows the **entire** open backlog so nothing is silently truncated
- Choose which sections to render and in what order with `--sections` (`in_progress`, `blocked`, `done`, `up_next`); a dedicated **Blocked** section always surfaces blocked items
- **Impediment inference** — the Blocked section surfaces not only `status=blocked` items but any open/in-progress item carrying a `blocked_by` dependency (top-level or in `dependencies[]`), so dependency-blocked work is never hidden
- **Blocked-work context** — blocked/dependency-blocked rows include the blocker id/reason and mark blockers stale after 3+ days since last activity
- **Yesterday/Today split** (`--yesterday`) — split the Done section into **Done Yesterday** / **Done Today** by the local-day boundary (implies `--include-done`)
- **Multi-channel posting** (`--channels #a,#b`) — post the same standup to several channel names and/or webhook URLs in one run, each message labelled with its own channel
- **`--fallback-to-stdout`** — if a Slack post fails, print the rendered standup to stdout (exit 0) instead of erroring out, so the work isn't lost on a transport failure
- **Custom section labels** (`--section-labels`) — override any section's title and/or emoji, e.g. `in_progress=Rolling,blocked=🔥 On Fire`
- **Trend deltas** (`--compare <path>`) — show momentum vs. a **prior** standup. Point `--compare` at a JSON file previously written by `pm standup export --format json`; the footer gains a one-line summary with directional indicators per section (`▲` up / `▼` down / `→` flat) and the numeric delta, e.g. `Trend vs prior: In Progress ▲+2 · Blocked ▼-1 · Done →0 · Up Next →0`. It is a **purely local file read** (no extra network), and a missing/unreadable/wrong-shape file degrades gracefully — a one-line stderr warning, then the standup renders normally **without** deltas (never crashes)
- Scope the "recently closed / Done" window with `--since <iso>` **or** `--days <n>` (relative). An **unparseable `--since`** (e.g. a typo) is not silently ignored — it emits a warning and the `--since` window is dropped, so the mistake surfaces loudly
- **Friendly export errors** — `pm standup export --output <path>` that cannot be written (missing directory, permission denied, etc.) aborts with a clear, actionable message and a clean non-zero exit instead of leaking a raw Node fs stack trace
- Map pm authors to Slack handles so they get mentioned (`--mention-map`)
- `pm standup export` — write the standup to a file as Markdown or JSON (the JSON form includes the full Block Kit payload for archiving or re-posting). **Stdout export is round-trip safe**: with no `--output`, stdout carries only the exported document (valid JSON/Markdown, no pm result envelope), so `pm standup export --format json > prev.json` pipes cleanly into `--compare` or `jq`
- **Multi-snapshot history** — `pm standup export --history-dir <dir>` accumulates one dated JSON snapshot per day, and `pm standup --compare <dir>` renders the whole window as per-section count sequences (e.g. `History (3 snapshots → now): In Progress 0→1→2→2 · …`) in addition to the trend deltas vs the newest snapshot. See [Multi-snapshot history](#multi-snapshot-history)
- `--channel` override; webhook URL configurable via flag or environment variable
- **Fail-fast credential preflight** — when you actually request a Slack post (anything other than `--dry-run`) but no webhook is configured, the command aborts **immediately** with a clear, actionable, non-zero error (exit 2) **before** reading any pm data or rendering anything — no half-built message, no crash. The non-posting `--dry-run` preview path is never gated, so previewing without credentials keeps working. See [Credential preflight](#credential-preflight).

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
pm slack-standup [flags]   # alias with identical behavior
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--webhook <url>` | string | — | Slack incoming webhook URL (overrides `PM_SLACK_WEBHOOK`) |
| `--channel <name>` | string | — | Channel name shown in the message (e.g. `#team-eng`) |
| `--dry-run` | boolean | `false` | Build and print the message in the chosen format **without** posting |
| `--format <fmt>` | string | `slack` | Output format: `slack` (mrkdwn) \| `blockkit`/`blocks` (Block Kit JSON) \| `markdown` \| `plain` |
| `--include-done` | boolean | `false` | Include recently-closed items in a Done section |
| `--since <iso>` | string | — | ISO date/time window; scopes the Done section to items updated since then |
| `--days <n>` | number | — | Relative window: scope Done to items updated in the last N days (combines with `--since`, more restrictive bound wins) |
| `--group-by <field>` | string | `status` | Group section items by `status` \| `assignee` \| `sprint` \| `type` \| `milestone` |
| `--up-next <n>` | number | `3` | How many open items the **Up Next** section shows (top-N by priority) |
| `--all-open` | boolean | `false` | Show **all** open items in Up Next (no truncation); overrides `--up-next` |
| `--sections <list>` | string | all | Comma list of sections to render/order: `in_progress`, `blocked`, `done`, `up_next` |
| `--mention-map <map>` | string | — | Map pm authors to Slack handles, e.g. `alice=@alice,bob=@bob` |
| `--yesterday` | boolean | `false` | Split Done into **Done Yesterday** / **Done Today** by local day (implies `--include-done`) |
| `--channels <list>` | string | — | Post the same standup to multiple targets: comma list of `#channel` names and/or full webhook URLs |
| `--fallback-to-stdout` | boolean | `false` | If the Slack post fails, print the rendered standup to stdout (exit 0) instead of erroring |
| `--section-labels <map>` | string | — | Override section titles/emoji, e.g. `in_progress=Rolling,blocked=🔥 On Fire` |
| `--compare <path>` | string | — | Show trend deltas vs a **prior** standup JSON file (from `standup export --format json`), or vs a snapshot **directory** (from `standup export --history-dir`) for [multi-snapshot history](#multi-snapshot-history); local read, never posts. Missing/malformed → warn + render without deltas |
| `--schedule <when>` | string | — | Schedule the post instead of sending now: `HH:MM` (daily, local time) or a 5-field cron expression (`min hour dom mon dow`). The process waits until the next fire time, then posts. Combine with `--dry-run` to preview the resolved schedule without waiting |
| `--include-blockers` | boolean | `false` | Highlight blocked rows with a 🚨 marker in every format so impediments stand out at a glance |
| `--team <list>` | string | — | Filter the standup to items assigned to the given members (comma list, e.g. `alice,bob`); items with no assignee are hidden |
| `--compact` | boolean | `false` | Render a shorter one-line-per-section standup (titles only, no per-item bullets / grouping sub-headers, empty sections omitted) |

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
| `--history-dir <dir>` | — | Additionally write a dated JSON snapshot to `<dir>/standup-YYYY-MM-DD.json` (one per local day, overwritten on re-export) for [multi-snapshot history](#multi-snapshot-history) |

The `--since`, `--group-by`, `--include-done`, `--channel` and `--mention-map` flags above also apply to the export, and `pm standup export --help` documents the full flag set.

**Stdout is round-trip safe:** when no `--output` is given, stdout carries **only** the exported document — `pm standup export --format json > prev.json` produces valid JSON with no pm result envelope appended, so it can be piped straight into `--compare`, `jq`, or an archive. (Status lines go to stderr.)

The JSON export also carries a top-level `counts` object (`{ wip, blocked, done, upNext, total }`) — this is the exact shape `standup --compare <path>` reads, so a JSON export from one day can be diffed against the next day's standup (see [Trend deltas](#trend-deltas-vs-a-prior-standup)).

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

**Group by milestone:**
```bash
pm standup --dry-run --group-by milestone
```

**Show more (or all) Up Next items:**
```bash
pm standup --dry-run --up-next 5     # top 5 open items instead of 3
pm standup --dry-run --all-open      # the entire open backlog, no truncation
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

**Filter to your team, compact + highlight blockers:**
```bash
pm standup --dry-run --team alice,bob --compact --include-blockers
```

**Schedule a daily post (waits until the next fire time, then posts):**
```bash
pm standup --schedule 09:30 --channel '#team-eng'         # daily at 09:30 local
pm standup --schedule '*/30 9-17 * * 1-5' --dry-run       # cron: every 30min, 9–17, weekdays (preview)
```

**Show momentum vs a prior standup (trend deltas):**
```bash
# Yesterday: snapshot the standup as JSON
pm standup export --format json --include-done --output prev.json

# Today: render the standup with directional deltas vs that snapshot
pm standup --dry-run --compare prev.json
# footer gains: "Trend vs prior: In Progress ▲+2 · Blocked ▼-1 · Done →0 · Up Next →0"
```
A missing/unreadable/wrong-shape `--compare` file is **not** fatal: it emits a one-line stderr warning and the standup renders normally without deltas. `--compare` only reads the local file — it makes no extra network call.

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

## Trend deltas (vs a prior standup)

`--compare <path>` makes a single standup show **momentum** instead of just a static snapshot. Without it, a reader can't tell whether WIP is climbing, whether the blocked pile is growing, or how much got done since the last report.

How it works:

1. **Snapshot** a standup as JSON — `pm standup export --format json --output prev.json`. The export carries a top-level `counts` object (`wip`/`blocked`/`done`/`upNext`/`total`).
2. **Compare** the next standup against it — `pm standup --compare prev.json`. The footer gains one line of directional indicators:

   ```
   Trend vs prior: In Progress ▲+2 · Blocked ▼-1 · Done →0 · Up Next →0
   ```

   `▲` = section grew, `▼` = section shrank, `→` = unchanged; the signed number is the exact delta (`current − prior`).

The trend line appears in the footer of every text format (`slack`, `markdown` — italicised —, `plain`) and as a second element in the Block Kit `context` footer.

**Graceful degradation:** if the `--compare` file is missing, unreadable, not valid JSON, or doesn't contain recognizable standup counts, the command emits a single `warning:` line to stderr and renders the standup **normally without deltas** — it never crashes. The read is purely local: `--compare` adds **no** network call.

**Round-trip contract:** the `counts` object the exporter writes is exactly what `--compare` consumes, so `standup export --format json > prev.json` today and `standup --compare prev.json` tomorrow always line up. `--compare` also tolerates the canonical `in_progress`/`up_next` key spellings and falls back to counting the exporter's `sections_data` arrays if `counts` is absent.

## Multi-snapshot history

A single prior snapshot shows yesterday-vs-today; a **snapshot directory** shows the whole week's trajectory.

1. **Accumulate** dated snapshots, e.g. from a daily cron or CI job:

   ```bash
   pm standup export --history-dir .standup-history        # writes .standup-history/standup-2026-06-12.json
   ```

   `--history-dir` always writes the JSON snapshot shape regardless of the primary `--format`, one file per local day (re-exporting the same day overwrites it).

2. **Compare against the directory** — `--compare` accepts a directory as well as a file:

   ```bash
   pm standup --dry-run --compare .standup-history
   ```

   The newest snapshot provides the trend baseline (same `Trend vs prior:` line as a file compare), and with 2+ snapshots the footer gains a per-section count sequence across the window, ending at the current standup:

   ```
   History (3 snapshots → now): In Progress 0→1→2→2 · Blocked 1→0→0→0 · Done 0→0→0→0 · Up Next 3→2→1→1
   ```

Snapshot files are read oldest-first by filename (the exporter's `standup-YYYY-MM-DD.json` naming makes lexicographic order chronological); at most the newest 8 snapshots are rendered. Unreadable or unrecognizable snapshot files are skipped with one stderr warning each, and a directory with no usable snapshots degrades exactly like a missing `--compare` file: warn once, render normally. Like the file form, a directory compare is a purely local read — no network.

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

## Credential preflight

Before any post is attempted, `pm standup` runs a **fail-fast credential gate**:

- **A post is "requested"** whenever you do *not* pass `--dry-run`. (`--fallback-to-stdout` still counts as a post — it only changes how a *transport* failure is handled; it still needs a webhook to attempt delivery.)
- **The gate fires only when** a post is requested **and** no usable webhook is configured. A webhook is "configured" if `--webhook` or `PM_SLACK_WEBHOOK` is set, **or** every `--channels` target is a full webhook URL (bare `#name` channels still need the base webhook).
- **When it fires**, the command aborts **immediately** — before reading any pm items or rendering anything — with a clear, actionable error and a **non-zero exit (2 / usage)**. Nothing is posted.
- **When it does not fire** (a webhook is present, *or* you used `--dry-run`), the command proceeds exactly as before.

```bash
# Post requested, no webhook → immediate abort (exit 2), nothing posted:
pm standup --channel '#team-eng'
#   Slack post requested but no webhook is configured. Set PM_SLACK_WEBHOOK or
#   pass --webhook <url> (or provide full webhook URLs via --channels).
#   To preview without posting, use --dry-run.

# Preview without credentials → always allowed (exit 0):
pm standup --dry-run

# With a webhook → preflight passes, the post proceeds:
PM_SLACK_WEBHOOK=https://hooks.slack.com/services/... pm standup --channel '#team-eng'
```

This is implemented in the `standup` command handler (where a thrown error reliably aborts with a non-zero exit); the package also declares the `preflight` capability and registers a scoped pass-through preflight hook for the standup command.

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
2. Sorts open items by priority (ascending) and takes the top N as "Up Next" (default 3; set with `--up-next <n>`, or `--all-open` to show the entire open backlog).
3. Builds a Slack Block Kit `blocks` array (header + a section per bucket + context footer) plus a plain-text `fallback`, optionally grouped by assignee and annotated with Slack mentions. Section titles/emoji can be overridden with `--section-labels`, and `--yesterday` expands Done into Done Yesterday / Done Today.
4. In `--dry-run`, prints the message in the chosen `--format` and exits without any network call. Otherwise posts `{ text, blocks }` to each target (the base webhook plus any `--channels`) using Node.js native `https`. A missing webhook (on a real post) raises a structured `CommandError`; a failed post does too **unless** `--fallback-to-stdout` is set, in which case the rendered standup is printed to stdout and the command exits 0.

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script (a portable Node guard, `scripts/prepare-merge-driver.mjs`: it runs
`pm merge install` only when the `pm` CLI is on `PATH`, and no-ops cleanly otherwise so
production / `--omit=dev` installs are not broken; being Node-based it behaves identically
on POSIX shells and Windows `cmd.exe`). To (re)run manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm the chain is green with
`pm history --verify <id>` and `pm validate`. The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.
