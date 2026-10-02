# Verification evidence

The current release is **0.1.0, internal alpha**. The [V1 specification](BANANA_SPLIT_V1_SPEC.md) describes required behavior; it is not a claim that every acceptance scenario has passed on every supported platform.

Start with the [internal-alpha assessment](FINAL_ALPHA_VERIFICATION.md), which reports successful coordination checks and their limitations, including a task that needed a host repair. The later [workspace MCP recovery report](WORKSPACE_MCP_RECOVERY.md) covers the workspace-based MCP selection change.

Other reports in this directory are historical development records. Some use `1.0.0+codex...` build labels from before the current release-numbering policy; those labels do not establish a public stable release. Absolute paths, workflow IDs and `.banana-test` artifacts refer to the author's test environment. They are evidence references, not prerequisites or files included in a fresh clone.

- [Verification matrix](V1_VERIFICATION_MATRIX.md): required scenarios and the level of evidence each needs.
- [Iteration history](ITERATION_LOOP_VERIFICATION.md): failures, fixes and follow-up checks.
- [Standalone verification](BLACKBOX_STANDALONE_VERIFICATION.md): installed workflow and approval behavior.
- [Custom cheap-tier scale run](CHEAP_TIER_SCALE_VERIFICATION.md): results from an overridden catalog, not the shipped cost-optimized tier.

## Four-tier smoke checks (2026-10-02)

Build `0.1.0+codex.20261002131108` passed two short real-model source-engine diagnostics using the shipped catalog without workflow overrides. Each coordinator created one fresh `defined-workhorse` child, reviewed and accepted its arithmetic result, and completed successfully.

| Tier | Coordinator model / requested effort | Child model / requested effort | Result | Elapsed |
| --- | --- | --- | --- | --- |
| `cost-optimized` | `gpt-6.1-sol` / `high` | `gpt-6-luna` / `xhigh` | Accepted `17 + 25 = 42` | 30.6 s |
| `max-performance` | `gpt-6-astra` / `ultra` | `gpt-6-astra` / `low` | Accepted `9 × 7 = 63` | 53.7 s |

The runs used four distinct agents: two coordinators and two children. App Server thread responses confirmed the model names. Reasoning efforts were sent in turn requests and recorded in routing history; the server did not separately echo the efforts. Both workflows retained the selected tier throughout and passed checks for exact agent count, routing, successful results, and parent acceptance.

These diagnostics ran on Linux through a temporary external harness that accepted the runtime's explicit Linux platform rejection. Authentication, permission checks and real App Server requests remained in use, and no shipped platform check was changed. This verifies engine coordination with real agents, not installation or runtime acceptance on Windows or macOS. The workflows were read-only, with no workspace writes or agent network access. The owned App Server was stopped afterward.

The automated suite also passed: 117 tests passed, three platform-specific tests were skipped, and none failed. All three supported platform packages were cross-built, with their checksums, bundled configuration and skill verified.

`npm run verify` runs source checks, automated tests and a native package build. The automated suite uses test doubles for much of the App Server interaction. Passing it or cross-compiling an executable does not establish authenticated live workflow behavior, Desktop Computer Use, or acceptance on another OS. Release notes should identify the platforms and live scenarios actually exercised.
