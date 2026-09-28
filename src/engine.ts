import { basename, normalize, resolve } from "node:path";
import type { AppServer } from "./app-server.js";
import { allTierPresets } from "./presets.js";
import { ceilingForWorkspace, permissionPath, withinWritableRoot } from "./config.js";
import type {
  AgentRecord, DurableState, JsonObject, MaterialEvent, PermissionPolicy, Preset,
  RuntimeConfig, TerminalFact, ToolFailure, WorkflowRecord, PresetTiers
} from "./model.js";
import { failure, id, now, shortId } from "./model.js";
import type { Store } from "./store.js";
import { AGENT_TOOL_SPECS } from "./tools.js";
import { handleAgentTool } from "./agent-actions.js";
import { handleHostTool } from "./host-actions.js";

export type ToolResult = ({ ok: true } & JsonObject) | ToolFailure;

const TURN_COMPLETION_INSTRUCTION = "Close each turn with exactly one successful banana_wait, banana_ask, banana_request_host, or banana_finish, then make your next message the final response for this turn, with no intervening commentary or tool calls. Do not repeat the closing call. The runtime commits the disposition and releases your active-turn slot only after that final response; it resumes you in a new turn when needed.";

export class Engine {
  readonly state: DurableState;
  private scheduling = false;
  private recovering = false;
  private threadsToReconnect = new Set<string>();
  private pendingFileChanges = new Map<string, unknown>();
  private startingTurns = new Map<string, { completions: JsonObject[]; ready: Promise<void> }>();
  private pollWaiters = new Map<string, Set<() => void>>();

  constructor(readonly config: RuntimeConfig, readonly store: Store, readonly app: AppServer) {
    this.state = store.load();
    app.onRequest((message) => this.onAppRequest(message));
    app.onNotification((method, params) => this.onAppNotification(method, params));
  }

  async initialize(): Promise<void> {
    this.recovering = true;
    const newNativeServer = await this.app.start();
    if (newNativeServer) {
      for (const workflow of Object.values(this.state.workflows)) {
        for (const approval of Object.values(workflow.approvals)) {
          if (approval.status !== "pending") continue;
          approval.status = "invalidated";
          this.event(workflow, "approval_invalidated", `Approval ${approval.id} belongs to the previous native server`, approval.agent_id, approval.id);
        }
      }
      this.persist();
    }
    await this.app.validatePresets(this.config.workflow_defaults.preset_tiers ? allTierPresets(this.config.workflow_defaults.preset_tiers) : this.config.workflow_defaults.presets);
    await this.app.probe(AGENT_TOOL_SPECS);
    for (const workflow of Object.values(this.state.workflows)) {
      if (workflow.preset_tiers && !["completed", "failed", "cancelled"].includes(workflow.status)) await this.app.validatePresets(allTierPresets(workflow.preset_tiers));
      for (const request of Object.values(workflow.host_requests)) {
        if (request.status === "in_progress") {
          request.status = "uncertain";
          this.event(workflow, "host_request_uncertain", `Host action ${request.id} became uncertain after runtime restart`, request.requester_id, request.id);
        }
      }
      for (const agent of Object.values(workflow.agents)) {
        if (agent.provenance.source === "fresh" && !agent.thread_id && !["completed", "failed", "cancelled"].includes(agent.state)) {
          this.failAgent(workflow, agent, "reconciliation_required", "Fresh thread creation did not reach a durable thread identity", "possible");
        } else if (agent.state === "pending_context" && agent.context_fork_started) {
          this.failAgent(workflow, agent, "reconciliation_required", "Inherited thread fork may have started without a durable child thread identity", "possible");
        }
      }
      for (const agent of Object.values(workflow.agents)) {
        if (agent.state === "active") await this.reconcileActive(workflow, agent);
        else if (agent.thread_id && !["completed", "failed", "cancelled"].includes(agent.state)) this.threadsToReconnect.add(agent.thread_id);
      }
      this.recomputeWorkflow(workflow);
    }
    this.persist();
    this.recovering = false;
    void this.schedule();
  }

  persist(): void {
    try { this.store.save(this.state) } catch (error) { throw new Error(`persistence_failed: ${String(error)}`) }
  }

  async agentTool(threadId: string, turnId: string, name: string, args: JsonObject): Promise<ToolResult> {
    const found = this.byThread(threadId);
    if (!found) return failure("not_found", "Managed thread identity is unknown");
    const { workflow, agent } = found;
    const record = (result: ToolResult): ToolResult => {
      if (!result.ok) {
        const event = this.event(workflow, "tool_rejected", `${agent.short_id}: ${name.slice(0, 80)} rejected (${result.error.code})`, agent.id);
        event.details = { tool: name.slice(0, 80), code: result.error.code, turn_id: turnId,
          ...(result.error.agent_id ? { target_agent_id: result.error.agent_id } : {}),
          ...(result.error.request_id ? { request_id: result.error.request_id } : {}) };
        try { this.persist() }
        catch (error) {
          return failure("persistence_failed", error instanceof Error ? error.message : String(error), {
            workflow_id: workflow.id, agent_id: agent.id, side_effects: result.error.side_effects
          });
        }
      }
      return result;
    };
    if (agent.state !== "active" || agent.active_turn_id !== turnId) return record(failure("invalid_state", "Tool call is not bound to the agent's active turn", { workflow_id: workflow.id, agent_id: agent.id, state: agent.state }));
    if (agent.attention_codes.includes("cancellation_requested")) return record(failure("invalid_state", "Cancellation requested. End this response without further tool calls.", { workflow_id: workflow.id, agent_id: agent.id, state: agent.state }));
    if (agent.turn_closing) return record(failure("turn_closing", "Turn is closing. Send your final response for this turn now. Do not call any tools.", { workflow_id: workflow.id, agent_id: agent.id }));
    try {
      const result = await handleAgentTool(this, workflow, agent, name, args);
      if (!result.ok) return record(result);
      return result.turn_closing === true
        ? { ...result, instruction: "Turn is closing. Send your final response for this turn now. Do not call any tools. The runtime will resume you in a new turn when needed." }
        : { ...result, turn_closing: false, instruction: "Your turn remains open. Continue useful work. Before your final response, close with banana_wait, banana_ask, banana_request_host, or banana_finish." };
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return record(failure(stableErrorCode(message), message, { workflow_id: workflow.id, agent_id: agent.id }));
    }
  }

  async hostTool(name: string, args: JsonObject): Promise<ToolResult> {
    try { return await handleHostTool(this, name, args) }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(stableErrorCode(message), message);
    }
  }

  activeCount(): number {
    return Object.values(this.state.workflows).flatMap((workflow) => Object.values(workflow.agents)).filter((agent) => agent.state === "active").length;
  }

  async nameThread(workflow: WorkflowRecord, agent: AgentRecord): Promise<void> {
    await this.app.setThreadName(agent.thread_id!, `${basename(workflow.workspace)}: ${label(agent.task)} [${agent.short_id}]`);
  }

  enqueue(workflow: WorkflowRecord, agent: AgentRecord, reason: string): void {
    if (["completed", "failed", "cancelled", "submitted", "pending_context"].includes(agent.state)) return;
    if (agent.state === "active" || agent.queued) return;
    agent.state = "queued";
    agent.queued = true;
    agent.last_queue_reason = reason;
    agent.wait = undefined;
    agent.attention_codes = agent.attention_codes.filter((code) => code !== "no_disposition");
    this.state.runnable.push({ sequence: this.state.next_runnable_sequence++, workflow_id: workflow.id, agent_id: agent.id });
    this.event(workflow, "agent_queued", `${agent.short_id} queued: ${reason}`, agent.id);
    this.recomputeWorkflow(workflow);
    this.persist();
    void this.schedule();
  }

  wake(workflow: WorkflowRecord, agent: AgentRecord, reason: string): void {
    if (agent.state === "waiting") this.enqueue(workflow, agent, reason);
  }

  event(workflow: WorkflowRecord, type: string, summary: string, agentId?: string, requestId?: string): MaterialEvent {
    const sequence = workflow.next_event_sequence++;
    const event: MaterialEvent = { cursor: String(sequence), sequence, type, summary, created_at: now() };
    if (agentId) event.agent_id = agentId;
    if (requestId) event.request_id = requestId;
    workflow.events.push(event);
    workflow.updated_at = event.created_at;
    const waiters = this.pollWaiters.get(workflow.id);
    if (waiters) for (const wake of waiters) wake();
    return event;
  }

  waitForEvent(workflowId: string, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return Promise.resolve();
    return new Promise((resolvePromise) => {
      const set = this.pollWaiters.get(workflowId) ?? new Set<() => void>();
      let timer: ReturnType<typeof setTimeout>;
      const done = () => { clearTimeout(timer); set.delete(done); resolvePromise() };
      set.add(done); this.pollWaiters.set(workflowId, set);
      timer = setTimeout(done, timeoutMs);
      timer.unref(); // A disconnected long poll must not hold the runtime open at shutdown.
    });
  }

  resolveAgent(workflow: WorkflowRecord, value: string, current?: AgentRecord): AgentRecord | undefined {
    if (value === "parent" && current?.parent_id) return workflow.agents[current.parent_id];
    if (workflow.agents[value]) return workflow.agents[value];
    const matches = Object.values(workflow.agents).filter((agent) => agent.short_id === value);
    return matches.length === 1 ? matches[0] : undefined;
  }

  resolveWorkflow(value: string): WorkflowRecord | undefined {
    if (this.state.workflows[value]) return this.state.workflows[value];
    const matches = Object.values(this.state.workflows).filter((workflow) => workflow.short_id === value);
    return matches.length === 1 ? matches[0] : undefined;
  }

  byThread(threadId: string): { workflow: WorkflowRecord; agent: AgentRecord } | undefined {
    for (const workflow of Object.values(this.state.workflows)) {
      const agent = Object.values(workflow.agents).find((candidate) => candidate.thread_id === threadId);
      if (agent) return { workflow, agent };
    }
    return undefined;
  }

  adviceEligible(advisor: AgentRecord, requesterId: string): boolean {
    return advisor.id !== requesterId && advisor.state !== "pending_context" && this.messageEligible(advisor);
  }

  messageEligible(agent: AgentRecord): boolean {
    return ["pending_context", "queued", "active", "waiting"].includes(agent.state)
      && !agent.attention_codes.includes("cancellation_requested")
      && (!agent.turn_closing || ["wait", "ask", "request_host"].includes(agent.disposition?.type ?? ""));
  }

  childRecovery(workflow: WorkflowRecord, child: AgentRecord): JsonObject {
    return { child_id: child.id, state: child.state, wait: child.wait ?? null,
      turn_closing: child.turn_closing, closing_into: child.disposition?.type ?? null,
      pending_approval_ids: Object.values(workflow.approvals).filter(a => a.agent_id === child.id && a.status === "pending").map(a => a.id),
      next_action: child.state === "submitted" ? "Review this child's submission with banana_review."
        : ["completed", "failed", "cancelled"].includes(child.state) ? "Inspect the retained result or terminal fact; there is no current submission to review."
        : child.state === "pending_context" ? "Close the spawning parent turn to let inherited context become available."
        : child.disposition?.type === "finish" ? "Wait for the child's closing turn to commit its submission."
        : "If the work is ready, send this child a request to submit with banana_finish, then wait for its submission. An ordinary status message is not a submission. Resolve any remaining dependencies first; cancellation is only for stopping work." };
  }

  narrowPermissions(parent: PermissionPolicy, request: unknown, workspace: string): PermissionPolicy {
    if (request === undefined) return structuredClone(parent);
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("permissions must be an object");
    const value = request as JsonObject;
    const allowed = ["sandbox", "writable_roots", "network_access", "tools", "mcp_servers"];
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new Error(`permissions has unknown fields: ${unknown.join(", ")}`);
    const result = structuredClone(parent);
    if (value.sandbox !== undefined) {
      if (!['readOnly', 'workspaceWrite'].includes(String(value.sandbox))) throw new Error("invalid sandbox");
      if (parent.sandbox === "readOnly" && value.sandbox === "workspaceWrite") throw widening("sandbox");
      result.sandbox = value.sandbox as PermissionPolicy["sandbox"];
      if (result.sandbox === "readOnly") result.writable_roots = [];
    }
    if (value.network_access !== undefined) {
      if (typeof value.network_access !== "boolean") throw new Error("network_access must be boolean");
      if (!parent.network_access && value.network_access) throw widening("network_access");
      result.network_access = value.network_access;
    }
    if (value.writable_roots !== undefined) {
      if (!Array.isArray(value.writable_roots) || value.writable_roots.some((item) => typeof item !== "string")) throw new Error("writable_roots must be strings");
      const roots = (value.writable_roots as string[]).map((item) => permissionPath(resolve(workspace, item)));
      for (const root of roots) if (!parent.writable_roots.some((allowedRoot) => withinWritableRoot(root, allowedRoot))) throw widening("writable_roots");
      result.writable_roots = roots;
    }
    if (value.tools !== undefined) throw new Error("app_server_unsupported: current App Server does not expose an enforceable generic built-in tool allowlist");
    for (const field of ["mcp_servers"] as const) {
      if (value[field] === undefined) continue;
      if (!Array.isArray(value[field]) || (value[field] as unknown[]).some((item) => typeof item !== "string")) throw new Error(`${field} must be strings`);
      const selected = [...new Set(value[field] as string[])];
      if (selected.some((item) => !parent[field].includes(item))) throw widening(field);
      result[field] = selected;
    }
    return result;
  }

  createWorkflow(task: string, details: JsonObject | undefined, workspaceValue: string, presets: Record<string, Preset>, recommendations: Record<string, JsonObject>, defaultPreset: string, rootPreset: string, rootPermissions: unknown, hostReported: boolean, tierConfig?: { preset_tiers: PresetTiers; active_tier: string }, workspaceMcp?: string[]): WorkflowRecord {
    const workspace = normalize(resolve(workspaceValue));
    const ceiling = ceilingForWorkspace(this.config, workspace, workspaceMcp);
    const permissions = this.narrowPermissions(ceiling, rootPermissions, workspace);
    const workflowId = id("wf"); const rootId = id("agt"); const timestamp = now();
    const root: AgentRecord = {
      id: rootId, short_id: shortId(rootId), workflow_id: workflowId, children: [], task,
      provenance: { source: "fresh" }, requested_preset: rootPreset, resolved_preset: presets[rootPreset]!,
      permissions, state: "queued", queued: false, turn_closing: false, mailbox: [], next_message_sequence: 1,
      submissions: [], attention_codes: [], created_at: timestamp, updated_at: timestamp
    };
    const workflow: WorkflowRecord = {
      id: workflowId, short_id: shortId(workflowId), root_id: rootId, task, workspace, status: "running", spawn_frozen: false,
      preset_snapshot: structuredClone(presets),
      preset_recommendations: structuredClone(Object.fromEntries(Object.entries(recommendations).filter(([name]) => name in presets))), default_preset: defaultPreset,
      ...(tierConfig ? structuredClone(tierConfig) : {}),
      permission_ceiling: ceiling,
      host_capabilities: { computer_use: this.config.runtime.host_capabilities.computer_use && hostReported },
      agents: { [rootId]: root }, advice_requests: {}, host_requests: {}, approvals: {}, events: [], next_event_sequence: 1,
      created_at: timestamp, updated_at: timestamp
    };
    if (details) workflow.details = details;
    this.state.workflows[workflow.id] = workflow;
    this.event(workflow, "workflow_created", `Workflow ${workflow.short_id} created`, root.id);
    this.persist();
    return workflow;
  }

  recomputeWorkflow(workflow: WorkflowRecord): void {
    const root = workflow.agents[workflow.root_id]!;
    if (workflow.status === "cancelling") {
      if (!Object.values(workflow.agents).some((agent) => agent.state === "active")) workflow.status = "cancelled";
      return;
    }
    if (root.state === "completed") workflow.status = "completed";
    else if (root.state === "failed") workflow.status = "failed";
    else if (root.state === "cancelled") workflow.status = "cancelled";
    else {
      const attention = Object.values(workflow.agents).some((agent) => agent.attention_codes.length
        || (agent.state === "failed" && agent.id !== root.id && !agent.failure_acknowledged && !["failed", "cancelled"].includes(workflow.agents[agent.parent_id!]?.state ?? "")))
        || Object.values(workflow.host_requests).some((request) => request.status === "uncertain");
      workflow.status = attention ? "attention_required" : "running";
    }
  }

  terminalFact(code: string, message: string, ids: string[], sideEffects: "none" | "possible" | "known" = "none", details?: JsonObject): TerminalFact {
    const fact: TerminalFact = { code, message, relevant_ids: ids, side_effects: sideEffects };
    if (details) fact.details = details;
    return fact;
  }

  async schedule(): Promise<void> {
    if (this.recovering || this.scheduling) return;
    this.scheduling = true;
    try {
      while (this.activeCount() < this.config.runtime.scheduler.max_active_turns && this.state.runnable.length) {
        this.state.runnable.sort((a, b) => a.sequence - b.sequence);
        const next = this.state.runnable.shift()!;
        const workflow = this.state.workflows[next.workflow_id];
        const agent = workflow?.agents[next.agent_id];
        if (!workflow || !agent || agent.state !== "queued") continue;
        agent.queued = false;
        await this.dispatch(workflow, agent);
      }
      this.persist();
    } finally { this.scheduling = false }
  }

  async dispatch(workflow: WorkflowRecord, agent: AgentRecord): Promise<void> {
    if (this.threadsToReconnect.delete(agent.thread_id!)) {
      await this.reconnectThread(workflow, agent);
      // A failed reconnect or cancellation while awaiting it must not start a turn.
      if (agent.state !== "queued") return;
    }
    const tier = workflow.active_tier;
    if (tier) agent.resolved_preset = structuredClone(workflow.preset_snapshot[agent.requested_preset]!);
    const intent = id("dispatch");
    const assigned = agent.mailbox.filter((item) => !item.assigned_turn_id);
    for (const item of assigned) item.assigned_turn_id = intent;
    agent.state = "active";
    agent.attention_codes = agent.attention_codes.filter((code) => code !== "child_failed");
    for (const childId of agent.children) {
      const child = workflow.agents[childId]!;
      if (child.state === "failed") child.failure_acknowledged = true;
    }
    this.recomputeWorkflow(workflow);
    agent.active_turn_id = intent;
    agent.updated_at = now();
    this.event(workflow, "turn_dispatching", `${agent.short_id} acquired an active-turn lease`, agent.id);
    this.persist();
    const earlyCompletions: JsonObject[] = [];
    let releaseStart!: () => void;
    const ready = new Promise<void>(resolve => { releaseStart = resolve });
    this.startingTurns.set(agent.id, { completions: earlyCompletions, ready });
    try {
      const input = agent.latest_turn_id ? this.delta(workflow, agent, assigned) : this.bootstrap(workflow, agent, assigned);
      const response = await this.app.startTurn(agent.thread_id!, input, agent.resolved_preset, agent.permissions);
      const turn = response.turn as JsonObject;
      const turnId = String(turn.id);
      agent.active_turn_id = turnId;
      agent.latest_turn_id = turnId;
      if (tier) (agent.routing_history ??= []).push({ turn_id: turnId, tier, preset: agent.requested_preset, resolved_preset: structuredClone(agent.resolved_preset) });
      for (const item of assigned) item.assigned_turn_id = turnId;
      const turnRouting = observedTurn(response);
      if (Object.keys(turnRouting).length) agent.observed_routing = { ...(agent.observed_routing ?? {}), ...turnRouting };
      this.event(workflow, "turn_started", `${agent.short_id} turn ${turnId} started`, agent.id);
      this.persist();
      if (agent.attention_codes.includes("cancellation_requested")) void this.app.interrupt(agent.thread_id!, turnId).catch(() => undefined);
      const completed = earlyCompletions.find(turn => turn.id === turnId);
      if (completed) await this.commitTurn(workflow, agent, completed);
    } catch (error) {
      this.failAgent(workflow, agent, "app_server_unsupported", `turn/start failed: ${String(error)}`, "possible");
      this.persist();
      void this.schedule();
    } finally { this.startingTurns.delete(agent.id); releaseStart() }
  }

  bootstrap(workflow: WorkflowRecord, agent: AgentRecord, inputs: JsonObject[]): string {
    return JSON.stringify({
      banana_split: {
        version: 1,
        identity: { workflow_id: workflow.id, agent_id: agent.id, short_id: agent.short_id, parent_id: agent.parent_id ?? null },
        task: agent.task,
        details: agent.parent_id ? agent.details ?? null : workflow.details ?? null,
        brief: agent.brief ?? null,
        workspace: workflow.workspace,
        context_provenance: agent.provenance,
        requested_preset: agent.requested_preset,
        resolved_preset: agent.resolved_preset,
        available_presets: workflow.preset_snapshot,
        ...(workflow.active_tier ? { active_tier: workflow.active_tier } : {}),
        preset_recommendations: workflow.preset_recommendations,
        effective_permissions: agent.permissions,
        advertised_host_capabilities: Object.entries(workflow.host_capabilities).filter(([, enabled]) => enabled).map(([name]) => name),
        capacity_scope: "runtime",
        max_active_turns: this.config.runtime.scheduler.max_active_turns,
        instructions: [
          "You are an independent managed Banana Split agent in the exact shared workspace above. Scope discovery and inspection to the paths and operations allowed by your assignment.",
          "Native relative paths resolve from your workflow workspace. A shell tool call with a different workdir does not change apply_patch's base directory. Use the assigned absolute file paths in patches; writable_roots restrict permission, not the working directory. Writable roots are resolved paths: when an assignment names the same directory through a symlink, use its resolved path under the effective writable roots for edits. The native patch tool rejects symlink traversal even after approval.",
          "Use only banana_* tools for orchestration. Native delegation and direct Computer Use are unavailable.",
          "A sandbox-denied command does not automatically request approval. For required work that has not been declined by the host, when your effective approval policy permits it, explicitly request an escalated rerun through the native shell tool (sandbox_permissions: require_escalated with a justification, when exposed) before reporting the work blocked. The host handles that approval. A host/user rejection is a decision, not a sandbox error: do not repeat the rejected operation or try another path or tool to perform it. Continue other authorized work and report the remaining limitation to your parent or in your root result.",
          "Choose presets only from available_presets. Only the host can change the workflow tier or preset definitions; a host change takes effect on your next turn.",
          "The main host executes advertised host capabilities; use a managed agent with an appropriate available preset when you need model judgment.",
          "When parent_id is null, you are the root: banana_finish completes this workflow and reports to the host. Otherwise it proposes your result for direct-parent review.",
          "Before accepting a child's result, verify its evidence against the assignment. Use banana_review with decision revise for unmet requirements or unresolved findings; accept when the submission meets the assignment.",
          "When your assigned work is ready, submit it with banana_finish. A banana_send progress message does not submit your result. Use to: 'parent' to contact your direct parent; banana_wait children accepts only your own direct children, and messages:true waits for messages from parents or peers.",
          "Finish useful independent work and send any progress updates before closing the turn. Call banana_wait only for a real child or message dependency; it returns immediately rather than pausing execution.",
          TURN_COMPLETION_INSTRUCTION,
          "All banana_* dynamic tools return JSON text. In JavaScript, parse each result and check ok before reading IDs. Example when child work is your only remaining dependency: const child = JSON.parse(await tools.banana_spawn({task: 'Review the changes', context: {source: 'inherit'}})); if (!child.ok) throw new Error(JSON.stringify(child.error)); const waiting = JSON.parse(await tools.banana_wait({children: [child.agent_id]})); if (!waiting.ok) throw new Error(JSON.stringify(waiting.error)); Then send your final response for this turn.",
          "Finish example: const result = JSON.parse(await tools.banana_finish({result: {outcome: 'success', summary: 'Completed the assigned work'}})); text(result); Put outcome, summary, and optional details inside result. On success, send your final response for this turn.",
          "Coordinate overlapping edits explicitly; Banana Split does not create worktrees or file locks."
        ],
        assigned_inputs: inputs
      }
    }, null, 2);
  }

  delta(workflow: WorkflowRecord, agent: AgentRecord, inputs: JsonObject[]): string {
    return JSON.stringify({ banana_split_delta: {
      identity: { workflow_id: workflow.id, agent_id: agent.id, short_id: agent.short_id },
      state: agent.state,
      ...(workflow.active_tier ? { active_tier: workflow.active_tier, available_presets: workflow.preset_snapshot, resolved_preset: agent.resolved_preset } : {}),
      direct_children: agent.children.map((childId) => { const child = workflow.agents[childId]!; return { id: child.id, short_id: child.short_id, state: child.state, task: label(child.task) } }),
      unresolved_obligations: this.obligations(workflow, agent),
      instructions: [TURN_COMPLETION_INSTRUCTION],
      assigned_inputs: inputs
    } }, null, 2);
  }

  obligations(workflow: WorkflowRecord, agent: AgentRecord): JsonObject {
    return {
      unfinished_children: agent.children.filter((childId) => !["completed", "failed", "cancelled"].includes(workflow.agents[childId]!.state)),
      inbound_advice: Object.values(workflow.advice_requests).filter((request) => request.advisor_id === agent.id && request.status === "pending").map((request) => request.id),
      outbound_advice: Object.values(workflow.advice_requests).filter((request) => request.requester_id === agent.id && ["armed", "pending"].includes(request.status)).map((request) => request.id),
      host_requests: Object.values(workflow.host_requests).filter((request) => request.requester_id === agent.id && ["armed", "pending", "in_progress", "uncertain"].includes(request.status)).map((request) => request.id)
    };
  }

  blockers(workflow: WorkflowRecord, agent: AgentRecord): JsonObject {
    const obligations = this.obligations(workflow, agent);
    const result: JsonObject = {
      ...obligations,
      submitted_children: agent.children.filter((childId) => workflow.agents[childId]!.state === "submitted")
    };
    if (agent.id === workflow.root_id) {
      result.workflow_advice_requests = Object.values(workflow.advice_requests).filter((request) => ["armed", "pending"].includes(request.status)).map((request) => request.id);
      result.workflow_host_requests = Object.values(workflow.host_requests).filter((request) => ["armed", "pending", "in_progress", "uncertain"].includes(request.status)).map((request) => request.id);
    }
    return result;
  }

  hasBlockers(workflow: WorkflowRecord, agent: AgentRecord): boolean {
    return Object.values(this.blockers(workflow, agent)).some((value) => Array.isArray(value) && value.length > 0);
  }

  async commitTurn(workflow: WorkflowRecord, agent: AgentRecord, turn: JsonObject): Promise<void> {
    const status = String(turn.status);
    const turnId = String(turn.id);
    agent.latest_turn_id = turnId;
    for (const approval of Object.values(workflow.approvals)) {
      if (approval.agent_id === agent.id && approval.turn_id === turnId && approval.status === "pending") {
        approval.status = "invalidated";
        this.event(workflow, "approval_invalidated", `Approval ${approval.id} expired with turn ${turnId}`, agent.id, approval.id);
      }
    }
    this.event(workflow, "active_capacity_changed", `${agent.short_id} released active-turn lease ${turnId}`, agent.id);
    const cancelling = agent.attention_codes.includes("cancellation_requested") || workflow.status === "cancelling";
    if (cancelling) {
      if (agent.disposition?.type === "finish") {
        agent.uncommitted_finish = { result: agent.disposition.result, turn_id: turnId, turn_status: status, recorded_at: now() };
      }
      if (agent.disposition?.type === "ask") this.cancelArmedAdvice(workflow, agent.disposition.request_id, "invalid_state", "Requesting agent was cancelled before the disposition committed");
      if (agent.disposition?.type === "request_host") this.cancelArmedHost(workflow, agent.disposition.request_id, "invalid_state", "Requesting agent was cancelled before the disposition committed");
      this.finishCancellation(workflow, agent);
      this.persist(); void this.schedule(); return;
    }
    if (status !== "completed") {
      if (agent.disposition?.type === "finish") {
        agent.uncommitted_finish = { result: agent.disposition.result, turn_id: turnId, turn_status: status, recorded_at: now() };
      }
      if (agent.disposition?.type === "ask") this.cancelArmedAdvice(workflow, agent.disposition.request_id);
      if (agent.disposition?.type === "request_host") this.cancelArmedHost(workflow, agent.disposition.request_id);
      for (const child of this.pendingContextChildren(workflow, agent, turnId)) {
        this.failAgent(workflow, child, "containing_turn_not_completed", `Spawning turn ${turnId} ended ${status}`);
      }
      this.failAgent(workflow, agent, "containing_turn_not_completed", `Turn ${turnId} ended ${status}`, "possible", (turn.error ?? {}) as JsonObject);
      this.persist(); void this.schedule(); return;
    }
    const pendingChildren = this.pendingContextChildren(workflow, agent, turnId);
    for (const child of pendingChildren) child.context_fork_started = true;
    const disposition = agent.disposition;
    agent.turn_closing = false;
    agent.disposition = undefined;
    agent.active_turn_id = undefined;
    if (!disposition) {
      agent.state = "waiting";
      agent.wait = { children: [], messages: false, reason: "no_disposition" };
      if (!agent.attention_codes.includes("no_disposition")) agent.attention_codes.push("no_disposition");
      this.event(workflow, "attention_required", `${agent.short_id} ended without a disposition`, agent.id);
    } else if (disposition.type === "wait") {
      const readyChildren = disposition.children.filter((childId) => ["submitted", "completed", "failed", "cancelled"].includes(workflow.agents[childId]?.state ?? ""));
      const messageReady = disposition.messages && agent.mailbox.some((item) => !item.assigned_turn_id);
      if (readyChildren.length || messageReady) { agent.state = "waiting"; this.enqueue(workflow, agent, [readyChildren.length ? `ready children: ${readyChildren.join(", ")}` : "", messageReady ? "buffered message" : ""].filter(Boolean).join("; ")) }
      else { agent.state = "waiting"; agent.wait = { children: disposition.children, messages: disposition.messages, reason: "declared_wait" } }
    } else if (disposition.type === "ask") {
      const request = workflow.advice_requests[disposition.request_id]!;
      agent.state = "waiting"; agent.wait = { children: [], messages: false, reason: `advice:${request.id}` };
      const advisor = workflow.agents[request.advisor_id]!;
      if (request.status === "armed" && this.adviceEligible(advisor, agent.id)) {
        request.status = "pending";
        this.deliver(workflow, advisor, agent.id, "advice_request", undefined, { request_id: request.id, question: request.question, context: request.context ?? {} });
        this.event(workflow, "advice_requested", `${agent.short_id} asked ${advisor.short_id} for guidance`, agent.id, request.id);
      } else if (request.status === "armed") {
        request.status = "failed"; request.resolved_at = now();
        request.terminal_fact = this.terminalFact("recipient_unavailable", "Advisor became unavailable before the advice request committed", [request.id, advisor.id]);
        this.deliver(workflow, agent, advisor.id, "request_cancelled", undefined, { request_id: request.id, status: request.status, terminal_fact: request.terminal_fact });
        this.event(workflow, "advice_failed", `Advisor ${advisor.short_id} became unavailable before ${request.id} committed`, agent.id, request.id);
      }
    } else if (disposition.type === "request_host") {
      const request = workflow.host_requests[disposition.request_id]!;
      request.status = "pending";
      request.pending_sequence = this.state.next_host_request_sequence++;
      agent.state = "waiting"; agent.wait = { children: [], messages: false, reason: `host:${request.id}` };
      if (agent.parent_id) this.deliver(workflow, workflow.agents[agent.parent_id]!, agent.id, "host_request_visible", request.task, { request_id: request.id, requester_id: agent.id, capability: request.capability });
      this.event(workflow, "host_action_required", `${agent.short_id} requested ${request.capability}: ${request.task}`, agent.id, request.id);
    } else {
      const pendingInputIds = agent.mailbox.filter((item) => !item.assigned_turn_id).map((item) => item.id);
      if (this.hasBlockers(workflow, agent) || pendingInputIds.length) {
        agent.state = "waiting";
        this.deliver(workflow, agent, "runtime", "finish_deferred", "Finish was deferred because new inputs or obligations need attention", { ...this.blockers(workflow, agent), pending_input_ids: pendingInputIds });
        this.enqueue(workflow, agent, "finish_deferred");
      } else if (agent.parent_id) {
        agent.state = "submitted"; agent.submission = disposition.result;
        agent.submissions.push({ result: disposition.result, submitted_at: now() });
        this.event(workflow, "submission", `${agent.short_id} submitted to its parent`, agent.id);
        const parent = workflow.agents[agent.parent_id]!;
        this.deliver(workflow, parent, agent.id, "child_submission", undefined, { child_id: agent.id, result: disposition.result });
      } else {
        agent.state = "completed"; agent.result = disposition.result;
        this.invalidateApprovals(workflow, agent);
        this.event(workflow, "root_completed", `Root ${agent.short_id} finished with outcome ${disposition.result.outcome}`, agent.id);
      }
    }
    if (agent.state === "waiting") {
      const wakeReason = this.bufferedWakeReason(agent);
      if (wakeReason) this.enqueue(workflow, agent, wakeReason);
    }
    agent.updated_at = now();
    this.recomputeWorkflow(workflow);
    this.persist();
    void this.schedule();
    await this.activatePendingChildren(workflow, agent, turnId);
    this.recomputeWorkflow(workflow);
    this.persist();
    void this.schedule();
  }

  deliver(workflow: WorkflowRecord, recipient: AgentRecord, from: string, type: string, body?: string, details?: JsonObject): JsonObject {
    const messageId = id("msg");
    const payload: { body?: string; details?: JsonObject } = {};
    if (body) payload.body = body;
    if (details) payload.details = details;
    const message = { id: messageId, from, to: recipient.id, type, payload, sequence: recipient.next_message_sequence++, sent_at: now() };
    recipient.mailbox.push(message);
    this.event(workflow, "message", `${type} delivered to ${recipient.short_id}`, recipient.id);
    if (recipient.state === "waiting") {
      const noDisposition = recipient.wait?.reason === "no_disposition";
      const directParentOrHost = from === "host" || from === recipient.parent_id;
      const obligation = ["advice_request", "advice_response", "child_submission", "child_cancelled", "review_feedback", "host_response", "agent_failure", "request_cancelled"].includes(type);
      if (obligation || recipient.wait?.messages || (noDisposition && directParentOrHost)) this.enqueue(workflow, recipient, type);
    }
    return message;
  }

  invalidateApprovals(workflow: WorkflowRecord, agent: AgentRecord): void {
    for (const approval of Object.values(workflow.approvals)) {
      if (approval.agent_id !== agent.id || approval.status !== "pending") continue;
      approval.status = "invalidated";
      // A standalone elicitation has no active native turn for interrupt to cancel.
      if (approval.method === "mcpServer/elicitation/request" && approval.turn_id === null) {
        const event = this.event(workflow, "approval_invalidated", `Standalone elicitation ${approval.id} invalidated because its agent ended`, agent.id, approval.id);
        try {
          this.app.respond(approval.request_id, { action: "cancel" });
          approval.response = { action: "cancel" }; approval.answered_at = now();
        } catch (error) {
          event.details = { response_error: String(error) };
        }
      }
    }
  }

  cancelSubtree(workflow: WorkflowRecord, target: AgentRecord, reason = "cancelled", interruptTarget = true): { settling: boolean; affected: string[] } {
    const affected: string[] = [];
    const visit = (agent: AgentRecord) => {
      for (const childId of agent.children) visit(workflow.agents[childId]!);
      if (["completed", "failed", "cancelled"].includes(agent.state)) return;
      affected.push(agent.id);
      if (agent.state === "active") {
        if (!agent.attention_codes.includes("cancellation_requested")) agent.attention_codes.push("cancellation_requested");
        this.invalidateApprovals(workflow, agent);
        // An approval's cancel response already interrupts its requesting turn.
        // Pending turn/start calls are interrupted when the native ID arrives.
        if ((agent.id !== target.id || interruptTarget) && agent.thread_id && agent.active_turn_id && !agent.active_turn_id.startsWith("dispatch_")) void this.app.interrupt(agent.thread_id, agent.active_turn_id).catch(() => undefined);
      } else this.finishCancellation(workflow, agent);
    };
    visit(target);
    this.event(workflow, "cancellation", `Cancellation requested for ${target.short_id}: ${reason}`, target.id);
    this.persist();
    return { settling: affected.some((agentId) => workflow.agents[agentId]!.state === "active"), affected };
  }

  failAgent(workflow: WorkflowRecord, agent: AgentRecord, code: string, message: string, sideEffects: "none" | "possible" | "known" = "none", details?: JsonObject): void {
    agent.state = "failed"; agent.active_turn_id = undefined; agent.queued = false; agent.turn_closing = false; agent.disposition = undefined; agent.wait = undefined;
    agent.terminal_fact = this.terminalFact(code, message, [workflow.id, agent.id], sideEffects, details);
    this.state.runnable = this.state.runnable.filter((item) => item.agent_id !== agent.id);
    this.invalidateApprovals(workflow, agent);
    for (const childId of agent.children) this.cancelSubtree(workflow, workflow.agents[childId]!, "ancestor_failed");
    this.resolveRequestsForTerminalAgent(workflow, agent, "failed");
    this.event(workflow, "agent_failed", `${agent.short_id} failed: ${message}`, agent.id);
    if (agent.parent_id) {
      const parent = workflow.agents[agent.parent_id]!;
      this.deliver(workflow, parent, agent.id, "agent_failure", message, { code, agent_id: agent.id });
      if (!parent.attention_codes.includes("child_failed")) parent.attention_codes.push("child_failed");
    }
    this.recomputeWorkflow(workflow);
  }

  finishCancellation(workflow: WorkflowRecord, agent: AgentRecord): void {
    agent.state = "cancelled"; agent.active_turn_id = undefined; agent.queued = false; agent.turn_closing = false; agent.disposition = undefined; agent.wait = undefined;
    agent.attention_codes = [];
    agent.terminal_fact = this.terminalFact("invalid_state", "Agent work was explicitly cancelled", [workflow.id, agent.id], "possible");
    this.state.runnable = this.state.runnable.filter((item) => item.agent_id !== agent.id);
    this.invalidateApprovals(workflow, agent);
    this.resolveRequestsForTerminalAgent(workflow, agent, "cancelled");
    this.event(workflow, "agent_cancelled", `${agent.short_id} cancelled; side effects may remain`, agent.id);
    if (agent.parent_id) {
      const parent = workflow.agents[agent.parent_id];
      if (parent && !["completed", "failed", "cancelled"].includes(parent.state)) {
        this.deliver(workflow, parent, agent.id, "child_cancelled", undefined, { child_id: agent.id, terminal_fact: agent.terminal_fact });
      }
    }
    this.recomputeWorkflow(workflow);
  }

  private resolveRequestsForTerminalAgent(workflow: WorkflowRecord, agent: AgentRecord, terminal: "failed" | "cancelled"): void {
    for (const request of Object.values(workflow.advice_requests)) {
      if (!["armed", "pending"].includes(request.status) || (request.requester_id !== agent.id && request.advisor_id !== agent.id)) continue;
      const resolution = request.requester_id === agent.id ? "cancelled" : terminal;
      request.status = resolution; request.resolved_at = now();
      request.terminal_fact = this.terminalFact("invalid_state", `Advice ${request.requester_id === agent.id ? "requester" : "advisor"} ${terminal}; request ${resolution}`, [request.id, agent.id]);
      const counterpartId = request.requester_id === agent.id ? request.advisor_id : request.requester_id;
      const counterpart = workflow.agents[counterpartId];
      if (counterpart && !["completed", "failed", "cancelled"].includes(counterpart.state)) this.deliver(workflow, counterpart, agent.id, "request_cancelled", undefined, { request_id: request.id, status: resolution, terminal_fact: request.terminal_fact });
    }
    for (const request of Object.values(workflow.host_requests)) {
      if (request.requester_id !== agent.id || !["armed", "pending", "in_progress", "uncertain"].includes(request.status)) continue;
      if (request.status === "in_progress" || request.status === "uncertain") {
        request.status = "uncertain"; request.resolution = "cancelled"; request.resolved_at = now();
      } else {
        request.status = "cancelled"; request.resolution = "cancelled"; request.resolved_at = now();
        request.terminal_fact = this.terminalFact("invalid_state", `Host request requester ${terminal}; request cancelled`, [request.id, agent.id]);
      }
    }
  }

  private cancelArmedAdvice(workflow: WorkflowRecord, requestId: string, code = "containing_turn_not_completed", message = "Containing turn did not complete"): void {
    const request = workflow.advice_requests[requestId]; if (!request) return;
    request.status = "cancelled"; request.resolved_at = now();
    request.terminal_fact = this.terminalFact(code, message, [request.id]);
  }
  private cancelArmedHost(workflow: WorkflowRecord, requestId: string, code = "containing_turn_not_completed", message = "Containing turn did not complete"): void {
    const request = workflow.host_requests[requestId]; if (!request) return;
    request.status = "cancelled"; request.resolution = "cancelled"; request.resolved_at = now();
    request.terminal_fact = this.terminalFact(code, message, [request.id]);
  }

  private async activatePendingChildren(workflow: WorkflowRecord, parent: AgentRecord, turnId: string): Promise<void> {
    const children = this.pendingContextChildren(workflow, parent, turnId).filter((child) => child.context_fork_started);
    for (const child of children) {
      if (child.state !== "pending_context") continue;
      try {
        const threadConfig = await this.app.prepareThread(workflow.workspace, child.permissions.mcp_servers);
        if (child.state !== "pending_context") continue;
        const response = await this.app.forkThread(parent.thread_id!, turnId, workflow.workspace, child.resolved_preset, child.permissions, threadConfig);
        child.thread_id = String((response.thread as JsonObject).id);
        await this.nameThread(workflow, child);
        child.provenance.parent_turn_id = turnId;
        child.pending_context_turn_id = undefined;
        child.context_fork_started = undefined;
        child.observed_routing = observedThread(response);
        if (child.state === "cancelled") continue;
        child.state = "waiting";
        this.enqueue(workflow, child, "inherited context ready");
      } catch (error) { if (child.state !== "cancelled") this.failAgent(workflow, child, "app_server_unsupported", `thread/fork failed: ${String(error)}`) }
    }
  }

  private pendingContextChildren(workflow: WorkflowRecord, parent: AgentRecord, turnId: string): AgentRecord[] {
    return parent.children.map((childId) => workflow.agents[childId]!)
      .filter((child) => child.state === "pending_context" && child.pending_context_turn_id === turnId);
  }

  private bufferedWakeReason(agent: AgentRecord): string | undefined {
    const obligationTypes = new Set(["advice_request", "advice_response", "child_submission", "child_cancelled", "review_feedback", "host_response", "agent_failure", "request_cancelled"]);
    for (const item of agent.mailbox) {
      if (item.assigned_turn_id) continue;
      if (obligationTypes.has(item.type)) return `buffered ${item.type}`;
      if (agent.wait?.messages) return "buffered message";
      if (agent.wait?.reason === "no_disposition" && (item.from === "host" || item.from === agent.parent_id)) return "buffered no_disposition resume";
    }
    return undefined;
  }

  private async onAppNotification(method: string, params: JsonObject): Promise<void> {
    if (method === "serverRequest/resolved") {
      const found = this.byThread(String(params.threadId)); if (!found) return;
      await this.startingTurns.get(found.agent.id)?.ready;
      for (const approval of Object.values(found.workflow.approvals)) {
        if (approval.agent_id === found.agent.id && approval.request_id === params.requestId && approval.status === "pending") {
          approval.status = "invalidated";
          this.event(found.workflow, "approval_invalidated", `Approval ${approval.id} was resolved by App Server`, found.agent.id, approval.id);
          this.persist();
        }
      }
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = params.item as JsonObject | undefined;
      if (item?.type === "fileChange" && this.byThread(String(params.threadId))) {
        const key = fileChangeKey(params.threadId, params.turnId, item.id);
        if (method === "item/started") this.pendingFileChanges.set(key, structuredClone(item.changes));
        else this.pendingFileChanges.delete(key);
      }
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const found = this.byThread(String(params.threadId)); if (!found) return;
      const usage = (params.tokenUsage ?? {}) as JsonObject;
      found.agent.token_usage = {
        turn_id: String(params.turnId),
        last: structuredClone((usage.last ?? {}) as JsonObject),
        total: structuredClone((usage.total ?? {}) as JsonObject),
        model_context_window: usage.modelContextWindow ?? null,
        updated_at: now()
      };
      this.persist();
      return;
    }
    if (method !== "turn/completed") return;
    const threadId = String(params.threadId);
    const found = this.byThread(threadId); if (!found) return;
    const turn = params.turn as JsonObject;
    if (found.agent.state !== "active" || typeof turn?.id !== "string") return;
    const earlyCompletions = this.startingTurns.get(found.agent.id)?.completions;
    if (earlyCompletions && found.agent.active_turn_id?.startsWith("dispatch_")) {
      earlyCompletions.push(structuredClone(turn));
      return;
    }
    if (found.agent.active_turn_id !== turn.id) return;
    await this.commitTurn(found.workflow, found.agent, turn);
  }

  private async onAppRequest(message: JsonObject): Promise<void> {
    const method = String(message.method); const params = (message.params ?? {}) as JsonObject;
    const startingAgent = this.byThread(String(params.threadId))?.agent;
    if (startingAgent) await this.startingTurns.get(startingAgent.id)?.ready;
    if (method === "item/tool/call") {
      const result = await this.agentTool(String(params.threadId), String(params.turnId), String(params.tool), (params.arguments ?? {}) as JsonObject);
      this.app.respond(message.id as string | number, { success: result.ok, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] });
      return;
    }
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request"].includes(method)) {
      const found = this.byThread(String(params.threadId));
      if (!found) { this.app.respond(message.id as string | number, rejectedApprovalResponse(method, false)); return }
      const details = approvalDetails(method, params);
      if (method === "item/fileChange/requestApproval") {
        const key = fileChangeKey(params.threadId, params.turnId, params.itemId);
        const changes = this.pendingFileChanges.get(key);
        if (changes !== undefined) details.file_changes = changes;
        this.pendingFileChanges.delete(key);
      }
      const approvalId = id("apr");
      found.workflow.approvals[approvalId] = {
        id: approvalId, workflow_id: found.workflow.id, agent_id: found.agent.id, thread_id: String(params.threadId),
        turn_id: typeof params.turnId === "string" ? params.turnId : null, method, request_id: message.id as string | number,
        summary: approvalSummary(method, params), status: "pending",
        details
      };
      const cancelled = found.agent.attention_codes.includes("cancellation_requested") || found.workflow.status === "cancelling" || ["completed", "failed", "cancelled"].includes(found.agent.state);
      // MCP elicitation can be a standalone server request with no native turn correlation.
      const standalone = method === "mcpServer/elicitation/request" && params.turnId == null;
      const unbound = !standalone && (found.agent.state !== "active" || found.agent.active_turn_id !== params.turnId || found.agent.turn_closing);
      if (cancelled || unbound) {
        const approval = found.workflow.approvals[approvalId]!;
        approval.status = "invalidated";
        approval.response = rejectedApprovalResponse(method, cancelled);
        approval.answered_at = now();
        this.event(found.workflow, "approval_invalidated", `Approval ${approvalId} rejected because ${cancelled ? "its agent is cancelled or terminal" : "it is not bound to an open active turn"}`, found.agent.id, approvalId);
        this.persist();
        this.app.respond(approval.request_id, approval.response);
        return;
      }
      this.event(found.workflow, "approval_required", `Approval ${approvalId}: ${approvalSummary(method, params)}`, found.agent.id, approvalId);
      this.persist(); return;
    }
    this.app.respond(message.id as string | number, {});
  }

  private async reconnectThread(workflow: WorkflowRecord, agent: AgentRecord): Promise<void> {
    try {
      const threadConfig = await this.app.prepareThread(workflow.workspace, agent.permissions.mcp_servers);
      if (["completed", "failed", "cancelled"].includes(agent.state)) return;
      const response = await this.app.resumeThread(agent.thread_id!, workflow.workspace, agent.resolved_preset, agent.permissions, threadConfig);
      const thread = response.thread as JsonObject | undefined;
      if (!thread || thread.id !== agent.thread_id) throw new Error("App Server did not return the retained thread identity");
      const routing = observedThread(response);
      if (Object.keys(routing).length) agent.observed_routing = { ...(agent.observed_routing ?? {}), ...routing };
      this.event(workflow, "thread_reconnected", `${agent.short_id} reconnected to retained thread ${agent.thread_id}`, agent.id);
    } catch (error) {
      if (["completed", "failed", "cancelled"].includes(agent.state)) return;
      this.failAgent(workflow, agent, "reconciliation_required", `Retained thread could not be reconnected: ${String(error)}`, "possible");
    }
  }

  private async reconcileActive(workflow: WorkflowRecord, agent: AgentRecord): Promise<void> {
    if (!agent.thread_id) { this.failAgent(workflow, agent, "reconciliation_required", "Active agent had no thread id"); return }
    const turnId = agent.active_turn_id;
    const stillActive = () => agent.state === "active" && agent.active_turn_id === turnId;
    try {
      const threadConfig = await this.app.prepareThread(workflow.workspace, agent.permissions.mcp_servers);
      if (!stillActive()) return;
      const response = await this.app.resumeThread(agent.thread_id, workflow.workspace, agent.resolved_preset, agent.permissions, threadConfig);
      if (!stillActive()) return;
      let thread = response.thread as JsonObject;
      if (!thread || thread.id !== agent.thread_id) throw new Error("App Server did not return the active thread identity");
      if (!Array.isArray(thread.turns)) thread = (await this.app.readThread(agent.thread_id)).thread as JsonObject;
      if (!stillActive()) return;
      const turns = (thread.turns ?? []) as JsonObject[];
      const turn = turns.find((item) => item.id === turnId);
      if (!turn) throw new Error("active turn not found");
      if (turn.status === "inProgress") {
        this.event(workflow, "turn_reconciled", `${agent.short_id} reattached to active turn ${String(agent.active_turn_id)}`, agent.id);
        if (agent.attention_codes.includes("cancellation_requested") || workflow.status === "cancelling") {
          await this.app.interrupt(agent.thread_id, String(turn.id));
        }
        return;
      }
      this.event(workflow, "turn_reconciled", `${agent.short_id} recovered terminal turn ${String(turn.id)}`, agent.id);
      await this.commitTurn(workflow, agent, turn);
    } catch (error) {
      if (!stillActive()) return;
      this.failAgent(workflow, agent, "reconciliation_required", `Active turn state is ambiguous: ${String(error)}`, "possible");
    }
  }
}

function rejectedApprovalResponse(method: string, cancel: boolean): JsonObject {
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  if (method === "item/tool/requestUserInput") return { answers: {} };
  if (method === "mcpServer/elicitation/request") return { action: "cancel" };
  return { decision: cancel ? "cancel" : "decline" };
}

function widening(axis: string): Error { const error = new Error(`permission_widening: ${axis} would broaden authority`); return error }
function stableErrorCode(message: string): string {
  for (const code of ["app_server_unsupported", "permission_widening", "persistence_failed"]) if (message.startsWith(code)) return code;
  return "invalid_input";
}
export function label(task: string): string { return task.replace(/\s+/g, " ").trim().slice(0, 96) }
function observedThread(response: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const key of ["model", "serviceTier", "modelProvider"]) if (response[key] !== undefined) result[key] = response[key];
  return result;
}
function observedTurn(response: JsonObject): JsonObject {
  const result = observedThread(response);
  if (response.reasoningEffort !== undefined) result.reasoningEffort = response.reasoningEffort;
  return result;
}
function fileChangeKey(threadId: unknown, turnId: unknown, itemId: unknown): string {
  return JSON.stringify([threadId, turnId, itemId]);
}

function approvalDetails(method: string, params: JsonObject): JsonObject {
  const fields = method === "item/commandExecution/requestApproval"
    ? ["availableDecisions", "command", "cwd", "reason", "additionalPermissions"]
    : method === "item/fileChange/requestApproval"
      ? ["grantRoot", "reason"]
      : method === "item/permissions/requestApproval"
        ? ["cwd", "reason", "permissions"]
        : method === "item/tool/requestUserInput"
          ? ["questions", "autoResolutionMs"]
          : ["serverName", "mode", "message", "requestedSchema", "url", "elicitationId"];
  const responseContract = method === "item/permissions/requestApproval"
    ? "details.response = {permissions, scope, strictAutoReview?}"
    : method === "item/tool/requestUserInput"
      ? "details.response = {answers: {question_id: {answers: string[]}}}"
      : method === "mcpServer/elicitation/request"
        ? "details.response = {action: accept | decline | cancel, content: object | null, _meta: object | null}"
        : "decision is relayed as {decision}";
  const details: JsonObject = { response_contract: responseContract };
  if (params.itemId !== undefined) details.itemId = params.itemId;
  for (const field of fields) if (params[field] !== undefined) details[field] = structuredClone(params[field]);
  if (method === "item/fileChange/requestApproval") details.availableDecisions = ["accept", "acceptForSession", "decline", "cancel"];
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    // App Server can omit decline from its UI choices while accepting it on the wire.
    const decisions = (details.availableDecisions ?? ["accept", "cancel"]) as unknown[];
    if (!decisions.includes("decline")) decisions.push("decline");
    details.availableDecisions = decisions;
    details.response_contract = 'Pass a decision value directly, for example decision: "accept"; Banana wraps it as the native {decision} response. decline rejects this operation and lets the agent continue; cancel interrupts the agent and cancels its subtree. details are retained for inspection, not delivered to the agent.';
    if (method === "item/fileChange/requestApproval") details.response_contract += " Before deciding, inspect request.file_changes paths and diff from the native proposal. If absent, use banana_agent_inspect with transcript_limit to match turn_id and request.itemId; pending patches may be absent from that transcript, so missing evidence does not authorize approval.";
  }
  return details;
}
function approvalSummary(method: string, params: JsonObject): string {
  if (method === "item/tool/requestUserInput") {
    const questions = (params.questions ?? []) as JsonObject[];
    const text = questions.map((question) => String(question.question ?? question.header ?? "")).filter(Boolean).join("; ");
    return ("User input requested: " + (text || "questions available")).slice(0, 240);
  }
  if (method === "mcpServer/elicitation/request") {
    return (String(params.serverName ?? "MCP server") + ": " + String(params.message ?? "elicitation requested")).slice(0, 240);
  }
  if (method === "item/permissions/requestApproval") {
    return String(params.reason ?? ("Permissions requested for " + String(params.cwd ?? "managed turn"))).slice(0, 240);
  }
  return String(params.reason ?? params.command ?? params.message ?? `${method} for turn ${String(params.turnId)}`).slice(0, 240);
}
