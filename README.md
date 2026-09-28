# Banana Split

Current release: **0.1.0 (internal alpha)**.

Banana Split is a Windows 11 x64 and macOS Codex plugin for durable, recursive managed-agent workflows. One local runtime owns orchestration state and one Codex App Server connection; the plugin's MCP surface gives the main Codex task a conversation-native cockpit. There is no dashboard and the standalone CLI is read-only.

The normative product contract is [`docs/BANANA_SPLIT_V1_SPEC.md`](docs/BANANA_SPLIT_V1_SPEC.md). The shipped runtime is [`distribution/plugins/banana-split-v1/runtime/banana.exe`](distribution/plugins/banana-split-v1/runtime/banana.exe).

macOS packages support Apple Silicon and Intel. Bug reports and focused pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues according to [SECURITY.md](SECURITY.md).

## Versioning

Releases use `major.minor.patch` versioning:

- `0.1.0`: initial internal alpha.
- `0.5.0`: start of beta; subsequent `0.x` releases remain beta until `1.0.0`.
- `1.0.0`: first stable release.

During `0.x` development, increment the patch for fixes and the minor for meaningful features or breaking changes. Document breaking changes in release notes. Starting with `1.0.0`, follow [Semantic Versioning](https://semver.org/): major for breaking changes, minor for backward-compatible features, and patch for backward-compatible fixes.

The beta milestone is a project convention. Minor versions are integers, so `0.10.0` follows `0.9.0` if needed. Local plugin rebuilds may append `+codex.<timestamp>` build metadata without changing the release version. The `banana-split-v1` plugin identifier, V1 design specification, and configuration/state schema versions are separate from release numbering.

## Requirements and build

- Windows 11 x64 or macOS (Apple Silicon or Intel)
- A current authenticated `codex` CLI on `PATH`
- Bun 1.3 or newer to build the self-contained executable
- Node/npm to install the pinned MCP SDK dependencies

```powershell
npm install
npm run verify
```

`npm run verify` bundles the TypeScript, runs the runtime suite, and builds a self-contained plugin for the current computer under `dist/bun-<platform>-<architecture>/`. `npm run build:windows` builds the Windows x64 package; `npm run build:macos` builds both Apple Silicon and Intel packages. Cross-compilation verifies the build, but does not run it on the target OS. The checked-in `distribution` package retains the original Windows executable; install rebuilt packages from `dist`.

## Install the packaged plugin

After building, install the package for your computer. On Apple Silicon macOS:

```sh
codex plugin marketplace add ./dist/bun-darwin-arm64
codex plugin add banana-split-v1@banana-split-v1
codex plugin list
```

On Intel macOS, use `./dist/bun-darwin-x64`. On Windows:

```powershell
codex plugin marketplace add .\dist\bun-windows-x64
codex plugin add banana-split-v1@banana-split-v1
codex plugin list
```

If the earlier colliding V1 entry was installed, remove only that transient entry with `codex plugin remove banana-split@banana-split-v1`. The legacy `banana-split@banana-split` plugin may remain installed side by side.

The plugin starts or reconnects the runtime through its MCP server. Runtime ownership is locked by canonical durable-data directory, so a second process cannot become another writer even when configured with a different loopback port. The MCP server also verifies that an existing listener owns the expected data directory before reconnecting. The host skill starts every root from a standalone task in a fresh thread and polls until mechanical termination.

When updating Banana Split itself, restart Codex Desktop after reinstalling the plugin. Existing Desktop sessions may retain the previously resolved plugin cache and runtime paths until the app restarts; begin verification in a new task after reopening Codex.

## Configuration

The packaged configuration is `distribution/plugins/banana-split-v1/config/banana.json`; the documented editable example is `config/banana.example.json`, validated by `config/banana.schema.json` and strict runtime checks. Configuration is read only at runtime startup. Workflow settings are snapshotted at start. Only the host can change preset tiers afterward; permission, recommendation, and host-capability snapshots remain fixed.

Important defaults:

- one runtime-wide maximum of 16 active model turns; agent population and depth are unbounded;
- only the exact workflow workspace is writable, network is disabled, approvals route to the host;
- Banana agent tools and the current App Server's normal sandboxed coding tools are available;
- native delegation, direct Computer Use, apps, plugins, and non-allowlisted MCP servers are disabled in managed threads;
- `computer_use` is only advertised when both startup configuration and the current host report it available. Omitting the host report advertises nothing.

The shipped `runtime.permission_ceiling.mcp_servers: "workspace"` setting resolves enabled MCP servers declared in Codex’s trusted project configuration layers for the exact workflow workspace at workflow creation. Banana host MCP servers remain excluded. Each workflow snapshots the resolved names; subsequent workspace configuration changes do not expand existing agents’ permissions. Use an explicit `mcp_servers` array for a fixed runtime ceiling, or `[]` (also the legacy omission default) to allow none. Omitted child permission objects and fields inherit the direct parent's effective policy; explicit MCP arrays replace the inherited array and may only remove entries. Empty arrays allow none. Widening is rejected, never clamped. Codex App Server 0.146.0 has no complete generic built-in-tool allowlist API, so an explicit `tools` ceiling or child restriction fails with `app_server_unsupported` instead of claiming an unenforced boundary.

Every preset is validated against the current App Server model catalog at runtime startup and workflow start. Unsupported model, reasoning-effort, or explicit service-tier combinations fail; there is no routing fallback.

State defaults to `%LOCALAPPDATA%\BananaSplit` on Windows and `~/Library/Application Support/BananaSplit` on macOS. The `%LOCALAPPDATA%` placeholder in the shared configuration resolves to the macOS Application Support directory. Windows state inherits the user's profile ACLs; new macOS state directories use owner-only permissions. Poll views omit raw payloads; trusted inspection reveals them only with `include_payloads: true`.

Windows runtime ownership uses a named pipe. macOS uses a Unix socket with stale-socket recovery after a crash, and an owned process group for App Server shutdown.

## Preset tiers

Each new workflow uses one active tier from a catalog of exactly three tiers, with four presets per tier. `workflow_defaults.preset_tiers` defines the catalog and `default_tier` selects the initial tier. All tiers share the same four preset names so switching a tier preserves each agent's assigned preset. Each entry specifies a model, reasoning level, and optional service tier.

The shipped tiers are `cost-optimized`, `default`, and `performance-optimized`; `default` is selected initially. The four stable preset names describe their intended use rather than a particular model, so an agent keeps the same assignment when the host changes tiers.

The host can pass `tier` and a full `preset_tiers` catalog to `banana_workflow_start`. It can later call `banana_workflow_set_tier(workflow_id, tier, preset_tiers?)` to switch tiers or replace the workflow catalog. All entries are validated against the current App Server model catalog before a change is accepted. Existing preset names must remain available. Managed agents have no tier-changing tool and can spawn only with presets from the active tier.

Changes affect new agents immediately and existing agents on their next turn. Running turns keep their current model and are not interrupted. Polls expose the tier catalog and active tier; agent inspection includes per-turn routing history. These settings and history survive runtime restart. Existing workflows without tiers retain their original flat preset snapshot; a host can opt them in by supplying a full catalog with their existing preset names. Flat `preset_overrides` applies only to workflows without tiers.

## Host operation

The installed `$banana-split` skill drives the nine host tools:

1. Start with a standalone task and exact workspace.
2. Poll with the returned cursor until terminal.
3. Inspect agents only when more context or a transcript page is needed.
4. Relay approvals only after an explicit user decision.
5. For Computer Use, claim the oldest request with `in_progress` before acting, then record correlated evidence as `completed`, `declined`, or `failed`.

Computer Use runs in the main host, never in managed threads, and consumes no Banana model-turn slot. An in-progress action becomes `uncertain` after a runtime restart and is never automatically replayed.

## Read-only CLI

```powershell
banana watch <workflow-id> --config <path>
banana inspect <workflow-id> <agent-id> [--payloads] --config <path>
banana transcript <workflow-id> <agent-id> [--cursor <cursor>] [--limit 50] [--one-page] --config <path>
```

The CLI connects to the runtime owner and cannot start, message, control, approve, or answer requests.

## Recovery and troubleshooting

The store alternates two flushed checkpoints and loads the newest valid generation. After restart, queued/waiting/submitted/terminal state is retained, in-progress host actions become `uncertain`, and active Codex turns are reconciled through App Server. Ambiguous turns fail with `reconciliation_required`; failed or uncertain work is not replayed.

- `runtime_unavailable`: confirm the configured executable, `codex` command, and loopback port. Start `banana.exe runtime --config <path>` in a terminal to see the startup error.
- `app_server_unsupported`: update Codex or correct a policy the current App Server cannot enforce.
- `preset_unavailable`: edit the startup catalog to a model/effort/tier advertised by the installed App Server.
- `persistence_failed`: stop and repair access or disk-space problems in the configured state directory; do not edit live state.
- `reconciliation_required`: inspect the retained agent and Codex transcript, then explicitly cancel or resolve the affected work.

To remove retained private state, first stop the Banana runtime, verify the exact configured `data_directory`, and delete that directory manually. Cancellation does not roll back filesystem, network, approval, or host-side effects.

## License

Banana Split is available under the [MIT License](LICENSE).
