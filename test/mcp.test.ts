import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { readConfig } from "../src/config.js";
import { createRuntimeClient } from "../src/runtime-client.js";
import { runtimeCall, runtimeOwnerKey } from "../src/runtime-rpc.js";

async function listen(handler: (socket: Socket) => void, port = 0) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve) });
  return { port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function fixture() {
  mkdirSync(".banana-test", { recursive: true });
  const base = mkdtempSync(resolve(".banana-test/mcp-"));
  const reserved = await listen(socket => socket.end());
  await reserved.close();
  const configPath = resolve(base, "banana.json");
  const config = readConfig("distribution/plugins/banana-split-v1/config/banana.json");
  config.runtime.data_directory = resolve(base, "data");
  config.runtime.listen_port = reserved.port;
  config.runtime.codex_command = resolve(base, "missing-codex");
  writeFileSync(configPath, JSON.stringify(config));
  return { base, config, configPath, remove: () => rmSync(base, { recursive: true, force: true }) };
}

async function connect(configPath: string) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve("src/index.ts"), "mcp", "--config", configPath], stderr: "pipe" });
  let stderr = "";
  transport.stderr!.on("data", chunk => { stderr += String(chunk) });
  const client = new Client({ name: "banana-startup-test", version: "1.0.0" });
  try { await client.connect(transport, { timeout: 2000 }) }
  catch (error) { await transport.close(); throw new Error(`${String(error)}\n${stderr}`) }
  return client;
}

test("the shipped plugin permits Codex startup when the MCP executable cannot start", () => {
  const manifest = JSON.parse(readFileSync("distribution/plugins/banana-split-v1/.mcp.json", "utf8"));
  expect(manifest.mcpServers["banana-split-v1"].required).toBe(false);
});

test("MCP initializes with missing/invalid configuration and recovers after repair in the same connection", async () => {
  const f = await fixture();
  rmSync(f.configPath);
  const client = await connect(f.configPath);
  let hostCalls = 0;
  const runtime = await listen(socket => socket.once("data", line => {
    const request = JSON.parse(String(line));
    if (request.method === "host_tool") hostCalls++;
    socket.end(JSON.stringify({ result: request.method === "ping"
      ? { ok: true, owner_key: runtimeOwnerKey(f.config.runtime.data_directory) }
      : { ok: true, workflows: [] } }) + "\n");
  }), f.config.runtime.listen_port);
  try {
    expect((await client.listTools()).tools).toHaveLength(9);
    expect(existsSync(f.config.runtime.data_directory)).toBe(false);
    for (const contents of [undefined, "{broken json", JSON.stringify({ version: 999 })]) {
      if (contents !== undefined) writeFileSync(f.configPath, contents);
      const result = await client.callTool({ name: "banana_workflow_list", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "invalid_input", side_effects: "none", details: { stage: "configuration" } } });
      expect((await client.listTools()).tools).toHaveLength(9);
      expect(hostCalls).toBe(0);
    }
    writeFileSync(f.configPath, JSON.stringify(f.config));
    const recovered = await client.callTool({ name: "banana_workflow_list", arguments: {} });
    expect(recovered.isError).toBeUndefined();
    expect(recovered.structuredContent).toEqual({ ok: true, workflows: [] });
    expect(hostCalls).toBe(1);
  } finally { await client.close(); await runtime.close(); f.remove() }
});

test("missing Codex is a tool error with saved startup diagnostics, while MCP remains usable", async () => {
  const f = await fixture();
  const client = await connect(f.configPath);
  try {
    expect((await client.listTools()).tools).toHaveLength(9);
    expect(existsSync(f.config.runtime.data_directory)).toBe(false);
    const result = await client.callTool({ name: "banana_workflow_list", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: {
      code: "runtime_unavailable", details: { stage: "startup", runtime_log: resolve(f.config.runtime.data_directory, "runtime.log") }
    } });
    const body = JSON.stringify(result.structuredContent);
    expect(body).toContain("could not launch");
    expect(body).toContain("missing-codex");
    expect(body).toContain("Update Codex");
    expect(readFileSync(resolve(f.config.runtime.data_directory, "runtime.log"), "utf8")).toContain("app_server_unsupported");
    expect((await client.listTools()).tools).toHaveLength(9);
  } finally { await client.close(); f.remove() }
}, 5000);

test("an incompatible Codex protocol leaves MCP connected and includes the native error", async () => {
  const f = await fixture();
  const app = Bun.serve({ hostname: "127.0.0.1", port: f.config.runtime.listen_port + 1,
    fetch(request, server) { if (!server.upgrade(request)) return new Response("WebSocket required", { status: 400 }) },
    websocket: { message(socket, data) {
      const request = JSON.parse(String(data));
      socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: "Unsupported initialize capability in old Codex" } }));
    } }
  });
  const client = await connect(f.configPath);
  try {
    const result = await client.callTool({ name: "banana_workflow_list", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("Unsupported initialize capability in old Codex");
    expect((await client.listTools()).tools).toHaveLength(9);
  } finally { await client.close(); app.stop(true); f.remove() }
}, 5000);

test("a Codex command that exits early reports its stderr without waiting for the startup deadline", async () => {
  const f = await fixture();
  // Bun is an executable, but rejects the Codex App Server arguments. This
  // exercises an actual child exit rather than the missing-executable path.
  f.config.runtime.codex_command = process.execPath;
  writeFileSync(f.configPath, JSON.stringify(f.config));
  const client = await connect(f.configPath);
  try {
    const result = await client.callTool({ name: "banana_workflow_list", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("Codex App Server exited with code");
    expect(JSON.stringify(result.structuredContent)).toContain("[codex]");
    expect((await client.listTools()).tools).toHaveLength(9);
  } finally { await client.close(); f.remove() }
}, 5000);

test("a stalled runtime leaves MCP responsive, times out, and can recover on a later call", async () => {
  const f = await fixture();
  let ready = false;
  let probes = 0;
  let hostCalls = 0;
  const runtime = await listen(socket => socket.once("data", line => {
    const request = JSON.parse(String(line));
    if (request.method === "ping") probes++; else hostCalls++;
    socket.end(JSON.stringify({ result: request.method === "ping"
      ? { ok: ready, state: ready ? "ready" : "starting", owner_key: runtimeOwnerKey(f.config.runtime.data_directory) }
      : { ok: true, workflows: [] } }) + "\n");
  }), f.config.runtime.listen_port);
  const client = await connect(f.configPath);
  try {
    const pending = client.callTool({ name: "banana_workflow_list", arguments: {} });
    while (!probes) await Bun.sleep(10);
    expect((await client.listTools()).tools).toHaveLength(9);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("did not start within 15 seconds");
    expect(hostCalls).toBe(0);
    expect(existsSync(f.config.runtime.data_directory)).toBe(false);
    ready = true;
    expect((await client.callTool({ name: "banana_workflow_list", arguments: {} })).structuredContent).toEqual({ ok: true, workflows: [] });
    expect(hostCalls).toBe(1);
  } finally { await client.close(); await runtime.close(); f.remove() }
}, 20000);

test("a runtime storage initialization failure releases its listener and exits", async () => {
  const f = await fixture();
  writeFileSync(f.config.runtime.data_directory, "A file prevents creation of the state directory");
  const child = Bun.spawn([process.execPath, resolve("src/index.ts"), "runtime", "--config", f.configPath], { stdout: "ignore", stderr: "pipe" });
  try {
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("EEXIST");
    const replacement = await listen(socket => socket.end(), f.config.runtime.listen_port);
    await replacement.close();
  } finally { child.kill(); await child.exited; f.remove() }
}, 2000);

test("simultaneous tools share a failed startup attempt and a later call can recover", async () => {
  const f = await fixture();
  const call = createRuntimeClient(f.configPath);
  try {
    const results = await Promise.all(Array.from({ length: 3 }, () => call("banana_workflow_list", {})));
    expect(results.every(result => result.ok === false)).toBe(true);
    const log = readFileSync(resolve(f.config.runtime.data_directory, "runtime.log"), "utf8");
    expect(log.match(/Banana Split runtime startup/g)).toHaveLength(1);
    const rejection = { ok: false, error: { code: "not_found", message: "Missing workflow", side_effects: "none" } };
    const runtime = await listen(socket => socket.once("data", line => {
      const request = JSON.parse(String(line));
      socket.end(JSON.stringify({ result: request.method === "ping"
        ? { ok: true, owner_key: runtimeOwnerKey(f.config.runtime.data_directory) } : rejection }) + "\n");
    }), f.config.runtime.listen_port);
    try { expect(await call("banana_agent_inspect", { workflow_id: "missing", agent_id: "missing" })).toEqual(rejection) }
    finally { await runtime.close() }
  } finally { f.remove() }
}, 5000);

test("a lost mutation response is reported with possible effects and is never replayed", async () => {
  const f = await fixture();
  let mutations = 0;
  const runtime = await listen(socket => socket.once("data", line => {
    const request = JSON.parse(String(line));
    if (request.method === "ping") socket.end(JSON.stringify({ result: { ok: true, owner_key: runtimeOwnerKey(f.config.runtime.data_directory) } }) + "\n");
    else { mutations++; socket.end() }
  }), f.config.runtime.listen_port);
  const client = await connect(f.configPath);
  try {
    const result = await client.callTool({ name: "banana_workflow_start", arguments: { task: "Test only", workspace: f.base } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "runtime_unavailable", side_effects: "possible", details: { stage: "request" } } });
    expect(JSON.stringify(result.structuredContent)).toContain("do not automatically repeat");
    expect(mutations).toBe(1);
    expect((await client.listTools()).tools).toHaveLength(9);
  } finally { await client.close(); await runtime.close(); f.remove() }
});

for (const reply of ["not json", "null", "{}", '{"result":[]}', '{"result":{"ok":"true"}}']) {
  test(`malformed runtime reply is rejected without crashing the caller: ${reply}`, async () => {
    const runtime = await listen(socket => socket.once("data", () => socket.end(reply + "\n")));
    try { await expect(runtimeCall(runtime.port, "ping", {}, 500)).rejects.toThrow("invalid runtime response") }
    finally { await runtime.close() }
  });
}

test("a silent runtime request times out and closes its connection", async () => {
  const runtime = await listen(socket => socket.on("data", () => {}));
  try { await expect(runtimeCall(runtime.port, "ping", {}, 50)).rejects.toThrow("runtime call timed out") }
  finally { await runtime.close() }
});
