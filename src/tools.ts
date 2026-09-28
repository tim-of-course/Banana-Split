import type { JsonObject } from "./model.js";

const object = (properties: JsonObject, required: string[]): JsonObject => ({ type: "object", properties, required, additionalProperties: false });
const details = { type: "object", additionalProperties: true };
const string = { type: "string", minLength: 1 };
const strings = { type: "array", items: string, uniqueItems: true };
const permissions = object({ sandbox: { type: "string", enum: ["readOnly", "workspaceWrite"] }, writable_roots: strings,
  network_access: { type: "boolean" },
  tools: { ...strings, description: "Omit this field to inherit built-in tools. Any explicit list returns app_server_unsupported because the current App Server cannot enforce a built-in tool allowlist. This field does not select Banana tools." },
  mcp_servers: strings }, []);

const CLOSE_TURN = " On success, make your next message the final response for this turn, with no intervening commentary or tool calls. Do not repeat this call. The runtime resumes you in a new turn when needed.";

export const AGENT_TOOL_SPECS: JsonObject[] = [
  { type: "function", name: "banana_spawn", description: "Create one direct managed child agent.", inputSchema: object({
    task: { ...string, description: "Start with a short, specific objective, such as 'Check timeout: empty input', followed by the full assignment and context. The first 96 characters become the visible thread name and task label." },
    context: object({ source: { type: "string", enum: ["fresh", "inherit"], description: "Fresh children receive only the task, details, and brief you supply, without parent history. Include required inputs, the output contract, applicable user restrictions, source paths, and permitted validation commands. Referring to an earlier contract does not supply it. Inherit uses the parent transcript through the completed spawning turn." }, brief: details }, ["source"]),
    preset: string,
    permissions,
    details: { ...details, description: "Optional structured assignment context delivered unchanged to this child alongside task and context.brief." }
  }, ["task", "context"]) },
  { type: "function", name: "banana_send", description: "Send nonblocking information to an eligible agent. Submitted agents cannot receive ordinary messages; review your submitted child's result with banana_review. Accepted results are final and further work needs a new assignment. For guidance needed to continue, use banana_ask: ordinary messages do not wake a recipient waiting only for child results. Use to: 'parent' only when you have a direct parent, or a full/short managed-agent ID. The root reports its result to the host with banana_finish. Messages arriving while a recipient closes into a wait are buffered for its next eligible turn; they do not resolve advice or host dependencies.", inputSchema: object({
    to: string, message: object({ type: string, body: string, details }, ["type"])
  }, ["to", "message"]) },
  { type: "function", name: "banana_ask", description: "Ask one agent for guidance or missing assignment context needed to continue and close this turn. The ask itself establishes the wait for a reply; no additional banana_wait call is needed. The recipient must resolve the request with banana_reply before finishing. For instructions to perform work or submit a result, use banana_send instead. Address by full/short ID or 'parent'." + CLOSE_TURN, inputSchema: object({ to: string, question: string, context: details }, ["to", "question"]) },
  { type: "function", name: "banana_reply", description: "Answer or decline a guidance request addressed to this agent. This leaves your turn open: continue useful work, then close with banana_wait or banana_finish when appropriate. Optional details are delivered under reply_details, alongside the runtime request_id and status.", inputSchema: object({
    request_id: string, status: { type: "string", enum: ["answered", "declined"] }, guidance: string, details
  }, ["request_id", "status"]) },
  { type: "function", name: "banana_request_host", description: "Request advertised Desktop Computer Use needed to continue and close this turn." + CLOSE_TURN, inputSchema: object({
    capability: { type: "string", enum: ["computer_use"] }, task: string, context: details, expected_evidence: details
  }, ["capability", "task"]) },
  { type: "function", name: "banana_wait", description: "Close this turn to wait for any selected direct child or an ordinary message. Send any progress updates before this call. Call only for a real dependency after useful independent work is exhausted. This returns immediately; it does not pause execution." + CLOSE_TURN, inputSchema: object({
    children: { type: "array", items: string, uniqueItems: true }, messages: { type: "boolean" }
  }, []) },
  { type: "function", name: "banana_review", description: "Accept or revise a direct child's current submission. Feedback is optional for accept and required for revise. Acceptance stores feedback and completes the child; that accepted child cannot be revised later. Finish planned review before accepting if it may require revisions; later changes need a new assignment. Revision resumes a submitted child with feedback. If ready work was only sent as a message, ask the child to submit with banana_finish before reviewing.", inputSchema: object({
    child_id: string, decision: { type: "string", enum: ["accept", "revise"] },
    feedback: object({ summary: string, details }, ["summary"])
  }, ["child_id", "decision"]) },
  { type: "function", name: "banana_cancel", description: "Cancel a descendant subtree owned by this agent.", inputSchema: object({ agent_id: string }, ["agent_id"]) },
  { type: "function", name: "banana_finish", description: 'Submit a result to the parent, or finish the root, after all obligations settle. Arguments must wrap the outcome and summary in result: {"result":{"outcome":"success","summary":"What was completed"}}.' + CLOSE_TURN, inputSchema: object({
    result: object({ outcome: { type: "string", enum: ["success", "partial", "blocked", "unsuccessful"] }, summary: string, details }, ["outcome", "summary"])
  }, ["result"]) }
].map((tool) => ({ ...tool, description: tool.description + " Returns a JSON string, never a JavaScript object. Use: const result = JSON.parse(await tools." + tool.name + "(args)); text(result); Read result.ok and other fields only after parsing. Checking .ok on the raw string incorrectly treats success as failure." }));

export const HOST_TOOL_NAMES = [
  "banana_workflow_start", "banana_workflow_set_tier", "banana_workflow_poll", "banana_agent_inspect", "banana_workflow_list",
  "banana_workflow_send", "banana_workflow_control", "banana_approval_respond", "banana_host_respond"
] as const;
