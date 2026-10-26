# Published pm SDK capability floor

Audited main: `d1279e294c3bf41694927fd1636e2a02425a9f9a`. Required API floor: **2026.8.18**.

Declared host floor: `2026.10.20`. npm peer: `>=2026.10.20`.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: certifyCompleteListResult` | 2026.8.18 | 2026.8.17 | [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: createPmCliExpectedError` | 2026.6.5 | 2026.5.31 | [status-roles.ts:1](../status-roles.ts#L1), [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: EXIT_CODE` | 2026.5.14 | 2026.5.12 | [status-roles.ts:1](../status-roles.ts#L1), [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: inspectCompleteListResult` | 2026.8.18 | 2026.8.17 | [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: normalizeStatusInputWithRegistry` | 2026.7.23 | 2026.7.22 | [status-roles.ts:1](../status-roles.ts#L1) |
| `@unbrained/pm-cli/sdk :: PmClient` | 2026.7.6 | 2026.7.5 | [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: readSettings` | 2026.5.14 | 2026.5.12 | [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: resolveRuntimeStatusRegistry` | 2026.5.14 | 2026.5.12 | [status-roles.ts:1](../status-roles.ts#L1), [index.ts:11](../index.ts#L11) |
| `@unbrained/pm-cli/sdk :: statusIsTerminal` | 2026.7.23 | 2026.7.22 | [status-roles.ts:1](../status-roles.ts#L1) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:2335](../index.ts#L2335), [index.ts:2338](../index.ts#L2338), [index.ts:2339](../index.ts#L2339), [index.ts:2341](../index.ts#L2341), [index.ts:2342](../index.ts#L2342), [index.ts:2355](../index.ts#L2355), [index.ts:2395](../index.ts#L2395), [index.ts:2434](../index.ts#L2434), [index.ts:2435](../index.ts#L2435), [index.ts:2535](../index.ts#L2535), [index.ts:2536](../index.ts#L2536) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:1128](../index.ts#L1128), [index.ts:2385](../index.ts#L2385), [index.ts:2540](../index.ts#L2540) |
| `CommandHandlerContext.sdk` | 2026.7.19 | 2026.7.18 | [index.ts:1128](../index.ts#L1128) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [index.ts:2495](../index.ts#L2495), [index.ts:2523](../index.ts#L2523), [index.ts:2544](../index.ts#L2544) |
| `ExtensionApi.registerExporter` | 2026.5.1 | 2026.3.12 | [index.ts:2644](../index.ts#L2644) |
| `ExtensionApi.registerPreflight` | 2026.5.1 | 2026.3.12 | [index.ts:2573](../index.ts#L2573) |
| `ExtensionApi.registerService` | 2026.5.1 | 2026.3.12 | [index.ts:2613](../index.ts#L2613), [index.ts:2614](../index.ts#L2614) |
| `ExtensionCommandSdk.client` | 2026.7.19 | 2026.7.18 | [index.ts:1128](../index.ts#L1128) |
| `ImportExportContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:2647](../index.ts#L2647), [index.ts:2653](../index.ts#L2653), [index.ts:2655](../index.ts#L2655), [index.ts:2711](../index.ts#L2711) |
| `ImportExportContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:2658](../index.ts#L2658) |
| `PmClient.listAllComplete` | 2026.8.18 | 2026.8.17 | [index.ts:1130](../index.ts#L1130) |
| `PmClient.run` | 2026.7.6 | 2026.7.5 | [index.ts:1133](../index.ts#L1133) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.12 | `42dcaef84dc441b7792aeffa059bfe10a86ae8b12b1084472229bba03fb29910` |
| 2026.5.14 | `7f7e9131afadb891344bf2fb93b15bc157d18c532a5da4ec31677957d37b7260` |
| 2026.5.31 | `d3b4a795704588e414070a22a4034d7fbd7a290a050509cc4852e0051c0969a7` |
| 2026.6.5 | `bb47c85bb2ce1a8ba858651af8d1f4ca6888bc731d0aaaa63a4b97427219cd89` |
| 2026.7.5 | `4a6664f68120cace5648faf48d51b08c14e969d9c7e185e592f1a0fceae57274` |
| 2026.7.6 | `0d6e446cf93a0f0660ce4e21943adf1e0c21381010ef67369f40cc9834b8d158` |
| 2026.7.18 | `44b48fe680cf330254a4ab8d42b55cbcee81ba5cf21e4d4550b40413265d64b9` |
| 2026.7.19 | `513e0aead42767a113a26b8b2e2cbb8a22879d0cb0500d4d3cdd16d21d9f7a39` |
| 2026.7.22 | `d013832d6afc97c9a5c6f4a48a497f54a216643f8c7017b9c4f807ce6607532b` |
| 2026.7.23 | `caf1a21b0b587dc55c3509654466dd1e20383e30f2d17b47678887a15a5490af` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |
