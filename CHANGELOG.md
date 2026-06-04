# Changelog

## 2026.6.4 - 2026-06-04

### Added

- Blocker inference, yesterday/today split, multi-channel, fallback-to-stdout, custom section labels ([pm-slack-standup-8s6b](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-8s6b.toon))

## 2026.06.03 - 2026-06-02

### Added

- Deep feature expansion: multi-format output, grouping, sections, date windows ([pm-slack-standup-h64p](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-h64p.toon))
- Add --days relative date window alongside --since ([pm-slack-standup-5sow](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-5sow.toon))
- Add --sections selection/ordering with dedicated Blocked section ([pm-slack-standup-jimx](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-jimx.toon))
- Add --group-by sprint and type \(extend assignee/status\) ([pm-slack-standup-f4m6](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-f4m6.toon))
- Add --format slack\|blockkit\|markdown\|plain unified output ([pm-slack-standup-dgyy](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-dgyy.toon))

### Other

- Keep slack message text byte-identical; --format governs printed output only \(blockkit JSON no longer always dumped in dry-run\) ([pm-slack-standup-rttw](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/decisions/pm-slack-standup-rttw.toon))
- Block Kit schema: single header \(150ch\), one mrkdwn section per bucket \(3000ch truncation\), divider + context footer ([pm-slack-standup-rpty](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/decisions/pm-slack-standup-rpty.toon))
- Export pure helpers + node:test unit suite \(formatters/grouping/window\) ([pm-slack-standup-uf4j](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-uf4j.toon))
- Missing-creds real post -\> CommandError \(exit 1\); no network in dry-run ([pm-slack-standup-m9ze](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-m9ze.toon))

## 2026.06.02 - 2026-06-02

### Added

- Block Kit standup + standup export exporter + grouping/window/mention flags ([pm-slack-standup-ddta](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/features/pm-slack-standup-ddta.toon))

## 2026.06.01 - 2026-06-01

### Fixed

- standup threw plain Error \(no exitCode\) → runtime double-invocation ([pm-slack-standup-uyr9](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-uyr9.toon))

## 2026.05.29 - 2026-05-29

### Fixed

- Missing-webhook failure returns error object and exits 0 \(wrong exit code\) ([pm-slack-standup-xk28](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/issues/pm-slack-standup-xk28.toon))

### Other

- dry-run / include-done flags ignored due to kebab-case option read \(option normalization\) ([pm-slack-standup-ro6d](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-ro6d.toon))

## 2026.05.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-slack-standup-5yh1](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-5yh1.toon))

## 2026.05.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-slack-standup-rexb](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-rexb.toon))

## 2026.05.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-slack-standup-1k0o](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-1k0o.toon))

### Other

- Release readiness hardening for pm-slack-standup ([pm-slack-standup-i5h1](https://github.com/unbraind/pm-slack-standup/blob/main/.agents/pm/tasks/pm-slack-standup-i5h1.toon))
