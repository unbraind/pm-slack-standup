import https from "node:https";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { basename, resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Local stand-in for the SDK's `defineExtension` identity helper.
 *
 * Declared here rather than imported so this package keeps a type-only
 * dependency on `@unbrained/pm-cli` and adds no runtime module edge. The
 * generic constraint is the SDK's own, so the extension object is contract-
 * checked against {@link ExtensionModule} exactly as the imported helper would.
 */
const defineExtension = (module) => module;
// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------
// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property
// (see @unbrained/pm-cli runCommandHandler). A plain `Error` makes the runtime
// fall through to its "unhandled" path, which RE-INVOKES the command handler a
// second time and exits with a generic code.
//
// We mirror the SDK's EXIT_CODE contract here rather than importing it, to keep
// this package's dependency on `@unbrained/pm-cli` type-only and add no runtime
// module edge. Note the reason is availability, not impossibility: the SDK IS
// importable at runtime wherever the package's own `node_modules` is populated
// (upstream pm-cli#717), but a standalone-installed extension is not guaranteed
// that, so taking a value import here would make activation depend on it.
const EXIT_CODE = {
    GENERIC_FAILURE: 1,
    USAGE: 2,
    NOT_FOUND: 3,
};
/**
 * Error type that carries the numeric exit code pm's command runtime expects.
 *
 * pm's extension runtime only treats a thrown error as a cleanly-handled
 * non-zero exit when the error exposes a numeric `exitCode`; a plain
 * {@link Error} makes the runtime re-invoke the handler and exit with a generic
 * code, so every intentional failure path in this package throws a
 * {@link CommandError} instead.
 */
export class CommandError extends Error {
    /** Numeric exit code pm's runtime reads off the thrown error (see EXIT_CODE). */
    exitCode;
    constructor(message, exitCode = EXIT_CODE.GENERIC_FAILURE) {
        super(message);
        this.name = "CommandError";
        this.exitCode = exitCode;
    }
}
/**
 * The four standup sections in their canonical render order.
 *
 * Used as the default selection and to iterate sections in a stable order
 * independent of how `--sections` lists them.
 */
export const ALL_SECTIONS = [
    "in_progress",
    "blocked",
    "done",
    "up_next",
];
/** Default number of items shown in the "Up Next" section. */
export const DEFAULT_UP_NEXT = 3;
/** Direction → indicator glyph used in trend output. */
export const TREND_GLYPH = {
    up: "▲",
    down: "▼",
    flat: "→",
};
/** How many snapshots the history footer shows at most (newest last). */
export const HISTORY_MAX_SNAPSHOTS = 8;
// ---------------------------------------------------------------------------
// Option helpers
// ---------------------------------------------------------------------------
/**
 * pm normalizes CLI flags to camelCase at runtime (e.g. `--dry-run` becomes
 * `dryRun`), so reading only the kebab-case key silently misses the value.
 * Read both forms (plus any explicit aliases) to be robust.
 */
function camelCase(key) {
    return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
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
export function readBoolOption(options, key) {
    for (const candidate of [key, camelCase(key)]) {
        const value = options[candidate];
        if (typeof value === "boolean")
            return value;
        if (typeof value === "string") {
            const v = value.trim().toLowerCase();
            if (v === "true" || v === "1" || v === "yes" || v === "on")
                return true;
            if (v === "false" || v === "0" || v === "no" || v === "off")
                return false;
        }
    }
    return false;
}
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
export function readStrOption(options, key) {
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
export function parseMentionMap(spec) {
    const map = {};
    if (!spec)
        return map;
    for (const pair of spec.split(/[,;]/)) {
        const eq = pair.indexOf("=");
        if (eq < 0)
            continue;
        const author = pair.slice(0, eq).trim();
        let handle = pair.slice(eq + 1).trim();
        if (!author || !handle)
            continue;
        if (!handle.startsWith("@"))
            handle = `@${handle}`;
        map[author] = handle;
    }
    return map;
}
/**
 * Normalize a `--format` value. Accepts the four public formats plus the
 * legacy `text` alias (== `plain`) and `blocks` (== `blockkit`, the Slack Block
 * Kit `blocks` JSON). Unknown values raise a USAGE CommandError.
 */
export function parseFormat(raw) {
    if (raw == null)
        return "slack";
    const v = raw.trim().toLowerCase();
    if (v === "" || v === "slack")
        return "slack";
    if (v === "blockkit" || v === "block-kit" || v === "blocks")
        return "blockkit";
    if (v === "markdown" || v === "md")
        return "markdown";
    if (v === "plain" || v === "text" || v === "txt")
        return "plain";
    throw new CommandError(`Unknown --format '${raw}'. Valid: slack | blockkit | blocks | markdown | plain.`, EXIT_CODE.USAGE);
}
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
export function parseGroupBy(raw) {
    if (raw == null)
        return "status";
    const v = raw.trim().toLowerCase();
    if (v === "" || v === "status")
        return "status";
    if (v === "assignee" || v === "owner")
        return "assignee";
    if (v === "sprint")
        return "sprint";
    if (v === "type")
        return "type";
    if (v === "milestone")
        return "milestone";
    throw new CommandError(`Unknown --group-by '${raw}'. Valid: status | assignee | sprint | type | milestone.`, EXIT_CODE.USAGE);
}
const SECTION_ALIASES = {
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
export function parseSections(spec) {
    if (!spec || !spec.trim())
        return [...ALL_SECTIONS];
    const out = [];
    for (const raw of spec.split(/[,;]/)) {
        const token = raw.trim().toLowerCase();
        if (!token)
            continue;
        const key = SECTION_ALIASES[token];
        if (!key) {
            throw new CommandError(`Unknown --sections value '${raw.trim()}'. Valid: in_progress | blocked | done | up_next.`, EXIT_CODE.USAGE);
        }
        if (!out.includes(key))
            out.push(key);
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
export function parseSectionLabels(spec) {
    const out = {};
    if (!spec || !spec.trim())
        return out;
    for (const pair of spec.split(/[,;]/)) {
        const eq = pair.indexOf("=");
        if (eq < 0)
            continue;
        const rawKey = pair.slice(0, eq).trim().toLowerCase();
        const rawVal = pair.slice(eq + 1).trim();
        if (!rawKey || !rawVal)
            continue;
        const key = SECTION_ALIASES[rawKey];
        if (!key) {
            throw new CommandError(`Unknown --section-labels key '${rawKey}'. Valid: in_progress | blocked | done | up_next.`, EXIT_CODE.USAGE);
        }
        // Split on the first space; treat the head as an emoji override only
        // when it carries a non-ASCII codepoint (emoji/symbol). A plain ASCII
        // word is part of the title, so the section keeps its default emoji.
        const spaceIdx = rawVal.indexOf(" ");
        const override = {};
        if (spaceIdx > 0) {
            const head = rawVal.slice(0, spaceIdx);
            const tail = rawVal.slice(spaceIdx + 1).trim();
            const headHasNonAscii = [...head].some((ch) => ch.codePointAt(0) > 127);
            if (tail && headHasNonAscii) {
                override.emoji = head;
                override.title = tail;
            }
            else {
                override.title = rawVal;
            }
        }
        else {
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
export function parseChannels(spec) {
    if (!spec || !spec.trim())
        return [];
    const out = [];
    for (const raw of spec.split(/[,;]/)) {
        const token = raw.trim();
        if (token && !out.includes(token))
            out.push(token);
    }
    return out;
}
/** True when a channel token is a full webhook URL rather than a name. */
export function isWebhookUrl(token) {
    return /^https?:\/\//i.test(token.trim());
}
/**
 * Parse a `--team` spec (comma/semicolon list of assignees) into an ordered,
 * trimmed, de-duped list. Empty spec → [] (no filter). Used by `--team` to
 * filter the standup to items assigned to one of the named team members.
 */
export function parseTeam(spec) {
    if (!spec || !spec.trim())
        return [];
    const out = [];
    for (const raw of spec.split(/[,;]/)) {
        const token = raw.trim();
        if (token && !out.includes(token))
            out.push(token);
    }
    return out;
}
// Valid value ranges for the five cron fields.
const CRON_BOUNDS = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day-of-month
    [1, 12], // month
    [0, 6], // day-of-week (0 = Sunday)
];
/** Parse one cron field token into a sorted unique list of valid values. */
function parseCronField(token, fieldIndex) {
    const [min, max] = CRON_BOUNDS[fieldIndex];
    const all = () => {
        const out = [];
        for (let v = min; v <= max; v++)
            out.push(v);
        return out;
    };
    const expandRange = (lo, hi, step) => {
        const out = [];
        for (let v = lo; v <= hi; v += step)
            out.push(v);
        return out;
    };
    const result = new Set();
    for (const part of token.split(",")) {
        const p = part.trim();
        if (p === "")
            continue;
        let step = 1;
        const slashIdx = p.indexOf("/");
        if (slashIdx >= 0) {
            const s = Number(p.slice(slashIdx + 1));
            if (!Number.isInteger(s) || s < 1) {
                throw new Error(`invalid step '${p.slice(slashIdx + 1)}' in '${p}'`);
            }
            step = s;
        }
        const rangePart = slashIdx >= 0 ? p.slice(0, slashIdx) : p;
        if (rangePart === "*") {
            for (const v of expandRange(min, max, step))
                result.add(v);
        }
        else {
            const dashIdx = rangePart.indexOf("-");
            if (dashIdx >= 0) {
                const loStr = rangePart.slice(0, dashIdx);
                const hiStr = rangePart.slice(dashIdx + 1);
                // Reject empty bounds: Number("") === 0 would accept `-5` (lo=0) or `0-` (hi=0).
                if (!/^\d+$/.test(loStr) || !/^\d+$/.test(hiStr)) {
                    throw new Error(`invalid range '${rangePart}'`);
                }
                const lo = Number(loStr);
                const hi = Number(hiStr);
                if (lo < min || hi > max || lo > hi) {
                    throw new Error(`invalid range '${rangePart}'`);
                }
                for (const v of expandRange(lo, hi, step))
                    result.add(v);
            }
            else {
                // Reject an empty base: Number("") === 0 would accept `/5` as `0/5`.
                if (!/^\d+$/.test(rangePart)) {
                    throw new Error(`invalid value '${rangePart}'`);
                }
                const v = Number(rangePart);
                if (v < min || v > max) {
                    throw new Error(`invalid value '${rangePart}'`);
                }
                if (slashIdx >= 0) {
                    // `n/step` means n..max with step
                    for (const x of expandRange(v, max, step))
                        result.add(x);
                }
                else {
                    result.add(v);
                }
            }
        }
    }
    if (result.size === 0)
        throw new Error(`empty field '${token}'`);
    return [...result].sort((a, b) => a - b);
}
/**
 * Parse a `--schedule` value. Accepts `HH:MM` (daily, local time) or a 5-field
 * cron expression (minute hour dom month dow). Raises a USAGE CommandError for
 * anything unparseable so a typo is loud rather than silently posting now.
 */
export function parseSchedule(spec) {
    if (!spec || !spec.trim())
        return undefined;
    const s = spec.trim();
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
    if (m) {
        return { kind: "daily", hour: Number(m[1]), minute: Number(m[2]), raw: s };
    }
    const fields = s.split(/\s+/);
    if (fields.length === 5) {
        try {
            const parsed = fields.map((f, i) => parseCronField(f, i));
            return { kind: "cron", fields: parsed, raw: s };
        }
        catch (err) {
            throw new CommandError(`Invalid --schedule cron expression '${s}': ${err instanceof Error ? err.message : String(err)}.`, EXIT_CODE.USAGE);
        }
    }
    throw new CommandError(`Invalid --schedule '${s}'. Use HH:MM (daily, local time) or a 5-field cron expression (min hour dom mon dow).`, EXIT_CODE.USAGE);
}
/**
 * Compute the next epoch-ms fire time at/after `now` (exclusive: the next fire
 * is always strictly after `now`). For cron, day-of-month vs day-of-week use
 * standard cron OR semantics when both are restricted. Returns the epoch ms.
 */
export function nextFireTime(spec, now = Date.now()) {
    const start = new Date(now + 60_000); // begin one minute after now
    start.setSeconds(0, 0);
    if (spec.kind === "daily") {
        const hour = spec.hour;
        const minute = spec.minute;
        for (let day = 0; day < 366; day++) {
            const d = new Date(start);
            d.setDate(d.getDate() + day);
            d.setHours(hour, minute, 0, 0);
            if (d.getTime() > now)
                return d.getTime();
        }
        // Should not happen within a year; fall back to now + 24h.
        return now + 86_400_000;
    }
    // cron: minute-by-minute scan, capped at 366 days.
    const [minF, hourF, domF, monF, dowF] = spec.fields;
    const domAll = domF.length === CRON_BOUNDS[2][1] - CRON_BOUNDS[2][0] + 1;
    const dowAll = dowF.length === CRON_BOUNDS[4][1] - CRON_BOUNDS[4][0] + 1;
    const cap = now + 366 * 86_400_000;
    const t = new Date(start);
    while (t.getTime() <= cap) {
        const min = t.getMinutes();
        const hour = t.getHours();
        const dom = t.getDate();
        const mon = t.getMonth() + 1;
        const dow = t.getDay();
        if (minF.includes(min) &&
            hourF.includes(hour) &&
            monF.includes(mon) &&
            // standard cron: if both dom and dow are restricted, match EITHER.
            (domAll || dowAll ? domF.includes(dom) && dowF.includes(dow) : domF.includes(dom) || dowF.includes(dow))) {
            return t.getTime();
        }
        t.setMinutes(t.getMinutes() + 1);
    }
    return now + 86_400_000;
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
export function resolveSinceMs(since, days, now = Date.now(), warn = (m) => console.error(m)) {
    let bound = NaN;
    if (since != null && since.trim() !== "") {
        const ms = Date.parse(since);
        if (isNaN(ms)) {
            warn(`warning: ignoring unparseable --since '${since}' (expected an ISO date/time, e.g. 2026-06-01). ` +
                `The Done window from --since is not applied.`);
        }
        else {
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
export function resolveUpNextCount(upNextRaw, allOpen, fallback = DEFAULT_UP_NEXT) {
    if (allOpen)
        return Infinity;
    if (upNextRaw == null || upNextRaw.trim() === "")
        return fallback;
    const n = Number(upNextRaw.trim());
    if (!Number.isInteger(n) || n < 1) {
        throw new CommandError(`Invalid --up-next value '${upNextRaw}' (expected a positive integer, or use --all-open).`, EXIT_CODE.USAGE);
    }
    return n;
}
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
export function parseDays(raw) {
    if (raw == null || raw.trim() === "")
        return undefined;
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
export function writeError(path, err) {
    const code = err?.code;
    const detail = err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
    let hint;
    if (code === "ENOENT") {
        hint = `the parent directory does not exist — create it first or choose an existing path`;
    }
    else if (code === "EACCES" || code === "EPERM") {
        hint = `permission denied — check write access to that location`;
    }
    else if (code === "EISDIR") {
        hint = `that path is a directory, not a file`;
    }
    else {
        hint = detail;
    }
    return new CommandError(`standup export: could not write to '${path}': ${hint}.`, EXIT_CODE.GENERIC_FAILURE);
}
// ---------------------------------------------------------------------------
// Data fetch
// ---------------------------------------------------------------------------
// Node's spawnSync defaults to a 1 MiB stdout cap, which a mature tracker's JSON
// dump passes at a few hundred items. Past that the child is killed with ENOBUFS,
// status null and EMPTY stderr, so the failure surfaces with nothing to diagnose
// (and at larger sizes stdout is genuinely truncated mid-document).
// 64 MiB matches the cap the sibling pm packages settled on.
/** Read-buffer cap for `pm` output, in bytes. 64 MiB by default; override with the
 * `PM_JSON_MAX_BUFFER` env var. Resolved per call so the override takes effect
 * without an import-order dependency. Invalid or non-positive values fall back to
 * the default rather than silently disabling the guard. */
export function pmJsonMaxBuffer() {
    // Number(), not parseInt(): parseInt("64MiB") silently yields 64, which would
    // impose a 64-BYTE cap and break every ordinary read while appearing to honor
    // the documented invalid-value fallback. Number() rejects the whole string.
    const raw = Number(process.env["PM_JSON_MAX_BUFFER"]);
    return Number.isSafeInteger(raw) && raw > 0 ? raw : 64 * 1024 * 1024;
}
/** Name the real cause of a failed `pm` read. A stdout overrun kills the child
 * with `status: null` and EMPTY stderr, so without this the failure surfaces as
 * an unexplained error (or, worse, as an empty result set). Exposed so the
 * wording can be regression-tested directly with synthetic errors, mirroring the
 * `describePmNullStatus` convention the sibling pm-csv package uses. */
export function describePmReadFailure(error, limitBytes) {
    const code = error.code;
    if (code === "ENOBUFS") {
        return `pm output exceeded the ${limitBytes} byte read buffer. `
            + "The workspace is larger than this integration's read limit; narrow the "
            + "operation or raise PM_JSON_MAX_BUFFER.";
    }
    return `pm read failed: ${error.message}`;
}
/**
 * Quote one argv element for a Windows command-line tail.
 *
 * The element is left bare when nothing in it needs quoting, and otherwise
 * wrapped in double quotes with the documented CommandLineToArgvW escaping:
 * every `"` in the element becomes `\"`, and a run of backslashes directly
 * before a quote (including the closing quote this function appends) doubles,
 * because the parser consuming the line collapses `2n` backslashes before a
 * quote back to `n`. An empty element becomes `""`, which is the only way an
 * empty argument survives a command line at all.
 *
 * Quoting is triggered by space and tab (which end an unquoted argument), by
 * `"` (which must be escaped anyway, and only reads as one token once quoted),
 * and by each of `& | < > ^ ( )`: cmd.exe treats those as operators when they
 * stand outside quotes and as literals inside them — which is also why quoting
 * is used instead of `^`-escaping, since a quoted `^` is a literal `^`. One
 * limit is shared with Node's own `shell: true` launching: `%` cannot be
 * neutralized this way, because cmd expands `%VAR%` even inside quotes. That
 * is not left to chance -- see {@link assertNoCmdVariableExpansion}, which
 * refuses the launch rather than letting pm read a different workspace.
 *
 * @param arg - One argv element to render.
 * @returns The element as it must appear inside a command-line tail.
 */
function quoteWindowsArg(arg) {
    if (arg === "")
        return '""';
    if (!/[\t "&|<>()^]/.test(arg))
        return arg;
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}
/**
 * Refuse a cmd.exe launch whose arguments contain a `%VAR%` cmd would expand.
 *
 * `quoteWindowsArg` neutralizes every metacharacter cmd honours inside quotes
 * except `%`: cmd expands `%NAME%` even within a quoted string, and there is no
 * escape for it on a `cmd /c` command tail. That limit was documented and
 * accepted on the assumption that no path this package launches would contain
 * one — but a Windows workspace path is user-chosen, and `--pm-path` carries it
 * straight into this tail. A path like `C:\work\%BUILD%\pm` would silently
 * become whatever `%BUILD%` expands to (or empty), so pm would read a DIFFERENT
 * workspace and the standup would be built from it while reporting success.
 *
 * Since the expansion cannot be prevented, the failure is made loud instead:
 * a wrong-workspace read that reports success is far worse than a refusal that
 * names the offending argument. Only a `%NAME%` pair with at least one character
 * between the delimiters is refused, so both an ordinary literal percent
 * (`C:\reports\100% done`) and a literal doubled pair (`100%% done`) still
 * launch -- `%%` is a batch-file escape, not a command-line one.
 *
 * @param argv - The binary path followed by every pm argument.
 * @throws {CommandError} When an argument contains a `%`-delimited name.
 */
function assertNoCmdVariableExpansion(argv) {
    // At least one character between the delimiters: `%%` is a literal doubled
    // percent, not a variable reference. The doubling rule is a BATCH FILE
    // convention; on a `cmd /c` command line `%%` is passed through unchanged. A
    // zero-width match would refuse a valid path such as `C:\reports\100%% done`.
    const offending = argv.find((arg) => /%[^%\r\n]+%/.test(arg));
    if (offending === undefined)
        return;
    throw new CommandError(`Refusing to launch pm through cmd.exe: the argument ${JSON.stringify(offending)} contains a `
        + "%-delimited name, and cmd.exe expands %VAR% even inside quotes with no way to escape it. "
        + "pm would read a different workspace than the one requested and the standup would be built "
        + "from it while reporting success. Rename the path so it contains no %NAME% pair, or run "
        + "from a workspace path without one.");
}
/**
 * Decide how `bin` is launched on `platform`: the single place that pairs a
 * resolved `pm` binary with the spawn that can actually execute it.
 *
 * On win32 every form this package can resolve — the `.cmd` batch shim, the
 * extensionless POSIX shim, and the bare `pm` PATH fallback — needs the Windows
 * command processor, for three different reasons: Node 18.20+/20.12+ refuse to
 * spawn `.cmd`/`.bat` directly at all (the CVE-2024-27980 mitigation fails the
 * spawn with EINVAL), CreateProcess rejects the extensionless shim for having
 * no recognized executable extension, and a bare `pm` is not resolved through
 * PATHEXT the way a shell would. So the launch is always the processor with
 * `/d /s /c` and the binary as the first word of the command.
 *
 * How the command tail after `/c` is built is the subtle part, and it is why
 * `PmLaunch` composes the whole argv rather than leaving a caller to append
 * arguments. cmd's documented `/c`/`/k` quote handling ("old behavior", which
 * `/s` forces unconditionally) is: if the first character after `/c` is a
 * quote, strip that leading quote and remove the LAST quote character on the
 * tail, preserving any text after it. Passing the binary and the pm arguments
 * as discrete argv elements — letting Node quote each one — assembles a tail
 * like `"C:\spaced path\pm.cmd" --path "C:\tracker root" list-all --json
 * --include-body`: the tail starts with the binary's opening quote, and when
 * the FINAL argument needs quoting (any tracker root containing a space), the
 * last quote on the tail is an inner one. cmd strips the leading quote and
 * that inner quote, and the executable's path splits at its first space. The
 * launch then only works when the last argument happens to be unquoted —
 * which is why the original form passed its tests and still broke on
 * `C:\Users\Some User\project`.
 *
 * The fix is the mechanism Node itself uses for `shell: true` on win32: the
 * ENTIRE tail — binary plus every pm argument, each quote-escaped per the
 * CommandLineToArgvW rules by {@link quoteWindowsArg} — is passed as ONE argv
 * element wrapped in an outer pair of quotes added here, with
 * `windowsVerbatimArguments: true` so Node adds nothing of its own. cmd's `/s`
 * strip removes exactly the outer pair (the first character and the last
 * quote character are now both ours), and the inner per-element quoting
 * survives verbatim for the parser on the other side. Unlike `shell: true`,`
 * no raw string is ever handed to a shell: every element is escaped by this
 * package before it reaches the command line, so a metacharacter inside an
 * argument is data to `pm`, never cmd syntax — `shell: true` is what joins
 * caller strings verbatim and must not be reintroduced.
 *
 * `/d` additionally skips the AutoRun registry hook, so machine-level cmd
 * configuration cannot alter the launch.
 *
 * On every other platform the binary is spawned directly with the pm arguments
 * as discrete argv elements, byte-for-byte the invocation this package has
 * always used: the shebang shim is executable as-is and no processor is
 * involved.
 *
 * `platform` defaults to `process.platform` and is a parameter so tests can
 * assert the exact launch shape for win32 without a Windows box.
 *
 * @param bin - Binary path (or PATH fallback name) to launch.
 * @param platform - Platform the launch will run on; defaults to the current one.
 * @returns The launch to hand to `spawnSync`: `command` plus `args(pmArgs)`
 *          building the full argv, and the `windowsVerbatimArguments` value
 *          the spawn must pass.
 */
export function pmLaunchPlan(bin, platform = process.platform) {
    if (platform !== "win32") {
        return {
            command: bin,
            args: (pmArgs) => [...pmArgs],
            windowsVerbatimArguments: false,
        };
    }
    return {
        command: process.env["ComSpec"] || "cmd.exe",
        // One argv element: outer-quoted by us, inner-quoted per element, so the
        // /s strip removes exactly the outer pair. See the doc comment above for
        // why this must not go back to appending the pm arguments as separate
        // elements after `/c`.
        args: (pmArgs) => {
            assertNoCmdVariableExpansion([bin, ...pmArgs]);
            return [
                "/d",
                "/s",
                "/c",
                `"${[bin, ...pmArgs].map(quoteWindowsArg).join(" ")}"`,
            ];
        },
        windowsVerbatimArguments: true,
    };
}
/**
 * Resolve the `pm` executable this package's own `@unbrained/pm-cli` declared,
 * walking up from `moduleUrl` to the nearest `node_modules/.bin/pm` shim, and
 * falling back to `pm` on `PATH` only when no local install is found — then
 * return it as a {@link PmLaunch} describing the spawn that can execute it.
 *
 * `spawnSync("pm", ...)` runs whichever `pm` comes first on `PATH`, which need
 * not be the `@unbrained/pm-cli` this package declared — that is what produced
 * the version skew this fix addresses. Resolving from the package's own
 * `node_modules` keeps the read against the same CLI the package pins, and the
 * walk handles both the source layout (`index.ts` at the package root) and the
 * built layout (`dist/index.js`), as well as a consumer install where the
 * nearest `.bin/pm` shim is the host CLI that loaded this extension.
 *
 * The result carries the launch decision, not just the path, because the two
 * cannot be separated on Windows: npm writes three shims into
 * `node_modules/.bin` (an extensionless shell script, a `.cmd` batch file, and
 * a `.ps1` script), and on win32 only the `.cmd` is executable at all — but
 * only through a command processor (see {@link pmLaunchPlan}). Returning the
 * bare `.cmd` path previously left the caller to invent a launch, and it
 * spawned the batch file directly, which Node refuses with EINVAL. Routing the
 * resolved binary through `pmLaunchPlan` here keeps "which file" and "how to
 * spawn it" in one place, so no caller can pair them wrongly.
 *
 * `moduleUrl` defaults to this module's URL and is a parameter only so the
 * resolution can be exercised against synthetic locations without touching the
 * real tree; `platform` likewise defaults to `process.platform` so the win32
 * launch shape can be asserted without a Windows box.
 */
export function resolvePmBin(moduleUrl = import.meta.url, platform = process.platform) {
    // Prefer the .cmd shim on win32 (Windows cannot execute the extensionless
    // one) and the shebang script everywhere else; pmLaunchPlan then decides how
    // the chosen file is spawned on that platform.
    const shims = platform === "win32" ? ["pm.cmd", "pm"] : ["pm"];
    let dir = dirname(fileURLToPath(moduleUrl));
    for (let i = 0; i < 4; i += 1) {
        for (const shim of shims) {
            const bin = join(dir, "node_modules", ".bin", shim);
            if (existsSync(bin))
                return pmLaunchPlan(bin, platform);
        }
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return pmLaunchPlan("pm", platform);
}
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
export function pmReadTimeoutMs() {
    const raw = Number(process.env["PM_READ_TIMEOUT_MS"]);
    return Number.isSafeInteger(raw) && raw > 0 ? raw : 60_000;
}
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
 * first on `PATH`. It accepts that returned {@link PmLaunch} or a plain binary
 * path — a string is normalized through {@link pmLaunchPlan}, so an explicitly
 * pinned binary gets the same platform-correct launch instead of bypassing it.
 */
export function fetchAllItems(pmRoot, pmBin = resolvePmBin()) {
    const launch = typeof pmBin === "string" ? pmLaunchPlan(pmBin) : pmBin;
    const maxBuffer = pmJsonMaxBuffer();
    const result = spawnSync(launch.command, launch.args(["--path", pmRoot, "list-all", "--json", "--include-body"]), 
    // `windowsVerbatimArguments` comes from the launch: on win32 the whole
    // command tail is ONE argv element this package quote-escaped itself (see
    // pmLaunchPlan), so Node must pass it through untouched — letting Node
    // re-quote it would bury the outer pair cmd's `/s` strip is meant to
    // remove. On POSIX the value is false, Node's default per-element quoting,
    // and the argv is byte-for-byte the discrete-element invocation this
    // package has always used. Nothing here may ever pass `shell: true`, which
    // would join a raw command string for a shell to interpret — the injection
    // surface the composed tail exists to avoid.
    { encoding: "utf-8", maxBuffer, timeout: pmReadTimeoutMs(), windowsVerbatimArguments: launch.windowsVerbatimArguments });
    if (result.error) {
        throw new CommandError(describePmReadFailure(result.error, maxBuffer));
    }
    if (result.status !== 0) {
        // The status has to be in the message: `pm` can exit non-zero with empty
        // stderr, and "pm list-all failed" with no number tells an operator nothing
        // about which failure they are looking at.
        const reason = result.stderr?.trim();
        throw new CommandError(`pm list-all failed (exit ${result.status})${reason ? `: ${reason}` : ""}`);
    }
    let envelope;
    try {
        envelope = JSON.parse(result.stdout);
    }
    catch {
        throw new CommandError("Could not parse `pm list-all --json` output.");
    }
    // Every other malformed shape above is refused with a CommandError; a non-array
    // `items` must be too. `{"items":{}}` would otherwise pass straight through and
    // fail inside buildStandupData with a TypeError far from the read that caused
    // it, naming neither the command nor the payload.
    if (envelope.items !== undefined && !Array.isArray(envelope.items)) {
        throw new CommandError("`pm list-all --json` returned a non-array `items` field, so the workspace could not be read.");
    }
    const items = (envelope.items ?? []);
    // `list-all` promises completeness, but pm-cli bounds read output against a
    // default token budget and reports the shortfall in-band: exit 0, well-formed
    // JSON, `truncated: true`, and a fraction of the rows. On 2026.8.14 that is 10
    // of 676 items. A standup built from a truncated read is not a smaller standup,
    // it is a wrong one that reads as a quiet day — the same failure mode this
    // function was just fixed for, arriving through a successful call instead of a
    // failed one. Refuse, and name the flag that lifts the cap: `--output-limit`
    // and `--no-truncate` are both accepted and both leave the cap in place.
    if (envelope.truncated === true) {
        throw new CommandError(`pm list-all returned ${items.length} of ${envelope.total ?? "unknown"} items because the read `
            + "was truncated. A standup built from a partial read would under-report work as absent. "
            + "Re-run with `--output-budget unbounded`, or upgrade past the pm-cli release that caps "
            + "list-all by default.");
    }
    return items;
}
const WIP_STATUSES = new Set(["in_progress", "wip", "doing"]);
const BLOCKED_STATUSES = new Set(["blocked", "on_hold"]);
const OPEN_STATUSES = new Set(["open", "todo", "new", "draft"]);
const DONE_STATUSES = new Set(["closed", "done", "complete", "completed"]);
function statusOf(item) {
    return (item.status ?? "").trim().toLowerCase();
}
/**
 * True when an item's last activity falls within the [sinceMs, now] window.
 * NaN sinceMs means "no window" → always true.
 */
export function withinWindow(item, sinceMs) {
    if (isNaN(sinceMs))
        return true;
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
export function hasBlockedByDep(item) {
    const top = item.blocked_by;
    if (typeof top === "string" && top.trim().length > 0)
        return true;
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
export function blockedAgeDays(item, now = Date.now()) {
    if (!BLOCKED_STATUSES.has(statusOf(item)) && !hasBlockedByDep(item))
        return undefined;
    const ts = Date.parse(item.updated_at ?? item.created_at ?? "");
    if (isNaN(ts))
        return undefined;
    return Math.max(0, Math.floor((now - ts) / 86_400_000));
}
/**
 * Local-day key (YYYY-MM-DD in the host's local timezone) for an item's last
 * activity. Used by the `--yesterday` split. Falls back to created_at, then
 * to the empty string when no timestamp is parseable.
 */
export function localDayKey(item) {
    const ts = Date.parse(item.updated_at ?? item.created_at ?? "");
    if (isNaN(ts))
        return "";
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}
/** Local-day key (YYYY-MM-DD) for a given epoch-ms instant. */
export function localDayKeyOf(ms) {
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
export function buildStandupData(items, opts, sinceMs = NaN, now = Date.now()) {
    // `--team`: filter to items assigned to one of the named members. Items
    // with no assignee are hidden when a team filter is active. No filter → all.
    const team = opts.team;
    const visible = team && team.length > 0
        ? items.filter((i) => i.assignee != null && team.includes(i.assignee))
        : items;
    const isDone = (i) => DONE_STATUSES.has(statusOf(i));
    // An item is "blocked" for standup purposes when its status is blocked/
    // on_hold OR it carries a blocked_by dependency — but a done item is never
    // re-surfaced as blocked (a closed impediment is no longer an impediment).
    const isBlocked = (i) => !isDone(i) && (BLOCKED_STATUSES.has(statusOf(i)) || hasBlockedByDep(i));
    const wip = visible.filter((i) => WIP_STATUSES.has(statusOf(i)) && !isBlocked(i));
    const blocked = visible.filter(isBlocked);
    const open = visible.filter((i) => OPEN_STATUSES.has(statusOf(i)) && !isBlocked(i));
    const done = opts.includeDone
        ? visible.filter((i) => isDone(i) && withinWindow(i, sinceMs))
        : [];
    const sortedOpen = [...open].sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));
    const upNextCount = opts.upNextCount ?? DEFAULT_UP_NEXT;
    const upNext = upNextCount === Infinity ? sortedOpen : sortedOpen.slice(0, upNextCount);
    const data = { wip, blocked, done, upNext, total: visible.length };
    if (opts.splitYesterday && done.length > 0) {
        const todayKey = localDayKeyOf(now);
        const yesterdayKey = localDayKeyOf(now - 86_400_000);
        data.doneToday = done.filter((i) => localDayKey(i) === todayKey);
        data.doneYesterday = done.filter((i) => localDayKey(i) === yesterdayKey);
    }
    return data;
}
const SECTION_META = {
    in_progress: { emoji: "🏃", title: "In Progress", emptyNote: "nothing in progress", withPriority: false },
    blocked: { emoji: "🚫", title: "Blocked", emptyNote: "nothing blocked", withPriority: false },
    done: { emoji: "✅", title: "Done", emptyNote: null, withPriority: false },
    up_next: { emoji: "📋", title: "Up Next", emptyNote: null, withPriority: true },
};
/**
 * Apply any `--section-labels` override for `key` to the given emoji/title.
 */
function labeled(key, emoji, title, opts) {
    const ov = opts.sectionLabels[key];
    if (!ov)
        return { emoji, title };
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
export function resolveSections(data, opts) {
    const itemsFor = {
        in_progress: data.wip,
        blocked: data.blocked,
        done: data.done,
        up_next: data.upNext,
    };
    const alwaysShow = {
        in_progress: true,
        blocked: true,
        done: false,
        up_next: false,
    };
    const out = [];
    for (const key of opts.sections) {
        const items = itemsFor[key];
        const meta = SECTION_META[key];
        if (key === "done" && opts.splitYesterday && data.doneYesterday && data.doneToday) {
            const subsets = [
                ["Done Yesterday", data.doneYesterday],
                ["Done Today", data.doneToday],
            ];
            // The day distinction owns the title here, so a --section-labels
            // override for `done` contributes only its emoji (not its title).
            const doneEmoji = opts.sectionLabels.done?.emoji ?? meta.emoji;
            for (const [subTitle, subItems] of subsets) {
                if (subItems.length === 0)
                    continue;
                out.push({ key, emoji: doneEmoji, title: subTitle, items: subItems, emptyNote: meta.emptyNote, withPriority: meta.withPriority });
            }
            continue;
        }
        if (!alwaysShow[key] && items.length === 0)
            continue;
        const { emoji, title } = labeled(key, meta.emoji, meta.title, opts);
        out.push({ key, emoji, title, items, emptyNote: meta.emptyNote, withPriority: meta.withPriority });
    }
    return out;
}
// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function typeLabel(item) {
    if (!item.type)
        return "";
    const label = item.type.charAt(0).toUpperCase() + item.type.slice(1);
    return `[${label}]`;
}
function mentionFor(item, mentionMap) {
    const author = item.assignee ?? item.author;
    if (author && mentionMap[author])
        return ` (${mentionMap[author]})`;
    return "";
}
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
export function itemText(item, mentionMap, withPriority = false) {
    const label = typeLabel(item);
    const title = label ? `${label} ${item.title}` : item.title;
    const prio = withPriority && item.priority != null ? ` (priority ${item.priority})` : "";
    const context = [];
    if (typeof item.blocked_by === "string" && item.blocked_by.trim()) {
        context.push(`blocked by ${item.blocked_by.trim()}`);
    }
    else if (Array.isArray(item.dependencies)) {
        const blockers = item.dependencies
            .filter((d) => d?.kind?.trim().toLowerCase() === "blocked_by")
            .map((d) => d.id?.trim())
            .filter((id) => Boolean(id));
        if (blockers.length > 0)
            context.push(`blocked by ${blockers.join(", ")}`);
    }
    const ageDays = blockedAgeDays(item);
    if (ageDays !== undefined && ageDays >= 3)
        context.push(`stale ${ageDays}d`);
    const blockedContext = context.length > 0 ? ` (${context.join("; ")})` : "";
    return `${title}${prio}${blockedContext}${mentionFor(item, mentionMap)}`;
}
/**
 * True when an item is a blocker for standup purposes: status is blocked/
 * on_hold OR it carries a `blocked_by` dependency. (A closed item is never a
 * blocker.) Used by `--include-blockers` highlighting.
 */
function isBlockerItem(item) {
    // A closed/done item is never a blocker: a stale `blocked_by` dependency
    // on a completed item must not resurface it with a 🚨 marker (e.g. when
    // `--include-done --include-blockers` are combined).
    return !DONE_STATUSES.has(statusOf(item)) && (BLOCKED_STATUSES.has(statusOf(item)) || hasBlockedByDep(item));
}
/**
 * Render one item line, applying `--include-blockers` highlighting (a 🚨
 * prefix on blocked rows) when enabled. Otherwise identical to `itemText`.
 */
function itemLine(item, opts, withPriority) {
    const base = itemText(item, opts.mentionMap, withPriority);
    if (opts.includeBlockers && isBlockerItem(item))
        return `🚨 ${base}`;
    return base;
}
/**
 * Compact one-line summary of a section: `emoji Title (n): t1; t2; t3` using
 * item titles only (no type/priority/mention/grouping sub-headers). Returns
 * the empty string for empty sections (so they can be omitted entirely).
 */
function compactSectionLine(def, opts) {
    if (def.items.length === 0)
        return "";
    // Honor `--include-blockers`: prefix blocked item titles with 🚨 so the
    // marker is not lost in compact mode (README says blockers are highlighted
    // in every format). Done items are never blockers (see isBlockerItem).
    const titles = def.items
        .map((i) => (opts.includeBlockers && isBlockerItem(i) ? `🚨 ${i.title}` : i.title))
        .join("; ");
    return `${def.emoji} ${def.title} (${def.items.length}): ${titles}`;
}
function todayISO() {
    return new Date().toISOString().slice(0, 10);
}
/**
 * Group a list of items by the configured field (assignee, sprint, type or
 * milestone). Items missing the field bucket under a synthetic "_none" key
 * (rendered as a friendly label). Returns entries sorted by group key for
 * stable output.
 */
export function groupItems(items, groupBy) {
    const groups = new Map();
    for (const item of items) {
        let key;
        if (groupBy === "assignee")
            key = item.assignee ?? "_none";
        else if (groupBy === "sprint")
            key = item.sprint ?? "_none";
        else if (groupBy === "type")
            key = item.type ?? "_none";
        else if (groupBy === "milestone")
            key = item.milestone ?? "_none";
        else
            key = "_none";
        const bucket = groups.get(key);
        if (bucket)
            bucket.push(item);
        else
            groups.set(key, [item]);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
/**
 * Display label for a sub-group key within a section.
 *
 * Most keys render verbatim; the `_none` sentinel — used for items missing the
 * grouped field — is translated into a field-appropriate placeholder
 * ("Unassigned", "No sprint", "Untyped", "(no milestone)") so the bucket reads
 * naturally instead of as a bare sentinel.
 *
 * @param key - The raw group key (possibly the `_none` sentinel).
 * @param groupBy - The active grouping field, which picks the placeholder.
 * @returns The display label for that group.
 */
function groupLabel(key, groupBy) {
    if (key !== "_none")
        return key;
    if (groupBy === "assignee")
        return "Unassigned";
    if (groupBy === "sprint")
        return "No sprint";
    if (groupBy === "type")
        return "Untyped";
    if (groupBy === "milestone")
        return "(no milestone)";
    return key;
}
const isGrouped = (opts) => opts.groupBy !== "status";
// ---------------------------------------------------------------------------
// Plain-text / mrkdwn / markdown message (fallback + dry-run preview)
// ---------------------------------------------------------------------------
function bold(text, format) {
    if (format === "slack")
        return `*${text}*`;
    if (format === "markdown")
        return `**${text}**`;
    return text;
}
function italic(text, format) {
    if (format === "slack")
        return `_${text}_`;
    if (format === "markdown")
        return `_${text}_`;
    return text;
}
/**
 * Append one standup section to the rendered line buffer.
 *
 * Emits the section header (emoji + title + item count) in the active format
 * (markdown heading or mrkdwn bold), an empty-state note when the section has no
 * items, and the items themselves — flat, or nested under sub-group labels when
 * grouping is on. Pushes onto `lines` in place; returns nothing.
 *
 * @param lines - The output line buffer being assembled.
 * @param def - The section definition (title, emoji, items, empty note).
 * @param opts - The resolved standup options (format, grouping, labels).
 */
function renderSection(lines, def, opts) {
    const count = `(${def.items.length})`;
    if (opts.format === "markdown") {
        lines.push(`## ${def.emoji} ${def.title} ${count}`);
    }
    else {
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
            if (opts.format === "markdown")
                lines.push(`- ${bold(name, opts.format)}`);
            else
                lines.push(`  ${bold(name, opts.format)}`);
            for (const item of group) {
                const bullet = opts.format === "markdown" ? "  - " : "    • ";
                lines.push(`${bullet}${itemLine(item, opts, def.withPriority)}`);
            }
        }
    }
    else {
        const bullet = opts.format === "markdown" ? "- " : "• ";
        for (const item of def.items)
            lines.push(`${bullet}${itemLine(item, opts, def.withPriority)}`);
    }
}
/**
 * Render the standup as a single text blob for the chosen non-Block-Kit
 * format. `slack` is byte-identical to the historical output (mrkdwn);
 * `plain` drops emphasis punctuation; `markdown` uses `#`/`**`/`-`.
 */
export function buildTextMessage(data, opts) {
    const lines = [];
    const dateStr = todayISO();
    if (opts.channel) {
        lines.push(opts.format === "markdown" ? `> Channel: ${opts.channel}` : `> Channel: ${opts.channel}`);
    }
    const title = `📊 ${bold("pm standup", opts.format)} — ${dateStr}`;
    lines.push(opts.format === "markdown" ? `# 📊 pm standup — ${dateStr}` : title);
    lines.push("");
    const sections = resolveSections(data, opts);
    if (opts.compact) {
        // Compact: one line per non-empty section, no per-item bullets / grouping.
        for (const def of sections) {
            const line = compactSectionLine(def, opts);
            if (line)
                lines.push(line);
        }
    }
    else {
        sections.forEach((def, idx) => {
            if (idx > 0)
                lines.push("");
            renderSection(lines, def, opts);
        });
    }
    // Trend footer (from `--compare`): a single directional summary line.
    if (opts.trend && opts.trend.length > 0) {
        const trendLine = renderTrendLine(opts.trend);
        if (trendLine) {
            lines.push("");
            lines.push(opts.format === "markdown" ? `_${trendLine}_` : trendLine);
        }
    }
    // History footer (from `--compare <dir>` with 2+ snapshots): per-section
    // count sequences across snapshots, ending at the current standup.
    if (opts.history && opts.history.length >= 2) {
        const historyLine = renderHistoryLine(opts.history, currentCounts(data));
        if (historyLine) {
            if (!(opts.trend && opts.trend.length > 0))
                lines.push("");
            lines.push(opts.format === "markdown" ? `_${historyLine}_` : historyLine);
        }
    }
    return lines.join("\n");
}
function mrkdwnList(items, opts, withPriority = false) {
    if (items.length === 0)
        return "_none_";
    if (isGrouped(opts)) {
        const parts = [];
        for (const [key, group] of groupItems(items, opts.groupBy)) {
            const name = groupLabel(key, opts.groupBy);
            parts.push(`*${name}*`);
            for (const item of group)
                parts.push(`• ${itemLine(item, opts, withPriority)}`);
        }
        return parts.join("\n");
    }
    return items.map((item) => `• ${itemLine(item, opts, withPriority)}`).join("\n");
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
export function buildBlockKit(data, opts) {
    const blocks = [];
    const dateStr = todayISO();
    const truncate = (text, max) => text.length <= max ? text : text.slice(0, max - 1) + "…";
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
        if (opts.compact) {
            // Compact: collapse all non-empty sections into a single section block,
            // one summary line each (titles only), to minimize block count.
            const lines = resolveSections(data, opts)
                .map((d) => compactSectionLine(d, opts))
                .filter(Boolean);
            if (lines.length > 0) {
                blocks.push({
                    type: "section",
                    text: { type: "mrkdwn", text: truncate(lines.join("\n"), 3000) },
                });
            }
            break;
        }
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: truncate(`${def.emoji} *${def.title}* (${def.items.length})\n${mrkdwnList(def.items, opts, def.withPriority)}`, 3000),
            },
        });
    }
    blocks.push({ type: "divider" });
    const groupNote = {
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
    const footerElements = [
        { type: "mrkdwn", text: `🤖 pm-slack-standup · ${footerBits.join(" · ")}` },
    ];
    // Trend footer (from `--compare`): a second context element so the
    // directional summary stays visually distinct from the meta line.
    if (opts.trend && opts.trend.length > 0) {
        const trendLine = renderTrendLine(opts.trend);
        if (trendLine)
            footerElements.push({ type: "mrkdwn", text: trendLine });
    }
    // History footer (from `--compare <dir>`): per-section count sequences
    // across snapshots, ending at the current standup.
    if (opts.history && opts.history.length >= 2) {
        const historyLine = renderHistoryLine(opts.history, currentCounts(data));
        if (historyLine)
            footerElements.push({ type: "mrkdwn", text: historyLine });
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
export function renderStandup(data, opts) {
    if (opts.format === "blockkit") {
        const { blocks } = buildBlockKit(data, opts);
        return JSON.stringify({ blocks }, null, 2);
    }
    return buildTextMessage(data, opts);
}
// ---------------------------------------------------------------------------
// Slack transport
// ---------------------------------------------------------------------------
function postToSlack(webhookUrl, payload) {
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
            res.on("data", (chunk) => (respBody += chunk.toString()));
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolvePromise();
                }
                else {
                    reject(new Error(`Slack webhook returned HTTP ${res.statusCode ?? "unknown"}: ${respBody}`));
                }
            });
        });
        req.on("error", (err) => reject(new Error(`Slack webhook request failed: ${err.message}`)));
        req.setTimeout(10_000, () => req.destroy(new Error("Slack webhook request timed out after 10s")));
        req.write(body);
        req.end();
    });
}
/**
 * Resolve the ordered list of post targets from `--webhook`/env + `--channel`
 * + `--channels`. Each `--channels` token is either a `#name` (posted to the
 * base webhook, just changing the displayed channel) or a full webhook URL
 * (posted to that URL). When no `--channels` is given, a single target using
 * the base webhook + `--channel` is returned. De-dupes (webhook,channel) pairs.
 */
export function resolvePostTargets(baseWebhook, baseChannel, channels) {
    if (channels.length === 0) {
        return [{ webhookUrl: baseWebhook, channel: baseChannel }];
    }
    const out = [];
    const seen = new Set();
    for (const token of channels) {
        const target = isWebhookUrl(token)
            ? { webhookUrl: token, channel: baseChannel }
            : { webhookUrl: baseWebhook, channel: token };
        const dedupeKey = `${target.webhookUrl}\u0000${target.channel ?? ""}`;
        if (seen.has(dedupeKey))
            continue;
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
export async function postStandupTargets(targets, data, baseOpts, poster) {
    const results = [];
    for (const target of targets) {
        const opts = { ...baseOpts, channel: target.channel };
        const { blocks, fallback } = buildBlockKit(data, opts);
        try {
            await poster(target.webhookUrl, { text: fallback, blocks, mrkdwn: true });
            results.push({ channel: target.channel, ok: true });
        }
        catch (err) {
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
export function isPostRequested(options) {
    return !readBoolOption(options, "dry-run");
}
/**
 * Resolve whether a *base* Slack webhook is required for this post. `--channels`
 * may carry full webhook URLs that are self-sufficient targets; but if there is
 * no `--channels` at all, or any `--channels` entry is a bare `#name`, the base
 * webhook (`--webhook` / `PM_SLACK_WEBHOOK`) is needed to actually deliver.
 */
export function needsBaseWebhook(channels) {
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
export function preflightSlackCredentials(options) {
    if (!isPostRequested(options))
        return;
    const webhookUrl = readStrOption(options, "webhook") ?? process.env["PM_SLACK_WEBHOOK"] ?? "";
    const channels = parseChannels(readStrOption(options, "channels"));
    if (!webhookUrl && needsBaseWebhook(channels)) {
        throw new CommandError("Slack post requested but no webhook is configured. " +
            "Set PM_SLACK_WEBHOOK or pass --webhook <url> (or provide full webhook " +
            "URLs via --channels). To preview without posting, use --dry-run.", EXIT_CODE.USAGE);
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
export function resolveStandupOptions(options, format) {
    const since = readStrOption(options, "since");
    const days = parseDays(readStrOption(options, "days"));
    const splitYesterday = readBoolOption(options, "yesterday");
    const opts = {
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
        upNextCount: resolveUpNextCount(readStrOption(options, "up-next"), readBoolOption(options, "all-open")),
        team: parseTeam(readStrOption(options, "team")),
        includeBlockers: readBoolOption(options, "include-blockers"),
        compact: readBoolOption(options, "compact"),
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
export function currentCounts(data) {
    return {
        in_progress: data.wip.length,
        blocked: data.blocked.length,
        done: data.done.length,
        up_next: data.upNext.length,
    };
}
/** A safe non-negative integer count, or undefined when not a usable number. */
function coerceCount(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        return undefined;
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
export function extractPriorCounts(parsed) {
    if (!parsed || typeof parsed !== "object")
        return undefined;
    const root = parsed;
    const fromCountsObject = (obj) => {
        if (!obj || typeof obj !== "object")
            return undefined;
        const c = obj;
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
    if (fromCounts)
        return fromCounts;
    // Fallback: count the per-section item arrays the exporter also writes.
    const sd = root["sections_data"] ?? root["sections"];
    if (sd && typeof sd === "object" && !Array.isArray(sd)) {
        const s = sd;
        const len = (k, alt) => {
            const v = Array.isArray(s[k]) ? s[k].length : alt && Array.isArray(s[alt]) ? s[alt].length : undefined;
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
export function readPriorCounts(path, warn = (m) => console.error(m)) {
    let raw;
    try {
        raw = readFileSync(resolve(path), "utf-8");
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        warn(`warning: --compare '${path}' could not be read (${detail}); rendering standup without trend deltas.`);
        return undefined;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        warn(`warning: --compare '${path}' is not valid JSON; rendering standup without trend deltas.`);
        return undefined;
    }
    const counts = extractPriorCounts(parsed);
    if (!counts) {
        warn(`warning: --compare '${path}' has no recognizable standup counts ` +
            `(expected a 'counts' object from 'standup export --format json'); rendering standup without trend deltas.`);
        return undefined;
    }
    return counts;
}
/**
 * True when `path` exists and is a directory (a snapshot history directory
 * written by `standup export --history-dir`). Never throws.
 */
export function isDirectory(path) {
    try {
        return statSync(resolve(path)).isDirectory();
    }
    catch {
        return false;
    }
}
/**
 * List the standup snapshot JSON files inside a history directory, oldest
 * first. Snapshot files are sorted by filename (the exporter writes
 * `standup-YYYY-MM-DD.json`, so lexicographic order IS chronological order);
 * unrelated JSON entries are ignored. Returns absolute paths.
 */
export function listSnapshotFiles(dir) {
    const root = resolve(dir);
    let entries;
    try {
        entries = readdirSync(root);
    }
    catch {
        return [];
    }
    return entries
        .filter((name) => /^standup-\d{4}-\d{2}-\d{2}\.json$/i.test(name))
        .sort((a, b) => a.localeCompare(b))
        .map((name) => join(root, name));
}
/**
 * Read a multi-snapshot history from a `--compare <dir>` directory. Each
 * `*.json` file is parsed with the same tolerant count extraction as a single
 * `--compare <file>`; unreadable/unrecognizable snapshots are skipped with one
 * stderr warning each. At most {@link HISTORY_MAX_SNAPSHOTS} newest snapshots
 * are kept (oldest first). Labels prefer the snapshot's own `date` field and
 * fall back to the file name. Returns an empty array when nothing is usable.
 */
export function readSnapshotHistory(dir, warn = (m) => console.error(m)) {
    const files = listSnapshotFiles(dir).slice(-HISTORY_MAX_SNAPSHOTS);
    const out = [];
    for (const file of files) {
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(file, "utf-8"));
        }
        catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            warn(`warning: skipping snapshot '${file}' (${detail}).`);
            continue;
        }
        const counts = extractPriorCounts(parsed);
        if (!counts) {
            warn(`warning: skipping snapshot '${file}' (no recognizable standup counts).`);
            continue;
        }
        const date = parsed && typeof parsed === "object" && typeof parsed["date"] === "string"
            ? parsed["date"]
            : basename(file).replace(/\.json$/i, "");
        out.push({ label: date, counts });
    }
    return out;
}
/**
 * Build the one-line history summary shown below the trend footer when
 * `--compare` points at a snapshot directory with 2+ snapshots, e.g.
 * "History (3 snapshots → today): In Progress 2→3→1 · Done 4→6→9".
 * Sections whose counts never change across the window are still shown so the
 * line stays positionally stable. Returns "" for fewer than 2 snapshots.
 */
export function renderHistoryLine(history, current) {
    if (history.length < 2)
        return "";
    const seq = (key) => [...history.map((s) => s.counts[key] ?? 0), current[key] ?? 0].join("→");
    const parts = ALL_SECTIONS.map((key) => `${SECTION_META[key].title} ${seq(key)}`);
    return `History (${history.length} snapshots → now): ${parts.join(" · ")}`;
}
/**
 * Compute per-section deltas (current − prior) for every standup section.
 * A positive delta is "up", negative "down", zero "flat". The ordering
 * follows ALL_SECTIONS so output is stable.
 */
export function computeDeltas(prior, current) {
    return ALL_SECTIONS.map((key) => {
        const p = prior[key] ?? 0;
        const c = current[key] ?? 0;
        const delta = c - p;
        const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
        return { key, prior: p, current: c, delta, direction };
    });
}
/** Render one section delta as e.g. "In Progress ▲+2" / "Blocked ▼-1" / "Done →0". */
export function formatDelta(d) {
    const glyph = TREND_GLYPH[d.direction];
    const num = d.delta > 0 ? `+${d.delta}` : `${d.delta}`;
    return `${SECTION_META[d.key].title} ${glyph}${num}`;
}
/**
 * Build the one-line trend summary shown in the standup footer, e.g.
 * "Trend vs prior: In Progress ▲+2 · Blocked ▼-1 · Done →0 · Up Next →0".
 * Returns the empty string when there are no deltas to show.
 */
export function renderTrendLine(deltas) {
    if (deltas.length === 0)
        return "";
    return `Trend vs prior: ${deltas.map(formatDelta).join(" · ")}`;
}
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
// True once the scoped `output_format` service override is registered. When
// the host runtime lacks `registerService`, the exporter falls back to writing
// stdout directly (legacy behavior, envelope included).
let exportStdoutViaService = false;
export default defineExtension({
    name: "pm-slack-standup",
    version: "2026.8.16",
    activate(api) {
        const standupFlags = [
            { long: "--webhook", value_name: "url", description: "Slack incoming webhook URL (overrides PM_SLACK_WEBHOOK env var)" },
            { long: "--channel", value_name: "name", description: "Channel name shown in the message (e.g. #team-eng)" },
            { long: "--dry-run", description: "Build and print the message in the chosen format WITHOUT posting to Slack" },
            { long: "--format", value_name: "fmt", description: "Output format: slack (mrkdwn, default) | blockkit | blocks (Block Kit JSON) | markdown | plain" },
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
            { long: "--compare", value_name: "path", description: "Show trend deltas vs a PRIOR standup JSON file, or vs a snapshot DIRECTORY (from 'standup export --history-dir') for multi-snapshot history; local read, never posts" },
            { long: "--schedule", value_name: "when", description: "Schedule the post instead of sending now: HH:MM (daily, local) or a 5-field cron expression (min hour dom mon dow); the process waits until the next fire time" },
            { long: "--include-blockers", description: "Highlight blocked rows with a 🚨 marker in every format so impediments stand out" },
            { long: "--team", value_name: "list", description: "Filter the standup to items assigned to the given members (comma list, e.g. alice,bob); items with no assignee are hidden" },
            { long: "--compact", description: "Render a shorter one-line-per-section standup (titles only, no per-item bullets / grouping sub-headers, empty sections omitted)" },
        ];
        // Typed against the SDK's real `CommandHandlerContext` so this closure
        // is contract-checked against the same shape `registerCommand`'s `run`
        // field expects (a `CommandHandler`). It is shared by both the `standup`
        // and `slack-standup` registrations, which are both ordinary command
        // handlers, so a single context type covers every call site.
        const runStandupCommand = async (ctx) => {
            // Fail-fast credential gate: if a Slack post is actually requested
            // (i.e. NOT --dry-run) but no webhook is configured, abort immediately
            // with a clear, actionable, non-zero error — before reading any pm data
            // or rendering anything. The non-posting --dry-run preview path is never
            // gated, so the legitimate stdout-fallback shape keeps working.
            preflightSlackCredentials(ctx.options);
            const webhookUrl = readStrOption(ctx.options, "webhook") ?? process.env["PM_SLACK_WEBHOOK"] ?? "";
            const dryRun = readBoolOption(ctx.options, "dry-run");
            const { opts, sinceMs } = resolveStandupOptions(ctx.options, parseFormat(readStrOption(ctx.options, "format")));
            // `--schedule`: defer the actual post to the next computed fire time
            // (HH:MM daily, or a 5-field cron expression). In `--dry-run` we just
            // report the resolved schedule without waiting. Otherwise the process
            // waits until the fire time, then posts normally below.
            //
            // IMPORTANT: for non-dry-run schedules the wait happens BEFORE the pm
            // data is fetched/built, so the posted standup reflects state at the
            // fire time rather than the (potentially stale) snapshot from when the
            // command was started. A command started at 08:00 for 09:30 thus posts
            // the 09:30 standup, not the 08:00 one.
            const scheduleSpec = parseSchedule(readStrOption(ctx.options, "schedule"));
            let scheduledAt;
            if (scheduleSpec) {
                const fireAt = nextFireTime(scheduleSpec, Date.now());
                scheduledAt = new Date(fireAt).toISOString();
                if (dryRun) {
                    console.error(`Scheduled: next post at ${scheduledAt} (${scheduleSpec.raw}); --dry-run, not waiting.`);
                }
                else {
                    const waitMs = Math.max(0, fireAt - Date.now());
                    console.error(`Scheduled: posting at ${scheduledAt} (${scheduleSpec.raw}); waiting ${Math.round(waitMs / 1000)}s...`);
                    // Node's setTimeout clamps delays larger than 2^31-1 ms (~24.8
                    // days) to 1 ms, which would fire immediately for sparse cron
                    // expressions. Sleep in <= 24-day chunks to stay under the limit.
                    const MAX_CHUNK_MS = 24 * 86_400_000;
                    let remaining = waitMs;
                    while (remaining > 0) {
                        const chunk = Math.min(remaining, MAX_CHUNK_MS);
                        await new Promise((res) => setTimeout(res, chunk));
                        remaining -= chunk;
                    }
                }
            }
            // Fetch and bucket the standup AFTER any schedule wait, so a scheduled
            // (non-dry-run) post reflects the current pm state at fire time.
            const items = fetchAllItems(ctx.pm_root);
            const data = buildStandupData(items, opts, sinceMs);
            // `--compare <path>`: read a PRIOR standup JSON and attach per-section
            // trend deltas. Pure local file read; a missing/malformed/wrong-shape
            // file warns to stderr and leaves `opts.trend` unset (normal render).
            // When <path> is a DIRECTORY (a snapshot history written by
            // `standup export --history-dir`), the newest snapshot provides the
            // trend baseline and the full window renders a multi-snapshot history
            // line (count sequences per section).
            const comparePath = readStrOption(ctx.options, "compare");
            if (comparePath) {
                if (isDirectory(comparePath)) {
                    const history = readSnapshotHistory(comparePath);
                    if (history.length === 0) {
                        console.error(`warning: --compare '${comparePath}' is a directory with no usable standup snapshots; rendering standup without trend deltas.`);
                    }
                    else {
                        opts.trend = computeDeltas(history[history.length - 1].counts, currentCounts(data));
                        if (history.length >= 2)
                            opts.history = history;
                    }
                }
                else {
                    const prior = readPriorCounts(comparePath);
                    if (prior)
                        opts.trend = computeDeltas(prior, currentCounts(data));
                }
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
                    scheduledAt,
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
                throw new CommandError("Slack post requested but no webhook is configured. " +
                    "Set PM_SLACK_WEBHOOK or pass --webhook <url>, " +
                    "or use --dry-run to preview the message without posting.", EXIT_CODE.USAGE);
            }
            const targets = resolvePostTargets(webhookUrl, opts.channel, channels);
            const results = await postStandupTargets(targets, data, opts, postToSlack);
            const failures = results.filter((r) => !r.ok);
            if (failures.length > 0 && fallbackToStdout) {
                // Print the rendered standup so the work isn't lost on a transport
                // failure. We exit 0 here: stdout delivery is the requested fallback.
                for (const f of failures) {
                    console.error(`Slack post to ${f.channel ?? "(default channel)"} failed: ${f.error ?? "unknown error"} — falling back to stdout.`);
                }
                const rendered = renderStandup(data, opts);
                process.stdout.write(rendered + "\n");
                return {
                    posted: results.some((r) => r.ok),
                    fallbackToStdout: true,
                    results,
                    scheduledAt,
                    wip: data.wip.length,
                    blocked: data.blocked.length,
                    done: data.done.length,
                    upNext: data.upNext.length,
                };
            }
            if (failures.length > 0) {
                throw new CommandError(`Slack post failed for ${failures.length} of ${targets.length} target(s): ` +
                    failures.map((f) => `${f.channel ?? "(default)"}: ${f.error ?? "unknown"}`).join("; "), EXIT_CODE.GENERIC_FAILURE);
            }
            return {
                posted: true,
                channel: opts.channel,
                channels: targets.length > 1 ? targets.map((t) => t.channel) : undefined,
                scheduledAt,
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
                "pm standup --dry-run --compare standup.json",
                "pm standup --dry-run --compare .standup-history",
                "pm standup --dry-run --team alice,bob --compact",
                "pm standup --dry-run --include-blockers --format blockkit",
                "pm standup --schedule 09:30 --channel '#team-eng'",
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
        // Scoped, not global: `registerPreflight` treats the bare-function form as
        // applying to every command, so two packages that both use it collide in
        // `pm health` even though neither guards the other's commands. Declaring the
        // owned command keeps this override off every other package's path.
        api.registerPreflight({
            // EVERY registered command path, not just `standup`. `slack-standup` is
            // registered as a full command sharing `runStandupCommand`, not as a
            // Commander alias, and `standup export` is its own path — the runtime
            // matches each by its exact normalized name, so a scope naming only
            // `standup` left the other two outside this override entirely. The
            // registration is a pass-through today, so nothing misbehaves at runtime,
            // but the declared scope is this package's ownership claim as `pm health`
            // reads it, and if the override ever becomes authoritative the omitted
            // paths would silently escape its gate. The smoke test derives the
            // expected list from the real activation, so a newly registered command
            // path cannot be added without appearing here.
            commands: ["standup", "slack-standup", "standup export"],
            // Mirror the handler's contract without aborting here (the runtime
            // swallows throws from preflight). An empty delta is an explicit
            // pass-through that leaves the runtime's preflight decision untouched.
            run: () => ({}),
        });
        // -----------------------------------------------------------------------
        // Output-format service override (scoped to `standup export`).
        //
        // pm renders every extension command's RETURN VALUE to stdout as a result
        // envelope (TOON by default, JSON with --json). The exporter's stdout mode
        // must emit ONLY the exported document — `standup export --format json >
        // f.json` has to produce valid JSON for the documented `--compare`
        // round-trip. The sanctioned SDK mechanism is an `output_format` service
        // override: when the active command is `standup export` and the handler
        // result carries our raw-stdout marker, return the export string verbatim
        // (pm prints exactly that string); for every other command/result DECLINE
        // with the `{ handled: false }` decision so the host renders normally.
        //
        // Declining must NOT be done by returning `sctx.payload`. As of
        // @unbrained/pm-cli 2026.7.27 an override's bare return value IS what the
        // host renders, so echoing the payload made EVERY command in a workspace
        // with this extension installed print the whole command context (`global`,
        // `format`, `options`, …) instead of its own result. The SDK's
        // `declineServiceOverride()` returns exactly this object, but it is a
        // runtime value this extension deliberately does not depend on.
        // -----------------------------------------------------------------------
        if (typeof api.registerService === "function") {
            api.registerService("output_format", (sctx) => {
                const payload = sctx?.payload;
                const command = (sctx?.command ?? payload?.["command"] ?? "").trim();
                if (command === "standup export") {
                    const result = payload?.["result"];
                    if (result && result["raw_stdout"] === true && typeof result["output"] === "string") {
                        return result["output"];
                    }
                }
                return { handled: false };
            });
            exportStdoutViaService = true;
        }
        // -----------------------------------------------------------------------
        // Exporter: standup  →  `pm standup export`
        // Writes the standup to a file (or stdout) as Markdown or JSON. JSON emits
        // the full Block Kit payload so it can be POSTed elsewhere or archived.
        // (No collision with the `pm standup` command — different invocation.)
        // -----------------------------------------------------------------------
        const exporterFlags = [
            { long: "--format", value_name: "fmt", description: "Export format: md (markdown, default) | json (counts + sections + Block Kit payload)" },
            { long: "--output", value_name: "file", description: "Write the export to this file instead of stdout" },
            { long: "--history-dir", value_name: "dir", description: "Also write a dated JSON snapshot to <dir>/standup-YYYY-MM-DD.json (for 'pm standup --compare <dir>' trends)" },
            { long: "--include-done", description: "Include recently-closed items in a Done section" },
            { long: "--since", value_name: "iso", description: "ISO date/time window; scopes the Done section to items updated since then" },
            { long: "--days", value_name: "n", description: "Relative window: scope Done to items updated in the last N days" },
            { long: "--group-by", value_name: "field", description: "Group section items by status (default) | assignee | sprint | type | milestone" },
            { long: "--up-next", value_name: "n", description: "How many open items the Up Next section shows (default 3)" },
            { long: "--all-open", description: "Show ALL open items in Up Next (no truncation); overrides --up-next" },
            { long: "--sections", value_name: "list", description: "Comma list of sections to render: in_progress,blocked,done,up_next" },
            { long: "--mention-map", value_name: "map", description: "Map pm authors to Slack handles, e.g. 'alice=@alice,bob=@bob'" },
            { long: "--yesterday", description: "Split the Done section into 'Done Yesterday' / 'Done Today' by local day (implies --include-done)" },
            { long: "--channel", value_name: "name", description: "Channel name recorded in the exported document" },
            { long: "--section-labels", value_name: "map", description: "Override section titles/emoji, e.g. 'in_progress=Rolling,blocked=🔥 On Fire'" },
            { long: "--include-blockers", description: "Highlight blocked rows with a 🚨 marker in every format so impediments stand out" },
            { long: "--team", value_name: "list", description: "Filter the standup to items assigned to the given members (comma list, e.g. alice,bob); items with no assignee are hidden" },
            { long: "--compact", description: "Render a shorter one-line-per-section standup (titles only, no per-item bullets / grouping sub-headers, empty sections omitted)" },
        ];
        api.registerExporter("standup", async (ctx) => {
            const rawFormat = (readStrOption(ctx.options, "format") ?? "md").toLowerCase();
            // For the exporter, --format selects the file format (md|json); the text
            // rendering is always markdown. We resolve options with markdown rather
            // than routing the exporter's md|json through the command's --format
            // validator (which only knows slack|blockkit|markdown|plain).
            const fileFormat = rawFormat === "json" ? "json" : "md";
            const { opts, sinceMs } = resolveStandupOptions(ctx.options, "markdown");
            const exportOpts = opts;
            const historyDir = readStrOption(ctx.options, "history-dir");
            const items = fetchAllItems(ctx.pm_root);
            const data = buildStandupData(items, exportOpts, sinceMs);
            const snapshotDate = localDayKeyOf(Date.now());
            const buildJsonSnapshot = () => {
                const { blocks, fallback } = buildBlockKit(data, opts);
                return JSON.stringify({
                    date: snapshotDate,
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
                }, null, 2);
            };
            const output = fileFormat === "json" ? buildJsonSnapshot() : buildTextMessage(data, exportOpts);
            // `--history-dir <dir>`: additionally write a dated JSON snapshot
            // (one per local day, overwritten on re-export) so `pm standup
            // --compare <dir>` can render multi-snapshot trends. Always JSON,
            // regardless of the primary --format.
            let historyFile;
            if (historyDir) {
                const dirAbs = resolve(historyDir);
                historyFile = join(dirAbs, `standup-${snapshotDate}.json`);
                try {
                    mkdirSync(dirAbs, { recursive: true });
                    writeFileSync(historyFile, (fileFormat === "json" ? output : buildJsonSnapshot()) + "\n", "utf-8");
                }
                catch (err) {
                    throw writeError(historyFile, err);
                }
                console.error(`standup export: wrote history snapshot to ${historyFile}`);
            }
            const outputPath = readStrOption(ctx.options, "output");
            if (outputPath) {
                const absolutePath = resolve(outputPath);
                try {
                    writeFileSync(absolutePath, output + "\n", "utf-8");
                }
                catch (err) {
                    throw writeError(absolutePath, err);
                }
                console.error(`standup export: wrote ${data.total} item(s) as ${fileFormat} to ${absolutePath}`);
                return { exported: data.total, format: fileFormat, file: absolutePath, history_file: historyFile };
            }
            console.error(`standup export: rendered ${data.total} item(s) as ${fileFormat}.`);
            if (exportStdoutViaService) {
                // The scoped `output_format` service prints `output` verbatim, so
                // stdout carries ONLY the exported document (valid JSON / markdown).
                return { exported: data.total, format: fileFormat, output, history_file: historyFile, raw_stdout: true };
            }
            // Fallback for runtimes without service overrides: write the document
            // ourselves (stdout will additionally carry pm's result envelope).
            console.log(output);
            return { exported: data.total, format: fileFormat, output, history_file: historyFile };
        }, {
            action: "standup-export",
            description: "Export the standup to a file or stdout as Markdown or JSON (counts, sections, Block Kit payload)",
            intent: "Archive a standup snapshot or feed another tool (stdout JSON is round-trip safe for --compare)",
            examples: [
                "pm standup export",
                "pm standup export --format json --output standup.json",
                "pm standup export --format json > standup.json",
                "pm standup export --include-done --days 7 --output standup.md",
                "pm standup export --format json --history-dir .standup-history",
            ],
            failure_hints: [
                "If the output path fails, ensure the parent directory exists and is writable.",
                "Run pm package doctor --project --detail deep --trace on activation failures.",
            ],
            flags: exporterFlags,
        });
    },
});
//# sourceMappingURL=index.js.map