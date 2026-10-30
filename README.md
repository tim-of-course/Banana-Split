# Banana Split

Banana Split is a standalone skill for **optimized deep multi-agent dynamic workflows**, within or across agent systems. Agents coordinate through independent threads: they can delegate recursively, message each other, and review their children's work. A shared directory file records the workflow in your workspace.

Banana Split was previously a Codex plugin. The current skill can work with any agent system in an environment that can start and message independent threads, including across systems such as Claude Code and Codex. It needs no Banana Split plugin, runtime, or MCP server. Available thread tools and models depend on your environment.

Banana Split works best in **T3 Code** for better thread management and cross-agent orchestration. You can also use it elsewhere when your environment supports the required threads and messaging.

## Install

Clone the repository, then copy the skill folder to the user skills directory for the tools you use. Run these commands from the cloned repository:

```sh
git clone https://github.com/tim-of-course/Banana-Split.git
cd Banana-Split

# Codex
mkdir -p ~/.agents/skills
cp -R skill/banana-split ~/.agents/skills/

# Claude Code
mkdir -p ~/.claude/skills
cp -R skill/banana-split ~/.claude/skills/
```

Run only the copy command for each tool you use. On Windows, from PowerShell:

```powershell
git clone https://github.com/tim-of-course/Banana-Split.git
Set-Location Banana-Split

# Codex
New-Item -ItemType Directory -Force "$HOME\.agents\skills" | Out-Null
Copy-Item -Recurse skill\banana-split "$HOME\.agents\skills\banana-split"

# Claude Code
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Copy-Item -Recurse skill\banana-split "$HOME\.claude\skills\banana-split"
```

These commands assume the destination does not already exist. To update an existing installation, pull the latest changes, remove the old installed `banana-split` folder, and copy the folder again. Start a new session if the skill does not appear.

You can also download the repository as a ZIP using GitHub's **Code → Download ZIP**, extract it, and copy `skill/banana-split` to the destinations above.

## Use

Ask for Banana Split explicitly, or ask for subagents or parallel workers. The skill directs the agent to use independent threads for delegation. To use another subagent system instead, say so in your request.

For example:

> Use Banana Split to review this project's onboarding documentation. Keep it read-only and return the most useful improvements.

The skill records workflow progress under `.banana-split/` in the workspace. Its [instructions](skill/banana-split/SKILL.md) explain the workflow, and [model tiers](skill/banana-split/references/tiers.md) list the mixed-provider presets. Optional [Codex-only](tier-options/codex-only.md) and [Claude-only](tier-options/claude-only.md) tier files are available to download and provide as custom tier definitions. If the environment cannot start the required threads or models, the agent will tell you.

## License

[MIT](LICENSE). Earlier versions are available in the repository's Git history.
