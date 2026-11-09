import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("calendar annotation work keeps separate release provenance from the October pin policy", () => {
  const historical = readFileSync(new URL("../.agents/pm/issues/pm-slack-standup-6wvl.toon", import.meta.url), "utf8");
  const calendar = readFileSync(new URL("../.agents/pm/issues/pm-slack-standup-calendar-pins-195.toon", import.meta.url), "utf8");
  assert.match(historical, /^title: Check external action pin properties without freezing Dependabot revisions$/m);
  assert.match(historical, /^release: 2026\.10\.21$/m);
  assert.doesNotMatch(historical, /^acceptance_criteria: Calendar release/m);
  assert.match(calendar, /^title: Accept calendar annotations only on trusted reusable workflow job pins$/m);
  assert.doesNotMatch(calendar, /^release: 2026\.10\.21$/m);
  assert.ok(calendar.includes("gh:unbraind/pm-slack-standup#195"));
});
