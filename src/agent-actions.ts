import type { Engine, ToolResult } from "./engine.js";
import type { AdviceRequest, AgentRecord, HostRequest, JsonObject, ResultValue, WorkflowRecord } from "./model.js";
import { failure, id, now, shortId } from "./model.js";
import { AGENT_TOOL_SPECS } from "./tools.js";

export async function handleAgentTool(engine: Engine, workflow: WorkflowRecord, agent: AgentRecord, name: string, args: JsonObject): Promise<ToolResult> {
  const allowed = AGENT_FIELDS[name];
  if (!allowed) return failure("invalid_input", `Unknown Banana agent tool: ${name}`, { workflow_id: workflow.id, agent_id: agent.id });
  exact(args, allowed, name);
  switch (name) {
    case "banana_spawn": return spawn(engine, workflow, agent, args);
    case "banana_send": return send(engine, workflow, agent, args);
    case "banana_ask": return ask(engine, workflow, agent, args);
    case "banana_reply": return reply(engine, workflow, agent, args);
    case "banana_request_host": return requestHost(engine, workflow, agent, args);
    case "banana_wait": return wait(engine, workflow, agent, args);
    case "banana_review": return review(engine, workflow, agent, args);
    case "banana_cancel": return cancel(engine, workflow, agent, args);
    case "banana_finish": return finish(engine, workflow, agent, args);
    default: return failure("invalid_input", `Unknown Banana agent tool: ${name}`, { workflow_id: workflow.id, agent_id: agent.id });
  }
}

async function spawn(engine: Engine, workflow: WorkflowRecord, parent: AgentRecord, args: JsonObject): Promise<ToolResult> {
  if (workflow.spawn_frozen) return failure("spawn_frozen", "New child admission is frozen", { workflow_id: workflow.id, agent_id: parent.id });
  const task = text(args.task, "task");
  const context = object(args.context, "context");
  exact(context, ["source", "brief"], "context");
  const source = context.source;
  if (source !== "fresh" && source !== "inherit") throw new Error("context.source must be fresh or inherit");
  const presetName = args.preset === undefined ? parent.requested_preset : text(args.preset, "preset");
  const preset = workflow.preset_snapshot[presetName];
  if (!preset) return failure("preset_unavailable", `Preset is unavailable in this workflow: ${presetName}`, { workflow_id: workflow.id, agent_id: parent.id });
  let permissions;
  try { permissions = engine.narrowPermissions(parent.permissions, args.permissions, workflow.workspace) }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.startsWith("permission_widening") ? "permission_widening" : message.startsWith("app_server_unsupported") ? "app_server_unsupported" : "invalid_input";
    return failure(code, message, { workflow_id: workflow.id, agent_id: parent.id });
  }
  const childId = id("agt"); const timestamp = now();
  const child: AgentRecord = {
    id: childId, short_id: shortId(childId), workflow_id: workflow.id, parent_id: parent.id, children: [], task,
    provenance: { source }, requested_preset: presetName, resolved_preset: structuredClone(preset), permissions,
    state: source === "inherit" ? "pending_context" : "queued", queued: false, turn_closing: false,
    mailbox: [], next_message_sequence: 1, submissions: [], attention_codes: [], created_at: timestamp, updated_at: timestamp
  };
  if (context.brief !== undefined) child.brief = object(context.brief, "context.brief");
  if (args.details !== undefined) child.details = object(args.details, "details");
  if (source === "inherit") child.pending_context_turn_id = parent.active_turn_id;
  workflow.agents[child.id] = child; parent.children.push(child.id);
  engine.event(workflow, "agent_created", `${parent.short_id} created ${child.short_id} with ${source} context`, child.id);
  engine.persist();
  if (source === "fresh") {
    try {
      child.thread_start_started = true;
      engine.persist();
      const response = await engine.app.startThread(workflow.workspace, child.resolved_preset, child.permissions, AGENT_TOOL_SPECS);
      child.thread_id = String((response.thread as JsonObject).id);
      child.thread_start_started = undefined;
      child.observed_routing = routing(response);
      child.state = "waiting";
      engine.enqueue(workflow, child, "fresh child ready");
    } catch (error) {
      const message = `thread/start failed: ${String(error)}`;
      engine.failAgent(workflow, child, "app_server_unsupported", message, "possible");
      engine.persist();
      return failure("app_server_unsupported", message, {
        workflow_id: workflow.id, agent_id: child.id, state: child.state, side_effects: "possible",
        details: { terminal_fact: child.terminal_fact }
      });
    }
  }
  const shouldYield = source === "inherit" || engine.activeCount() >= engine.config.runtime.scheduler.max_active_turns;
  return { ok: true, agent_id: child.id, short_id: child.short_id, context_state: source,
    ...(source === "inherit" ? { thread_boundary: parent.active_turn_id } : {}), requested_preset: presetName,
    resolved_preset: child.resolved_preset, admission_state: child.state === "pending_context" ? "pending_context" : child.state === "active" ? "active" : "queued",
    active_turns: engine.activeCount(), max_active_turns: engine.config.runtime.scheduler.max_active_turns, should_yield: shouldYield };
}

function send(engine: Engine, workflow: WorkflowRecord, sender: AgentRecord, args: JsonObject): ToolResult {
  const recipient = engine.resolveAgent(workflow, text(args.to, "to"), sender);
  if (!recipient) return failure("not_found", "Recipient was not found or short id is ambiguous", { workflow_id: workflow.id, agent_id: sender.id });
  if (!["pending_context", "queued", "active", "waiting"].includes(recipient.state) || recipient.turn_closing) {
    return failure("recipient_unavailable", "Recipient cannot accept ordinary messages in its current state", { workflow_id: workflow.id, agent_id: recipient.id, state: recipient.state });
  }
  const message = object(args.message, "message"); exact(message, ["type", "body", "details"], "message");
  const type = text(message.type, "message.type");
  const body = message.body === undefined ? undefined : text(message.body, "message.body");
  const details = message.details === undefined ? undefined : object(message.details, "message.details");
  if (!body && !details) throw new Error("message requires body or details");
  const delivered = engine.deliver(workflow, recipient, sender.id, type, body, details);
  engine.persist();
  return { ok: true, message_id: delivered.id, recipient_id: recipient.id, sequence: delivered.sequence };
}

function ask(engine: Engine, workflow: WorkflowRecord, requester: AgentRecord, args: JsonObject): ToolResult {
  const advisor = engine.resolveAgent(workflow, text(args.to, "to"), requester);
  if (!advisor) return failure("not_found", "Advisor was not found or short id is ambiguous", { workflow_id: workflow.id, agent_id: requester.id });
  if (!engine.adviceEligible(advisor, requester.id)) {
    return failure("recipient_unavailable", "Advisor is not eligible", { workflow_id: workflow.id, agent_id: advisor.id, state: advisor.state });
  }
  const requestId = id("adv");
  const request: AdviceRequest = { id: requestId, workflow_id: workflow.id, requester_id: requester.id, advisor_id: advisor.id,
    question: text(args.question, "question"), status: "armed", created_at: now() };
  if (args.context !== undefined) request.context = object(args.context, "context");
  workflow.advice_requests[request.id] = request;
  requester.disposition = { type: "ask", request_id: request.id }; requester.turn_closing = true;
  engine.persist();
  return { ok: true, request_id: request.id, turn_closing: true };
}

function reply(engine: Engine, workflow: WorkflowRecord, advisor: AgentRecord, args: JsonObject): ToolResult {
  const requestId = text(args.request_id, "request_id"); const request = workflow.advice_requests[requestId];
  if (!request) return failure("not_found", "Advice request not found", { workflow_id: workflow.id, agent_id: advisor.id, request_id: requestId });
  if (request.advisor_id !== advisor.id) return failure("invalid_state", "Only the designated advisor may resolve this request", { workflow_id: workflow.id, agent_id: advisor.id, request_id: requestId });
  if (request.status !== "pending") return failure("request_terminal", "Advice request is not pending", { workflow_id: workflow.id, request_id: requestId, state: request.status });
  const status = args.status;
  if (status !== "answered" && status !== "declined") throw new Error("status must be answered or declined");
  if (status === "answered") request.guidance = text(args.guidance, "guidance");
  else if (args.guidance !== undefined) throw new Error("guidance must be omitted when declined");
  if (args.details !== undefined) request.details = object(args.details, "details");
  request.status = status; request.resolved_at = now();
  const requester = workflow.agents[request.requester_id]!;
  engine.deliver(workflow, requester, advisor.id, "advice_response", request.guidance, { request_id: request.id, status, ...(request.details ?? {}) });
  engine.event(workflow, "advice_resolved", `${advisor.short_id} ${status} ${request.id}`, requester.id, request.id);
  engine.persist();
  return { ok: true, request_id: request.id, status, requester_id: requester.id };
}

function requestHost(engine: Engine, workflow: WorkflowRecord, requester: AgentRecord, args: JsonObject): ToolResult {
  if (args.capability !== "computer_use") throw new Error("capability must be computer_use");
  if (!workflow.host_capabilities.computer_use) return failure("capability_unavailable", "Computer Use was not both configured and reported by the host", { workflow_id: workflow.id, agent_id: requester.id });
  const requestId = id("host");
  const request: HostRequest = { id: requestId, workflow_id: workflow.id, requester_id: requester.id, capability: "computer_use",
    task: text(args.task, "task"), status: "armed", created_at: now() };
  if (args.context !== undefined) request.context = object(args.context, "context");
  if (args.expected_evidence !== undefined) request.expected_evidence = object(args.expected_evidence, "expected_evidence");
  workflow.host_requests[request.id] = request;
  requester.disposition = { type: "request_host", request_id: request.id }; requester.turn_closing = true;
  engine.persist();
  return { ok: true, request_id: request.id, turn_closing: true };
}

function wait(engine: Engine, workflow: WorkflowRecord, agent: AgentRecord, args: JsonObject): ToolResult {
  const children = args.children === undefined ? [] : stringList(args.children, "children");
  const resolved: string[] = [];
  for (const childId of children) {
    const child = engine.resolveAgent(workflow, childId, agent);
    if (!child || child.parent_id !== agent.id) throw new Error(`wait child is not a direct child: ${childId}`);
    resolved.push(child.id);
  }
  const messages = args.messages === true;
  if (!resolved.length && !messages) throw new Error("banana_wait requires children or messages:true");
  agent.disposition = { type: "wait", children: resolved, messages }; agent.turn_closing = true;
  engine.persist();
  return { ok: true, turn_closing: true };
}

function review(engine: Engine, workflow: WorkflowRecord, parent: AgentRecord, args: JsonObject): ToolResult {
  const child = engine.resolveAgent(workflow, text(args.child_id, "child_id"), parent);
  if (!child || child.parent_id !== parent.id) return failure("not_found", "Child is not a direct child", { workflow_id: workflow.id, agent_id: parent.id });
  if (child.state !== "submitted" || !child.submission) return failure("invalid_state", "Child has no current submission", { workflow_id: workflow.id, agent_id: child.id, state: child.state });
  const decision = args.decision;
  if (decision !== "accept" && decision !== "revise") throw new Error("decision must be accept or revise");
  const history = child.submissions.at(-1)!;
  if (decision === "accept") {
    if (args.feedback !== undefined) throw new Error("feedback is only valid for revise");
    history.decision = "accept"; child.result = child.submission; child.submission = undefined; child.state = "completed";
    engine.event(workflow, "review_accepted", `${parent.short_id} accepted ${child.short_id}`, child.id);
    engine.recomputeWorkflow(workflow); engine.persist();
    return { ok: true, child_id: child.id, child_state: child.state, accepted_result: child.result };
  }
  const feedback = object(args.feedback, "feedback"); exact(feedback, ["summary", "details"], "feedback");
  const summary = text(feedback.summary, "feedback.summary");
  if (feedback.details !== undefined) object(feedback.details, "feedback.details");
  history.decision = "revise"; history.feedback = feedback; child.submission = undefined; child.state = "waiting";
  engine.deliver(workflow, child, parent.id, "review_feedback", summary, (feedback.details ?? {}) as JsonObject);
  engine.event(workflow, "review_revision", `${parent.short_id} requested revision from ${child.short_id}`, child.id);
  engine.persist();
  return { ok: true, child_id: child.id, child_state: child.state, revision_status: "queued" };
}

function cancel(engine: Engine, workflow: WorkflowRecord, caller: AgentRecord, args: JsonObject): ToolResult {
  const target = engine.resolveAgent(workflow, text(args.agent_id, "agent_id"), caller);
  if (!target || !descendant(workflow, caller, target.id)) return failure("not_found", "Caller does not own that descendant subtree", { workflow_id: workflow.id, agent_id: caller.id });
  const snapshot = engine.cancelSubtree(workflow, target, `cancelled by ${caller.short_id}`);
  return { ok: true, target_agent_id: target.id, cancellation: snapshot, side_effects: "possible" };
}

function finish(engine: Engine, workflow: WorkflowRecord, agent: AgentRecord, args: JsonObject): ToolResult {
  const resultObject = object(args.result, "result");
  exact(resultObject, ["outcome", "summary", "details"], "result");
  const outcome = resultObject.outcome;
  if (!["success", "partial", "blocked", "unsuccessful"].includes(String(outcome))) throw new Error("invalid result outcome");
  const result: ResultValue = { outcome: outcome as ResultValue["outcome"], summary: text(resultObject.summary, "result.summary") };
  if (resultObject.details !== undefined) result.details = object(resultObject.details, "result.details");
  if (engine.hasBlockers(workflow, agent)) return failure("invalid_state", "Agent has unresolved descendants, reviews, advice, or host requests", { workflow_id: workflow.id, agent_id: agent.id, details: engine.blockers(workflow, agent) });
  agent.disposition = { type: "finish", result }; agent.turn_closing = true;
  engine.persist();
  return { ok: true, turn_closing: true };
}

function object(value: unknown, where: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as JsonObject;
}
function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a nonempty string`);
  return value;
}
function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`${where} must be an array of nonempty strings`);
  return [...new Set(value as string[])];
}
function descendant(workflow: WorkflowRecord, ancestor: AgentRecord, targetId: string): boolean {
  return ancestor.children.some((childId) => childId === targetId || descendant(workflow, workflow.agents[childId]!, targetId));
}
function routing(response: JsonObject): JsonObject {
  const value: JsonObject = {}; for (const key of ["model", "serviceTier", "modelProvider"]) if (response[key] !== undefined) value[key] = response[key]; return value;
}

const AGENT_FIELDS: Record<string, string[]> = {
  banana_spawn: ["task", "context", "preset", "permissions", "details"],
  banana_send: ["to", "message"],
  banana_ask: ["to", "question", "context"],
  banana_reply: ["request_id", "status", "guidance", "details"],
  banana_request_host: ["capability", "task", "context", "expected_evidence"],
  banana_wait: ["children", "messages"],
  banana_review: ["child_id", "decision", "feedback"],
  banana_cancel: ["agent_id"],
  banana_finish: ["result"]
};
function exact(value: JsonObject, allowed: string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${where} has unknown fields: ${unknown.join(", ")}`);
}
