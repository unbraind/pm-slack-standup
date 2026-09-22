import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { COMPLETE_LIST_COMMAND_ARGUMENTS, fetchAllItems, type PmLaunch } from "../index.ts";
import { completeListEnvelope } from "../test/complete-list-fixture.ts";

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
  process.env.PM_STANDUP_FAKE_RESPONSE = JSON.stringify(
    completeListEnvelope({
      items: [{ id: "fixture-1", title: "Tracked standup work", status: "in_progress" }],
    }),
  );
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
