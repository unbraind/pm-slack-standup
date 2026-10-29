import { createHash } from "node:crypto";
import { readdirSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** Include names, bytes, modes and mtimes so even a same-content write or new cache is visible. */
export function treeState(root: string, includeDerived = false): string {
  const entries: unknown[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!includeDerived && directory === root && ["runtime", "locks", "search"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      entries.push([path.slice(root.length), stat.mode, stat.mtimeMs,
        entry.isSymbolicLink() ? createHash("sha256").update(readlinkSync(path)).digest("hex") : entry.isDirectory() ? "directory" : createHash("sha256").update(readFileSync(path)).digest("hex")]);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return JSON.stringify(entries);
}
