import { PmCliError } from "@unbrained/pm-cli/sdk";
/** Stable remedies remain safe even when a source record contains private or malformed data. */
declare const remedies: {
    readonly invalid_input: "Use the strict version 1 evidence schema and documented bounded options in docs/progress-deltas.md.";
    readonly checkpoint_mismatch: "Use this item's previous next token with its original append-only history; restart explicitly without after to replay.";
    readonly history_unavailable: "Inspect existing history with read-only SDK snapshot/verification APIs; recover complete history separately before retrying.";
    readonly invalid_output: "Retry the read and inspect the installed package version; emitted counters must be finite bounded integers.";
    readonly output_limit: "Increase outputBytes up to 32768 or reduce events; the checkpoint was not advanced.";
};
/** Machine-readable refusal, shared by SDK consumers and the CLI expected-error renderer. */
export declare class ProgressRefusal extends PmCliError {
    /** Expected CLI usage failure; no source text is interpolated. */
    readonly exitCode = 2;
    /** Fixed corrective action for an agent to follow. */
    readonly remedy: string;
    /** Stable machine-readable refusal code. */
    readonly code: keyof typeof remedies;
    constructor(code: keyof typeof remedies);
}
export {};
//# sourceMappingURL=progress-refusals.d.ts.map