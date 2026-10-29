import type { HistoryStreamSnapshot } from "@unbrained/pm-cli/sdk";
/** Verified immutable source shared by progress, standup presentation and exports. */
export interface VerifiedStandupHistory {
    id: string;
    history: HistoryStreamSnapshot["entries"];
    compacted: boolean;
}
/**
 * Read existing native bytes through SDK primitives without invoking the history
 * command's missing-stream maintenance policy. Parsing, I/O, replay and current
 * document failures share one safe refusal; no source exception text escapes.
 */
export declare function readVerifiedStandupHistory(pmRoot: string, id: string): Promise<VerifiedStandupHistory>;
//# sourceMappingURL=verified-history.d.ts.map