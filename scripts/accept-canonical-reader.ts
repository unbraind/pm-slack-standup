import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { COMPLETE_LIST_COMMAND_ARGUMENTS, fetchAllItems, type PmLaunch } from "../index.ts";

/** Complete response emitted by the fake host for the whole-tracker read. */
function completeEnvelope(): Record<string, unknown> {
  return {
    items: [{ id: "fixture-1", title: "Tracked standup work", status: "in_progress" }],
    count: 1,
    total: 1,
    has_more: false,
    truncated: false,
    next_cursor: null,
    filters: { status: "all", include_body: true, no_truncate: true, strict_read: true, runtime_filters: {} },
    limit: null,
    requested_limit: null,
    effective_limit: null,
    source: null,
    completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 },
    projection: { mode: "full", fields: null },
    omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] },
    read_output: {
      contract_version: 1,
      command: "list",
      requested_dimensions: ["include", "amount", "cost"],
      within_budget: true,
      strings_compacted: false,
      rows_compacted: false,
      result_omitted: false,
    },
  };
}

test("canonical reader acceptance issues exactly one complete-list read", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-slack-standup-canonical-reader-"));
  const fakePm = join(root, "fake-pm.mjs");
  const argsFile = join(root, "args.json");
  const previousResponse = process.env.PM_STANDUP_FAKE_RESPONSE;
  const previousArgsFile = process.env.PM_STANDUP_ARGS_FILE;
  writeFileSync(fakePm, `import { appendFileSync } from "node:fs";
appendFileSync(process.env.PM_STANDUP_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(process.env.PM_STANDUP_FAKE_RESPONSE);
`, "utf8");
  process.env.PM_STANDUP_FAKE_RESPONSE = JSON.stringify(completeEnvelope());
  process.env.PM_STANDUP_ARGS_FILE = argsFile;
  const launch: PmLaunch = {
    command: process.execPath,
    args: (pmArgs) => [fakePm, ...pmArgs],
    windowsVerbatimArguments: false,
  };
  try {
    assert.deepEqual(fetchAllItems("/tracker", launch), [
      { id: "fixture-1", title: "Tracked standup work", status: "in_progress" },
    ]);
    const invocations = readFileSync(argsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(invocations, [[
      "--path", "/tracker", ...COMPLETE_LIST_COMMAND_ARGUMENTS,
    ]], "the acceptance must observe exactly one canonical host invocation");
  } finally {
    if (previousResponse === undefined) delete process.env.PM_STANDUP_FAKE_RESPONSE;
    else process.env.PM_STANDUP_FAKE_RESPONSE = previousResponse;
    if (previousArgsFile === undefined) delete process.env.PM_STANDUP_ARGS_FILE;
    else process.env.PM_STANDUP_ARGS_FILE = previousArgsFile;
    rmSync(root, { recursive: true, force: true });
  }
});
