/** Exercise the coverage gate with real Node tests in disposable source trees. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectSources, runGate, runIfMain } from "../scripts/coverage-gate.ts";

/** Create an isolated package whose authored files and tests are independently controlled. */
function fixture(check: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "standup-coverage-gate-"));
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", coverageGate: {
    sources: ["."], tests: ["test/*.test.ts"],
    thresholds: { lines: 100, statements: 100, branches: 100, functions: 100 }, ignore: [],
  } }));
  writeFileSync(join(root, "index.ts"), "export const message = 'ready';\n");
  writeFileSync(join(root, "scripts", "operation.ts"), "export const operation = 'complete';\n");
  writeFileSync(join(root, "test", "fixture.test.ts"),
    "import assert from 'node:assert/strict'; import test from 'node:test'; import { message } from '../index.ts'; import { operation } from '../scripts/operation.ts'; test('observable exports', () => { assert.equal(message, 'ready'); assert.equal(operation, 'complete'); });\n");
  try { check(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("coverage inventories operational scripts and independently reports all four dimensions", () => {
  fixture((root) => {
    writeFileSync(join(root, ".c8rc.json"), JSON.stringify({ include: ["index.ts"], all: false, lines: 0 }));
    assert.deepEqual(collectSources(root), ["index.ts", "scripts/operation.ts"]);
    assert.equal(runGate(root), 0);
    const summary = JSON.parse(readFileSync(join(root, "coverage", "coverage-summary.json"), "utf8")) as {
      total: Record<string, { pct: number }>;
    };
    for (const metric of ["lines", "statements", "branches", "functions"]) assert.equal(summary.total[metric].pct, 100);
  });
});

test("an unimported operational source fails the gate and invalidates stale LCOV", () => {
  fixture((root) => {
    mkdirSync(join(root, "coverage"));
    writeFileSync(join(root, "coverage", "lcov.info"), "stale-success");
    writeFileSync(join(root, "coverage", "coverage-summary.json"), "stale-success");
    writeFileSync(join(root, "scripts", "unloaded.ts"), "export function missing() { return 'uncovered'; }\n");
    assert.equal(runGate(root), 1);
    assert.throws(() => readFileSync(join(root, "coverage", "lcov.info")));
    assert.throws(() => readFileSync(join(root, "coverage", "coverage-summary.json")));
  });
});

test("coverage through a directory alias reports the canonical source inventory", () => {
  fixture((root) => {
    const alias = `${root}-alias`;
    symlinkSync(root, alias, "junction");
    try {
      assert.equal(runGate(alias), 0);
      const summary = JSON.parse(readFileSync(join(alias, "coverage", "coverage-summary.json"), "utf8")) as Record<string, unknown>;
      assert.equal(Object.keys(summary).length, 3);
    } finally { rmSync(alias, { force: true }); }
  });
});

test("source enumeration excludes generated trees and verifies that type-only files erase", () => {
  fixture((root) => {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "generated.ts"), "export const generated = true;");
    writeFileSync(join(root, "types.d.ts"), "export declare const declared: string;");
    writeFileSync(join(root, "types.ts"), "/** Data contract. */\nexport interface Contract { value: string }\n");
    writeFileSync(join(root, "notes.txt"), "fixture notes");
    assert.deepEqual(collectSources(root), ["index.ts", "scripts/operation.ts"]);
    assert.equal(runGate(root), 0);
  });
});

test("invalid configuration and empty source inventories fail closed", () => {
  fixture((root) => {
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      coverageGate: { sources: string[]; ignore: string[]; thresholds: Record<string, number>; tests: string[] };
    };
    for (const config of [undefined, { ...manifest.coverageGate, sources: [] },
      { ...manifest.coverageGate, sources: ["index.ts"] },
      { ...manifest.coverageGate, sources: [".", "scripts"] },
      { ...manifest.coverageGate, ignore: ["scripts/operation.ts"] }]) {
      writeFileSync(manifestPath, JSON.stringify({ type: "module", coverageGate: config }));
      assert.equal(runGate(root), 1);
    }
    for (const threshold of [-1, 0, 99.99, 101, null]) {
      writeFileSync(manifestPath, JSON.stringify({ type: "module", coverageGate: {
        ...manifest.coverageGate, thresholds: { ...manifest.coverageGate.thresholds, statements: threshold },
      } }));
      assert.equal(runGate(root), 1);
    }
    writeFileSync(manifestPath, JSON.stringify(manifest));
    rmSync(join(root, "index.ts"));
    rmSync(join(root, "scripts", "operation.ts"));
    assert.equal(runGate(root), 1);
  });
});

test("a failing behavioral assertion cannot leave a successful coverage receipt", () => {
  fixture((root) => {
    writeFileSync(join(root, "test", "failing.test.ts"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('failure', () => assert.equal('actual', 'expected'));\n");
    assert.equal(runGate(root), 1);
    assert.throws(() => readFileSync(join(root, "coverage", "lcov.info")));
  });
});

test("a source disappearing during the suite cannot silently shrink the report", () => {
  fixture((root) => {
    writeFileSync(join(root, "test", "fixture.test.ts"), "import { unlinkSync } from 'node:fs'; import assert from 'node:assert/strict'; import test from 'node:test'; import { message } from '../index.ts'; import { operation } from '../scripts/operation.ts'; test('loaded before removal', () => { assert.equal(message, 'ready'); assert.equal(operation, 'complete'); unlinkSync(new URL('../index.ts', import.meta.url)); });\n");
    assert.equal(runGate(root), 1);
  });
});

test("direct invocation sets success status while imports leave status untouched", () => {
  fixture((root) => {
    const previousStatus = process.exitCode;
    try {
      assert.equal(runIfMain([], import.meta.url, root), false);
      assert.equal(runIfMain([process.execPath, import.meta.filename], import.meta.url, root), true);
      assert.equal(process.exitCode, 0);
    } finally { process.exitCode = previousStatus; }
  });
});
