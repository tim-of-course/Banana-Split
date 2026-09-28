import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { readPresetTiers } from "./presets.js";
import type { JsonObject, PermissionPolicy, Preset, RuntimeConfig } from "./model.js";
const keys = (value: JsonObject, allowed: string[], where: string): void => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${where} has unknown fields: ${unknown.join(", ")}`);
};
const object = (value: unknown, where: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as JsonObject;
};
const nonempty = (value: unknown, where: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a nonempty string`);
  return value;
};
const expand = (value: string): string => normalize(value.replace(/%([^%]+)%/g, (_, name: string) =>
  name === "LOCALAPPDATA" && process.platform === "darwin"
    ? resolve(homedir(), "Library", "Application Support")
    : process.env[name] ?? `%${name}%`));

export function readConfig(path: string): RuntimeConfig {
  if (!existsSync(path)) throw new Error(`Configuration file not found: ${path}`);
  const raw = object(JSON.parse(readFileSync(path, "utf8")), "configuration");
  keys(raw, ["version", "runtime", "workflow_defaults"], "configuration");
  if (raw.version !== 1) throw new Error("Unsupported configuration version; expected 1");
  const runtime = object(raw.runtime, "runtime");
  keys(runtime, ["data_directory", "listen_port", "scheduler", "permission_ceiling", "host_capabilities", "codex_command"], "runtime");
  const scheduler = object(runtime.scheduler, "runtime.scheduler");
  keys(scheduler, ["max_active_turns"], "runtime.scheduler");
  const max = scheduler.max_active_turns;
  if (!Number.isInteger(max) || (max as number) < 1) throw new Error("max_active_turns must be a positive integer");
  const port = runtime.listen_port ?? 43891;
  if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65534) throw new Error("listen_port must be 1024-65534 because App Server uses the next port");
  const ceiling = object(runtime.permission_ceiling, "runtime.permission_ceiling");
  keys(ceiling, ["sandbox", "network_access", "approval_policy", "approval_reviewer", "writable_roots", "tools", "mcp_servers"], "runtime.permission_ceiling");
  if (!["readOnly", "workspaceWrite"].includes(String(ceiling.sandbox))) throw new Error("permission ceiling sandbox must be readOnly or workspaceWrite");
  if (typeof ceiling.network_access !== "boolean") throw new Error("permission ceiling network_access must be boolean");
  if (!["untrusted", "onRequest", "never"].includes(String(ceiling.approval_policy))) throw new Error("invalid approval_policy");
  if (ceiling.approval_reviewer !== "host") throw new Error("approval_reviewer must be host");
  if (ceiling.tools !== undefined) throw new Error("app_server_unsupported: current App Server does not expose an enforceable generic built-in tool allowlist");
  const caps = object(runtime.host_capabilities, "runtime.host_capabilities");
  keys(caps, ["computer_use"], "runtime.host_capabilities");
  if (typeof caps.computer_use !== "boolean") throw new Error("host_capabilities.computer_use must be boolean");
  const defaults = object(raw.workflow_defaults, "workflow_defaults");
  keys(defaults, ["default_preset", "presets", "preset_recommendations", "preset_tiers", "default_tier"], "workflow_defaults");
  const presetsObject = object(defaults.presets, "workflow_defaults.presets");
  const presets: Record<string, Preset> = {};
  for (const [name, value] of Object.entries(presetsObject)) {
    const preset = object(value, `preset ${name}`);
    keys(preset, ["model", "reasoning_effort", "service_tier"], `preset ${name}`);
    presets[name] = { model: nonempty(preset.model, `${name}.model`), reasoning_effort: nonempty(preset.reasoning_effort, `${name}.reasoning_effort`) };
    if (preset.service_tier !== undefined) presets[name].service_tier = nonempty(preset.service_tier, `${name}.service_tier`);
  }
  const defaultPreset = nonempty(defaults.default_preset, "default_preset");
  if (!presets[defaultPreset]) throw new Error(`default preset is unavailable: ${defaultPreset}`);
  const tiers = defaults.preset_tiers === undefined ? undefined : readPresetTiers(defaults.preset_tiers, defaultPreset);
  const defaultTier = defaults.default_tier === undefined ? undefined : nonempty(defaults.default_tier, "default_tier");
  if (tiers ? !defaultTier || !tiers[defaultTier] : defaultTier !== undefined) throw new Error("default_tier must name a configured preset tier");
  const dataDirectory = expand(nonempty(runtime.data_directory, "data_directory"));
  return {
    version: 1,
    runtime: {
      data_directory: isAbsolute(dataDirectory) ? dataDirectory : resolve(path, "..", dataDirectory),
      listen_port: port as number,
      scheduler: { max_active_turns: max as number },
      permission_ceiling: {
        sandbox: ceiling.sandbox as "readOnly" | "workspaceWrite",
        network_access: ceiling.network_access as boolean,
        approval_policy: ceiling.approval_policy as "untrusted" | "onRequest" | "never",
        approval_reviewer: "host",
        ...(ceiling.writable_roots === undefined ? {} : { writable_roots: stringArray(ceiling.writable_roots, "writable_roots") }),
        mcp_servers: ceiling.mcp_servers === "workspace" ? "workspace" : stringArray(ceiling.mcp_servers, "mcp_servers")
      },
      host_capabilities: { computer_use: caps.computer_use as boolean },
      codex_command: nonempty(runtime.codex_command ?? "codex", "codex_command")
    },
    workflow_defaults: {
      default_preset: defaultPreset,
      presets,
      ...(tiers ? { preset_tiers: tiers, default_tier: defaultTier! } : {}),
      preset_recommendations: object(defaults.preset_recommendations ?? {}, "preset_recommendations") as Record<string, JsonObject>
    }
  };
}

function stringArray(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`${where} must be an array of nonempty strings`);
  return [...new Set(value as string[])];
}

export function ceilingForWorkspace(config: RuntimeConfig, workspace: string, workspaceMcp?: string[]): PermissionPolicy {
  const canonical = permissionPath(workspace);
  const configured = config.runtime.permission_ceiling.writable_roots;
  if (configured?.length && !configured.some((path) => withinWritableRoot(canonical, expand(path)))) {
    throw new Error("Workflow workspace is not an allowed writable root");
  }
  const mcp = config.runtime.permission_ceiling.mcp_servers;
  if (mcp === "workspace" && workspaceMcp === undefined) throw new Error("Workspace MCP permissions must be resolved before workflow creation");
  const policy: PermissionPolicy = {
    sandbox: config.runtime.permission_ceiling.sandbox,
    writable_roots: config.runtime.permission_ceiling.sandbox === "workspaceWrite" && configured?.length !== 0 ? [canonical] : [],
    network_access: config.runtime.permission_ceiling.network_access,
    approval_policy: config.runtime.permission_ceiling.approval_policy,
    approval_reviewer: "host",
    mcp_servers: [...(mcp === "workspace" ? workspaceMcp! : mcp ?? [])]
  };
  if (config.runtime.permission_ceiling.tools !== undefined) policy.tools = [...config.runtime.permission_ceiling.tools];
  return policy;
}

export function permissionPath(path: string): string {
  // Resolve aliases in existing ancestors even when the requested directory is new.
  let ancestor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return resolve(realpathSync(ancestor), ...missing) }
    catch (error) {
      const parent = dirname(ancestor);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === ancestor) throw error;
      missing.unshift(basename(ancestor)); ancestor = parent;
    }
  }
}

export function withinWritableRoot(child: string, parent: string): boolean {
  const suffix = relative(permissionPath(parent), permissionPath(child));
  // Native workspace-write protects these directories beneath each root. Making
  // one a new root would drop its parent's read-only exception in the new policy.
  const protectedDirectory = [".git", ".agents", ".codex"].includes(suffix.split(sep)[0]!.toLowerCase());
  return !protectedDirectory && (suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)));
}
