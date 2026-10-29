import { PmCliError } from "@unbrained/pm-cli/sdk";

/** Stable remedies remain safe even when a source record contains private or malformed data. */
const remedies = {
  invalid_input: "Use the strict version 1 evidence schema and documented bounded options in docs/progress-deltas.md.",
  checkpoint_mismatch: "Use this item's previous next token with its original append-only history; restart explicitly without after to replay.",
  history_unavailable: "Inspect existing history with read-only SDK snapshot/verification APIs; recover complete history separately before retrying.",
  invalid_output: "Retry the read and inspect the installed package version; emitted counters must be finite bounded integers.",
  output_limit: "Increase outputBytes up to 32768 or reduce events; the checkpoint was not advanced.",
} as const;
/** Machine-readable refusal, shared by SDK consumers and the CLI expected-error renderer. */
export class ProgressRefusal extends PmCliError {
  /** Expected CLI usage failure; no source text is interpolated. */
  readonly exitCode = 2;
  /** Fixed corrective action for an agent to follow. */
  readonly remedy: string;
  /** Stable machine-readable refusal code. */
  readonly code: keyof typeof remedies;
  constructor(code: keyof typeof remedies) {
    super(`Progress refused (${code}). ${remedies[code]}`, 2, { code, required: remedies[code] });
    this.code = code;
    this.remedy = remedies[code];
  }
}
