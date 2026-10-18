The workflow action-pin gate checks properties rather than freezing approved
revisions. Every external action or reusable workflow must use a full 40-digit
lowercase hexadecimal commit SHA, an owner in the explicit allow-list, and an
exact `# vX.Y.Z` annotation. A YAML syntax-tree walk prevents quoted keys, flow mappings and block scalars
from evading the gate. Aliases are refused pending an explicit policy review.
The gate inventories every workflow, including
CodeQL, Dependabot and reusable workflow callers.
Inventory uses parsed YAML rather than raw key spelling: `uses :` and quoted
`"uses":` keys receive the same pin checks. Workflows without actions are valid,
and `uses:` text within a scalar input is data rather than an action reference.

Offline observations of known action tags check their annotations. They are
optional evidence: an unobserved version with a valid SHA annotation is
accepted without updating a commit allow-list, including new tags that reuse
an existing commit. Network access is unnecessary.
The gate checks pin format and recorded tag agreement; it does not attest that
an upstream commit is safe or that an unobserved version actually names it.

Local `./` actions are permitted. Docker `docker://` references are rejected,
including digest references: container image approval is outside this policy.
Adding container actions requires a separately reviewed digest and image policy.

Dependabot preserves the version-comment format it finds. Existing major-only
comments are expanded to exact versions so future bumps update both the SHA and
version. PR #126's original patch was applied locally; its legacy `# v7`
annotations were expanded to the verified `# v7.1.0` tag, and all four workflow
security tests passed. The original patch has comment-format conflicts with the
required full-version migration; these are resolved to the new full version,
without changing any other patch content. This formatting migration is part of the gate repair;
the dependency bump remains owned by Dependabot.

Pin validation applies only to `jobs.<job_id>.uses` and
`jobs.<job_id>.steps[*].uses`. Inputs or environment fields named `uses` are
ordinary values. Every reference, including a local action, must occupy one
physical source line; escaped line breaks in quoted YAML scalars are refused.
