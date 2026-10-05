import { resolve } from "node:path";
import { AppServer } from "./app-server.js";
import { readConfig } from "./config.js";
import { Engine } from "./engine.js";
import type { JsonObject } from "./model.js";
import { runMcp } from "./mcp-host.js";
import { RuntimeOwner, runtimeCall } from "./runtime-rpc.js";
import { Store } from "./store.js";

const args = process.argv.slice(2);
const command = args[0];
const configPath = resolve(option(args, "--config") ?? process.env.BANANA_CONFIG ?? "config/banana.json");

try {
  if (command === "runtime") await runtime(configPath);
  else if (command === "mcp") await runMcp(configPath);
  else if (command === "watch") await watch(configPath, positional(args, 1, "workflow"));
  else if (command === "inspect") await inspect(configPath, positional(args, 1, "workflow"), positional(args, 2, "agent"));
  else if (command === "transcript") await transcript(configPath, positional(args, 1, "workflow"), positional(args, 2, "agent"));
  else if (!command || command === "--help" || command === "-h") usage();
  else { usage(); process.exitCode = 2 }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
}

async function runtime(path: string): Promise<void> {
  const config = readConfig(path);
  const owner = new RuntimeOwner(config.runtime.listen_port, config.runtime.data_directory);
  await owner.listen();
  const app = new AppServer(config.runtime.codex_command, config.runtime.listen_port + 1);
  try {
    const store = new Store(config.runtime.data_directory);
    const engine = new Engine(config, store, app); await engine.initialize(); owner.attach(engine);
    process.stderr.write(`Banana Split runtime listening on 127.0.0.1:${config.runtime.listen_port}\n`);
    await owner.wait();
  } catch (error) {
    await owner.close();
    throw error;
  } finally { await app.stop() }
}

async function watch(path: string, workflow: string): Promise<void> {
  const config = readConfig(path); let cursor: string | undefined;
  for (;;) {
    const result = await host(config.runtime.listen_port, "banana_workflow_poll", { workflow_id: workflow, ...(cursor ? { cursor, timeout_ms: 30000 } : { timeout_ms: 0 }) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.ok === false || terminalStatus((result.snapshot as JsonObject | undefined)?.status)) return;
    cursor = String(result.cursor);
  }
}

async function inspect(path: string, workflow: string, agent: string): Promise<void> {
  const config = readConfig(path);
  const result = await host(config.runtime.listen_port, "banana_agent_inspect", { workflow_id: workflow, agent_id: agent, include_payloads: args.includes("--payloads") });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok === false) process.exitCode = 1;
}

async function transcript(path: string, workflow: string, agent: string): Promise<void> {
  const config = readConfig(path); let cursor = option(args, "--cursor"); const limit = Number(option(args, "--limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be 1-100");
  do {
    const result = await host(config.runtime.listen_port, "banana_agent_inspect", { workflow_id: workflow, agent_id: agent, transcript_limit: limit, ...(cursor ? { transcript_cursor: cursor } : {}) });
    if (result.ok === false) { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exitCode = 1; return }
    const transcriptValue = result.transcript as JsonObject;
    for (const item of (transcriptValue.data ?? []) as unknown[]) process.stdout.write(`${JSON.stringify(item)}\n`);
    cursor = typeof transcriptValue.next_transcript_cursor === "string" ? transcriptValue.next_transcript_cursor : undefined;
  } while (cursor && !args.includes("--one-page"));
}

async function host(port: number, name: string, toolArgs: JsonObject): Promise<JsonObject> {
  return runtimeCall(port, "host_tool", { name, args: toolArgs });
}

function option(values: string[], name: string): string | undefined { const index = values.indexOf(name); return index >= 0 ? values[index + 1] : undefined }
function positional(values: string[], position: number, name: string): string {
  const filtered: string[] = [];
  for (let index = 0; index < values.length; index++) { if (values[index]!.startsWith("--")) { if (!["--payloads", "--one-page"].includes(values[index]!)) index++; continue } filtered.push(values[index]!) }
  const value = filtered[position]; if (!value) throw new Error(`${name} is required`); return value;
}
function terminalStatus(value: unknown): boolean { return ["completed", "failed", "cancelled"].includes(String(value)) }
function usage(): void {
  process.stdout.write("Banana Split V1\n\nRead-only CLI:\n  banana watch <workflow> [--config PATH]\n  banana inspect <workflow> <agent> [--payloads] [--config PATH]\n  banana transcript <workflow> <agent> [--cursor CURSOR] [--limit 1-100] [--one-page] [--config PATH]\n");
}
