import assert from "node:assert/strict";
import test from "node:test";
import { toUSVString } from "node:util";
import type { buildBlockKit, SlackSectionBlock, StandupOptions } from "../index.ts";

/** Register the same Unicode boundary contract for each real public renderer. */
export function registerUnicodeClippingTests(label: string, render: typeof buildBlockKit): void {
  for (const compact of [false, true]) {
    const opts: StandupOptions = {
      format: "blockkit", includeDone: true, groupBy: "status",
      sections: ["in_progress"], mentionMap: {}, splitYesterday: false,
      sectionLabels: {}, upNextCount: Infinity, compact,
    };
    /** Render the selected bucket and require the existing single-section layout. */
    const section = (title: string): string => {
      const blocks = render({
        wip: [{ id: "pm-emoji", title, status: "in_progress" }],
        blocked: [], done: [], upNext: [], total: 1,
      }, opts).blocks.filter((block) => block.type === "section");
      assert.equal(blocks.length, 1);
      return (blocks[0] as SlackSectionBlock).text.text;
    };
    const prefix = section("");
    const room = 2999 - prefix.length;
    const cases = [
      { name: "short Unicode", title: "Short 😀 title", expected: prefix + "Short 😀 title" },
      { name: "long ASCII", title: "a".repeat(3100), expected: prefix + "a".repeat(room) + "…" },
      { name: "non-BMP before cut", title: "a".repeat(room - 2) + "😀" + "b".repeat(100), expected: prefix + "a".repeat(room - 2) + "😀…" },
      { name: "non-BMP across cut", title: "a".repeat(room - 1) + "😀" + "b".repeat(100), expected: prefix + "a".repeat(room - 1) + "…" },
      { name: "non-BMP after cut", title: "a".repeat(room) + "𐐷" + "b".repeat(100), expected: prefix + "a".repeat(room) + "…" },
      { name: "Unicode exactly at ceiling", title: "a".repeat(room - 1) + "😀", expected: prefix + "a".repeat(room - 1) + "😀" },
      { name: "Unicode below ceiling", title: "a".repeat(room - 2) + "𐐷", expected: prefix + "a".repeat(room - 2) + "𐐷" },
    ];
    for (const scenario of cases) {
      test(`${label}: ${compact ? "compact" : "ordinary"} ${scenario.name}`, () => {
        assert.equal(toUSVString(scenario.title), scenario.title);
        const output = section(scenario.title);
        assert.equal(toUSVString(output), output);
        assert.ok(output.length <= 3000);
        assert.equal(output, scenario.expected);
      });
    }
  }
}
