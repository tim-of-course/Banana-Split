# Banana Split

Let Codex split a large task among agents that can delegate further, ask each other for advice, and review their children's work before returning a result. You stay in one Codex conversation while Banana Split tracks the work and saves its progress locally.

For example, a coordinator can assign implementation and testing to separate agents, ask a reviewer to check the result, and send changes back to the original worker. Each agent has its own Codex thread. Children can start fresh or inherit their parent's completed conversation history.

**Current release: 0.1.1, internal alpha.** Intended for supervised use on **Windows 11 x64 or macOS (Apple Silicon and Intel)**. Linux and WSL are not supported. See the [release notes](docs/releases/0.1.1.md) and [verification guide](docs/VERIFICATION.md) for the limits of the existing evidence.

## When to use it

Banana Split adds a persistent workflow record, a runtime-wide concurrency limit, recursive delegation, and explicit parent review to a Codex task. It is useful for work with several phases or many related assignments whose messages, reviews, and partial results need to remain inspectable across a runtime restart.

For a small task that only needs a helper, native Codex subagents may be sufficient. Banana Split adds a local runtime and configuration to manage. Recovery preserves workflow state; it does not guarantee that every interrupted model turn can resume automatically.

**Enabling the plugin changes delegation defaults.** Its `$banana-split` skill is eligible to activate when you ask for subagents, parallel workers, or delegation, even without naming Banana Split. To request the native mechanism, say **"use native Codex subagents"**. If Banana Split cannot start, the skill reports the failure instead of silently switching mechanisms. Ordinary tasks do not require a Banana workflow.

Banana Split starts its runtime when you first use a Banana tool. Startup failures, including an outdated Codex CLI, are reported by that tool and leave ordinary Codex chats available. See [startup troubleshooting](docs/OPERATIONS.md#runtime-startup-and-recovery) for diagnostic logs and recovery.

## Quickstart

### 1. Check your setup

You need a supported OS and an authenticated [Codex CLI](https://developers.openai.com/codex/cli/) available on `PATH`. Codex Desktop is optional for ordinary coding workflows; host Computer Use requires a host that provides it.

Run these in the terminal you will use for installation:

```sh
codex --version
codex login status
codex plugin --help
```

If you are signed out, run `codex login`. If `plugin` is not recognized, update Codex using its installation instructions. Your account must also support the models and reasoning levels in the [packaged configuration](distribution/plugins/banana-split-v1/config/banana.json); see [model configuration](docs/OPERATIONS.md#models-and-preset-tiers) if startup reports `preset_unavailable`.

### 2. Get a package

Check [GitHub Releases](https://github.com/tim-of-course/Banana-Split/releases) for a platform archive. Release packaging is provided by this repository, but an archive is available only after a maintainer publishes it. If the release has no matching asset, use the source-build instructions below. GitHub's automatic **Source code** downloads are not runnable plugin packages.

| Computer | Release archive | Folder created by extraction |
| --- | --- | --- |
| Windows 11 x64 | `banana-split-<version>-windows-x64.tar.gz` | `bun-windows-x64` |
| Mac with Apple Silicon | `banana-split-<version>-darwin-arm64.tar.gz` | `bun-darwin-arm64` |
| Mac with Intel | `banana-split-<version>-darwin-x64.tar.gz` | `bun-darwin-x64` |

Extract the archive in a directory you intend to keep. For example, in PowerShell or a macOS terminal, replace the filename with the downloaded asset:

```sh
tar -xzf banana-split-<version>-<platform>-<architecture>.tar.gz
```

Each folder contains a `.agents` marketplace directory and a `plugins` directory. Keep both, including hidden files. A compiled package needs Codex, but does not need Node or Bun installed. Packages are unsigned; if your OS blocks a downloaded executable, use the source-build route or your organization's approved process.

<details>
<summary>Build from source instead</summary>

Install [Git](https://git-scm.com/downloads), [Node.js with npm](https://nodejs.org/en/download), and [Bun 1.3 or newer](https://bun.sh/get), then run:

```sh
git clone https://github.com/tim-of-course/Banana-Split.git
cd Banana-Split
npm ci
npm run verify
```

`verify` bundles the source, runs the tests, and builds the package for your computer under `dist/bun-<platform>-<architecture>/`. Use that folder in the next step. It does not run a live model workflow. If a test times out, see [build troubleshooting](docs/OPERATIONS.md#build-and-install-problems).

The old Windows executable under `distribution/` uses [Git LFS](https://git-lfs.com/). Building from source replaces it, so you do not need to download that LFS object. If you intentionally need the historical binary, install Git LFS and run `git lfs pull`. A small text file beginning with `version https://git-lfs.github.com/spec/v1` is a pointer, not an executable. Install the newly built package from `dist`, not the historical package from `distribution`.

</details>

### 3. Install in Codex

From the directory containing your extracted platform folder, run the commands for your computer. For a source build, first run `cd dist` from the repository root.

**Windows PowerShell:**

```powershell
codex plugin marketplace add .\bun-windows-x64
codex plugin add banana-split-v1@banana-split-v1 --json
codex plugin list
```

**Apple Silicon macOS:**

```sh
codex plugin marketplace add ./bun-darwin-arm64
codex plugin add banana-split-v1@banana-split-v1 --json
codex plugin list
```

On Intel macOS, replace `bun-darwin-arm64` with `bun-darwin-x64`.

The install output includes `installedPath`; keep it for troubleshooting. Confirm the plugin is installed and enabled. Restart Codex Desktop, or exit and reopen the CLI, then open a **new task in the project you want to work on**. Codex loads an installed copy of the package; editing the download or source alone does not update that copy. See [changing configuration and updating](docs/OPERATIONS.md#changing-configuration-and-updating).

### 4. Run a small first task

Paste this into the new Codex task:

```text
Use $banana-split to review this project's onboarding documentation.
Use a read-only workflow in the current workspace. Have one coordinator
delegate to two fresh reviewers: one for installation instructions and one
for first-use examples. Do not modify files or run setup commands.
Return three concrete improvements, the workflow ID, and its final status.
```

Codex should start a workflow, report progress, review the two submissions, and return the findings with a workflow ID, root agent ID, and completion status. Its recap should include the tier, models and reasoning efforts used, distinguishing the root coordinator from the two reviewers. You do not need to call MCP tools or manage polling yourself. This task uses your Codex account's model capacity.

If the skill or tools are missing, confirm the plugin is enabled and start a new Codex session. If startup fails, use the [troubleshooting guide](docs/OPERATIONS.md#troubleshooting). A completed workflow describes the execution state; assess the actual findings before treating the task as successful.

## Everyday use

Give Codex your objective, the exact workspace, and any constraints. For example:

- "Use Banana Split to implement this feature, with separate implementation and review work."
- "Use Banana Split's cost-optimized tier to review these modules. Do not change files."
- "Show the status and blockers for workflow `<workflow-id>`."
- "Freeze new spawning for workflow `<workflow-id>`." Existing work continues.
- "Cancel workflow `<workflow-id>`." Cancellation does not undo changes already made.

The plugin provides **one host skill and nine host MCP tools**. The main Codex task coordinates your request through them. Managed agents use separate coordination tools and share the specified workspace; they do not get separate working copies automatically. There is no dashboard. Optional terminal inspection is covered in [the operations guide](docs/OPERATIONS.md#read-only-cli).

### Choosing a tier for a workflow

Include the tier in your request: **"Use the high performance Banana Split tier to review this feature."** Codex selects `performance-optimized` before the coordinator's first turn. Say **"Use the max performance Banana Split tier"** for `max-performance`, **"use the cheap tier"** for `cost-optimized`, or **"use the default tier"** for `default`. Exact configured tier names also work. With no selection, the shipped configuration uses `default`.

Each tier provides four agent presets. Agents choose a preset for their assignment; the tier determines its model and reasoning effort:

| Agent preset | `cost-optimized` | `default` | `performance-optimized` | `max-performance` |
| --- | --- | --- | --- | --- |
| Complex judgment | Sol · xhigh | Astra · xhigh | Astra · xhigh | Astra · ultra |
| Default judgment | Sol · high | Sol · high | Astra · xhigh | Astra · ultra |
| General workhorse | Sol · medium | Sol · medium | Astra · low | Astra · xhigh |
| Defined workhorse | Luna · xhigh | Sol · low | Sol · medium | Astra · low |

**Sol** is `gpt-6.1-sol`, **Luna** is `gpt-6-luna`, and **Astra** is `gpt-6-astra`. The coordinator uses `default-judgment` unless you request another configured preset.

The selection applies to that workflow. You can later say **"Switch this workflow to max-performance."** New agents and subsequent turns use the new tier; already-running turns keep their settings. The final recap includes all tiers used, any switches or custom catalog overrides, and model/effort counts with the root coordinator separate from subagents. It distinguishes recorded configuration from model use confirmed by Codex when confirmation is available. See [model configuration](docs/OPERATIONS.md#models-and-preset-tiers) to customize the catalog.

## Defaults to know

- Up to **16 model turns can run at once across all workflows**. This is not a total-agent or spending limit: depth and agent population are unbounded. Start with a small task and reduce concurrency in the configuration if needed.
- Agents can write to the exact workflow workspace by default. Network access is disabled. The host resolves approvals using existing user authorization and asks when authorization is unresolved.
- Managed threads disable native delegation, direct Computer Use, apps, and plugins. Enabled MCP servers declared in the workspace's trusted project configuration can be selected; globally configured servers are not automatically included.
- Computer Use runs through the main host only when that host can provide it. A request interrupted during execution is not replayed automatically.
- State stays on your computer until you remove it: `%LOCALAPPDATA%\BananaSplit` on Windows or `~/Library/Application Support/BananaSplit` on macOS.

See [configuration, model tiers, updates, recovery and removal](docs/OPERATIONS.md) for the full instructions.

## Documentation and contributing

- [Operations guide](docs/OPERATIONS.md): configuration, restart, inspection and troubleshooting.
- [Host skill](distribution/plugins/banana-split-v1/skills/banana-split/SKILL.md): the instructions Codex follows.
- [V1 specification](docs/BANANA_SPLIT_V1_SPEC.md): the normative design and tool contract for implementers.
- [Verification guide](docs/VERIFICATION.md): how to interpret the historical test reports.
- [Contributing](CONTRIBUTING.md) and [release packaging](docs/RELEASING.md).
- [Security reporting](SECURITY.md).

## Versioning and license

`0.1.0` is the initial internal alpha; beta begins at `0.5.0`, and `1.0.0` is the first stable release. During `0.x`, patch versions cover fixes and minor versions cover meaningful features or breaking changes. From `1.0.0`, use [Semantic Versioning](https://semver.org/). Breaking changes belong in release notes.

Minor versions are integers: `0.10.0` follows `0.9.0` if needed. Local builds may append `+codex.<timestamp>` metadata. The `banana-split-v1` plugin ID, V1 specification, and configuration/state schema versions are independent of release numbering.

Banana Split is available under the [MIT License](LICENSE).
