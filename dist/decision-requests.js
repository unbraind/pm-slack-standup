/** Explicit opt-in tag; ordinary Decision items never become requests implicitly. */
export const DECISION_REQUEST_TAG = "standup-decision-request";
/**
 * Typed CLI/SDK refusal.
 * The message names the canonical item id when one is known, because the CLI
 * prints only `message`, and never interpolates declaration values.
 */
export class DecisionRequestRefusal extends Error {
    /** Usage failure understood by the extension command runtime. */
    exitCode = 2;
    /** Stable machine-readable discriminator for consuming agents. */
    code;
    /** Safe corrective action without source payload values. */
    remedy;
    /** Canonical item to repair, absent for option refusals. */
    itemId;
    constructor(code, remedy, itemId) {
        const subject = itemId === undefined
            ? `Decision requests refused (${code})`
            : `Decision requests refused (${code}) for item ${itemId}`;
        super(`${subject}. ${remedy}`);
        this.name = "DecisionRequestRefusal";
        this.code = code;
        this.remedy = remedy;
        this.itemId = itemId;
    }
}
/**
 * Item states that suppress a request before payload validation.
 * Includes the standup done alias `complete` so a finished Decision cannot
 * abort the report when its old declaration is incomplete.
 */
const terminal = new Set(["closed", "done", "complete", "completed", "canceled", "cancelled", "superseded", "archived", "resolved", "rejected"]);
/** Narrow untrusted JSON without asserting a declaration shape. */
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Bound public display strings and disallow multiline/control-character injection. */
function label(value) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
}
/** Require credential-free canonical HTTPS links, including optional evidence anchors. */
function link(value) {
    if (typeof value !== "string" || value.length > 512)
        return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !/[\s<>|]/u.test(value);
    }
    catch {
        return false;
    }
}
/** Identify opted-in Decision items without examining or copying their body. */
export function isDecisionRequestItem(item) {
    return item.type?.toLowerCase() === "decision" && item.tags?.includes(DECISION_REQUEST_TAG) === true;
}
/** Read one explicit declaration; fail closed rather than emitting an incomplete request. */
function declaration(item) {
    const blocks = [...(item.body ?? "").matchAll(/^```standup-decision-request\r?\n([\s\S]*?)\r?\n```\s*$/gmu)];
    const remedy = "Use one standup-decision-request JSON fence matching the README schema; explicitly classify every alternative and link only approved public evidence.";
    let parsed;
    try {
        if (blocks.length !== 1)
            throw new Error();
        parsed = JSON.parse(blocks[0][1]);
    }
    catch {
        throw new DecisionRequestRefusal("invalid_request", remedy, item.id);
    }
    if (!record(parsed))
        throw new DecisionRequestRefusal("invalid_request", remedy, item.id);
    if (parsed.version !== 1)
        throw new DecisionRequestRefusal("unsupported_version", "Use declaration version 1 or upgrade the standup package to a compatible version.", item.id);
    // A terminal declaration is enough to suppress old requests, even if their old payload is incomplete.
    if (parsed.state === "closed" || parsed.state === "superseded" || parsed.disclosure === "private")
        return parsed;
    const alternatives = parsed.alternatives;
    const deadline = parsed.responseBy;
    if (parsed.state !== "pending" || parsed.disclosure !== "public" || !label(parsed.prompt)
        || !["human", "agent", "either"].includes(String(parsed.audience))
        || typeof deadline !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(deadline)
        || !Number.isFinite(Date.parse(deadline)) || new Date(deadline).toISOString() !== deadline
        || !Array.isArray(parsed.evidence) || parsed.evidence.length < 1 || parsed.evidence.length > 3 || !parsed.evidence.every(link)
        || !link(parsed.acknowledgeAt) || (parsed.acknowledgment !== undefined && !link(parsed.acknowledgment))
        || !Array.isArray(alternatives) || alternatives.length < 2 || alternatives.length > 6
        || !alternatives.every((entry) => record(entry) && label(entry.label) && ["public", "private"].includes(String(entry.disclosure)))) {
        throw new DecisionRequestRefusal("invalid_request", remedy, item.id);
    }
    return parsed;
}
/**
 * Project only active, explicitly declared requests from a complete canonical tracker read.
 * Public disclosure is mandatory; there is deliberately no CLI override to expose private data.
 * Deadlines order requests (overdue first), then item IDs break ties independent of input order.
 */
export function collectDecisionRequests(items, options = {}) {
    const limit = options.limit ?? 10;
    const outputBytes = options.outputBytes ?? 8192;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
        throw new DecisionRequestRefusal("invalid_options", "Use --limit with an integer from 1 to 10.");
    }
    if (!Number.isInteger(outputBytes) || outputBytes < 512 || outputBytes > 32768) {
        throw new DecisionRequestRefusal("invalid_options", "Use --output-bytes with an integer from 512 to 32768.");
    }
    const requests = [];
    for (const item of items) {
        if (!isDecisionRequestItem(item) || terminal.has(item.status.trim().toLowerCase()))
            continue;
        const value = declaration(item);
        if (value.state !== "pending" || value.disclosure !== "public")
            continue;
        const alternatives = value.alternatives.filter((entry) => entry.disclosure === "public").map((entry) => entry.label);
        const request = {
            id: item.id, prompt: value.prompt, audience: value.audience, responseBy: value.responseBy,
            alternatives, withheldAlternatives: value.alternatives.length - alternatives.length,
            evidence: value.evidence, acknowledgeAt: value.acknowledgeAt,
        };
        if (value.acknowledgment !== undefined)
            request.acknowledgment = value.acknowledgment;
        requests.push(request);
    }
    requests.sort((a, b) => a.responseBy < b.responseBy ? -1 : a.responseBy > b.responseBy ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const report = { ok: true, requests: requests.slice(0, limit), total: requests.length, omitted: Math.max(0, requests.length - limit),
        remedy: "Read evidence and acknowledge at acknowledgeAt; increase --limit (max 10) or --output-bytes (max 32768) for omissions, or inspect the tracker." };
    // Bound the compact JSON projection including the omission receipt; never cut an evidence URL or alternative.
    while (Buffer.byteLength(JSON.stringify(report)) > outputBytes) {
        report.requests.pop();
        report.omitted += 1;
    }
    return report;
}
/** Escape Slack control syntax and mentions in author-approved display text. */
function display(value, format) {
    if (format === "plain")
        return value;
    return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/@/gu, "＠");
}
/** Render public evidence and acknowledgment linkage in the periodic standup section. */
export function renderDecisionRequests(report, format = "slack") {
    const lines = ["Decision requests"];
    for (const request of report.requests) {
        lines.push(`${display(request.id, format)}: ${display(request.prompt, format)} [${request.audience}] — respond by ${request.responseBy}`, `Alternatives: ${request.alternatives.map((alternative) => display(alternative, format)).join(" / ")} (${request.withheldAlternatives} withheld)`, `Evidence: ${request.evidence.join(" ")}`, `Acknowledge: ${request.acknowledgeAt}`);
        if (request.acknowledgment !== undefined)
            lines.push(`Acknowledgment: ${request.acknowledgment}`);
    }
    lines.push(`${report.total} request(s); ${report.omitted} omitted. ${report.remedy}`);
    return lines.join("\n");
}
//# sourceMappingURL=decision-requests.js.map