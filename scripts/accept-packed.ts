import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve, posix, win32 } from "node:path";

import { COMPLETE_LIST_COMMAND_ARGUMENTS } from "../index.ts";
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
    if (["npm_config_allow_scripts", "pm_path", "pm_global_path"].includes(key.toLowerCase())) {
      delete environment[key];
    }
  }
  return environment;
}

const cleanEnvironment = acceptanceEnvironment(process.env);
/** Maximum time allowed for one install, pack, or pm subprocess. */
const commandTimeoutMs = 5 * 60 * 1000;

/** Run one shell-free command and fail with bounded diagnostics. */
export function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = cleanEnvironment, timeoutMs = commandTimeoutMs): SpawnSyncReturns<string> {
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
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${String(result.status)}: ${(result.stderr || result.error?.message || result.stdout).trim()}`);
  }
  return result;
}

/** Invoke the scenario-local pm host through its user-facing launcher. */
function runPm(launchers: AcceptanceLaunchers, scenario: AcceptanceScenario, cwd: string, env: NodeJS.ProcessEnv, args: string[]): SpawnSyncReturns<string> {
  return scenario.manager === "npm"
    ? run(launchers.npx.command, [...launchers.npx.prefix, "--no-install", "pm", ...args], cwd, env)
    : run(launchers.bunx, ["--no-install", "pm", ...args], cwd, env);
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

/** Pack once, exercise all real npm/Bun hosts, emit reconciled receipts, and remove fixtures. */
export function acceptPacked(root: string, temporaryParent = tmpdir()): void {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as PackageContract;
  const { developmentVersion, minimumVersion } = acceptanceVersions(packageJson);
  const launchers = acceptanceLaunchers(process.platform, process.env.npm_execpath, process.execPath, process.env.PATH);
  const npmLauncher = launchers.npm;
  const temporaryRoot = mkdtempSync(join(temporaryParent, "pm-slack-standup-packed-acceptance-"));
  try {
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
      runPm(launchers, scenario, scenarioRoot, scenarioEnvironment, ["create", "task", inProgressTitle, "--status", "in_progress", "--create-mode", "progressive"]);
      runPm(launchers, scenario, scenarioRoot, scenarioEnvironment, ["create", "task", openTitle, "--status", "open", "--create-mode", "progressive"]);
      runPm(launchers, scenario, scenarioRoot, scenarioEnvironment, ["install", tarball, "--project"]);
      const listed = JSON.parse(runPm(launchers, scenario, scenarioRoot, scenarioEnvironment, COMPLETE_LIST_COMMAND_ARGUMENTS.slice()).stdout) as Record<string, unknown>;
      const exported = runPm(launchers, scenario, scenarioRoot, scenarioEnvironment, ["standup", "export", "--format", "json"]);
      receipts.push(scenarioReceipt(scenario, actualVersion, listed, exported, [inProgressTitle, openTitle]));
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
      PM_PATH: join(globalProjectRoot, ".agents", "pm"),
      PM_GLOBAL_PATH: join(globalScenarioRoot, "global-pm"),
      XDG_CONFIG_HOME: globalConfigRoot,
      XDG_DATA_HOME: globalDataRoot,
      npm_config_cache: join(globalScenarioRoot, "npm-cache"),
    };
    run(npmLauncher.command, [...npmLauncher.prefix, "install", "--prefix", globalHostRoot, "--ignore-scripts", `${cliPackage}@${developmentVersion}`], globalScenarioRoot, globalEnvironment);
    const globalHostCli = join(globalHostRoot, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
    const globalVersion = run(process.execPath, [globalHostCli, "--version"], globalProjectRoot, globalEnvironment).stdout.trim();
    assertHostVersion("npm-global-current", globalVersion, developmentVersion);

    run(process.execPath, [globalHostCli, "init", "--defaults", "--agent-guidance", "skip", "--prefix", "accept"], globalProjectRoot, globalEnvironment);
    const globalTitle = "Packed global-host fixture";
    run(process.execPath, [globalHostCli, "create", "task", globalTitle, "--status", "open", "--create-mode", "progressive"], globalProjectRoot, globalEnvironment);
    run(process.execPath, [globalHostCli, "install", tarball, "--project"], globalProjectRoot, globalEnvironment);
    const globalExport = run(process.execPath, [globalHostCli, "standup", "export", "--format", "json"], globalProjectRoot, globalEnvironment);
    receipts.push(globalReceipt(globalVersion, developmentVersion, globalExport));

    process.stdout.write(`${JSON.stringify({ ok: true, receipts })}\n`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (isMainInvocation(process.argv, import.meta.url)) {
  acceptPacked(repoRoot);
}
