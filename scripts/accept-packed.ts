import assert from "node:assert/strict";
import { decodeToon, getHistoryPath, getItemPath } from "@unbrained/pm-cli/sdk";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { COMPLETE_LIST_COMMAND_ARGUMENTS, encodeProgressEvidence, encodeStandupCommitment } from "../index.ts";
import type { CommitmentVarianceReport, ProgressReport, StandupWindowPacket } from "../index.ts";
import { treeState } from "../test/tracker-state.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Package fields that define the installed-extension acceptance matrix. */
interface PackageContract {
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

/** One package-manager and host-version combination exercised in isolation. */
interface AcceptanceScenario {
  readonly name: string;
  readonly manager: "npm" | "bun";
  readonly hostVersion: string;
}

/** Machine-readable proof emitted for one successful packed extension. */
interface AcceptanceReceipt {
  readonly scenario: string;
  readonly host_version: string;
  readonly tracker_items: number;
  readonly rendered_items: number;
  readonly stderr_bytes: number;
  readonly fixtures_present: true;
  /** Revision-cited progress and checkpoint replay were exercised through the installed CLI. */
  readonly progress_verified?: true;
  /** Selected commitment variance is exercised through this exact installed artifact. */
  readonly variance_verified?: true;
  /** Orphaned live storage and native deletion were distinguished through the installed host. */
  readonly materialization_verified?: true;
  /** Retained reporting windows were exercised through the installed host. */
  readonly window_verified?: true;
}

const repoRoot = resolve(import.meta.dirname, "..");
const cliPackage = "@unbrained/pm-cli";

/** Validate the exact development host and minimum supported peer before packing. */
export function acceptanceVersions(packageJson: PackageContract): { developmentVersion: string; minimumVersion: string } {
  const developmentVersion = packageJson.devDependencies[cliPackage];
  const minimumMatch = packageJson.peerDependencies[cliPackage]?.match(/^>=\s*(\d+\.\d+\.\d+)$/u);
  const minimumVersion = minimumMatch?.[1];
  if (!developmentVersion || !/^\d+\.\d+\.\d+$/u.test(developmentVersion) || !minimumVersion) {
    throw new Error(`package.json must declare an exact development version and a >= exact minimum peer version for ${cliPackage}`);
  }
  return { developmentVersion, minimumVersion };
}

/** Executable and leading arguments used to invoke a package-manager CLI. */
interface Launcher {
  readonly command: string;
  readonly prefix: string[];
}

/** Explicit platform selection shared by the real matrix and portable config tests. */
interface AcceptanceLaunchers {
  readonly npm: Launcher;
  readonly npx: Launcher;
  readonly bun: string;
  readonly bunx: string;
}

/**
 * Select npm's pinned JavaScript entry or resolve its Windows installation from PATH.
 * @param platform - Target platform for executable naming and path parsing.
 * @param npmExecPath - Inherited npm entry, preserved as unset when absent.
 * @param node - Node executable used for JavaScript launchers.
 * @param searchPath - Explicit PATH used to find npm's Windows installation.
 * @returns Executables and discrete entry prefixes for npm, npx and Bun.
 * @throws {Error} When Windows cannot resolve npm and npx JavaScript entries.
 */
export function acceptanceLaunchers(platform: NodeJS.Platform, npmExecPath: string | undefined, node: string, searchPath = ""): AcceptanceLaunchers {
  const windows = platform === "win32";
  const paths = windows ? win32 : posix;
  let npmCli = npmExecPath?.endsWith(".js") ? npmExecPath : undefined;
  let npxCli = npmCli === undefined ? undefined : paths.resolve(paths.dirname(npmCli), "npx-cli.js");
  if (windows && npmCli === undefined) {
    for (const directory of searchPath.split(";")) {
      if (directory === "") continue;
      const bin = join(directory, "node_modules", "npm", "bin");
      const candidate = join(bin, "npm-cli.js");
      const npxCandidate = join(bin, "npx-cli.js");
      if (existsSync(candidate) && existsSync(npxCandidate)) {
        npmCli = candidate;
        npxCli = npxCandidate;
        break;
      }
    }
  }
  if (windows && npmCli === undefined) {
    throw new Error("Cannot resolve npm-cli.js and npx-cli.js on Windows. Set npm_execpath to npm's JavaScript entry in a complete npm installation or set PATH to its prefix containing node_modules/npm/bin; .cmd shims cannot launch without a shell.");
  }
  return {
    npm: npmCli === undefined
      ? { command: "npm", prefix: [] }
      : { command: node, prefix: [npmCli] },
    npx: npxCli === undefined
      ? { command: "npx", prefix: [] }
      : { command: node, prefix: [npxCli] },
    bun: windows ? "bun.exe" : "bun",
    bunx: windows ? "bunx.exe" : "bunx",
  };
}

/** Isolate installs from parent PM/npm settings while retaining child-process V8 coverage. */
export function acceptanceEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source, npm_config_userconfig: devNull, NPM_CONFIG_USERCONFIG: devNull, PM_TELEMETRY_DISABLED: "1" };
  for (const key of Object.keys(environment)) {
    if (["npm_config_allow_scripts", "pm_path", "pm_global_path", "npm_media_server"].includes(key.toLowerCase())
      || /token|secret|password|credential|api_key/i.test(key)) {
      delete environment[key];
    }
  }
  return environment;
}

const cleanEnvironment = acceptanceEnvironment(process.env);
/** Maximum time allowed for one install, pack, or pm subprocess. */
const commandTimeoutMs = 5 * 60 * 1000;

/** Run one shell-free command and fail with bounded diagnostics. */
export function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = cleanEnvironment, timeoutMs = commandTimeoutMs, expectedStatus = 0): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(`${command} ${args.join(" ")} exceeded ${String(timeoutMs)}ms and was terminated`);
  }
  if (result.status !== expectedStatus) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${String(result.status)}: ${(result.stderr || result.error?.message || result.stdout).trim()}`);
  }
  return result;
}

/** Invoke the scenario-local pm host through its user-facing launcher. */
function runPm(launchers: AcceptanceLaunchers, scenario: AcceptanceScenario, cwd: string, env: NodeJS.ProcessEnv, args: string[], expectedStatus = 0): SpawnSyncReturns<string> {
  return scenario.manager === "npm"
    ? run(launchers.npx.command, [...launchers.npx.prefix, "--no-install", "pm", ...args], cwd, env, commandTimeoutMs, expectedStatus)
    : run(launchers.bunx, ["--no-install", "pm", ...args], cwd, env, commandTimeoutMs, expectedStatus);
}

/** Select the single packed artifact, rejecting empty or ambiguous output directories. */
export function packedTarball(packRoot: string): string {
  const packedNames = readdirSync(packRoot).filter((name) => name.endsWith(".tgz"));
  if (packedNames.length !== 1) {
    throw new Error(`npm pack must create exactly one tarball, got ${String(packedNames.length)}`);
  }
  return join(packRoot, packedNames[0]!);
}

/** Refuse an unexpected host before it can initialize or modify an acceptance workspace. */
export function assertHostVersion(name: string, actualVersion: string, expectedVersion: string): void {
  if (actualVersion !== expectedVersion) {
    throw new Error(`${name} resolved pm ${actualVersion}, expected ${expectedVersion}`);
  }
}

/** Reconcile a real local-host export with its complete tracker read and expected titles. */
export function scenarioReceipt(scenario: AcceptanceScenario, actualVersion: string, listed: Record<string, unknown>, exported: Pick<SpawnSyncReturns<string>, "stdout" | "stderr">, expectedTitles: readonly [string, string]): AcceptanceReceipt {
  assertHostVersion(scenario.name, actualVersion, scenario.hostVersion);
  const trackerItems = Array.isArray(listed.items) ? listed.items.length : -1;
  if (trackerItems !== 2 || listed.count !== trackerItems || listed.total !== trackerItems) {
    throw new Error(`${scenario.name} complete tracker receipt did not reconcile two created fixtures`);
  }
  const document = JSON.parse(exported.stdout) as Record<string, unknown>;
  const sections = document.sections_data;
  if (sections === null || typeof sections !== "object" || Array.isArray(sections)) {
    throw new Error(`${scenario.name} standup export omitted sections_data`);
  }
  const rendered = Object.values(sections).flatMap((value) => Array.isArray(value) ? value : []);
  const titles = new Set(rendered.flatMap((value) => value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).title === "string"
    ? [(value as Record<string, unknown>).title as string]
    : []));
  if (!titles.has(expectedTitles[0]) || !titles.has(expectedTitles[1])) {
    throw new Error(`${scenario.name} complete standup omitted a real tracker fixture`);
  }
  if (rendered.length !== trackerItems) {
    throw new Error(`${scenario.name} rendered ${String(rendered.length)} items from a ${String(trackerItems)}-item tracker`);
  }
  if (/deprecated|list-all/iu.test(exported.stderr)) {
    throw new Error(`${scenario.name} emitted a deprecated-command diagnostic: ${exported.stderr.trim()}`);
  }
  return { scenario: scenario.name, host_version: actualVersion, tracker_items: trackerItems, rendered_items: rendered.length, stderr_bytes: Buffer.byteLength(exported.stderr), fixtures_present: true };
}

/** Validate SDK discovery with an externally installed host and no project node_modules. */
export function globalReceipt(actualVersion: string, expectedVersion: string, exported: Pick<SpawnSyncReturns<string>, "stdout" | "stderr">): AcceptanceReceipt {
  assertHostVersion("npm-global-current", actualVersion, expectedVersion);
  const globalDocument = JSON.parse(exported.stdout) as Record<string, unknown>;
  const globalSections = globalDocument.sections_data;
  const globalRendered = globalSections !== null && typeof globalSections === "object" && !Array.isArray(globalSections)
    ? Object.values(globalSections).flatMap((value) => Array.isArray(value) ? value : [])
    : [];
  if (globalRendered.length !== 1 || !globalRendered.some((value) => value !== null && typeof value === "object"
    && (value as Record<string, unknown>).title === "Packed global-host fixture")) {
    throw new Error("npm-global-current could not load the SDK-backed extension from a global host without project node_modules");
  }
  if (/deprecated|list-all/iu.test(exported.stderr)) {
    throw new Error(`npm-global-current emitted a deprecated-command diagnostic: ${exported.stderr.trim()}`);
  }
  return { scenario: "npm-global-current", host_version: actualVersion, tracker_items: 1, rendered_items: globalRendered.length, stderr_bytes: Buffer.byteLength(exported.stderr), fixtures_present: true };
}

/** Select an installed global pm entry without using it to discover an SDK location. */
export function globalHostEntry(prefix: string, packages: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? join(packages, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js") : join(prefix, "bin", "pm");
}

/** Prove current availability independently of retained completion history in every packed consumer. */
function verifyPackedMaterialization(invoke: (args: string[], expectedStatus?: number) => SpawnSyncReturns<string>, target: string, pmRoot: string): void {
  const source = `${target}-availability`;
  invoke(["create", "task", "Availability source", "--id", source, "--create-mode", "progressive",
    "--parent", "none", "--sprint", "none", "--release", "none", "--assignee", "none"]);
  const path = getItemPath(pmRoot, "Task", target);
  let original = readFileSync(path);
  try {
    invoke(["comment", source, encodeStandupCommitment({ version: 1, key: "outcome", target: { id: target, revision: 1 } })]);
    const capture = JSON.parse(invoke(["standup", "progress", source, "--json"]).stdout) as ProgressReport;
    const command = ["standup", "variance", source, "--revision", String(capture.through)];
    invoke(["close", target, "Recorded availability control"]);
    const completed = JSON.parse(invoke([...command, "--json"]).stdout) as CommitmentVarianceReport;
    assert.equal(completed.rows[0].state, "completed");
    original = readFileSync(path);
    const history = readFileSync(getHistoryPath(pmRoot, target));
    rmSync(path);
    const before = treeState(pmRoot);
    for (const json of [false, true]) {
      const output = invoke([...command, ...(json ? ["--json"] : [])]).stdout;
      const report = (json ? JSON.parse(output) : decodeToon(output)) as CommitmentVarianceReport;
      assert.equal(report.rows[0].state, "unsupported");
      assert.equal(report.counts.completed, 0);
      const refusal = invoke(["standup", "progress", target, ...(json ? ["--json"] : [])], 2);
      assert.match(refusal.stderr, /history_unavailable/);
    }
    assert.equal(treeState(pmRoot), before);
    assert.deepEqual(readFileSync(getHistoryPath(pmRoot, target)), history);
    writeFileSync(path, original);
    // A genuine native deletion remains readable as historical evidence.
    invoke(["delete", source]);
    const archived = JSON.parse(invoke(["standup", "progress", source, "--json"]).stdout) as ProgressReport;
    assert.equal(archived.id, source);
  } finally { writeFileSync(path, original); }
}

/** Verify preview replay, durable admission and an empty restart on each packed host. */
function verifyPackedWindow(invoke: (args: string[], expectedStatus?: number) => SpawnSyncReturns<string>, pmRoot: string): void {
  const cursor = join(pmRoot, "packed-window.json");
  const output = join(pmRoot, "packed-packet.json");
  const command = ["standup", "window", "--cursor-file", cursor];
  const preview = JSON.parse(invoke([...command, "--no-advance", "--json"]).stdout) as StandupWindowPacket;
  assert.equal(preview.window.incomplete, false);
  assert.ok(preview.window.events > 0);
  assert.equal(existsSync(cursor), false);
  assert.deepEqual(decodeToon(invoke([...command, "--no-advance"]).stdout), preview);
  const admitted = JSON.parse(invoke([...command, "--output", output, "--json"]).stdout) as StandupWindowPacket;
  assert.deepEqual(admitted, { ...preview, window: { ...preview.window, admitted: true } });
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), admitted);
  const empty = JSON.parse(invoke([...command, "--json"]).stdout) as StandupWindowPacket;
  assert.equal(empty.window.events, 0);
  assert.equal(empty.window.incomplete, false);
  assert.equal(empty.window.boundary_before, admitted.window.boundary_next);
  assert.equal(empty.window.admitted, false);
}

/** Exercise the new command through each installed host, retaining real native SDK/history behavior. */
function verifyPackedProgress(invoke: (args: string[], expectedStatus?: number) => SpawnSyncReturns<string>, id: string, pmRoot: string): void {
  const initial = JSON.parse(invoke(["standup", "progress", id, "--json"]).stdout) as ProgressReport;
  assert.deepEqual(initial.gains, [], "status-only fixtures have no verified progress");
  const declaration = encodeProgressEvidence({ version: 1, kind: "criterion", subject: "AC1", targetRevision: "packed-v1", evidenceRevision: "receipt-v1", value: "accepted" });
  invoke(["comment", id, declaration]);
  const page = JSON.parse(invoke(["standup", "progress", id, "--after", initial.next, "--json"]).stdout) as ProgressReport;
  assert.equal(page.gains.length, 1);
  assert.equal(page.gains[0].evidenceRevision, "receipt-v1");
  assert.ok(page.gains[0].revision.version > initial.through);
  invoke(["comment", id, encodeStandupCommitment({ version: 1, key: "packed", target: { id, revision: 1 } })]);
  const sourceRevision = page.through + 1;
  const beforeVariance = treeState(pmRoot);
  const varianceArgs = ["standup", "variance", id, "--revision", String(sourceRevision)];
  const variance = JSON.parse(invoke([...varianceArgs, "--json"]).stdout) as CommitmentVarianceReport;
  assert.equal(variance.rows[0].state, "still_pending");
  assert.equal(variance.rows[0].baseline!.version, 1);
  assert.equal(variance.source.selected.version, sourceRevision);
  assert.equal(variance.capture, "available");
  assert.equal(treeState(pmRoot), beforeVariance, "packed variance reads preserve native state");
  assert.match(invoke(varianceArgs).stdout, /still_pending/);
  const invalidVariance = invoke([...varianceArgs, "--revision", "Infinity", "--json"], 2);
  assert.equal((JSON.parse(invalidVariance.stderr) as { code: string }).code, "invalid_input");
  const replay = JSON.parse(invoke(["standup", "progress", id, "--after", page.next, "--json"]).stdout) as ProgressReport;
  assert.deepEqual(replay.gains, []);
  const writeRun = (mode: string, subject: string): void => {
    run(process.execPath, [fileURLToPath(new URL("../test/progress-native-writer.ts", import.meta.url)), pmRoot, id, mode, subject], resolve("."));
  };
  for (const mode of ["failed", "malformed"]) {
    writeRun(mode, mode);
    const baseline = JSON.parse(invoke(["standup", "progress", id, "--json"]).stdout) as ProgressReport;
    assert.deepEqual(baseline.gains.filter((gain) => gain.subject === `packed-corrected-${mode}`), []);
    writeRun("passed", mode);
    const corrected = JSON.parse(invoke(["standup", "progress", id, "--after", baseline.next, "--json"]).stdout) as ProgressReport;
    assert.equal(corrected.gains.length, 1);
    assert.equal(corrected.gains[0].revision.version, corrected.through);
    assert.equal(corrected.gains[0].targetRevision, `item:${id}:v${corrected.through}`);
    assert.deepEqual(decodeToon(invoke(["standup", "progress", id, "--after", baseline.next]).stdout), corrected);
    writeRun("empty", mode); writeRun("passed", mode);
    const replay = JSON.parse(invoke(["standup", "progress", id, "--after", corrected.next, "--json"]).stdout) as ProgressReport;
    assert.deepEqual(replay.gains, []);
    const historical = JSON.parse(invoke(["standup", "progress", id, "--after", baseline.next, "--json"]).stdout) as ProgressReport;
    assert.deepEqual(historical.gains, corrected.gains, "packed consumers preserve first-passing provenance");
  }
  invoke(["config", "project", "set", "history-missing-stream-policy", "--policy", "auto_create"]);
  const path = join(pmRoot, "history", `${id}.jsonl`);
  const original = readFileSync(path, "utf8");
  try {
    for (const bytes of [null, "{malformed JSONL\n"]) {
      if (bytes === null) rmSync(path); else writeFileSync(path, bytes);
      const before = treeState(pmRoot);
      for (const format of [[], ["--json"]]) {
        for (const command of [["standup", "progress", id], ["standup", "--dry-run"]]) {
          const result = invoke([...command, ...format], 2);
          if (format.length > 0) {
            const refusal = JSON.parse(result.stderr) as { code: string; required: string };
            assert.equal(refusal.code, "history_unavailable");
            assert.match(refusal.required, /read-only SDK/);
          } else {
            assert.match(result.stderr, /history_unavailable/);
            assert.match(result.stderr, /read-only SDK/);
          }
          assert.equal(treeState(pmRoot), before);
        }
      }
      writeFileSync(path, original);
    }
  } finally { writeFileSync(path, original); }
  verifyPackedMaterialization(invoke, id, pmRoot);
  verifyPackedWindow(invoke, pmRoot);
}

/** Pack once, exercise all real npm/Bun hosts, emit reconciled receipts, and remove fixtures. */
export function acceptPacked(root: string, temporaryParent = tmpdir()): void {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as PackageContract;
  const { developmentVersion, minimumVersion } = acceptanceVersions(packageJson);
  const launchers = acceptanceLaunchers(process.platform, process.env.npm_execpath, process.execPath, process.env.PATH);
  const npmLauncher = launchers.npm;
  const temporaryRoot = mkdtempSync(join(temporaryParent, "pm-slack-standup-packed-acceptance-"));
  try {
    console.error("packed acceptance: pack artifact");
    const packRoot = join(temporaryRoot, "pack");
    mkdirSync(packRoot);
    run(
      npmLauncher.command,
      [...npmLauncher.prefix, "pack", "--ignore-scripts", "--pack-destination", packRoot],
      root,
      { ...cleanEnvironment, npm_config_ignore_scripts: "true", NPM_CONFIG_IGNORE_SCRIPTS: "true" },
    );
    const tarball = packedTarball(packRoot);
    const scenarios: AcceptanceScenario[] = [
      { name: "npm-current", manager: "npm", hostVersion: developmentVersion },
      { name: "bun-current", manager: "bun", hostVersion: developmentVersion },
      { name: "npm-minimum", manager: "npm", hostVersion: minimumVersion },
      { name: "bun-minimum", manager: "bun", hostVersion: minimumVersion },
    ];
    const receipts: AcceptanceReceipt[] = [];

    for (const scenario of scenarios) {
      console.error(`packed acceptance: ${scenario.name}`);
      const scenarioRoot = join(temporaryRoot, scenario.name);
      const isolatedConfig = join(scenarioRoot, "xdg-config");
      const isolatedData = join(scenarioRoot, "xdg-data");
      mkdirSync(scenarioRoot);
      const scenarioEnvironment: NodeJS.ProcessEnv = {
        ...cleanEnvironment,
        PM_PATH: join(scenarioRoot, ".agents", "pm"),
        PM_GLOBAL_PATH: join(scenarioRoot, "global-pm"),
        XDG_CONFIG_HOME: isolatedConfig,
        XDG_DATA_HOME: isolatedData,
        npm_config_cache: join(scenarioRoot, "npm-cache"),
        BUN_INSTALL_CACHE_DIR: join(scenarioRoot, "bun-cache"),
      };
      mkdirSync(isolatedConfig);
      mkdirSync(isolatedData);
      if (scenario.manager === "npm") {
        run(npmLauncher.command, [...npmLauncher.prefix, "init", "-y"], scenarioRoot, scenarioEnvironment);
        run(npmLauncher.command, [...npmLauncher.prefix, "install", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot, scenarioEnvironment);
      } else {
        run(launchers.bun, ["init", "-y"], scenarioRoot, scenarioEnvironment);
        run(launchers.bun, ["add", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot, scenarioEnvironment);
      }
      const actualVersion = runPm(launchers, scenario, scenarioRoot, scenarioEnvironment, ["--version"]).stdout.trim();
      assertHostVersion(scenario.name, actualVersion, scenario.hostVersion);

      runPm(launchers, scenario, scenarioRoot, scenarioEnvironment, ["init", "--defaults", "--agent-guidance", "skip", "--prefix", "accept"]);
      const inProgressTitle = `Packed in progress ${scenario.name}`;
      const openTitle = `Packed up next ${scenario.name}`;
      runPm(launchers, scenario, scenarioRoot, scenarioEnvironment, ["create", "task", inProgressTitle, "--status", "in_progress", "--create-mode", "progressive", "--parent", "none", "--sprint", "none", "--release", "none"]);
      runPm(launchers, scenario, scenarioRoot, scenarioEnvironment, ["create", "task", openTitle, "--status", "open", "--create-mode", "progressive", "--parent", "none", "--sprint", "none", "--release", "none"]);
      runPm(launchers, scenario, scenarioRoot, scenarioEnvironment, ["install", tarball, "--project"]);
      const listed = JSON.parse(runPm(launchers, scenario, scenarioRoot, scenarioEnvironment, COMPLETE_LIST_COMMAND_ARGUMENTS.slice()).stdout) as Record<string, unknown>;
      const exported = runPm(launchers, scenario, scenarioRoot, scenarioEnvironment, ["standup", "export", "--format", "json"]);
      verifyPackedProgress((args, expectedStatus) => runPm(launchers, scenario, scenarioRoot, scenarioEnvironment, args, expectedStatus), String((listed.items as Array<{ id: string }>)[0].id), scenarioEnvironment.PM_PATH!);
      receipts.push({ ...scenarioReceipt(scenario, actualVersion, listed, exported, [inProgressTitle, openTitle]), progress_verified: true, variance_verified: true, materialization_verified: true, window_verified: true });
    }

    console.error("packed acceptance: npm-global-current");
    const globalScenarioRoot = join(temporaryRoot, "npm-global-current");
    const globalHostRoot = join(globalScenarioRoot, "host");
    const globalProjectRoot = join(globalScenarioRoot, "project");
    const globalConfigRoot = join(globalScenarioRoot, "xdg-config");
    const globalDataRoot = join(globalScenarioRoot, "xdg-data");
    mkdirSync(globalHostRoot, { recursive: true });
    mkdirSync(globalProjectRoot);
    mkdirSync(globalConfigRoot);
    mkdirSync(globalDataRoot);
    const globalEnvironment: NodeJS.ProcessEnv = {
      ...cleanEnvironment,
      PM_PATH: join(globalProjectRoot, ".agents", "pm"),
      PM_GLOBAL_PATH: join(globalScenarioRoot, "global-pm"),
      XDG_CONFIG_HOME: globalConfigRoot,
      XDG_DATA_HOME: globalDataRoot,
      npm_config_cache: join(globalScenarioRoot, "npm-cache"),
    };
    run(npmLauncher.command, [...npmLauncher.prefix, "install", "--global", "--prefix", globalHostRoot, "--ignore-scripts", `${cliPackage}@${developmentVersion}`], globalScenarioRoot, globalEnvironment);
    const globalHostCli = globalHostEntry(globalHostRoot, globalHostRoot, process.platform);
    const globalVersion = run(process.execPath, [globalHostCli, "--version"], globalProjectRoot, globalEnvironment).stdout.trim();
    assertHostVersion("npm-global-current", globalVersion, developmentVersion);

    run(process.execPath, [globalHostCli, "init", "--defaults", "--agent-guidance", "skip", "--prefix", "accept"], globalProjectRoot, globalEnvironment);
    const globalTitle = "Packed global-host fixture";
    run(process.execPath, [globalHostCli, "create", "task", globalTitle, "--status", "open", "--create-mode", "progressive", "--parent", "none", "--sprint", "none", "--release", "none"], globalProjectRoot, globalEnvironment);
    run(process.execPath, [globalHostCli, "install", tarball, "--project"], globalProjectRoot, globalEnvironment);
    const globalExport = run(process.execPath, [globalHostCli, "standup", "export", "--format", "json"], globalProjectRoot, globalEnvironment);
    const globalItems = JSON.parse(run(process.execPath, [globalHostCli, ...COMPLETE_LIST_COMMAND_ARGUMENTS], globalProjectRoot, globalEnvironment).stdout) as { items: Array<{ id: string }> };
    verifyPackedProgress((args, expectedStatus) => run(process.execPath, [globalHostCli, ...args], globalProjectRoot, globalEnvironment, commandTimeoutMs, expectedStatus), globalItems.items[0].id, globalEnvironment.PM_PATH!);
    receipts.push({ ...globalReceipt(globalVersion, developmentVersion, globalExport), progress_verified: true, variance_verified: true, materialization_verified: true, window_verified: true });

    console.error("packed acceptance: bun-global-current");
    const bunRoot = join(temporaryRoot, "bun-global-current");
    const bunProject = join(bunRoot, "project");
    const bunGlobal = join(bunRoot, "global");
    const bunBin = join(bunRoot, "bin");
    mkdirSync(bunProject, { recursive: true });
    const bunEnvironment = { ...globalEnvironment, PM_PATH: join(bunProject, ".agents", "pm"),
      BUN_INSTALL_GLOBAL_DIR: bunGlobal, BUN_INSTALL_BIN: bunBin };
    run(launchers.bun, ["add", "--global", "--ignore-scripts", `${cliPackage}@${developmentVersion}`], bunProject, bunEnvironment);
    const bunHost = globalHostEntry(bunRoot, bunGlobal, process.platform);
    const invokeBun = (args: string[], expectedStatus?: number) => run(process.execPath, [bunHost, ...args], bunProject, bunEnvironment, commandTimeoutMs, expectedStatus);
    const bunVersion = invokeBun(["--version"]).stdout.trim();
    invokeBun(["init", "--defaults", "--agent-guidance", "skip", "--prefix", "accept"]);
    invokeBun(["create", "task", globalTitle, "--status", "open", "--create-mode", "progressive", "--parent", "none", "--sprint", "none", "--release", "none"]);
    invokeBun(["install", tarball, "--project"]);
    const bunExport = invokeBun(["standup", "export", "--format", "json"]);
    const bunItems = JSON.parse(invokeBun(COMPLETE_LIST_COMMAND_ARGUMENTS.slice()).stdout) as { items: Array<{ id: string }> };
    verifyPackedProgress(invokeBun, bunItems.items[0].id, bunEnvironment.PM_PATH);
    receipts.push({ ...globalReceipt(bunVersion, developmentVersion, bunExport), scenario: "bun-global-current", progress_verified: true, variance_verified: true, materialization_verified: true, window_verified: true });

    process.stdout.write(`${JSON.stringify({ ok: true, receipts })}\n`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (isMainInvocation(process.argv, import.meta.url)) {
  acceptPacked(repoRoot);
}
