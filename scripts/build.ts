import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = process.argv[2] ?? `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
if (!["bun-windows-x64", "bun-darwin-arm64", "bun-darwin-x64"].includes(target)) {
  throw new Error(`Unsupported build target: ${target}`);
}
const executable = target === "bun-windows-x64" ? "banana.exe" : "banana";
const root = resolve("dist", target);
const plugin = resolve(root, "plugins/banana-split-v1");
// Replace only this generated package so rebuilds cannot retain stale metadata.
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
cpSync("distribution", root, { recursive: true, filter: (source) => !source.endsWith("banana.exe") });
mkdirSync(resolve(plugin, "docs"), { recursive: true });
cpSync("docs/OPERATIONS.md", resolve(plugin, "docs/OPERATIONS.md"));
cpSync("config/banana.schema.json", resolve(plugin, "config/banana.schema.json"));
cpSync("LICENSE", resolve(plugin, "LICENSE"));
const result = Bun.spawnSync([process.execPath, "build", "--compile", `--target=${target}`, "--outfile", resolve(plugin, "runtime", executable), "src/index.ts"], { stdout: "inherit", stderr: "inherit" });
if (result.exitCode !== 0) process.exit(result.exitCode);
chmodSync(resolve(plugin, "runtime", executable), 0o755);
const mcpPath = resolve(plugin, ".mcp.json");
const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
mcp.mcpServers["banana-split-v1"].command = `./runtime/${executable}`;
writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
console.log(`Install with:\n  codex plugin marketplace add ${root}\n  codex plugin add banana-split-v1@banana-split-v1`);
