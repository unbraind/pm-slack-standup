import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { toUSVString } from "node:util";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { buildBlockKit, readCompleteStandupItems } from "../index.ts";
import type { SlackSectionBlock } from "../index.ts";
import { acceptanceEnvironment, acceptanceLaunchers, packedTarball, run } from "../scripts/accept-packed.ts";
import { runtimeFixture, runtimeCommand, removeRuntimeFixture } from "./runtime-fixture.ts";
import { registerUnicodeClippingTests } from "./unicode-clipping-contract.ts";

registerUnicodeClippingTests("source", buildBlockKit);

/** Keep generated-artifact counters separate from the authored-source coverage inventory. */
function consumerEnvironment(): NodeJS.ProcessEnv {
  const env = acceptanceEnvironment(process.env);
  delete env.NODE_TEST_CONTEXT;
  // Node propagates the parent's counters when this key is absent; an empty value disables them.
  env.NODE_V8_COVERAGE = "";
  return env;
}

/** Require every contract case to execute and pass in the real consumer process. */
function assertConsumerReceipt(stdout: string): void {
  assert.match(stdout, /# tests 14\b/u);
  assert.match(stdout, /# pass 14\b/u);
  assert.match(stdout, /# fail 0\b/u);
}

test("built public entry preserves the full Unicode clipping contract", () => {
  const receipt = run(process.execPath, ["--test", "--test-reporter=tap", "test/unicode-clipping-public.consumer.ts"],
    resolve(import.meta.dirname, ".."), consumerEnvironment());
  assertConsumerReceipt(receipt.stdout);
});

test("Unicode clipping survives real tracker reads and ordinary/compact command rendering", async () => {
  const fixture = await runtimeFixture();
  try {
    const title = "a".repeat(3100) + "😀";
    const created = await fixture.client.create({ title, type: "Issue", status: "in_progress", assignee: "unicode-fixture" });
    const envelope = await listAllComplete({}, { pmRoot: fixture.pmRoot, cwd: fixture.directory, noExtensions: true });
    assert.equal(readCompleteStandupItems(envelope).find((item) => item.id === created.item.id)?.title, title);
    for (const compact of [false, true]) {
      const options = { format: "json", sections: "in_progress", team: "unicode-fixture", compact };
      const initial = await runtimeCommand(fixture, "standup export", options);
      const original = JSON.parse(String(initial.output)) as { slack: ReturnType<typeof buildBlockKit> };
      const section = original.slack.blocks.find((block) => block.type === "section");
      assert.ok(section && section.type === "section");
      const prefix = (section as SlackSectionBlock).text.text.indexOf("aaaa");
      assert.ok(prefix > 0);
      await fixture.client.update(created.item.id, { title: "a".repeat(2998 - prefix) + "😀" + "b".repeat(100) });
      const clipped = await runtimeCommand(fixture, "standup export", options);
      const payload = JSON.parse(String(clipped.output)) as { slack: ReturnType<typeof buildBlockKit> };
      const sections = payload.slack.blocks.filter((block) => block.type === "section");
      assert.equal(sections.length, 1);
      const text = (sections[0] as SlackSectionBlock).text.text;
      assert.equal(toUSVString(text), text);
      assert.equal(text.length, 2999);
      assert.ok(text.endsWith("a…"));
    }
  } finally { await removeRuntimeFixture(fixture); }
});

test("npm tarball public entry preserves the full Unicode clipping contract", () => {
  const root = resolve(import.meta.dirname, "..");
  const directory = mkdtempSync(join(tmpdir(), "standup-unicode-packed-"));
  const env = consumerEnvironment();
  const npm = acceptanceLaunchers(process.platform, process.env.npm_execpath, process.execPath, process.env.PATH).npm;
  const contract = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
  try {
    const pack = join(directory, "pack");
    mkdirSync(pack);
    run(npm.command, [...npm.prefix, "pack", "--ignore-scripts", "--pack-destination", pack], root, env);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "unicode-consumer", private: true, type: "module" }));
    run(npm.command, [...npm.prefix, "install", "--ignore-scripts", "--no-audit", "--no-fund",
      `@unbrained/pm-cli@${contract.devDependencies["@unbrained/pm-cli"]}`, packedTarball(pack)], directory, env);
    const installed = join(directory, "node_modules", "pm-slack-standup");
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { main: string };
    assert.equal(manifest.main, "dist/index.js");
    const tests = join(directory, "test");
    mkdirSync(tests);
    copyFileSync(join(root, "test", "unicode-clipping-contract.ts"), join(tests, "unicode-clipping-contract.ts"));
    writeFileSync(join(tests, "unicode-clipping-public.consumer.ts"),
      readFileSync(join(root, "test", "unicode-clipping-public.consumer.ts"), "utf8").replace("../dist/index.js", "pm-slack-standup"));
    const receipt = run(process.execPath, ["--test", "--test-reporter=tap", join(tests, "unicode-clipping-public.consumer.ts")], directory, env);
    assertConsumerReceipt(receipt.stdout);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
