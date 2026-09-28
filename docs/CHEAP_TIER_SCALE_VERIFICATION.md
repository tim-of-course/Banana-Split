# Custom all-Luna scale verification

Tested September 6, 2026 using installed Banana Split `1.0.0+codex.20260906230958` in `/Volumes/OS/Development/Banana-Test-Project`, without Sunlight. No Banana Split runtime code changed during this run.

## Preset diagnosis correction

This was **not a test of the shipped `cost-optimized` tier**. The supervising runner supplied `.banana-test/scale-run-20260906/preset-tiers.json`, a replacement catalog with an all-Luna tier named `cheap`, and instructed the new host to pass it through `banana_workflow_start`. The actual start arguments confirm `tier: cheap`, `root_preset: sol-high`, and that full replacement `preset_tiers` object. The runtime correctly used the supplied workflow catalog; no managed agent bypassed the active presets.

The installed `cost-optimized` tier was Astra medium (`complex-judgment`), Sol medium (`default-judgment`), Terra high (`general-workhorse`), and Luna xhigh (`defined-workhorse`). The test intentionally used a Luna-high host/root and custom Luna worker configurations. The owner subsequently confirmed that this override was acceptable for testing; the question was whether preset resolution worked. The installed global catalog was not changed by these workflow overrides.

The measured scheduling and message-delivery results remain evidence from this custom configuration. Conclusions about normal model behavior, task judgment, efficiency, and the shipped tier require another run using `tier: cost-optimized` with no catalog override. A Luna-high external host can run that workflow while the managed root uses the configured `default-judgment` preset. The custom catalog and original prompt remain unchanged as historical evidence.

## Verdict

The scheduler and lifecycle bookkeeping handled 11 delegated agents across two levels, with 10 simultaneous active turns. All agents settled, approvals were resolved or invalidated, and the runtime recorded no agent failures or further Banana calls after a successful closing call. The workflow completed with a model-judged `success` result and one small BlackBox fix.

The run was not clean. Seven messages were rejected during recipients' closing turns; five waits named siblings or a parent instead of direct children; a worker sent implementation evidence as an ordinary message without submitting a result, and its parent cancelled it to finish. There were also 27 immediate requeues; a subsequent mailbox audit confirmed that all 27 had newly deliverable messages, so this is not evidence of a wait-loop defect. This supports more confidence in supervised operation, while exposing concrete coordination problems to address before calling the workflow smooth or autonomous.

## Scale and measured results

| Measure | Observed |
| --- | --- |
| Fresh CLI host | `gpt-5.6-luna`, high |
| Managed root | `gpt-5.6-luna`, high |
| Delegated agents | 11: six Luna medium, five Luna low |
| Delegation depth below root | 2 |
| Context mode | Fresh root; all 11 children inherited |
| Managed turns | 55 |
| Peak active turns | 10 of configured 16 |
| Managed workflow elapsed | 523.4 seconds; excludes baseline setup |
| Terminal agents | 9 completed including root, 3 cancelled, 0 failed |
| Banana dynamic-tool calls | 163, including 14 rejected calls |
| Code-mode syntax errors | 2, recovered; no JSON-result parsing failure found in inspected outputs |
| Calls after successful close | 0 subsequent Banana orchestration calls |
| Readable names | Present on all 12 managed threads |
| Accepted child submissions | 8; six retained acceptance feedback, two omitted optional feedback |
| Formal revise cycles | 0 |
| Native command approvals | 3 accepted; 1 invalidated when its requester was cancelled |
| Advice protocol | Not exercised; agents used ordinary messages |
| Remaining active agents / pending approvals | 0 / 0 |

The host's own final recap undercounted the invalid waits as one and omitted the seven rejected messages. Counts here come from each agent's own routing-history turns, excluding inherited transcript history.

## Findings and next fixes

### Closing recipients reject useful messages

All seven failed `banana_send` calls returned `recipient_unavailable` while the recipient's public state was `active`. The send implementation in `src/agent-actions.ts` rejects a recipient when `turn_closing` is set, including when it is closing into a wait. Rejected content included child IDs, review findings, requests for final evidence, and a final track summary. These were explicit rejections, not silent delivery acknowledgments.

First fix to investigate: queue messages for the next turn when a live recipient is closing into a wait or advice dependency. Keep the caller's prohibition on further orchestration after closing. Preserve an explicit unavailable outcome for terminal recipients and decide finish/submission behavior separately. This is a runtime delivery change, not merely skill wording.

### Invalid waits and legitimate message wakes

Five waits incorrectly selected a sibling or parent, and the runtime correctly rejected them. Workers recovered by changing their wait behavior, although three workers were later cancelled. The existing tool already says direct children; an error that returns the caller's eligible child IDs and the message-wait option would make recovery more concrete.

There were 27 `wait dependency already satisfied` requeues out of 55 dispatches. A follow-up audit correlated each requeue with the next turn and the durable mailbox: all 27 had messages already queued at requeue time and assigned to that next turn. Only three also had a selected child in a ready state. These were legitimate message wakes, not evidence of repeated waking on stale results. Preserve current scheduling semantics. Better wake-reason reporting would make this distinction visible without a transcript-level audit. Evidence is in `wake-evidence.json`, generated by `check-wakes.ts`.

One inherited implementation child also sent a status request to itself, phrased as if it were supervising that implementation child. This is evidence of role confusion in that turn, not proof of a routing defect. Rejecting accidental self-addressed coordination and testing fresh versus inherited worker context are small, concrete follow-ups.

### Completion handoff falls back to cancellation

The runtime-config implementation child `bec68487` changed two files and sent exact before/after evidence in a message, but never produced a formal submission. Its parent attempted acceptance and received `invalid_state: Child has no current submission`. A subsequent finish was blocked by that unfinished child. The parent then cancelled the child and submitted its own track result.

The parent described cancellation as required, but the runtime did not require that specific resolution. Requesting a formal child submission was another path. Investigate an explicit request-submission operation or an actionable recovery response from review/finish, so the normal way to obtain a final result is easier than abandoning the child record. Do not automatically treat an arbitrary message as an accepted submission.

The CLI implementation was cancelled while its authorized reproduction command was waiting for approval. That request remained pending for roughly 84 seconds, then was invalidated. The host spent that interval inspecting agents. Approval handling should take priority over broad transcript inspection. The CLI reviewer was also cancelled. Consequently, this run does not establish that the CLI candidates were disproved; their actual reproductions were unfinished.

During progress reporting the host repeatedly said no files had changed, although the runtime-config edits existed. Its final report corrected this after inspecting the actual diff. Source state and cancelled-agent side effects must remain part of final review.

## Code outcome and checks

Only `config/runtime.exs` and `test/blackbox/runtime_config_test.exs` changed during this run. Non-positive values for model timeout, model max tokens, Tavily max results, and Tavily timeout now fall back to the existing positive defaults. Evidence followed the actual `Config.Reader` to `Application.put_env` to `ModelConfig.resolve_provider_config` path. The added test covers the four non-positive values.

The coordinator ran the checks serially through accepted native approvals:

- `mix test test/blackbox/runtime_config_test.exs`: 5 tests, 0 failures.
- `mix test test/blackbox/validation_test.exs`: 7 tests, 0 failures.
- Formatting check for the changed files: passed.
- `git diff --check`: passed.

The previous formatter source/test hashes are unchanged. The clone still has no remote. No commits, publication, deployment, or Sunlight actions occurred.

## Test setup and limitations

The supervising runner initially made a fresh full-suite baseline a prerequisite. That was too broad for this coordination test. The seed-0 baseline was stopped after 992.7 seconds of repeated unrelated nested-Mix timeouts. It printed a partial summary of 146 tests and 18 failures during shutdown; it was not a completed 274-test run. The new host remained alive while waiting and did not require a resumed host turn.

After the process exited, the supervising runner provided the completion marker with `status: stopped_incomplete`, then sent one explicit scope correction to the managed root: use relevant test groups and report the incomplete full-suite comparison. The host separately sent one nudge while inherited children were awaiting the root's planning-turn boundary. That pending-context state is expected; the nudge is not proof of a scheduler stall. Both interventions are recorded, so this is not an unassisted run.

The earlier completed suite had 274 tests and 5 failures under a different seed. It cannot establish that this run introduced no new full-suite failures. No full seed-0 suite was repeated after the scope correction. This test did not saturate the 16-slot limit, restart the runtime, exercise fresh child threads, or exercise correlated advice and formal code revision.

## IDs and evidence

- Host thread: `01a07907-2256-7331-b80f-464db05d600e`.
- Workflow: `wf_b1bcd68b-193e-4a7e-b68a-077eb3b9e41b`.
- Root: `agt_2adeebfd-4d87-412c-9687-ae9f12e0ac03`.
- Scratch evidence: `.banana-test/scale-run-20260906/`, including host prompt/JSONL/final response, baseline log and incomplete marker, before/after file evidence, thread reads, `audit.json`, `metrics.json`, and `script-errors.json`.
- Durable workflow records: `~/Library/Application Support/BananaSplit/state-{a,b}.json`.

All agents below used `gpt-5.6-luna` on the logical cheap tier. Root is listed separately from its eleven descendants.

| Agent | Parent | Reasoning | Own turns | Final state |
| --- | --- | --- | --- | --- |
| `2adeebfd` | root | high | 13 | completed |
| `f491ce53` | 2adeebfd | medium | 9 | completed |
| `50091d21` | 2adeebfd | medium | 10 | completed |
| `3d1489d6` | 2adeebfd | medium | 8 | completed |
| `6011cb1d` | 2adeebfd | low | 1 | completed |
| `704048be` | 2adeebfd | low | 1 | completed |
| `bc00f72b` | f491ce53 | medium | 2 | cancelled |
| `7b333900` | f491ce53 | low | 2 | cancelled |
| `bec68487` | 50091d21 | medium | 3 | cancelled |
| `29ce524b` | 50091d21 | low | 1 | completed |
| `c805446b` | 3d1489d6 | medium | 3 | completed |
| `63af92ef` | 3d1489d6 | low | 2 | completed |
