# Banana Split V1

Banana Split is a Windows 11 x64 Codex plugin for durable, recursive managed-agent workflows. One local runtime owns orchestration state and one Codex App Server connection; the plugin's MCP surface gives the main Codex task a conversation-native cockpit. There is no dashboard and the standalone CLI is read-only.

The normative product contract is [`docs/BANANA_SPLIT_V1_SPEC.md`](docs/BANANA_SPLIT_V1_SPEC.md). The shipped runtime is [`distribution/plugins/banana-split-v1/runtime/banana.exe`](distribution/plugins/banana-split-v1/runtime/banana.exe).

This is a V1 release for Windows 11 x64. Bug reports and focused pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues according to [SECURITY.md](SECURITY.md).

## Requirements and build

- Windows 11 x64
- A current authenticated `codex` CLI on `PATH`
- Bun 1.3 or newer to build the self-contained executable
- Node/npm to install the pinned MCP SDK dependencies

```powershell
npm install
npm run verify
```

`npm run verify` bundles the TypeScript, runs the deterministic runtime suite, and compiles `dist/banana.exe`. Copy a rebuilt executable into `distribution/plugins/banana-split-v1/runtime/banana.exe` before installing the plugin package.

## Install the packaged plugin

From this repository:

```powershell
codex plugin marketplace add .\distribution
codex plugin add banana-split-v1@banana-split-v1
codex plugin list
```

If the earlier colliding V1 entry was installed, remove only that transient entry with `codex plugin remove banana-split@banana-split-v1`. The legacy `banana-split@banana-split` plugin may remain installed side by side.

The plugin starts or reconnects the runtime through its MCP server. Runtime ownership is locked by canonical durable-data directory, so a second process cannot become another writer even when configured with a different loopback port. The MCP server also verifies that an existing listener owns the expected data directory before reconnecting. The host skill starts every root from a standalone task in a fresh thread and polls until mechanical termination.

When updating Banana Split itself, restart Codex Desktop after reinstalling the plugin. Existing Desktop sessions may retain the previously resolved plugin cache and runtime paths until the app restarts; begin verification in a new task after reopening Codex.

## Configuration

The packaged configuration is `distribution/plugins/banana-split-v1/config/banana.json`; the documented editable example is `config/banana.example.json`, validated by `config/banana.schema.json` and strict runtime checks. Configuration is read only at runtime startup. Workflow preset, permission, recommendation, and host-capability values are snapshotted immutably at workflow start.

Important defaults:

- one runtime-wide maximum of 16 active model turns; agent population and depth are unbounded;
- only the exact workflow workspace is writable, network is disabled, approvals route to the host;
- Banana agent tools and the current App Server's normal sandboxed coding tools are available;
- native delegation, direct Computer Use, apps, plugins, and non-allowlisted MCP servers are disabled in managed threads;
- `computer_use` is only advertised when both startup configuration and the current host report it available. Omitting the host report advertises nothing.

Optional `mcp_servers` arrays describe additional allowlisted MCP capabilities. Omitted child permission objects and fields inherit the direct parent's effective policy; explicit MCP arrays replace the inherited array and may only remove entries. Empty arrays allow none. Widening is rejected, never clamped. Codex App Server 0.146.0 has no complete generic built-in-tool allowlist API, so an explicit `tools` ceiling or child restriction fails with `app_server_unsupported` instead of claiming an unenforced boundary.

Every preset is validated against the current App Server model catalog at runtime startup and workflow start. Unsupported model, reasoning-effort, or explicit service-tier combinations fail; there is no routing fallback.

State defaults to `%LOCALAPPDATA%\BananaSplit`. It contains potentially sensitive authored payloads and inherits the current user's private profile ACLs. Poll views omit raw payloads; trusted inspection reveals them only with `include_payloads: true`.

## Host operation

The installed `$banana-split` skill drives the eight host tools:

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
