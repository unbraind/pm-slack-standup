import { mutateItemWithHistoryContext, readSettings } from "@unbrained/pm-cli/sdk";
import { passingRun } from "./progress-fixture.ts";

// Internal packed-acceptance fixture; SDK acquisition uses the public package import.
const [pmRoot, id, mode, subject] = process.argv.slice(2);
if (!pmRoot || !id || !["failed", "malformed"].includes(subject) || !["failed", "malformed", "passed", "empty"].includes(mode)) throw new Error("Invalid native fixture operation");
const run = passingRun(`packed-corrected-${subject}`);
await mutateItemWithHistoryContext({ pmRoot, settings: await readSettings(pmRoot), id, author: "packed-fixture", op: "update",
  mutate(document) {
    document.metadata.test_runs = mode === "empty" ? [] : [{ ...run,
      ...(mode === "failed" ? { status: "failed" as const } : mode === "malformed" ? { passed: 0 } : {}) }];
    return { changedFields: ["test_runs"] };
  } });
