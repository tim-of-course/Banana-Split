# Workspace MCP recovery verification

Date: 2026-09-09. Installed build: `0.1.0+codex.20260909175001`.

## Failure and correction

The PlanVyper host (Codex thread `01a086ff-537d-7c61-b28a-9aa73d2a41ab`, T3 thread `c3f9fe2f-f559-42a1-b829-47e4a5f52f3c`) reached an older shared runtime after plugin reinstallation. Its fixed MCP ceiling required another project's server. Startup first failed with `app_server_unsupported`, then the attempted PlanVyper server selection failed with `permission_widening`. Both failures reported no side effects.

Banana now supports `runtime.permission_ceiling.mcp_servers: "workspace"`. At workflow creation it reads Codex's effective configuration and trusted project layers for the requested workspace, selects enabled project-declared MCP servers, excludes Banana host servers, and snapshots the names in workflow permissions. Globally configured servers are not automatically selected. Explicit arrays remain fixed ceilings; legacy omission and empty arrays still allow none. Root and child restrictions can only narrow the snapshot, and resumed agents retain their existing permissions.

The shipped example and plugin configuration select workspace mode. `banana_workflow_list.runtime` now identifies the running PID, executable, data directory, port, and MCP selection, making retained-runtime configuration visible. The Banana skill and combined managed-access reference explain these product contracts without project-specific instructions.

## Verification

- 115 tests pass, 844 assertions. The new regression exercises two workspace paths, configuration changes, disabled/untrusted/global server exclusion, immutable workflow snapshots, root narrowing, and rejection of child widening. Existing fixed-ceiling rejection checks still pass.
- Bun source bundle, macOS ARM64 build, and Windows x64 cross-build pass. Windows was not executed live.
- Plugin validation, both affected skill validations, and `git diff --check` pass.
- A real Luna-xhigh managed root called PlanVyper's Sunlight `repository_status`, verified `/Volumes/OS/Development/PlanVyper` and `sunlight_0fe7368d1a069c05`, then finished successfully. Workflow `wf_cfc2ba61-9c82-4948-a46d-8899d5fac91d`, root `agt_03b48432-554f-47c3-87e0-cc062d3755b0`. No children, source changes, or topics; zero managed-tool rejections or missing dispositions. This verifies connectivity, not implementation or source-write approval.
- Recovery notification was dispatched through T3's supported HTTP orchestration endpoint to the existing host thread. It confirmed port 43981 and successfully started the original implementation workflow: `wf_4660fd64-9938-47f4-b898-185b6e889947`, root `agt_8e27fde1-4264-4a6e-8f7d-def85768a635`. The short-lived CLI-issued handoff authentication session was revoked.

## Temporary deployment arrangement

PlanVyper uses the corrected compiled runtime on port 43981 and native App Server port 43982. Its stable package, configuration, data, and original project-config backup are under `/Users/tim/Library/Application Support/BananaSplit/planvyper-recovery-20260909`.

The marked recovery block in PlanVyper's `.codex/config.toml` disables the plugin-provided instance for this project and configures the same `banana-split-v1` MCP name against that stable package. Its own data directory prevents sharing state with the old runtime. Only the idle PlanVyper host connection was closed, using T3's settle action; the original thread was retained and resumed. No active managed work was cancelled.

The existing shared runtime on port 43891 was left running for its active Inspection workflow. The globally installed plugin is updated, but an already-running runtime is not replaced by reinstall. Keep the recovery runtime available while PlanVyper's workflow is active. When both runtimes are idle, the shared runtime can be restarted with the updated package and the marked PlanVyper override removed if consolidation is desired. No consolidation or automatic restart was performed.
