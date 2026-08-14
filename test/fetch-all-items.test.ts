import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchAllItems,
  describePmReadFailure,
  pmJsonMaxBuffer,
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
test("resolvePmBin resolves the project-local node_modules/.bin/pm shim from this module", () => {
  const bin = resolvePmBin(import.meta.url);
  // Walking up from this test file reaches the package root, whose
  // node_modules/.bin/pm shim exists (this package dev-depends on @unbrained/pm-cli).
  assert.ok(bin.endsWith(join("node_modules", ".bin", "pm")), `expected a node_modules/.bin/pm path, got ${bin}`);
  // It must NOT be the bare PATH fallback.
  assert.notEqual(bin, "pm");
});

test("resolvePmBin falls back to 'pm' on PATH when no local node_modules/.bin/pm exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-pmbin-fallback-"));
  try {
    // A module URL inside a temp tree with no node_modules must fall back.
    const fakeModuleUrl = pathToFileURL(join(dir, "index.js")).href;
    assert.equal(resolvePmBin(fakeModuleUrl), "pm");
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

test("resolvePmBin prefers the .cmd shim on Windows and the extensionless shim elsewhere", () => {
  const dir = mkdtempSync(join(tmpdir(), "standup-shim-"));
  try {
    const binDir = join(dir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    // Both shims present, as npm installs them, so the choice is the assertion.
    writeFileSync(join(binDir, "pm"), "#!/bin/sh\n", { encoding: "utf-8", mode: 0o755 });
    writeFileSync(join(binDir, "pm.cmd"), "@echo off\r\n", { encoding: "utf-8", mode: 0o755 });
    const moduleUrl = pathToFileURL(join(dir, "index.ts")).href;
    const expected = process.platform === "win32" ? join(binDir, "pm.cmd") : join(binDir, "pm");
    assert.equal(resolvePmBin(moduleUrl), expected);
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
