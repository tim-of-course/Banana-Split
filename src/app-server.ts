import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import type { JsonObject, PermissionPolicy, Preset } from "./model.js";

type RequestHandler = (message: JsonObject) => Promise<void>;
type NotificationHandler = (method: string, params: JsonObject) => Promise<void>;

const BANANA_HOST_MCP_SERVER_NAMES = ["banana-split", "banana-split-v1"] as const;
const BANANA_HOST_PLUGIN_NAMES = [
  "banana-split",
  "banana-split@personal",
  "banana-split@banana-split",
  "banana-split@banana-split-v1",
  "banana-split-v1",
  "banana-split-v1@banana-split-v1"
] as const;
export function ownedAppServerArgs(port: number): string[] {
  return [
    "-c", 'mcp_servers.banana-split.command="disabled"',
    "-c", "mcp_servers.banana-split.enabled=false",
    "-c", 'mcp_servers.banana-split-v1.command="disabled"',
    "-c", "mcp_servers.banana-split-v1.enabled=false",
    "app-server",
    "--listen",
    `ws://127.0.0.1:${port}`
  ];
}

export class AppServer {
  private process?: ChildProcess;
  private socket?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve(value: JsonObject): void; reject(error: Error): void }>();
  private requestHandler?: RequestHandler;
  private notificationHandler?: NotificationHandler;
  private effectiveConfig: JsonObject = {};
  private stopping = false;

  constructor(private readonly command: string, private readonly port: number) {}

  onRequest(handler: RequestHandler): void { this.requestHandler = handler }
  onNotification(handler: NotificationHandler): void { this.notificationHandler = handler }

  // True means this call launched a native process with a new RPC request namespace.
  async start(): Promise<boolean> {
    this.stopping = false;
    if (this.socket?.readyState === WebSocket.OPEN) return false;
    let launched = false;
    try { await this.connect(500) }
    catch {
      // Reinstall removes versioned plugin directories; the server must outlive that cwd.
      this.process = spawn(this.command, ownedAppServerArgs(this.port), { cwd: homedir(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
      launched = true;
      let startupError: Error | undefined;
      this.process.once("error", error => { startupError = error });
      this.process.stderr?.on("data", (chunk) => process.stderr.write(`[codex] ${String(chunk)}`));
      this.process.on("exit", (code, signal) => {
        const error = new Error(`Codex App Server exited with ${signal ?? `code ${code ?? "unknown"}`}`);
        startupError = error;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear(); this.process = undefined;
      });
      const deadline = Date.now() + 10000;
      while (!this.socket && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (startupError) throw new Error(`app_server_unsupported: could not launch ${this.command}: ${startupError.message}. Verify codex_command and update Codex to a current version.`);
        try { await this.connect(500) } catch {}
      }
      if (!this.socket) throw new Error(`app_server_unsupported: could not connect to App Server on ws://127.0.0.1:${this.port}`);
    }
    const initialized = await this.call("initialize", {
      clientInfo: { name: "banana_split", title: "Banana Split", version: "0.1.1" },
      capabilities: { experimentalApi: true }
    });
    if (!["windows", "macos"].includes(String(initialized.platformOs))) throw new Error(`Banana Split requires Windows or macOS App Server, observed ${String(initialized.platformOs)}`);
    this.notify("initialized", {});
    const config = await this.call("config/read", { includeLayers: false });
    this.effectiveConfig = (config.config && typeof config.config === "object" ? config.config : {}) as JsonObject;
    await this.call("model/list", { limit: 1, includeHidden: true });
    return launched;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const request of this.pending.values()) request.reject(new Error("App Server stopped"));
    this.pending.clear();
    const socket = this.socket;
    const ownedProcess = this.process;
    this.socket = undefined;
    this.process = undefined;
    socket?.close();
    if (ownedProcess) await terminateProcessTree(ownedProcess);
  }

  async call(method: string, params: JsonObject): Promise<JsonObject> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("App Server is not running");
    const rpcId = this.nextId++;
    const promise = new Promise<JsonObject>((resolve, reject) => this.pending.set(rpcId, { resolve, reject }));
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }));
    return promise;
  }

  respond(id: string | number, result: JsonObject): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("App Server is not running");
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  notify(method: string, params: JsonObject): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("App Server is not running");
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async models(): Promise<JsonObject[]> {
    const all: JsonObject[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.call("model/list", { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
      all.push(...((response.data ?? []) as JsonObject[]));
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : undefined;
    } while (cursor);
    return all;
  }

  async validatePresets(presets: Record<string, Preset>): Promise<void> {
    const models = await this.models();
    for (const [name, preset] of Object.entries(presets)) {
      const model = models.find((entry) => entry.model === preset.model || entry.id === preset.model);
      if (!model) throw new Error(`preset_unavailable: ${name} model ${preset.model} is not advertised by App Server`);
      const efforts = ((model.supportedReasoningEfforts ?? []) as JsonObject[]).map((entry) => entry.reasoningEffort);
      if (!efforts.includes(preset.reasoning_effort)) throw new Error(`preset_unavailable: ${name} effort ${preset.reasoning_effort} is unsupported`);
      if (preset.service_tier) {
        const tiers = [
          ...((model.serviceTiers ?? []) as JsonObject[]).map((entry) => entry.id),
          ...((model.additionalSpeedTiers ?? []) as string[])
        ];
        if (!tiers.includes(preset.service_tier)) throw new Error(`preset_unavailable: ${name} tier ${preset.service_tier} is unsupported`);
      }
    }
  }

  validateMcpServers(allowedMcp: string[], config = this.effectiveConfig): void {
    const configured = (config.mcp_servers ?? {}) as JsonObject;
    const missing = allowedMcp.filter((name) => configured[name] === undefined);
    if (missing.length) throw new Error(`app_server_unsupported: configured MCP servers are unavailable: ${missing.join(", ")}`);
  }

  async probe(dynamicTools: JsonObject[]): Promise<void> {
    const response = await this.call("thread/start", {
      ephemeral: true,
      dynamicTools,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      config: this.isolationConfig([]),
      allowProviderModelFallback: false
    });
    if (!((response.thread as JsonObject | undefined)?.id)) throw new Error("app_server_unsupported: dynamic tool probe did not return a thread id");
  }

  isolationConfig(allowedMcp: string[], config = this.effectiveConfig): JsonObject {
    const configured = (config.mcp_servers ?? {}) as JsonObject;
    const mcp: JsonObject = {};
    for (const name of Object.keys(configured)) {
      if (BANANA_HOST_MCP_SERVER_NAMES.includes(name as typeof BANANA_HOST_MCP_SERVER_NAMES[number])) continue;
      mcp[name] = { enabled: allowedMcp.includes(name) };
    }
    for (const name of BANANA_HOST_MCP_SERVER_NAMES) mcp[name] = { command: "disabled", enabled: false };
    const plugins = (config.plugins ?? {}) as JsonObject;
    const isolatedPlugins: JsonObject = {};
    for (const name of Object.keys(plugins)) isolatedPlugins[name] = { enabled: false };
    for (const name of BANANA_HOST_PLUGIN_NAMES) isolatedPlugins[name] = { enabled: false };
    return {
      features: { multi_agent: false, goals: false, computer_use: false, browser_use: false, in_app_browser: false, apps: false },
      agents: { enabled: false },
      apps: { _default: { enabled: false } },
      sandbox_workspace_write: { exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
      mcp_servers: mcp,
      plugins: isolatedPlugins
    };
  }

  async workspaceMcpServers(workspace: string): Promise<string[]> {
    const response = await this.call("config/read", { includeLayers: true, cwd: workspace });
    if (!response.config || typeof response.config !== "object" || !Array.isArray(response.layers)) {
      throw new Error("app_server_unsupported: config/read did not return workspace configuration layers");
    }
    const configured = ((response.config as JsonObject).mcp_servers ?? {}) as JsonObject;
    const projectNames = new Set<string>();
    for (const layer of response.layers as JsonObject[]) {
      if ((layer.name as JsonObject)?.type !== "project" || layer.disabledReason) continue;
      for (const name of Object.keys(((layer.config as JsonObject)?.mcp_servers ?? {}) as JsonObject)) projectNames.add(name);
    }
    return [...projectNames].filter(name => {
      const value = configured[name];
      return !BANANA_HOST_MCP_SERVER_NAMES.includes(name as typeof BANANA_HOST_MCP_SERVER_NAMES[number])
        && value !== null && typeof value === "object" && (value as JsonObject).enabled !== false;
    });
  }

  async prepareThread(workspace: string, allowedMcp: string[]): Promise<JsonObject> {
    const response = await this.call("config/read", { includeLayers: false, cwd: workspace });
    if (!response.config || typeof response.config !== "object") throw new Error("app_server_unsupported: config/read did not return workspace configuration");
    const config = response.config as JsonObject;
    this.validateMcpServers(allowedMcp, config);
    return this.isolationConfig(allowedMcp, config);
  }

  async startThread(workspace: string, preset: Preset, permissions: PermissionPolicy, dynamicTools: JsonObject[], preparedConfig?: JsonObject): Promise<JsonObject> {
    const config = preparedConfig ?? await this.prepareThread(workspace, permissions.mcp_servers);
    return this.call("thread/start", {
      cwd: workspace,
      model: preset.model,
      serviceTier: preset.service_tier ?? null,
      approvalPolicy: mapApproval(permissions.approval_policy),
      approvalsReviewer: "user",
      sandbox: permissions.sandbox === "workspaceWrite" ? "workspace-write" : "read-only",
      runtimeWorkspaceRoots: permissions.writable_roots,
      dynamicTools,
      ephemeral: false,
      allowProviderModelFallback: false,
      config,
      serviceName: "banana_split"
    });
  }

  async setThreadName(threadId: string, name: string): Promise<JsonObject> {
    const response = await this.call("thread/name/set", { threadId, name });
    // Read after naming: Codex then persists an empty queued thread's history.
    // Reading before naming can hit an uninitialized history store.
    await this.readThread(threadId);
    return response;
  }

  async forkThread(parentThreadId: string, lastTurnId: string, workspace: string, preset: Preset, permissions: PermissionPolicy, preparedConfig?: JsonObject): Promise<JsonObject> {
    const config = preparedConfig ?? await this.prepareThread(workspace, permissions.mcp_servers);
    return this.call("thread/fork", {
      threadId: parentThreadId,
      lastTurnId,
      deferGoalContinuation: true,
      cwd: workspace,
      model: preset.model,
      serviceTier: preset.service_tier ?? null,
      approvalPolicy: mapApproval(permissions.approval_policy),
      approvalsReviewer: "user",
      sandbox: permissions.sandbox === "workspaceWrite" ? "workspace-write" : "read-only",
      runtimeWorkspaceRoots: permissions.writable_roots,
      config,
      ephemeral: false
    });
  }

  async resumeThread(threadId: string, workspace: string, preset: Preset, permissions: PermissionPolicy, preparedConfig?: JsonObject): Promise<JsonObject> {
    const config = preparedConfig ?? await this.prepareThread(workspace, permissions.mcp_servers);
    return this.call("thread/resume", {
      threadId,
      cwd: workspace,
      model: preset.model,
      serviceTier: preset.service_tier ?? null,
      approvalPolicy: mapApproval(permissions.approval_policy),
      approvalsReviewer: "user",
      sandbox: permissions.sandbox === "workspaceWrite" ? "workspace-write" : "read-only",
      runtimeWorkspaceRoots: permissions.writable_roots,
      config
    });
  }
  readThread(threadId: string): Promise<JsonObject> { return this.call("thread/read", { threadId, includeTurns: true }) }
  async listItems(threadId: string, cursor: string | undefined, limit: number): Promise<JsonObject> {
    const response = await this.readThread(threadId);
    const turns = ((((response.thread ?? {}) as JsonObject).turns ?? []) as JsonObject[]);
    const items = turns.flatMap((turn) => ((turn.items ?? []) as JsonObject[]).map((item) => ({ turnId: turn.id, item })));
    const start = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isInteger(start) || start < 0 || start > items.length) throw new Error("transcript cursor is invalid");
    const data = items.slice(start, start + limit);
    const next = start + data.length;
    return { data, nextCursor: next < items.length ? String(next) : null };
  }
  startTurn(threadId: string, input: string, preset: Preset, permissions: PermissionPolicy): Promise<JsonObject> {
    return this.call("turn/start", {
      threadId,
      input: [{ type: "text", text: input }],
      model: preset.model,
      effort: preset.reasoning_effort,
      serviceTier: preset.service_tier ?? null,
      approvalPolicy: mapApproval(permissions.approval_policy),
      approvalsReviewer: "user",
      runtimeWorkspaceRoots: permissions.writable_roots,
      sandboxPolicy: permissions.sandbox === "workspaceWrite"
        ? { type: "workspaceWrite", writableRoots: permissions.writable_roots, networkAccess: permissions.network_access, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
        : { type: "readOnly", networkAccess: permissions.network_access }
    });
  }
  async interrupt(threadId: string, turnId: string): Promise<JsonObject> {
    try { return await this.call("turn/interrupt", { threadId, turnId }) }
    catch (error) {
      let nativeError: JsonObject | undefined;
      try { nativeError = JSON.parse(error instanceof Error ? error.message : "") as JsonObject } catch {}
      if (nativeError?.code !== -32600 || nativeError.message !== "no active turn to interrupt") throw error;
      // turn/start can return before its turn becomes active. Codex's empty-ID
      // form interrupts startup too. Cancellation never resumes this agent again.
      return this.call("turn/interrupt", { threadId, turnId: "" });
    }
  }

  private async receive(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: JsonObject;
    try { message = JSON.parse(line) as JsonObject } catch { return }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && message.method === undefined) {
      const request = this.pending.get(Number(message.id));
      if (!request) return;
      this.pending.delete(Number(message.id));
      if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve((message.result ?? {}) as JsonObject);
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      if (this.requestHandler) await this.requestHandler(message); else this.respond(message.id as string | number, {});
      return;
    }
    if (typeof message.method === "string" && this.notificationHandler) await this.notificationHandler(message.method, (message.params ?? {}) as JsonObject);
  }

  private connect(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
      const timer = setTimeout(() => { socket.close(); reject(new Error("App Server connection timed out")) }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer); this.socket = socket;
        socket.addEventListener("message", (event) => void this.receive(String(event.data)));
        socket.addEventListener("close", () => {
          if (this.socket !== socket) return;
          this.socket = undefined;
          if (!this.stopping) {
            const error = new Error("App Server connection closed; runtime ownership is terminating for safe recovery");
            for (const request of this.pending.values()) request.reject(error);
            this.pending.clear();
            process.stderr.write(`${error.message}\n`);
            setTimeout(() => process.exit(1), 0);
          }
        });
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("App Server connection failed")) }, { once: true });
    });
  }
}

function mapApproval(value: PermissionPolicy["approval_policy"]): string {
  return value === "onRequest" ? "on-request" : value;
}

export function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return Promise.resolve();
  if (process.platform !== "win32") {
    // The owned App Server starts a separate process group, including its tools.
    try { process.kill(-pid, "SIGKILL") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return Promise.reject(error) }
    return new Promise((resolve) => child.once("exit", () => resolve()));
  }
  return new Promise((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.once("error", reject);
    killer.once("exit", (code) => {
      if (code === 0 || child.exitCode !== null) resolve();
      else reject(new Error(`Failed to terminate owned Codex App Server process tree ${pid} (taskkill exit ${code ?? "unknown"})`));
    });
  });
}
