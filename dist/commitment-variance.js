import { applyHistoryPatch, hashHistoryRecord, hashHistoryStream, normalizeItemId, normalizeStatusInputWithRegistry, readSettingsWithMetadata, replayHistoryToTarget, resolveRuntimeStatusRegistry, statusIsTerminal, } from "@unbrained/pm-cli/sdk";
import { readVerifiedStandupHistory } from "./verified-history.js";
import { COMMITMENT_PREFIX, CommitmentRefusal, parseCommitmentVarianceInput, parseStandupCommitment } from "./commitment-schema.js";
export * from "./commitment-schema.js";
const scopeFields = ["title", "type", "parent", "sprint", "release", "dependencies", "blocked_by", "deadline"];
/** Inspect each annotation independently; foreign comments are skipped rather than interpreted. */
export function inspectStandupCommitments(comments) {
    const declarations = new Map();
    const ignored = { foreign: 0, invalid: 0 };
    const records = Array.isArray(comments) ? comments : [];
    for (const comment of records) {
        if (typeof comment !== "object" || comment === null || typeof comment.text !== "string") {
            ignored.invalid++;
            continue;
        }
        if (!comment.text.startsWith(COMMITMENT_PREFIX)) {
            ignored.foreign++;
            continue;
        }
        try {
            if (comment.text.length > 2048)
                throw new CommitmentRefusal("invalid_input");
            const declaration = parseStandupCommitment(JSON.parse(comment.text.slice(COMMITMENT_PREFIX.length)));
            declarations.set(declaration.key, declaration);
        }
        catch {
            ignored.invalid++;
        }
    }
    return { declarations, ignored };
}
/** Revisions use immutable record digests and monotonic stream positions, catching ABA edits. */
function revision(history, version) {
    return { version, digest: hashHistoryRecord(history.history[version - 1]) };
}
/** SDK replay owns native normalization on both sides of scope comparisons. */
function scopeChanges(before, after) {
    const changed = [];
    if (before.body !== after.body)
        changed.push("body");
    for (const field of scopeFields) {
        if (JSON.stringify(before.metadata[field]) !== JSON.stringify(after.metadata[field]))
            changed.push(field);
    }
    return changed;
}
/** Unavailable target captures are row-level uncertainty, never evidence of failure. */
async function historyOrMissing(pmRoot, id) {
    try {
        return await readVerifiedStandupHistory(pmRoot, id);
    }
    catch {
        return undefined;
    }
}
/** Compare native stream identity, including unavailable streams, without a content-only ABA check. */
function witness(history) {
    return history === undefined ? undefined : hashHistoryStream(history.history);
}
/** Keep settings I/O failures within the same safe typed refusal contract as native history. */
async function settingsOrRefuse(pmRoot, code) {
    try {
        const result = await readSettingsWithMetadata(pmRoot);
        if (result.warnings.some((warning) => warning.startsWith("settings_read_")))
            throw new CommitmentRefusal(code);
        return result.settings;
    }
    catch {
        throw new CommitmentRefusal(code);
    }
}
/** Validate every emitted count/revision and the exact count partition before returning ok. */
export function validateCommitmentNumbers(report) {
    const revisions = [report.source.selected, report.source.observed,
        ...report.rows.flatMap((row) => [row.baseline, row.observed].filter((entry) => entry !== null))];
    if (report.rows.length > 20 || Object.values(report.counts).some((count) => !Number.isSafeInteger(count) || count < 0 || count > 20)
        || Object.values(report.ignored).some((count) => !Number.isSafeInteger(count) || count < 0)
        || revisions.some((entry) => !Number.isSafeInteger(entry.version) || entry.version < 1 || entry.version > 1000000)
        || Object.values(report.counts).reduce((sum, count) => sum + count, 0) !== report.rows.length
        || Object.entries(report.counts).some(([state, count]) => report.rows.filter((row) => row.state === state).length !== count)) {
        throw new CommitmentRefusal("invalid_output");
    }
}
/**
 * Inspect a selected capture through SDK history, yielding between reads for cooperative hosts.
 * Drain this iterator to obtain a report; retain no frozen plan across retries. Rechecks detect
 * interleaving but cannot exclude an ordinary writer after its last check (core issue 1620).
 */
export async function* commitmentVarianceSteps(ctx, rawInput) {
    const input = parseCommitmentVarianceInput(rawInput);
    yield { phase: "settings", id: input.source.id };
    const settings = await settingsOrRefuse(ctx.pm_root, "history_unavailable");
    const registry = resolveRuntimeStatusRegistry(settings.schema);
    const nativeId = (id) => normalizeItemId(id, settings.id_prefix);
    yield { phase: "source", id: input.source.id };
    const source = await historyOrMissing(ctx.pm_root, input.source.id);
    if (source === undefined)
        throw new CommitmentRefusal("history_unavailable");
    if (source.compacted || input.source.revision > source.history.length || source.history.length > 10000)
        throw new CommitmentRefusal("revision_unavailable");
    const selected = replayHistoryToTarget(source.history, input.source.revision - 1);
    const captured = inspectStandupCommitments(selected.metadata.comments);
    const keys = input.keys ?? [...captured.declarations.keys()];
    if (keys.length > 20)
        throw new CommitmentRefusal("selection_limit");
    const changedDeclarations = new Set();
    const sourceScopeChanges = new Set();
    let subsequent = selected;
    for (let index = input.source.revision; index < source.history.length; index++) {
        const entry = source.history[index];
        subsequent = applyHistoryPatch(subsequent, entry.patch, index + 1, entry.op);
        for (const field of scopeChanges(selected, subsequent))
            sourceScopeChanges.add(`source.${field}`);
        const later = inspectStandupCommitments(subsequent.metadata.comments).declarations;
        for (const [key, declaration] of captured.declarations) {
            const updated = later.get(key);
            if (updated === undefined || nativeId(updated.target.id) !== nativeId(declaration.target.id)
                || updated.target.revision !== declaration.target.revision)
                changedDeclarations.add(key);
        }
    }
    const report = {
        ok: true, source: { id: source.id, selected: revision(source, input.source.revision), observed: revision(source, source.history.length) },
        capture: captured.declarations.size > 0 ? "available" : "missing",
        rows: [], counts: { completed: 0, changed_scope: 0, unsupported: 0, still_pending: 0 }, ignored: captured.ignored,
    };
    const histories = new Map([[source.id, source]]);
    for (const key of keys) {
        const declaration = captured.declarations.get(key);
        const row = { key, target: null, baseline: null, observed: null, state: "unsupported", reason: "missing_capture", changes: [] };
        if (declaration !== undefined) {
            const id = nativeId(declaration.target.id);
            row.target = id;
            if (!histories.has(id)) {
                yield { phase: "target", id };
                histories.set(id, await historyOrMissing(ctx.pm_root, id));
            }
            const target = histories.get(id);
            if (target === undefined || target.compacted || target.history.length > 10000 || declaration.target.revision > target.history.length) {
                row.reason = "target_history_unavailable";
            }
            else {
                row.baseline = revision(target, declaration.target.revision);
                row.observed = revision(target, target.history.length);
                const baseline = replayHistoryToTarget(target.history, declaration.target.revision - 1);
                let current = baseline;
                const changes = new Set(sourceScopeChanges);
                if (changedDeclarations.has(key))
                    changes.add("declaration");
                for (let index = declaration.target.revision; index < target.history.length; index++) {
                    const entry = target.history[index];
                    current = applyHistoryPatch(current, entry.patch, index + 1, entry.op);
                    for (const field of scopeChanges(baseline, current))
                        changes.add(field);
                }
                row.changes = [...changes].sort();
                const status = normalizeStatusInputWithRegistry(current.metadata.status, registry);
                if (baseline.metadata.id === undefined || current.metadata.id === undefined || status === undefined)
                    row.reason = "target_state_unavailable";
                else if (changes.size > 0 || registry.terminal_canceled_statuses.has(status)) {
                    row.state = "changed_scope";
                    row.reason = changes.size > 0 ? "scope_revised" : "canceled";
                }
                else if (registry.terminal_done_statuses.has(status)) {
                    row.state = "completed";
                    row.reason = "linked_done_status";
                }
                else if (statusIsTerminal(status, registry))
                    row.reason = "terminal_without_done_role";
                else if (registry.active_statuses.has(status) || registry.blocked_statuses.has(status) || registry.draft_statuses.has(status)
                    || registry.by_id.get(status)?.roles.includes("default_open")) {
                    row.state = "still_pending";
                    row.reason = "no_linked_completion";
                }
                else
                    row.reason = "status_without_lifecycle_role";
            }
        }
        report.rows.push(row);
        report.counts[row.state]++;
    }
    // Re-read every witness, including missing targets. No source or derived cache is written.
    for (const [id, history] of histories) {
        yield { phase: "recheck", id };
        if (witness(await historyOrMissing(ctx.pm_root, id)) !== witness(history))
            throw new CommitmentRefusal("source_changed");
    }
    yield { phase: "settings_recheck", id: source.id };
    if (JSON.stringify(await settingsOrRefuse(ctx.pm_root, "source_changed")) !== JSON.stringify(settings))
        throw new CommitmentRefusal("source_changed");
    validateCommitmentNumbers(report);
    if (Buffer.byteLength(JSON.stringify(report)) > input.outputBytes)
        throw new CommitmentRefusal("output_limit");
    return report;
}
/** Read a bounded receipt without capturing, importing, assigning, sending, or mutating tracker state. */
export async function readCommitmentVariance(ctx, input) {
    const steps = commitmentVarianceSteps(ctx, input);
    let step = await steps.next();
    while (!step.done)
        step = await steps.next();
    return step.value;
}
//# sourceMappingURL=commitment-variance.js.map