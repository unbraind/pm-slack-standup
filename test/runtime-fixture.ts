import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import https from "node:https";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { PmClient, listAllComplete } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { readCompleteStandupItems } from "../index.ts";
import type { PmItem } from "../index.ts";

/** A disposable initialized tracker, its actual SDK client, and activated package. */
export interface RuntimeFixture {
  directory: string;
  pmRoot: string;
  client: PmClient;
  harness: ExtensionTestHarness;
  items: PmItem[];
  envelope: Record<string, unknown>;
}

/** Initialize synthetic local PM data through the installed CLI and real SDK. */
export async function runtimeFixture(): Promise<RuntimeFixture> {
  const directory = mkdtempSync(join(tmpdir(), "standup-runtime-"));
  const pmRoot = join(directory, ".agents", "pm");
  try {
    execFileSync(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"),
      "--path", pmRoot, "--no-extensions", "init", "--defaults", "--prefix", "runtime", "--agent-guidance", "skip"], {
      cwd: directory, encoding: "utf8", env: { ...process.env, PM_AUTHOR: "runtime-fixture" },
    });
    const client = new PmClient({ pmRoot, cwd: directory, noExtensions: true, author: "runtime-fixture" });
    await client.create({ title: "Runtime parser integration", type: "Issue", status: "in_progress", assignee: "alice", body: "Complete synthetic body" });
    await client.create({ title: "Waiting for local fixture", type: "Task", status: "blocked", assignee: "bob" });
    await client.create({ title: "Next fixture release", type: "Feature", priority: 1 });
    await client.create({ title: "Second open candidate", type: "Chore", priority: 2 });
    const completed = await client.create({ title: "Finished synthetic work", type: "Task" });
    await client.close(completed.item.id, "Disposable runtime fixture completion");
    const envelope = await listAllComplete({}, { pmRoot, cwd: directory, noExtensions: true });
    const harness = await createExtensionTestHarness(extension, {
      name: "pm-slack-standup", capabilities: ["commands", "schema", "importers", "preflight", "services"],
    });
    assert.deepEqual(harness.activation.failed, []);
    return { directory, pmRoot, client, harness, items: readCompleteStandupItems(envelope), envelope: { ...envelope } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Dispatch the real registered handler and require the SDK's success receipt. */
export async function runtimeCommand(fixture: RuntimeFixture, command: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const receipt = await fixture.harness.runCommand({ command, pmRoot: fixture.pmRoot, options });
  assert.equal(receipt.handled, true);
  assert.deepEqual(receipt.warnings, []);
  assert.ok(receipt.result && typeof receipt.result === "object");
  return receipt.result as Record<string, unknown>;
}

/** Remove only the disposable tracker and release SDK activation resources. */
export async function removeRuntimeFixture(fixture: RuntimeFixture): Promise<void> {
  await fixture.harness.deactivate();
  rmSync(fixture.directory, { recursive: true, force: true });
}

/** An actual HTTPS webhook with synthetic routes and captured wire requests. */
export interface RuntimeWebhook {
  url: string;
  requests: Array<{ method?: string; path?: string; body: Record<string, unknown>; length?: string }>;
  stop: () => Promise<void>;
}

/** Serve verified local TLS; success, HTTP refusal, hang, and reset are real network events. */
export async function runtimeWebhook(directory: string): Promise<RuntimeWebhook> {
  const key = join(directory, "tls.key");
  const cert = join(directory, "tls.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  const requests: RuntimeWebhook["requests"] = [];
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.on("end", () => {
      requests.push({ method: req.method, path: req.url, body: JSON.parse(raw) as Record<string, unknown>, length: req.headers["content-length"] });
      if (req.url === "/hang") return;
      if (req.url === "/reset") { req.socket.destroy(); return; }
      res.writeHead(req.url === "/refuse" ? 503 : 200);
      res.write(req.url === "/refuse" ? "synthetic refusal" : "ok");
      res.end();
    });
  });
  const oldCa = https.globalAgent.options.ca;
  https.globalAgent.options.ca = readFileSync(cert);
  server.listen(0, "localhost");
  await once(server, "listening");
  return {
    url: `https://localhost:${(server.address() as AddressInfo).port}`,
    requests,
    /** Close every disposable socket and restore the process's original trust store. */
    stop: async () => {
      https.globalAgent.options.ca = oldCa;
      server.closeAllConnections();
      await new Promise<void>((resolveStop, rejectStop) => {
        server.close((error) => error ? rejectStop(error) : resolveStop());
      });
    },
  };
}

/** Capture the real process stream while preserving the command's observable stdout bytes. */
export function runtimeStdout(context: TestContext): string[] {
  const captured: string[] = [];
  context.mock.method(process.stdout, "write", (chunk: string | Uint8Array): boolean => {
    captured.push(chunk.toString());
    return true;
  });
  return captured;
}
