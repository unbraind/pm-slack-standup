import assert from "node:assert/strict";
import test from "node:test";

import extension, {
  fetchAllItems,
  describePmReadFailure,
  pmJsonMaxBuffer,
  pmLaunchPlan,
  pmReadTimeoutMs,
  resolvePmBin,
  CommandError,
  COMPLETE_LIST_COMMAND_ARGUMENTS,
} from "../index.ts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { completeListEnvelope } from "./complete-list-fixture.ts";
import { expectCommandError } from "./test-helpers.ts";

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Default `maxBuffer` the sibling packages settled on, asserted here so a
 * silent change to the constant is caught alongside the message-wording tests.
 */
const EXPECTED_DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Write an executable shell script to `dir` that mimics a `pm` subprocess for
 * one of the failure shapes under test, and return its path. `mode` selects the
 * shape: `"nonzero"` prints `stderrText` to stderr and exits `exitCode`;
 * `"overrun"` prints more than `maxBuffer` bytes to stdout (to trigger ENOBUFS);
 * `"good"` prints a valid canonical complete-list document. Every shape is a real
 * subprocess launched by {@link fetchAllItems}'s `spawnSync`, so the test
 * exercises the actual spawn/error/overrun code paths rather than a synthetic
 * stand-in for `spawnSync`.
 */
/**
 * Skip options for the tests that launch a fake `pm` binary.
 *
 * Every fake here is a `#!/bin/sh` script (one uses `sleep 30`), so on win32 the
 * spawn fails for reasons that have nothing to do with the behaviour under test
 * and the failure names the wrong cause. This repository runs a
 * `windows-acceptance-launcher` job, so those runs must report a skip. The
 * win32 launch path itself is not left uncovered: the shell-free `resolvePmBin`
 * tests below exercise it directly and run on every platform.
 */
const posixOnly = {
  skip: process.platform === "win32" ? "fake pm binaries are POSIX shell scripts" : false,
} as const;

function fakePmBin(dir: string, mode: "nonzero" | "overrun" | "good" | "truncated", opts: { stderrText?: string; exitCode?: number; maxBuffer?: number } = {}): string {
  const bin = join(dir, "fake-pm");
  let script: string;
  if (mode === "nonzero") {
    const code = opts.exitCode ?? 7;
    const stderrText = (opts.stderrText ?? "pm list --all failed").replace(/'/g, "'\\''");
    script = `#!/bin/sh\necho '${stderrText}' >&2\nexit ${code}\n`;
  } else if (mode === "overrun") {
    // Emit more bytes than the maxBuffer the caller will set via PM_JSON_MAX_BUFFER.
    // A 64 KiB run of 'x' overruns any small test cap (e.g. 1024) instantly.
    script = `#!/bin/sh\nhead -c 65536 /dev/zero | tr '\\0' 'x'\n`;
  } else if (mode === "truncated") {
    // Exit 0 with well-formed JSON that reports its own incompleteness — the
    // shape pm-cli emits when a collection read exceeds the default output
    // budget. Nothing about the process outcome distinguishes it from success.
    script = `#!/bin/sh\necho '${JSON.stringify(completeListEnvelope({ items: [{ id: "a", title: "A", status: "in_progress" }], count: 1, total: 676, truncated: true }))}'\nexit 0\n`;
  } else {
    script = `#!/bin/sh\necho '${JSON.stringify(completeListEnvelope({ items: [], count: 0, total: 0 }))}'\nexit 0\n`;
  }
  writeFileSync(bin, script, { encoding: "utf-8", mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}

test("Windows PM entry receives hostile input as one literal argument through a real child", () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-literal-argv-"));
  try {
    const entry = join(directory, "pm entry.cjs");
    const envelope = completeListEnvelope({ items: [], count: 0, total: 0 });
    writeFileSync(entry, `const args = process.argv.slice(2); const envelope = ${JSON.stringify(envelope)}; envelope.items = args.map((title, index) => ({ id: String(index), title, status: "open" })); envelope.count = args.length; envelope.total = args.length; process.stdout.write(JSON.stringify(envelope));`);
    const hostile = "tracker with space & calc | whoami";
    const plan = pmLaunchPlan(entry, "win32");
    assert.deepEqual(fetchAllItems(hostile, plan).map((item) => item.title), ["--path", hostile, ...COMPLETE_LIST_COMMAND_ARGUMENTS]);
    assert.equal(plan.command, process.execPath);
    assert.equal(plan.windowsVerbatimArguments, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// --- describePmReadFailure: message wording for each failure shape -----------
test("describePmReadFailure names the buffer ceiling for an ENOBUFS overrun", () => {
  const limit = 16 * 1024 * 1024;
  const msg = describePmReadFailure(Object.assign(new Error("spawn ENOBUFS"), { code: "ENOBUFS" }), limit);
  assert.match(msg, new RegExp(`${limit} byte read buffer`));
  assert.match(msg, /PM_JSON_MAX_BUFFER/);
});

test("describePmReadFailure surfaces the raw error message for a non-ENOBUFS spawn error", () => {
  const msg = describePmReadFailure(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), 1024);
  assert.match(msg, /pm read failed: spawn ENOENT/);
  assert.ok(!/buffer/.test(msg), "a non-ENOBUFS error must not be worded as a buffer overrun");
});

test("describePmReadFailure handles an error with no errno code", () => {
  const msg = describePmReadFailure(new Error("disk on fire"), 1024);
  assert.match(msg, /pm read failed: disk on fire/);
});

// --- pmJsonMaxBuffer: default + override ------------------------------------
test("pmJsonMaxBuffer defaults to 64 MiB and honors a positive PM_JSON_MAX_BUFFER override", () => {
  const saved = process.env["PM_JSON_MAX_BUFFER"];
  try {
    // Clear it first: the default assertion is only meaningful against an unset
    // variable, and a developer or CI runner that exports one would otherwise
    // turn this into a test of their environment.
    delete process.env["PM_JSON_MAX_BUFFER"];
    assert.equal(pmJsonMaxBuffer(), EXPECTED_DEFAULT_MAX_BUFFER);
    process.env["PM_JSON_MAX_BUFFER"] = "1048576";
    assert.equal(pmJsonMaxBuffer(), 1048576);
  } finally {
    if (saved === undefined) delete process.env["PM_JSON_MAX_BUFFER"];
    else process.env["PM_JSON_MAX_BUFFER"] = saved;
  }
});

test("pmJsonMaxBuffer falls back to the default for invalid or non-positive values", () => {
  const saved = process.env["PM_JSON_MAX_BUFFER"];
  try {
    for (const bad of ["64MiB", "not-a-number", "0", "-1", "1.5", ""]) {
      process.env["PM_JSON_MAX_BUFFER"] = bad;
      assert.equal(pmJsonMaxBuffer(), EXPECTED_DEFAULT_MAX_BUFFER, `value '${bad}' should fall back to the default`);
    }
  } finally {
    if (saved === undefined) delete process.env["PM_JSON_MAX_BUFFER"];
    else process.env["PM_JSON_MAX_BUFFER"] = saved;
  }
});

// --- resolvePmBin: project-local pm vs PATH fallback -------------------------
/**
 * Create a temporary directory with both `pm` (POSIX shebang) and `pm.cmd`
 * (Windows batch) shims in `node_modules/.bin`, and return the module URL the
 * resolver expects plus the paths needed for assertions. Both shims are
 * written as npm installs them, so the resolver's platform-specific choice can
 * be exercised without a real install.
 *
 * @param prefix - Prefix for the temporary directory name.
 * @returns The temp `dir`, the `binDir` containing the shims, and the
 *          `moduleUrl` to pass to `resolvePmBin`, plus the installed JS `entry`.
 */
function setupBothShims(prefix: string): { dir: string; binDir: string; entry: string; moduleUrl: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const binDir = join(dir, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "pm"), "#!/bin/sh\n", { encoding: "utf-8", mode: 0o755 });
  writeFileSync(join(binDir, "pm.cmd"), "@echo off\r\n", { encoding: "utf-8", mode: 0o755 });
  const moduleUrl = pathToFileURL(join(dir, "index.ts")).href;
  const entry = join(dir, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));", "utf8");
  return { dir, binDir, entry, moduleUrl };
}

test("resolvePmBin resolves the project-local node_modules/.bin/pm shim from this module", () => {
  const launch = resolvePmBin(import.meta.url, "linux");
  // Walking up from this test file reaches the package root, whose
  // node_modules/.bin/pm shim exists (this package dev-depends on @unbrained/pm-cli).
  assert.ok(
    launch.command.endsWith(join("node_modules", ".bin", "pm")),
    `expected a node_modules/.bin/pm path, got ${launch.command}`
  );
  // It must NOT be the bare PATH fallback, and on POSIX the shim is launched
  // directly — no command processor, and the pm arguments are the argv itself.
  assert.notEqual(launch.command, "pm");
  assert.deepEqual(launch.args(["--path", "/tracker"]), ["--path", "/tracker"]);
  assert.equal(launch.windowsVerbatimArguments, false);
});

test("resolvePmBin falls back to 'pm' on PATH when its four searched ancestors have no shim", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-pmbin-fallback-"));
  try {
    // Keep all four probed directories inside the owned fixture. A real shim
    // just outside that search window proves the bounded lookup ignores it,
    // independently of any installed shims in the shared temporary ancestors.
    const nested = join(dir, "one", "two", "three", "four");
    mkdirSync(nested, { recursive: true });
    const outsideBin = join(dir, "node_modules", ".bin");
    mkdirSync(outsideBin, { recursive: true });
    writeFileSync(join(outsideBin, "pm"), "#!/bin/sh\n", "utf-8");
    const fakeModuleUrl = pathToFileURL(join(nested, "index.js")).href;
    const launch = resolvePmBin(fakeModuleUrl, "linux");
    assert.equal(launch.command, "pm");
    assert.deepEqual(launch.args(["--path", "/tracker"]), ["--path", "/tracker"]);
    assert.equal(launch.windowsVerbatimArguments, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- fetchAllItems: throws on each failure shape (real subprocesses) ---------

test("fetchAllItems throws a CommandError when the pm subprocess exits non-zero, with the stderr text in the message", posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-nonzero-"));
  try {
    const bin = fakePmBin(dir, "nonzero", { stderrText: "tracker_not_initialized boom", exitCode: 7 });
    assert.throws(
      () => fetchAllItems("/anywhere", bin),
      expectCommandError(1, /tracker_not_initialized boom/)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems names the exit status when the subprocess exits non-zero with EMPTY stderr", posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-nonzero-stderr-"));
  try {
    const bin = join(dir, "empty-stderr-pm");
    // Exits non-zero without writing anything to stderr. With no stderr text to
    // quote, the exit status is the only diagnostic the caller can be given, so
    // it has to be in the message rather than a bare "pm list --all failed".
    writeFileSync(bin, "#!/bin/sh\nexit 9\n", { encoding: "utf-8", mode: 0o755 });
    chmodSync(bin, 0o755);
    assert.throws(
      () => fetchAllItems("/anywhere", bin),
      (e: unknown) => {
        assert.ok(e instanceof CommandError);
        const err = e as CommandError;
        assert.equal(err.exitCode, 1);
        assert.equal(err.message, "pm list --all failed (exit 9)");
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems throws a CommandError when the pm binary cannot be spawned (result.error set)", posixOnly, () => {
  // A non-existent binary path makes spawnSync set result.error (ENOENT).
  const dir = mkdtempSync(join(tmpdir(), "standup-read-error-"));
  try {
    const nope = join(dir, "does-not-exist-pm");
    assert.throws(
      () => fetchAllItems("/anywhere", nope),
      (e: unknown) => {
        assert.ok(e instanceof CommandError, "should throw a CommandError");
        const err = e as CommandError;
        assert.equal(err.exitCode, 1);
        // The ENOENT spawn failure must surface a real reason, not an empty
        // message or a silent empty-result degradation.
        assert.match(err.message, /pm read failed:/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems throws on the ENOBUFS shape (status null, empty stderr) with a message naming the buffer ceiling", posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-enobufs-"));
  const saved = process.env["PM_JSON_MAX_BUFFER"];
  try {
    // Shrink the cap so a 64 KiB stdout overruns it without writing 64 MiB.
    process.env["PM_JSON_MAX_BUFFER"] = "1024";
    const bin = fakePmBin(dir, "overrun", { maxBuffer: 1024 });
    assert.throws(
      () => fetchAllItems("/anywhere", bin),
      expectCommandError(1, /exceeded the 1024 byte read buffer/, /PM_JSON_MAX_BUFFER/)
    );
  } finally {
    if (saved === undefined) delete process.env["PM_JSON_MAX_BUFFER"];
    else process.env["PM_JSON_MAX_BUFFER"] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems throws when the envelope reports a truncated read, naming the item counts and the flag that lifts the cap", posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-truncated-"));
  try {
    const bin = fakePmBin(dir, "truncated");
    assert.throws(
      () => fetchAllItems("/anywhere", bin),
      (e: unknown) => {
        assert.ok(e instanceof CommandError);
        const msg = (e as CommandError).message;
        // The counts must be reported, because "1 of 676" is what makes the
        // shortfall legible; a bare "truncated" reads as a formatting detail.
        assert.match(msg, /count=1 of total=676/);
        // --output-limit and --no-truncate are both accepted by pm and both
        // leave the cap in place, so the message has to name the one that works.
        assert.match(msg, /partial tracker read/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems returns the items when the envelope reports the read was not truncated", posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-complete-"));
  try {
    const bin = join(dir, "complete-pm");
    writeFileSync(
      bin,
      `#!/bin/sh\necho '${JSON.stringify(completeListEnvelope({ items: [{ id: "a", title: "A", status: "open" }, { id: "b", title: "B", status: "open" }], count: 2, total: 2 }))}'\nexit 0\n`,
      { encoding: "utf-8", mode: 0o755 }
    );
    chmodSync(bin, 0o755);
    assert.deepEqual(fetchAllItems("/anywhere", bin).map((i) => i.id), ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `{"items":{}}` is a zero-exit, well-formed-JSON envelope, so nothing about the
 * process outcome distinguishes it from success. Without an explicit shape check
 * it flowed straight through as `PmItem[]` and failed inside `buildStandupData`
 * with a TypeError naming neither the command that produced it nor the payload.
 * Every other malformed shape is refused with a CommandError at the read; this
 * one has to be too.
 */
test("fetchAllItems refuses a non-array items field instead of passing it on as rows", posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-nonarray-"));
  try {
    const bin = join(dir, "nonarray-pm");
    writeFileSync(bin, `#!/bin/sh\necho '{"items":{},"total":0}'\nexit 0\n`, { encoding: "utf-8", mode: 0o755 });
    chmodSync(bin, 0o755);
    assert.throws(
      () => fetchAllItems(dir, bin),
      (err: unknown) => {
        assert.ok(err instanceof CommandError, "must refuse with a CommandError, not a TypeError");
        assert.match(err.message, /invalid_envelope/, "the SDK finding must name the invalid envelope");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems throws on unparseable JSON stdout from a zero-exit pm subprocess", posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-badjson-"));
  try {
    const bin = join(dir, "bad-json-pm");
    writeFileSync(bin, "#!/bin/sh\necho 'not json at all'\nexit 0\n", { encoding: "utf-8", mode: 0o755 });
    chmodSync(bin, 0o755);
    assert.throws(
      () => fetchAllItems("/anywhere", bin),
      (e: unknown) => {
        assert.ok(e instanceof CommandError);
        assert.match((e as CommandError).message, /Could not parse/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pmReadTimeoutMs defaults to 60s, honors a positive override, and rejects an invalid one", () => {
  const saved = process.env["PM_READ_TIMEOUT_MS"];
  try {
    delete process.env["PM_READ_TIMEOUT_MS"];
    assert.equal(pmReadTimeoutMs(), 60_000);
    process.env["PM_READ_TIMEOUT_MS"] = "5000";
    assert.equal(pmReadTimeoutMs(), 5000);
    // "5s" would yield 5 under parseInt — a 5 ms ceiling that kills every read
    // while looking like an honored override. Number() rejects the whole string.
    process.env["PM_READ_TIMEOUT_MS"] = "5s";
    assert.equal(pmReadTimeoutMs(), 60_000);
    process.env["PM_READ_TIMEOUT_MS"] = "0";
    assert.equal(pmReadTimeoutMs(), 60_000);
  } finally {
    if (saved === undefined) delete process.env["PM_READ_TIMEOUT_MS"];
    else process.env["PM_READ_TIMEOUT_MS"] = saved;
  }
});

test("fetchAllItems kills a hung pm read at the timeout rather than waiting forever", posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-hang-"));
  const saved = process.env["PM_READ_TIMEOUT_MS"];
  try {
    process.env["PM_READ_TIMEOUT_MS"] = "300";
    const bin = join(dir, "hanging-pm");
    writeFileSync(bin, "#!/bin/sh\nsleep 30\n", { encoding: "utf-8", mode: 0o755 });
    chmodSync(bin, 0o755);
    const started = Date.now();
    assert.throws(
      () => fetchAllItems("/anywhere", bin),
      (e: unknown) => {
        assert.ok(e instanceof CommandError);
        return true;
      }
    );
    // The point of the ceiling is that the call returns; asserting it came back
    // well inside the child's 30s sleep is what proves the kill happened.
    assert.ok(Date.now() - started < 10_000, "the read must be killed, not awaited");
  } finally {
    if (saved === undefined) delete process.env["PM_READ_TIMEOUT_MS"];
    else process.env["PM_READ_TIMEOUT_MS"] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems names the exit status when pm exits non-zero with empty stderr", posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-status-"));
  try {
    const bin = join(dir, "silent-fail-pm");
    writeFileSync(bin, "#!/bin/sh\nexit 42\n", { encoding: "utf-8", mode: 0o755 });
    chmodSync(bin, 0o755);
    assert.throws(
      () => fetchAllItems("/anywhere", bin),
      (e: unknown) => {
        assert.match((e as CommandError).message, /exit 42/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Windows launch contracts execute Node entries and preserve discrete argv.
test("resolvePmBin bypasses both npm shims on Windows and keeps POSIX shebang launch", () => {
  const { dir, binDir, entry, moduleUrl } = setupBothShims("standup-shim-layout-");
  try {
    const args = ["--path", "tracker with space", "list", "--all", "--json"];
    const windows = resolvePmBin(moduleUrl, "win32");
    assert.equal(windows.command, process.execPath);
    assert.deepEqual(windows.args(args), [entry, ...args]);
    assert.equal(windows.windowsVerbatimArguments, false);
    rmSync(join(binDir, "pm.cmd"));
    assert.deepEqual(resolvePmBin(moduleUrl, "win32").args(args), [entry, ...args]);
    const posix = resolvePmBin(moduleUrl, "linux");
    assert.equal(posix.command, join(binDir, "pm"));
    assert.deepEqual(posix.args(args), args);
    assert.equal(posix.windowsVerbatimArguments, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Windows PATH fallback resolves a global npm entry without consulting ComSpec", () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-path-entry-"));
  const savedPath = process.env.PATH;
  const savedComSpec = process.env.ComSpec;
  try {
    const entry = join(directory, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
    mkdirSync(join(entry, ".."), { recursive: true });
    writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));", "utf8");
    process.env.PATH = `;${join(directory, "absent")};${directory};`;
    process.env.ComSpec = "unlaunchable-command-processor";
    const plan = pmLaunchPlan("pm", "win32");
    assert.equal(plan.command, process.execPath);
    assert.deepEqual(plan.args(["--version"]), [entry, "--version"]);
    delete process.env.PATH;
    assert.throws(() => plan.args([]), /Cannot resolve.*JavaScript entry/);
    assert.throws(() => pmLaunchPlan(join(directory, "absent", "pm.cmd"), "win32").args([]), /JavaScript entry/);
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedComSpec === undefined) delete process.env.ComSpec; else process.env.ComSpec = savedComSpec;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows native executables launch directly and JavaScript entries use Node", () => {
  for (const bin of ["pm.exe", "PM.EXE", "pm.js", "pm.cjs", "pm.mjs"]) {
    const plan = pmLaunchPlan(bin, "win32");
    const native = bin.toLowerCase().endsWith(".exe");
    assert.equal(plan.command, native ? bin : process.execPath);
    assert.deepEqual(plan.args(["--path", "tracker"]), native ? ["--path", "tracker"] : [bin, "--path", "tracker"]);
    assert.equal(plan.windowsVerbatimArguments, false);
  }
});

test("Windows argv preserves empty values, metacharacters and backslashes without composition", () => {
  const plan = pmLaunchPlan("pm.js", "win32");
  const values = ["", "a & calc | whoami", "()<>^!", " spaced\\path\\", "\\".repeat(200_000)];
  assert.deepEqual(plan.args(values), ["pm.js", ...values]);
  // Backslash runs once triggered quadratic quoting (js/polynomial-redos), so
  // assert growth rather than one cold wall-clock reading: after warm-up, the
  // median cost of a 10x longer run must stay far below the 100x a quadratic
  // pass would take.
  const medianMs = (length: number): number => {
    const argv = ["\\".repeat(length)];
    for (let i = 0; i < 5; i++) plan.args(argv);
    const samples = Array.from({ length: 7 }, () => {
      const start = performance.now();
      plan.args(argv);
      return performance.now() - start;
    }).sort((a, b) => a - b);
    return samples[3];
  };
  const small = medianMs(20_000);
  const large = medianMs(200_000);
  assert.ok(large < Math.max(small, 0.05) * 30, `200k run took ${large}ms vs ${small}ms for 20k`);
  assert.ok(large < 5000, `200k run took ${large}ms, above the generous 5,000 ms ceiling`);
});

test("fetchAllItems passes a metacharacter-laden pmRoot as one discrete argv element, never a shell string", posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-metachar-"));
  try {
    // A fake pm that echoes every argv element it received back as item titles.
    // Whatever reaches this child arrives via a real spawnSync launch, so the
    // round trip proves the metacharacter root survived as ONE argv element:
    // any shell concatenation would split or interpret it (`&`, `|`, `"`).
    const bin = join(dir, "argv-echo-pm");
    writeFileSync(
      bin,
      "#!/bin/sh\nexec node -e 'const a=process.argv.slice(1);process.stdout.write(JSON.stringify({items:a.map((title,index)=>({id:`arg-${index}`,title,status:`open`})),count:a.length,total:a.length,has_more:false,truncated:false,next_cursor:null,filters:{status:`all`,include_body:true,no_truncate:true,strict_read:true,runtime_filters:{}},limit:null,requested_limit:null,effective_limit:null,source:null,completeness:{status:`complete`,unreadable_item_count:0,unreadable_directory_count:0},projection:{mode:`full`,fields:null},omission_receipt:{has_omissions:false,omitted_field_group_count:0,omitted_field_groups:[]},read_output:{contract_version:1,command:`list`,requested_dimensions:[`include`,`amount`,`cost`],within_budget:true,strings_compacted:false,rows_compacted:false,result_omitted:false}}))' -- \"$@\"\n",
      { encoding: "utf-8", mode: 0o755 }
    );
    chmodSync(bin, 0o755);
    const evil = 'root with space & "quote" | pipe';
    // Passed as a PmLaunch (the shape resolvePmBin returns), exercising the
    // non-string arm of fetchAllItems' parameter on the same path. On POSIX
    // the launch is the direct spawn, so this is the same metacharacter
    // round trip the real read performs.
    const items = fetchAllItems(evil, pmLaunchPlan(bin, "linux"));
    assert.deepEqual(items.map((i) => i.title), [
      "--path",
      evil,
      ...COMPLETE_LIST_COMMAND_ARGUMENTS,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems returns items from a valid canonical list --all document", posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-ok-"));
  try {
    const bin = join(dir, "good-pm");
    const doc = JSON.stringify(completeListEnvelope({ items: [{ id: "pm-1", title: "T", status: "open" }, { id: "pm-2", title: "U", status: "in_progress" }], count: 2, total: 2 }));
    writeFileSync(bin, `#!/bin/sh\necho '${doc}'\nexit 0\n`, { encoding: "utf-8", mode: 0o755 });
    chmodSync(bin, 0o755);
    const items = fetchAllItems("/anywhere", bin);
    assert.equal(items.length, 2);
    assert.equal(items[0].id, "pm-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems refuses a canonical envelope that omits its items field", posixOnly, () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-no-items-"));
  try {
    const bin = join(dir, "no-items-pm");
    // A zero-exit JSON object without rows is not a verifiable complete corpus.
    writeFileSync(bin, "#!/bin/sh\necho '{}'\nexit 0\n", { encoding: "utf-8", mode: 0o755 });
    chmodSync(bin, 0o755);
    assert.throws(() => fetchAllItems("/anywhere", bin), /invalid_envelope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems with the default pmBin resolves the project-local pm (integration with resolvePmBin)", () => {
  // The default pmBin must be the resolved project-local pm, which (against a
  // non-tracker path) exits non-zero and throws — proving the default does NOT
  // degrade to an empty result. This is the read-failure contract on the real
  // binary, complementing the fake-bin unit cases above.
  assert.throws(
    () => fetchAllItems("/tmp/standup-no-such-tracker-zzz"),
    (e: unknown) => {
      assert.ok(e instanceof CommandError);
      const err = e as CommandError;
      assert.equal(err.exitCode, 1);
      // The real pm emits a structured tracker_not_initialized error on stderr.
      assert.match(err.message, /tracker_not_initialized|Tracker is not initialized/);
      return true;
    }
  );
});

// --- Regression: `pm standup export` exits non-zero when the read fails -------
//
// This is the regression test for the actual user-visible bug: a failed read
// used to degrade to an empty success and exit 0. It exercises the command
// path (the registered exporter handler) through pm's real dispatch engine,
// not just the helper. The exporter handler calls fetchAllItems(ctx.pm_root);
// with the fix it throws a CommandError (numeric exitCode) which pm's runtime
// propagates as a non-zero exit. With the old `return []` it would return a
// 0-item export and exit 0 — so this test fails against the old implementation
// and passes against the new one (see the revert experiment in the PR report).

test("pm standup export exits non-zero when the underlying pm read fails (command path)", async () => {
  const harness = await createExtensionTestHarness(extension, {
    name: "pm-slack-standup",
    capabilities: ["commands", "schema", "importers", "preflight", "services"],
  });
  assert.deepEqual(harness.activation.failed, [], "activation must not fail");

  // A non-existent tracker root makes the real pm list --all read exit non-zero,
  // so fetchAllItems throws a CommandError, which the runtime propagates.
  await assert.rejects(
    harness.runExporter({ exporter: "standup", pmRoot: "/tmp/standup-regression-no-such-tracker", options: { format: "md" } }),
    (e: unknown) => {
      assert.ok(e instanceof CommandError, "the handler must propagate a CommandError, not return an empty export");
      const err = e as CommandError;
      assert.notEqual(err.exitCode, 0, "the propagated exit code must be non-zero");
      assert.match(err.message, /tracker_not_initialized|Tracker is not initialized|pm list --all failed/);
      return true;
    }
  );
});

/**
 * cmd.exe expands `%VAR%` even inside quotes, and there is no escape for it on
 * a `cmd /c` command tail — so the launch must refuse rather than proceed.
 *
 * The consequence of proceeding is the failure mode this whole package guards
 * against elsewhere: `--pm-path C:\work\%BUILD%\pm` becomes whatever `%BUILD%`
 * expands to (or nothing), pm reads a DIFFERENT workspace, and the standup is
 * built from it while reporting success. A refusal naming the argument is
 * strictly better than a quiet wrong answer.
 */
test("the win32 launch refuses an argument cmd.exe would variable-expand", () => {
  const plan = pmLaunchPlan("C:\\proj\\node_modules\\.bin\\pm.cmd", "win32");
  assert.throws(
    () => plan.args(["--pm-path", "C:\\work\\%BUILD%\\.agents\\pm", "list", "--all", "--json"]),
    (err: unknown) => {
      assert.ok(err instanceof CommandError, "must refuse, not silently launch an expanded path");
      assert.match((err as Error).message, /%BUILD%/, "the message must name the offending argument");
      assert.match((err as Error).message, /different workspace/, "and say what proceeding would cost");
      return true;
    },
  );
});

/**
 * cmd.exe parses before CommandLineToArgvW and does not treat backslash as an
 * escape character, so the `\"` generated for a literal quote closes cmd's
 * quote state and exposes following metacharacters as command syntax.
 */
test("the win32 launch refuses an argument whose double quote would break cmd quote state", () => {
  const plan = pmLaunchPlan("C:\\tools\\pm.exe", "win32");
  const injected = 'C:\\work\\a"&calc&"b';
  assert.throws(
    () => plan.args(["--pm-path", injected]),
    (err: unknown) => {
      assert.ok(err instanceof CommandError, "must refuse before constructing an injectable /c tail");
      assert.match((err as Error).message, /double quote/, "the message must name what is refused");
      assert.match((err as Error).message, /cmd\.exe/, "the message must identify the parser that cannot contain it");
      assert.match((err as Error).message, /Remove the double quote/, "the message must tell the caller what to do");
      return true;
    },
  );
});

/**
 * A line break is a command boundary on a `cmd /c` tail, not a metacharacter, so
 * quoting cannot contain it — cmd ends the command at the break and reads the
 * remainder as a fresh command.
 *
 * It also slips past the quoting entirely: `quoteWindowsArg` only quotes an
 * argument containing one of `[\t "&|<>()^]`, and `\r`/`\n` are in neither that
 * set nor the `%NAME%` refusal, so before this guard such an argument reached the
 * tail unquoted. Both characters are covered, since a lone `\r` still ends the
 * line for cmd.
 */
test("the win32 launch refuses an argument carrying a line break cmd.exe would split on", () => {
  const plan = pmLaunchPlan("C:\\proj\\node_modules\\.bin\\pm.cmd", "win32");
  for (const [name, injected] of [["line feed", "\n"], ["carriage return", "\r"]] as const) {
    assert.throws(
      () => plan.args(["--pm-path", `C:\\work${injected}whoami`, "list", "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CommandError, `${name} must refuse, not launch a split command line`);
        assert.match((err as Error).message, /line break/, "the message must say what was refused");
        return true;
      },
      `an argument containing a ${name} must not reach the cmd tail`,
    );
  }
});

/**
 * Only a `%...%` PAIR can name a variable, so an ordinary literal percent in a
 * path must still launch — refusing it would break valid workspaces to guard
 * against a case cmd.exe does not actually expand.
 */
test("the win32 launch still accepts a literal percent that names no variable", () => {
  const plan = pmLaunchPlan("pm.js", "win32");
  const argv = plan.args(["--pm-path", "C:\\reports\\100% done\\.agents\\pm"]);
  assert.strictEqual(argv[0], "pm.js");
  assert.ok(argv[2]?.includes("100% done"), "the literal percent must survive into the tail");
});

/**
 * `%%` is a literal doubled percent, not a variable reference: the doubling rule
 * is a batch-file convention, and cmd passes `%%` through unchanged on a `/c`
 * command line. Refusing it would abort a valid workspace path for a case
 * cmd.exe does not expand, so the guard has to be narrower than "contains two
 * percent signs".
 */
test("the win32 launch accepts a literal doubled percent, which names no variable", () => {
  const plan = pmLaunchPlan("pm.js", "win32");
  const argv = plan.args(["--pm-path", "C:\\reports\\100%% done\\.agents\\pm"]);
  assert.ok(argv[2]?.includes("100%% done"), "the doubled percent must survive into the tail");
});

/** Delayed-expansion names remain literal because the launch uses no command processor. */
test("the win32 launch accepts an argument containing !NAME! because no command processor runs", () => {
  const plan = pmLaunchPlan("pm.js", "win32");
  const argv = plan.args(["--pm-path", "C:\\work\\!BUILD!\\.agents\\pm"]);
  assert.ok(argv[2]?.includes("!BUILD!"), "the !NAME! pair must survive as a literal argument");
});
