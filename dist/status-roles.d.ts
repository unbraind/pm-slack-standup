import type { RuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import type { PmItem } from "./index.ts";
/** Standalone presentation compatibility spellings configured as SDK aliases by role. */
export declare const DEFAULT_STATUS_REGISTRY: RuntimeStatusRegistry;
/** Exclusive visible lifecycle buckets plus explicit suppressed terminal classifications. */
export interface StandupItemRoles {
    active: boolean;
    blocked: boolean;
    open: boolean;
    done: boolean;
    canceled: boolean;
    terminal: boolean;
}
/** Whether an item carries a nonempty top-level or typed blocked_by relationship. */
export declare function hasBlockedByDep(item: Pick<PmItem, "blocked_by" | "dependencies">): boolean;
/**
 * Resolve all item-status meanings through SDK roles, never workflow status names.
 * Terminal roles suppress blocker edges; blocked work precedes open/draft, then
 * every remaining active role enters In Progress. Unclassified inputs refuse
 * the report so a configured item cannot silently disappear.
 */
export declare function classifyStandupItem(item: Pick<PmItem, "status" | "blocked_by" | "dependencies">, registry?: RuntimeStatusRegistry): StandupItemRoles;
//# sourceMappingURL=status-roles.d.ts.map