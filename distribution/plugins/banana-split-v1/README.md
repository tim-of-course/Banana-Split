# Banana Split plugin

Current release: **0.1.1 (internal alpha)**. Supported on Windows 11 x64 and macOS (Apple Silicon and Intel). Linux and WSL are not supported.

Banana Split lets Codex delegate a large task to agents that can create further agents, exchange advice, and review their children's work. It saves workflow state locally and keeps progress in your main Codex conversation.

## Install and try it

Follow the [repository quickstart](https://github.com/tim-of-course/Banana-Split#quickstart) to install a platform package as `banana-split-v1@banana-split-v1`. The package includes the runtime, nine host MCP tools under `banana-split-v1`, and one `$banana-split` skill. Compiled packages need an authenticated Codex CLI on `PATH`; Node and Bun are needed only to build from source.

After installation, restart Codex and open a new task in your project. Try:

```text
Use $banana-split to review this project's onboarding documentation.
Use a read-only workflow in the current workspace. Have one coordinator
delegate to two fresh reviewers: one for installation instructions and one
for first-use examples. Do not modify files or run setup commands.
Return three concrete improvements, the workflow ID, and its final status.
```

Expect progress updates, findings, a workflow ID and a final status. The recap includes the tier or tiers used, switches or custom overrides, and models and reasoning efforts, with the coordinator counted separately from subagents. It distinguishes resolved configuration from model use confirmed by Codex. This uses model capacity on your Codex account. The default permits 16 simultaneous model turns across workflows; it does not limit total agents or spending.

## Choose a workflow tier

Say **"Use the high performance Banana Split tier"** to select `performance-optimized`, or **"Use the max performance Banana Split tier"** to select `max-performance`. "Cheap" selects `cost-optimized`; "default" selects `default`, which is also the shipped initial selection. Exact configured names work too. Choose before starting so the coordinator's first turn uses the requested tier. You can ask to switch an existing workflow; the change applies to new agents and subsequent turns.

Each tier supplies four presets using `gpt-6.1-sol` (Sol), `gpt-6-luna` (Luna), or `gpt-6-astra` (Astra). See the [tier comparison](https://github.com/tim-of-course/Banana-Split#choosing-a-tier-for-a-workflow) for every model and effort combination. The coordinator defaults to `default-judgment` within its selected tier.

## Delegation defaults

While enabled, the skill is eligible to activate for requests involving subagents, parallel workers or delegation even if you do not name Banana Split. Say **"use native Codex subagents"** when you want native delegation. Startup failure is reported rather than silently falling back. Read the full [host skill](skills/banana-split/SKILL.md) for its operating contract.

## Configuration and help

The installed runtime reads `config/banana.json` at startup. All configured model presets must be available to your Codex account. Editing the source or extracted package does not change Codex's installed copy, and reinstalling does not replace an already-running runtime.

The MCP server is optional for Codex startup. It starts the runtime on the first Banana tool call; configuration and runtime failures return tool errors while ordinary chats remain available. Startup errors include recent diagnostics and the path to `runtime.log` in the configured data directory. Fix the cause and retry the tool in the same chat. A lost response may have side effects, so inspect retained workflows before repeating a command.

Built packages include `docs/OPERATIONS.md`, `config/banana.schema.json` and `LICENSE`. Use the [online operations guide](https://github.com/tim-of-course/Banana-Split/blob/main/docs/OPERATIONS.md) when browsing this source template. It explains which configuration to edit, how to restart and reinstall, troubleshooting, and removal.

The MCP server launches `runtime/banana.exe` on Windows or `runtime/banana` on macOS with `mcp --config config/banana.json`. The separate CLI provides read-only inspection; it cannot start or cancel workflows. The checked-in Windows executable is a historical Git LFS object; use a newly built or released platform package.
