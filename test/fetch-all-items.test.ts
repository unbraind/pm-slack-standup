import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchAllItems,
  describePmReadFailure,
  pmJsonMaxBuffer,
  pmLaunchPlan,
  pmReadTimeoutMs,
  resolvePmBin,
  CommandError,
} from "../index.ts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";

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
 * `"good"` prints a valid `list-all --json` document. Every shape is a real
 * subprocess launched by {@link fetchAllItems}'s `spawnSync`, so the test
 * exercises the actual spawn/error/overrun code paths rather than a synthetic
 * stand-in for `spawnSync`.
 */
function fakePmBin(dir: string, mode: "nonzero" | "overrun" | "good" | "truncated", opts: { stderrText?: string; exitCode?: number; maxBuffer?: number } = {}): string {
  const bin = join(dir, "fake-pm");
  let script: string;
  if (mode === "nonzero") {
    const code = opts.exitCode ?? 7;
    const stderrText = (opts.stderrText ?? "pm list-all failed").replace(/'/g, "'\\''");
    script = `#!/bin/sh\necho '${stderrText}' >&2\nexit ${code}\n`;
  } else if (mode === "overrun") {
    // Emit more bytes than the maxBuffer the caller will set via PM_JSON_MAX_BUFFER.
    // A 64 KiB run of 'x' overruns any small test cap (e.g. 1024) instantly.
    script = `#!/bin/sh\nhead -c 65536 /dev/zero | tr '\\0' 'x'\n`;
  } else if (mode === "truncated") {
    // Exit 0 with well-formed JSON that reports its own incompleteness — the
    // shape pm-cli emits when a collection read exceeds the default output
    // budget. Nothing about the process outcome distinguishes it from success.
    script = `#!/bin/sh\necho '{"items":[{"id":"a","status":"in_progress"}],"total":676,"truncated":true}'\nexit 0\n`;
  } else {
    script = `#!/bin/sh\necho '{"items":[]}'\nexit 0\n`;
  }
  writeFileSync(bin, script, { encoding: "utf-8", mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}

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
// The command the resolver hands back depends on ComSpec only on win32, and the
// assertion has to hold on any machine running the suite, so the expected
// processor is computed the same way the implementation computes it.
function expectedComSpec(): string {
  return process.env["ComSpec"] || "cmd.exe";
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

test("resolvePmBin falls back to 'pm' on PATH when no local node_modules/.bin/pm exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-pmbin-fallback-"));
  try {
    // A module URL inside a temp tree with no node_modules must fall back.
    const fakeModuleUrl = pathToFileURL(join(dir, "index.js")).href;
    const launch = resolvePmBin(fakeModuleUrl, "linux");
    assert.equal(launch.command, "pm");
    assert.deepEqual(launch.args(["--path", "/tracker"]), ["--path", "/tracker"]);
    assert.equal(launch.windowsVerbatimArguments, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- fetchAllItems: throws on each failure shape (real subprocesses) ---------

test("fetchAllItems throws a CommandError when the pm subprocess exits non-zero, with the stderr text in the message", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-nonzero-"));
  try {
    const bin = fakePmBin(dir, "nonzero", { stderrText: "tracker_not_initialized boom", exitCode: 7 });
    assert.throws(
      () => fetchAllItems("/anywhere", bin),
      (e: unknown) => {
        assert.ok(e instanceof CommandError, "should throw a CommandError");
        const err = e as CommandError;
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /tracker_not_initialized boom/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems names the exit status when the subprocess exits non-zero with EMPTY stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-nonzero-stderr-"));
  try {
    const bin = join(dir, "empty-stderr-pm");
    // Exits non-zero without writing anything to stderr. With no stderr text to
    // quote, the exit status is the only diagnostic the caller can be given, so
    // it has to be in the message rather than a bare "pm list-all failed".
    writeFileSync(bin, "#!/bin/sh\nexit 9\n", { encoding: "utf-8", mode: 0o755 });
    chmodSync(bin, 0o755);
    assert.throws(
      () => fetchAllItems("/anywhere", bin),
      (e: unknown) => {
        assert.ok(e instanceof CommandError);
        const err = e as CommandError;
        assert.equal(err.exitCode, 1);
        assert.equal(err.message, "pm list-all failed (exit 9)");
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems throws a CommandError when the pm binary cannot be spawned (result.error set)", () => {
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

test("fetchAllItems throws on the ENOBUFS shape (status null, empty stderr) with a message naming the buffer ceiling", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-enobufs-"));
  const saved = process.env["PM_JSON_MAX_BUFFER"];
  try {
    // Shrink the cap so a 64 KiB stdout overruns it without writing 64 MiB.
    process.env["PM_JSON_MAX_BUFFER"] = "1024";
    const bin = fakePmBin(dir, "overrun", { maxBuffer: 1024 });
    assert.throws(
      () => fetchAllItems("/anywhere", bin),
      (e: unknown) => {
        assert.ok(e instanceof CommandError, "should throw a CommandError");
        const err = e as CommandError;
        assert.equal(err.exitCode, 1);
        // The overrun message must name the ceiling, not surface an empty reason.
        assert.match(err.message, /exceeded the 1024 byte read buffer/);
        assert.match(err.message, /PM_JSON_MAX_BUFFER/);
        return true;
      }
    );
  } finally {
    if (saved === undefined) delete process.env["PM_JSON_MAX_BUFFER"];
    else process.env["PM_JSON_MAX_BUFFER"] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems throws when the envelope reports a truncated read, naming the item counts and the flag that lifts the cap", () => {
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
        assert.match(msg, /1 of 676 items/);
        // --output-limit and --no-truncate are both accepted by pm and both
        // leave the cap in place, so the message has to name the one that works.
        assert.match(msg, /--output-budget unbounded/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems returns the items when the envelope reports the read was not truncated", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-complete-"));
  try {
    const bin = join(dir, "complete-pm");
    writeFileSync(
      bin,
      "#!/bin/sh\necho '{\"items\":[{\"id\":\"a\"},{\"id\":\"b\"}],\"total\":2,\"truncated\":false}'\nexit 0\n",
      { encoding: "utf-8", mode: 0o755 }
    );
    chmodSync(bin, 0o755);
    assert.deepEqual(fetchAllItems("/anywhere", bin).map((i) => i.id), ["a", "b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems throws on unparseable JSON stdout from a zero-exit pm subprocess", () => {
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

test("fetchAllItems kills a hung pm read at the timeout rather than waiting forever", () => {
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

test("fetchAllItems names the exit status when pm exits non-zero with empty stderr", () => {
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

// --- resolvePmBin / pmLaunchPlan: the exact launch shape per platform ----------
//
// These are the regression tests for the unlaunchable-.cmd defect: the resolver
// used to hand back the bare `pm.cmd` path, and the caller spawned it directly,
// which Node (18.20+/20.12+, the CVE-2024-27980 mitigation) refuses with EINVAL.
// Now the resolver returns the launch — command processor plus the `/d /s /c`
// prefix on win32, the bare shim with no prefix on POSIX — and these assertions
// pin the exact argv for each platform without needing a Windows box. Revert the
// launch wrapping and the win32 assertions fail: the expected `cmd.exe /d /s /c`
// shape collapses back to the bare (unlaunchable) shim path.

test("resolvePmBin produces the cmd.exe launch for the .cmd shim on win32 (npm's both-shims layout)", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-shim-cmd-"));
  try {
    const binDir = join(dir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    // Both shims present, as npm installs them, so the .cmd choice is the assertion.
    writeFileSync(join(binDir, "pm"), "#!/bin/sh\n", { encoding: "utf-8", mode: 0o755 });
    writeFileSync(join(binDir, "pm.cmd"), "@echo off\r\n", { encoding: "utf-8", mode: 0o755 });
    const moduleUrl = pathToFileURL(join(dir, "index.ts")).href;
    const launch = resolvePmBin(moduleUrl, "win32");
    // The exact spawn for a read: cmd.exe is the executable, and the /d /s /c
    // switches precede the ENTIRE command tail as one outer-quoted argv
    // element. `/d` skips AutoRun, `/s` strips exactly the outer pair, `/c`
    // runs and exits — the same switch set Node's own `shell: true` uses,
    // with per-element quoting done here instead of a raw string join.
    assert.deepEqual(
      [launch.command, ...launch.args(["--path", "/tracker", "list-all", "--json", "--include-body"])],
      [expectedComSpec(), "/d", "/s", "/c", `"${join(binDir, "pm.cmd")} --path /tracker list-all --json --include-body"`]
    );
    assert.equal(launch.windowsVerbatimArguments, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePmBin wraps the extensionless shim in cmd.exe on win32 when only it exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-shim-ext-"));
  try {
    const binDir = join(dir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    // POSIX-style layout with no .cmd: resolution falls to the extensionless
    // shim, and on win32 even that needs the command processor (CreateProcess
    // rejects an extensionless file), so the launch is the wrapped form — the
    // whole tail as ONE outer-quoted element — not a direct spawn that would
    // fail, and not a multi-element tail that /s could strip mid-command.
    writeFileSync(join(binDir, "pm"), "#!/bin/sh\n", { encoding: "utf-8", mode: 0o755 });
    const moduleUrl = pathToFileURL(join(dir, "index.ts")).href;
    const launch = resolvePmBin(moduleUrl, "win32");
    const argv = launch.args(["--path", "/tracker", "list-all", "--json", "--include-body"]);
    assert.deepEqual(
      [launch.command, ...argv],
      [expectedComSpec(), "/d", "/s", "/c", `"${join(binDir, "pm")} --path /tracker list-all --json --include-body"`]
    );
    // Extensionless shim: still wrapped, so /s still strips exactly one pair.
    assert.equal(launch.windowsVerbatimArguments, true);
    assert.ok(argv[3].startsWith('"') && argv[3].endsWith('"'), "the tail must be one outer-quoted element");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePmBin keeps the direct shebang-shim launch on POSIX with the argv verbatim", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-shim-posix-"));
  try {
    const binDir = join(dir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    // Both shims present; on POSIX the extensionless one is chosen AND launched
    // directly — byte-for-byte the invocation this package has always used:
    // command plus the pm arguments as discrete argv elements, and the spawn
    // option values unchanged (windowsVerbatimArguments false is Node's
    // default per-element quoting).
    writeFileSync(join(binDir, "pm"), "#!/bin/sh\n", { encoding: "utf-8", mode: 0o755 });
    writeFileSync(join(binDir, "pm.cmd"), "@echo off\r\n", { encoding: "utf-8", mode: 0o755 });
    const moduleUrl = pathToFileURL(join(dir, "index.ts")).href;
    const launch = resolvePmBin(moduleUrl, "linux");
    assert.deepEqual(
      [launch.command, ...launch.args(["--path", "/tracker", "list-all", "--json", "--include-body"])],
      [join(binDir, "pm"), "--path", "/tracker", "list-all", "--json", "--include-body"]
    );
    assert.equal(launch.windowsVerbatimArguments, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the win32 launch resolves the command processor through ComSpec and falls back to cmd.exe", () => {
  const saved = process.env["ComSpec"];
  const pmArgs = ["--path", "/tracker", "list-all", "--json", "--include-body"];
  try {
    // ComSpec honored when set: the launch must use the machine's configured
    // processor rather than assuming cmd.exe lives at a bare name.
    process.env["ComSpec"] = "C:\\Windows\\system32\\cmd.exe";
    const viaComSpec = pmLaunchPlan(join("x", "pm.cmd"), "win32");
    assert.equal(viaComSpec.command, "C:\\Windows\\system32\\cmd.exe");
    assert.deepEqual(
      viaComSpec.args(pmArgs),
      ["/d", "/s", "/c", `"${join("x", "pm.cmd")} --path /tracker list-all --json --include-body"`]
    );
    // Fallback when unset: the documented default.
    delete process.env["ComSpec"];
    const viaDefault = pmLaunchPlan(join("x", "pm.cmd"), "win32");
    assert.equal(viaDefault.command, "cmd.exe");
    assert.deepEqual(
      viaDefault.args(pmArgs),
      ["/d", "/s", "/c", `"${join("x", "pm.cmd")} --path /tracker list-all --json --include-body"`]
    );
  } finally {
    if (saved === undefined) delete process.env["ComSpec"];
    else process.env["ComSpec"] = saved;
  }
});

test("pmLaunchPlan wraps even the bare PATH fallback 'pm' on win32 so PATHEXT resolution happens", () => {
  // On win32 a bare 'pm' cannot be spawned directly either: Node does not do
  // PATHEXT lookup, so the direct spawn would ENOENT. The command processor
  // does that lookup, so the fallback goes through the same one-element tail
  // as every other form.
  const launch = pmLaunchPlan("pm", "win32");
  assert.equal(launch.command, expectedComSpec());
  assert.deepEqual(
    launch.args(["--path", "/tracker", "list-all", "--json", "--include-body"]),
    ["/d", "/s", "/c", '"pm --path /tracker list-all --json --include-body"']
  );
});

test("pmLaunchPlan returns a direct launch with no wrapping on POSIX", () => {
  const launch = pmLaunchPlan(join("x", "pm"), "linux");
  assert.equal(launch.command, join("x", "pm"));
  assert.deepEqual(launch.args(["--path", "/tracker"]), ["--path", "/tracker"]);
  assert.equal(launch.windowsVerbatimArguments, false);
});

// --- pmLaunchPlan win32 quoting: the cmd.exe /s tail contract --------------------
//
// Regression tests for the /s quote-stripping defect found in review (PR #35,
// Greptile P1): passing the shim and the pm arguments as DISCRETE argv elements
// after `/d /s /c` lets Node assemble the tail, and cmd's documented "old
// behavior" quote handling (forced unconditionally by /s) strips the tail's
// leading quote and its LAST quote character whenever the first character after
// /c is a quote. When the final argument itself needs quoting — any tracker
// root containing a space — that last quote is an inner one, so the strip also
// destroys the quote protecting the executable path and the command splits at
// its first space. The launch now passes the whole tail as ONE argv element
// wrapped in an outer pair of quotes added by us (with
// windowsVerbatimArguments so Node adds nothing), so /s removes exactly the
// outer pair. These tests pin that contract without a Windows box.

/**
 * Parse a Windows command line back into argv per the documented
 * CommandLineToArgvW rules, the inverse of the quoting pmLaunchPlan applies:
 * space and tab separate arguments unless inside double quotes; 2n
 * backslashes immediately before a quote collapse to n, and an odd run makes
 * the quote literal; a doubled quote inside quotes is one literal quote.
 *
 * Written here rather than imported so the round-trip assertions are a real
 * re-parse under the documented rules, not a mirror of the quoter that could
 * share a bug with it and pass vacuously.
 *
 * @param line - One command line (no argv0) to parse.
 * @returns The argv elements the child process would observe.
 */
function parseWindowsCommandLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    // Skip the whitespace that separates one argument from the next.
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
    if (i >= line.length) break;
    let arg = "";
    let backslashes = 0;
    let quoted = false;
    while (i < line.length) {
      const c = line[i];
      if (c === "\\") {
        backslashes += 1;
        i += 1;
        continue;
      }
      if (c === '"') {
        arg += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          // 2n+1 backslashes then a quote: n backslashes plus a literal quote.
          arg += '"';
        } else {
          // A bare quote toggles quoting, except "" inside quotes is literal.
          if (quoted && i + 1 < line.length && line[i + 1] === '"') {
            arg += '"';
            i += 1;
          } else {
            quoted = !quoted;
          }
        }
        backslashes = 0;
        i += 1;
        continue;
      }
      // Any other character flushes pending backslashes literally.
      arg += "\\".repeat(backslashes);
      backslashes = 0;
      if (!quoted && (c === " " || c === "\t")) break; // ends this argument
      arg += c;
      i += 1;
    }
    arg += "\\".repeat(backslashes);
    out.push(arg);
  }
  return out;
}

test("win32 outer-wraps the tail so /s cannot strip the quotes protecting a spaced .cmd path (quoted final arg)", () => {
  // The exact broken case: a spaced shim path AND a final argument that itself
  // needs quoting. With the old discrete-element tail, cmd's /s rule removed
  // the shim's opening quote and the tracker root's closing quote, splitting
  // the executable path at its first space.
  const bin = "C:\\Program Files\\pm\\node_modules\\.bin\\pm.cmd";
  const root = "C:\\Users\\Some User\\tracker";
  const launch = pmLaunchPlan(bin, "win32");
  const argv = launch.args(["--path", root, "list-all", "--json", "--include-body"]);
  assert.equal(launch.windowsVerbatimArguments, true, "the tail is pre-quoted; Node must not re-quote it");
  // The exact spawn argv: the entire command tail is ONE element. Note the
  // doubled opening quote: the outer pair we add, then the bin's own quotes —
  // /s strips exactly the outer pair and leaves the inner one intact.
  assert.deepEqual(argv, [
    "/d", "/s", "/c",
    '""C:\\Program Files\\pm\\node_modules\\.bin\\pm.cmd" --path "C:\\Users\\Some User\\tracker" list-all --json --include-body"',
  ]);
  const tail = argv[3];
  // The outer pair exists: the FIRST character after /c and the LAST quote on
  // the tail are both ours, so the /s strip removes exactly that pair.
  assert.ok(tail.startsWith('"'), "tail must open with the outer quote");
  assert.ok(tail.endsWith('"'), "tail must close with the outer quote — this is what the unwrapped form lacks");
  // Inner quoting survives: the spaced shim path stays one quoted token, and
  // the final argument keeps ITS quotes even though it is last.
  assert.ok(
    tail.slice(1, -1).startsWith('"C:\\Program Files\\pm\\node_modules\\.bin\\pm.cmd"'),
    "the shim's own quotes must survive inside the outer pair"
  );
  assert.ok(
    tail.includes('--path "C:\\Users\\Some User\\tracker"'),
    "the quoted final argument must keep its quotes"
  );
  // And cmd hands the child exactly the command line we intended: strip the
  // outer pair the way /s does, parse per CommandLineToArgvW, compare.
  assert.deepEqual(parseWindowsCommandLine(tail.slice(1, -1)), [
    bin, "--path", root, "list-all", "--json", "--include-body",
  ]);
});

test("win32 wraps the spaced extensionless shim in the same outer-quoted tail", () => {
  // Spec case 3: the extensionless shim also goes through the processor, so a
  // spaced one needs the same outer pair or /s splits it identically.
  const bin = "C:\\Program Files\\pm\\node_modules\\.bin\\pm";
  const root = "C:\\Users\\Some User\\tracker";
  const launch = pmLaunchPlan(bin, "win32");
  const argv = launch.args(["--path", root, "list-all", "--json", "--include-body"]);
  assert.equal(launch.windowsVerbatimArguments, true);
  assert.equal(argv.length, 4, "the whole tail must be one argv element after /d /s /c");
  assert.ok(argv[3].startsWith('"') && argv[3].endsWith('"'), "outer pair present");
  assert.deepEqual(parseWindowsCommandLine(argv[3].slice(1, -1)), [
    bin, "--path", root, "list-all", "--json", "--include-body",
  ]);
});

test("every cmd metacharacter round-trips through the win32 tail per the CommandLineToArgvW rules", () => {
  const bin = "C:\\Program Files\\pm\\node_modules\\.bin\\pm.cmd";
  // Spec case 2: each metacharacter, embedded in a realistic tracker root. A
  // metacharacter outside quotes would be cmd syntax; the quoter must wrap
  // every one of these, and the re-parse must recover the original argv.
  for (const ch of [" ", "\t", "&", "|", "<", ">", "^", "(", ")", '"']) {
    const root = `C:\\Users\\Some User ${ch} part\\tracker`;
    const pmArgs = ["--path", root, "list-all", "--json", "--include-body"];
    const argv = pmLaunchPlan(bin, "win32").args(pmArgs);
    assert.equal(argv.length, 4, `one tail element for '${ch}'`);
    const tail = argv[3];
    assert.ok(tail.startsWith('"') && tail.endsWith('"'), `outer pair for '${ch}'`);
    assert.deepEqual(
      parseWindowsCommandLine(tail.slice(1, -1)),
      [bin, ...pmArgs],
      `the tail after /s strips the outer pair must re-parse to the original argv for '${ch}'`
    );
  }
});

test("backslash and quote interactions in the win32 tail follow the documented doubling rules", () => {
  const bin = "C:\\Program Files\\pm\\node_modules\\.bin\\pm.cmd";
  // Backslash runs directly before a quote (or before the closing quote we
  // append) must double, or a root ending in a backslash would eat the
  // closing quote and swallow the NEXT argument into the path.
  const cases = [
    "C:\\Users\\Some User\\tracker\\",          // trailing backslash before the closing quote
    'C:\\Users\\O"Brien\\tracker',               // embedded quote
    'C:\\Users\\weird\\"quoted\\"\\end',        // backslash-run directly before quotes
    'C:\\Users\\a\\b\\"',                      // run of backslashes then a trailing quote
    "",                                        // empty argument must survive as ""
    "plain",                                   // no quoting needed at all
  ];
  for (const root of cases) {
    const pmArgs = ["--path", root, "list-all", "--json", "--include-body"];
    const { args } = pmLaunchPlan(bin, "win32");
    const tail = args(pmArgs)[3];
    assert.ok(tail.startsWith('"') && tail.endsWith('"'), `outer pair for ${JSON.stringify(root)}`);
    assert.deepEqual(
      parseWindowsCommandLine(tail.slice(1, -1)),
      [bin, ...pmArgs],
      `round trip for ${JSON.stringify(root)}`
    );
  }
});

test("fetchAllItems passes a metacharacter-laden pmRoot as one discrete argv element, never a shell string", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-metachar-"));
  try {
    // A fake pm that echoes every argv element it received back as item ids.
    // Whatever reaches this child arrives via a real spawnSync launch, so the
    // round trip proves the metacharacter root survived as ONE argv element:
    // any shell concatenation would split or interpret it (`&`, `|`, `"`).
    const bin = join(dir, "argv-echo-pm");
    writeFileSync(
      bin,
      "#!/bin/sh\nexec node -e 'process.stdout.write(JSON.stringify({items:process.argv.slice(1).map(id=>({id}))}))' -- \"$@\"\n",
      { encoding: "utf-8", mode: 0o755 }
    );
    chmodSync(bin, 0o755);
    const evil = 'root with space & "quote" | pipe';
    // Passed as a PmLaunch (the shape resolvePmBin returns), exercising the
    // non-string arm of fetchAllItems' parameter on the same path. On POSIX
    // the launch is the direct spawn, so this is the same metacharacter
    // round trip the real read performs.
    const items = fetchAllItems(evil, pmLaunchPlan(bin, "linux"));
    assert.deepEqual(items.map((i) => i.id), [
      "--path",
      evil,
      "list-all",
      "--json",
      "--include-body",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems returns items from a valid list-all --json document", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-ok-"));
  try {
    const bin = join(dir, "good-pm");
    const doc = JSON.stringify({ items: [{ id: "pm-1", title: "T", status: "open" }, { id: "pm-2", title: "U", status: "in_progress" }] });
    writeFileSync(bin, `#!/bin/sh\necho '${doc}'\nexit 0\n`, { encoding: "utf-8", mode: 0o755 });
    chmodSync(bin, 0o755);
    const items = fetchAllItems("/anywhere", bin);
    assert.equal(items.length, 2);
    assert.equal(items[0].id, "pm-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAllItems returns an empty array when list-all --json omits the items field", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-read-no-items-"));
  try {
    const bin = join(dir, "no-items-pm");
    // A valid JSON document with no `items` key must fall back to [] rather than
    // throw or return undefined.
    writeFileSync(bin, "#!/bin/sh\necho '{}'\nexit 0\n", { encoding: "utf-8", mode: 0o755 });
    chmodSync(bin, 0o755);
    const items = fetchAllItems("/anywhere", bin);
    assert.deepEqual(items, []);
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

  // A non-existent tracker root makes the real pm list-all read exit non-zero,
  // so fetchAllItems throws a CommandError, which the runtime propagates.
  await assert.rejects(
    harness.runExporter({ exporter: "standup", pmRoot: "/tmp/standup-regression-no-such-tracker", options: { format: "md" } }),
    (e: unknown) => {
      assert.ok(e instanceof CommandError, "the handler must propagate a CommandError, not return an empty export");
      const err = e as CommandError;
      assert.notEqual(err.exitCode, 0, "the propagated exit code must be non-zero");
      assert.match(err.message, /tracker_not_initialized|Tracker is not initialized|pm list-all failed/);
      return true;
    }
  );
});
