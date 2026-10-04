/** Behavior contracts for packed acceptance configuration, subprocesses and receipts. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  acceptanceEnvironment,
  acceptanceLaunchers,
  acceptanceVersions,
  acceptPacked,
  globalReceipt,
  packedTarball,
  run,
  scenarioReceipt,
} from "../scripts/accept-packed.ts";

const root = resolve(import.meta.dirname, "..");
const scenario = { name: "npm-current", manager: "npm", hostVersion: "2026.10.4" } as const;
const listed = { items: [{ title: "Doing" }, { title: "Next" }], count: 2, total: 2 };
const sections = { doing: [{ title: "Doing" }], next: [{ title: "Next" }] };

test("packed host contract rejects every missing or nonexact version input", () => {
  const contract = { devDependencies: { "@unbrained/pm-cli": "2026.10.4" }, peerDependencies: { "@unbrained/pm-cli": ">= 2026.8.20" } };
  assert.deepEqual(acceptanceVersions(contract), { developmentVersion: "2026.10.4", minimumVersion: "2026.8.20" });
  for (const development of [undefined, "", "latest", "^2026.10.4"]) {
    assert.throws(() => acceptanceVersions({ ...contract, devDependencies: development === undefined ? {} : { "@unbrained/pm-cli": development } }), /exact development version/);
  }
  for (const minimum of [undefined, "", "2026.8.20", ">=2026.8.20 <2027", "^2026.8.20"]) {
    assert.throws(() => acceptanceVersions({ ...contract, peerDependencies: minimum === undefined ? {} : { "@unbrained/pm-cli": minimum } }), /minimum peer version/);
  }
});

test("packed launch configuration selects Windows and POSIX tools with and without npm CLI", () => {
  for (const platform of ["linux", "win32"] as const) {
    const windows = platform === "win32";
    const node = windows ? "C:\\Node\\node.exe" : "/usr/bin/node";
    for (const npmPath of [undefined, "npm.cmd", windows ? "C:\\Node\\npm\\bin\\npm-cli.js" : "/usr/npm/bin/npm-cli.js"]) {
      const launchers = acceptanceLaunchers(platform, npmPath, node);
      const script = npmPath?.endsWith(".js") === true;
      assert.deepEqual(launchers.npm, { command: script ? node : windows ? "npm.cmd" : "npm", prefix: script ? [npmPath] : [] });
      assert.deepEqual(launchers.npx, { command: script ? node : windows ? "npx.cmd" : "npx", prefix: script ? [windows ? "C:\\Node\\npm\\bin\\npx-cli.js" : "/usr/npm/bin/npx-cli.js"] : [] });
      assert.equal(launchers.bun, windows ? "bun.exe" : "bun");
      assert.equal(launchers.bunx, windows ? "bunx.exe" : "bunx");
    }
  }
});

test("Windows npm PATH lookup launches real JavaScript entries when npm_execpath is unset", () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-npm-path-"));
  try {
    const bin = join(directory, "node_modules", "npm", "bin");
    mkdirSync(bin, { recursive: true });
    const body = "process.stdout.write(JSON.stringify(process.argv.slice(2)));";
    writeFileSync(join(bin, "npm-cli.js"), body);
    writeFileSync(join(bin, "npx-cli.js"), body);
    const launchers = acceptanceLaunchers("win32", undefined, process.execPath, `;${join(directory, "absent")};${directory};`);
    for (const launcher of [launchers.npm, launchers.npx]) {
      assert.equal(launcher.command, process.execPath);
      const args = ["literal & calc | whoami"];
      assert.deepEqual(JSON.parse(run(launcher.command, [...launcher.prefix, ...args], directory).stdout), args);
    }
    const pinned = acceptanceLaunchers("win32", join(bin, "npm-cli.js"), process.execPath, join(directory, "absent"));
    assert.deepEqual(pinned.npm, launchers.npm);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("packed environment strips case-insensitive tracker and script overrides without mutation", () => {
  const input = { PM_PATH: "/private", pm_GLOBAL_path: "/global", npm_CONFIG_allow_scripts: "all", NODE_V8_COVERAGE: "/coverage", PATH: "/tools", npm_config_userconfig: "/private/npmrc" };
  const clean = acceptanceEnvironment(input);
  assert.equal(clean.PM_PATH, undefined);
  assert.equal(clean.pm_GLOBAL_path, undefined);
  assert.equal(clean.npm_CONFIG_allow_scripts, undefined);
  assert.equal(clean.npm_config_userconfig, devNull);
  assert.equal(clean.NPM_CONFIG_USERCONFIG, devNull);
  assert.equal(clean.PM_TELEMETRY_DISABLED, "1");
  assert.equal(clean.NODE_V8_COVERAGE, "/coverage");
  assert.equal(clean.PATH, "/tools");
  assert.equal(input.PM_PATH, "/private");
});

test("packed tarball selection requires exactly one artifact and ignores other filenames", () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-pack-count-"));
  try {
    writeFileSync(join(directory, "README.txt"), "unrelated");
    assert.throws(() => packedTarball(directory), /exactly one tarball, got 0/);
    writeFileSync(join(directory, "package.tgz"), "fixture");
    assert.equal(packedTarball(directory), join(directory, "package.tgz"));
    writeFileSync(join(directory, "second.tgz"), "fixture");
    assert.throws(() => packedTarball(directory), /exactly one tarball, got 2/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("packed subprocess runner reports real output, exit failures, missing binaries, signals and deadlines", () => {
  const success = run(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"], root);
  assert.equal(success.stdout, "out");
  assert.equal(success.stderr, "err");
  for (const [body, diagnostic] of [
    ["process.stderr.write('stderr reason'); process.exit(7)", /status 7: stderr reason/],
    ["process.stdout.write('stdout reason'); process.exit(8)", /status 8: stdout reason/],
    ["process.exit(9)", /status 9: $/],
    ["process.kill(process.pid, 'SIGTERM')", /status null/],
  ] as const) assert.throws(() => run(process.execPath, ["-e", body], root), diagnostic);
  assert.throws(() => run(join(root, "absent-packed-tool"), [], root), /ENOENT/);
  assert.throws(() => run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], root, acceptanceEnvironment(process.env), 40), /exceeded 40ms and was terminated/);
});

test("scenario receipts reconcile host, tracker counts, titles, sections and diagnostics", () => {
  const exported = { stdout: JSON.stringify({ sections_data: sections }), stderr: "" };
  assert.deepEqual(scenarioReceipt(scenario, scenario.hostVersion, listed, exported, ["Doing", "Next"]), {
    scenario: "npm-current", host_version: "2026.10.4", tracker_items: 2, rendered_items: 2, stderr_bytes: 0, fixtures_present: true,
  });
  assert.throws(() => scenarioReceipt(scenario, "2026.9.28", listed, exported, ["Doing", "Next"]), /resolved pm .* expected/);
  for (const bad of [{ ...listed, items: null }, { ...listed, items: [] }, { ...listed, count: 1 }, { ...listed, total: 3 }]) {
    assert.throws(() => scenarioReceipt(scenario, scenario.hostVersion, bad, exported, ["Doing", "Next"]), /did not reconcile two created fixtures/);
  }
  for (const bad of [null, [], "bad", undefined]) {
    assert.throws(() => scenarioReceipt(scenario, scenario.hostVersion, listed, { stdout: JSON.stringify({ sections_data: bad }), stderr: "" }, ["Doing", "Next"]), /omitted sections_data/);
  }
  const varied = { ...sections, annotation: "skip", other: [null, 1, {}, { title: 1 }] };
  assert.throws(() => scenarioReceipt(scenario, scenario.hostVersion, listed, { stdout: JSON.stringify({ sections_data: varied }), stderr: "" }, ["Doing", "Next"]), /rendered 6 items from a 2-item tracker/);
  assert.throws(() => scenarioReceipt(scenario, scenario.hostVersion, listed, exported, ["Missing", "Next"]), /omitted a real tracker fixture/);
  assert.throws(() => scenarioReceipt(scenario, scenario.hostVersion, listed, exported, ["Doing", "Missing"]), /omitted a real tracker fixture/);
  for (const stderr of ["deprecated command", "list-all is obsolete"]) {
    assert.throws(() => scenarioReceipt(scenario, scenario.hostVersion, listed, { ...exported, stderr }, ["Doing", "Next"]), /deprecated-command diagnostic/);
  }
  assert.equal(scenarioReceipt(scenario, scenario.hostVersion, listed, { ...exported, stderr: "✓\n" }, ["Doing", "Next"]).stderr_bytes, 4);
  assert.throws(() => scenarioReceipt(scenario, scenario.hostVersion, listed, { stdout: "invalid json", stderr: "" }, ["Doing", "Next"]), SyntaxError);
});

test("global receipt demands one real fixture and refuses malformed exports or obsolete reads", () => {
  const exported = { stdout: JSON.stringify({ sections_data: { open: [{ title: "Packed global-host fixture" }], note: "skip" } }), stderr: "" };
  assert.deepEqual(globalReceipt("2026.10.4", "2026.10.4", exported), { scenario: "npm-global-current", host_version: "2026.10.4", tracker_items: 1, rendered_items: 1, stderr_bytes: 0, fixtures_present: true });
  assert.throws(() => globalReceipt("wrong", "2026.10.4", exported), /resolved pm wrong, expected/);
  for (const bad of [null, undefined, [], 1, {}, { open: [null] }, { open: [1] }, { open: [{ title: "wrong" }] }, { open: [{ title: "Packed global-host fixture" }, {}] }]) {
    assert.throws(() => globalReceipt("2026.10.4", "2026.10.4", { stdout: JSON.stringify({ sections_data: bad }), stderr: "" }), /could not load the SDK-backed extension/);
  }
  assert.throws(() => globalReceipt("2026.10.4", "2026.10.4", { ...exported, stderr: "list-all deprecated" }), /deprecated-command diagnostic/);
});

test("a real pack failure leaves no acceptance workspace behind", () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-invalid-pack-"));
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "invalid-pack-fixture", devDependencies: { "@unbrained/pm-cli": "2026.10.4" }, peerDependencies: { "@unbrained/pm-cli": ">=2026.8.20" } }));
    assert.throws(() => acceptPacked(directory, directory), /pack .* failed with status 1/u);
    assert.deepEqual(readdirSync(directory), ["package.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const direct of [false, true]) test(`packed acceptance completes npm/Bun matrices with npm_execpath ${direct ? "unset" : "inherited"}`, { timeout: 300_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-direct-node-"));
  const node = join(directory, process.platform === "win32" ? "node.exe" : "node");
  copyFileSync(process.execPath, node);
  const environment = { ...process.env };
  if (direct) delete environment.npm_execpath;
  try {
    const result = spawnSync(direct ? node : process.execPath, [join(root, "scripts", "accept-packed.ts")], {
      cwd: root, encoding: "utf8", env: environment, timeout: 290_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message || "packed acceptance did not exit successfully");
    const receipt = JSON.parse(result.stdout) as { ok: boolean; receipts: { scenario: string; tracker_items: number; rendered_items: number; fixtures_present: boolean; host_version: string }[] };
    assert.equal(receipt.ok, true);
    assert.deepEqual(receipt.receipts.map((entry) => entry.scenario), ["npm-current", "bun-current", "npm-minimum", "bun-minimum", "npm-global-current"]);
    const versions = acceptanceVersions(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
    for (const entry of receipt.receipts) {
      assert.equal(entry.fixtures_present, true);
      assert.equal(entry.rendered_items, entry.tracker_items);
      assert.equal(entry.tracker_items, entry.scenario === "npm-global-current" ? 1 : 2);
      assert.equal(entry.host_version, entry.scenario.endsWith("minimum") ? versions.minimumVersion : versions.developmentVersion);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
