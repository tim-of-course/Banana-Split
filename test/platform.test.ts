import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { AppServer, terminateProcessTree } from "../src/app-server.js";
import { Engine } from "../src/engine.js";
import { ceilingForWorkspace, readConfig } from "../src/config.js";
import { RuntimeOwner, runtimeCall, runtimeOwnerKey } from "../src/runtime-rpc.js";
import { ensureRuntime } from "../src/runtime-client.js";

test("writable-root ceilings distinguish omission, empty lists, descendants, and siblings", () => {
  const config = readConfig("distribution/plugins/banana-split-v1/config/banana.json");
  config.runtime.permission_ceiling.mcp_servers = [];
  const workspace = resolve(".banana-test", "allowed", "project");
  expect(config.runtime.permission_ceiling.writable_roots).toBeUndefined();
  expect(ceilingForWorkspace(config, workspace).writable_roots).toEqual([workspace]);
  config.runtime.permission_ceiling.writable_roots = [];
  expect(ceilingForWorkspace(config, workspace).writable_roots).toEqual([]);
  config.runtime.permission_ceiling.writable_roots = [resolve(".banana-test", "allowed")];
  expect(ceilingForWorkspace(config, workspace).writable_roots).toEqual([workspace]);
  expect(() => ceilingForWorkspace(config, resolve(".banana-test", "allowed-sibling"))).toThrow("not an allowed writable root");
});

test("write-root narrowing resolves directory aliases at both permission boundaries", () => {
  const base = resolve(".banana-test", crypto.randomUUID());
  const allowed = `${base}/allowed`, outside = `${base}/outside`;
  mkdirSync(`${allowed}/inside`, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, `${allowed}/escape`, "junction");
  symlinkSync(`${allowed}/inside`, `${base}/alias`, "junction");
  const config = readConfig("distribution/plugins/banana-split-v1/config/banana.json");
  config.runtime.permission_ceiling.mcp_servers = [];
  config.runtime.permission_ceiling.writable_roots = [allowed];
  expect(() => ceilingForWorkspace(config, `${allowed}/escape`)).toThrow("not an allowed writable root");
  expect(ceilingForWorkspace(config, `${base}/alias`).writable_roots).toEqual([`${allowed}/inside`]);
  const parent = ceilingForWorkspace(config, allowed);
  for (const requested of [`${allowed}/escape`, `${allowed}/escape/new/child`]) {
    expect(() => Engine.prototype.narrowPermissions(parent, { writable_roots: [requested] }, allowed)).toThrow("writable_roots");
  }
  expect(Engine.prototype.narrowPermissions(parent, { writable_roots: [`${base}/alias/new/child`] }, allowed).writable_roots)
    .toEqual([`${allowed}/inside/new/child`]);
});

test("narrowing cannot turn a native protected directory into a writable root", () => {
  const config = readConfig("distribution/plugins/banana-split-v1/config/banana.json");
  config.runtime.permission_ceiling.mcp_servers = [];
  const workspace = resolve(".banana-test", crypto.randomUUID());
  mkdirSync(workspace, { recursive: true });
  const parent = ceilingForWorkspace(config, workspace);
  config.runtime.permission_ceiling.writable_roots = [workspace];
  for (const name of [".git", ".agents", ".codex"]) {
    mkdirSync(`${workspace}/${name}`);
    for (const suffix of [name, `${name}/new/child`]) {
      expect(() => Engine.prototype.narrowPermissions(parent, { writable_roots: [`${workspace}/${suffix}`] }, workspace)).toThrow("writable_roots");
      expect(() => ceilingForWorkspace(config, `${workspace}/${suffix}`)).toThrow("not an allowed writable root");
    }
  }
  expect(Engine.prototype.narrowPermissions(parent, { writable_roots: [`${workspace}/.github`] }, workspace).writable_roots)
    .toEqual([`${workspace}/.github`]);
});

test("a missing Codex executable reports its launch error without a connection timeout", async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const command = resolve(".banana-test", crypto.randomUUID(), "missing-codex");
  const app = new AppServer(command, port);
  try { await expect(app.start()).rejects.toThrow(`could not launch ${command}`) }
  finally { await app.stop() }
}, 2000);

test("a runtime disconnect rejects the call before its request timeout", async () => {
  const server = createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = runtimeCall((server.address() as { port: number }).port, "ping", {}, 5000);
    await expect(result).rejects.toThrow("runtime connection closed before responding");
  } finally { server.close() }
}, 1000);

test("stopping an attached App Server rejects outstanding RPC calls", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (!server.upgrade(request)) return new Response("WebSocket required", { status: 400 }) },
    websocket: { message(socket, data) {
      const request = JSON.parse(String(data));
      if (request.id === undefined || request.method === "pending-probe") return;
      const result = request.method === "initialize" ? { platformOs: process.platform === "darwin" ? "macos" : "windows" }
        : request.method === "config/read" ? { config: {} } : { data: [], nextCursor: null };
      socket.send(JSON.stringify({ id: request.id, result }));
    } }
  });
  const app = new AppServer("unused", server.port!);
  let timeout: ReturnType<typeof setTimeout>;
  try {
    await app.start();
    const pending = app.call("pending-probe", {}).then(() => "unexpected response", error => String(error));
    await app.stop();
    const result = await Promise.race([pending, new Promise(resolve => { timeout = setTimeout(() => resolve("still pending"), 500) })]);
    expect(result).toContain("App Server stopped");
  } finally { clearTimeout(timeout!); await app.stop(); server.stop(true) }
});

test("a starting runtime owned by another data directory is rejected immediately", async () => {
  const server = createServer(socket => socket.once("data", () => socket.end(JSON.stringify({ result: { ok: false, state: "starting", owner_key: "other-owner" } }) + "\n")));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const config = readConfig("distribution/plugins/banana-split-v1/config/banana.json");
    config.runtime.listen_port = (server.address() as { port: number }).port;
    await expect(ensureRuntime(config, "unused-config-path")).rejects.toThrow("belongs to a different Banana Split data directory");
  } finally { server.close() }
}, 1000);

test.skipIf(process.platform !== "darwin")("packaged configuration uses the macOS user data directory", () => {
  expect(readConfig("distribution/plugins/banana-split-v1/config/banana.json").runtime.data_directory)
    .toBe(resolve(homedir(), "Library/Application Support/BananaSplit"));
});

test.skipIf(process.platform !== "darwin")("simultaneous runtime starts acquire exactly one durable-data owner", async () => {
  const data = resolve(".banana-test", crypto.randomUUID());
  const children = Array.from({ length: 12 }, () => spawn(process.execPath, ["-e", `import { RuntimeOwner } from './src/runtime-rpc.ts'; const owner = new RuntimeOwner(0, ${JSON.stringify(data)}); process.stdin.once('data', async () => { try { await owner.listen(); console.log('owned') } catch { console.log('denied') } }); console.log('ready'); setInterval(() => {}, 1000);`], { stdio: ["pipe", "pipe", "inherit"] }));
  try {
    await Promise.all(children.map(child => once(child.stdout!, "data")));
    const replies = children.map(child => once(child.stdout!, "data"));
    for (const child of children) child.stdin!.write("go");
    const results = await Promise.all(replies);
    expect(results.filter(([output]) => String(output).trim() === "owned")).toHaveLength(1);
  } finally {
    const exits = children.map(child => once(child, "exit"));
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(exits);
  }
});

test("a pending event poll does not keep a closed runtime process alive", async () => {
  const child = spawn(process.execPath, ["-e", 'import { Engine } from "./src/engine.ts"; void Engine.prototype.waitForEvent.call({ pollWaiters: new Map() }, "probe", 60000);'], { stdio: "ignore" });
  let timeout: ReturnType<typeof setTimeout>;
  try {
    const result = await Promise.race([
      once(child, "exit").then(([code]) => code),
      new Promise(resolve => { timeout = setTimeout(() => resolve("still running"), 1000) })
    ]);
    expect(result).toBe(0);
  } finally {
    clearTimeout(timeout!);
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited }
  }
});

test.skipIf(process.platform !== "darwin")("directory aliases share one runtime owner even before a child directory exists", async () => {
  const base = resolve(".banana-test", crypto.randomUUID());
  mkdirSync(`${base}/data`, { recursive: true }); symlinkSync(`${base}/data`, `${base}/alias`, "dir");
  expect(runtimeOwnerKey(`${base}/data/new`)).toBe(runtimeOwnerKey(`${base}/alias/new`));
  const first = new RuntimeOwner(0, `${base}/data`); const second = new RuntimeOwner(0, `${base}/alias`);
  try {
    await first.listen();
    await expect(second.listen()).rejects.toThrow("already owns this durable data directory");
  } finally { await first.close(); await second.close() }
});

test("runtime ownership can recover after a process is killed", async () => {
  const data = resolve(".banana-test", crypto.randomUUID());
  const child = spawn(process.execPath, ["-e", `import { RuntimeOwner } from './src/runtime-rpc.ts'; const owner = new RuntimeOwner(0, ${JSON.stringify(data)}); await owner.listen(); console.log('ready'); await owner.wait();`], { stdio: ["ignore", "pipe", "inherit"] });
  await once(child.stdout!, "data");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const replacement = new RuntimeOwner(0, data);
  try { await replacement.listen() }
  finally { await replacement.close() }
});

test.skipIf(process.platform === "win32")("shutdown kills the owned process group, including descendants", async () => {
  const child = spawn(process.execPath, ["-e", `import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); console.log(child.pid); setInterval(() => {}, 1000);`], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  const [output] = await once(child.stdout!, "data");
  const descendant = Number(String(output).trim());
  try {
    await terminateProcessTree(child);
    expect(child.signalCode).toBe("SIGKILL");
    // Reaping of the grandchild is asynchronous after the group is killed.
    let gone = false;
    for (let attempt = 0; attempt < 100 && !gone; attempt++) {
      try { process.kill(descendant, 0) }
      catch (error) { gone = (error as NodeJS.ErrnoException).code === "ESRCH" }
      if (!gone) await Bun.sleep(10);
    }
    expect(gone).toBe(true);
  } finally {
    try { process.kill(-child.pid!, "SIGKILL") } catch {}
  }
});
