import { PmCliError } from "@unbrained/pm-cli/sdk";
declare const remedies: {
    readonly invalid_input: "Use the version 1 commitment schema, a positive source revision, and at most twenty distinct keys; see docs/commitment-variance.md.";
    readonly history_unavailable: "Inspect current source storage and retained history using read-only SDK verification; recover missing data separately before retrying; no failure is inferred.";
    readonly revision_unavailable: "Select an existing, uncompacted source revision; obtain its number through the native history API.";
    readonly selection_limit: "Select at most twenty keys explicitly, or select a smaller source capture.";
    readonly source_changed: "Retry the complete read against the same explicit source revision; a source, target or status registry changed during inspection.";
    readonly output_limit: "Increase outputBytes up to 32768 or select fewer keys; no partial report was returned.";
    readonly invalid_output: "Retry with the current package; report counts and revisions must be finite bounded integers.";
};
/** Stable SDK/CLI refusal with a corrective action and no interpolated source data. */
export declare class CommitmentRefusal extends PmCliError {
    /** Stable machine-readable category shared by SDK callers and CLI renderers. */
    readonly code: keyof typeof remedies;
    /** Safe corrective action, independent of malformed or private source content. */
    readonly remedy: string;
    constructor(code: keyof typeof remedies);
}
/** One native target revision, selected explicitly rather than from session focus. */
export interface CommitmentTarget {
    id: string;
    revision: number;
}
/** A single declared intention; the native comment is its link to the observed target. */
export interface StandupCommitment {
    version: 1;
    key: string;
    target: CommitmentTarget;
}
/** Read controls; keys also let callers request an explicit missing-capture receipt. */
export interface CommitmentVarianceInput {
    source: CommitmentTarget;
    keys?: string[];
    outputBytes?: number;
}
/** Only this versioned annotation is owned by the commitment reader. */
export declare const COMMITMENT_PREFIX = "standup-commitment/v1 ";
/** The single strict declaration schema used by every producer and validator. */
export declare function parseStandupCommitment(value: unknown): StandupCommitment;
/** Produce one native comment; callers persist it through the host's comments API. */
export declare function encodeStandupCommitment(value: StandupCommitment): string;
/** Validate dense, bounded selections and normalize their keys through the declaration schema. */
export declare function parseCommitmentVarianceInput(value: unknown): CommitmentVarianceInput & {
    outputBytes: number;
};
/** Adapt only CLI numeric spellings, leaving all semantic validation to the shared schema. */
export declare function commitmentCliNumber(value: unknown): unknown;
export {};
//# sourceMappingURL=commitment-schema.d.ts.map