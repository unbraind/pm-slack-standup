import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, readdirSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("documented decision verification works in a source copy without dist", () => {
  const directory = mkdtempSync(join(tmpdir(), "standup-decision-guide-"));
  try {
    for (const path of [...readdirSync(resolve(".")).filter((entry) => entry.endsWith(".ts")), "tsconfig.json", "tsconfig.test.json", "package.json",
      "package-lock.json", "manifest.json", "README.md", "CHANGELOG.md", ".gitignore", "docs", "scripts", "test"]) {
      cpSync(resolve(path), join(directory, path), { recursive: true });
    }
    symlinkSync(resolve("node_modules"), join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(existsSync(join(directory, "dist")), false);
    const guide = readFileSync(join(directory, "docs", "decision-requests-validation.md"), "utf8");
    const recipe = guide.match(/Targeted verification:\s+```sh\n([\s\S]*?)\n```/u);
    assert.ok(recipe, "the standalone validation recipe must be executable");
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: directory, NODE_V8_COVERAGE: "" };
    delete env.NODE_TEST_CONTEXT;
    for (const line of recipe[1].trim().split("\n")) {
      const [command, ...args] = line.trim().split(/\s+/u);
      const output = execFileSync(command === "node" ? process.execPath : command, args, {
        cwd: directory, encoding: "utf8", shell: process.platform === "win32", timeout: 120_000,
        env,
      });
      if (command === "node") {
        assert.match(output, /(?:ℹ|#) tests [1-9]\d*\b/u, "standalone tests must actually execute");
        assert.match(output, /(?:ℹ|#) fail 0\b/u);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
