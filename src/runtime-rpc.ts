import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { normalize, resolve } from "node:path";
import type { Engine } from "./engine.js";
import type { JsonObject } from "./model.js";

export class RuntimeOwner {
  readonly ownerKey: string;
  private readonly lockServer = createServer((socket) => socket.destroy());
  private readonly sockets = new Set<import("node:net").Socket>();
  private engine?: Engine;
  private readonly server = createServer((socket) => {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.setEncoding("utf8"); let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n"); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line.trim()) void respond(this.engine, this.ownerKey, socket, line);
      }
    });
  });

  constructor(private readonly port: number, dataDirectory: string) {
    this.ownerKey = runtimeOwnerKey(dataDirectory);
  }

  async listen(): Promise<void> {
    try {
      await listen(this.lockServer, runtimeLockAddress(this.ownerKey), "Another Banana Split runtime already owns this durable data directory");
      await listen(this.server, this.port, "A Banana Split runtime already owns 127.0.0.1:" + this.port, "127.0.0.1");
    } catch (error) {
      await closeServer(this.server);
      await closeServer(this.lockServer);
      throw error;
    }
  }

  attach(engine: Engine): void { this.engine = engine }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await closeServer(this.server);
    await closeServer(this.lockServer);
  }

  wait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const close = () => void this.close().then(resolve, reject);
      process.once("SIGINT", close); process.once("SIGTERM", close);
    });
  }
}

export function runtimeOwnerKey(dataDirectory: string): string {
  const canonical = normalize(resolve(dataDirectory)).toLowerCase();
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function runtimeLockAddress(ownerKey: string): string {
  return "\\\\.\\pipe\\banana-split-" + ownerKey;
}

function listen(server: import("node:net").Server, target: number | string, inUseMessage: string, host?: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException) => reject(new Error(error.code === "EADDRINUSE" || typeof target === "string" ? inUseMessage : String(error)));
    server.once("error", onError);
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    if (host === undefined) server.listen(target, onListening);
    else server.listen(target as number, host, onListening);
  });
}

function closeServer(server: import("node:net").Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

async function respond(engine: Engine | undefined, ownerKey: string, socket: import("node:net").Socket, line: string): Promise<void> {
  let id: unknown;
  try {
    const request = JSON.parse(line) as JsonObject; id = request.id;
    const method = String(request.method);
    const result = method === "ping" ? { ok: Boolean(engine), version: 1, state: engine ? "ready" : "starting", owner_key: ownerKey }
      : !engine ? { ok: false, error: { code: "runtime_unavailable", message: "Runtime owner is still starting", side_effects: "none" } }
      : method === "host_tool" ? await engine.hostTool(String((request.params as JsonObject).name), (((request.params as JsonObject).args ?? {}) as JsonObject))
      : { ok: false, error: { code: "invalid_input", message: `Unknown runtime RPC method: ${method}`, side_effects: "none" } };
    socket.write(`${JSON.stringify({ id, result })}\n`);
  } catch (error) { socket.write(`${JSON.stringify({ id, result: { ok: false, error: { code: "invalid_input", message: String(error), side_effects: "none" } } })}\n`) }
}

export function runtimeCall(port: number, method: string, params: JsonObject = {}, timeoutMs = 65000): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }); let buffer = "";
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error("runtime_unavailable: runtime call timed out")) }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: crypto.randomUUID(), method, params })}\n`));
    socket.on("data", (chunk) => { buffer += chunk; const end = buffer.indexOf("\n"); if (end < 0) return; clearTimeout(timeout); socket.end(); resolve((JSON.parse(buffer.slice(0, end)) as JsonObject).result as JsonObject) });
    socket.on("error", (error) => { clearTimeout(timeout); reject(new Error(`runtime_unavailable: ${error.message}`)) });
  });
}
