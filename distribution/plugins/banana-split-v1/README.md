# Banana Split V1 plugin

This Windows 11 x64 plugin installs as `banana-split-v1@banana-split-v1` and packages the Banana Split runtime, distinct `banana-split-v1` host MCP server, and `$banana-split` host-loop skill.

The MCP server launches `runtime/banana.exe mcp --config config/banana.json`. Edit the startup configuration before starting workflows if the shipped preset catalog or data directory does not fit the installed Codex environment. Active workflow snapshots are immutable. Only one runtime may own a configured durable-data directory, even when another process uses a different loopback port.

For build, configuration, operation, recovery, and troubleshooting instructions, see the repository-level `README.md` in the Banana Split source distribution.
