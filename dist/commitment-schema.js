import { PmCliError } from "@unbrained/pm-cli/sdk";
const remedies = {
    invalid_input: "Use the version 1 commitment schema, a positive source revision, and at most twenty distinct keys; see docs/commitment-variance.md.",
    history_unavailable: "Inspect current source storage and retained history using read-only SDK verification; recover missing data separately before retrying; no failure is inferred.",
    revision_unavailable: "Select an existing, uncompacted source revision; obtain its number through the native history API.",
    selection_limit: "Select at most twenty keys explicitly, or select a smaller source capture.",
    source_changed: "Retry the complete read against the same explicit source revision; a source, target or status registry changed during inspection.",
    output_limit: "Increase outputBytes up to 32768 or select fewer keys; no partial report was returned.",
    invalid_output: "Retry with the current package; report counts and revisions must be finite bounded integers.",
};
/** Stable SDK/CLI refusal with a corrective action and no interpolated source data. */
export class CommitmentRefusal extends PmCliError {
    /** Stable machine-readable category shared by SDK callers and CLI renderers. */
    code;
    /** Safe corrective action, independent of malformed or private source content. */
    remedy;
    constructor(code) {
        super(`Commitment variance refused (${code}). ${remedies[code]}`, 2, { code, required: remedies[code] });
        this.code = code;
        this.remedy = remedies[code];
    }
}
/** Only this versioned annotation is owned by the commitment reader. */
export const COMMITMENT_PREFIX = "standup-commitment/v1 ";
/** Require precisely the documented fields, without accepting prototype properties. */
function objectFields(value, required, optional = []) {
    if (typeof value !== "object" || value === null || Array.isArray(value)
        || required.some((key) => !Object.hasOwn(value, key))
        || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)))
        throw new CommitmentRefusal("invalid_input");
    return value;
}
/** Bounded single-line labels preserve Unicode and normalize both readers and producers. */
function label(value, maximum) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\p{Cc}\u2028\u2029]/u.test(value)) {
        throw new CommitmentRefusal("invalid_input");
    }
    return value.trim();
}
/** Bound all numeric inputs before the SDK is acquired or any tracker is inspected. */
function integer(value, minimum, maximum) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new CommitmentRefusal("invalid_input");
    return value;
}
/** Shared revision schema for source selections and producers' target references. */
function target(value) {
    const entry = objectFields(value, ["id", "revision"]);
    return { id: label(entry.id, 128), revision: integer(entry.revision, 1, 1000000) };
}
/** The single strict declaration schema used by every producer and validator. */
export function parseStandupCommitment(value) {
    const entry = objectFields(value, ["version", "key", "target"]);
    if (entry.version !== 1)
        throw new CommitmentRefusal("invalid_input");
    return { version: 1, key: label(entry.key, 64), target: target(entry.target) };
}
/** Produce one native comment; callers persist it through the host's comments API. */
export function encodeStandupCommitment(value) {
    return COMMITMENT_PREFIX + JSON.stringify(parseStandupCommitment(value));
}
/** Validate dense, bounded selections and normalize their keys through the declaration schema. */
export function parseCommitmentVarianceInput(value) {
    const entry = objectFields(value, ["source"], ["keys", "outputBytes"]);
    let keys;
    if (entry.keys !== undefined) {
        if (!Array.isArray(entry.keys) || entry.keys.length < 1 || entry.keys.length > 20
            || Object.keys(entry.keys).length !== entry.keys.length)
            throw new CommitmentRefusal("invalid_input");
        keys = Array.from(entry.keys, (key) => label(key, 64));
        if (new Set(keys).size !== keys.length)
            throw new CommitmentRefusal("invalid_input");
    }
    return { source: target(entry.source), keys, outputBytes: entry.outputBytes === undefined ? 16384 : integer(entry.outputBytes, 1024, 32768) };
}
/** Adapt only CLI numeric spellings, leaving all semantic validation to the shared schema. */
export function commitmentCliNumber(value) {
    return typeof value === "string" && value.trim() !== "" ? Number(value) : value;
}
//# sourceMappingURL=commitment-schema.js.map