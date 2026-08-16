# Changelog

## 2026.8.16 - 2026-08-16

### Fixed

- A quoted final argument makes cmd /s strip the quotes that protect the executable path in the win32 pm launch ([pm-slack-standup-ogys](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-ogys.toon))
- The .cmd shim resolvePmBin selects on win32 cannot be launched by its only caller ([pm-slack-standup-20gw](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-20gw.toon))
- A truncated list-all envelope produces a partial standup that reads as a quiet day ([pm-slack-standup-5q1f](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-5q1f.toon))
- Standup read failure must refuse, not render an empty standup ([pm-slack-standup-011l](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-011l.toon))

## 2026.8.14 - 2026-08-14

### Fixed

- Declaring the pm CLI as a runtime dependency gives consumers a second nested copy whenever their host pin differs ([pm-slack-standup-v5q6](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-v5q6.toon))

## 2026.8.10 - 2026-08-10

### Fixed

- The mandatory docstring gate could skip its own scan and still exit zero ([pm-slack-standup-cg85](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-cg85.toon))

### Other

- Adopt the canonical pm-ops docstring gate ([pm-slack-standup-4hk6](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-4hk6.toon))

## 2026.8.7 - 2026-08-07

### Other

- Gate CI on strict tracked pm project health ([pm-slack-standup-2f0f](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-2f0f.toon))

## 2026.8.4 - 2026-08-04

### Other

- Resolve pm-changelog to the release that derives release dates in UTC ([pm-slack-standup-1sqq](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-1sqq.toon))

## 2026.7.31 - 2026-07-31

### Fixed

- Release commits discard the rebuilt dist, so the git-install path serves the previous version ([pm-slack-standup-cims](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-cims.toon))

## 2026.7.29 - 2026-07-29

### Added

- Enforce a real coverage gate by running tests against TypeScript sources ([pm-slack-standup-9l8f](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-9l8f.toon))

### Other

- Adopt pm-cli 2026.7.29 ([pm-slack-standup-lslq](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-lslq.toon))

## 2026.7.28 - 2026-07-28

### Fixed

- Fix the output_format service override so it declines unclaimed payloads instead of echoing the command context ([pm-slack-standup-v4tf](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-v4tf.toon))

### Other

- Adopt pm-cli 2026.7.28 ([pm-slack-standup-40od](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-40od.toon))
- Eliminate the last source any with real SDK handler context types ([pm-slack-standup-m2jv](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-m2jv.toon))

## 2026.7.27 - 2026-07-27

### Other

- Adopt the pm-cli 2026.7.26 typed authoring SDK, drop the last any-typed shim, and de-binary the source file ([pm-slack-standup-xms9](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-xms9.toon))

## 2026.7.26 - 2026-07-26

### Other

- Enable governance duplicate-detection advisory mode and adopt pm-cli 2026.7.25 ([pm-slack-standup-jl6z](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-jl6z.toon))

## 2026.7.25 - 2026-07-25

### Other

- Adopt --respect-item-release in changelog scripts and bump pm-changelog to 2026.7.24 ([pm-slack-standup-6nwd](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-6nwd.toon))

## 2026.7.23 - 2026-07-23

### Fixed

- Recommend pm merge reconcile (2026.7.22) over raw history-repair in Multi-agent merge safety docs ([pm-slack-standup-dkqk](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-dkqk.toon))

### Other

- Adopt pm field-aware merge driver for multi-agent branch-merge safety ([pm-slack-standup-0pxr](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-0pxr.toon))

## 2026.7.19 - 2026-07-19

### Added

- Hands-on functional test pass 2026-05-29 (real data) ([pm-slack-standup-s1rp](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-s1rp.toon))

### Other

- Harden release bun-verify so registry-mirror lag cannot block the GitHub release ([pm-slack-standup-do6k](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-do6k.toon))

## 2026.7.10 - 2026-07-10

### Added

- Add --format blocks, --schedule, --include-blockers, --team, --compact to pm-slack-standup ([pm-slack-standup-9o06](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-9o06.toon))

## 2026.7.7 - 2026-07-07

### Other

- Ecosystem release readiness pass 2026-07-06 ([pm-slack-standup-u81w](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-u81w.toon))

## 2026.7.6 - 2026-07-06

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-slack-standup-izpr](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-izpr.toon))

### Other

- Align Node engine with pm CLI runtime ([pm-slack-standup-r884](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-r884.toon))
- Regenerate CHANGELOG after pm close item ([pm-slack-standup-xuty](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-xuty.toon))

## 2026.6.12 - 2026-06-12

### Added

- Round-trip-safe stdout export, documented export flags, multi-snapshot history (--history-dir / --compare <dir\>) ([pm-slack-standup-39h9](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-39h9.toon))
- Configurable Up Next count, milestone grouping, --since warning + friendly export errors ([pm-slack-standup-dc4i](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-dc4i.toon))

### Other

- Align pm-slack-standup with pm CLI 2026.6.12 release readiness ([pm-slack-standup-7ikg](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-7ikg.toon))

## 2026.6.9 - 2026-06-09

### Added

- Add --compare standup trend deltas ([pm-slack-standup-o59l](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-o59l.toon))

## 2026.6.8 - 2026-06-08

### Other

- Full-cycle hardening wave: pm-slack-standup ([pm-slack-standup-3bae](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-3bae.toon))

## 2026.6.7 - 2026-06-07

### Added

- Render blocker context and stale blocked work in standups ([pm-slack-standup-nspi](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-nspi.toon))

### Other

- PM ecosystem production-readiness sweep 2026-06-07 ([pm-slack-standup-diqb](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-diqb.toon))
- Harden release readiness checks ([pm-slack-standup-9bl1](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-9bl1.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-slack-standup-iv4f](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/chores/pm-slack-standup-iv4f.toon))

## 2026.6.4-1 - 2026-06-04

### Added

- preflight: fail-fast Slack-credential gate for standup post path ([pm-slack-standup-qnkp](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-qnkp.toon))

## 2026.6.4 - 2026-06-04

### Added

- Blocker inference, yesterday/today split, multi-channel, fallback-to-stdout, custom section labels ([pm-slack-standup-8s6b](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-8s6b.toon))

## 2026.6.3 - 2026-06-02

### Added

- Deep feature expansion: multi-format output, grouping, sections, date windows ([pm-slack-standup-h64p](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-h64p.toon))
- Add --days relative date window alongside --since ([pm-slack-standup-5sow](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-5sow.toon))
- Add --sections selection/ordering with dedicated Blocked section ([pm-slack-standup-jimx](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-jimx.toon))
- Add --group-by sprint and type (extend assignee/status) ([pm-slack-standup-f4m6](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-f4m6.toon))
- Add --format slack\|blockkit\|markdown\|plain unified output ([pm-slack-standup-dgyy](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-dgyy.toon))

### Other

- Keep slack message text byte-identical; --format governs printed output only (blockkit JSON no longer always dumped in dry-run) ([pm-slack-standup-rttw](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/decisions/pm-slack-standup-rttw.toon))
- Block Kit schema: single header (150ch), one mrkdwn section per bucket (3000ch truncation), divider + context footer ([pm-slack-standup-rpty](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/decisions/pm-slack-standup-rpty.toon))
- Export pure helpers + node:test unit suite (formatters/grouping/window) ([pm-slack-standup-uf4j](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-uf4j.toon))
- Missing-creds real post -\> CommandError (exit 1); no network in dry-run ([pm-slack-standup-m9ze](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-m9ze.toon))

## 2026.6.2 - 2026-06-02

### Added

- Block Kit standup + standup export exporter + grouping/window/mention flags ([pm-slack-standup-ddta](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-ddta.toon))

## 2026.6.1 - 2026-06-01

### Fixed

- standup threw plain Error (no exitCode) → runtime double-invocation ([pm-slack-standup-uyr9](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-uyr9.toon))

## 2026.5.30 - 2026-05-30

### Other

- Production-readiness audit 2026-05-28 ([pm-slack-standup-uqdb](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-uqdb.toon))

## 2026.5.29 - 2026-05-29

### Fixed

- Missing-webhook failure returns error object and exits 0 (wrong exit code) ([pm-slack-standup-xk28](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-xk28.toon))

### Other

- dry-run / include-done flags ignored due to kebab-case option read (option normalization) ([pm-slack-standup-ro6d](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-ro6d.toon))

## 2026.5.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-slack-standup-5yh1](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-5yh1.toon))

## 2026.5.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-slack-standup-rexb](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-rexb.toon))

## 2026.5.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-slack-standup-1k0o](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-1k0o.toon))

### Other

- Release readiness hardening for pm-slack-standup ([pm-slack-standup-i5h1](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-i5h1.toon))
