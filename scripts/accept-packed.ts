import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { COMPLETE_LIST_COMMAND_ARGUMENTS } from "../index.ts";

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
}

const repoRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as PackageContract;
const cliPackage = "@unbrained/pm-cli";
const developmentVersion = packageJson.devDependencies[cliPackage];
const minimumMatch = packageJson.peerDependencies[cliPackage]?.match(/^>=\s*(\d+\.\d+\.\d+)$/u);
const minimumVersion = minimumMatch?.[1];
if (!developmentVersion || !/^\d+\.\d+\.\d+$/u.test(developmentVersion) || !minimumVersion) {
  throw new Error(`package.json must declare an exact development version and a >= exact minimum peer version for ${cliPackage}`);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
const bunxCommand = process.platform === "win32" ? "bunx.exe" : "bunx";
const npmCli = process.env.npm_execpath?.endsWith(".js") ? process.env.npm_execpath : undefined;
const npmLauncher = npmCli === undefined
  ? { command: npmCommand, prefix: [] as string[] }
  : { command: process.execPath, prefix: [npmCli] };
const npxLauncher = npmCli === undefined
  ? { command: npxCommand, prefix: [] as string[] }
  : { command: process.execPath, prefix: [resolve(dirname(npmCli), "npx-cli.js")] };
const cleanEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  npm_config_userconfig: devNull,
  NPM_CONFIG_USERCONFIG: devNull,
  PM_TELEMETRY_DISABLED: "1",
};
for (const key of Object.keys(cleanEnvironment)) {
  if (key.toLowerCase() === "npm_config_allow_scripts") delete cleanEnvironment[key];
}
/** Maximum time allowed for one install, pack, or pm subprocess. */
const commandTimeoutMs = 5 * 60 * 1000;

/** Run one shell-free command and fail with bounded diagnostics. */
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = cleanEnvironment): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: commandTimeoutMs,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(`${command} ${args.join(" ")} exceeded ${String(commandTimeoutMs)}ms and was terminated`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${String(result.status)}: ${(result.stderr || result.error?.message || result.stdout).trim()}`);
  }
  return result;
}

/** Invoke the scenario-local pm host through its user-facing launcher. */
function runPm(scenario: AcceptanceScenario, cwd: string, env: NodeJS.ProcessEnv, args: string[]): SpawnSyncReturns<string> {
  return scenario.manager === "npm"
    ? run(npxLauncher.command, [...npxLauncher.prefix, "--no-install", "pm", ...args], cwd, env)
    : run(bunxCommand, ["--no-install", "pm", ...args], cwd, env);
}

/** Invoke a host whose CLI is installed outside the tracker under test. */
function runNodePm(hostCli: string, cwd: string, env: NodeJS.ProcessEnv, args: string[]): SpawnSyncReturns<string> {
  return run(process.execPath, [hostCli, ...args], cwd, env);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "pm-slack-standup-packed-acceptance-"));
try {
  const packRoot = join(temporaryRoot, "pack");
  mkdirSync(packRoot);
  run(
    npmLauncher.command,
    [...npmLauncher.prefix, "pack", "--ignore-scripts", "--pack-destination", packRoot],
    repoRoot,
    { ...cleanEnvironment, npm_config_ignore_scripts: "true", NPM_CONFIG_IGNORE_SCRIPTS: "true" },
  );
  const packedNames = readdirSync(packRoot).filter((name) => name.endsWith(".tgz"));
  if (packedNames.length !== 1) {
    throw new Error(`npm pack must create exactly one tarball, got ${String(packedNames.length)}`);
  }
  const tarball = join(packRoot, packedNames[0]!);
  const scenarios: AcceptanceScenario[] = [
    { name: "npm-current", manager: "npm", hostVersion: developmentVersion },
    { name: "bun-current", manager: "bun", hostVersion: developmentVersion },
    { name: "npm-minimum", manager: "npm", hostVersion: minimumVersion },
    { name: "bun-minimum", manager: "bun", hostVersion: minimumVersion },
  ];
  const receipts: AcceptanceReceipt[] = [];

  for (const scenario of scenarios) {
    const scenarioRoot = join(temporaryRoot, scenario.name);
    const isolatedConfig = join(scenarioRoot, "xdg-config");
    const isolatedData = join(scenarioRoot, "xdg-data");
    mkdirSync(scenarioRoot);
    const scenarioEnvironment: NodeJS.ProcessEnv = {
      ...cleanEnvironment,
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
      run(bunCommand, ["init", "-y"], scenarioRoot, scenarioEnvironment);
      run(bunCommand, ["add", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot, scenarioEnvironment);
    }
    const actualVersion = runPm(scenario, scenarioRoot, scenarioEnvironment, ["--version"]).stdout.trim();
    if (actualVersion !== scenario.hostVersion) {
      throw new Error(`${scenario.name} resolved pm ${actualVersion}, expected ${scenario.hostVersion}`);
    }

    runPm(scenario, scenarioRoot, scenarioEnvironment, ["init", "--defaults", "--agent-guidance", "skip", "--prefix", "accept"]);
    const inProgressTitle = `Packed in progress ${scenario.name}`;
    const openTitle = `Packed up next ${scenario.name}`;
    runPm(scenario, scenarioRoot, scenarioEnvironment, ["create", "task", inProgressTitle, "--status", "in_progress", "--create-mode", "progressive"]);
    runPm(scenario, scenarioRoot, scenarioEnvironment, ["create", "task", openTitle, "--status", "open", "--create-mode", "progressive"]);
    runPm(scenario, scenarioRoot, scenarioEnvironment, ["install", tarball, "--project"]);
    const listed = JSON.parse(runPm(scenario, scenarioRoot, scenarioEnvironment, COMPLETE_LIST_COMMAND_ARGUMENTS.slice()).stdout) as Record<string, unknown>;
    const trackerItems = Array.isArray(listed.items) ? listed.items.length : -1;
    if (trackerItems !== 2 || listed.count !== trackerItems || listed.total !== trackerItems) {
      throw new Error(`${scenario.name} complete tracker receipt did not reconcile two created fixtures`);
    }
    const exported = runPm(scenario, scenarioRoot, scenarioEnvironment, ["standup", "export", "--format", "json"]);
    const document = JSON.parse(exported.stdout) as Record<string, unknown>;
    const sections = document.sections_data;
    if (sections === null || typeof sections !== "object" || Array.isArray(sections)) {
      throw new Error(`${scenario.name} standup export omitted sections_data`);
    }
    const rendered = Object.values(sections).flatMap((value) => Array.isArray(value) ? value : []);
    const titles = new Set(rendered.flatMap((value) => value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).title === "string"
      ? [(value as Record<string, unknown>).title as string]
      : []));
    if (!titles.has(inProgressTitle) || !titles.has(openTitle)) {
      throw new Error(`${scenario.name} complete standup omitted a real tracker fixture`);
    }
    if (rendered.length !== trackerItems) {
      throw new Error(`${scenario.name} rendered ${String(rendered.length)} items from a ${String(trackerItems)}-item tracker`);
    }
    if (/deprecated|list-all/iu.test(exported.stderr)) {
      throw new Error(`${scenario.name} emitted a deprecated-command diagnostic: ${exported.stderr.trim()}`);
    }
    receipts.push({
      scenario: scenario.name,
      host_version: actualVersion,
      tracker_items: trackerItems,
      rendered_items: rendered.length,
      stderr_bytes: Buffer.byteLength(exported.stderr),
      fixtures_present: true,
    });
  }

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
    PM_GLOBAL_PATH: join(globalScenarioRoot, "global-pm"),
    XDG_CONFIG_HOME: globalConfigRoot,
    XDG_DATA_HOME: globalDataRoot,
    npm_config_cache: join(globalScenarioRoot, "npm-cache"),
  };
  run(npmLauncher.command, [...npmLauncher.prefix, "install", "--prefix", globalHostRoot, "--ignore-scripts", `${cliPackage}@${developmentVersion}`], globalScenarioRoot, globalEnvironment);
  const globalHostCli = join(globalHostRoot, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  const globalVersion = runNodePm(globalHostCli, globalProjectRoot, globalEnvironment, ["--version"]).stdout.trim();
  if (globalVersion !== developmentVersion) {
    throw new Error(`npm-global-current resolved pm ${globalVersion}, expected ${developmentVersion}`);
  }
  runNodePm(globalHostCli, globalProjectRoot, globalEnvironment, ["init", "--defaults", "--agent-guidance", "skip", "--prefix", "accept"]);
  const globalTitle = "Packed global-host fixture";
  runNodePm(globalHostCli, globalProjectRoot, globalEnvironment, ["create", "task", globalTitle, "--status", "open", "--create-mode", "progressive"]);
  runNodePm(globalHostCli, globalProjectRoot, globalEnvironment, ["install", tarball, "--project"]);
  const globalExport = runNodePm(globalHostCli, globalProjectRoot, globalEnvironment, ["standup", "export", "--format", "json"]);
  const globalDocument = JSON.parse(globalExport.stdout) as Record<string, unknown>;
  const globalSections = globalDocument.sections_data;
  const globalRendered = globalSections !== null && typeof globalSections === "object" && !Array.isArray(globalSections)
    ? Object.values(globalSections).flatMap((value) => Array.isArray(value) ? value : [])
    : [];
  if (globalRendered.length !== 1 || !globalRendered.some((value) => value !== null && typeof value === "object"
    && (value as Record<string, unknown>).title === globalTitle)) {
    throw new Error("npm-global-current could not load the SDK-backed extension from a global host without project node_modules");
  }
  if (/deprecated|list-all/iu.test(globalExport.stderr)) {
    throw new Error(`npm-global-current emitted a deprecated-command diagnostic: ${globalExport.stderr.trim()}`);
  }
  receipts.push({
    scenario: "npm-global-current",
    host_version: globalVersion,
    tracker_items: 1,
    rendered_items: globalRendered.length,
    stderr_bytes: Buffer.byteLength(globalExport.stderr),
    fixtures_present: true,
  });

  process.stdout.write(`${JSON.stringify({ ok: true, receipts })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
