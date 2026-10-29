import {
  getActiveExtensionRegistrations, getHistoryPath, locateItem, normalizeItemId,
  readHistorySnapshot, readLocatedItem, readSettings, resolveItemTypeRegistry, verifyHistoryEntries,
} from "@unbrained/pm-cli/sdk";
import type { HistoryStreamSnapshot } from "@unbrained/pm-cli/sdk";
import { ProgressRefusal } from "./progress-refusals.ts";

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
export async function readVerifiedStandupHistory(pmRoot: string, id: string): Promise<VerifiedStandupHistory> {
  try {
    const settings = await readSettings(pmRoot);
    const registry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
    const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, registry.type_to_folder);
    const canonicalId = located?.id ?? normalizeItemId(id, settings.id_prefix);
    const { entries } = await readHistorySnapshot(getHistoryPath(pmRoot, canonicalId), canonicalId);
    const current = located === null ? undefined : (await readLocatedItem(located, { schema: settings.schema })).document;
    if (entries.length === 0 || !verifyHistoryEntries(entries, current).ok) throw new Error("History integrity unavailable");
    return { id: canonicalId, history: entries, compacted: entries[0].op === "history_compact_baseline" };
  } catch {
    throw new ProgressRefusal("history_unavailable");
  }
}
