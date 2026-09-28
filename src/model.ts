export type JsonObject = Record<string, unknown>;
export type SideEffects = "none" | "possible" | "known";
export type AgentState = "pending_context" | "queued" | "active" | "waiting" | "submitted" | "completed" | "failed" | "cancelled";
export type WorkflowState = "running" | "attention_required" | "cancelling" | "completed" | "failed" | "cancelled";
export type Outcome = "success" | "partial" | "blocked" | "unsuccessful";

export interface Preset { model: string; reasoning_effort: string; service_tier?: string }
export type PresetTiers = Record<string, Record<string, Preset>>;
export interface PermissionPolicy {
  sandbox: "readOnly" | "workspaceWrite";
  writable_roots: string[];
  network_access: boolean;
  approval_policy: "untrusted" | "onRequest" | "never";
  approval_reviewer: "host";
  tools?: string[];
  mcp_servers: string[];
}
export interface ResultValue { outcome: Outcome; summary: string; details?: JsonObject }
export interface TerminalFact { code: string; message: string; relevant_ids: string[]; side_effects: SideEffects; details?: JsonObject }
export interface MailItem {
  id: string; from: string; to: string; type: string;
  payload: { body?: string; details?: JsonObject };
  sequence: number; sent_at: string; assigned_turn_id?: string;
}
export type Disposition =
  | { type: "wait"; children: string[]; messages: boolean }
  | { type: "ask"; request_id: string }
  | { type: "request_host"; request_id: string }
  | { type: "finish"; result: ResultValue };
export interface ContextProvenance { source: "fresh" | "inherit"; parent_turn_id?: string }

export interface AgentRecord {
  id: string; short_id: string; workflow_id: string; parent_id?: string; children: string[];
  task: string; brief?: JsonObject; details?: JsonObject; provenance: ContextProvenance;
  requested_preset: string; resolved_preset: Preset; observed_routing?: JsonObject;
  token_usage?: JsonObject;
  routing_history?: Array<{ turn_id: string; tier: string; preset: string; resolved_preset: Preset }>;
  permissions: PermissionPolicy; state: AgentState; thread_id?: string; latest_turn_id?: string;
  active_turn_id?: string; pending_context_turn_id?: string; queued: boolean; turn_closing: boolean;
  thread_start_started?: boolean; context_fork_started?: boolean;
  last_queue_reason?: string;
  disposition?: Disposition; mailbox: MailItem[]; next_message_sequence: number;
  wait?: { children: string[]; messages: boolean; reason?: string };
  uncommitted_finish?: { result: ResultValue; turn_id: string; turn_status: string; recorded_at: string };
  submission?: ResultValue;
  submissions: Array<{ result: ResultValue; submitted_at: string; decision?: "accept" | "revise"; feedback?: JsonObject }>;
  result?: ResultValue; terminal_fact?: TerminalFact; attention_codes: string[];
  failure_acknowledged?: boolean;
  created_at: string; updated_at: string;
}

export interface AdviceRequest {
  id: string; workflow_id: string; requester_id: string; advisor_id: string; question: string;
  context?: JsonObject; status: "armed" | "pending" | "answered" | "declined" | "cancelled" | "failed";
  guidance?: string; details?: JsonObject; terminal_fact?: TerminalFact; created_at: string; resolved_at?: string;
}
export interface HostRequest {
  id: string; workflow_id: string; requester_id: string; capability: "computer_use"; task: string;
  context?: JsonObject; expected_evidence?: JsonObject;
  status: "armed" | "pending" | "in_progress" | "uncertain" | "completed" | "declined" | "failed" | "cancelled";
  resolution?: "completed" | "declined" | "failed" | "cancelled"; summary?: string; details?: JsonObject;
  terminal_fact?: TerminalFact;
  created_at: string; pending_sequence?: number; claimed_at?: string; resolved_at?: string;
}
export interface ApprovalRecord {
  id: string; workflow_id: string; agent_id: string; thread_id: string; turn_id: string | null; method: string;
  request_id: string | number; summary: string; status: "pending" | "answered" | "invalidated"; details?: JsonObject;
  response?: JsonObject; response_details?: JsonObject; answered_at?: string;
}
export interface MaterialEvent {
  cursor: string; sequence: number; type: string; summary: string; agent_id?: string; request_id?: string; created_at: string;
  details?: JsonObject;
}
export interface WorkflowRecord {
  id: string; short_id: string; root_id: string; task: string; details?: JsonObject; workspace: string;
  status: WorkflowState; spawn_frozen: boolean; preset_snapshot: Record<string, Preset>;
  preset_tiers?: PresetTiers; active_tier?: string;
  preset_catalog_source?: "configured" | "workflow_override";
  preset_recommendations: Record<string, JsonObject>; default_preset: string; permission_ceiling: PermissionPolicy;
  host_capabilities: { computer_use: boolean }; agents: Record<string, AgentRecord>;
  advice_requests: Record<string, AdviceRequest>; host_requests: Record<string, HostRequest>;
  approvals: Record<string, ApprovalRecord>; events: MaterialEvent[]; next_event_sequence: number;
  created_at: string; updated_at: string;
}
export interface DurableState {
  version: 1; runnable: Array<{ sequence: number; workflow_id: string; agent_id: string }>;
  next_runnable_sequence: number; next_host_request_sequence: number; workflows: Record<string, WorkflowRecord>;
}
export interface RuntimeConfig {
  version: 1;
  runtime: {
    data_directory: string; listen_port: number; scheduler: { max_active_turns: number };
    permission_ceiling: {
      sandbox: "readOnly" | "workspaceWrite"; network_access: boolean;
      approval_policy: "untrusted" | "onRequest" | "never"; approval_reviewer: "host";
      writable_roots?: string[]; tools?: string[]; mcp_servers?: string[] | "workspace";
    };
    host_capabilities: { computer_use: boolean }; codex_command: string;
  };
  workflow_defaults: {
    default_preset: string; presets: Record<string, Preset>; preset_recommendations: Record<string, JsonObject>;
    preset_tiers?: PresetTiers; default_tier?: string;
  };
}
export interface ToolFailure {
  ok: false;
  error: { code: string; message: string; workflow_id?: string; agent_id?: string; request_id?: string;
    state?: string; side_effects: SideEffects; details?: JsonObject };
}
export const now = (): string => new Date().toISOString();
export const id = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
export const shortId = (value: string): string => value.slice(value.indexOf("_") + 1, value.indexOf("_") + 9);
export function failure(code: string, message: string, fields: Partial<ToolFailure["error"]> = {}): ToolFailure {
  return { ok: false, error: { code, message, side_effects: "none", ...fields } };
}
