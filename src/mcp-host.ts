import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { RuntimeConfig } from "./model.js";
import { runtimeCall, runtimeOwnerKey } from "./runtime-rpc.js";

const jsonObject = z.record(z.string(), z.unknown());
const message = z.strictObject({ type: z.string().min(1), body: z.string().min(1).optional(), details: jsonObject.optional() });

export async function runMcp(config: RuntimeConfig, configPath: string): Promise<void> {
  await ensureRuntime(config, configPath);
  const server = new McpServer({ name: "banana-split-v1", version: "1.0.0" });
  const call = (name: string, args: Record<string, unknown>) => runtimeCall(config.runtime.listen_port, "host_tool", { name, args }, 65000).then(toolResult);

  server.registerTool("banana_workflow_start", { description: "Start a durable recursive Banana Split workflow in a fresh Codex thread.", inputSchema: z.strictObject({
    task: z.string().min(1), details: jsonObject.optional(), workspace: z.string().min(1), root_preset: z.string().min(1).optional(),
    preset_overrides: z.record(z.string(), z.strictObject({ model: z.string().min(1), reasoning_effort: z.string().min(1), service_tier: z.string().min(1).optional() })).optional(),
    root_permissions: jsonObject.optional(),
    host_capabilities: z.strictObject({ computer_use: z.boolean() }).optional()
  }) }, (args) => call("banana_workflow_start", args));
  server.registerTool("banana_workflow_poll", { description: "Poll a workflow for ordered material events and its current cockpit snapshot.", inputSchema: z.strictObject({
    workflow_id: z.string().min(1), cursor: z.string().min(1).optional(), timeout_ms: z.number().int().min(0).max(60000).optional(), event_limit: z.number().int().min(1).max(200).optional()
  }) }, (args) => call("banana_workflow_poll", args));
  server.registerTool("banana_agent_inspect", { description: "Read one managed agent and optionally one Codex-owned transcript page without resuming it.", inputSchema: z.strictObject({
    workflow_id: z.string().min(1), agent_id: z.string().min(1), include_payloads: z.boolean().optional(), transcript_cursor: z.string().min(1).optional(), transcript_limit: z.number().int().min(1).max(100).optional()
  }) }, (args) => call("banana_agent_inspect", args));
  server.registerTool("banana_workflow_list", { description: "List retained workflows.", inputSchema: z.strictObject({ statuses: z.array(z.enum(["running", "attention_required", "cancelling", "completed", "failed", "cancelled"])).optional() }) }, (args) => call("banana_workflow_list", args));
  server.registerTool("banana_workflow_send", { description: "Send new host context to one eligible managed agent.", inputSchema: z.strictObject({ workflow_id: z.string().min(1), agent_id: z.string().min(1), message }) }, (args) => call("banana_workflow_send", args));
  server.registerTool("banana_workflow_control", { description: "Freeze or reopen spawning, or cancel a subtree or workflow.", inputSchema: z.strictObject({
    workflow_id: z.string().min(1), action: z.enum(["freeze_spawning", "reopen_spawning", "cancel_subtree", "cancel_workflow"]), agent_id: z.string().min(1).optional()
  }) }, (args) => call("banana_workflow_control", args));
  server.registerTool("banana_approval_respond", { description: "Relay an explicit trusted host/user decision to a pending Codex approval.", inputSchema: z.strictObject({
    workflow_id: z.string().min(1), approval_id: z.string().min(1), decision: z.unknown(), details: jsonObject.optional()
  }) }, (args) => call("banana_approval_respond", args));
  server.registerTool("banana_host_respond", { description: "Claim or resolve a correlated managed-agent Computer Use request.", inputSchema: z.strictObject({
    workflow_id: z.string().min(1), request_id: z.string().min(1), status: z.enum(["in_progress", "completed", "declined", "failed"]), summary: z.string().min(1).optional(), details: jsonObject.optional()
  }) }, (args) => call("banana_host_respond", args));

  await server.connect(new StdioServerTransport());
}

async function ensureRuntime(config: RuntimeConfig, configPath: string): Promise<void> {
  const expectedOwner = runtimeOwnerKey(config.runtime.data_directory);
  try {
    const ping = await runtimeCall(config.runtime.listen_port, "ping", {}, 1000);
    if (ping.ok === true) {
      if (ping.owner_key !== expectedOwner) throw new Error("runtime_unavailable: 127.0.0.1:" + config.runtime.listen_port + " belongs to a different Banana Split data directory");
      return;
    }
  } catch (error) {
    if (String(error).includes("belongs to a different Banana Split data directory")) throw error;
  }
  const sourceMode = /(?:bun|node)(?:\.exe)?$/i.test(process.execPath);
  const args = sourceMode ? [fileURLToPath(new URL("./index.ts", import.meta.url)), "runtime", "--config", configPath] : ["runtime", "--config", configPath];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true }); child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const ping = await runtimeCall(config.runtime.listen_port, "ping", {}, 1000);
      if (ping.ok === true && ping.owner_key === expectedOwner) return;
      if (ping.ok === true) throw new Error("runtime_unavailable: 127.0.0.1:" + config.runtime.listen_port + " belongs to a different Banana Split data directory");
    } catch (error) {
      if (String(error).includes("belongs to a different Banana Split data directory")) throw error;
    }
  }
  throw new Error("runtime_unavailable: Banana Split runtime did not start within 15 seconds");
}

function toolResult(value: Record<string, unknown>): { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown>; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) };
}
