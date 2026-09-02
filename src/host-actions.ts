import { statSync } from "node:fs";
import type { Engine, ToolResult } from "./engine.js";
import { label } from "./engine.js";
import type { AgentRecord, HostRequest, JsonObject, Preset, WorkflowRecord } from "./model.js";
import { failure, now } from "./model.js";

export async function handleHostTool(engine: Engine, name: string, args: JsonObject): Promise<ToolResult> {
  switch (name) {
    case "banana_workflow_start": return workflowStart(engine, args);
    case "banana_workflow_poll": return workflowPoll(engine, args);
    case "banana_agent_inspect": return agentInspect(engine, args);
    case "banana_workflow_list": return workflowList(engine, args);
    case "banana_workflow_send": return workflowSend(engine, args);
    case "banana_workflow_control": return workflowControl(engine, args);
    case "banana_approval_respond": return approvalRespond(engine, args);
    case "banana_host_respond": return hostRespond(engine, args);
    default: return failure("invalid_input", `Unknown Banana host tool: ${name}`);
  }
}

async function workflowStart(engine: Engine, args: JsonObject): Promise<ToolResult> {
  exact(args, ["task", "details", "workspace", "root_preset", "preset_overrides", "root_permissions", "host_capabilities"], "banana_workflow_start");
  const task = text(args.task, "task"); const workspace = text(args.workspace, "workspace");
  if (!statSync(workspace).isDirectory()) throw new Error("workspace must be an existing directory");
  const presets = structuredClone(engine.config.workflow_defaults.presets);
  if (args.preset_overrides !== undefined) {
    const overrides = object(args.preset_overrides, "preset_overrides");
    for (const [name, raw] of Object.entries(overrides)) {
      const value = object(raw, `preset override ${name}`);
      exact(value, ["model", "reasoning_effort", "service_tier"], `preset override ${name}`);
      const preset: Preset = { model: text(value.model, `${name}.model`), reasoning_effort: text(value.reasoning_effort, `${name}.reasoning_effort`) };
      if (value.service_tier !== undefined) preset.service_tier = text(value.service_tier, `${name}.service_tier`);
      presets[name] = preset;
    }
  }
  const rootPreset = args.root_preset === undefined ? engine.config.workflow_defaults.default_preset : text(args.root_preset, "root_preset");
  if (!presets[rootPreset]) return failure("preset_unavailable", `Root preset is unavailable: ${rootPreset}`);
  try { await engine.app.validatePresets(presets) }
  catch (error) { return failure("preset_unavailable", String(error)) }
  const details = args.details === undefined ? undefined : object(args.details, "details");
  const hostCapabilities = args.host_capabilities === undefined ? undefined : object(args.host_capabilities, "host_capabilities");
  if (hostCapabilities) {
    exact(hostCapabilities, ["computer_use"], "host_capabilities");
    if (typeof hostCapabilities.computer_use !== "boolean") throw new Error("host_capabilities.computer_use must be boolean");
  }
  const reported = hostCapabilities?.computer_use === true;
  const workflow = engine.createWorkflow(task, details, workspace, presets, engine.config.workflow_defaults.preset_recommendations,
    engine.config.workflow_defaults.default_preset, rootPreset, args.root_permissions, reported);
  const root = workflow.agents[workflow.root_id]!;
  try {
    root.thread_start_started = true;
    engine.persist();
    const response = await engine.app.startThread(workflow.workspace, root.resolved_preset, root.permissions, (await import("./tools.js")).AGENT_TOOL_SPECS);
    root.thread_id = String((response.thread as JsonObject).id);
    root.thread_start_started = undefined;
    root.observed_routing = routing(response);
    root.state = "waiting";
    engine.enqueue(workflow, root, "root ready");
  } catch (error) {
    const message = `Root thread/start failed: ${String(error)}`;
    engine.failAgent(workflow, root, "app_server_unsupported", message, "possible");
    workflow.status = "failed"; engine.persist();
    return failure("app_server_unsupported", message, {
      workflow_id: workflow.id, agent_id: root.id, state: root.state, side_effects: "possible",
      details: { terminal_fact: root.terminal_fact }
    });
  }
  return { ok: true, workflow_id: workflow.id, root_agent_id: root.id, root_short_id: root.short_id,
    resolved_root_preset: root.resolved_preset, context_provenance: { source: "fresh" },
    snapshot: snapshot(engine, workflow), workflow_state: workflow.status };
}

async function workflowPoll(engine: Engine, args: JsonObject): Promise<ToolResult> {
  exact(args, ["workflow_id", "cursor", "timeout_ms", "event_limit"], "banana_workflow_poll");
  const workflow = engine.resolveWorkflow(text(args.workflow_id, "workflow_id"));
  if (!workflow) return failure("not_found", "Workflow not found");
  const limit = integer(args.event_limit ?? 50, "event_limit", 1, 200);
  const timeout = integer(args.timeout_ms ?? 30000, "timeout_ms", 0, 60000);
  const from = args.cursor === undefined ? 0 : cursor(args.cursor);
  let available = workflow.events.filter((event) => event.sequence > from);
  let timedOut = false;
  if (!available.length && args.cursor !== undefined && timeout > 0) {
    await engine.waitForEvent(workflow.id, timeout);
    available = workflow.events.filter((event) => event.sequence > from);
    timedOut = !available.length;
  }
  const events = available.slice(0, limit); const last = events.at(-1)?.sequence ?? from;
  return { ok: true, snapshot: snapshot(engine, workflow), events, cursor: String(last), has_more: available.length > events.length, timed_out: timedOut,
    ...(terminal(workflow) ? { final: finalResponse(workflow) } : {}) };
}

async function agentInspect(engine: Engine, args: JsonObject): Promise<ToolResult> {
  exact(args, ["workflow_id", "agent_id", "include_payloads", "transcript_cursor", "transcript_limit"], "banana_agent_inspect");
  const workflow = engine.resolveWorkflow(text(args.workflow_id, "workflow_id"));
  if (!workflow) return failure("not_found", "Workflow not found");
  const agent = engine.resolveAgent(workflow, text(args.agent_id, "agent_id"));
  if (!agent) return failure("not_found", "Agent not found or short id is ambiguous", { workflow_id: workflow.id });
  const include = args.include_payloads === true;
  const result: JsonObject = { ok: true, workflow_id: workflow.id, agent: inspectRecord(engine, workflow, agent, include) };
  if (args.transcript_cursor !== undefined || args.transcript_limit !== undefined) {
    if (!agent.thread_id) result.transcript = { data: [], next_transcript_cursor: null };
    else {
      const limit = integer(args.transcript_limit ?? 20, "transcript_limit", 1, 100);
      const page = await engine.app.listItems(agent.thread_id, args.transcript_cursor === undefined ? undefined : text(args.transcript_cursor, "transcript_cursor"), limit);
      result.transcript = { data: page.data ?? [], next_transcript_cursor: page.nextCursor ?? null };
    }
  }
  return result as ToolResult;
}

function workflowList(engine: Engine, args: JsonObject): ToolResult {
  exact(args, ["statuses"], "banana_workflow_list");
  const statuses = args.statuses === undefined ? undefined : stringList(args.statuses, "statuses");
  const workflows = Object.values(engine.state.workflows).filter((workflow) => !statuses || statuses.includes(workflow.status)).map((workflow) => ({
    workflow_id: workflow.id, short_id: workflow.short_id, status: workflow.status, workspace: workflow.workspace,
    task_label: label(workflow.task), root_agent_id: workflow.root_id, created_at: workflow.created_at, updated_at: workflow.updated_at
  }));
  return { ok: true, workflows };
}

function workflowSend(engine: Engine, args: JsonObject): ToolResult {
  exact(args, ["workflow_id", "agent_id", "message"], "banana_workflow_send");
  const workflow = engine.resolveWorkflow(text(args.workflow_id, "workflow_id"));
  if (!workflow) return failure("not_found", "Workflow not found");
  const agent = engine.resolveAgent(workflow, text(args.agent_id, "agent_id"));
  if (!agent) return failure("not_found", "Agent not found or short id is ambiguous", { workflow_id: workflow.id });
  if (!['pending_context', 'queued', 'active', 'waiting'].includes(agent.state) || agent.turn_closing) return failure("recipient_unavailable", "Agent cannot accept a host message", { workflow_id: workflow.id, agent_id: agent.id, state: agent.state });
  const message = object(args.message, "message"); exact(message, ["type", "body", "details"], "message");
  const body = message.body === undefined ? undefined : text(message.body, "message.body");
  const details = message.details === undefined ? undefined : object(message.details, "message.details");
  if (!body && !details) throw new Error("message requires body or details");
  const delivered = engine.deliver(workflow, agent, "host", text(message.type, "message.type"), body, details);
  engine.persist();
  return { ok: true, message_id: delivered.id, recipient_id: agent.id, sequence: delivered.sequence };
}

function workflowControl(engine: Engine, args: JsonObject): ToolResult {
  exact(args, ["workflow_id", "action", "agent_id"], "banana_workflow_control");
  const workflow = engine.resolveWorkflow(text(args.workflow_id, "workflow_id"));
  if (!workflow) return failure("not_found", "Workflow not found");
  const action = args.action;
  if (action === "freeze_spawning" || action === "reopen_spawning") {
    if (args.agent_id !== undefined) throw new Error("agent_id is not valid for spawn freeze control");
    workflow.spawn_frozen = action === "freeze_spawning";
    engine.event(workflow, "spawn_control", workflow.spawn_frozen ? "Spawning frozen" : "Spawning reopened"); engine.persist();
    return { ok: true, workflow_id: workflow.id, spawn_frozen: workflow.spawn_frozen };
  }
  if (action === "cancel_subtree") {
    const target = engine.resolveAgent(workflow, text(args.agent_id, "agent_id"));
    if (!target) return failure("not_found", "Target agent not found", { workflow_id: workflow.id });
    return { ok: true, workflow_id: workflow.id, cancellation: engine.cancelSubtree(workflow, target, "host_cancel_subtree"), snapshot: snapshot(engine, workflow), side_effects: "possible" };
  }
  if (action === "cancel_workflow") {
    if (args.agent_id !== undefined) throw new Error("agent_id is not valid for cancel_workflow");
    workflow.status = "cancelling";
    const cancellation = engine.cancelSubtree(workflow, workflow.agents[workflow.root_id]!, "host_cancel_workflow");
    engine.recomputeWorkflow(workflow); engine.persist();
    return { ok: true, workflow_id: workflow.id, cancellation, snapshot: snapshot(engine, workflow), side_effects: "possible" };
  }
  throw new Error("invalid workflow control action");
}

function approvalRespond(engine: Engine, args: JsonObject): ToolResult {
  exact(args, ["workflow_id", "approval_id", "decision", "details"], "banana_approval_respond");
  const workflow = engine.resolveWorkflow(text(args.workflow_id, "workflow_id"));
  if (!workflow) return failure("not_found", "Workflow not found");
  const approvalId = text(args.approval_id, "approval_id"); const approval = workflow.approvals[approvalId];
  if (!approval) return failure("not_found", "Approval not found", { workflow_id: workflow.id });
  if (approval.status !== "pending") return failure("approval_not_pending", "Approval is not pending", { workflow_id: workflow.id, request_id: approval.id, state: approval.status });
  let response: JsonObject;
  if (approval.method === "item/commandExecution/requestApproval" || approval.method === "item/fileChange/requestApproval") response = { decision: args.decision };
  else {
    const details = args.details === undefined ? undefined : object(args.details, "details");
    if (!details?.response || typeof details.response !== "object") throw new Error("details.response is required for this App Server approval type");
    response = details.response as JsonObject;
  }
  engine.app.respond(approval.request_id, response); approval.status = "answered";
  engine.event(workflow, "approval_answered", `Approval ${approval.id} answered`, approval.agent_id, approval.id); engine.persist();
  return { ok: true, approval_id: approval.id, relay_status: approval.status };
}

function hostRespond(engine: Engine, args: JsonObject): ToolResult {
  exact(args, ["workflow_id", "request_id", "status", "summary", "details"], "banana_host_respond");
  const workflow = engine.resolveWorkflow(text(args.workflow_id, "workflow_id"));
  if (!workflow) return failure("not_found", "Workflow not found");
  const requestId = text(args.request_id, "request_id"); const request = workflow.host_requests[requestId];
  if (!request) return failure("not_found", "Host request not found", { workflow_id: workflow.id, request_id: requestId });
  const status = args.status; const summary = args.summary === undefined ? undefined : text(args.summary, "summary");
  const details = args.details === undefined ? undefined : object(args.details, "details");
  if (status === "in_progress") {
    if (request.status !== "pending") return transitionFailure(workflow, request);
    const active = allHostRequests(engine).find((item) => item.status === "in_progress");
    if (active) return failure("invalid_state", `Computer Use request ${active.id} is already in progress`, { workflow_id: workflow.id, request_id: request.id });
    if (oldestPending(engine)?.id !== request.id) return failure("invalid_state", "Only the runtime-wide oldest pending Computer Use request may be claimed", { workflow_id: workflow.id, request_id: request.id });
    request.status = "in_progress"; request.claimed_at = now();
    engine.event(workflow, "host_action_in_progress", `Host claimed ${request.id}`, request.requester_id, request.id); engine.persist();
    return { ok: true, request: hostRequestView(request) };
  }
  if (!['completed', 'declined', 'failed'].includes(String(status))) throw new Error("invalid host response status");
  if (status === "completed" && !summary && !details) throw new Error("completed requires summary or details evidence");
  if ((status === "declined" || status === "failed") && !summary) throw new Error(`${String(status)} requires summary`);
  const allowed = request.status === "pending" ? ["declined", "failed"] : request.status === "in_progress" || request.status === "uncertain" ? ["completed", "failed"] : [];
  if (!allowed.includes(String(status))) {
    if (request.status === "cancelled" || request.resolution === "cancelled") {
      request.summary = summary; if (details) request.details = details;
      engine.event(workflow, "host_action_evidence", `Late evidence retained for cancelled ${request.id}`, request.requester_id, request.id); engine.persist();
      return { ok: true, request: hostRequestView(request) };
    }
    return transitionFailure(workflow, request);
  }
  request.status = status as "completed" | "declined" | "failed"; request.resolution = request.status; request.resolved_at = now();
  if (summary) request.summary = summary; if (details) request.details = details;
  if (request.status === "failed") request.terminal_fact = engine.terminalFact("invalid_state", summary!, [request.id, request.requester_id], "possible", details);
  const requester = workflow.agents[request.requester_id]!;
  if (!['failed', 'cancelled', 'completed'].includes(requester.state)) engine.deliver(workflow, requester, "host", "host_response", summary, { request_id: request.id, status, evidence: details ?? {} });
  engine.event(workflow, "host_action_resolved", `Host request ${request.id} ${String(status)}`, request.requester_id, request.id);
  engine.recomputeWorkflow(workflow); engine.persist();
  return { ok: true, request: hostRequestView(request) };
}

export function snapshot(engine: Engine, workflow: WorkflowRecord): JsonObject {
  const agents = Object.values(workflow.agents);
  const attention: JsonObject[] = [];
  for (const approval of Object.values(workflow.approvals).filter((item) => item.status === "pending")) attention.push({
    type: "approval", approval_id: approval.id, agent_id: approval.agent_id, method: approval.method,
    summary: approval.summary, request: approval.details ?? {}
  });
  for (const agent of agents.filter((item) => item.attention_codes.length || (item.state === "failed" && !item.failure_acknowledged))) attention.push({ type: "agent", agent_id: agent.id, short_id: agent.short_id, state: agent.state, codes: agent.attention_codes, terminal_fact: agent.terminal_fact });
  for (const agent of agents.filter((item) => item.state === "submitted")) attention.push({ type: "submission", agent_id: agent.id, parent_id: agent.parent_id });
  for (const request of Object.values(workflow.host_requests).filter((item) => item.status === "uncertain")) attention.push({ type: "uncertain_host_action", request_id: request.id, requester_id: request.requester_id });
  const oldest = oldestPending(engine);
  const hostAction = oldest?.workflow_id === workflow.id && !allHostRequests(engine).some((item) => item.status === "in_progress") ? hostRequestView(oldest, false) : undefined;
  return {
    workflow_id: workflow.id, short_id: workflow.short_id, status: workflow.status, spawn_frozen: workflow.spawn_frozen,
    capacity: { active_turns: engine.activeCount(), max_active_turns: engine.config.runtime.scheduler.max_active_turns, runnable_backlog: engine.state.runnable.length },
    attention, ...(hostAction ? { host_action_required: hostAction } : {}),
    tree: tree(workflow, workflow.agents[workflow.root_id]!),
    event_cursor: String(workflow.events.at(-1)?.sequence ?? 0),
    ...(terminal(workflow) ? { final: finalResponse(workflow) } : {})
  };
}

function tree(workflow: WorkflowRecord, agent: AgentRecord): JsonObject {
  return { agent_id: agent.id, short_id: agent.short_id, state: agent.state, task_label: label(agent.task),
    context_source: agent.provenance.source, requested_preset: agent.requested_preset, resolved_preset: agent.resolved_preset,
    observed_routing: agent.observed_routing ?? {}, wait: agent.wait ?? null, submission_pending: agent.state === "submitted",
    children: agent.children.map((childId) => tree(workflow, workflow.agents[childId]!)) };
}

function inspectRecord(engine: Engine, workflow: WorkflowRecord, agent: AgentRecord, include: boolean): JsonObject {
  const base: JsonObject = {
    agent_id: agent.id, short_id: agent.short_id, parent_id: agent.parent_id ?? null, child_ids: agent.children,
    state: agent.state, task_label: label(agent.task), provenance: agent.provenance, requested_preset: agent.requested_preset,
    resolved_preset: agent.resolved_preset, observed_routing: agent.observed_routing ?? {}, permissions: agent.permissions,
    thread_id: agent.thread_id ?? null, latest_turn_id: agent.latest_turn_id ?? null, token_usage: agent.token_usage ?? null, wait: agent.wait ?? null,
    obligations: engine.obligations(workflow, agent), submission: agent.submission ?? null, result: agent.result ?? null,
    terminal_fact: agent.terminal_fact ?? null, attention_codes: agent.attention_codes,
    recent_events: workflow.events.filter((event) => event.agent_id === agent.id).slice(-50)
  };
  if (include) Object.assign(base, { task: agent.task, brief: agent.brief ?? null, details: agent.details ?? null,
    mailbox: agent.mailbox, submissions: agent.submissions, uncommitted_finish: agent.uncommitted_finish ?? null,
    advice_requests: Object.values(workflow.advice_requests).filter((request) => request.requester_id === agent.id || request.advisor_id === agent.id),
    host_requests: Object.values(workflow.host_requests).filter((request) => request.requester_id === agent.id) });
  return base;
}

function finalResponse(workflow: WorkflowRecord): JsonObject {
  const agents = Object.values(workflow.agents);
  return {
    workflow_id: workflow.id, status: workflow.status,
    ...(workflow.agents[workflow.root_id]!.result ? { root_result: workflow.agents[workflow.root_id]!.result } : {}),
    accepted_results: agents.filter((agent) => agent.result).map((agent) => ({ agent_id: agent.id, result: agent.result })),
    terminal_facts: agents.filter((agent) => agent.terminal_fact).map((agent) => ({ agent_id: agent.id, fact: agent.terminal_fact })),
    unaccepted_submissions: agents.filter((agent) => agent.submission).map((agent) => ({ agent_id: agent.id, submission: agent.submission })),
    terminated_requests: [
      ...Object.values(workflow.advice_requests)
        .filter((request) => !['armed', 'pending'].includes(request.status))
        .map((request) => ({ request_id: request.id, type: "advice", participants: { requester_id: request.requester_id, advisor_id: request.advisor_id }, status: request.status, terminal_fact: request.terminal_fact ?? null })),
      ...Object.values(workflow.host_requests)
        .filter((request) => !['armed', 'pending', 'in_progress', 'uncertain'].includes(request.status))
        .map((request) => ({ request_id: request.id, type: "host_capability", participants: { requester_id: request.requester_id, host: "main_host" }, status: request.status, terminal_fact: request.terminal_fact ?? null }))
    ],
    side_effects: agents.some((agent) => agent.terminal_fact?.side_effects === "known") ? "known" : agents.some((agent) => agent.terminal_fact?.side_effects === "possible") ? "possible" : "none",
    event_cursor: String(workflow.events.at(-1)?.sequence ?? 0)
  };
}

function allHostRequests(engine: Engine): HostRequest[] { return Object.values(engine.state.workflows).flatMap((workflow) => Object.values(workflow.host_requests)) }
function oldestPending(engine: Engine): HostRequest | undefined { return allHostRequests(engine).filter((request) => request.status === "pending").sort((a, b) => a.created_at.localeCompare(b.created_at))[0] }
function hostRequestView(request: HostRequest, includePayloads = true): JsonObject {
  return {
    request_id: request.id, workflow_id: request.workflow_id, requester_id: request.requester_id,
    capability: request.capability, task: request.task, status: request.status,
    ...(includePayloads ? { context: request.context ?? {}, expected_evidence: request.expected_evidence ?? {}, details: request.details ?? null } : {}),
    summary: request.summary ?? null
  };
}
function terminal(workflow: WorkflowRecord): boolean { return ['completed', 'failed', 'cancelled'].includes(workflow.status) }
function transitionFailure(workflow: WorkflowRecord, request: HostRequest): ToolResult { return failure(['completed', 'declined', 'failed', 'cancelled'].includes(request.status) ? "request_terminal" : "invalid_state", "Invalid host request transition", { workflow_id: workflow.id, request_id: request.id, state: request.status }) }
function object(value: unknown, where: string): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`); return value as JsonObject }
function text(value: unknown, where: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a nonempty string`); return value }
function stringList(value: unknown, where: string): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${where} must be strings`); return value as string[] }
function integer(value: unknown, where: string, min: number, max: number): number { if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${where} must be ${min}-${max}`); return value as number }
function cursor(value: unknown): number { const parsed = Number(text(value, "cursor")); if (!Number.isInteger(parsed) || parsed < 0) throw new Error("cursor is invalid"); return parsed }
function exact(value: JsonObject, allowed: string[], where: string): void { const unknown = Object.keys(value).filter((key) => !allowed.includes(key)); if (unknown.length) throw new Error(`${where} has unknown fields: ${unknown.join(", ")}`) }
function routing(response: JsonObject): JsonObject { const value: JsonObject = {}; for (const key of ["model", "serviceTier", "modelProvider"]) if (response[key] !== undefined) value[key] = response[key]; return value }
