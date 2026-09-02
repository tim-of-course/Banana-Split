import type { JsonObject } from "./model.js";

const object = (properties: JsonObject, required: string[]): JsonObject => ({ type: "object", properties, required, additionalProperties: false });
const details = { type: "object", additionalProperties: true };
const string = { type: "string", minLength: 1 };

export const AGENT_TOOL_SPECS: JsonObject[] = [
  { type: "function", name: "banana_spawn", description: "Create one direct managed child agent.", inputSchema: object({
    task: string,
    context: object({ source: { type: "string", enum: ["fresh", "inherit"] }, brief: details }, ["source"]),
    preset: string,
    permissions: details,
    details
  }, ["task", "context"]) },
  { type: "function", name: "banana_send", description: "Send nonblocking information to an eligible agent.", inputSchema: object({
    to: string, message: object({ type: string, body: string, details }, ["type"])
  }, ["to", "message"]) },
  { type: "function", name: "banana_ask", description: "Ask one agent for correlated guidance and close this turn into a wait.", inputSchema: object({ to: string, question: string, context: details }, ["to", "question"]) },
  { type: "function", name: "banana_reply", description: "Answer or decline a guidance request addressed to this agent.", inputSchema: object({
    request_id: string, status: { type: "string", enum: ["answered", "declined"] }, guidance: string, details
  }, ["request_id", "status"]) },
  { type: "function", name: "banana_request_host", description: "Request advertised Desktop Computer Use and close this turn into a wait.", inputSchema: object({
    capability: { type: "string", enum: ["computer_use"] }, task: string, context: details, expected_evidence: details
  }, ["capability", "task"]) },
  { type: "function", name: "banana_wait", description: "Wait for any selected direct child or an ordinary message.", inputSchema: object({
    children: { type: "array", items: string, uniqueItems: true }, messages: { type: "boolean" }
  }, []) },
  { type: "function", name: "banana_review", description: "Accept or revise a direct child's current submission.", inputSchema: object({
    child_id: string, decision: { type: "string", enum: ["accept", "revise"] },
    feedback: object({ summary: string, details }, ["summary"])
  }, ["child_id", "decision"]) },
  { type: "function", name: "banana_cancel", description: "Cancel a descendant subtree owned by this agent.", inputSchema: object({ agent_id: string }, ["agent_id"]) },
  { type: "function", name: "banana_finish", description: "Submit a result to the parent, or finish the root, after all obligations settle.", inputSchema: object({
    result: object({ outcome: { type: "string", enum: ["success", "partial", "blocked", "unsuccessful"] }, summary: string, details }, ["outcome", "summary"])
  }, ["result"]) }
];

export const HOST_TOOL_NAMES = [
  "banana_workflow_start", "banana_workflow_poll", "banana_agent_inspect", "banana_workflow_list",
  "banana_workflow_send", "banana_workflow_control", "banana_approval_respond", "banana_host_respond"
] as const;
