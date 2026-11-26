import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { isPair, isScalar, isSeq, parseDocument, visit } from "yaml";

/** Owners whose external actions and reusable workflows may run here. */
const TRUSTED_OWNERS = new Set(["actions", "oven-sh", "github", "dependabot", "unbraind"]);

/** Offline tag observations validate annotations, never restrict future commits. */
const OBSERVED_VERSIONS = new Map<string, string>([
  ["actions/checkout@v7.0.1", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/setup-node@v7.0.0", "820762786026740c76f36085b0efc47a31fe5020"],
  ["actions/setup-node@v7.1.0", "949feb2413d6458794dcd2491c4babbbce0c15c1"],
  ["oven-sh/setup-bun@v2.2.0", "0c5077e51419868618aeaa5fe8019c62421857d6"],
]);

/** Check action and reusable-workflow uses paths; local actions are allowed and Docker actions refused. */
function assertActionPins(workflow: string): void {
  const document = parseDocument(workflow);
  assert.deepEqual(document.errors, [], "workflow must be valid YAML");
  visit(document, {
    Alias() { assert.fail("workflow aliases require a separate pin-policy review"); },
    Pair(_key, pair, path) {
      if (!isScalar(pair.key) || pair.key.value !== "uses") return;
      const keys = path.filter(isPair).map(parent => isScalar(parent.key) ? parent.key.value : undefined);
      // Direct job mappings have two ancestor pairs; step mappings also pass through a sequence.
      const jobReference = path.length === 6 && keys.length === 2;
      const stepReference = path.length === 9 && keys.length === 3 && keys[2] === "steps" && isSeq(path.at(-2));
      if (keys[0] !== "jobs" || typeof keys[1] !== "string" || (!jobReference && !stepReference)) return;
      const value = pair.value;
      assert.ok(isScalar(value) && typeof value.value === "string", "uses must contain one literal reference");
      assert.ok(["PLAIN", "QUOTE_DOUBLE", "QUOTE_SINGLE"].includes(value.type!), "uses must be a single-line scalar");
      assert.doesNotMatch(workflow.slice(value.range![0], value.range![1]), /[\r\n]/, "uses must be a single-line scalar");
      const reference = value.value;
      if (reference.startsWith("./")) return;
      assert.ok(!reference.startsWith("docker://"), "Docker actions are not permitted by the action-pin policy");
      const pin = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)@([0-9a-f]{40})$/.exec(reference);
      assert.ok(pin, `${reference}: external actions require a full 40-hex commit SHA`);
      assert.ok(TRUSTED_OWNERS.has(pin[1]!), `${reference}: untrusted owner`);
      const version = value.comment?.trim();
      const semver = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
      const calendar = /^v[1-9]\d{3}\.(0?[1-9]|1[0-2])\.(0?[1-9]|[12]\d|3[01])$/;
      // The 2026.11.15 caller contract annotates pm-github reusable job references with
      // the owning package and its calendar release: "pm-github 2026.11.15".
      const packageCalendar = /^pm-github [1-9]\d{3}\.(0?[1-9]|1[0-2])\.(0?[1-9]|[12]\d|3[01])$/;
      const packageWorkflow = jobReference && pin[1] === "unbraind" && pin[2]!.startsWith("pm-github/.github/workflows/");
      assert.ok(semver.test(version ?? "") || (packageWorkflow && (calendar.test(version ?? "") || packageCalendar.test(version ?? ""))), `${reference}: missing or malformed version comment`);
      assert.match(workflow.slice(value.range![1], value.range![2]), /^[ \t]+# (?:v\d+\.\d+\.\d+|pm-github [1-9]\d{3}\.(?:0?[1-9]|1[0-2])\.(?:0?[1-9]|[12]\d|3[01]))[ \t]*(?:\r?\n)?$/, "version comment must be on the uses line with exactly one space after #");
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

test("trusted package workflows accept calendar tags in job references only", () => {
  const sha = "a".repeat(40);
  for (const tag of ["v2026.11.02", "v2026.01.09", "v2026.1.09"]) {
    assertReferenceFragment(`uses: unbraind/pm-github/.github/workflows/check.yml@${sha} # ${tag}`);
    assert.throws(() => assertReferenceFragment(`- uses: unbraind/pm-github/.github/workflows/check.yml@${sha} # ${tag}`), /missing or malformed version comment/);
  }
  // Unpadded annotations also match strict semver, which remains valid for steps.
  for (const prefix of ["uses:", "- uses:"]) {
    assertReferenceFragment(`${prefix} unbraind/pm-github/.github/workflows/check.yml@${sha} # v2026.11.2`);
  }
  // The 2026.11.15 caller contract: package-annotated calendar releases on job references.
  for (const annotation of ["pm-github 2026.11.15", "pm-github 2026.1.9"]) {
    assertReferenceFragment(`uses: unbraind/pm-github/.github/workflows/pm-github-sync.yml@${sha} # ${annotation}`);
    assert.throws(() => assertReferenceFragment(`- uses: unbraind/pm-github/.github/workflows/pm-github-sync.yml@${sha} # ${annotation}`), /missing or malformed version comment/);
  }
});

test("calendar annotations retain owner, package, pin and comment boundaries", () => {
  const sha = "a".repeat(40);
  for (const reference of [
    `actions/setup-node@${sha} # v2026.11.02`,
    `actions/pm-github/.github/workflows/check.yml@${sha} # v2026.11.02`,
    `unbraind/other/.github/workflows/check.yml@${sha} # v2026.11.02`,
    "unbraind/pm-github/.github/workflows/check.yml@main # v2026.11.02",
    `unbraind/pm-github/.github/workflows/check.yml@${sha} # v2026.00.02`,
    `unbraind/pm-github/.github/workflows/check.yml@${sha} # v2026.13.02`,
    `unbraind/pm-github/.github/workflows/check.yml@${sha} # v2026.11.00`,
    `unbraind/pm-github/.github/workflows/check.yml@${sha} # v2026.11.032`,
    `unbraind/pm-github/.github/workflows/check.yml@${sha} #  v2026.11.02`,
    `unbraind/pm-github/.github/workflows/check.yml@${sha} # v2026.11.02 trailing`,
    `unbraind/pm-github/.github/workflows/check.yml@${sha} # pm-github v2026.11.02`,
    `unbraind/pm-github/.github/workflows/check.yml@${sha} # pm-github 2026.11.02 trailing`,
    `unbraind/pm-github/.github/workflows/check.yml@${sha} # pm-changelog 2026.11.02`,
    `unbraind/pm-github/.github/workflows/check.yml@${sha} # pm-github 2026.13.02`,
    `unbraind/pm-github/.github/workflows/check.yml@${sha} # pm-github 2026.11.00`,
    `unbraind/pm-github/.github/workflows/check.yml@${sha} # pm-github 2026.11.032`,
  ]) assert.throws(() => assertReferenceFragment(`uses: ${reference}`), reference);
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

/** Embed hostile reference fragments in actual job or step locations before validation. */
function assertReferenceFragment(source: string): void {
  const prefix = source.startsWith("-") ? "jobs:\n  check:\n    steps:\n" : "jobs:\n  check:\n";
  const indent = source.startsWith("-") ? "      " : "    ";
  assertActionPins(prefix + source.split("\n").map(line => indent + line).join("\n"));
}

test("the pin gate accepts future commits without refreshing a commit allow-list", () => {
  assertReferenceFragment(`- uses: actions/setup-node@${"a".repeat(40)} # v99.2.3`);
  assertReferenceFragment(`uses: actions/setup-node@${"a".repeat(40)} # v99.2.3`);
  assertReferenceFragment("- uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v99.2.3");
  assertReferenceFragment('- uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1" # v7.1.0');
  assertReferenceFragment("uses: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1' # v7.1.0");
  assertReferenceFragment("- uses: ./actions/local");
});

test("the pin gate rejects malformed version-comment spacing and missing v prefixes", () => {
  for (const comment of ["#v7.1.0", "#  v7.1.0", "#    v7.1.0", "#\tv7.1.0", "# \tv7.1.0", "# 7.1.0"]) {
    assert.throws(() => assertReferenceFragment(`- uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 ${comment}`), comment);
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
  ]) assert.throws(() => assertReferenceFragment(`- uses: ${reference}`), reference);
  for (const body of [
    '- { uses: "actions/setup-node@main" }',
    '"uses": actions/setup-node@main # v7.1.0',
    '- uses: [actions/setup-node@main]',
    '- uses: null',
    `- uses: actions/setup-node@${sha}\n  # v7.1.0`,
    `- uses: &pin actions/setup-node@${sha} # v7.1.0\n- uses: *pin`,
    'uses: ./local\nuses: actions/setup-node@main',
  ]) assert.throws(() => assertReferenceFragment(body), body);
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


test("pin policy ignores ordinary inputs named uses at job and step scope", () => {
  assertActionPins(`jobs:
  reusable:
    uses: unbraind/example/.github/workflows/check.yml@${"a".repeat(40)} # v99.2.3
    with:
      uses: ordinary job input
  check:
    env:
      uses: ordinary environment value
    steps:
      - uses: ./actions/local
        with:
          uses: ordinary step input
      - run: echo ready
        env:
          uses: ordinary step environment
`);
});

test("pin policy rejects escaped multiline source references before local or SHA acceptance", () => {
  for (const reference of [`actions/setup-node@${"a".repeat(40)}`, "./actions/local"]) {
    for (const newline of ["\n", "\r\n"]) {
      const split = reference.length - 4;
      const scalar = '"' + reference.slice(0, split) + "\\" + newline + "          " + reference.slice(split) + '" # v99.2.3';
      assert.throws(() => assertActionPins(`jobs:
  check:
    steps:
      - uses: ${scalar}
`), /uses must be a single-line scalar/);
    }
  }
});


test("quick and deep tiers retain exact runtime floors and runner contracts", () => {
  const ci = parseDocument(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")).toJS();
  const deep = parseDocument(readFileSync(new URL("../.github/workflows/ci-deep.yml", import.meta.url), "utf8")).toJS();
  assert.deepEqual(ci.jobs.test.strategy.matrix["node-version"], ["22.18.0", 26]);
  assert.equal(ci.jobs.test["runs-on"], "ubuntu-latest");
  assert.equal(ci.jobs["windows-acceptance-launcher"]["runs-on"], "windows-latest");
  for (const job of Object.values(ci.jobs) as Record<string, unknown>[]) assert.ok(Number(job["timeout-minutes"]) <= 30);
  assert.equal(ci.on.push, undefined);
  assert.deepEqual(deep.jobs.deep.strategy.matrix, { "node-version": ["22.18.0", 26], "package-manager": ["npm", "bun"] });
  assert.match(deep.jobs.deep["runs-on"], /PM_LOCAL_DEEP.*self-hosted.*pm-local.*ubuntu-latest/);
  assert.equal(deep.jobs.deep["timeout-minutes"], 120);
  const checkout = deep.jobs.deep.steps.find((step: { name: string }) => step.name === "Checkout");
  assert.equal(checkout.with["persist-credentials"], false);
});


// The callers pin one full commit with its release comment. This test used to assert one literal commit, which made
// every Dependabot bump of the callers fail CI; the gated sync then ran an extension older than the installed pm CLI.
test("pm-github callers share one pinned release without a version override, and Dependabot moves them together", () => {
  const pins = ["sync", "closeout"].map(name => {
    const source = readFileSync(new URL(`../.github/workflows/pm-github-${name}.yml`, import.meta.url), "utf8");
    const workflow = parseDocument(source).toJS();
    const job = workflow.jobs[`gated-${name}`];
    const revision = new RegExp(`^unbraind/pm-github/\\.github/workflows/pm-github-${name}\\.yml@([0-9a-f]{40})$`).exec(job.uses)?.[1];
    assert.ok(revision, `${name} must pin a full commit`);
    const line = source.split("\n").find(candidate => /^\s*uses:/.test(candidate) && candidate.includes(job.uses)) ?? "";
    const parts = /# pm-github (\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?\s*$/.exec(line);
    assert.ok(parts, `the ${name} pin must carry its release comment on the same line`);
    const pinnedRelease = parts[0];
    // 2026.11.25 is the first pm-github release whose gated import works with the pm CLI this package installs.
    const [year, month, day] = parts.slice(1, 4).map(Number);
    assert.ok(year * 10_000 + month * 100 + day >= 2026_11_25, `${name} must not pin a release older than 2026.11.25`);
    assert.equal(job.with?.["pm-github-version"], undefined);
    assert.equal(job["runs-on"], undefined);
    return `${revision} ${pinnedRelease}`;
  });
  assert.equal(pins[0], pins[1], "sync and closeout must use one reviewed release");
  const updates = parseDocument(readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8")).toJS().updates as { "package-ecosystem": string; groups?: Record<string, { patterns?: string[] }> }[];
  const actions = updates.filter(update => update["package-ecosystem"] === "github-actions");
  assert.equal(actions.length, 1, "one github-actions update entry");
  assert.deepEqual(actions[0].groups?.["pm-github-workflows"]?.patterns, ["unbraind/pm-github/*"]);
  const release = parseDocument(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")).toJS().jobs.release;
  assert.match(release.uses, /^unbraind\/pm-ops\/\.github\/workflows\/daily-release\.yml@[a-f0-9]{40}$/);
  assert.equal(release["runs-on"], undefined);
  assert.equal(release.permissions["id-token"], "write");
});
