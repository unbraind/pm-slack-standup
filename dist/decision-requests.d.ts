import type { PmItem } from "./index.ts";
/** Explicit opt-in tag; ordinary Decision items never become requests implicitly. */
export declare const DECISION_REQUEST_TAG = "standup-decision-request";
/** Versioned, author-declared public presentation contract stored in the item body. */
export interface DecisionRequestDeclaration {
    version: 1;
    state: "pending" | "closed" | "superseded";
    disclosure: "public" | "private";
    prompt: string;
    audience: "human" | "agent" | "either";
    responseBy: string;
    evidence: string[];
    acknowledgeAt: string;
    acknowledgment?: string;
    alternatives: Array<{
        label: string;
        disclosure: "public" | "private";
    }>;
}
/** Public-only request projection; item bodies, titles and private labels are never copied. */
export interface StandupDecisionRequest {
    id: string;
    prompt: string;
    audience: DecisionRequestDeclaration["audience"];
    responseBy: string;
    evidence: string[];
    acknowledgeAt: string;
    acknowledgment?: string;
    alternatives: string[];
    withheldAlternatives: number;
}
/** Bounded deterministic report, with explicit omission counts and recovery guidance. */
export interface DecisionRequestReport {
    ok: true;
    requests: StandupDecisionRequest[];
    total: number;
    omitted: number;
    remedy: string;
}
/** Machine-readable refusal codes, independent of CLI wording. */
export type DecisionRequestRefusalCode = "invalid_options" | "invalid_request" | "unsupported_version";
/**
 * Typed CLI/SDK refusal.
 * The message names the canonical item id when one is known, because the CLI
 * prints only `message`, and never interpolates declaration values.
 */
export declare class DecisionRequestRefusal extends Error {
    /** Usage failure understood by the extension command runtime. */
    readonly exitCode = 2;
    /** Stable machine-readable discriminator for consuming agents. */
    readonly code: DecisionRequestRefusalCode;
    /** Safe corrective action without source payload values. */
    readonly remedy: string;
    /** Canonical item to repair, absent for option refusals. */
    readonly itemId?: string;
    constructor(code: DecisionRequestRefusalCode, remedy: string, itemId?: string);
}
/** Optional row cap; the hard maximum keeps periodic Slack messages and agent reports small. */
export interface DecisionRequestOptions {
    limit?: number;
    outputBytes?: number;
}
/** Identify opted-in Decision items without examining or copying their body. */
export declare function isDecisionRequestItem(item: PmItem): boolean;
/**
 * Project only active, explicitly declared requests from a complete canonical tracker read.
 * Public disclosure is mandatory; there is deliberately no CLI override to expose private data.
 * Deadlines order requests (overdue first), then item IDs break ties independent of input order.
 */
export declare function collectDecisionRequests(items: readonly PmItem[], options?: DecisionRequestOptions): DecisionRequestReport;
/** Render public evidence and acknowledgment linkage in the periodic standup section. */
export declare function renderDecisionRequests(report: DecisionRequestReport, format?: "plain" | "slack"): string;
//# sourceMappingURL=decision-requests.d.ts.map