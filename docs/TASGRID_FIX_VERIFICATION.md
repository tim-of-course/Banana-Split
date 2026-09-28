# TasGrid tool-contract verification

Verified September 6, 2026 in `/Volumes/OS/Development/Sunlight Test repos/TasGrid`.

## Result

All four fixes are implemented. The final installed macOS plugin is `1.0.0+codex.20260906051805`. The latest natural-discovery run completed with readable names, parsed results, three acceptances with retained feedback, and no further tool calls after a successful closing call. It was not error-free: the coordinator copied a child ID incorrectly in two unsuccessful wait requests, then recovered.

The first implementation run exposed another instance of checking `.ok` on an unparsed success string. That caused one repeated `banana_finish`, which the existing guard rejected. The final wording explicitly explains this false-failure trap and supplies a parsing example for each tool, including finish. The subsequent independent reviewer and natural-discovery workflow had no repeated closing calls.

## Changes and local checks

- All four closing tools explain that success ends the response immediately. Closing responses and the existing guard return an explicit end-response instruction. The scheduler still commits only on successful turn completion.
- Managed dynamic tools document their JSON-string return and parsing examples. Host MCP `structuredContent` remains a separate transport. The installed App Server's generated `DynamicToolCallResponse` contains only `contentItems` and `success`.
- Acceptance validates optional feedback and stores it with submission history without resuming the child. Revision still requires feedback and resumes the same child thread.
- Root, fresh-child, and inherited-child threads receive names through `thread/name/set` before dispatch: workspace basename, bounded task label, and short agent ID.

`bun test`: **47 passed, 0 failed**, including the dynamic-tool JSON spawn/wait sequence, a one-slot scheduler releasing capacity and resuming on submission, fresh/inherited names, and acceptance feedback surviving reload. `bun run check`, the native macOS build, plugin validation, and `git diff --check` passed. No retries, watchdogs, or new scheduling gates were added.

## Live runs

Both ordinary host threads used **gpt-5.6-luna, high**. Neither prompt named Banana Split; both requested subagents and the cheap tier. Both discovered the skill. The supplied workflow-local catalog defined cheap as Luna with high, medium, low, and xhigh presets; the shipped global tier definitions were not changed.

| Run | Workflow | Managed agents | Mechanical status / root outcome |
| --- | --- | --- | --- |
| Read-only contract probe | `wf_a3a05c02-e5ac-47c9-b345-0bf26722c52f` | High root plus two high children, one fresh and one inherited | completed / success |
| Initial empty-state advice | `wf_71fd8095-2d31-4476-80c5-de16615f8dde` | One low root, no children | completed / success |
| Empty-state follow-up review | `wf_8f01ef0e-fc3c-49d2-9b60-dce36bb95738` | One low root, no children | completed / unsuccessful |
| Fresh accessibility discovery retest | `wf_24d2ea86-d330-45f0-a205-98264d0cbc47` | High root plus three low children | completed / success |

The probe exercised actual JavaScript `JSON.parse` calls through App Server, two waits, and two acceptances with feedback. Its five managed turns had zero tool failures and zero calls after closing.

The fresh retest reviewed TaskSearchPopover and FilterBar. Its five managed turns included three successful spawns, one successful wait, three acceptances with feedback, and four finishes. The two invalid waits were rejected before any closing disposition was armed. There were zero parsing failures and zero calls after successful closing. All three children completed after acceptance.

Across the runs: **five distinct children and four roots**, with four agents using Luna high and five using Luna low, over twelve managed turns. There were no agent failures, cancellations, review revision cycles, or unresolved approvals. The two ordinary hosts each attempted one late message to an already-completed coordinator; both were rejected, so successful host interventions were zero. The supervising test runner sent no hints or follow-ups to either host.

## TasGrid result and limits

The first host authored the empty-state distinction and native Clear filters button in Sunlight's canonical view, checkpoint `checkpoint_83f180628888a587_085f5f15fd4e`, topic revision `rev_tasks_empty_filter_state_0001`. Its `bun run build` exited 0, including application TypeScript, worker TypeScript, Vite, and service-worker generation. This change was not exported into the ordinary filesystem. The follow-up reviewer therefore reported an unsuccessful result after reading the old filesystem version. This is a Sunlight handoff limitation in this test, not a scheduler or result-parsing failure. No site was published or deployed.

All nine managed threads had explicit names; their `projectId` remained null. In this run, default `thread/list` included the managed `vscode`-source threads but omitted the CLI host's `exec` source. Explicitly including `exec` returned the host. This establishes the listing behavior for this run, not the cause of the earlier Desktop-host omission, and does not establish project association.

These runs establish observed behavior, not a guarantee against future model mistakes. The original run used Sol managed agents, so its timing and intervention count are not a controlled performance comparison with this cheap-tier test.

## Evidence

- Implementation host: `01a07523-802b-7b60-b758-323fbccea8d1`.
- Fresh retest host: `01a07527-9cd7-7c82-82fe-5805d3fdf982`.
- Probe root: `agt_fa35da2e-9a92-489b-bed5-e9ce0123f67c`.
- Fresh retest root: `agt_788fe289-5562-42d0-b13b-6870a7af9435`.
- Fresh retest children: `agt_9c9e1289-cba6-4a68-b3f9-f459e2f511a3`, `agt_29e28687-ebbb-4411-bd9a-a083ad4862ba`, `agt_cd339b6d-dee1-409c-ae25-b90f87b5aa6a`.
- Local captured prompts, catalogs, host JSONL events, thread reads, final responses, and listing comparison: `.banana-test/tasgrid-fixes/`.
- Durable workflow records: `~/Library/Application Support/BananaSplit/state-{a,b}.json`; Codex rollouts: `~/.codex/sessions/2026/09/06/`.

Inherited history was excluded from each agent's own turn and tool-call counts using its recorded routing history.
