/** A current complete-list envelope with caller-selected top-level overrides. */
export function completeListEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    items: [{ id: "fixture-1", title: "Fixture", status: "open", tags: ["agent"] }],
    count: 1,
    total: 1,
    has_more: false,
    truncated: false,
    next_cursor: null,
    filters: { status: "all", include_body: true, no_truncate: true, strict_read: true, runtime_filters: {} },
    limit: null,
    requested_limit: null,
    effective_limit: null,
    source: null,
    completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 },
    projection: { mode: "full", fields: null },
    omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] },
    read_output: {
      contract_version: 1,
      command: "list",
      requested_dimensions: ["include", "amount", "cost"],
      within_budget: true,
      strings_compacted: false,
      rows_compacted: false,
      result_omitted: false,
    },
    ...overrides,
  };
}
