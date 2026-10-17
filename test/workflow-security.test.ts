import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { isScalar, parseDocument, visit } from "yaml";

/** Owners whose external actions and reusable workflows may run here. */
const TRUSTED_OWNERS = new Set(["actions", "oven-sh", "github", "dependabot", "unbraind"]);

/** Offline tag observations validate annotations, never restrict future commits. */
const OBSERVED_VERSIONS = new Map<string, string>([
  ["actions/checkout@v7.0.1", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/setup-node@v7.0.0", "820762786026740c76f36085b0efc47a31fe5020"],
  ["actions/setup-node@v7.1.0", "949feb2413d6458794dcd2491c4babbbce0c15c1"],
  ["oven-sh/setup-bun@v2.2.0", "0c5077e51419868618aeaa5fe8019c62421857d6"],
]);

/** Check every parsed uses pair; local actions are allowed and Docker actions are refused. */
function assertActionPins(workflow: string): void {
  const document = parseDocument(workflow);
  assert.deepEqual(document.errors, [], "workflow must be valid YAML");
  visit(document, {
    Alias() { assert.fail("workflow aliases require a separate pin-policy review"); },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || pair.key.value !== "uses") return;
      const value = pair.value;
      assert.ok(isScalar(value) && typeof value.value === "string", "uses must contain one literal reference");
      assert.ok(["PLAIN", "QUOTE_DOUBLE", "QUOTE_SINGLE"].includes(value.type!), "uses must be a single-line scalar");
      const reference = value.value;
      if (reference.startsWith("./")) return;
      assert.ok(!reference.startsWith("docker://"), "Docker actions are not permitted by the action-pin policy");
      const pin = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)@([0-9a-f]{40})$/.exec(reference);
      assert.ok(pin, `${reference}: external actions require a full 40-hex commit SHA`);
      assert.ok(TRUSTED_OWNERS.has(pin[1]!), `${reference}: untrusted owner`);
      const version = value.comment?.trim();
      assert.match(version ?? "", /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, `${reference}: missing or malformed version comment`);
      assert.match(workflow.slice(value.range![1], value.range![2]), /^[ \t]+# v\d+\.\d+\.\d+[ \t]*(?:\r?\n)?$/, "version comment must be on the uses line with exactly one space after #");
      const observed = OBSERVED_VERSIONS.get(`${pin[1]}/${pin[2]}@${version}`);
      if (observed !== undefined) assert.equal(pin[3], observed, `${reference}: comment disagrees with observed tag`);
    },
  });
}

/** Validate a nonempty workflow inventory without requiring actions in each workflow. */
function assertWorkflowInventory(workflows: readonly string[]): void {
  assert.ok(workflows.length > 0, "workflow inventory must not be empty");
  for (const workflow of workflows) assertActionPins(workflow);
}

test("every external workflow action has an immutable pin and version annotation from a trusted owner", () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const workflows = readdirSync(directory).filter((file) => /\.ya?ml$/.test(file));
  assertWorkflowInventory(workflows.map((file) => readFileSync(new URL(file, directory), "utf8")));
});

test("workflow inventory accepts spaced uses keys with valid pins", () => {
  assertWorkflowInventory([`jobs:
  check:
    steps:
      - uses : actions/setup-node@${"a".repeat(40)} # v99.2.3
`]);
});

test("workflow inventory rejects quoted uses keys with mutable tag pins", () => {
  assert.throws(() => assertWorkflowInventory([`jobs:
  check:
    "uses": unbraind/example/.github/workflows/check.yml@v1.2.3 # v1.2.3
`]), /external actions require a full 40-hex commit SHA/);
});

test("workflow inventory accepts action-free workflows", () => {
  assertWorkflowInventory([`jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: echo ready
`]);
});

test("workflow inventory ignores uses text nested inside a with input", () => {
  assertWorkflowInventory([`jobs:
  check:
    steps:
      - uses : ./actions/local
        with:
          text: |
            uses: actions/setup-node@v7.1.0
            "uses": actions/setup-node@main
`]);
});

test("the pin gate accepts future commits without refreshing a commit allow-list", () => {
  assertActionPins(`- uses: actions/setup-node@${"a".repeat(40)} # v99.2.3`);
  assertActionPins(`uses: actions/setup-node@${"a".repeat(40)} # v99.2.3`);
  assertActionPins("- uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v99.2.3");
  assertActionPins('- uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1" # v7.1.0');
  assertActionPins("uses: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1' # v7.1.0");
  assertActionPins("- uses: ./actions/local");
});

test("the pin gate rejects malformed version-comment spacing and missing v prefixes", () => {
  for (const comment of ["#v7.1.0", "#  v7.1.0", "#    v7.1.0", "#\tv7.1.0", "# \tv7.1.0", "# 7.1.0"]) {
    assert.throws(() => assertActionPins(`- uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 ${comment}`), comment);
  }
});

test("the pin gate rejects mutable, undocumented and untrusted external references", () => {
  const sha = "a".repeat(40);
  for (const reference of [
    "actions/setup-node@v7.1.0 # v7.1.0",
    "actions/setup-node@main # v7.1.0",
    "actions/setup-node@abcdef0 # v7.1.0",
    `actions/setup-node@${sha}`,
    `unknown/setup-node@${sha} # v7.1.0`,
    `actions/setup-node@${sha} # v7`,
    `actions/setup-node@${sha} # v07.1.0`,
    "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.0.0",
    "docker://alpine:3.20",
    `docker://alpine@sha256:${"a".repeat(64)}`,
    "actions/setup-node", '"unterminated', "",
    `actions/setup-node@${"g".repeat(40)} # v7.1.0`,
    `${"actions/setup-node@" + sha} # v7.1.0 trailing`,
    `|\n    actions/setup-node@${sha} # v7.1.0`,
  ]) assert.throws(() => assertActionPins(`- uses: ${reference}`), reference);
  for (const body of [
    '- { uses: "actions/setup-node@main" }',
    '"uses": actions/setup-node@main # v7.1.0',
    '- uses: [actions/setup-node@main]',
    '- uses: null',
    `- uses: actions/setup-node@${sha}\n  # v7.1.0`,
    `- uses: &pin actions/setup-node@${sha} # v7.1.0\n- uses: *pin`,
    'uses: ./local\nuses: actions/setup-node@main',
  ]) assert.throws(() => assertActionPins(body), body);
});

test("read-only CI checkouts never persist repository credentials", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const checkoutSteps = workflow.split(/\n(?=\s*- name: Checkout\s*$)/m).slice(1);
  assert.equal(checkoutSteps.length, 2, "CI must keep both Linux and Windows checkout steps under this gate");
  for (const step of checkoutSteps) {
    const checkoutBlock = step.split(/\n(?=\s*- name: )/m, 1)[0]!;
    assert.match(
      checkoutBlock,
      /^\s*persist-credentials:\s*false\s*$/m,
      "every read-only CI checkout must disable persisted credentials",
    );
  }
});
