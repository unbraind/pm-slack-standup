import { createPmCliExpectedError, EXIT_CODE, normalizeStatusInputWithRegistry, resolveRuntimeStatusRegistry, statusIsTerminal, } from "@unbrained/pm-cli/sdk";
/** Empty schema lets the SDK supply its canonical default lifecycle definitions. */
const defaultSchema = {
    version: 1, files: {}, statuses: [], fields: [], workflow: {}, unknown_field_policy: "allow",
};
/** Standalone presentation compatibility spellings configured as SDK aliases by role. */
export const DEFAULT_STATUS_REGISTRY = resolveRuntimeStatusRegistry({
    ...defaultSchema,
    statuses: resolveRuntimeStatusRegistry(defaultSchema).definitions.map((definition) => ({
        ...definition,
        aliases: [...definition.aliases, ...(definition.roles.includes("default_open") ? ["todo", "new"]
                : definition.roles.includes("active") ? ["wip", "doing"]
                    : definition.roles.includes("blocked") ? ["on_hold"]
                        : definition.roles.includes("terminal_done") ? ["done", "complete", "completed", "resolved"]
                            : definition.roles.includes("terminal_canceled") ? ["superseded", "archived", "rejected"] : [])],
    })),
});
/** Whether an item carries a nonempty top-level or typed blocked_by relationship. */
export function hasBlockedByDep(item) {
    const top = item.blocked_by;
    if (typeof top === "string" && top.trim().length > 0)
        return true;
    const deps = item.dependencies;
    if (Array.isArray(deps)) {
        for (const dependency of deps) {
            if (dependency && typeof dependency.kind === "string" && dependency.kind.trim().toLowerCase() === "blocked_by")
                return true;
        }
    }
    return false;
}
/**
 * Resolve all item-status meanings through SDK roles, never workflow status names.
 * Terminal roles suppress blocker edges; blocked work precedes open/draft, then
 * every remaining active role enters In Progress. Unclassified inputs refuse
 * the report so a configured item cannot silently disappear.
 */
export function classifyStandupItem(item, registry = DEFAULT_STATUS_REGISTRY) {
    const id = normalizeStatusInputWithRegistry(item.status, registry);
    const definition = id === undefined ? undefined : registry.by_id.get(id);
    if (definition === undefined) {
        throw createPmCliExpectedError("Standup status is not registered; configure its lifecycle roles and aliases.", { exitCode: EXIT_CODE.USAGE });
    }
    const terminal = statusIsTerminal(definition.id, registry);
    const canceled = registry.terminal_canceled_statuses.has(definition.id);
    const done = terminal && !canceled && registry.terminal_done_statuses.has(definition.id);
    const blocked = !terminal && (registry.blocked_statuses.has(definition.id) || hasBlockedByDep(item));
    const open = !terminal && !blocked && (registry.draft_statuses.has(definition.id) || definition.roles.includes("default_open"));
    const active = !terminal && !blocked && !open && registry.active_statuses.has(definition.id);
    if (!terminal && !blocked && !open && !active) {
        throw createPmCliExpectedError("Standup status has no reportable lifecycle role; configure active, draft, blocked or terminal roles.", { exitCode: EXIT_CODE.USAGE });
    }
    return { active, blocked, open, done, canceled, terminal };
}
//# sourceMappingURL=status-roles.js.map