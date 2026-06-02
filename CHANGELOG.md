# Changelog

## 2026.6.2 - 2026-06-02

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
