import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { AppServer, ownedAppServerArgs } from "../src/app-server.js";
import { Engine } from "../src/engine.js";
import type { JsonObject, PermissionPolicy, RuntimeConfig, WorkflowRecord } from "../src/model.js";
import { RuntimeOwner } from "../src/runtime-rpc.js";
import { Store } from "../src/store.js";

class FakeApp {
  request?: (message: JsonObject) => Promise<void>;
  notification?: (method: string, params: JsonObject) => Promise<void>;
  nextThread = 1; nextTurn = 1;
  forks: Array<{ thread: string; turn: string }> = [];
  forkBarrier?: Promise<void>;
  failThreadStart = false;
  starts: string[] = [];
  resumes: string[] = [];
  responses: JsonObject[] = [];
  onRequest(handler: (message: JsonObject) => Promise<void>) { this.request = handler }
  onNotification(handler: (method: string, params: JsonObject) => Promise<void>) { this.notification = handler }
  async start() {}
  validateMcpServers() {}
  async validatePresets() {}
  async probe() {}
  async startThread() { if (this.failThreadStart) throw new Error("start unavailable"); return { thread: { id: `thread-${this.nextThread++}` }, model: "model", reasoningEffort: "high" } }
  async forkThread(thread: string, turn: string) { this.forks.push({ thread, turn }); await this.forkBarrier; return { thread: { id: `thread-${this.nextThread++}` }, model: "model", reasoningEffort: "high" } }
  async startTurn(thread: string) { const id = `turn-${this.nextTurn++}`; this.starts.push(thread); return { turn: { id, status: "inProgress" } } }
  async interrupt() { return {} }
  async readThread() { return { thread: { turns: [] } } }
  async resumeThread(threadId: string) { this.resumes.push(threadId); return { thread: { id: threadId, turns: [] }, model: "model", reasoningEffort: "high" } }
  async listItems() { return { data: [], nextCursor: null } }
  respond(_id: unknown, value: JsonObject) { this.responses.push(value) }
  stop() {}
  async emit(threadId: string, turnId: string, status = "completed") { await this.notification?.("turn/completed", { threadId, turn: { id: turnId, status, items: [] } }) }
}

const workspace = resolve(".");
const permission: PermissionPolicy = { sandbox: "workspaceWrite", writable_roots: [workspace], network_access: false, approval_policy: "onRequest", approval_reviewer: "host", tools: ["shell_command", "apply_patch"], mcp_servers: [] };

function setup(max = 16, host = true): { engine: Engine; app: FakeApp; workflow: WorkflowRecord } {
  const data = resolve(".banana-test", crypto.randomUUID()); mkdirSync(data, { recursive: true });
  const config: RuntimeConfig = {
    version: 1,
    runtime: { data_directory: data, listen_port: 43891, scheduler: { max_active_turns: max },
      permission_ceiling: { sandbox: "workspaceWrite", network_access: false, approval_policy: "onRequest", approval_reviewer: "host", tools: permission.tools, mcp_servers: [] },
      host_capabilities: { computer_use: true }, codex_command: "codex" },
    workflow_defaults: { default_preset: "default", presets: { default: { model: "model", reasoning_effort: "high" } }, preset_recommendations: {} }
  };
  const app = new FakeApp(); const engine = new Engine(config, new Store(data), app as never);
  const workflow = engine.createWorkflow("root task", undefined, workspace, config.workflow_defaults.presets, {}, "default", "default", undefined, host);
  const root = workflow.agents[workflow.root_id]!; root.thread_id = "root-thread"; root.state = "active"; root.active_turn_id = "root-turn"; root.latest_turn_id = "root-turn";
  engine.persist(); return { engine, app, workflow };
}
const tick = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 5));

describe("scheduler and context provenance", () => {
  test("more than 16 recursive agents use one active-turn ceiling and FIFO drains", async () => {
    const { engine, app, workflow } = setup(16);
    const root = workflow.agents[workflow.root_id]!;
    for (let index = 0; index < 20; index++) {
      const result = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: `child ${index}`, context: { source: "fresh" } });
      expect(result.ok).toBe(true);
    }
    await tick();
    expect(Object.keys(workflow.agents)).toHaveLength(21);
    expect(engine.activeCount()).toBe(16);
    expect(engine.state.runnable).toHaveLength(5);
    const activeChild = Object.values(workflow.agents).find((agent) => agent.parent_id && agent.state === "active")!;
    await app.emit(activeChild.thread_id!, activeChild.active_turn_id!);
    await tick();
    expect(engine.activeCount()).toBe(16);
    expect(engine.state.runnable).toHaveLength(4);
  });

  test("inherited child forks only through the completed spawning turn", async () => {
    const { engine, app, workflow } = setup(4); const root = workflow.agents[workflow.root_id]!;
    const result = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "inherit", context: { source: "inherit", brief: { fact: 1 } } });
    expect(result.ok).toBe(true); const child = workflow.agents[String((result as JsonObject).agent_id)]!;
    expect(child.state).toBe("pending_context"); expect(app.forks).toHaveLength(0);
    await app.emit(root.thread_id!, root.active_turn_id!); await tick();
    expect(app.forks).toEqual([{ thread: "root-thread", turn: "root-turn" }]);
    expect(child.provenance).toEqual({ source: "inherit", parent_turn_id: "root-turn" });
    expect(child.observed_routing).toEqual({ model: "model" });
    expect(child.observed_routing?.reasoningEffort).toBeUndefined();
  });

  test("a completed parent releases its slot while inherited context is forking", async () => {
    const { engine, app, workflow } = setup(1); const root = workflow.agents[workflow.root_id]!;
    const freshResult = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "fresh", context: { source: "fresh" } });
    const inheritResult = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "inherit", context: { source: "inherit" } });
    const fresh = workflow.agents[String((freshResult as JsonObject).agent_id)]!;
    const inherited = workflow.agents[String((inheritResult as JsonObject).agent_id)]!;
    let releaseFork!: () => void; app.forkBarrier = new Promise<void>((resolvePromise) => { releaseFork = resolvePromise });
    const completion = app.emit(root.thread_id!, root.active_turn_id!); await tick();
    expect(root.state).not.toBe("active"); expect(fresh.state).toBe("active"); expect(inherited.state).toBe("pending_context");
    releaseFork(); await completion;
  });

  test("a failed spawning turn fails its pending inherited child", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const result = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "inherit", context: { source: "inherit" } });
    const child = workflow.agents[String((result as JsonObject).agent_id)]!;
    await app.emit(root.thread_id!, root.active_turn_id!, "failed");
    expect(child.state).toBe("failed"); expect(child.terminal_fact?.code).toBe("containing_turn_not_completed");
  });

  test("fresh thread allocation failure returns the retained failed child honestly", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!; app.failThreadStart = true;
    const result = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "fresh", context: { source: "fresh" } });
    expect(result).toMatchObject({ ok: false, error: { code: "app_server_unsupported", state: "failed", side_effects: "possible" } });
    const child = workflow.agents[String((result as { ok: false; error: JsonObject }).error.agent_id)]!;
    expect(child.state).toBe("failed"); expect(child.terminal_fact?.code).toBe("app_server_unsupported");
  });

  test("root thread allocation failure returns the retained failed workflow honestly", async () => {
    const { engine, app } = setup(); app.failThreadStart = true;
    const result = await engine.hostTool("banana_workflow_start", { task: "new workflow", workspace });
    expect(result).toMatchObject({ ok: false, error: { code: "app_server_unsupported", state: "failed", side_effects: "possible" } });
    const error = (result as { ok: false; error: JsonObject }).error;
    const retained = engine.state.workflows[String(error.workflow_id)]!;
    expect(retained.status).toBe("failed"); expect(retained.agents[String(error.agent_id)]!.terminal_fact?.code).toBe("app_server_unsupported");
  });

  test("turn-closing disposition remains active until successful turn completion", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const childResult = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "child", context: { source: "inherit" } });
    const result = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { children: [(childResult as JsonObject).agent_id] });
    expect(result).toMatchObject({ ok: true, turn_closing: true }); expect(root.state).toBe("active");
    const later = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_send", { to: (childResult as JsonObject).agent_id, message: { type: "late", body: "no" } });
    expect(later).toMatchObject({ ok: false, error: { code: "turn_closing" } });
    await app.emit(root.thread_id!, root.active_turn_id!); expect(root.state).not.toBe("active");
  });

  test("only the exact active turn completion can commit a disposition", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { messages: true });
    await app.emit(root.thread_id!, "stale-turn");
    expect(root.state).toBe("active"); expect(root.turn_closing).toBe(true);
    await app.emit(root.thread_id!, root.active_turn_id!);
    expect(root.state).toBe("waiting");
    expect(workflow.events.some((event) => event.type === "active_capacity_changed" && event.agent_id === root.id)).toBe(true);
  });

  test("latest token usage is normalized onto the matching agent and exposed by inspect", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    await app.notification?.("thread/tokenUsage/updated", {
      threadId: root.thread_id, turnId: root.active_turn_id,
      tokenUsage: {
        last: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        total: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        modelContextWindow: 128000
      }
    });
    const inspect = await engine.hostTool("banana_agent_inspect", { workflow_id: workflow.id, agent_id: root.id });
    expect(((inspect as JsonObject).agent as JsonObject).token_usage).toMatchObject({
      turn_id: "root-turn", last: { totalTokens: 14 }, total: { totalTokens: 28 }, model_context_window: 128000
    });
  });
});

describe("messaging, dependencies, and review", () => {
  test("no_disposition resumes exactly once from direct parent message", async () => {
    const { engine, app, workflow } = setup(3); const root = workflow.agents[workflow.root_id]!;
    const spawn = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "child", context: { source: "fresh" } }); await tick();
    const child = workflow.agents[String((spawn as JsonObject).agent_id)]!; await app.emit(child.thread_id!, child.active_turn_id!);
    expect(child.wait?.reason).toBe("no_disposition");
    const sent = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_send", { to: child.id, message: { type: "resume", body: "continue" } });
    expect(sent.ok).toBe(true); await tick(); expect(["queued", "active"]).toContain(child.state);
    expect(engine.state.runnable.filter((item) => item.agent_id === child.id).length).toBeLessThanOrEqual(1);
    expect(workflow.status).toBe("running");
  });

  test("a direct-parent message buffered during a turn resumes no_disposition with that input assigned", async () => {
    const { engine, app, workflow } = setup(2); const root = workflow.agents[workflow.root_id]!;
    const spawn = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "child", context: { source: "fresh" } }); await tick();
    const child = workflow.agents[String((spawn as JsonObject).agent_id)]!;
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_send", { to: child.id, message: { type: "resume", body: "continue" } });
    const message = child.mailbox.at(-1)!; await app.emit(child.thread_id!, child.active_turn_id!); await tick();
    expect(["queued", "active"]).toContain(child.state); expect(message.assigned_turn_id).toBe(child.active_turn_id);
    expect(engine.state.runnable.filter((item) => item.agent_id === child.id).length).toBeLessThanOrEqual(1);
  });

  test("a buffered obligation wakes an outbound advice wait without resolving it", async () => {
    const { engine, app, workflow } = setup(3); const root = workflow.agents[workflow.root_id]!;
    const advisorResult = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "advisor", context: { source: "fresh" } });
    const workerResult = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "worker", context: { source: "fresh" } }); await tick();
    const advisor = workflow.agents[String((advisorResult as JsonObject).agent_id)]!;
    const worker = workflow.agents[String((workerResult as JsonObject).agent_id)]!;
    const ask = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_ask", { to: advisor.id, question: "Which?" });
    await engine.agentTool(worker.thread_id!, worker.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "done" } });
    await app.emit(worker.thread_id!, worker.active_turn_id!);
    await app.emit(root.thread_id!, root.active_turn_id!); await tick();
    expect(["queued", "active"]).toContain(root.state);
    expect(workflow.advice_requests[String((ask as JsonObject).request_id)]!.status).toBe("pending");
  });

  test("advice is correlated and requester retains a single continuation", async () => {
    const { engine, app, workflow } = setup(3); const root = workflow.agents[workflow.root_id]!;
    const spawn = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "advisor", context: { source: "fresh" } }); await tick();
    const advisor = workflow.agents[String((spawn as JsonObject).agent_id)]!;
    const ask = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_ask", { to: advisor.id, question: "Which?" });
    const requestId = String((ask as JsonObject).request_id); await app.emit(root.thread_id!, root.active_turn_id!);
    expect(workflow.advice_requests[requestId]!.status).toBe("pending"); expect(root.state).toBe("waiting");
    const replied = await engine.agentTool(advisor.thread_id!, advisor.active_turn_id!, "banana_reply", { request_id: requestId, status: "answered", guidance: "A" });
    expect(replied.ok).toBe(true); expect(workflow.advice_requests[requestId]!.status).toBe("answered");
    await tick();
    expect(["queued", "active"]).toContain(root.state);
  });

  test("an armed advice request is never reopened after its advisor fails", async () => {
    const { engine, app, workflow } = setup(2); const root = workflow.agents[workflow.root_id]!;
    const spawn = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "advisor", context: { source: "fresh" } }); await tick();
    const advisor = workflow.agents[String((spawn as JsonObject).agent_id)]!;
    const ask = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_ask", { to: advisor.id, question: "Which?" });
    const requestId = String((ask as JsonObject).request_id); engine.failAgent(workflow, advisor, "invalid_state", "advisor failed");
    expect(workflow.advice_requests[requestId]!.status).toBe("failed");
    await app.emit(root.thread_id!, root.active_turn_id!); await tick();
    expect(workflow.advice_requests[requestId]!.status).toBe("failed"); expect(["queued", "active"]).toContain(root.state);
    expect(advisor.failure_acknowledged).toBe(true); expect(workflow.status).toBe("running");
  });

  test("revision resumes the same child thread and acceptance preserves judged outcome", async () => {
    const { engine, app, workflow } = setup(3); const root = workflow.agents[workflow.root_id]!;
    const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "work", context: { source: "fresh" } }); await tick();
    const child = workflow.agents[String((spawned as JsonObject).agent_id)]!; const originalThread = child.thread_id;
    await engine.agentTool(child.thread_id!, child.active_turn_id!, "banana_finish", { result: { outcome: "partial", summary: "first" } }); await app.emit(child.thread_id!, child.active_turn_id!);
    expect(child.state).toBe("submitted");
    const revise = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_review", { child_id: child.id, decision: "revise", feedback: { summary: "fix" } });
    expect(revise.ok).toBe(true); await tick(); expect(child.thread_id).toBe(originalThread);
    await engine.agentTool(child.thread_id!, child.active_turn_id!, "banana_finish", { result: { outcome: "partial", summary: "revised" } }); await app.emit(child.thread_id!, child.active_turn_id!);
    const accept = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_review", { child_id: child.id, decision: "accept" });
    expect(accept.ok).toBe(true); expect(child.result?.outcome).toBe("partial"); expect(child.state).toBe("completed");
  });
});

describe("permissions, host requests, cancellation, and visibility", () => {
  test("omission inherits permissions, narrowing succeeds, widening is rejected", async () => {
    const { engine, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const inherited = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "same", context: { source: "fresh" } });
    expect(workflow.agents[String((inherited as JsonObject).agent_id)]!.permissions).toEqual(root.permissions);
    const narrow = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "narrow", context: { source: "fresh" }, permissions: { sandbox: "readOnly" } });
    expect(workflow.agents[String((narrow as JsonObject).agent_id)]!.permissions.sandbox).toBe("readOnly");
    const unsupportedTools = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "tool narrow", context: { source: "fresh" }, permissions: { tools: [] } });
    expect(unsupportedTools).toMatchObject({ ok: false, error: { code: "app_server_unsupported" } });
    const denied = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "wide", context: { source: "fresh" }, permissions: { network_access: true } });
    expect(denied).toMatchObject({ ok: false, error: { code: "permission_widening" } });
  });

  test("host capability is unadvertised when the host reports nothing", async () => {
    const { engine, workflow } = setup(16, false); const root = workflow.agents[workflow.root_id]!;
    const result = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_request_host", { capability: "computer_use", task: "click" });
    expect(result).toMatchObject({ ok: false, error: { code: "capability_unavailable" } }); expect(Object.keys(workflow.host_requests)).toHaveLength(0);
  });

  test("Computer Use is exposed only after turn close and globally serialized", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const armed = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_request_host", { capability: "computer_use", task: "open app", expected_evidence: { screenshot: true } });
    const requestId = String((armed as JsonObject).request_id); expect(workflow.host_requests[requestId]!.status).toBe("armed");
    await app.emit(root.thread_id!, root.active_turn_id!); expect(workflow.host_requests[requestId]!.status).toBe("pending");
    const claim = await engine.hostTool("banana_host_respond", { workflow_id: workflow.id, request_id: requestId, status: "in_progress" }); expect(claim.ok).toBe(true);
    const done = await engine.hostTool("banana_host_respond", { workflow_id: workflow.id, request_id: requestId, status: "completed", summary: "done", details: { evidence: "screen" } });
    await tick();
    expect(done.ok).toBe(true); expect(workflow.host_requests[requestId]!.status).toBe("completed"); expect(["queued", "active"]).toContain(root.state);
  });

  test("spawn freeze and recursive cancellation preserve inspectable evidence", async () => {
    const { engine, workflow } = setup(3); const root = workflow.agents[workflow.root_id]!;
    await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "freeze_spawning" });
    const denied = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "blocked", context: { source: "fresh" } });
    expect(denied).toMatchObject({ ok: false, error: { code: "spawn_frozen" } });
    await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "reopen_spawning" });
    const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "child", context: { source: "fresh" } });
    const child = workflow.agents[String((spawned as JsonObject).agent_id)]!;
    const cancelled = await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_subtree", agent_id: child.id });
    expect(cancelled.ok).toBe(true); expect(["active", "cancelled"]).toContain(child.state);
  });

  test("a selected child cancellation wakes its waiting parent", async () => {
    const { engine, app, workflow } = setup(2); const root = workflow.agents[workflow.root_id]!;
    const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "child", context: { source: "fresh" } });
    const child = workflow.agents[String((spawned as JsonObject).agent_id)]!; await tick();
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { children: [child.id] });
    await app.emit(root.thread_id!, root.active_turn_id!); expect(root.state).toBe("waiting");
    await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_subtree", agent_id: child.id });
    await app.emit(child.thread_id!, child.active_turn_id!, "interrupted"); await tick();
    expect(child.state).toBe("cancelled"); expect(["queued", "active"]).toContain(root.state); expect(workflow.status).toBe("running");
  });

  test("a completed turn still settles as cancelled when interruption races completion", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "must not commit" } });
    await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_workflow" });
    await app.emit(root.thread_id!, root.active_turn_id!, "completed");
    expect(root.state).toBe("cancelled"); expect(workflow.status).toBe("cancelled"); expect(root.result).toBeUndefined();
    expect(root.uncommitted_finish?.result.summary).toBe("must not commit");
  });

  test("root finish remains blocked by an uncertain descendant host action", async () => {
    const { engine, app, workflow } = setup(2); const root = workflow.agents[workflow.root_id]!;
    const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "child", context: { source: "fresh" } }); await tick();
    const child = workflow.agents[String((spawned as JsonObject).agent_id)]!;
    const armed = await engine.agentTool(child.thread_id!, child.active_turn_id!, "banana_request_host", { capability: "computer_use", task: "external action" });
    const requestId = String((armed as JsonObject).request_id); await app.emit(child.thread_id!, child.active_turn_id!);
    await engine.hostTool("banana_host_respond", { workflow_id: workflow.id, request_id: requestId, status: "in_progress" });
    await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_subtree", agent_id: child.id });
    expect(workflow.host_requests[requestId]!.status).toBe("uncertain");
    const finish = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "too early" } });
    expect(finish).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  test("poll and inspect use stable IDs and omit payloads by default", async () => {
    const { engine, workflow } = setup();
    const poll = await engine.hostTool("banana_workflow_poll", { workflow_id: workflow.short_id, timeout_ms: 0, event_limit: 10 });
    expect(poll.ok).toBe(true); expect((poll as JsonObject).snapshot).toBeTruthy();
    const inspect = await engine.hostTool("banana_agent_inspect", { workflow_id: workflow.id, agent_id: workflow.agents[workflow.root_id]!.short_id });
    expect(inspect.ok).toBe(true); expect(((inspect as JsonObject).agent as JsonObject).task).toBeUndefined();
  });

  test("poll omits host request context and explicit inspection reveals it", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_request_host", {
      capability: "computer_use", task: "bounded task", context: { secret: "context" }, expected_evidence: { secret: "evidence" }
    });
    await app.emit(root.thread_id!, root.active_turn_id!);
    const poll = await engine.hostTool("banana_workflow_poll", { workflow_id: workflow.id, timeout_ms: 0 });
    const required = ((poll as JsonObject).snapshot as JsonObject).host_action_required as JsonObject;
    expect(required.context).toBeUndefined(); expect(required.expected_evidence).toBeUndefined();
    const inspect = await engine.hostTool("banana_agent_inspect", { workflow_id: workflow.id, agent_id: root.id, include_payloads: true });
    const requests = (((inspect as JsonObject).agent as JsonObject).host_requests as JsonObject[]);
    expect((requests[0]!.context as JsonObject).secret).toBe("context");
    const cancellation = await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_workflow" });
    expect(cancellation).toMatchObject({ ok: true, snapshot: { status: "cancelled" } });
    const terminalPoll = await engine.hostTool("banana_workflow_poll", { workflow_id: workflow.id, timeout_ms: 0 });
    const terminalSnapshot = (terminalPoll as JsonObject).snapshot as JsonObject;
    const terminated = ((((terminalSnapshot.final as JsonObject).terminated_requests ?? []) as JsonObject[]))[0]!;
    expect(terminated).toMatchObject({ type: "host_capability", request_id: requests[0]!.id, status: "cancelled" });
    expect(terminated.task).toBeUndefined(); expect(terminated.context).toBeUndefined(); expect(terminated.details).toBeUndefined();
  });

  test("failed containing turn cancels an armed host request", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const armed = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_request_host", { capability: "computer_use", task: "must not commit" });
    const requestId = String((armed as JsonObject).request_id);
    await app.emit(root.thread_id!, root.active_turn_id!, "failed");
    expect(workflow.host_requests[requestId]!.status).toBe("cancelled");
    expect(root.terminal_fact?.code).toBe("containing_turn_not_completed");
  });

  test("failed containing turn retains an armed finish only as diagnostic evidence", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "not committed" } });
    await app.emit(root.thread_id!, root.active_turn_id!, "failed");
    expect(root.state).toBe("failed"); expect(root.result).toBeUndefined(); expect(root.disposition).toBeUndefined();
    expect(root.uncommitted_finish?.result.summary).toBe("not committed");
  });

  test("mechanical completion preserves a partial root outcome", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_finish", { result: { outcome: "partial", summary: "useful but incomplete" } });
    await app.emit(root.thread_id!, root.active_turn_id!);
    const poll = await engine.hostTool("banana_workflow_poll", { workflow_id: workflow.id, timeout_ms: 0 });
    expect(((poll as JsonObject).final as JsonObject).status).toBe("completed");
    expect((((poll as JsonObject).final as JsonObject).root_result as JsonObject).outcome).toBe("partial");
  });

  test("restart turns an in-progress host action uncertain without resuming the requester", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const armed = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_request_host", { capability: "computer_use", task: "external action" });
    const requestId = String((armed as JsonObject).request_id); await app.emit(root.thread_id!, root.active_turn_id!);
    await engine.hostTool("banana_host_respond", { workflow_id: workflow.id, request_id: requestId, status: "in_progress" });
    const recoveryApp = new FakeApp();
    const recovered = new Engine(engine.config, new Store(dirname(engine.store.paths[0])), recoveryApp as never);
    await recovered.initialize();
    const recoveredWorkflow = recovered.state.workflows[workflow.id]!;
    expect(recoveredWorkflow.host_requests[requestId]!.status).toBe("uncertain");
    expect(recoveredWorkflow.agents[root.id]!.state).toBe("waiting");
    expect(recoveryApp.resumes).toContain("root-thread");
    await recovered.hostTool("banana_host_respond", { workflow_id: workflow.id, request_id: requestId, status: "completed", summary: "reconciled" }); await tick();
    expect(recoveryApp.starts).toContain("root-thread");
  });
});

describe("durable checkpoints", () => {
  test("a torn newest checkpoint falls back to the previous flushed generation", () => {
    const data = resolve(".banana-test", crypto.randomUUID()); const store = new Store(data);
    const state = store.load(); state.next_runnable_sequence = 2; store.save(state);
    state.next_runnable_sequence = 3; store.save(state);
    writeFileSync(store.paths[0], "{torn", "utf8");
    expect(new Store(data).load().next_runnable_sequence).toBe(2);
  });
});

describe("App Server isolation", () => {
  test("owned App Server launch shadows and disables both Banana MCP transports", () => {
    expect(ownedAppServerArgs(43893)).toEqual([
      "-c", 'mcp_servers.banana-split.command="disabled"',
      "-c", "mcp_servers.banana-split.enabled=false",
      "-c", 'mcp_servers.banana-split-v1.command="disabled"',
      "-c", "mcp_servers.banana-split-v1.enabled=false",
      "app-server", "--listen", "ws://127.0.0.1:43893"
    ]);
  });

  test("per-thread isolation carries valid Banana shadows and isolates other configured MCPs", () => {
    const app = new AppServer("codex", 43892);
    (app as unknown as { effectiveConfig: JsonObject }).effectiveConfig = {
      mcp_servers: {
        node_repl: { command: "node" },
        database: { command: "database" },
        "banana-split": { command: "disabled", enabled: false },
        "banana-split-v1": { command: "disabled", enabled: false }
      },
      plugins: {
        unrelated: { enabled: true },
        "banana-split@banana-split": { enabled: true },
        "banana-split@banana-split-v1": { enabled: true },
        "banana-split-v1@banana-split-v1": { enabled: true }
      }
    };
    const isolated = app.isolationConfig(["node_repl", "banana-split", "banana-split-v1"]);
    expect(isolated.mcp_servers).toEqual({
      node_repl: { enabled: true },
      database: { enabled: false },
      "banana-split": { command: "disabled", enabled: false },
      "banana-split-v1": { command: "disabled", enabled: false }
    });
    expect(isolated.plugins).toEqual({
      unrelated: { enabled: false },
      "banana-split@banana-split": { enabled: false },
      "banana-split@banana-split-v1": { enabled: false },
      "banana-split-v1@banana-split-v1": { enabled: false },
      "banana-split": { enabled: false },
      "banana-split@personal": { enabled: false },
      "banana-split-v1": { enabled: false }
    });
  });

  test("thread transcripts flatten authoritative turn items with deterministic paging", async () => {
    const app = new AppServer("codex", 43892);
    app.readThread = async () => ({ thread: { turns: [
      { id: "turn-1", items: [{ id: "item-1" }, { id: "item-2" }] },
      { id: "turn-2", items: [{ id: "item-3" }] }
    ] } });
    expect(await app.listItems("thread-1", undefined, 2)).toEqual({
      data: [
        { turnId: "turn-1", item: { id: "item-1" } },
        { turnId: "turn-1", item: { id: "item-2" } }
      ],
      nextCursor: "2"
    });
    expect(await app.listItems("thread-1", "2", 2)).toEqual({
      data: [{ turnId: "turn-2", item: { id: "item-3" } }],
      nextCursor: null
    });
  });

  test("preset validation accepts an advertised additional speed tier", async () => {
    const app = new AppServer("codex", 43892);
    app.models = async () => [{
      id: "gpt-5.6-luna", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }],
      serviceTiers: [{ id: "priority" }], additionalSpeedTiers: ["fast"]
    }];
    await expect(app.validatePresets({ luna: { model: "gpt-5.6-luna", reasoning_effort: "xhigh", service_tier: "fast" } })).resolves.toBeUndefined();
  });

  test("startup MCP allowlists reject names absent from config/read", () => {
    const app = new AppServer("codex", 43892);
    (app as unknown as { effectiveConfig: JsonObject }).effectiveConfig = { mcp_servers: { node_repl: { enabled: true } } };
    expect(() => app.validateMcpServers(["node_repl"])).not.toThrow();
    expect(() => app.validateMcpServers(["missing"])).toThrow("configured MCP servers are unavailable: missing");
  });
});

describe("approval relay", () => {
  test("attention exposes bounded response facts and relays exact protocol responses", async () => {
    const cases: Array<{ method: string; params: JsonObject; expected: JsonObject; response: JsonObject }> = [
      {
        method: "item/permissions/requestApproval",
        params: { cwd: workspace, permissions: { network: { enabled: false } }, reason: "Need scoped access" },
        expected: { permissions: { network: { enabled: false } } },
        response: { permissions: { network: { enabled: false } }, scope: "turn" }
      },
      {
        method: "item/tool/requestUserInput",
        params: { questions: [{ id: "choice", header: "Choice", question: "Which option?", options: [{ label: "A", description: "Use A" }] }] },
        expected: { questions: [{ id: "choice", question: "Which option?" }] },
        response: { answers: { choice: { answers: ["A"] } } }
      },
      {
        method: "mcpServer/elicitation/request",
        params: { serverName: "allowlisted-server", mode: "form", message: "Provide project", requestedSchema: { type: "object", properties: { project: { type: "string" } } } },
        expected: { serverName: "allowlisted-server", mode: "form", message: "Provide project" },
        response: { action: "decline", content: null, _meta: null }
      }
    ];
    for (const item of cases) {
      const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
      await app.request?.({ id: "rpc-approval", method: item.method, params: { threadId: root.thread_id, turnId: root.active_turn_id, itemId: "item-1", ...item.params } });
      const poll = await engine.hostTool("banana_workflow_poll", { workflow_id: workflow.id, timeout_ms: 0 });
      const attention = ((((poll as JsonObject).snapshot as JsonObject).attention ?? []) as JsonObject[]).find((entry) => entry.type === "approval")!;
      expect(attention).toMatchObject({ method: item.method, request: item.expected });
      expect(((attention.request as JsonObject).response_contract as string).startsWith("details.response")).toBe(true);
      const approvalId = String(attention.approval_id);
      const relayed = await engine.hostTool("banana_approval_respond", {
        workflow_id: workflow.id, approval_id: approvalId, decision: "responded", details: { response: item.response }
      });
      expect(relayed.ok).toBe(true);
      expect(app.responses.at(-1)).toEqual(item.response);
    }
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    await app.request?.({
      id: "rpc-file-approval", method: "item/fileChange/requestApproval",
      params: { threadId: root.thread_id, turnId: root.active_turn_id, itemId: "item-file", reason: "Apply changes" }
    });
    const poll = await engine.hostTool("banana_workflow_poll", { workflow_id: workflow.id, timeout_ms: 0 });
    const attention = ((((poll as JsonObject).snapshot as JsonObject).attention ?? []) as JsonObject[]).find((entry) => entry.type === "approval")!;
    expect((attention.request as JsonObject).availableDecisions).toEqual(["accept", "acceptForSession", "decline", "cancel"]);
    await engine.hostTool("banana_approval_respond", {
      workflow_id: workflow.id, approval_id: attention.approval_id, decision: "accept"
    });
    expect(app.responses.at(-1)).toEqual({ decision: "accept" });
  });
});

describe("stable wire errors", () => {
  test("permission widening and persistence failures retain their stable codes", async () => {
    const { engine, workflow } = setup();
    const widening = await engine.hostTool("banana_workflow_start", { task: "other", workspace, root_permissions: { network_access: true } });
    expect(widening).toMatchObject({ ok: false, error: { code: "permission_widening" } });
    engine.persist = () => { throw new Error("persistence_failed: disk unavailable") };
    const persistence = await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "freeze_spawning" });
    expect(persistence).toMatchObject({ ok: false, error: { code: "persistence_failed" } });
  });
});

describe("runtime ownership", () => {
  test("one durable data directory cannot have two runtime owners on different ports", async () => {
    const data = resolve(".banana-test", crypto.randomUUID());
    const first = new RuntimeOwner(0, data);
    const second = new RuntimeOwner(0, data);
    await first.listen();
    try {
      await expect(second.listen()).rejects.toThrow("already owns this durable data directory");
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("closing the runtime drops accepted connections before releasing its listener", async () => {
    const owner = new RuntimeOwner(0, resolve(".banana-test", crypto.randomUUID()));
    await owner.listen();
    const server = (owner as unknown as { server: import("node:net").Server }).server;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    const client = createConnection({ host: "127.0.0.1", port: address.port });
    await new Promise<void>((resolvePromise, reject) => {
      client.once("connect", resolvePromise);
      client.once("error", reject);
    });
    try {
      await owner.close();
      if (!client.destroyed) await new Promise<void>((resolvePromise) => client.once("close", resolvePromise));
      expect(server.listening).toBe(false);
      expect(client.destroyed).toBe(true);
    } finally {
      client.destroy();
      await owner.close();
    }
  });
});
