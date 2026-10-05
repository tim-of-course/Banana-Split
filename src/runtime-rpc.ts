import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { closeSync, constants, openSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, normalize, resolve } from "node:path";
import type { Engine } from "./engine.js";
import type { JsonObject } from "./model.js";

export class RuntimeOwner {
  readonly ownerKey: string;
  private readonly lockServer = createServer((socket) => socket.destroy());
  private readonly sockets = new Set<import("node:net").Socket>();
  private engine?: Engine;
  private lockFd?: number;
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
      const address = runtimeLockAddress(this.ownerKey);
      if (process.platform === "darwin") {
        // Darwin O_EXLOCK locks atomically during open. Keep this file in place:
        // unlinking it would let a second owner lock a different inode.
        try { this.lockFd = openSync(`${address}.lock`, constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | 0x20, 0o600) }
        catch (error) {
          if (["EAGAIN", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new Error("Another Banana Split runtime already owns this durable data directory");
          throw error;
        }
      }
      if (process.platform !== "win32") await removeStaleSocket(address);
      await listen(this.lockServer, address, "Another Banana Split runtime already owns this durable data directory");
      await listen(this.server, this.port, "A Banana Split runtime already owns 127.0.0.1:" + this.port, "127.0.0.1");
    } catch (error) {
      await closeServer(this.server);
      await closeServer(this.lockServer);
      this.releaseFileLock();
      throw error;
    }
  }

  attach(engine: Engine): void { this.engine = engine }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await closeServer(this.server);
    await closeServer(this.lockServer);
    this.releaseFileLock();
  }

  private releaseFileLock(): void {
    if (this.lockFd !== undefined) { closeSync(this.lockFd); this.lockFd = undefined }
  }

  wait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const close = () => void this.close().then(resolve, reject);
      process.once("SIGINT", close); process.once("SIGTERM", close);
    });
  }
}

export function runtimeOwnerKey(dataDirectory: string): string {
  // Resolve the nearest existing ancestor so aliases agree even on first startup.
  let ancestor = resolve(dataDirectory);
  const missing: string[] = [];
  for (;;) {
    try { ancestor = realpathSync(ancestor); break }
    catch (error) {
      const parent = dirname(ancestor);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === ancestor) throw error;
      missing.unshift(basename(ancestor)); ancestor = parent;
    }
  }
  const canonical = normalize(resolve(ancestor, ...missing)).toLowerCase();
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function runtimeLockAddress(ownerKey: string): string {
  return process.platform === "win32"
    ? "\\\\.\\pipe\\banana-split-" + ownerKey
    : `/tmp/banana-split-${process.getuid!()}-${ownerKey}.sock`;
}

async function removeStaleSocket(address: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const socket = createConnection(address);
    socket.once("connect", () => { socket.destroy(); resolvePromise() });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      // Bun on macOS reports ENOENT for a socket left by a killed process.
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        try { unlinkSync(address) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { reject(error); return } }
      } else { reject(error); return }
      resolvePromise();
    });
  });
}

function listen(server: import("node:net").Server, target: number | string, inUseMessage: string, host?: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException) => reject(new Error(error.code === "EADDRINUSE" ? inUseMessage : String(error)));
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
    let settled = false;
    const finish = (error?: Error, result?: JsonObject) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const timeout = setTimeout(() => finish(new Error("runtime_unavailable: runtime call timed out")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      try { socket.write(`${JSON.stringify({ id: crypto.randomUUID(), method, params })}\n`) }
      catch (error) { finish(new Error(`runtime_unavailable: could not send runtime request: ${String(error)}`)) }
    });
    socket.on("data", (chunk) => {
      buffer += chunk; const end = buffer.indexOf("\n"); if (end < 0 || settled) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        const result = response?.result;
        if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.ok !== "boolean") throw new Error("expected a result object with an ok flag");
        finish(undefined, result);
      } catch (error) { finish(new Error(`runtime_unavailable: invalid runtime response: ${String(error)}`)) }
    });
    socket.on("error", error => finish(new Error(`runtime_unavailable: ${error.message}`)));
    socket.once("close", () => finish(new Error("runtime_unavailable: runtime connection closed before responding")));
  });
}
