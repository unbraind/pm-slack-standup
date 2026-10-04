/** Measure all authored TypeScript, including operational scripts, with fresh V8 counters. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { isMainInvocation } from "./main-invocation.ts";

/** Four independently reported Istanbul coverage dimensions. */
interface Thresholds {
  readonly lines: number;
  readonly statements: number;
  readonly branches: number;
  readonly functions: number;
}

/** Package-owned source inventory and test runner settings. */
interface CoverageConfig {
  readonly sources: readonly string[];
  readonly tests: readonly string[];
  readonly thresholds: Thresholds;
  readonly ignore: readonly string[];
}

/** Only dependencies, fixtures, generated output and tracker data are outside authored source. */
const nonSourceDirectories = new Set([
  "node_modules", "test", "tests", "dist", "dist-test", "coverage", ".git", ".agents",
]);
const metrics = ["lines", "statements", "branches", "functions"] as const;
const c8 = createRequire(import.meta.url).resolve("c8/bin/c8.js");

/**
 * Inventory executable TypeScript recursively without excluding operational scripts.
 * Type-only declarations erase completely and carry no runtime counters.
 * @param root - Package root or a nested source directory.
 * @param base - Package root used to normalize report paths.
 * @returns Sorted repository-relative executable source paths.
 */
export function collectSources(root: string, base = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!nonSourceDirectories.has(entry.name)) files.push(...collectSources(path, base));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      const emitted = stripTypeScriptTypes(readFileSync(path, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "")
        .replace(/export\s*\{\s*\}\s*;?/gu, "").trim();
      if (emitted.length > 0) files.push(relative(base, path).split(sep).join("/"));
    }
  }
  return files.sort();
}

/**
 * Run real tests with isolated counters and enforce a complete four-metric report.
 * Failed runs remove the public LCOV receipt so downstream gates cannot reuse it.
 * @param root - Package root containing package.json, authored source and tests.
 * @returns Zero only for a complete passing report; one for configuration, test or coverage failures.
 */
export function runGate(root: string): number {
  const reportDir = join(root, "coverage");
  const lcov = join(reportDir, "lcov.info");
  mkdirSync(reportDir, { recursive: true });
  rmSync(lcov, { force: true });
  const counters = join(reportDir, "gate-counters");
  rmSync(counters, { recursive: true, force: true });
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { coverageGate?: CoverageConfig };
    const config = manifest.coverageGate;
    if (!config || config.sources.length !== 1 || config.sources[0] !== "." || config.ignore.length !== 0) {
      throw new Error('coverageGate must inventory sources ["."] with no ignored executable source');
    }
    for (const metric of metrics) {
      const threshold = config.thresholds[metric];
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
        throw new Error(`coverageGate.thresholds.${metric} must be a finite percentage`);
      }
    }
    const sources = collectSources(root);
    if (sources.length === 0) throw new Error("source walk found no executable TypeScript files");
    const settings = join(reportDir, "gate-config.json");
    writeFileSync(settings, JSON.stringify({
      all: true, src: [root], include: sources, exclude: [], extension: [".ts"],
      reporter: ["text", "lcovonly", "json-summary"],
      "reports-dir": reportDir, "temp-directory": counters,
      "exclude-after-remap": true, "check-coverage": true, ...config.thresholds,
    }));
    const environment: NodeJS.ProcessEnv = { ...process.env, TZ: "UTC" };
    delete environment.NODE_TEST_CONTEXT;
    execFileSync(process.execPath, [c8, "--config", settings, process.execPath,
      "--test", "--test-reporter=spec", ...config.tests], {
      cwd: root, stdio: "inherit",
      env: environment,
    });
    const summary = JSON.parse(readFileSync(join(reportDir, "coverage-summary.json"), "utf8")) as Record<string, unknown>;
    const reported = Object.keys(summary).filter((file) => file !== "total")
      .map((file) => relative(root, file).split(sep).join("/")).sort();
    if (JSON.stringify(reported) !== JSON.stringify(sources)) {
      throw new Error(`report/source inventory mismatch: expected ${sources.join(", ")}; reported ${reported.join(", ")}`);
    }
    console.log(`coverage-gate: ${sources.length} source file(s) reported; lines/statements/branches/functions thresholds met.`);
    return 0;
  } catch (error: unknown) {
    rmSync(lcov, { force: true });
    console.error(`coverage-gate: ${String(error)}`);
    return 1;
  }
}

/**
 * Execute the gate only for a direct invocation, preserving import safety.
 * @param argv - Process argument vector used by the entry-point guard.
 * @param moduleUrl - URL of the executable gate module.
 * @param root - Package root to measure.
 * @returns Whether the gate ran and set the process exit code.
 */
export function runIfMain(argv: readonly string[], moduleUrl: string, root: string): boolean {
  if (!isMainInvocation(argv, moduleUrl)) return false;
  process.exitCode = runGate(root);
  return true;
}

runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));
