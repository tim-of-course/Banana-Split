---
name: banana-split
description: Use Banana Split by default whenever a task calls for subagents, multiple agents, parallel workers, delegated workers, or supervised agent coordination. Use native Codex subagents only when the user explicitly requests native or standard subagents. Provides durable independent Codex contexts, bounded active-turn scheduling, recursive parent-child and peer coordination, shared configuration, parent-reviewed results, and host-mediated Computer Use.
---

# Banana Split host loop

Keep the main task as the cockpit. Managed agents run in independent Codex threads.

1. Write a standalone root `task` containing the objective and any conversational context it needs. The root starts fresh rather than inheriting this conversation.
2. Advertise only host capabilities currently callable here. Pass `host_capabilities: {computer_use: true}` when Computer Use is available; otherwise omit it.
3. Start the workflow in the exact workspace. Omit `root_preset` to use the configured default; pass a preset name only when the user requests that configured preset. Pass only permission restrictions that preserve or narrow access.
4. Poll until the workflow is mechanically terminal, preserving the returned cursor between calls.
5. Resolve each attention item before continuing:
   - For a Codex approval, present its summary and bounded request facts. After an explicit user decision, relay it with `banana_approval_respond`. For permission, user-input, and MCP elicitation requests, copy the response shape required by `request.response_contract` into `details.response`.
   - For `host_action_required`, inspect the bounded task and evidence request, then call `banana_host_respond(status: in_progress)` before acting. Perform or decline it under this task's permissions and record `completed`, `declined`, or `failed` with evidence. An `uncertain` action stays unresolved until explicitly handled.
   - A host message to an agent waiting with `no_disposition` creates one continuation. Send only new material context or an explicit resume.
   - Inspect failures, submissions, and deep agents without resuming them.
6. Apply a user-requested spawn freeze, reopening, subtree cancellation, or workflow cancellation with `banana_workflow_control`. Report cancellation without implying rollback.
7. Finish only after the workflow is terminal. Report these separately:
   - mechanical workflow status;
   - root result outcome and summary, if present;
   - workflow ID, root agent ID, and any child IDs needed for later inspection.

If startup returns `runtime_unavailable`, report the configured path and startup error. Leave uncertain turns untouched and keep native subagents unavailable.
