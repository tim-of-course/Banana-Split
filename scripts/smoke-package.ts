import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Exercise the shipped executable and MCP manifest without authentication or a model turn.
const root = resolve(process.argv[2] ?? `dist/bun-linux-x64`);
const marketplace = JSON.parse(readFileSync(resolve(root, ".agents/plugins/marketplace.json"), "utf8"));
const entry = marketplace.plugins.find((plugin: { name: string }) => plugin.name === "banana-split-v1");
assert(entry, "Archive must include the Banana Split marketplace entry");
const plugin = resolve(root, entry.source.path);
const manifest = JSON.parse(readFileSync(resolve(plugin, ".mcp.json"), "utf8"));
const server = manifest.mcpServers["banana-split-v1"];
const command = resolve(plugin, server.command);
const help = Bun.spawnSync([command, "--help"], { stdout: "pipe", stderr: "pipe" });
assert.equal(help.exitCode, 0, help.stderr.toString());
assert(help.stdout.toString().includes("Banana Split V1"));

const dataHome = mkdtempSync(resolve(tmpdir(), "banana-package-smoke-"));
const transport = new StdioClientTransport({ command, args: server.args,
  cwd: resolve(plugin, server.cwd), env: { ...getDefaultEnvironment(), XDG_DATA_HOME: dataHome }, stderr: "pipe" });
let stderr = "";
transport.stderr?.on("data", chunk => { stderr += String(chunk) });
const client = new Client({ name: "banana-package-smoke", version: "1.0.0" });
try {
  await client.connect(transport, { timeout: 5000 });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 9);
  assert(tools.some(tool => tool.name === "banana_workflow_start"));
  assert(tools.some(tool => tool.name === "banana_workflow_poll"));
  assert(!existsSync(resolve(dataHome, "BananaSplit")), "Discovery must not launch a runtime");
  console.log("Packaged executable and MCP discovery passed (9 tools; no runtime or model turn).");
} catch (error) {
  throw new Error(`${String(error)}\n${stderr}`);
} finally {
  await client.close();
  await transport.close();
  rmSync(dataHome, { recursive: true, force: true });
}
