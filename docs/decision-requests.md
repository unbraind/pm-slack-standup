# Decision requests in a standup

A Decision item must carry the exact `standup-decision-request` tag and one
`standup-decision-request` JSON fence in its body. The declaration is a public
presentation of the request, separate from general decision notes and plan
records. Keep the canonical decision and its response at the linked source.

Example body (synthetic public evidence):

````markdown
```standup-decision-request
{
  "version": 1,
  "state": "pending",
  "disclosure": "public",
  "prompt": "Which release route should we use?",
  "audience": "human",
  "responseBy": "2026-10-22T09:00:00.000Z",
  "alternatives": [
    { "label": "Ship the small patch", "disclosure": "public" },
    { "label": "Wait for the bundled release", "disclosure": "public" },
    { "label": "An internal option", "disclosure": "private" }
  ],
  "evidence": ["https://example.org/project/decisions/release#evidence"],
  "acknowledgeAt": "https://example.org/project/decisions/release",
  "acknowledgment": "https://example.org/project/decisions/release#response"
}
```
````

Create or update a Decision using the normal pm CLI/SDK; for example, save this
body as `request.md` and run:

```sh
pm create Decision "Choose a release route" --tags standup-decision-request --body-file request.md
pm standup decisions --json --limit 3 --output-bytes 4096
pm standup --dry-run --include-decisions --format markdown
pm standup export --include-decisions --format md
```

Omit `--json` for the host's default TOON output. `standup decisions` only reads;
it never posts, acknowledges, or updates a decision. `acknowledgeAt` tells a
human or agent where to respond; optional `acknowledgment` links an existing
response. Acknowledgment alone does not resolve the request. Update its state
to `closed` or `superseded`, or close/cancel the Decision item, to remove it.
Deadlines do not auto-close requests: overdue requests remain visible first.

`audience` is `human`, `agent`, or `either`. `responseBy` is an exact UTC ISO
instant with milliseconds. Public labels and prompts are nonempty single-line
strings of at most 160 UTF-16 units; alternatives number 2–6. Evidence has 1–3
credential-free HTTPS URLs, each at most 512 units; acknowledgment links use the
same rule. Only publish URLs and labels approved for public disclosure. URL
validation cannot determine whether the linked resource is public.

The request must explicitly declare `disclosure: public`. A private declaration
is withheld entirely. Every alternative must explicitly declare `public` or
`private`; private labels never enter the projection, text, or Block Kit. Only
the withheld count appears. Titles, general body prose, and unknown fields are
never copied into the decision section. Declared requests are excluded from
ordinary work buckets even when the optional section is disabled. JSON exports
never contain their source bodies; `--include-decisions` adds their public projection. Terminal item states
(including the standup done alias `complete`, compared after trimming) and terminal request states suppress a
request before validating obsolete payload details.
Untagged decisions are ignored, including malformed old notes. A malformed
active declaration refuses the entire report instead of silently dropping it.

Rows sort by deadline then canonical item ID. `--limit` is 1–10 (default 10).
`--output-bytes` is 512–32768 (default 8192), measured over compact JSON including
the omission receipt. The TOON host renderer may use different whitespace;
this is a projection budget rather than a transport byte guarantee. Entire
rows are omitted from the end, preserving complete alternatives and URLs.
`total`, `omitted`, and `remedy` expose the remaining work. Periodic sections use
the defaults and respect the standup's team filter; general time-window and
work-section filters do not hide pending requests.

```ts
import {
  collectDecisionRequests, fetchAllItems, DecisionRequestRefusal,
  type DecisionRequestDeclaration,
} from "pm-slack-standup";

const declarationVersion: DecisionRequestDeclaration["version"] = 1;
try {
  const report = collectDecisionRequests(fetchAllItems(".agents/pm"), { limit: 3 });
  console.log(declarationVersion, report.requests, report.omitted);
} catch (error) {
  if (error instanceof DecisionRequestRefusal) {
    console.error(error.code, error.itemId, error.remedy);
  } else {
    throw error;
  }
}
```

`DecisionRequestRefusal` carries `exitCode: 2`, `code`, `remedy`, and optional
`itemId`. Codes are `invalid_options` (use documented bounds), `invalid_request`
(repair the declaration), and `unsupported_version` (use version 1 or a compatible
package). The CLI fails nonzero with the remedy; when `itemId` is set the message
names that item, because the command runtime prints only the message. SDK consumers
retain the typed properties. The canonical reader separately refuses incomplete tracker reads.
Block Kit decision sections are plain text and split only on line boundaries, so an
evidence or acknowledgment URL is never divided across blocks.
