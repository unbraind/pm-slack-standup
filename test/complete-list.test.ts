import assert from "node:assert/strict";
import test from "node:test";

import { COMPLETE_LIST_COMMAND_ARGUMENTS, readCompleteStandupItems } from "../index.ts";
import { completeListEnvelope as completeEnvelope } from "./complete-list-fixture.ts";

test("the standup reader declares one exact canonical complete-list argv", () => {
  assert.deepEqual(COMPLETE_LIST_COMMAND_ARGUMENTS, [
    "list", "--all", "--json", "--include-body", "--strict-read", "--no-truncate",
    "--output-budget", "unbounded", "--output-limit", "unbounded", "--output-include", "full",
  ]);
});

test("a complete canonical standup envelope is decoded", () => {
  assert.deepEqual(readCompleteStandupItems(completeEnvelope()), [
    { id: "fixture-1", title: "Fixture", status: "open", tags: ["agent"] },
  ]);
});

test("shared SDK policy rejects malformed corpus, paging, projection, count, and identity evidence", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["bare array", [], /invalid_envelope/],
    ["null", null, /invalid_envelope/],
    ["non-array items", completeEnvelope({ items: {} }), /invalid_envelope/],
    ["truncated", completeEnvelope({ truncated: true }), /page_incomplete/],
    ["paginated", completeEnvelope({ has_more: true }), /page_incomplete/],
    ["cursor", completeEnvelope({ next_cursor: "more" }), /page_incomplete/],
    ["partial source", completeEnvelope({ completeness: { status: "partial", unreadable_item_count: 1, unreadable_directory_count: 0 } }), /source_incomplete/],
    ["missing source", (() => { const value = completeEnvelope(); delete value.completeness; return value; })(), /source_unchecked/],
    ["filtered", completeEnvelope({ filters: { status: "open", include_body: true, no_truncate: true, strict_read: true } }), /filtered_corpus/],
    ["not strict", completeEnvelope({ filters: { status: "all", include_body: true, no_truncate: true, strict_read: false } }), /strict_read_unproven/],
    ["compact", completeEnvelope({ projection: { mode: "brief", fields: ["id"] } }), /projection_incomplete/],
    ["count mismatch", completeEnvelope({ count: 2, total: 2 }), /count_mismatch/],
    ["duplicate id", completeEnvelope({ items: [{ id: "same", title: "A", status: "open" }, { id: "same", title: "B", status: "open" }], count: 2, total: 2 }), /duplicate_item_id/],
    ["empty id", completeEnvelope({ items: [{ id: " ", title: "A", status: "open" }] }), /invalid_item_id/],
  ];
  for (const [name, value, pattern] of cases) assert.throws(() => readCompleteStandupItems(value), pattern, name);
});

test("supplemental policy rejects every pm-cli 2026.8.21 SDK receipt gap", () => {
  const readOutput = completeEnvelope().read_output as Record<string, unknown>;
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["unreadable item", completeEnvelope({ completeness: { status: "complete", unreadable_item_count: 1, unreadable_directory_count: 0 } }), /unreadable_item_count=1/],
    ["unreadable directory", completeEnvelope({ completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 1 } }), /unreadable_directory_count=1/],
    ["missing omission", (() => { const value = completeEnvelope(); delete value.omission_receipt; return value; })(), /omission_receipt=<missing>/],
    ["omission count", completeEnvelope({ omission_receipt: { has_omissions: false, omitted_field_group_count: 1, omitted_field_groups: [] } }), /omitted_field_group_count=1/],
    ["omission rows", completeEnvelope({ omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: ["body"] } }), /omitted_field_groups=\["body"\]/],
    ["missing read", (() => { const value = completeEnvelope(); delete value.read_output; return value; })(), /read_output=<missing>/],
    ["wrong read type", completeEnvelope({ read_output: "bad" }), /read_output="bad"/],
    ["unknown contract", completeEnvelope({ read_output: { ...readOutput, contract_version: 2 } }), /contract_version=2/],
    ["wrong command", completeEnvelope({ read_output: { ...readOutput, command: "list-all" } }), /command="list-all"/],
    ["strings compacted", completeEnvelope({ read_output: { ...readOutput, strings_compacted: true } }), /strings_compacted=true/],
    ["rows compacted", completeEnvelope({ read_output: { ...readOutput, rows_compacted: true } }), /rows_compacted=true/],
    ["result omitted", completeEnvelope({ read_output: { ...readOutput, result_omitted: true } }), /result_omitted=true/],
    ["outside budget", completeEnvelope({ read_output: { ...readOutput, within_budget: false } }), /within_budget=false/],
    ["missing dimensions", completeEnvelope({ read_output: (() => { const value = { ...readOutput }; delete value.requested_dimensions; return value; })() }), /requested_dimensions=<missing>/],
    ["wrong dimensions", completeEnvelope({ read_output: { ...readOutput, requested_dimensions: "amount,cost" } }), /requested_dimensions="amount,cost"/],
    ["missing include", completeEnvelope({ read_output: { ...readOutput, requested_dimensions: ["amount", "cost"] } }), /missing include/],
    ["missing amount", completeEnvelope({ read_output: { ...readOutput, requested_dimensions: ["include", "cost"] } }), /missing amount/],
    ["missing cost", completeEnvelope({ read_output: { ...readOutput, requested_dimensions: ["include", "amount"] } }), /missing cost/],
    ["budget truncation", completeEnvelope({ output_budget_truncation: { reason: "reached" } }), /output_budget_truncation=<present>/],
    ["budget omission", completeEnvelope({ output_budget_exceeded: { omitted_result: true } }), /output_budget_exceeded=<present>/],
  ];
  for (const [name, value, pattern] of cases) assert.throws(() => readCompleteStandupItems(value), pattern, name);
});

test("standup item fields are validated before rendering", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["title", { id: "fixture-1", title: 1, status: "open" }, /string title and status/],
    ["status", { id: "fixture-1", title: "Fixture", status: 1 }, /string title and status/],
    ["priority", { id: "fixture-1", title: "Fixture", status: "open", priority: "high" }, /priority must be a number/],
    ["tags", { id: "fixture-1", title: "Fixture", status: "open", tags: [1] }, /tags must be strings/],
    ["blocked_by", { id: "fixture-1", title: "Fixture", status: "open", blocked_by: 1 }, /blocked_by must be a string/],
    ["dependencies", { id: "fixture-1", title: "Fixture", status: "open", dependencies: [{ id: 1, kind: "blocked_by" }] }, /dependency id and kind must be strings/],
  ];
  for (const [name, item, pattern] of cases) assert.throws(() => readCompleteStandupItems(completeEnvelope({ items: [item] })), pattern, name);
});
