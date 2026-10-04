/** Real-process checks for the canonical thin lint, duplication and docstring launchers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import "../scripts/accept-canonical-reader.ts";

const repoRoot = resolve(import.meta.dirname, "..");

/** Run a real gate in a dependency-linked fixture, retaining its status and both streams. */
function gateFixture(script: string, sources: Readonly<Record<string, string>>, manifest: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "standup-thin-gate-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "junction");
    for (const [file, source] of Object.entries(sources)) writeFileSync(join(root, file), source);
    return spawnSync(process.execPath, [join(repoRoot, "scripts", script)], { cwd: root, env: process.env, encoding: "utf8", timeout: 30_000 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("lint launcher accepts clean source and emits the real strict-policy diagnostic", () => {
  const clean = gateFixture("lint.ts", { "clean.ts": "export const version: number = 1;\n" }, { type: "module" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout, "");
  assert.equal(clean.stderr, "");
  const bad = gateFixture("lint.ts", { "bad.ts": "debugger;\n" }, { type: "module" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /bad\.ts/u);
  assert.match(bad.stderr, /no-debugger/u);
});

test("duplication launcher reports actual clean and cloned fixture sources", () => {
  const source = "export function evaluate(numbers: readonly number[]): number {\n  let total = 0;\n  for (const value of numbers) {\n    if (value > 0) total += value * 2;\n    else total -= value;\n  }\n  return total;\n}\n";
  const config = { type: "module", duplicationGate: { threshold: 0, minTokens: 10 } };
  const clean = gateFixture("duplication-gate.ts", { "original.ts": source }, config);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /duplication.*0.*clone/iu);
  const duplicate = gateFixture("duplication-gate.ts", { "original.ts": source, "duplicate.ts": source }, config);
  assert.equal(duplicate.status, 1, duplicate.stdout + duplicate.stderr);
  assert.match(duplicate.stdout, /original\.ts/u);
  assert.match(duplicate.stdout, /duplicate\.ts/u);
  assert.match(duplicate.stderr, /exceeds the configured 0% threshold/u);
  const missingContract = gateFixture("duplication-gate.ts", { "original.ts": source }, { type: "module" });
  assert.equal(missingContract.status, 1);
  assert.match(missingContract.stderr, /duplicationGate/u);
});

test("direct docstring entry scans source and emits a newline-terminated success receipt", () => {
  const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "docstring-gate.ts")], { cwd: repoRoot, encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^docstring-gate: \d+ file\(s\), \d+ declaration\(s\) documented\.\n$/u);
  assert.equal(result.stderr, "");
});
