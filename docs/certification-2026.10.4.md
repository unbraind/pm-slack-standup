# PM CLI/SDK 2026.10.4 certification candidate

PM: [certification pm-slack-standup-74w8](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-74w8.toon), [coverage pm-slack-standup-7t31](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-7t31.toon), [full audit pm-slack-standup-2sjh](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-2sjh.toon).

## Changes

Exact development pins: CLI/SDK, pm-ops, pm-changelog 2026.10.4; Babel ESLint parser 8.0.6 (newest published 8.x rather than the older 7.x latest tag), Babel TypeScript syntax plugin 8.0.3, Node types 26.6.4, ESLint 10.12.0, fast-glob 3.3.3, jscpd 5.4.0, TypeScript 7.0.2. Runtime floors and all thresholds remain unchanged. The canonical launcher is copied byte-for-byte from the installed pm-ops template. Dependabot #98/#99/#100/#102/#103 are consolidated, including exact CodeQL SHA `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` and `# v4.38.2` comment.

## Gate results

`flock /tmp/claude-1000/heavy-gate.lock npm run release:check` passed: 208/208 tests, zero skipped, plus canonical-reader acceptance; lint passed, duplication 0/8796 lines across 26 sources with 0 clone pairs; 81 documented declarations. Coverage remains 90.44% lines/88.23% branches/91.79% functions over index.ts only (1 reported source). Scripts and independent statements remain unmeasured in the existing coverage item. No threshold, ignore or skip was added or reduced.

All 5 packed scenarios passed: npm-current and bun-current on 2026.10.4, npm-minimum and bun-minimum on 2026.8.20 (each 2 tracker/2 rendered items), and npm-global-current (1/1). Production audit, pack contents, changelog, release-date and publish-attestation checks passed. The same heavy lock covered CI's `bun install --no-save` and the following dogfood script.

`npx pm health --strict-exit --require-merge-drivers --json` passed with existing advisory warnings stale_in_progress_items:1 and legacy role-domain count 13. The linked launcher suite via `pm test --run --progress` passed 8/8.

## Security blocker

Open repository Dependabot alerts returned `[]`. `npm audit --omit=dev` reports zero vulnerabilities. Full `npm audit` remains blocked by 4 high development findings through fast-glob 3.3.3 -> micromatch 4.0.8 -> braces 3.0.3, also affecting pm-ops 2026.10.4. The [reviewed advisory GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) lists no patched version; npm's published braces versions stop at 3.0.3. An incompatible brace-expansion substitution or canonical-gate downgrade was not used. This candidate is NOT READY for certification until the full audit is clean; the coverage requirement remains open separately.

## Packed real-tracker dogfood

`flock /tmp/claude-1000/heavy-gate.lock bash -c 'npm run release:check && bun install --no-save && ../dogfood-slack.sh'` covered the heavy commands (individual outputs captured separately). Dogfood packed with `npm pack`, installed the archive plus CLI 2026.10.4 into a copy of the real tracker and ran npm and native Bun commands below. Both read 89 input items and selected 3 in_progress/0 blocked/3 up_next/0 done for the current standup. Section data match and Markdown is byte-identical (3175 bytes). Scratch deleted; no Slack delivery occurred.

```text
+ npx -y @unbrained/pm-cli@2026.10.4 package install /tmp/claude-1000/cert-wt/pm-slack-standup-2026.10.4.tgz --project
+ npx -y @unbrained/pm-cli@2026.10.4 standup --dry-run --format markdown
+ npx -y @unbrained/pm-cli@2026.10.4 standup export --format json --output npm-standup.json
standup export: wrote 89 item(s) as json to /tmp/claude-1000/cert-wt/pm-slack-standup-dogfood/npm-standup.json
exported: 89
format: "json"
file: "/tmp/claude-1000/cert-wt/pm-slack-standup-dogfood/npm-standup.json"
+ bunx --bun -y @unbrained/pm-cli@2026.10.4 standup --dry-run --format markdown
+ bunx --bun -y @unbrained/pm-cli@2026.10.4 standup export --format json --output bun-standup.json
standup export: wrote 89 item(s) as json to /tmp/claude-1000/cert-wt/pm-slack-standup-dogfood/bun-standup.json
exported: 89
format: "json"
file: "/tmp/claude-1000/cert-wt/pm-slack-standup-dogfood/bun-standup.json"
+ cmp npm-standup.md bun-standup.md
{"bytes":3175,"sectionCounts":{"in_progress":3,"blocked":0,"up_next":3,"done":0},"runtimesEqual":true}
```

## Managed GitHub preview

Installed managed `npm:pm-github@2026.10.4`. `pm github sync --repo unbraind/pm-slack-standup --dry-run` reports no provenance-linked items and synced=0/skipped=0/planned=0. This is zero-case preview evidence. No GitHub issue writes or scheduled sync. Final-head CI and substantive reviews remain separate; the orchestrator merges and closes PM items after verification.

## Review follow-up

Managed extension payloads are clone-local installed distributions and are excluded from Git. Reproduce the read-only preview with `npx -y @unbrained/pm-cli@2026.10.4 package install npm:pm-github@2026.10.4 --project`, then `npx -y @unbrained/pm-cli@2026.10.4 github sync --repo unbraind/pm-slack-standup --dry-run`. The installed version and zero-case receipt above remain the evidence; no write-path acceptance is claimed.

Greptile missing-catch-path finding is covered by a real `NODE_PATH` file fixture: nonzero `MODULE_NOT_FOUND`, no omit-dev skip and no installed drivers. Scoped and linked launcher suites pass 8/8; final locked full gate passes 208/208. Upstream generated pm-github apply concerns remain in open [pm-slack-standup-bhg0](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-bhg0.toon), not fixed by removing their distribution from the consumer PR.

The executable PM-linked full gate now runs `mkdir -p /tmp/claude-1000 && flock /tmp/claude-1000/heavy-gate.lock npm run release:check` in explicit tracker/source context. A real disposable missing-parent preflight reproduced failure before directory creation and success afterward. The shared lock path and full npm gate are unchanged; this fixes CodeRabbit portability finding #4177585174.

The corrected full PM-linked gate passes 208/208 tests, zero skips, all five packed scenarios and all release checks, using explicit tracker/source context (90 copied real items, no mismatch). Its first run exposed inherited PM_PATH in packed fixtures; source packing now clears external tracker overrides and each scenario owns its explicit project/global tracker roots. Coverage remains 90.44/88.23/91.79, duplication 0/8796 lines across 26 sources. No gate was weakened.
