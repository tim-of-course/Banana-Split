# Operating Banana Split

Start with the [quickstart](../README.md) for installation and a first task. This guide covers Windows 11 x64 and macOS. Linux and WSL are unsupported.

## Which configuration file to edit

The runtime reads `config/banana.json` in its installed plugin directory at startup. The install command's JSON output includes `installedPath`. Codex normally caches local plugins below `~/.codex/plugins/cache/`; use the returned path rather than guessing the version directory. A custom `CODEX_HOME` changes the cache location. See the [official plugin packaging documentation](https://developers.openai.com/plugins/build/plugins) for marketplace and cache behavior.

| File | Purpose |
| --- | --- |
| Source repo: `distribution/plugins/banana-split-v1/config/banana.json` | Defaults copied into new builds; edit this before building your own configuration. |
| Source repo: `config/banana.example.json` | Reference copy of shipped defaults; editing it alone has no effect on a build or runtime. |
| Extracted or built package: `plugins/banana-split-v1/config/banana.json` | Edit this before installing a downloaded package. A rebuild replaces this generated file. |
| Installed copy: `<installedPath>/config/banana.json` | Used by the installed runtime; direct edits are temporary and can be lost on reinstall. |

Keep custom settings in your source or extracted package, with a separate backup before upgrading. The [JSON schema](../config/banana.schema.json) describes the format; startup performs additional strict validation.

Configuration is read only at runtime startup. Each new workflow snapshots its settings. Existing workflows keep their permission and host-capability snapshots; restarting does not expand them. The host can change model tiers separately.

### Models and preset tiers

The shipped tiers are `cost-optimized`, `default`, `performance-optimized`, and `max-performance`, with `default` initially selected. Each has the same four preset names: `complex-judgment`, `default-judgment`, `general-workhorse`, and `defined-workhorse`. Each entry supplies a model, reasoning effort and optional service tier. See the [tier comparison](https://github.com/tim-of-course/Banana-Split#choosing-a-tier-for-a-workflow) for the shipped model and effort combinations: Sol is `gpt-6.1-sol`, Luna is `gpt-6-luna`, and Astra is `gpt-6-astra`. The coordinator defaults to `default-judgment` within the selected tier.

All entries in **every configured tier** are checked against the authenticated Codex App Server model catalog at startup, including tiers you are not using. A missing model or unsupported reasoning/service tier fails with `preset_unavailable`; there is no fallback. Ask Codex to inspect its App Server model catalog and help match `workflow_defaults.preset_tiers` to models and reasoning levels your account advertises. The catalog accepts three or four tiers with the same four preset names, preserving compatibility with older three-tier catalogs. Keep `workflow_defaults.presets`, the legacy flat catalog, consistent with the default tier when editing defaults.

Tell the host the tier you want before starting, for example: "Use the high performance Banana Split tier for this task." The skill maps "high performance" to `performance-optimized`, "max performance" or "maximum performance" to `max-performance`, "cheap" or "cost optimized" to `cost-optimized`, and "default" to `default`. Exact configured tier names take precedence. If a requested tier is absent from a custom or older catalog, the host reports that instead of inventing its definitions.

The host passes the selected tier to `banana_workflow_start` so the coordinator's first turn uses it. Omitting a selection uses the configured default. This does not alter other workflows or the global default. It can later use `banana_workflow_set_tier(workflow_id, tier, preset_tiers?)` to select a tier or replace the workflow catalog. All entries are validated before acceptance, and existing preset names must remain available.

Changes affect new agents immediately and existing agents on their next turn. Running turns retain their current model. Agents cannot change tiers themselves. Polls expose the catalog and active tier; inspection exposes per-turn routing history. These records survive restart. Old workflows without tiers keep their flat preset snapshot until the host supplies a tier catalog containing their preset names. `preset_overrides` applies only to workflows without tiers.

The host's final recap must name the tier or tiers used, any switches, and whether the catalog was configured or overridden for the workflow. It must also report models and reasoning efforts by distinct agent count, keeping the root coordinator separate from subagents. An agent that changes routing can appear in more than one model/effort group but counts once in the total. Use per-turn routing history and observed routing fields for this account; the final active tier alone does not describe earlier turns. If Codex does not confirm a routing field, label it as resolved configuration rather than observed model use. Identify legacy flat catalogs as having no tier, and label unavailable details as unknown.

### Concurrency and permissions

`runtime.scheduler.max_active_turns` defaults to 16 across the whole runtime. Waiting agents use no active-turn slot. This limits simultaneous turns, not total agents, depth, time, tokens or spending. Lower it in startup configuration if you want less concurrency.

The default ceiling allows writes only in the exact workflow workspace, disables network access, and routes approvals to the host. The host uses existing user authorization and asks when authorization is unresolved. Workflow and child restrictions can only narrow the ceiling. Cancellation does not undo filesystem, network, approval or host-side effects.

`runtime.permission_ceiling.mcp_servers: "workspace"` selects enabled servers declared in trusted Codex project configuration layers for the exact workspace at workflow creation. Globally configured servers and Banana host servers are excluded. Later project configuration changes do not expand existing workflows. Use an explicit array for a fixed ceiling or `[]` to allow none. Omission also allows none for older configurations.

Omitted child permission fields inherit the parent's policy. Explicit MCP arrays replace the inherited array and may only remove entries. Widening is rejected. Managed threads disable native delegation, direct Computer Use, apps, plugins, and non-allowlisted MCP servers. The adapter rejects explicit `tools` lists with `app_server_unsupported` because it cannot enforce a generic built-in-tool allowlist; omit that field.

Computer Use is advertised only when both startup configuration and the current host report it available. Omitting the host report advertises nothing. The host claims each request as `in_progress` before acting, then records evidence as `completed`, `declined` or `failed`. After interruption, an in-progress action becomes `uncertain` and must be resolved from evidence before another action is claimed. It is never replayed automatically.

## Changing configuration and updating

Reinstalling the plugin does **not** replace a running runtime. Restarting Codex Desktop alone may reconnect to the old runtime. Use this sequence when changing startup settings or upgrading:

1. In the existing Codex task, ask: "Use `banana_workflow_list` to show all workflows and the runtime PID, executable, data directory and port. Do not start new work." Record the values. Wait for all workflows to finish, or explicitly cancel the work you intend to stop. The runtime can serve multiple workflows.
2. Close Codex Desktop and CLI sessions using Banana Split so they do not restart it during maintenance. Stop the **identified runtime**, using the commands below.
3. Edit the source or extracted package configuration. For a source installation, run `npm run build` from the repository root to regenerate the native package. Keep custom settings backed up outside generated `dist` directories.
4. Reinstall using the commands below. Start a new Codex session in your project, ask for `banana_workflow_list` again, and verify its runtime executable, data directory, port and MCP selection before starting another workflow.

### Stop the identified runtime

Replace `12345` with the PID returned by the runtime list. First check that the executable and command line match the runtime you recorded.

On macOS:

```sh
ps -p 12345 -o pid=,command=
kill -TERM 12345
```

On Windows PowerShell:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId = 12345" |
  Select-Object ProcessId, ExecutablePath, CommandLine
taskkill /PID 12345 /T /F
```

The Windows command forcibly stops that process tree, so settle workflows first. For a runtime started in the foreground for diagnosis, use Ctrl+C instead. Confirm the process has exited before reinstalling. There is no `banana stop` command, and uninstalling alone does not stop the runtime. Do not terminate every `codex` or `banana` process by name.

If MCP startup failed and listing is unavailable, identify the listener on your configured loopback port (default `43891`), then inspect its executable. On macOS use `lsof -nP -iTCP:43891 -sTCP:LISTEN`; on Windows use `Get-NetTCPConnection -LocalPort 43891 -State Listen` and inspect its `OwningProcess` with `Get-CimInstance` as above. A listener may belong to another application.

### Reinstall from the package

If the marketplace source directory is unchanged:

```sh
codex plugin remove banana-split-v1@banana-split-v1
codex plugin add banana-split-v1@banana-split-v1 --json
```

If you moved to a new extracted package, also replace the marketplace source:

```sh
codex plugin remove banana-split-v1@banana-split-v1
codex plugin marketplace remove banana-split-v1
codex plugin marketplace add /absolute/path/to/bun-platform-architecture
codex plugin add banana-split-v1@banana-split-v1 --json
```

Replace the example path with your actual platform folder. Keep that folder for later reinstalls. Removal clears the installed cache, so back up any configuration you edited there first. Durable workflow data lives separately by default and is retained.

For older installations, remove the transient colliding entry `banana-split@banana-split-v1` only if present. The legacy `banana-split@banana-split` entry has a different identity and can coexist; do not remove it unless you intend to uninstall it too.

## Read-only CLI

The installer does not add `banana` to `PATH`. Change to the `installedPath` returned by installation, then run the appropriate executable. Replace the angle-bracket placeholders with IDs from the Codex recap.

macOS:

```sh
./runtime/banana watch <workflow-id> --config ./config/banana.json
./runtime/banana inspect <workflow-id> <agent-id> --config ./config/banana.json
./runtime/banana transcript <workflow-id> <agent-id> --limit 50 --one-page --config ./config/banana.json
```

Windows PowerShell:

```powershell
.\runtime\banana.exe watch <workflow-id> --config .\config\banana.json
.\runtime\banana.exe inspect <workflow-id> <agent-id> --config .\config\banana.json
.\runtime\banana.exe transcript <workflow-id> <agent-id> --limit 50 --one-page --config .\config\banana.json
```

Use `inspect --payloads` only when you need raw task/message payloads. Transcripts support `--cursor <cursor>` for paging; omit `--one-page` to continue through the remaining pages. The CLI connects to an already-running runtime. It cannot start workflows, send messages, approve operations or control agents.

## Troubleshooting

### Build and install problems

| Symptom | Next step |
| --- | --- |
| `bun`, `npm` or `codex` not found | Install the prerequisites linked in the quickstart, reopen your terminal, and confirm the command is on `PATH`. |
| `Unsupported build target: bun-linux-x64` or a Linux App Server error | Use native Windows 11 or macOS. A Windows executable cannot run in a Linux/WSL Codex host. |
| Marketplace not found | Point at the platform folder containing `.agents/plugins/marketplace.json`, not its `plugins/banana-split-v1` subfolder. Check that extraction preserved hidden files. |
| Plugin installed but skill/tools missing | Check `codex plugin list`, enable the plugin if needed, restart Codex and begin a new task. Installation does not prove runtime startup works. |
| A checked-in `banana.exe` is a text file | It is a Git LFS pointer. Build from source or retrieve the LFS object as described in the quickstart. |
| A test reports a 5000 ms timeout on a slow machine | Rerun the named test with `bun test --test-name-pattern 'part of the test name' --timeout 30000`. A slower pass explains that check only; investigate other failures before calling verification successful. |

### Runtime startup and recovery

| Error | Next step |
| --- | --- |
| `runtime_unavailable` | Check the installed executable, `codex` on `PATH`, and loopback port. Use the foreground command below to see the startup error. |
| `preset_unavailable` | Match every preset in every tier to your authenticated App Server's model catalog; see [model configuration](#models-and-preset-tiers). Reinstall and restart after editing. |
| `app_server_unsupported` | Check the detailed message. Update Codex if a required capability is absent, or remove an unenforceable `tools` restriction. Check project trust and MCP configuration if a server is unavailable. |
| `permission_widening` | Narrow the request, or deliberately change startup settings and create a new workflow; an existing permission snapshot cannot be expanded. |
| `persistence_failed` | Stop work and repair permissions or disk space in the exact state directory. Do not edit live state files. |
| `reconciliation_required` | Inspect the retained agent and Codex transcript. Resolve or cancel affected work explicitly; do not assume a retry is safe. |

If no runtime owns the configured data directory and port, start it in the foreground from the installed plugin directory to reveal startup errors:

```sh
# macOS
./runtime/banana runtime --config ./config/banana.json
```

```powershell
# Windows
.\runtime\banana.exe runtime --config .\config\banana.json
```

A successful startup prints `Banana Split runtime listening on 127.0.0.1:43891` (or your configured port). Use Ctrl+C when finished diagnosing. The MCP server normally launches or reconnects automatically. If a runtime already owns the data directory, a second instance fails rather than becoming another writer.

The store alternates two flushed checkpoints and loads the newest valid generation. Queued, waiting, submitted and terminal state is retained after restart. Active turns are reconciled through Codex App Server; ambiguous turns become `reconciliation_required`. Failed or uncertain work is not replayed. A terminal workflow that needs further work requires a new follow-up workflow.

## Disable, uninstall and remove data

To keep the plugin installed but prevent it loading, set this in your user Codex configuration (`~/.codex/config.toml`, or under a custom `CODEX_HOME`), then start a new session:

```toml
[plugins."banana-split-v1@banana-split-v1"]
enabled = false
```

Change an existing section rather than adding a duplicate. Project configuration can override user settings; check the effective state if it still loads. Disabling does not cancel workflows or stop an existing runtime. Set `enabled = true` to enable it again.

To uninstall, settle workflows and stop the runtime as above, then run:

```sh
codex plugin remove banana-split-v1@banana-split-v1
codex plugin marketplace remove banana-split-v1
```

The default state directory is `%LOCALAPPDATA%\BananaSplit` on Windows and `~/Library/Application Support/BananaSplit` on macOS. The shared configuration's `%LOCALAPPDATA%` placeholder maps to macOS Application Support automatically. Windows state inherits profile ACLs; new macOS state directories use owner-only permissions.

To remove retained orchestration data, verify the exact configured `data_directory` and delete it manually after the runtime stops. Codex owns agent conversations separately; deleting Banana state does not delete those threads or undo project changes.
