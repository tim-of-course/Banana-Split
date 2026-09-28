# Banana Split plugin

Current release: **0.1.0 (internal alpha)**. Beta begins at `0.5.0`; `1.0.0` is the first stable release. See the repository README for the versioning policy.

This Windows 11 x64 and macOS plugin installs as `banana-split-v1@banana-split-v1` and packages the Banana Split runtime, distinct `banana-split-v1` host MCP server, and `$banana-split` host-loop skill. Build a native package with `npm run build` in the source repository, then install from the generated `dist/bun-<platform>-<architecture>` marketplace. The checked-in executable is the original Windows release.

The MCP server launches `runtime/banana.exe` on Windows or `runtime/banana` on macOS with `mcp --config config/banana.json`. Edit the startup configuration before starting workflows if the shipped preset catalog or data directory does not fit the installed Codex environment. Only the host can adjust a workflow's active preset tier or tier definitions; other workflow settings remain fixed. Only one runtime may own a configured durable-data directory, even when another process uses a different loopback port.

For build, configuration, operation, recovery, and troubleshooting instructions, see the repository-level `README.md` in the Banana Split source distribution.
