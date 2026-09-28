import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { RuntimeConfig } from "./model.js";
import { runtimeCall, runtimeOwnerKey } from "./runtime-rpc.js";

const jsonObject = z.record(z.string(), z.unknown());
const workflowId = z.string().min(1).describe("Copy the returned workflow_id or its unique short_id unchanged from the start result, list, or snapshot.");
const agentId = z.string().min(1).describe("Copy the returned agent_id or its unique short_id unchanged from the snapshot or inspection result.");
const presetSchema = z.strictObject({ model: z.string().min(1), reasoning_effort: z.string().min(1), service_tier: z.string().min(1).optional() });
const tiersSchema = z.record(z.string().min(1), z.record(z.string().min(1), presetSchema));
const message = z.strictObject({ type: z.string().min(1), body: z.string().min(1).optional(), details: jsonObject.optional() });
const permissions = z.strictObject({ sandbox: z.enum(["readOnly", "workspaceWrite"]).optional(), writable_roots: z.array(z.string().min(1)).optional(),
  network_access: z.boolean().optional(), tools: z.array(z.string().min(1)).optional().describe("Omit this field to inherit built-in tools. Any explicit list returns app_server_unsupported because the current App Server cannot enforce a built-in tool allowlist. This field does not select Banana tools."), mcp_servers: z.array(z.string().min(1)).optional() });

export async function runMcp(config: RuntimeConfig, configPath: string): Promise<void> {
  await ensureRuntime(config, configPath);
  const server = new McpServer({ name: "banana-split-v1", version: "0.1.0" });
  const call = (name: string, args: Record<string, unknown>) => runtimeCall(config.runtime.listen_port, "host_tool", { name, args }, 65000).then(toolResult);

  server.registerTool("banana_workflow_start", { description: "Start a durable recursive Banana Split workflow in a fresh Codex thread. Omit root_preset to use the configured default.", inputSchema: z.strictObject({
    task: z.string().min(1).describe("Describe the managed root assignment, starting with a short objective. The first 96 characters become its visible thread name. Keep host polling, post-run transcript verification, and the host report out of this task; the root calls banana_finish before the host verifies the terminal workflow."), details: jsonObject.optional().describe("Optional structured assignment context delivered unchanged to the root alongside task. Put custom fields such as manifests inside details; additional top-level arguments are rejected. Fresh children receive only the details and brief their parent explicitly supplies. Keep host-owned report paths out of root deliverables and allowed outputs."), workspace: z.string().min(1).describe("Use the exact workspace requested by the user, including a requested subdirectory. This becomes managed threads' working directory; writable_roots do not change it."), root_preset: z.string().min(1).optional().describe("Configured preset name. Omit this field to use the configured default."),
    preset_overrides: z.record(z.string(), z.strictObject({ model: z.string().min(1), reasoning_effort: z.string().min(1), service_tier: z.string().min(1).optional() })).optional(),
    tier: z.string().min(1).optional().describe("Pass the user's requested tier in this initial call so the first root turn uses it. Omission uses configured default_tier; later tier changes affect only subsequent turns. Agents can choose only the active tier's four presets."),
    preset_tiers: tiersSchema.optional().describe("Exactly three tiers, each with the same four preset names. Replaces configured tiers for this workflow."),
    root_permissions: permissions.optional(),
    host_capabilities: z.strictObject({ computer_use: z.boolean() }).optional()
  }) }, (args) => call("banana_workflow_start", args));
  server.registerTool("banana_workflow_set_tier", { description: "Host-only: select the active tier and optionally replace this workflow's three tier definitions. Applies to new agents and existing agents' next turns; running turns are not interrupted.", inputSchema: z.strictObject({
    workflow_id: workflowId, tier: z.string().min(1), preset_tiers: tiersSchema.optional()
  }) }, (args) => call("banana_workflow_set_tier", args));
  server.registerTool("banana_workflow_poll", { description: "Poll ordered events, current state, and runtime diagnostic counts. Inspect requested operations and resolve pending approvals using existing authorization before unrelated transcript reviews or status nudges. pending_context normally awaits the spawning parent's turn completion.", inputSchema: z.strictObject({
    workflow_id: workflowId,
    cursor: z.string().min(1).optional().describe("Omit for the first poll. Otherwise pass the cursor returned by the previous poll for this workflow unchanged as a string, never a number."),
    timeout_ms: z.number().int().min(0).max(60000).optional(),
    event_limit: z.number().int().min(1).max(200).optional().describe("Return 1 to 200 events per page; defaults to 50. When has_more is true, continue with the returned cursor.")
  }) }, (args) => call("banana_workflow_poll", args));
  server.registerTool("banana_agent_inspect", { description: "Read one managed agent and optionally one Codex-owned transcript page without resuming it.", inputSchema: z.strictObject({
    workflow_id: workflowId, agent_id: agentId, include_payloads: z.boolean().optional(), transcript_cursor: z.string().min(1).optional().describe("Omit for the first page or when switching agents. Otherwise pass next_transcript_cursor returned for this same agent; null means there is no further page currently."), transcript_limit: z.number().int().min(1).max(100).optional().describe("Request a transcript page of 1 to 100 items. Follow next_transcript_cursor for more items; a cursor without a limit uses 20.")
  }) }, (args) => call("banana_agent_inspect", args));
  server.registerTool("banana_workflow_list", { description: "List retained workflows.", inputSchema: z.strictObject({ statuses: z.array(z.enum(["running", "attention_required", "cancelling", "completed", "failed", "cancelled"])).optional() }) }, (args) => call("banana_workflow_list", args));
  server.registerTool("banana_workflow_send", { description: "Send new host context to one eligible managed agent.", inputSchema: z.strictObject({ workflow_id: workflowId, agent_id: agentId, message }) }, (args) => call("banana_workflow_send", args));
  server.registerTool("banana_workflow_control", { description: "Freeze or reopen spawning, or cancel a subtree or workflow.", inputSchema: z.strictObject({
    workflow_id: workflowId, action: z.enum(["freeze_spawning", "reopen_spawning", "cancel_subtree", "cancel_workflow"]), agent_id: agentId.optional()
  }) }, (args) => call("banana_workflow_control", args));
  server.registerTool("banana_approval_respond", { description: "Relay a trusted host/user decision after inspecting the actual requested operation against authorization. For file changes, inspect request.file_changes paths and diff from the native proposal. For command/file approvals, decline rejects only the operation and lets the agent continue; cancel interrupts the agent and its subtree. Host details are retained for inspection, not delivered as agent context. Other approval types require details.response as shown in the attention item.", inputSchema: z.strictObject({
    workflow_id: workflowId, approval_id: z.string().min(1), decision: z.unknown().describe('For command/file approvals, pass a decision value directly, for example "accept", "acceptForSession", "decline", or "cancel". Native command amendment objects are also supported. Other approval types use details.response according to request.response_contract.'), details: jsonObject.optional()
  }) }, (args) => call("banana_approval_respond", args));
  server.registerTool("banana_host_respond", { description: "Claim or resolve a correlated managed-agent Computer Use request.", inputSchema: z.strictObject({
    workflow_id: workflowId, request_id: z.string().min(1), status: z.enum(["in_progress", "completed", "declined", "failed"]), summary: z.string().min(1).optional(), details: jsonObject.optional()
  }) }, (args) => call("banana_host_respond", args));

  await server.connect(new StdioServerTransport());
}

export async function ensureRuntime(config: RuntimeConfig, configPath: string): Promise<void> {
  const expectedOwner = runtimeOwnerKey(config.runtime.data_directory);
  let starting = false;
  try {
    const ping = await runtimeCall(config.runtime.listen_port, "ping", {}, 1000);
    if (ping.owner_key !== expectedOwner) throw new Error("runtime_unavailable: 127.0.0.1:" + config.runtime.listen_port + " belongs to a different Banana Split data directory");
    if (ping.ok === true) return;
    starting = ping.state === "starting";
  } catch (error) {
    if (String(error).includes("belongs to a different Banana Split data directory")) throw error;
  }
  let startupError: Error | undefined;
  if (!starting) {
    const sourceMode = /(?:bun|node)(?:\.exe)?$/i.test(process.execPath);
    const args = sourceMode ? [fileURLToPath(new URL("./index.ts", import.meta.url)), "runtime", "--config", configPath] : ["runtime", "--config", configPath];
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true }); child.unref();
    child.once("error", error => { startupError = error });
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (startupError) throw new Error(`runtime_unavailable: could not launch ${process.execPath}: ${startupError.message}`);
    try {
      const ping = await runtimeCall(config.runtime.listen_port, "ping", {}, 1000);
      if (ping.ok === true && ping.owner_key === expectedOwner) return;
      if (ping.owner_key !== expectedOwner) throw new Error("runtime_unavailable: 127.0.0.1:" + config.runtime.listen_port + " belongs to a different Banana Split data directory");
    } catch (error) {
      if (String(error).includes("belongs to a different Banana Split data directory")) throw error;
    }
  }
  throw new Error("runtime_unavailable: Banana Split runtime did not start within 15 seconds");
}

function toolResult(value: Record<string, unknown>): { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown>; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) };
}
