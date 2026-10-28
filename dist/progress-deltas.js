import { createHash } from "node:crypto";
import { applyHistoryPatch, hashHistoryRecord, hashHistoryStream, PmClient } from "@unbrained/pm-cli/sdk";
/** Stable remedies remain safe even when a source record contains private or malformed data. */
const remedies = {
    invalid_input: "Use the strict version 1 evidence schema and documented bounded options in docs/progress-deltas.md.",
    checkpoint_mismatch: "Use this item's previous next token with its original append-only history; restart explicitly without after to replay.",
    history_unavailable: "Read pm history for this item with --verify --full; restore complete verified history before reporting progress.",
    invalid_output: "Retry the read and inspect the installed package version; emitted counters must be finite bounded integers.",
    output_limit: "Increase outputBytes up to 32768 or reduce events; the checkpoint was not advanced.",
};
/** Machine-readable refusal, shared by SDK consumers and the CLI expected-error renderer. */
export class ProgressRefusal extends Error {
    /** Expected CLI usage failure; no source text is interpolated. */
    exitCode = 2;
    /** Fixed corrective action for an agent to follow. */
    remedy;
    /** Stable machine-readable refusal code. */
    code;
    constructor(code) {
        super(`Progress refused (${code}). ${remedies[code]}`);
        this.code = code;
        this.name = "ProgressRefusal";
        this.remedy = remedies[code];
    }
}
/** Versioned comment prefix; other annotations are ordinary activity, never inferred evidence. */
export const PROGRESS_EVIDENCE_PREFIX = "standup-progress/v1 ";
/** Reject arrays and null before inspecting boundary objects. */
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Canonical display strings exclude controls but preserve normal Unicode and punctuation. */
function text(value) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\p{Cc}\u2028\u2029]/u.test(value);
}
/** One strict schema normalizes declarations for both the producer and reader. */
export function parseProgressEvidence(value) {
    if (!record(value) || Object.keys(value).sort().join(",") !== "evidenceRevision,kind,subject,targetRevision,value,version"
        || value.version !== 1 || (value.kind !== "criterion" && value.kind !== "readiness")
        || !text(value.subject) || !text(value.targetRevision) || !text(value.evidenceRevision)
        || !(value.kind === "criterion" ? value.value === "accepted" : value.value === "ready" || value.value === "not_ready")) {
        throw new ProgressRefusal("invalid_input");
    }
    return { version: 1, kind: value.kind, subject: value.subject.trim(),
        targetRevision: value.targetRevision.trim(), evidenceRevision: value.evidenceRevision.trim(), value: value.value };
}
/** Produce a comment for the native SDK comments API; this function itself writes nothing. */
export function encodeProgressEvidence(value) {
    return PROGRESS_EVIDENCE_PREFIX + JSON.stringify(parseProgressEvidence(value));
}
/** Inspect historical native comment data without tightening the host's persisted-item schema. */
export function inspectProgressComment(comment) {
    if (!record(comment) || typeof comment.text !== "string")
        return { kind: "invalid" };
    if (!comment.text.startsWith(PROGRESS_EVIDENCE_PREFIX))
        return { kind: "foreign" };
    try {
        if (comment.text.length > 8192)
            throw new ProgressRefusal("invalid_input");
        const evidence = parseProgressEvidence(JSON.parse(comment.text.slice(PROGRESS_EVIDENCE_PREFIX.length)));
        if (!text(comment.author) || !text(comment.created_at))
            return { kind: "invalid" };
        return { kind: "evidence", evidence };
    }
    catch {
        return { kind: "invalid" };
    }
}
/** Length-prefixed JSON tuples avoid delimiter collisions and prototype-key lookups. */
function digest(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Validate the entire options boundary before acquiring or reading the SDK. */
export function parseProgressOptions(value) {
    if (!record(value) || Object.keys(value).some((key) => !["after", "events", "outputBytes"].includes(key)))
        throw new ProgressRefusal("invalid_input");
    const { after } = value;
    const events = value.events === undefined ? 100 : typeof value.events === "string" ? Number(value.events) : value.events;
    const outputBytes = value.outputBytes === undefined ? 8192 : typeof value.outputBytes === "string" ? Number(value.outputBytes) : value.outputBytes;
    if ((after !== undefined && (typeof after !== "string" || after.trim().length === 0 || after.length > 1024)) || !Number.isSafeInteger(events) || Number(events) < 1 || Number(events) > 500
        || !Number.isSafeInteger(outputBytes) || Number(outputBytes) < 1024 || Number(outputBytes) > 32768)
        throw new ProgressRefusal("invalid_input");
    return { after: after, events: Number(events), outputBytes: Number(outputBytes) };
}
/** Decode a canonical checkpoint without accepting truncated JSON, sparse tuples or unsafe counts. */
function checkpoint(after, id, history) {
    if (after === "")
        return 0;
    let value;
    try {
        value = JSON.parse(Buffer.from(after, "base64url").toString("utf8"));
    }
    catch {
        throw new ProgressRefusal("checkpoint_mismatch");
    }
    if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== digest(id) || !Number.isSafeInteger(value[2])
        || value[2] < 1 || value[2] > history.length || value[3] !== hashHistoryStream(history.slice(0, value[2]))
        || Buffer.from(JSON.stringify(value)).toString("base64url") !== after)
        throw new ProgressRefusal("checkpoint_mismatch");
    return value[2];
}
/** Native arrays are consumed record-by-record; a bad legacy record never discards its neighbors. */
function records(value) { return Array.isArray(value) ? value : []; }
/** Validate every numeric output field before an ok report can leave the SDK boundary. */
export function validateProgressNumbers(report) {
    const counts = [report.from, report.through, report.remaining, ...Object.values(report.activity), ...Object.values(report.ignored)];
    if (counts.some((value) => !Number.isSafeInteger(value) || value < 0) || report.through < report.from
        || report.gains.some((gain) => !Number.isSafeInteger(gain.count) || gain.count < 1 || gain.count > 1000000
            || !Number.isSafeInteger(gain.revision.version) || gain.revision.version <= report.from || gain.revision.version > report.through)) {
        throw new ProgressRefusal("invalid_output");
    }
}
/** Read a single item's verified history with a host-injected client or the package's supported SDK adapter. */
export async function readProgressDeltas(ctx, id, rawOptions = {}) {
    const options = parseProgressOptions(rawOptions);
    if (typeof id !== "string" || id.trim().length === 0)
        throw new ProgressRefusal("invalid_input");
    const client = ctx.sdk?.client ?? new PmClient({ pmRoot: ctx.pm_root, noExtensions: true });
    const result = await client.run("history", { id, options: { verify: true, compact: false, outputBudget: "unbounded", outputLimit: "unbounded", outputInclude: "full" } });
    if (!result.history?.length || !result.verification?.ok
        || result.version_addressing !== undefined)
        throw new ProgressRefusal("history_unavailable");
    const hashes = result.history.map((entry) => hashHistoryRecord(entry));
    const from = checkpoint(options.after ?? "", result.id, result.history);
    const through = Math.min(result.history.length, from + options.events);
    const report = { ok: true, id: result.id, gains: [], activity: { status: 0, comments: 0, other: 0 },
        ignored: { invalid: 0, foreign: 0, duplicate: 0, unchanged: 0 }, from, through, remaining: result.history.length - through,
        next: Buffer.from(JSON.stringify([1, digest(result.id), through, hashHistoryStream(result.history.slice(0, through))])).toString("base64url") };
    let state = { metadata: {}, body: "" };
    const seen = new Set();
    const knownComments = new Set();
    const readiness = new Map();
    for (let index = 0; index < through; index++) {
        const entry = result.history[index];
        const previous = state.metadata;
        state = applyHistoryPatch(state, entry.patch, index + 1, entry.op);
        const inWindow = index >= from;
        const revision = { version: index + 1, digest: hashes[index] };
        if (inWindow) {
            if (previous.status !== state.metadata.status)
                report.activity.status++;
            else if (entry.op.startsWith("comment"))
                report.activity.comments++;
            else
                report.activity.other++;
        }
        /** Attribute first observation to its immutable revision and suppress replayed evidence across all prior windows. */
        const admit = (key, gain) => {
            if (seen.has(key)) {
                if (inWindow)
                    report.ignored.duplicate++;
                return;
            }
            seen.add(key);
            if (gain.kind === "readiness") {
                const subject = digest([gain.subject, gain.targetRevision]);
                const previousValue = readiness.get(subject);
                readiness.set(subject, gain.value);
                if (previousValue === gain.value) {
                    if (inWindow)
                        report.ignored.unchanged++;
                    return;
                }
            }
            if (inWindow)
                report.gains.push({ ...gain, revision });
        };
        for (const run of records(state.metadata.test_runs)) {
            if (!record(run) || run.status !== "passed")
                continue;
            if (!text(run.run_id) || !Number.isSafeInteger(run.passed) || Number(run.passed) < 1 || Number(run.passed) > 1000000 || run.failed !== 0 || run.skipped !== 0) {
                if (inWindow)
                    report.ignored.invalid++;
                continue;
            }
            const key = digest(["test", run.run_id]);
            // Existing records on unchanged item revisions are not duplicate input activity.
            if (records(previous.test_runs).some((old) => record(old) && old.run_id === run.run_id))
                continue;
            admit(key, { kind: "passing_tests", subject: run.run_id, targetRevision: `item:${result.id}:v${index + 1}`,
                evidenceRevision: `run:${run.run_id}`, value: "passed", count: Number(run.passed) });
        }
        for (const comment of records(state.metadata.comments)) {
            const commentKey = digest([comment]);
            if (knownComments.has(commentKey))
                continue;
            knownComments.add(commentKey);
            const inspected = inspectProgressComment(comment);
            if (inspected.kind !== "evidence") {
                if (inWindow)
                    report.ignored[inspected.kind]++;
                continue;
            }
            const { evidence } = inspected;
            const key = digest([evidence.kind, evidence.subject, evidence.targetRevision, evidence.evidenceRevision, evidence.value]);
            admit(key, { kind: evidence.kind, subject: evidence.subject, targetRevision: evidence.targetRevision,
                evidenceRevision: evidence.evidenceRevision, value: evidence.value, count: 1 });
        }
    }
    validateProgressNumbers(report);
    if (Buffer.byteLength(JSON.stringify(report)) > options.outputBytes)
        throw new ProgressRefusal("output_limit");
    return report;
}
//# sourceMappingURL=progress-deltas.js.map