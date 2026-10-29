export { ProgressRefusal } from "./progress-refusals.ts";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
/** Explicit assessments cite both the assessed target and its supporting artifact revision. */
export interface ProgressEvidence {
    version: 1;
    kind: "criterion" | "readiness";
    subject: string;
    targetRevision: string;
    evidenceRevision: string;
    value: "accepted" | "ready" | "not_ready";
}
/** A durable item version plus immutable history-record digest, including legacy envelopes. */
export interface ProgressRevision {
    version: number;
    digest: string;
}
/** Bounded window controls; the caller retains next and supplies it as after on the next window. */
export interface ProgressOptions {
    after?: string;
    events?: number;
    outputBytes?: number;
}
/** One new recorded fact; a native run counts linked commands, never inferred test assertions. */
export interface ProgressGain {
    kind: "passing_tests" | "criterion" | "readiness";
    subject: string;
    targetRevision: string;
    evidenceRevision: string;
    value: string;
    count: number;
    revision: ProgressRevision;
}
/** Compact, replayable page with activity kept apart from evidence and explicit pagination. */
export interface ProgressReport {
    ok: true;
    id: string;
    gains: ProgressGain[];
    activity: {
        status: number;
        comments: number;
        other: number;
    };
    ignored: {
        invalid: number;
        foreign: number;
        duplicate: number;
        unchanged: number;
    };
    from: number;
    through: number;
    remaining: number;
    next: string;
}
/** Versioned comment prefix; other annotations are ordinary activity, never inferred evidence. */
export declare const PROGRESS_EVIDENCE_PREFIX = "standup-progress/v1 ";
/** One strict schema normalizes declarations for both the producer and reader. */
export declare function parseProgressEvidence(value: unknown): ProgressEvidence;
/** Produce a comment for the native SDK comments API; this function itself writes nothing. */
export declare function encodeProgressEvidence(value: ProgressEvidence): string;
/** Per-record inspection preserves foreign annotations and isolates malformed owned declarations. */
export type ProgressCommentInspection = {
    kind: "foreign" | "invalid";
} | {
    kind: "evidence";
    evidence: ProgressEvidence;
};
/** Inspect historical native comment data without tightening the host's persisted-item schema. */
export declare function inspectProgressComment(comment: unknown): ProgressCommentInspection;
/** Validate the entire options boundary before acquiring or reading the SDK. */
export declare function parseProgressOptions(value: unknown): ProgressOptions & {
    events: number;
    outputBytes: number;
};
/** Validate every numeric output field before an ok report can leave the SDK boundary. */
export declare function validateProgressNumbers(report: ProgressReport): void;
/** Read a single item's verified history with a host-injected client or the package's supported SDK adapter. */
export declare function readProgressDeltas(ctx: Pick<CommandHandlerContext, "pm_root" | "sdk">, id: string, rawOptions?: ProgressOptions): Promise<ProgressReport>;
//# sourceMappingURL=progress-deltas.d.ts.map