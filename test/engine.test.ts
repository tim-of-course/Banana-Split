import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { AppServer, ownedAppServerArgs } from "../src/app-server.js";
import { Engine } from "../src/engine.js";
import type { JsonObject, PermissionPolicy, Preset, PresetTiers, RuntimeConfig, WorkflowRecord } from "../src/model.js";
import { readPresetTiers } from "../src/presets.js";
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
  turnRouting: Array<{ input: string; preset: Preset }> = [];
  resumes: string[] = [];
  responses: JsonObject[] = [];
  interrupts: Array<{ thread: string; turn: string }> = [];
  names: Array<{ threadId: string; name: string }> = [];
  onRequest(handler: (message: JsonObject) => Promise<void>) { this.request = handler }
  onNotification(handler: (method: string, params: JsonObject) => Promise<void>) { this.notification = handler }
  async start() { return false }
  async prepareThread() { return {} }
  validateMcpServers() {}
  async validatePresets() {}
  async probe() {}
  async setThreadName(threadId: string, name: string) { this.names.push({ threadId, name }); return {} }
  async startThread() { if (this.failThreadStart) throw new Error("start unavailable"); return { thread: { id: `thread-${this.nextThread++}` }, model: "model", reasoningEffort: "high" } }
  async forkThread(thread: string, turn: string) { this.forks.push({ thread, turn }); await this.forkBarrier; return { thread: { id: `thread-${this.nextThread++}` }, model: "model", reasoningEffort: "high" } }
  async startTurn(thread: string, input: string, preset: Preset) { const id = `turn-${this.nextTurn++}`; this.starts.push(thread); this.turnRouting.push({ input, preset: structuredClone(preset) }); return { turn: { id, status: "inProgress" } } }
  async interrupt(thread: string, turn: string) { this.interrupts.push({ thread, turn }); return {} }
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

function configReadFixture(config: RuntimeConfig, configuredMcp: JsonObject = {}) {
  const app = new AppServer("unused", 0);
  const calls: Array<{ method: string; params: JsonObject }> = [];
  const instance = crypto.randomUUID();
  let thread = 0, turn = 0;
  let notification!: (method: string, params: JsonObject) => Promise<void>;
  let gate: { entered(): void; wait: Promise<void> } | undefined;
  app.start = async () => false;
  app.validatePresets = async () => {};
  app.onNotification = handler => { notification = handler };
  app.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "config/read") {
      const pending = gate; gate = undefined;
      if (pending) { pending.entered(); await pending.wait }
      return { config: { mcp_servers: { global_server: { command: "global" }, ...configuredMcp } }, layers: [{ name: { type: "project" }, config: { mcp_servers: configuredMcp } }, { name: { type: "project" }, disabledReason: "untrusted", config: { mcp_servers: { global_server: {} } } }, { name: { type: "user" }, config: { mcp_servers: { global_server: { command: "global" } } } }] };
    }
    if (method === "thread/start" || method === "thread/fork") return { thread: { id: `${instance}-thread-${++thread}` } };
    if (method === "thread/read" || method === "thread/resume") return { thread: { id: params.threadId, turns: [] } };
    if (method === "turn/start") return { turn: { id: `${instance}-turn-${++turn}`, status: "inProgress" } };
    return {};
  };
  const engine = new Engine(config, new Store(config.runtime.data_directory), app);
  return {
    app, engine, calls,
    blockConfig() {
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve });
      const wait = new Promise<void>(resolve => { release = resolve });
      gate = { entered, wait };
      return { reached, release };
    },
    complete(threadId: string, turnId: string) { return notification("turn/completed", { threadId, turn: { id: turnId, status: "completed" } }) }
  };
}

describe("scheduler and context provenance", () => {
  for (const waitingRoot of [false, true]) test(`root subtree cancellation waits for child interruption with root ${waitingRoot ? "waiting" : "active"}`, async () => {
    const config = structuredClone(setup().engine.config);
    config.runtime.data_directory = resolve(".banana-test", crypto.randomUUID());
    const app = new FakeApp(); const engine = new Engine(config, new Store(config.runtime.data_directory), app as never);
    const started = await engine.hostTool("banana_workflow_start", { task: "Root cancellation", workspace }); await tick();
    expect(started.ok).toBe(true);
    const workflow = engine.state.workflows[String(started.workflow_id)]!; const root = workflow.agents[workflow.root_id]!;
    const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "worker", context: { source: "fresh" } }); await tick();
    const child = workflow.agents[String(spawned.agent_id)]!; const childTurn = child.active_turn_id!; const rootTurn = root.active_turn_id!;
    if (waitingRoot) {
      await engine.agentTool(root.thread_id!, rootTurn, "banana_wait", { children: [child.id] });
      await app.emit(root.thread_id!, rootTurn);
    }
    const response = await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_subtree", agent_id: root.id });
    expect(response).toMatchObject({ ok: true, cancellation: { settling: true }, snapshot: { status: "cancelling" } });
    expect(child.state).toBe("active");
    expect(child.attention_codes).toContain("cancellation_requested");
    if (!waitingRoot) await app.emit(root.thread_id!, rootTurn, "interrupted");
    expect(root.state).toBe("cancelled");
    expect(workflow.status).toBe("cancelling");
    expect(engine.store.load().workflows[workflow.id]!.status).toBe("cancelling");
    await app.emit(child.thread_id!, childTurn, "interrupted");
    expect(child.state).toBe("cancelled");
    expect(workflow.status).toBe("cancelled");
    expect(engine.activeCount()).toBe(0);
  });

  for (const startFails of [false, true]) test(`early native tool requests wait for turn binding when start ${startFails ? "fails" : "succeeds"}`, async () => {
    const config = structuredClone(setup().engine.config);
    config.runtime.data_directory = resolve(".banana-test", crypto.randomUUID());
    const app = new FakeApp();
    const engine = new Engine(config, new Store(config.runtime.data_directory), app as never);
    const start = app.startTurn.bind(app);
    let pendingRequest: Promise<void> | undefined, responseBeforeBinding = false;
    app.startTurn = async (...args) => {
      const response = await start(...args);
      pendingRequest = app.request!({ id: "early-wait", method: "item/tool/call", params: { threadId: args[0], turnId: response.turn.id, tool: "banana_wait", arguments: { messages: true } } });
      await tick();
      responseBeforeBinding = app.responses.length > 0;
      if (startFails) throw new Error("start response failed");
      return response;
    };
    const started = await engine.hostTool("banana_workflow_start", { task: "Early wait request", workspace });
    await tick(); await tick(); await pendingRequest;
    expect(responseBeforeBinding).toBe(false);
    expect(app.responses).toHaveLength(1);
    expect(app.responses[0]!.success).toBe(!startFails);
    const workflow = engine.state.workflows[String(started.workflow_id)]!;
    const root = workflow.agents[workflow.root_id]!;
    if (startFails) expect(root.state).toBe("failed");
    else {
      expect(root.disposition?.type).toBe("wait");
      await app.emit(root.thread_id!, root.active_turn_id!);
      expect(root.state).toBe("waiting");
      expect(root.attention_codes).not.toContain("no_disposition");
    }
  });

  test("a recovered continuation settles when native completion precedes the start response", async () => {
    const config = structuredClone(setup().engine.config);
    config.runtime.data_directory = resolve(".banana-test", crypto.randomUUID());
    const first = configReadFixture(config);
    const started = await first.engine.hostTool("banana_workflow_start", { task: "Fast recovered continuation", workspace });
    expect(started.ok).toBe(true); await tick();
    const original = first.engine.state.workflows[String(started.workflow_id)]!;
    const root = original.agents[original.root_id]!;
    const oldTurn = root.active_turn_id!;
    await first.engine.agentTool(root.thread_id!, oldTurn, "banana_wait", { messages: true });
    await first.complete(root.thread_id!, oldTurn);
    const recovered = configReadFixture(config);
    await recovered.engine.initialize();
    const call = recovered.app.call.bind(recovered.app);
    recovered.app.call = async (method, params) => {
      const response = await call(method, params);
      if (method === "turn/start") {
        await recovered.complete(root.thread_id!, oldTurn);
        const turn = response.turn as JsonObject;
        await recovered.complete(root.thread_id!, String(turn.id));
        await recovered.complete(root.thread_id!, String(turn.id));
      }
      return response;
    };
    await recovered.engine.hostTool("banana_workflow_send", { workflow_id: original.id, agent_id: root.id, message: { type: "resume", body: "Continue once" } });
    await tick();
    const workflow = recovered.engine.state.workflows[original.id]!;
    const continued = workflow.agents[root.id]!;
    expect(continued.state).toBe("waiting");
    expect(continued.attention_codes).toContain("no_disposition");
    expect(continued.active_turn_id).toBeUndefined();
    expect(continued.latest_turn_id).not.toBe(oldTurn);
    expect(recovered.engine.activeCount()).toBe(0);
    expect(workflow.events.filter(event => event.type === "active_capacity_changed")).toHaveLength(2);
    expect(recovered.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  });

  for (const boundary of ["config/read", "thread/resume", "thread/read"]) test(`settled host requests survive completion during recovery ${boundary}`, async () => {
    const config = structuredClone(setup().engine.config);
    config.runtime.data_directory = resolve(".banana-test", crypto.randomUUID());
    const first = configReadFixture(config);
    const started = await first.engine.hostTool("banana_workflow_start", { task: "Request during recovery", workspace, host_capabilities: { computer_use: true } });
    expect(started.ok).toBe(true); await tick();
    const original = first.engine.state.workflows[String(started.workflow_id)]!;
    const root = original.agents[original.root_id]!;
    const armed = await first.engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_request_host", { capability: "computer_use", task: "Observe only after host claim" });
    expect(armed.ok).toBe(true);
    const recovered = configReadFixture(config);
    const call = recovered.app.call.bind(recovered.app);
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve });
    const barrier = new Promise<void>(resolve => { release = resolve });
    recovered.app.call = async (method, params) => {
      if (method === boundary) {
        entered(); await barrier;
        if (boundary === "config/read") throw new Error("late config failure");
      }
      if (boundary === "thread/read" && method === "thread/resume") return { thread: { id: params.threadId } };
      return call(method, params);
    };
    const initializing = recovered.engine.initialize();
    await reached;
    await recovered.complete(root.thread_id!, root.active_turn_id!);
    release(); await initializing;
    const workflow = recovered.engine.state.workflows[original.id]!;
    expect(workflow.agents[root.id]!.state).toBe("waiting");
    expect(workflow.agents[root.id]!.terminal_fact).toBeUndefined();
    expect(workflow.host_requests[String(armed.request_id)]!.status).toBe("pending");
    expect(workflow.events.filter(event => event.type === "active_capacity_changed")).toHaveLength(1);
    expect(workflow.events.filter(event => event.type === "turn_reconciled")).toHaveLength(0);
  });

  test("native completion survives a later recovery preparation failure", async () => {
    const config = structuredClone(setup().engine.config);
    config.runtime.data_directory = resolve(".banana-test", crypto.randomUUID());
    config.runtime.permission_ceiling.mcp_servers = ["project_server"];
    const first = configReadFixture(config, { project_server: { command: "configured" } });
    const started = await first.engine.hostTool("banana_workflow_start", { task: "Finish during recovery", workspace });
    expect(started.ok).toBe(true); await tick();
    const original = first.engine.state.workflows[String(started.workflow_id)]!;
    const originalRoot = original.agents[original.root_id]!;
    expect((await first.engine.agentTool(originalRoot.thread_id!, originalRoot.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "Already finished" } })).ok).toBe(true);
    const recovered = configReadFixture(config);
    const barrier = recovered.blockConfig();
    const initializing = recovered.engine.initialize();
    await barrier.reached;
    const workflow = recovered.engine.state.workflows[original.id]!;
    const root = workflow.agents[workflow.root_id]!;
    await recovered.complete(root.thread_id!, root.active_turn_id!);
    expect(workflow.status).toBe("completed");
    barrier.release(); await initializing;
    expect(workflow.status).toBe("completed");
    expect(root.result).toEqual({ outcome: "success", summary: "Already finished" });
    expect(root.terminal_fact).toBeUndefined();
  });

  test("workspace MCP mode snapshots each project's enabled servers and preserves narrowing", async () => {
    const config = structuredClone(setup().engine.config);
    config.runtime.data_directory = resolve(".banana-test", crypto.randomUUID());
    config.runtime.permission_ceiling.mcp_servers = "workspace";
    const configured: JsonObject = { project_a: { command: "a" }, disabled: { command: "disabled", enabled: false }, "banana-split-v1": { command: "host" } };
    const { engine, calls } = configReadFixture(config, configured);
    const first = await engine.hostTool("banana_workflow_start", { task: "Project A", workspace });
    expect(first.ok).toBe(true);
    const workflow = engine.state.workflows[String(first.workflow_id)]!;
    expect(workflow.permission_ceiling.mcp_servers).toEqual(["project_a"]);
    expect(workflow.agents[workflow.root_id]!.permissions.mcp_servers).toEqual(["project_a"]);
    const otherWorkspace = resolve(".banana-test", crypto.randomUUID());
    mkdirSync(otherWorkspace, { recursive: true });
    delete configured.project_a; configured.project_b = { command: "b" };
    const second = await engine.hostTool("banana_workflow_start", { task: "Project B", workspace: otherWorkspace, root_permissions: { mcp_servers: [] } });
    expect(second.ok).toBe(true);
    const other = engine.state.workflows[String(second.workflow_id)]!;
    expect(other.permission_ceiling.mcp_servers).toEqual(["project_b"]);
    expect(other.agents[other.root_id]!.permissions.mcp_servers).toEqual([]);
    expect(workflow.permission_ceiling.mcp_servers).toEqual(["project_a"]);
    expect(() => engine.narrowPermissions(other.agents[other.root_id]!.permissions, { mcp_servers: ["project_b"] }, workspace)).toThrow("permission_widening");
    const rejected = await engine.hostTool("banana_workflow_start", { task: "Foreign server", workspace: otherWorkspace, root_permissions: { mcp_servers: ["project_a"] } });
    expect(rejected).toMatchObject({ ok: false, error: { code: "permission_widening", side_effects: "none" } });
    expect(Object.keys(engine.state.workflows)).toHaveLength(2);
    expect(calls.filter(c => c.method === "config/read").map(c => c.params.cwd)).toContain(workspace);
    expect(calls.filter(c => c.method === "config/read").map(c => c.params.cwd)).toContain(otherWorkspace);
  });

  test("workspace MCP validation rejects before durable workflow allocation", async () => {
    const config = structuredClone(setup().engine.config);
    config.runtime.data_directory = resolve(".banana-test", crypto.randomUUID());
    config.runtime.permission_ceiling.mcp_servers = ["missing_project_server"];
    const { engine, calls } = configReadFixture(config);
    const rejected = await engine.hostTool("banana_workflow_start", { task: "Missing workspace MCP", workspace });
    expect(rejected).toMatchObject({ ok: false, error: { code: "app_server_unsupported", side_effects: "none" } });
    expect(Object.keys(engine.state.workflows)).toEqual([]);
    expect(calls.some(call => call.method === "thread/start")).toBe(false);
  });

  test("cancellation during config preparation prevents later native start, fork and resume", async () => {
    for (const source of ["fresh", "inherit", "resume"] as const) {
      const config = structuredClone(setup().engine.config);
      config.runtime.data_directory = resolve(".banana-test", crypto.randomUUID());
      let fixture = configReadFixture(config);
      const started = await fixture.engine.hostTool("banana_workflow_start", { task: `Cancel during ${source} preparation`, workspace });
      expect(started.ok).toBe(true); await tick();
      let workflow = fixture.engine.state.workflows[String(started.workflow_id)]!;
      let root = workflow.agents[workflow.root_id]!;
      if (source === "resume") {
        await fixture.engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { messages: true });
        await fixture.complete(root.thread_id!, root.active_turn_id!);
        fixture = configReadFixture(config);
        await fixture.engine.initialize();
        workflow = fixture.engine.state.workflows[workflow.id]!;
        root = workflow.agents[workflow.root_id]!;
      }
      const barrier = fixture.blockConfig();
      let pending: Promise<unknown>, target = root;
      if (source === "fresh") {
        pending = fixture.engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "Fresh child", context: { source } });
        await barrier.reached;
        target = workflow.agents[root.children[0]!]!;
      } else if (source === "inherit") {
        const child = await fixture.engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "Inherited child", context: { source } });
        target = workflow.agents[String(child.agent_id)]!;
        await fixture.engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { children: [target.id] });
        pending = fixture.complete(root.thread_id!, root.active_turn_id!);
        await barrier.reached;
      } else {
        pending = fixture.engine.hostTool("banana_workflow_send", { workflow_id: workflow.id, agent_id: root.id, message: { type: "resume", body: "Continue retained work" } });
        await barrier.reached;
      }
      const before = fixture.calls.length;
      expect((await fixture.engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_subtree", agent_id: target.id })).ok).toBe(true);
      expect(target.state).toBe("cancelled");
      barrier.release(); await pending; await tick();
      expect(target.state).toBe("cancelled");
      const method = source === "fresh" ? "thread/start" : source === "inherit" ? "thread/fork" : "thread/resume";
      expect(fixture.calls.slice(before).filter(call => call.method === method).map(call => call.method)).toEqual([]);
      if (source !== "resume") expect(target.thread_id).toBeUndefined();
    }
  });

  test("late workflow cancellation preserves a settled outcome", async () => {
    for (const status of ["completed", "failed"] as const) {
      const { engine, app, workflow } = setup();
      const root = workflow.agents[workflow.root_id]!;
      if (status === "completed") {
        expect((await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "Completed before cancellation arrived" } })).ok).toBe(true);
      }
      await app.emit(root.thread_id!, root.active_turn_id!, status);
      expect(workflow.status).toBe(status);
      const before = structuredClone(workflow);
      const late = await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_workflow" });
      expect(late.ok).toBe(false);
      expect(late.error?.code).toBe("invalid_state");
      expect(workflow).toEqual(before);
    }
  });

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
    expect(app.names).toContainEqual({ threadId: child.thread_id!, name: `${basename(workspace)}: inherit [${child.short_id}]` });
  });

  test("root and fresh child receive readable names before their first turn", async () => {
    const { engine, app } = setup();
    const started = await engine.hostTool("banana_workflow_start", { task: "Review\n accessibility", workspace });
    expect(started.ok).toBe(true);
    await tick();
    const workflow = Object.values(engine.state.workflows).find((item) => item.task === "Review\n accessibility")!;
    const root = workflow.agents[workflow.root_id]!;
    expect(app.names).toContainEqual({ threadId: root.thread_id!, name: `${basename(workspace)}: Review accessibility [${root.short_id}]` });
    const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "UI review", context: { source: "fresh" } });
    const child = workflow.agents[String(spawned.agent_id)]!;
    expect(app.names).toContainEqual({ threadId: child.thread_id!, name: `${basename(workspace)}: UI review [${child.short_id}]` });
  });

  test("structured assignment details reach root and child bootstraps without leaking to fresh children", async () => {
    const { engine, app } = setup(5);
    const details = { assignment: "Exact root requirements", status: "domain metadata", nested: { values: [1, 2] } };
    const started = await engine.hostTool("banana_workflow_start", { task: "Structured root", workspace, details });
    expect(started.ok).toBe(true); await tick();
    const workflow = engine.state.workflows[String(started.workflow_id)]!;
    const root = workflow.agents[workflow.root_id]!;
    const bootstrap = (task: string) => app.turnRouting.map((turn) => JSON.parse(turn.input).banana_split).find((packet) => packet.task === task);
    expect(bootstrap(root.task).details).toEqual(details);
    const plain = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "No parent details", context: { source: "fresh" } });
    expect(plain.ok).toBe(true); await tick();
    expect(bootstrap("No parent details").details).toBeNull();
    expect(JSON.stringify(bootstrap("No parent details"))).not.toContain(details.assignment);
    for (const source of ["fresh", "inherit"]) {
      const childDetails = { assignment: `${source} child requirements` };
      const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: `${source} task`, context: { source, brief: { scope: "child brief" } }, details: childDetails });
      expect(spawned.ok).toBe(true);
      if (source === "inherit") await app.emit(root.thread_id!, root.active_turn_id!);
      await tick();
      expect(bootstrap(`${source} task`).details).toEqual(childDetails);
      expect(bootstrap(`${source} task`).brief).toEqual({ scope: "child brief" });
    }
    expect(engine.store.load().workflows[workflow.id]!.details).toEqual(details);
  });

  test("dynamic-tool JSON spawn and wait releases capacity and resumes on submission", async () => {
    const { engine, app, workflow } = setup(1); const root = workflow.agents[workflow.root_id]!;
    const call = async (agent: typeof root, tool: string, args: JsonObject): Promise<string> => {
      await app.request!({ id: 1, method: "item/tool/call", params: { threadId: agent.thread_id, turnId: agent.active_turn_id, tool, arguments: args } });
      const response = app.responses.at(-1)!;
      expect(response.success).toBe(true);
      return ((response.contentItems as JsonObject[])[0]!.text as string);
    };
    const tools = {
      banana_spawn: (args: JsonObject) => call(root, "banana_spawn", args),
      banana_wait: (args: JsonObject) => call(root, "banana_wait", args)
    };
    const child = JSON.parse(await tools.banana_spawn({ task: "Review the changes", context: { source: "inherit" } }));
    if (!child.ok) throw new Error(JSON.stringify(child.error));
    const waiting = JSON.parse(await tools.banana_wait({ children: [child.agent_id] }));
    if (!waiting.ok) throw new Error(JSON.stringify(waiting.error));
    expect(waiting.instruction).toContain("Send your final response for this turn now");
    expect(engine.activeCount()).toBe(1);
    await app.emit(root.thread_id!, root.active_turn_id!); await tick();
    const worker = workflow.agents[child.agent_id]!;
    expect(root.state).toBe("waiting"); expect(worker.state).toBe("active");
    expect(engine.activeCount()).toBe(1);
    const finished = JSON.parse(await call(worker, "banana_finish", { result: { outcome: "success", summary: "Reviewed" } }));
    expect(finished.instruction).toContain("Send your final response for this turn now");
    await app.emit(worker.thread_id!, worker.active_turn_id!); await tick();
    expect(worker.state).toBe("submitted"); expect(root.state).toBe("active");
    expect(root.active_turn_id).not.toBe("root-turn");
    expect(engine.activeCount()).toBe(1);
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

  test("cancelling a child during thread allocation prevents its first turn", async () => {
    for (const source of ["fresh", "inherit"] as const) for (const allocationFails of [false, true]) {
      const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve });
      const allocate = async () => { await barrier; if (allocationFails) throw new Error("allocation failed"); return { thread: { id: "late-thread" }, model: "model", reasoningEffort: "high" } };
      app.startThread = allocate; app.forkThread = allocate;
      const spawning = engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "cancel during allocation", context: { source } });
      if (source === "inherit") await spawning;
      const completing = source === "inherit" ? app.emit(root.thread_id!, root.active_turn_id!) : undefined;
      await tick();
      const child = workflow.agents[root.children[0]!]!;
      await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_subtree", agent_id: child.id });
      expect(child.state).toBe("cancelled");
      release(); await spawning; await completing; await tick();
      expect(child.state).toBe("cancelled");
      expect(child.active_turn_id).toBeUndefined();
      expect(app.starts).not.toContain("late-thread");
    }
  });

  test("cancelling a workflow during root allocation cannot revive it", async () => {
    for (const allocationFails of [false, true]) {
      const { engine, app } = setup();
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve });
      app.startThread = async () => { await barrier; if (allocationFails) throw new Error("allocation failed"); return { thread: { id: "late-root" }, model: "model", reasoningEffort: "high" } };
      const starting = engine.hostTool("banana_workflow_start", { task: "cancel during allocation", workspace });
      await tick();
      const workflow = Object.values(engine.state.workflows).find(w => w.task === "cancel during allocation")!;
      await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_workflow" });
      release();
      expect(await starting).toMatchObject({ ok: false, error: { code: "invalid_state", state: "cancelled" } });
      expect(workflow.status).toBe("cancelled");
      expect(workflow.agents[workflow.root_id]!.state).toBe("cancelled");
      expect(app.starts).not.toContain("late-root");
    }
  });

  test("cancellation during turn dispatch interrupts the returned native turn", async () => {
    const { engine, app, workflow } = setup(1); const root = workflow.agents[workflow.root_id]!;
    const spawning = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "cancel during dispatch", context: { source: "fresh" } });
    const child = workflow.agents[String(spawning.agent_id)]!;
    let release!: () => void;
    app.startTurn = async () => { await new Promise<void>(resolve => { release = resolve }); return { turn: { id: "native-turn", status: "inProgress" } } };
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { children: [child.id] });
    await app.emit(root.thread_id!, root.active_turn_id!); await tick();
    await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_subtree", agent_id: child.id });
    release(); await tick();
    expect(app.interrupts).toEqual([{ thread: child.thread_id!, turn: "native-turn" }]);
    await app.emit(child.thread_id!, "native-turn", "interrupted");
    expect(child.state).toBe("cancelled");
  });

  test("a cancelling agent cannot admit new work before interruption settles", async () => {
    const { engine, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_workflow" });
    expect(root.state).toBe("active");
    const result = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "late work", context: { source: "fresh" } });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(root.children).toHaveLength(0);
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
  test.each(["root", "child"])("%s finish delivers accepted inputs before committing, without repeated deferral", async (role) => {
    const { engine, app } = setup();
    const started = await engine.hostTool("banana_workflow_start", { task: "Pending input completion", workspace });
    await tick();
    const workflow = engine.state.workflows[String(started.workflow_id)]!;
    const root = workflow.agents[workflow.root_id]!;
    let agent = root;
    if (role === "child") {
      const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "worker", context: { source: "fresh" } });
      await tick(); agent = workflow.agents[String(spawned.agent_id)]!;
    }
    for (const body of ["Use threshold 10", "Include the correction in the result"]) {
      expect((await engine.hostTool("banana_workflow_send", { workflow_id: workflow.id, agent_id: agent.id, message: { type: "correction", body } })).ok).toBe(true);
    }
    const finish = (summary: string) => engine.agentTool(agent.thread_id!, agent.active_turn_id!, "banana_finish", { result: { outcome: "success", summary } });
    expect((await finish("Old threshold")).ok).toBe(true);
    await app.emit(agent.thread_id!, agent.active_turn_id!); await tick();
    expect(agent.state).toBe("active");
    expect(agent.result).toBeUndefined(); expect(agent.submissions).toHaveLength(0);
    const inputs = JSON.parse(app.turnRouting.at(-1)!.input).banana_split_delta.assigned_inputs;
    expect(inputs.map((item: JsonObject) => item.type)).toEqual(["correction", "correction", "finish_deferred"]);
    expect(agent.mailbox.every(item => item.assigned_turn_id === agent.active_turn_id)).toBe(true);
    expect((await finish("Corrected threshold 10")).ok).toBe(true);
    await app.emit(agent.thread_id!, agent.active_turn_id!); await tick();
    expect(agent.state).toBe(role === "root" ? "completed" : "submitted");
    expect(app.starts.filter(thread => thread === agent.thread_id)).toHaveLength(2);
    expect(agent.mailbox.filter(item => item.type === "finish_deferred")).toHaveLength(1);
  });

  test("parent receives a child's failure before committing its own finish", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "worker", context: { source: "fresh" } }); await tick();
    const child = workflow.agents[String(spawned.agent_id)]!;
    await app.emit(child.thread_id!, child.active_turn_id!, "failed");
    expect(child.failure_acknowledged).not.toBe(true);
    expect((await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "Unaware of failure" } })).ok).toBe(true);
    await app.emit(root.thread_id!, root.active_turn_id!); await tick();
    expect(root.state).toBe("active"); expect(child.failure_acknowledged).toBe(true);
    const inputs = JSON.parse(app.turnRouting.at(-1)!.input).banana_split_delta.assigned_inputs;
    expect(inputs.some((item: JsonObject) => item.type === "agent_failure")).toBe(true);
    expect((await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_finish", { result: { outcome: "partial", summary: "Worker failed; report remaining work" } })).ok).toBe(true);
    await app.emit(root.thread_id!, root.active_turn_id!); await tick();
    expect(workflow.status).toBe("completed"); expect(root.result?.outcome).toBe("partial");
    expect(app.starts.filter(thread => thread === root.thread_id)).toHaveLength(1);
  });

  test.each(["wait", "ask", "request_host"])("messages arriving while closing into %s survive until an eligible turn", async (closing) => {
    const { engine, app, workflow } = setup(3); const root = workflow.agents[workflow.root_id]!;
    const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "peer", context: { source: "fresh" } }); await tick();
    const peer = workflow.agents[String(spawned.agent_id)]!;
    const args = closing === "wait" ? { messages: true } : closing === "ask" ? { to: peer.id, question: "Which option?" } : { capability: "computer_use", task: "Inspect example" };
    const closed = await engine.agentTool(root.thread_id!, root.active_turn_id!, `banana_${closing}`, args);
    expect(closed.ok).toBe(true);
    expect((await engine.agentTool(peer.thread_id!, peer.active_turn_id!, "banana_send", { to: "parent", message: { type: "update", body: "peer evidence" } })).ok).toBe(true);
    expect((await engine.hostTool("banana_workflow_send", { workflow_id: workflow.id, agent_id: root.id, message: { type: "update", body: "host evidence" } })).ok).toBe(true);
    const messages = root.mailbox.slice();
    expect(messages).toHaveLength(2);
    expect(messages.every(message => !message.assigned_turn_id)).toBe(true);
    await app.emit(root.thread_id!, root.active_turn_id!); await tick();
    if (closing !== "wait") {
      expect(root.state).toBe("waiting");
      expect(messages.every(message => !message.assigned_turn_id)).toBe(true);
      if (closing === "ask") {
        await engine.agentTool(peer.thread_id!, peer.active_turn_id!, "banana_reply", { request_id: closed.request_id, status: "answered", guidance: "Use A" });
      } else {
        await engine.hostTool("banana_host_respond", { workflow_id: workflow.id, request_id: closed.request_id, status: "in_progress" });
        await engine.hostTool("banana_host_respond", { workflow_id: workflow.id, request_id: closed.request_id, status: "completed", summary: "Inspected" });
      }
      await tick();
    }
    expect(root.state).toBe("active");
    expect(messages.every(message => message.assigned_turn_id === root.active_turn_id)).toBe(true);
    const queued = workflow.events.filter(event => event.agent_id === root.id && event.type === "agent_queued");
    expect(queued).toHaveLength(1);
    expect(root.last_queue_reason).toBe(closing === "wait" ? "buffered message" : closing === "ask" ? "advice_response" : "host_response");
  });

  test("closing into finish and terminal recipients still reject ordinary messages", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "worker", context: { source: "fresh" } }); await tick();
    const child = workflow.agents[String(spawned.agent_id)]!;
    await engine.agentTool(child.thread_id!, child.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "done" } });
    const send = () => engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_send", { to: child.id, message: { type: "late", body: "context" } });
    expect(await send()).toMatchObject({ ok: false, error: { code: "recipient_unavailable" } });
    await app.emit(child.thread_id!, child.active_turn_id!);
    expect(await send()).toMatchObject({ ok: false, error: { code: "recipient_unavailable" } });
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_review", { child_id: child.id, decision: "accept" });
    expect(await send()).toMatchObject({ ok: false, error: { code: "recipient_unavailable" } });
    expect(child.mailbox).toHaveLength(0);
  });

  test("a waiting child's status message recovers into a formal accepted submission without cancellation", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "worker", context: { source: "fresh" } }); await tick();
    const child = workflow.agents[String(spawned.agent_id)]!;
    await engine.agentTool(child.thread_id!, child.active_turn_id!, "banana_send", { to: "parent", message: { type: "ready", body: "Work ready" } });
    await engine.agentTool(child.thread_id!, child.active_turn_id!, "banana_wait", { messages: true });
    await app.emit(child.thread_id!, child.active_turn_id!);
    const review = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_review", { child_id: child.id, decision: "accept" });
    expect(review).toMatchObject({ ok: false, error: { details: { child_id: child.id, state: "waiting", wait: { messages: true } } } });
    expect(review.error.details.next_action).toContain("banana_finish");
    const finish = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "done" } });
    expect(finish.error.details.child_recovery[0].child_id).toBe(child.id);
    const invalidWait = await engine.agentTool(child.thread_id!, child.active_turn_id ?? "ended", "banana_wait", { children: [root.id] });
    expect(invalidWait.ok).toBe(false);
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_send", { to: child.id, message: { type: "submit", body: "Submit your ready work with banana_finish" } }); await tick();
    const peerWait = await engine.agentTool(child.thread_id!, child.active_turn_id!, "banana_wait", { children: [root.id] });
    expect(peerWait).toMatchObject({ ok: false, error: { details: { eligible_child_ids: [], message_wait: { messages: true } } } });
    await engine.agentTool(child.thread_id!, child.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "Ready work" } });
    await app.emit(child.thread_id!, child.active_turn_id!);
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_review", { child_id: child.id, decision: "accept", feedback: { summary: "Evidence verified" } });
    expect(child.state).toBe("completed"); expect(child.submissions[0]!.feedback).toEqual({ summary: "Evidence verified" });
    const poll = await engine.hostTool("banana_workflow_poll", { workflow_id: workflow.id, timeout_ms: 0 });
    expect(poll.snapshot.diagnostics.managed_tool_rejections.total).toBe(4);
    expect(poll.snapshot.diagnostics.managed_tool_rejections.by_tool_and_code).toEqual({ "banana_review:invalid_state": 1, "banana_finish:invalid_state": 1, "banana_wait:invalid_state": 1, "banana_wait:invalid_input": 1 });
    expect(workflow.events.filter(event => event.type === "tool_rejected").every(event => !JSON.stringify(event).includes("Ready work"))).toBe(true);
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { messages: true });
    await app.emit(root.thread_id!, root.active_turn_id!); await tick();
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "Reviewed" } });
    await app.emit(root.thread_id!, root.active_turn_id!);
    const finalPoll = await engine.hostTool("banana_workflow_poll", { workflow_id: workflow.id, timeout_ms: 0 });
    expect(finalPoll.snapshot.final.diagnostics).toEqual(poll.snapshot.diagnostics);
  });

  test("no_disposition resumes exactly once from direct parent message", async () => {
    const { engine, app, workflow } = setup(3); const root = workflow.agents[workflow.root_id]!;
    const spawn = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "child", context: { source: "fresh" } }); await tick();
    const child = workflow.agents[String((spawn as JsonObject).agent_id)]!; await app.emit(child.thread_id!, child.active_turn_id!);
    expect(child.wait?.reason).toBe("no_disposition");
    const sent = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_send", { to: child.id, message: { type: "resume", body: "continue" } });
    expect(sent.ok).toBe(true); await tick(); expect(["queued", "active"]).toContain(child.state);
    expect(engine.state.runnable.filter((item) => item.agent_id === child.id).length).toBeLessThanOrEqual(1);
    expect(workflow.status).toBe("running");
    const poll = await engine.hostTool("banana_workflow_poll", { workflow_id: workflow.id, timeout_ms: 0 });
    expect(poll.snapshot.diagnostics.no_disposition_turns).toBe(1);
    const inspect = await engine.hostTool("banana_agent_inspect", { workflow_id: workflow.id, agent_id: child.id });
    expect(inspect.agent.diagnostics.no_disposition_turns).toBe(1);
    const parent = await engine.hostTool("banana_agent_inspect", { workflow_id: workflow.id, agent_id: root.id });
    expect(parent.agent.diagnostics.no_disposition_turns).toBe(0);
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

  test("advice is buffered across an advisor closing into a dependency wait", async () => {
    for (const closing of ["wait", "ask", "request_host"]) for (const order of ["ask_first", "close_first"]) {
      const { engine, app, workflow } = setup(5); const root = workflow.agents[workflow.root_id]!;
      const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "advisor", context: { source: "fresh" } });
      const advisor = workflow.agents[String(spawned.agent_id)]!;
      const peerSpawn = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "peer", context: { source: "fresh" } });
      const peer = workflow.agents[String(peerSpawn.agent_id)]!;
      const ask = () => engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_ask", { to: advisor.id, question: "Which?" });
      const close = () => engine.agentTool(advisor.thread_id!, advisor.active_turn_id!, `banana_${closing}`, closing === "wait" ? { messages: true } : closing === "ask" ? { to: peer.id, question: "Peer guidance?" } : { capability: "computer_use", task: "Inspect the requested page" });
      let request;
      if (order === "ask_first") { request = await ask(); expect((await close()).ok).toBe(true) }
      else { expect((await close()).ok).toBe(true); request = await ask() }
      expect(request.ok).toBe(true);
      const requestId = String(request.request_id);
      await app.emit(root.thread_id!, root.active_turn_id!);
      expect(workflow.advice_requests[requestId]!.status).toBe("pending");
      expect(advisor.mailbox.filter((message) => message.type === "advice_request")).toHaveLength(1);
      await app.emit(advisor.thread_id!, advisor.active_turn_id!); await tick();
      expect(app.starts.filter((threadId) => threadId === advisor.thread_id)).toHaveLength(2);
      expect((await engine.agentTool(advisor.thread_id!, advisor.active_turn_id!, "banana_reply", { request_id: requestId, status: "answered", guidance: "A" })).ok).toBe(true);
      expect(workflow.advice_requests[requestId]!.status).toBe("answered");
    }
  });

  test("advice cannot target an advisor finishing or being cancelled", async () => {
    for (const closing of ["finish", "cancel"]) {
      const { engine, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
      const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "advisor", context: { source: "fresh" } });
      const advisor = workflow.agents[String(spawned.agent_id)]!;
      if (closing === "finish") await engine.agentTool(advisor.thread_id!, advisor.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "done" } });
      else engine.cancelSubtree(workflow, advisor);
      expect(await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_ask", { to: advisor.id, question: "Which?" })).toMatchObject({ ok: false, error: { code: "recipient_unavailable" } });
      expect(Object.keys(workflow.advice_requests)).toHaveLength(0);
    }
  });

  test("advice is correlated and requester retains a single continuation", async () => {
    const { engine, app, workflow } = setup(3); const root = workflow.agents[workflow.root_id]!;
    const spawn = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "advisor", context: { source: "fresh" } }); await tick();
    const advisor = workflow.agents[String((spawn as JsonObject).agent_id)]!;
    const ask = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_ask", { to: advisor.id, question: "Which?" });
    expect(spawn.turn_closing).toBe(false); expect(ask.turn_closing).toBe(true);
    const requestId = String((ask as JsonObject).request_id); await app.emit(root.thread_id!, root.active_turn_id!);
    expect(workflow.advice_requests[requestId]!.status).toBe("pending"); expect(root.state).toBe("waiting");
    const premature = await engine.agentTool(advisor.thread_id!, advisor.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "Ready before receiving the question" } });
    expect(premature.ok).toBe(false);
    expect(premature.error.details.next_action).toContain("banana_wait({messages:true})");
    expect(advisor.turn_closing).toBe(false);
    await engine.agentTool(advisor.thread_id!, advisor.active_turn_id!, "banana_wait", { messages: true });
    await app.emit(advisor.thread_id!, advisor.active_turn_id!); await tick();
    const input = JSON.parse(app.turnRouting.at(-1)!.input).banana_split_delta.assigned_inputs;
    expect(input).toEqual(expect.arrayContaining([expect.objectContaining({ type: "advice_request", payload: { details: { request_id: requestId, question: "Which?", context: {} } } })]));
    const details = { request_id: "domain-request", status: "domain-status", note: "retained metadata" };
    const replied = await engine.agentTool(advisor.thread_id!, advisor.active_turn_id!, "banana_reply", { request_id: requestId, status: "answered", guidance: "A", details });
    expect(replied).toMatchObject({ ok: true, turn_closing: false }); expect(workflow.advice_requests[requestId]!.status).toBe("answered");
    expect(root.mailbox.find((message) => message.type === "advice_response")?.payload.details).toEqual({ request_id: requestId, status: "answered", reply_details: details });
    expect(engine.store.load().workflows[workflow.id]!.advice_requests[requestId]!.details).toEqual(details);
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
    const feedback = { summary: "Accepted with notes", details: { limitation: "partial outcome is expected" } };
    const accept = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_review", { child_id: child.id, decision: "accept", feedback });
    expect(accept.ok).toBe(true); expect(child.result?.outcome).toBe("partial"); expect(child.state).toBe("completed");
    expect(child.submissions.at(-1)).toMatchObject({ decision: "accept", feedback });
    expect(child.submissions[0]).toMatchObject({ decision: "revise", feedback: { summary: "fix" } });
    expect(engine.store.load().workflows[workflow.id]!.agents[child.id]!.submissions.at(-1)?.feedback).toEqual(feedback);
    await tick(); expect(child.state).toBe("completed");
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
    const claim = await engine.hostTool("banana_host_respond", { workflow_id: workflow.id, request_id: requestId, status: "in_progress", summary: "Opening the local page", details: { browser: "Safari" } });
    expect(claim).toMatchObject({ ok: true, request: { status: "in_progress", summary: "Opening the local page", details: { browser: "Safari" } } });
    expect(root.state).toBe("waiting");
    const done = await engine.hostTool("banana_host_respond", { workflow_id: workflow.id, request_id: requestId, status: "completed", summary: "done", details: { evidence: "screen" } });
    await tick();
    expect(done.ok).toBe(true); expect(workflow.host_requests[requestId]!.status).toBe("completed"); expect(["queued", "active"]).toContain(root.state);
    expect(workflow.host_requests[requestId]).toMatchObject({ summary: "done", details: { evidence: "screen" } });
  });

  test("host claims follow durable pending-entry order across workflows", async () => {
    const config = structuredClone(setup().engine.config);
    config.runtime.data_directory = resolve(".banana-test", crypto.randomUUID());
    const fixture = configReadFixture(config);
    const requests = [];
    for (const task of ["armed first", "ready first"]) {
      const started = await fixture.engine.hostTool("banana_workflow_start", { task, workspace, host_capabilities: { computer_use: true } });
      expect(started.ok).toBe(true); await tick();
      const workflow = fixture.engine.state.workflows[String(started.workflow_id)]!;
      const root = workflow.agents[workflow.root_id]!;
      const armed = await fixture.engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_request_host", { capability: "computer_use", task });
      expect(armed.ok).toBe(true);
      requests.push({ workflow, root, request: String(armed.request_id) });
    }
    const first = requests[0]!, second = requests[1]!;
    await fixture.complete(second.root.thread_id!, second.root.active_turn_id!);
    await fixture.complete(first.root.thread_id!, first.root.active_turn_id!);
    const legacy = structuredClone(fixture.engine.state);
    delete (legacy as Partial<typeof legacy>).next_host_request_sequence;
    for (const workflow of Object.values(legacy.workflows)) for (const request of Object.values(workflow.host_requests)) delete request.pending_sequence;
    const legacyStore = new Store(resolve(".banana-test", crypto.randomUUID()));
    legacyStore.save(legacy);
    const upgraded = legacyStore.load();
    expect(upgraded.workflows[first.workflow.id]!.host_requests[first.request]!.pending_sequence).toBe(1);
    expect(upgraded.workflows[second.workflow.id]!.host_requests[second.request]!.pending_sequence).toBe(2);
    expect(upgraded.next_host_request_sequence).toBe(3);
    const recovered = configReadFixture(config).engine;
    await recovered.initialize();
    const poll = await recovered.hostTool("banana_workflow_poll", { workflow_id: second.workflow.id, timeout_ms: 0 });
    expect((poll.snapshot as JsonObject).host_action_required).toMatchObject({ request_id: second.request });
    expect(await recovered.hostTool("banana_host_respond", { workflow_id: first.workflow.id, request_id: first.request, status: "in_progress" })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect((await recovered.hostTool("banana_host_respond", { workflow_id: second.workflow.id, request_id: second.request, status: "in_progress" })).ok).toBe(true);
  });

  test("cancelled unclaimed host actions reject evidence without changing their record", async () => {
    const { engine, app, workflow } = setup();
    const root = workflow.agents[workflow.root_id]!;
    const armed = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_request_host", { capability: "computer_use", task: "Never claimed" });
    await app.emit(root.thread_id!, root.active_turn_id!);
    await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_workflow" });
    const request = workflow.host_requests[String(armed.request_id)]!;
    const before = structuredClone(request);
    expect(await engine.hostTool("banana_host_respond", { workflow_id: workflow.id, request_id: request.id, status: "completed", summary: "Stale evidence" }))
      .toMatchObject({ ok: false, error: { code: "request_terminal", side_effects: "none" } });
    expect(request).toEqual(before);
    expect(root.state).toBe("cancelled");
  });

  for (const cause of ["cancellation", "restart"] as const) test(`an uncertain host action holds the global queue after ${cause}`, async () => {
    const config = structuredClone(setup().engine.config);
    config.runtime.data_directory = resolve(".banana-test", crypto.randomUUID());
    const fixture = configReadFixture(config);
    let engine = fixture.engine;
    const ids: Array<{ workflow: string; root: string; request: string }> = [];
    for (const task of ["first host action", "second host action"]) {
      const started = await engine.hostTool("banana_workflow_start", { task, workspace, host_capabilities: { computer_use: true } });
      expect(started.ok).toBe(true); await tick();
      const workflow = engine.state.workflows[String(started.workflow_id)]!;
      const root = workflow.agents[workflow.root_id]!;
      const armed = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_request_host", { capability: "computer_use", task });
      expect(armed.ok).toBe(true);
      await fixture.complete(root.thread_id!, root.active_turn_id!);
      ids.push({ workflow: workflow.id, root: root.id, request: String(armed.request_id) });
    }
    const first = ids[0]!, second = ids[1]!;
    expect((await engine.hostTool("banana_host_respond", { workflow_id: first.workflow, request_id: first.request, status: "in_progress" })).ok).toBe(true);
    if (cause === "cancellation") {
      await engine.hostTool("banana_workflow_control", { workflow_id: first.workflow, action: "cancel_subtree", agent_id: first.root });
    } else {
      engine = configReadFixture(config).engine;
      await engine.initialize();
    }
    expect(engine.state.workflows[first.workflow]!.host_requests[first.request]!.status).toBe("uncertain");
    const poll = await engine.hostTool("banana_workflow_poll", { workflow_id: second.workflow, timeout_ms: 0 });
    expect((poll.snapshot as JsonObject).host_action_required).toBeUndefined();
    expect(await engine.hostTool("banana_host_respond", { workflow_id: second.workflow, request_id: second.request, status: "in_progress" }))
      .toMatchObject({ ok: false, error: { code: "invalid_state" } });
    const settled = await engine.hostTool("banana_host_respond", { workflow_id: first.workflow, request_id: first.request, status: "completed", summary: "Host supplied final reconciliation evidence" });
    expect(settled).toMatchObject({ ok: true, request: { status: "completed", resolution: cause === "cancellation" ? "cancelled" : "completed" } });
    if (cause === "cancellation") {
      expect(engine.state.workflows[first.workflow]!.agents[first.root]!.state).toBe("cancelled");
      const final = await engine.hostTool("banana_workflow_poll", { workflow_id: first.workflow, timeout_ms: 0 });
      expect((final.final as JsonObject).terminated_requests).toContainEqual(expect.objectContaining({ request_id: first.request, status: "completed", resolution: "cancelled" }));
    }
    const ready = await engine.hostTool("banana_workflow_poll", { workflow_id: second.workflow, timeout_ms: 0 });
    expect((ready.snapshot as JsonObject).host_action_required).toMatchObject({ request_id: second.request });
    expect((await engine.hostTool("banana_host_respond", { workflow_id: second.workflow, request_id: second.request, status: "in_progress" })).ok).toBe(true);
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
    expect(recoveryApp.resumes).toEqual([]);
    await recovered.hostTool("banana_host_respond", { workflow_id: workflow.id, request_id: requestId, status: "completed", summary: "reconciled" }); await tick();
    expect(recoveryApp.starts).toContain("root-thread");
    expect(recoveryApp.resumes).toEqual(["root-thread"]);
  });

  test("restart defers submitted-thread reconnect until revision needs a new turn", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "worker", context: { source: "fresh" } }); await tick();
    const child = workflow.agents[String(spawned.agent_id)]!;
    await engine.agentTool(child.thread_id!, child.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "Draft" } });
    await app.emit(child.thread_id!, child.active_turn_id!);
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { messages: true });
    await app.emit(root.thread_id!, root.active_turn_id!); await tick();
    // The buffered submission may cause one continuation; park after consuming it.
    if (root.state === "active") {
      await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { messages: true });
      await app.emit(root.thread_id!, root.active_turn_id!);
    }
    const recoveryApp = new FakeApp();
    const recovered = new Engine(engine.config, new Store(dirname(engine.store.paths[0])), recoveryApp as never);
    await recovered.initialize();
    expect(recoveryApp.resumes).toEqual([]);
    await recovered.hostTool("banana_workflow_send", { workflow_id: workflow.id, agent_id: root.id, message: { type: "review", body: "Review the retained draft" } }); await tick();
    const rr = recovered.state.workflows[workflow.id]!.agents[root.id]!;
    expect(recoveryApp.resumes).toEqual([root.thread_id!]);
    await recovered.agentTool(rr.thread_id!, rr.active_turn_id!, "banana_review", { child_id: child.id, decision: "revise", feedback: { summary: "Correct the draft" } }); await tick();
    expect(recoveryApp.resumes).toEqual([root.thread_id!, child.thread_id!]);
    expect(recoveryApp.starts).toEqual([root.thread_id!, child.thread_id!]);
  });

  test("restart reissues a persisted cancellation for the original active turn", async () => {
    const { engine, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_workflow" });
    const recoveryApp = new FakeApp();
    recoveryApp.resumeThread = async threadId => ({ thread: { id: threadId, turns: [{ id: "root-turn", status: "inProgress" }] }, model: "model", reasoningEffort: "high" });
    const recovered = new Engine(engine.config, new Store(dirname(engine.store.paths[0])), recoveryApp as never);
    await recovered.initialize();
    expect(recoveryApp.interrupts).toEqual([{ thread: "root-thread", turn: "root-turn" }]);
    expect(recoveryApp.starts).toEqual([]);
    await recoveryApp.emit("root-thread", "root-turn", "interrupted");
    expect(recovered.state.workflows[workflow.id]!.status).toBe("cancelled");
    expect(recovered.state.workflows[workflow.id]!.agents[root.id]!.state).toBe("cancelled");
  });

  test("cancellation wins over a late failure reconnecting an idle thread", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { messages: true });
    await app.emit(root.thread_id!, root.active_turn_id!);
    const recoveryApp = new FakeApp();
    let rejectResume!: (error: Error) => void;
    recoveryApp.resumeThread = () => new Promise((_, reject) => { rejectResume = reject });
    const recovered = new Engine(engine.config, new Store(dirname(engine.store.paths[0])), recoveryApp as never);
    await recovered.initialize();
    await recovered.hostTool("banana_workflow_send", { workflow_id: workflow.id, agent_id: root.id, message: { type: "resume", body: "Continue" } });
    await recovered.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_workflow" });
    rejectResume(new Error("connection closed")); await tick();
    expect(recovered.state.workflows[workflow.id]!.status).toBe("cancelled");
    expect(recovered.state.workflows[workflow.id]!.agents[root.id]!.state).toBe("cancelled");
    expect(recoveryApp.starts).toEqual([]);
  });

  test("recovery registers queued threads before a failed active child wakes scheduling", async () => {
    const { engine, app, workflow } = setup(1); const root = workflow.agents[workflow.root_id]!;
    const first = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "active child", context: { source: "fresh" } });
    const second = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "queued child", context: { source: "fresh" } });
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { children: [first.agent_id, second.agent_id] });
    await app.emit(root.thread_id!, root.active_turn_id!); await tick();
    const active = workflow.agents[String(first.agent_id)]!; const queued = workflow.agents[String(second.agent_id)]!;
    expect(active.state).toBe("active"); expect(queued.state).toBe("queued");
    const recoveryApp = new FakeApp();
    recoveryApp.resumeThread = async threadId => {
      recoveryApp.resumes.push(threadId);
      return { thread: { id: threadId, turns: threadId === active.thread_id ? [{ id: active.active_turn_id, status: "failed" }] : [] }, model: "model", reasoningEffort: "high" };
    };
    const start = recoveryApp.startTurn.bind(recoveryApp);
    recoveryApp.startTurn = async (thread, input, preset) => {
      if (!recoveryApp.resumes.includes(thread)) throw new Error("thread not resumed");
      return start(thread, input, preset);
    };
    const recovered = new Engine(engine.config, new Store(dirname(engine.store.paths[0])), recoveryApp as never);
    await recovered.initialize(); await tick();
    expect(recovered.state.workflows[workflow.id]!.agents[queued.id]!.state).toBe("active");
    expect(recoveryApp.starts).toEqual([queued.thread_id!]);
  });

  test("restart retains accepted results without resuming completed historical threads", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "worker", context: { source: "fresh" } }); await tick();
    const child = workflow.agents[String(spawned.agent_id)]!;
    await engine.agentTool(child.thread_id!, child.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "Historical evidence" } });
    await app.emit(child.thread_id!, child.active_turn_id!);
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_review", { child_id: child.id, decision: "accept", feedback: { summary: "Verified" } });
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { messages: true });
    await app.emit(root.thread_id!, root.active_turn_id!); await tick();
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "Reviewed" } });
    await app.emit(root.thread_id!, root.active_turn_id!);
    const recoveryApp = new FakeApp();
    const recovered = new Engine(engine.config, new Store(dirname(engine.store.paths[0])), recoveryApp as never);
    await recovered.initialize();
    expect(recoveryApp.resumes).toEqual([]);
    expect(recovered.state.workflows[workflow.id]!.status).toBe("completed");
    const inspected = await recovered.hostTool("banana_agent_inspect", { workflow_id: workflow.id, agent_id: child.id, include_payloads: true, transcript_limit: 1 });
    expect(inspected.agent).toMatchObject({ state: "completed", result: { summary: "Historical evidence" }, submissions: [{ decision: "accept", feedback: { summary: "Verified" } }] });
    expect(recoveryApp.resumes).toEqual([]);
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

  test("managed native permissions exclude implicit temporary-directory write grants", async () => {
    const app = new AppServer("codex", 43892);
    const calls: Array<{ method: string; params: JsonObject }> = [];
    app.call = async (method, params) => { calls.push({ method, params }); return method === "config/read" ? { config: {} } : { thread: { id: "managed-thread" } } };
    const preset = { model: "model", reasoning_effort: "high" };
    const restricted = { ...permission, writable_roots: [resolve(".banana-test/allowed")] };
    await app.startThread(workspace, preset, restricted, []);
    await app.forkThread("parent", "parent-turn", workspace, preset, restricted);
    await app.resumeThread("managed-thread", workspace, preset, restricted);
    for (const { params } of calls.filter(call => call.method !== "config/read")) {
      expect(params.runtimeWorkspaceRoots).toEqual(restricted.writable_roots);
      expect(params.config.sandbox_workspace_write).toEqual({ exclude_tmpdir_env_var: true, exclude_slash_tmp: true });
    }
    await app.startTurn("managed-thread", "ready", preset, restricted);
    expect(calls.at(-1)!.params.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: restricted.writable_roots, networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  });

  test("thread isolation uses effective project configuration on start, fork and resume", async () => {
    const app = new AppServer("codex", 43892);
    const calls: Array<{ method: string; params: JsonObject }> = [];
    app.call = async (method, params) => {
      calls.push({ method, params });
      if (method === "config/read") {
        expect(params).toEqual({ includeLayers: false, cwd: workspace });
        return { config: { mcp_servers: { project_allowed: { command: "allowed" }, project_denied: { command: "denied" } }, plugins: { project_plugin: { enabled: true } } } };
      }
      return { thread: { id: "managed-thread" } };
    };
    const preset = { model: "model", reasoning_effort: "high" };
    const scoped = { ...permission, mcp_servers: ["project_allowed"] };
    await app.startThread(workspace, preset, scoped, []);
    await app.forkThread("parent", "parent-turn", workspace, preset, scoped);
    await app.resumeThread("managed-thread", workspace, preset, scoped);
    expect(calls.map(call => call.method)).toEqual(["config/read", "thread/start", "config/read", "thread/fork", "config/read", "thread/resume"]);
    for (const { params } of calls.filter(call => call.method !== "config/read")) {
      expect(params.config.mcp_servers.project_allowed).toEqual({ enabled: true });
      expect(params.config.mcp_servers.project_denied).toEqual({ enabled: false });
      expect(params.config.plugins.project_plugin).toEqual({ enabled: false });
    }
    const count = calls.length;
    await expect(app.startThread(workspace, preset, { ...scoped, mcp_servers: ["missing"] }, [])).rejects.toThrow("configured MCP servers are unavailable: missing");
    expect(calls.slice(count).map(call => call.method)).toEqual(["config/read"]);
  });

  test("thread naming awaits history materialization before returning", async () => {
    const app = new AppServer("codex", 43892);
    let named = false, materialized = false;
    app.call = async (method, params) => {
      if (method === "thread/name/set") { named = true; return {} }
      expect(method).toBe("thread/read");
      expect(named).toBe(true);
      expect(params).toEqual({ threadId: "queued-thread", includeTurns: true });
      await tick(); materialized = true;
      return { thread: { id: "queued-thread", turns: [] } };
    };
    await app.setThreadName("queued-thread", "Queued work");
    expect(materialized).toBe(true);
  });

  test("native cancellation uses the startup form only for the no-active-turn race", async () => {
    const app = new AppServer("codex", 43892);
    const calls: JsonObject[] = [];
    app.call = async (_method, params) => {
      calls.push(params);
      if (params.turnId !== "") throw new Error(JSON.stringify({ code: -32600, message: "no active turn to interrupt" }));
      return {};
    };
    await app.interrupt("thread", "native-turn");
    expect(calls).toEqual([{ threadId: "thread", turnId: "native-turn" }, { threadId: "thread", turnId: "" }]);
    app.call = async () => { throw new Error("connection closed") };
    await expect(app.interrupt("thread", "native-turn")).rejects.toThrow("connection closed");
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
  for (const newServer of [false, true]) test(`recovery ${newServer ? "invalidates" : "retains"} pending approvals when native server ${newServer ? "restarts" : "survives"}`, async () => {
    const config = structuredClone(setup().engine.config);
    config.runtime.data_directory = resolve(".banana-test", crypto.randomUUID());
    const app = new FakeApp(), engine = new Engine(config, new Store(config.runtime.data_directory), app as never);
    const started = await engine.hostTool("banana_workflow_start", { task: "Retained standalone request", workspace }); await tick();
    const workflow = engine.state.workflows[String(started.workflow_id)]!, root = workflow.agents[workflow.root_id]!;
    await app.request!({ id: "answered", method: "item/fileChange/requestApproval", params: { threadId: root.thread_id, turnId: root.active_turn_id } });
    const answered = Object.values(workflow.approvals)[0]!;
    await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: answered.id, decision: "decline" });
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { messages: true });
    await app.emit(root.thread_id!, root.active_turn_id!);
    await app.request!({ id: "standalone", method: "mcpServer/elicitation/request", params: { threadId: root.thread_id, turnId: null, serverName: "configured" } });
    const pending = Object.values(workflow.approvals).at(-1)!;
    const recoveredApp = new FakeApp(); recoveredApp.start = async () => newServer;
    const recovered = new Engine(config, new Store(config.runtime.data_directory), recoveredApp as never); await recovered.initialize();
    const retained = recovered.state.workflows[workflow.id]!;
    expect(retained.approvals[pending.id]!.status).toBe(newServer ? "invalidated" : "pending");
    expect(retained.approvals[answered.id]!.status).toBe("answered");
    expect(retained.agents[root.id]!.state).toBe("waiting");
    expect(recoveredApp.responses).toEqual([]);
    const relay = await recovered.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: pending.id, details: { response: { action: "decline" } } });
    expect(relay.ok).toBe(!newServer);
    expect(recoveredApp.responses).toHaveLength(newServer ? 0 : 1);
  });

  for (const ending of ["cancel", "finish", "accept", "fail"]) test(`standalone MCP elicitation closes when its agent ends through ${ending}`, async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    let target = root;
    if (ending === "accept") {
      const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "worker", context: { source: "fresh" } }); await tick();
      target = workflow.agents[String(spawned.agent_id)]!;
    }
    await engine.agentTool(target.thread_id!, target.active_turn_id!, "banana_wait", { messages: true });
    await app.emit(target.thread_id!, target.active_turn_id!);
    await app.request!({ id: "standalone", method: "mcpServer/elicitation/request", params: { threadId: target.thread_id, turnId: null, serverName: "configured" } });
    const approval = Object.values(workflow.approvals)[0]!;
    if (ending === "cancel") await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_workflow" });
    else if (ending === "fail") {
      app.respond = () => { throw new Error("App Server is not running") };
      engine.failAgent(workflow, target, "reconciliation_required", "Disconnected request owner");
    }
    else {
      await engine.hostTool("banana_workflow_send", { workflow_id: workflow.id, agent_id: target.id, message: { type: "resume", body: "Finish the assignment" } }); await tick();
      expect(approval.status).toBe("pending");
      await engine.agentTool(target.thread_id!, target.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "Done" } });
      await app.emit(target.thread_id!, target.active_turn_id!);
      if (ending === "accept") {
        expect(approval.status).toBe("pending");
        await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_review", { child_id: target.id, decision: "accept" });
      }
    }
    expect(approval.status).toBe("invalidated");
    if (ending === "fail") {
      expect(app.responses).toEqual([]); expect(approval.response).toBeUndefined();
      expect(workflow.events.find(event => event.request_id === approval.id && event.details?.response_error)?.details?.response_error).toContain("App Server is not running");
    } else {
      expect(app.responses).toEqual([{ action: "cancel" }]);
      expect(approval.response).toEqual({ action: "cancel" });
    }
    expect((await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: approval.id, details: { response: { action: "accept", content: {} } } })).ok).toBe(false);
  });

  test("early native resolution waits for the requesting turn to bind", async () => {
    const config = structuredClone(setup().engine.config);
    config.runtime.data_directory = resolve(".banana-test", crypto.randomUUID());
    const app = new FakeApp();
    const engine = new Engine(config, new Store(config.runtime.data_directory), app as never);
    const start = app.startTurn.bind(app);
    let pendingRequest: Promise<void> | undefined, pendingResolution: Promise<void> | undefined;
    app.startTurn = async (...args) => {
      const response = await start(...args);
      pendingRequest = app.request!({ id: 0, method: "item/fileChange/requestApproval", params: { threadId: args[0], turnId: response.turn.id } });
      pendingResolution = app.notification!("serverRequest/resolved", { threadId: args[0], requestId: 0 });
      return response;
    };
    const started = await engine.hostTool("banana_workflow_start", { task: "Resolved request during startup", workspace });
    await tick(); await pendingRequest; await pendingResolution;
    const workflow = engine.state.workflows[String(started.workflow_id)]!;
    const approval = Object.values(workflow.approvals)[0]!;
    expect(approval.status).toBe("invalidated");
    expect(app.responses).toEqual([]);
    expect(workflow.agents[workflow.root_id]!.state).toBe("active");
    expect((await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: approval.id, decision: "accept" })).ok).toBe(false);
    expect(engine.store.load().workflows[workflow.id]!.approvals[approval.id]!.status).toBe("invalidated");
  });

  test("native request resolution removes pending attention without inventing a host decision", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const params = { threadId: root.thread_id, turnId: root.active_turn_id };
    await app.request!({ id: 0, method: "item/fileChange/requestApproval", params });
    const approval = Object.values(workflow.approvals)[0]!;
    await app.notification!("serverRequest/resolved", { threadId: "unrelated-thread", requestId: 0 });
    await app.notification!("serverRequest/resolved", { threadId: root.thread_id, requestId: "0" });
    expect(approval.status).toBe("pending");
    await app.notification!("serverRequest/resolved", { threadId: root.thread_id, requestId: 0 });
    expect(approval.status).toBe("invalidated"); expect(approval.response).toBeUndefined();
    expect(app.responses).toEqual([]);
    expect((await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: approval.id, decision: "accept" })).ok).toBe(false);
    expect(root.state).toBe("active");
    expect(engine.store.load().workflows[workflow.id]!.approvals[approval.id]!.status).toBe("invalidated");
    await app.request!({ id: 1, method: "item/fileChange/requestApproval", params });
    const answered = Object.values(workflow.approvals).at(-1)!;
    await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: answered.id, decision: "decline" });
    await app.notification!("serverRequest/resolved", { threadId: root.thread_id, requestId: 1 });
    expect(answered.status).toBe("answered"); expect(answered.response).toEqual({ decision: "decline" });
  });

  test("turn-scoped approvals expire on completion and reject stale or closing requests", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const threadId = root.thread_id!, oldTurn = root.active_turn_id!;
    const method = "item/commandExecution/requestApproval";
    await app.request!({ id: "original", method, params: { threadId, turnId: oldTurn } });
    const original = Object.values(workflow.approvals)[0]!;
    await engine.agentTool(threadId, oldTurn, "banana_wait", { messages: true });
    await app.request!({ id: "closing", method, params: { threadId, turnId: oldTurn } });
    expect(Object.values(workflow.approvals).find(a => a.request_id === "closing")!.status).toBe("invalidated");
    expect(app.responses.at(-1)).toEqual({ decision: "decline" });
    await app.emit(threadId, oldTurn);
    expect(original.status).toBe("invalidated");
    expect(await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: original.id, decision: "accept" })).toMatchObject({ ok: false, error: { code: "approval_not_pending" } });
    await app.request!({ id: "waiting", method, params: { threadId, turnId: oldTurn } });
    expect(Object.values(workflow.approvals).find(a => a.request_id === "waiting")!.status).toBe("invalidated");
    await engine.hostTool("banana_workflow_send", { workflow_id: workflow.id, agent_id: root.id, message: { type: "resume", body: "Continue" } }); await tick();
    expect(root.active_turn_id).not.toBe(oldTurn);
    await app.request!({ id: "stale", method, params: { threadId, turnId: oldTurn } });
    expect(Object.values(workflow.approvals).find(a => a.request_id === "stale")!.status).toBe("invalidated");
    expect(app.responses.at(-1)).toEqual({ decision: "decline" });
    expect(root.state).toBe("active"); expect(app.interrupts).toEqual([]);
    await app.request!({ id: "current", method, params: { threadId, turnId: root.active_turn_id } });
    const current = Object.values(workflow.approvals).find(a => a.request_id === "current")!;
    expect((await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: current.id, decision: "accept" })).ok).toBe(true);
    expect(engine.store.load().workflows[workflow.id]!.approvals[original.id]!.status).toBe("invalidated");
  });

  test("standalone MCP elicitation retains its nullable native turn correlation", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { messages: true });
    await app.emit(root.thread_id!, root.active_turn_id!);
    for (const turnId of [null, undefined]) {
      await app.request!({ id: `elicitation-${turnId}`, method: "mcpServer/elicitation/request", params: { threadId: root.thread_id, turnId, serverName: "configured" } });
      const approval = Object.values(workflow.approvals).at(-1)!;
      expect(approval.status).toBe("pending"); expect(approval.turn_id).toBeNull();
      expect((await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: approval.id, details: { response: { action: "decline" } } })).ok).toBe(true);
    }
  });

  test("pending file approvals retain the proposed patch from native item-start events", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const changes = [{ path: "/workspace/proposed.md", kind: { type: "add" }, diff: "Proposed content\n" }];
    await app.notification!("item/started", { threadId: root.thread_id, turnId: root.active_turn_id, item: { type: "fileChange", id: "patch-item", changes, status: "inProgress" } });
    await app.request!({ id: "patch-approval", method: "item/fileChange/requestApproval", params: { threadId: root.thread_id, turnId: root.active_turn_id, itemId: "patch-item" } });
    const poll = await engine.hostTool("banana_workflow_poll", { workflow_id: workflow.id, timeout_ms: 0 });
    expect(poll.snapshot.attention[0].request.file_changes).toEqual(changes);
    await app.notification!("item/completed", { threadId: root.thread_id, turnId: root.active_turn_id, item: { type: "fileChange", id: "patch-item", changes, status: "declined" } });
    expect(Object.values(engine.store.load().workflows[workflow.id]!.approvals)[0]!.details?.file_changes).toEqual(changes);
  });

  test("decline remains available and lets command/file requesters finish on the same turn", async () => {
    for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
      const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
      await app.request!({ id: "approval", method, params: { threadId: root.thread_id, turnId: root.active_turn_id, availableDecisions: ["accept", "cancel"] } });
      const approval = Object.values(workflow.approvals)[0]!;
      const poll = await engine.hostTool("banana_workflow_poll", { workflow_id: workflow.id, timeout_ms: 0 });
      const attention = (poll.snapshot as JsonObject).attention as JsonObject[];
      expect((attention[0]!.request as JsonObject).availableDecisions).toContain("decline");
      const result = await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: approval.id, decision: "decline", details: { reason: "Host already verified the result" } });
      expect(result).toMatchObject({ ok: true, response: { decision: "decline" } });
      expect(app.responses.at(-1)).toEqual({ decision: "decline" });
      expect(app.interrupts).toHaveLength(0);
      expect(root.state).toBe("active");
      const inspect = await engine.hostTool("banana_agent_inspect", { workflow_id: workflow.id, agent_id: root.id, include_payloads: true });
      expect((inspect.agent as JsonObject).approvals).toMatchObject([{ status: "answered", response: { decision: "decline" }, response_details: { reason: "Host already verified the result" } }]);
      expect(engine.store.load().workflows[workflow.id]!.approvals[approval.id]!.response).toEqual({ decision: "decline" });
      const duplicate = await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: approval.id, decision: "cancel" });
      expect(duplicate).toMatchObject({ ok: false, error: { code: "approval_not_pending" } });
      expect((await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "Continued after denial" } })).ok).toBe(true);
      await app.emit(root.thread_id!, root.active_turn_id!);
      expect(workflow.status).toBe("completed");
      expect(root.result?.summary).toBe("Continued after denial");
    }
  });

  test("cancellation invalidates pending and late approvals with native rejection responses", async () => {
    const cases: Array<[string, JsonObject]> = [
      ["item/commandExecution/requestApproval", { decision: "cancel" }],
      ["item/fileChange/requestApproval", { decision: "cancel" }],
      ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
      ["item/tool/requestUserInput", { answers: {} }],
      ["mcpServer/elicitation/request", { action: "cancel" }]
    ];
    for (const [method, response] of cases) {
      const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
      const threadId = root.thread_id!; const turnId = root.active_turn_id!;
      await app.request!({ id: "before", method, params: { threadId, turnId } });
      const before = Object.values(workflow.approvals)[0]!;
      await engine.hostTool("banana_workflow_control", { workflow_id: workflow.id, action: "cancel_workflow" });
      expect(before.status).toBe("invalidated");
      for (const phase of ["during", "after"]) {
        if (phase === "after") await app.emit(threadId, turnId, "interrupted");
        await app.request!({ id: phase, method, params: { threadId, turnId } });
        const approval = Object.values(workflow.approvals).find((item) => item.request_id === phase)!;
        expect(approval.status).toBe("invalidated");
        expect(approval.response).toEqual(response);
        expect(app.responses.at(-1)).toEqual(response);
        expect(await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: approval.id, decision: "accept" })).toMatchObject({ ok: false, error: { code: "approval_not_pending" } });
      }
      expect(workflow.status).toBe("cancelled");
      expect(engine.store.load().workflows[workflow.id]!.approvals[before.id]!.status).toBe("invalidated");
    }
  });

  test("approval cancel settles the root and active descendants as cancelled, preserving accepted work", async () => {
    for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
      const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
      const spawn = async () => {
        const result = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "child", context: { source: "fresh" } });
        return workflow.agents[String(result.agent_id)]!;
      };
      const completed = await spawn();
      await engine.agentTool(completed.thread_id!, completed.active_turn_id!, "banana_finish", { result: { outcome: "success", summary: "Accepted work" } });
      await app.emit(completed.thread_id!, completed.active_turn_id!);
      expect((await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_review", { child_id: completed.id, decision: "accept" })).ok).toBe(true);
      const active = await spawn();
      await app.request!({ id: "approval", method, params: { threadId: root.thread_id, turnId: root.active_turn_id } });
      const approval = Object.values(workflow.approvals)[0]!;
      const response = await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: approval.id, decision: "cancel" });
      expect(response).toMatchObject({ ok: true, cancellation: { settling: true } });
      expect(workflow.status).toBe("cancelling");
      expect(app.interrupts).toEqual([{ thread: active.thread_id!, turn: active.active_turn_id! }]);
      await app.emit(root.thread_id!, root.active_turn_id!, "interrupted");
      expect(root.state).toBe("cancelled");
      expect(workflow.status).toBe("cancelling");
      await app.emit(active.thread_id!, active.active_turn_id!, "interrupted");
      expect(workflow.status).toBe("cancelled");
      expect(engine.activeCount()).toBe(0);
      expect(active.state).toBe("cancelled");
      expect(completed.result?.summary).toBe("Accepted work");
      expect(approval.status).toBe("answered");
      expect(workflow.events.some((event) => event.type === "agent_failed")).toBe(false);
    }
  });

  test("cancelling a child's approval lets its parent continue", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    const spawned = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "child", context: { source: "fresh" } });
    const child = workflow.agents[String(spawned.agent_id)]!;
    await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_wait", { children: [child.id] });
    await app.emit(root.thread_id!, root.active_turn_id!);
    await app.request!({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: child.thread_id, turnId: child.active_turn_id } });
    const approval = Object.values(workflow.approvals)[0]!;
    await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: approval.id, decision: "cancel" });
    await app.emit(child.thread_id!, child.active_turn_id!, "interrupted");
    await tick();
    expect(child.state).toBe("cancelled");
    expect(root.state).toBe("active");
    expect(workflow.status).toBe("running");
    expect(root.mailbox.some((message) => message.type === "child_cancelled")).toBe(true);
  });

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
      for (const invalid of [{}, [], { ...item.response, scope: "forever", answers: [], action: "approve", permissions: [] }]) {
        const rejected = await engine.hostTool("banana_approval_respond", {
          workflow_id: workflow.id, approval_id: approvalId, details: { response: invalid }
        });
        expect(rejected.ok).toBe(false);
        expect(workflow.approvals[approvalId]!.status).toBe("pending");
        expect(app.responses).toEqual([]);
      }
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
    expect(attention.turn_id).toBe(root.active_turn_id);
    expect((attention.request as JsonObject).itemId).toBe("item-file");
    expect((attention.request as JsonObject).response_contract).toContain("paths and diff");
    expect(poll.snapshot.next_action).toContain("Resolve pending approvals");
    const rejected = await engine.hostTool("banana_approval_respond", {
      workflow_id: workflow.id, approval_id: attention.approval_id, decision: "approve"
    });
    expect(rejected.ok).toBe(false);
    expect(app.responses).toEqual([]);
    await engine.hostTool("banana_approval_respond", {
      workflow_id: workflow.id, approval_id: attention.approval_id, decision: "accept"
    });
    expect(app.responses.at(-1)).toEqual({ decision: "accept" });
  });

  test("permission approval responses follow native defaults, nullability, and scan-depth bounds", async () => {
    const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
    await app.request!({ id: "rpc", method: "item/permissions/requestApproval", params: { threadId: root.thread_id, turnId: root.active_turn_id } });
    const approval = Object.values(workflow.approvals)[0]!;
    const invalid = await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: approval.id, decision: "responded", details: { response: { permissions: { fileSystem: { globScanMaxDepth: 0 } }, scope: "turn" } } });
    expect(invalid.ok).toBe(false);
    expect(approval.status).toBe("pending"); expect(app.responses).toEqual([]);
    const response = { permissions: { network: {}, fileSystem: { read: null, write: null, entries: null, globScanMaxDepth: null } }, strictAutoReview: null };
    const relayed = await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: approval.id, decision: "responded", details: { response } });
    expect(relayed.ok).toBe(true); expect(app.responses).toEqual([response]);
  });

  test("command approvals reject malformed decisions and preserve policy amendments", async () => {
    for (const decision of [
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } },
      { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } }
    ]) {
      const { engine, app, workflow } = setup(); const root = workflow.agents[workflow.root_id]!;
      await app.request!({ id: "rpc", method: "item/commandExecution/requestApproval", params: { threadId: root.thread_id, turnId: root.active_turn_id } });
      const approval = Object.values(workflow.approvals)[0]!;
      for (const invalid of ["approve", {}, { acceptWithExecpolicyAmendment: { execpolicy_amendment: "git" } }]) {
        expect((await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: approval.id, decision: invalid })).ok).toBe(false);
        expect(approval.status).toBe("pending");
        expect(app.responses).toEqual([]);
      }
      expect((await engine.hostTool("banana_approval_respond", { workflow_id: workflow.id, approval_id: approval.id, decision })).ok).toBe(true);
      expect(app.responses).toEqual([{ decision }]);
    }
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
    const root = workflow.agents[workflow.root_id]!;
    const rejected = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_finish", { outcome: "success", summary: "Wrong shape" });
    expect(rejected).toMatchObject({ ok: false, error: { code: "persistence_failed" } });
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

describe("host-controlled preset tiers", () => {
  const catalog = (): PresetTiers => Object.fromEntries(["tier-1", "tier-2", "tier-3"].map(tier => [tier,
    Object.fromEntries(["default", "deep", "worker", "fast"].map(name => [name, { model: `${tier}-${name}`, reasoning_effort: "high" }]))
  ]));

  test("requires three tiers with four shared preset slots", () => {
    const tiers = catalog();
    expect(readPresetTiers(tiers, "default")).toEqual(tiers);
    delete tiers["tier-3"];
    expect(() => readPresetTiers(tiers, "default")).toThrow("exactly three");
    const short = catalog(); delete short["tier-2"]!.fast;
    expect(() => readPresetTiers(short, "default")).toThrow("exactly four");
    const renamed = catalog(); renamed["tier-2"]!.other = renamed["tier-2"]!.fast!; delete renamed["tier-2"]!.fast;
    expect(() => readPresetTiers(renamed, "default")).toThrow("same four");
  });

  test("start snapshots all tiers and exposes only the active tier to agents", async () => {
    const { engine, app } = setup();
    engine.config.workflow_defaults.preset_recommendations = { default: { recommended_for: "Judgment" }, unavailable: { recommended_for: "Work" } };
    const tiers = catalog();
    const result = await engine.hostTool("banana_workflow_start", { task: "tiered", workspace, preset_tiers: tiers, tier: "tier-2" });
    expect(result.ok).toBe(true); await tick();
    const workflow = engine.state.workflows[String(result.workflow_id)]!;
    const root = workflow.agents[workflow.root_id]!;
    expect(root.resolved_preset.model).toBe("tier-2-default");
    expect(JSON.parse(app.turnRouting.at(-1)!.input).banana_split.available_presets).toEqual(tiers["tier-2"]);
    expect(JSON.parse(app.turnRouting.at(-1)!.input).banana_split.preset_recommendations).toEqual({ default: { recommended_for: "Judgment" } });
    tiers["tier-2"]!.default!.model = "mutated";
    expect(workflow.preset_tiers!["tier-2"]!.default!.model).toBe("tier-2-default");
    const poll = await engine.hostTool("banana_workflow_poll", { workflow_id: workflow.id, timeout_ms: 0 });
    expect(poll.snapshot).toMatchObject({ active_tier: "tier-2", preset_catalog_source: "workflow_override" });
  });

  test("only the host changes tiers, applying on the next turn and to new children", async () => {
    const { engine, app, workflow } = setup();
    const root = workflow.agents[workflow.root_id]!;
    const first = await engine.hostTool("banana_workflow_set_tier", { workflow_id: workflow.id, tier: "tier-1", preset_tiers: catalog() });
    expect(first.ok).toBe(true);
    expect(root.resolved_preset.model).toBe("model"); // The active turn keeps its original routing.
    const denied = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_workflow_set_tier", { workflow_id: workflow.id, tier: "tier-3" });
    expect(denied.ok).toBe(false);
    expect(workflow.active_tier).toBe("tier-1");
    const wrongTier = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "other tier", context: { source: "fresh" }, preset: "tier-3/worker" });
    expect(wrongTier).toMatchObject({ ok: false, error: { code: "preset_unavailable" } });
    await app.emit(root.thread_id!, root.active_turn_id!);
    await engine.hostTool("banana_workflow_send", { workflow_id: workflow.id, agent_id: root.id, message: { type: "resume", body: "Continue" } });
    await tick();
    expect(root.resolved_preset.model).toBe("tier-1-default");
    const previousTurn = root.active_turn_id;
    await engine.hostTool("banana_workflow_set_tier", { workflow_id: workflow.id, tier: "tier-2" });
    expect(root.active_turn_id).toBe(previousTurn);
    expect(root.resolved_preset.model).toBe("tier-1-default");
    const spawn = await engine.agentTool(root.thread_id!, root.active_turn_id!, "banana_spawn", { task: "new child", context: { source: "fresh" }, preset: "worker" });
    expect(spawn.resolved_preset).toMatchObject({ model: "tier-2-worker" });
    await app.emit(root.thread_id!, root.active_turn_id!);
    await engine.hostTool("banana_workflow_send", { workflow_id: workflow.id, agent_id: root.id, message: { type: "resume", body: "Continue again" } });
    await tick();
    expect(root.resolved_preset.model).toBe("tier-2-default");
    expect(root.routing_history!.map(item => item.tier)).toEqual(["tier-1", "tier-2"]);
    expect(JSON.parse(app.turnRouting.at(-1)!.input).banana_split_delta.active_tier).toBe("tier-2");
    const inspected = await engine.hostTool("banana_agent_inspect", { workflow_id: workflow.id, agent_id: root.id });
    expect((inspected.agent as JsonObject).routing_history).toEqual(root.routing_history);
  });

  test("invalid host changes are atomic and valid tier definitions survive reloading", async () => {
    const { engine, app, workflow } = setup();
    await engine.hostTool("banana_workflow_set_tier", { workflow_id: workflow.id, tier: "tier-1", preset_tiers: catalog() });
    const renamed = catalog();
    for (const presets of Object.values(renamed)) { presets.other = presets.fast!; delete presets.fast }
    expect(await engine.hostTool("banana_workflow_set_tier", { workflow_id: workflow.id, tier: "tier-2", preset_tiers: renamed })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    app.validatePresets = async () => { throw new Error("unsupported model") };
    const rejected = await engine.hostTool("banana_workflow_set_tier", { workflow_id: workflow.id, tier: "tier-2" });
    expect(rejected).toMatchObject({ ok: false, error: { code: "preset_unavailable" } });
    expect(workflow.active_tier).toBe("tier-1");
    app.validatePresets = async () => {};
    const changed = catalog(); changed["tier-3"]!.default!.model = "host-defined-model";
    const accepted = await engine.hostTool("banana_workflow_set_tier", { workflow_id: workflow.id, tier: "tier-3", preset_tiers: changed });
    expect(accepted.ok).toBe(true);
    const loaded = new Engine(engine.config, engine.store, new FakeApp() as never).state.workflows[workflow.id]!;
    expect(loaded.active_tier).toBe("tier-3");
    expect(loaded.preset_snapshot.default!.model).toBe("host-defined-model");
    expect(loaded.preset_tiers).toEqual(changed);
    workflow.status = "completed";
    expect(await engine.hostTool("banana_workflow_set_tier", { workflow_id: workflow.id, tier: "tier-1" })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });
});
