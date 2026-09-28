# TasGrid natural discovery test

Observed September 5, 2026 (America/Chicago). Host task: `01a07409-1467-7a21-82b2-5612d882aa01`. Workflow: `wf_374a1b44-29fd-4ca1-b540-9d756693988e`. Workspace: `/Users/tim/.codex/worktrees/e1bf/TasGrid`.

## Result

Discovery and completion passed. The Luna high host received a task-management improvement request containing “use subagents” without naming Banana Split. Its first commentary selected the Banana Split skill. It created a managed coordinator, which spawned three inherited-context subagents. All three submissions were accepted and the root finished successfully at 00:15:53 UTC. The host finished at 00:16:45 UTC, after polling the terminal workflow.

The host ran about 11 minutes. Banana Split recorded 26 managed turns across four agents. There were no agent failures, cancellations, or unresolved approvals at completion. The reviewer went through two revision cycles, including catching a keyboard-event regression that the coordinator fixed.

| Responsibility | Model | Reasoning |
|---|---|---|
| Host | gpt-5.6-luna | high |
| Root coordinator | gpt-5.6-sol | high |
| UI/accessibility subagent | gpt-5.6-sol | high |
| Filtering/sorting subagent | gpt-5.6-sol | high |
| Review subagent | gpt-5.6-sol | medium |

There were three distinct subagents plus one root coordinator. Resumes and review revisions did not create additional agents. The host's Luna setting did not propagate to the managed coordinator; it correctly used the then-configured Sol high default. This run preceded preset tiers.

## Issues observed

1. **Agents close turns too early, then continue issuing tools.** The coordinator called `banana_wait(messages: true)` after its first repository read at 00:06:26 UTC, then continued reading and attempted three spawns in the same turn. Those orchestration calls returned `turn_closing`. Similar errors occurred in each worker's record. The runtime enforced its contract, but the agent-facing turn boundary was not understood reliably. The host sent seven successful messages across the coordinator and workers to encourage implementation, review, or completion. This is the main usability problem; it did not become a permanent scheduler deadlock.

2. **Tool return shape caused a failed wait.** At 00:07:44 UTC the coordinator successfully spawned three children through `tools.banana_spawn`, then used `a1.agent_id`, `a2.agent_id`, and `a3.agent_id` in a wait. The returned values were JSON text strings rather than JavaScript objects, leaving those properties undefined. The wait failed with `children must be an array of nonempty strings`. The coordinator recovered by supplying the IDs explicitly. Structured return handling or an explicit parsing example would remove this integration trap.

3. **Review schema permits a combination the runtime rejects.** At 00:11:07 UTC, accepting a child with feedback failed with `feedback is only valid for revise`. The advertised tool schema allows both fields together without describing that condition. The agent then armed a wait and attempted further reviews, which failed with `turn_closing`. Clarifying the feedback condition would prevent an avoidable rejection.

4. **Managed tasks have raw JSON titles and weak project association.** The app listing showed each managed task with its bootstrap JSON as a multi-thousand-character title and `projectId: null`. This makes the tasks hard to identify in the sidebar. The host task also did not appear in the listing used by the monitor, although direct reads and waits by its ID worked. The title issue is visible in Banana's integration; the listing omission's cause is unconfirmed.

## Recovered or unrelated problems

- The host initially omitted one directory when expanding the skill alias. The provided skill catalog path was correct; it found the actual file and recovered without assistance.
- The new worktree had no dependencies. The host installed them and the focused sorting tests then passed 8/8.
- One production build failed while renaming `dist/sw.mjs` to `dist/sw.js`; a rerun passed. The evidence does not establish whether this was concurrent build interference or a PWA tooling issue.
- The host reported 119 smoke tests passing and two existing Cloudflare filter-parity failures outside the edited UI scope. Their pre-existing status was reported by the task, not independently established by this monitor.

## Limits

The monitor sent no hints or follow-up instructions to the host. Progress-summary skill wording was updated while the run was active; the host had already read the prior skill. The later tier feature was added after workflow completion. Runtime restarts after completion added reconnect events, so the workflow's final `updated_at` is not its completion time. This test validates discovery, delegation, review, and terminal reporting; it does not validate crash recovery, Computer Use, or approval handling.

Evidence is in the host's Codex rollout, the four managed-agent rollouts under `~/.codex/sessions/2026/09/05/`, and the retained workflow checkpoints in `~/Library/Application Support/BananaSplit/`.
