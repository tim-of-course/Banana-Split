---
name: banana-split
description: Use Banana Split by default whenever a task calls for subagents, multiple agents, parallel workers, delegated workers, or supervised agent coordination. Use native Codex subagents only when the user explicitly requests native or standard subagents. Provides durable independent Codex contexts, bounded active-turn scheduling, recursive parent-child and peer coordination, shared configuration, parent-reviewed results, and host-mediated Computer Use.
---

# Banana Split host loop

Use the Banana host tools from this plugin. Keep the main task as the cockpit; managed agents are independent App Server threads.

1. Turn the user's objective and any necessary conversational references into a standalone root `task`. Do not claim the root inherits this host conversation.
2. Determine host capability availability from tools actually callable in this host task. Pass `host_capabilities: {computer_use: true}` only when Computer Use is currently available. If the host reports nothing, omit the field and advertise nothing.
3. Call `banana_workflow_start` with the exact workspace and any user-requested preset or narrower permissions. Do not broaden startup permissions.
4. Poll with `banana_workflow_poll`. Preserve and pass the returned cursor so events are not repeated. Continue until the workflow is mechanically terminal unless the user asks to stop.
5. Present attention items promptly:
   - Relay Codex approvals only after an explicit user decision through `banana_approval_respond`. Present the approval attention item's summary and bounded request facts. For permissions, user-input, and MCP elicitation requests, construct `details.response` exactly as described by `request.response_contract`; do not infer or auto-approve an answer.
   - For `host_action_required`, inspect the bounded task and evidence request. Call `banana_host_respond(status: in_progress)` before acting. Perform or decline the action under this host task's current permissions, then record `completed`, `declined`, or `failed` with evidence. Never replay an `uncertain` action automatically.
   - A host message to an agent waiting with `no_disposition` creates exactly one continuation. Use `banana_workflow_send` only when new material context or an explicit resume is warranted.
   - Inspect failures, submissions, or deep agents with `banana_agent_inspect`; inspection never resumes a thread.
6. Use `banana_workflow_control` for a user-requested spawn freeze, subtree cancellation, or workflow cancellation. Do not imply cancellation rolls back side effects.
7. At termination, report the mechanical workflow status separately from the root result's model-judged outcome. Preserve workflow and agent IDs for later inspection.

If a tool returns `runtime_unavailable`, report the configured path and startup error. Do not invent state, retry an uncertain turn, or fall back to native subagents.
