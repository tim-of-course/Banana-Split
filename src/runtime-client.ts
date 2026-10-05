import { spawn } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "./config.js";
import type { JsonObject, RuntimeConfig } from "./model.js";
import { runtimeCall, runtimeOwnerKey } from "./runtime-rpc.js";

// MCP discovery must not depend on configuration, Codex, or a running runtime.
// Share one startup attempt among simultaneous tool calls; a later call can retry
// after the user repairs configuration or updates Codex.
export function createRuntimeClient(configPath: string): (name: string, args: JsonObject) => Promise<JsonObject> {
  let startup: { config: RuntimeConfig; promise: Promise<void> } | undefined;
  return async (name, args) => {
    let stage: "configuration" | "startup" | "request" = "configuration";
    let config: RuntimeConfig | undefined;
    try {
      if (!startup) {
        config = readConfig(configPath);
        startup = { config, promise: ensureRuntime(config, configPath).finally(() => { startup = undefined }) };
      }
      const attempt = startup;
      config = attempt.config;
      stage = "startup";
      await attempt.promise;
      stage = "request";
      // Never replay a request after a transport failure: it may have committed.
      return await runtimeCall(config.runtime.listen_port, "host_tool", { name, args }, 65000);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return { ok: false, error: {
        code: stage === "configuration" ? "invalid_input" : "runtime_unavailable",
        message: `Banana Split ${stage} failed: ${cause}. Ordinary Codex work can continue.`,
        // Starting a runtime can reconcile retained workflows even before the
        // requested tool is sent. A lost tool response has an unknown outcome.
        side_effects: stage === "configuration" ? "none" : "possible",
        details: {
          stage, config_path: configPath, tool: name,
          ...(stage === "startup" && config ? { runtime_log: join(config.runtime.data_directory, "runtime.log") } : {}),
          recovery: stage === "configuration"
            ? "Fix the installed configuration file, then retry the Banana Split tool."
            : stage === "startup"
              ? "Check the runtime log. Update Codex if capabilities are unsupported; verify the configured codex_command is available to the host, authentication, model presets, and runtime port. The requested tool was not sent. Retry after correcting the cause."
              : "The request may have completed; do not automatically repeat it. Restore runtime connectivity, then inspect retained workflows before deciding whether to retry."
        }
      } };
    }
  };
}

export async function ensureRuntime(config: RuntimeConfig, configPath: string): Promise<void> {
  const expectedOwner = runtimeOwnerKey(config.runtime.data_directory);
  const state = async (): Promise<"ready" | "starting" | undefined> => {
    let ping: JsonObject;
    try { ping = await runtimeCall(config.runtime.listen_port, "ping", {}, 1000) }
    catch { return undefined }
    if (ping.owner_key !== expectedOwner) throw new Error("runtime_unavailable: 127.0.0.1:" + config.runtime.listen_port + " belongs to a different Banana Split data directory");
    return ping.ok === true ? "ready" : ping.state === "starting" ? "starting" : undefined;
  };
  const initial = await state();
  if (initial === "ready") return;
  const logPath = join(config.runtime.data_directory, "runtime.log");
  let logStart = 0;
  let startupError: string | undefined;
  if (initial !== "starting") {
    mkdirSync(config.runtime.data_directory, { recursive: true, mode: 0o700 });
    // A file descriptor lets the detached runtime keep reporting errors after
    // this MCP host exits, without a pipe tying their lifetimes together.
    const log = openSync(logPath, "a", 0o600);
    try {
      logStart = fstatSync(log).size;
      writeSync(log, `\nBanana Split runtime startup ${new Date().toISOString()}\n`);
      const sourceMode = /(?:bun|node)(?:\.exe)?$/i.test(process.execPath);
      const args = sourceMode ? [fileURLToPath(new URL("./index.ts", import.meta.url)), "runtime", "--config", configPath] : ["runtime", "--config", configPath];
      const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", "ignore", log], windowsHide: true });
      child.once("error", error => { startupError = `could not launch ${process.execPath}: ${error.message}` });
      child.once("exit", (code, signal) => { startupError = `runtime exited (${signal ?? `code ${code}`}) before becoming ready` });
      child.unref();
    } finally { closeSync(log) }
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const current = await state();
    if (current === "ready") return;
    // Another host may win the startup race. Wait for its matching owner even
    // if our child exits because the data directory is already locked.
    if (startupError && current !== "starting") throw startupFailure(startupError, logPath, logStart);
  }
  throw startupFailure("Banana Split runtime did not start within 15 seconds", logPath, logStart);
}

function startupFailure(message: string, logPath: string, logStart: number): Error {
  let output = "";
  try {
    const fd = openSync(logPath, "r");
    try {
      const end = fstatSync(fd).size;
      const start = Math.max(logStart, end - 8192);
      const buffer = Buffer.alloc(Math.max(0, end - start));
      output = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, start)).toString("utf8").trim();
    } finally { closeSync(fd) }
  } catch { /* Report the startup failure even when the log cannot be read. */ }
  return new Error(`runtime_unavailable: ${message}\nRuntime log: ${logPath}${output ? `\nRecent runtime output:\n${output}` : ""}`);
}
