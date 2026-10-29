# SDK example: select intent, then observe outcomes

This runs inside an extension command with a host-injected `context`. Replace
the source and target IDs with existing items. Nothing in the report assigns or
modifies work. Capturing the explicit declaration is a separate native action.

```ts
import { getHistoryPath, readHistorySnapshot } from "@unbrained/pm-cli/sdk";
import { encodeStandupCommitment, readCommitmentVariance } from "pm-slack-standup";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";

/** Capture the current native target revision on an existing periodic Plan. */
export async function declareIntent(context: CommandHandlerContext): Promise<number> {
  if (context.sdk === undefined) throw new Error("Capture intent inside a host-injected SDK command context.");
  const target = "demo-build";
  const source = "demo-plan";
  const history = await readHistorySnapshot(getHistoryPath(context.pm_root, target), target);
  await context.sdk.client.comments(source, {
    add: encodeStandupCommitment({ version: 1, key: "build", target: { id: target, revision: history.entries.length } }),
  });
  const capture = await readHistorySnapshot(getHistoryPath(context.pm_root, source), source);
  return capture.entries.length; // Retain this explicit source revision.
}

/** Observe later outcomes, retaining unsupported and pending commitments separately. */
export async function inspectIntent(context: CommandHandlerContext, selectedRevision: number) {
  return readCommitmentVariance(context, {
    source: { id: "demo-plan", revision: selectedRevision },
    keys: ["build", "docs"],
    outputBytes: 16384,
  });
}
```

Before a linked outcome, `build` is `still_pending`; a native close with a done
role makes it `completed`. Changing its body and later closing it produces
`changed_scope` with `changes: ["body"]`. The explicitly requested `docs` key
remains `unsupported/missing_capture` unless it was declared in the selected
source revision. No missing data is interpreted as failure.

These filesystem history APIs require retained native history; unavailable
history yields actionable uncertainty/refusals. The example makes no claim about
remote-backend history availability or atomic capture across multiple writers.
