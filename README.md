# Banana Split

Banana Split is a skill for coordinating work across independent agent threads. Agents can delegate, message each other, and review their children's work. A shared directory file records the workflow in your workspace.

The skill works with Claude Code and Codex in environments that can start and message independent threads. It needs no Banana Split runtime, plugin, or MCP server. The available thread tools and models depend on your environment.

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

The skill records workflow progress under `.banana-split/` in the workspace. Its [instructions](skill/banana-split/SKILL.md) explain the workflow, and [model tiers](skill/banana-split/references/tiers.md) list the available presets. If the environment cannot start the required threads or models, the agent will tell you.

## License

[MIT](LICENSE). Earlier versions are available in the repository's Git history.
