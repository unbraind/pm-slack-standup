import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import type { ProgressRevision } from "./progress-deltas.ts";
import type { StandupCommitment, CommitmentVarianceInput } from "./commitment-schema.ts";
export * from "./commitment-schema.ts";
/** Distinct epistemic outcomes; unsupported never means a failed commitment. */
export type CommitmentState = "completed" | "changed_scope" | "unsupported" | "still_pending";
/** Payload-free evidence row. Revisions identify native records, not test approval. */
export interface CommitmentVarianceRow {
    key: string;
    target: string | null;
    baseline: ProgressRevision | null;
    observed: ProgressRevision | null;
    state: CommitmentState;
    reason: string;
    changes: string[];
}
/** One bounded source selection, with per-record omissions and no source bodies. */
export interface CommitmentVarianceReport {
    ok: true;
    source: {
        id: string;
        selected: ProgressRevision;
        observed: ProgressRevision;
    };
    capture: "available" | "missing";
    rows: CommitmentVarianceRow[];
    counts: Record<CommitmentState, number>;
    ignored: {
        foreign: number;
        invalid: number;
    };
}
/** Cooperative read boundaries carry only identity; no locks or durable plans are retained. */
export interface CommitmentReadBoundary {
    phase: "settings" | "source" | "target" | "recheck" | "settings_recheck";
    id: string;
}
/** Inspect each annotation independently; foreign comments are skipped rather than interpreted. */
export declare function inspectStandupCommitments(comments: unknown): {
    declarations: Map<string, StandupCommitment>;
    ignored: CommitmentVarianceReport["ignored"];
};
/** Validate every emitted count/revision and the exact count partition before returning ok. */
export declare function validateCommitmentNumbers(report: CommitmentVarianceReport): void;
/**
 * Inspect a selected capture through SDK history, yielding between reads for cooperative hosts.
 * Drain this iterator to obtain a report; retain no frozen plan across retries. Rechecks detect
 * interleaving but cannot exclude an ordinary writer after its last check (core issue 1620).
 */
export declare function commitmentVarianceSteps(ctx: Pick<CommandHandlerContext, "pm_root" | "sdk">, rawInput: CommitmentVarianceInput): AsyncGenerator<CommitmentReadBoundary, CommitmentVarianceReport>;
/** Read a bounded receipt without capturing, importing, assigning, sending, or mutating tracker state. */
export declare function readCommitmentVariance(ctx: Pick<CommandHandlerContext, "pm_root" | "sdk">, input: CommitmentVarianceInput): Promise<CommitmentVarianceReport>;
//# sourceMappingURL=commitment-variance.d.ts.map