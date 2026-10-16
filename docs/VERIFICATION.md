# Verification evidence

The current release is **0.1.1, internal alpha**. The [V1 specification](BANANA_SPLIT_V1_SPEC.md) describes required behavior; it is not a claim that every acceptance scenario has passed on every supported platform.

Start with the [internal-alpha assessment](FINAL_ALPHA_VERIFICATION.md), which reports successful coordination checks and their limitations, including a task that needed a host repair. The later [workspace MCP recovery report](WORKSPACE_MCP_RECOVERY.md) covers the workspace-based MCP selection change.

Other reports in this directory are historical development records. Some use `1.0.0+codex...` build labels from before the current release-numbering policy; those labels do not establish a public stable release. Absolute paths, workflow IDs and `.banana-test` artifacts refer to the author's test environment. They are evidence references, not prerequisites or files included in a fresh clone.

- [Verification matrix](V1_VERIFICATION_MATRIX.md): required scenarios and the level of evidence each needs.
- [Iteration history](ITERATION_LOOP_VERIFICATION.md): failures, fixes and follow-up checks.
- [Standalone verification](BLACKBOX_STANDALONE_VERIFICATION.md): installed workflow and approval behavior.
- [Custom cheap-tier scale run](CHEAP_TIER_SCALE_VERIFICATION.md): results from an overridden catalog, not the shipped cost-optimized tier.

## Linux x64 port checks (2026-10-15)

The Linux port was checked on Ubuntu 24.04.5 LTS, x86_64, glibc 2.39, with Bun 1.3.14, Node 24.21.0, and Codex CLI 0.160.0 authenticated through ChatGPT. These checks use the actual Linux runtime, without bypassing its platform check.

`npm run verify` passed: source bundle, **137 passing tests, one macOS-only skip, no failures**, and the native Linux package build. The platform suite covers XDG defaults and explicit state directories, simultaneous single ownership, directory aliases, case-sensitive owner identity, killed-owner recovery, and descendant process termination. The previous Linux ownership race was reproduced before the fix; the concurrent-start test now runs on Linux against the abstract-socket implementation.

`npm run package:release` built Windows x64, both macOS architectures, and Linux x64 archives. All four checksums passed. After extracting the Linux archive into a fresh directory, `scripts/smoke-package.ts` executed its binary and connected through its packaged MCP manifest: all nine tools were discoverable without starting a runtime or model turn. CI performs this same package check on Ubuntu 24.04 without authentication.

The Linux archive was then installed through Codex's local marketplace. A local MCP SDK client drove the installed executable and shipped configuration, using the default Linux state directory. This verifies the installed MCP/runtime path; it does not establish fresh-session host skill discovery or Desktop UI behavior.

| Live check | Workflow / root agent | Result |
| --- | --- | --- |
| Read-only delegation | `wf_dd64cb9a-d246-491e-a11d-b15a14be62c5` / `agt_fa850217-bace-4298-90e5-1159e8733f55` | Completed; root outcome `success`; exactly two fresh children submitted 42 and 63; parent accepted both. |
| Scratch-file write and readback | `wf_223135ee-3442-4093-b5a6-fe91d436b9aa` / `agt_08b2635c-cb6d-40b1-9104-7cffe7c944b3` | Completed; root outcome `success`; exact bytes `banana-split-linux-ok\n` verified after two inspected host approvals. |

Both workflows used the shipped `cost-optimized` tier with no catalog overrides or tier changes. Each root used resolved settings `gpt-6.1-sol` / `high`; the delegation workflow's two distinct children used `gpt-6-luna` / `xhigh`. Codex confirmed the model names; reasoning efforts are recorded request settings. Across both workflows there were two roots and two subagents, two parent acceptances, no revisions, no managed-tool rejections, and no turns missing a disposition. The host running these checks was GPT-6.1-Sol with high reasoning effort.

After both workflows completed, the idle runtime was terminated with SIGTERM and restarted through the installed MCP executable. Its PID changed; both retained workflow trees and final responses matched their pre-restart values exactly. The installed read-only CLI's `watch`, `inspect`, and `transcript` commands also succeeded after restart. Local diagnostic artifacts are under `.banana-test/linux-acceptance/`; they are not distributed.

**Remaining Linux acceptance limit:** this container cannot create the user namespace required by the Codex sandbox (`unshare -Ur true` fails while writing `uid_map`). The scratch write and readback first failed in the sandbox, then succeeded through two scoped, inspected approvals. This proves approval routing and the bounded file result, but **does not prove Linux sandbox enforcement**. Repeat the write inside a working sandbox on a host configured with [Codex's Linux prerequisites](https://learn.chatgpt.com/docs/sandboxing#prerequisites) before claiming full sandbox acceptance. ARM64, Alpine/musl, WSL, other distributions, and host Computer Use were not exercised.

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
