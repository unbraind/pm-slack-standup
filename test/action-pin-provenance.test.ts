import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/** Folders that hold tracked item documents rather than runtime tracker state. */
const ITEM_FOLDERS = ["chores", "decisions", "features", "issues", "tasks"] as const;

/** One tracked item document with the header fields the changelog gates read. */
interface TrackedItem {
  id: string;
  status: string;
  release: string;
  closeReason: string;
  provenanceTags: string[];
}

/** Read every tracked item document and parse its header fields. */
function readTrackedItems(): TrackedItem[] {
  const root = new URL("../.agents/pm/", import.meta.url);
  return ITEM_FOLDERS.flatMap((folder) =>
    readdirSync(new URL(`${folder}/`, root))
      .filter((file) => /\.toon$/.test(file))
      .map((file) => {
        const text = readFileSync(new URL(`${folder}/${file}`, root), "utf8");
        const field = (name: string): string =>
          new RegExp(`^${name}(?:\\[\\d+\\])?: (.*)$`, "m").exec(text)?.[1]?.trim().replace(/^"|"$/g, "") ?? "";
        return {
          id: file.replace(/\.toon$/, ""),
          status: field("status"),
          release: field("release"),
          closeReason: field("close_reason"),
          provenanceTags: [...(field("tags").matchAll(/gh:[A-Za-z0-9_./-]+#\d+/g))].map((match) => match[0]),
        };
      }));
}

/** Map each changelog release heading to the section text below it. */
function readChangelogSections(): Map<string, string> {
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const headings = [...changelog.matchAll(/^## (\S+) - \S+.*$/gm)];
  const sections = new Map<string, string>();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    const end = index + 1 < headings.length ? headings[index + 1]!.index! : changelog.length;
    sections.set(heading[1]!, changelog.slice(heading.index! + heading[0].length, end));
  }
  return sections;
}

test("calendar annotation work keeps separate release provenance from the October pin policy", () => {
  const historical = readFileSync(new URL("../.agents/pm/issues/pm-slack-standup-6wvl.toon", import.meta.url), "utf8");
  const calendar = readFileSync(new URL("../.agents/pm/issues/pm-slack-standup-calendar-pins-195.toon", import.meta.url), "utf8");
  assert.match(historical, /^title: Check external action pin properties without freezing Dependabot revisions$/m);
  assert.match(historical, /^release: 2026\.10\.21$/m);
  assert.match(historical, /^status: closed$/m);
  assert.doesNotMatch(historical, /^acceptance_criteria: Calendar release/m);
  assert.ok(
    readChangelogSections().get("2026.10.21")?.includes("[pm-slack-standup-6wvl]("),
    "the delivered October action-pin entry must stay generated under 2026.10.21",
  );
  assert.match(calendar, /^title: Accept calendar annotations only on trusted reusable workflow job pins$/m);
  assert.doesNotMatch(calendar, /^release: 2026\.10\.21$/m);
  const items = new Map(readTrackedItems().map((item) => [item.id, item]));
  assert.deepEqual(items.get("pm-slack-standup-calendar-pins-195")?.provenanceTags, [
    "gh:unbraind/pm-slack-standup#191",
    "gh:unbraind/pm-slack-standup#192",
    "gh:unbraind/pm-slack-standup#195",
  ]);
  assert.deepEqual(items.get("pm-slack-standup-6wvl")?.provenanceTags, []);
});

test("each GitHub provenance tag stays on exactly one tracked item", () => {
  const holdersByTag = new Map<string, string[]>();
  for (const item of readTrackedItems()) {
    for (const tag of item.provenanceTags) {
      const holders = holdersByTag.get(tag) ?? [];
      holders.push(item.id);
      holdersByTag.set(tag, holders);
    }
  }
  assert.ok(holdersByTag.size > 0, "the tracker must keep GitHub provenance tags");
  for (const [tag, holders] of holdersByTag) {
    assert.equal(holders.length, 1, `${tag} must tag exactly one item, found ${holders.join(", ")}`);
  }
});

test("every closed delivered item keeps its changelog entry under its declared release", () => {
  const sections = readChangelogSections();
  for (const item of readTrackedItems()) {
    if (item.status !== "closed" || !item.release || item.closeReason.startsWith("duplicate of")) continue;
    // Release values naming no section (future, next, or pre-tag history) ship no generated section.
    const section = sections.get(item.release);
    if (section === undefined) continue;
    assert.ok(section.includes(`[${item.id}](`), `${item.id} must stay listed under ${item.release}`);
  }
});
