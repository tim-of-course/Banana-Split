# BlackBox standalone Banana Split verification

Tested September 6, 2026 in `/Volumes/OS/Development/Banana-Test-Project` using installed Banana Split `1.0.0+codex.20260906051805`.

## Verdict

Core coordination passed, but the natural implementation workflow did not complete successfully. Both delegated results were accepted and the code passed focused tests. The host then used `cancel` to dismiss a redundant command approval, interrupting the coordinator and leaving the workflow `failed`. This exposed a standalone approval-contract and cancellation-state problem; Sunlight was absent.

That initial run did not support claiming an entirely clean end-to-end result. The runtime fix and follow-up checks below supersede the earlier wording-only recommendation.

## Runtime correction

Installed follow-up build: `1.0.0+codex.20260906230958`.

A live protocol probe established that `decline` works even when the App Server command request omits it from `availableDecisions`. In `wf_4dbf43a0-a6af-410c-8dd4-905698058881`, the escalated Mix command was declined and the Luna-high root completed successfully on the same turn. The previous decision to avoid testing decline merely because it was not advertised was mistaken.

The runtime now exposes `decline` alongside the supplied command choices and describes its effect: reject only the operation and let the agent continue. For command/file `cancel`, it records cancellation intent, cancels nonterminal descendants, and waits for active leases to settle. App Server interrupts the requesting turn; Banana interrupts only active descendants. Responses retain the exact relayed response, timestamp, and host details, visible through agent inspection. Host details remain audit records rather than agent context.

The 50-test suite passes, including command/file denial continuation, root cancellation with active descendants and accepted results, and parent continuation after a child's approval is cancelled. Build, plugin validation, and diff checks pass.

The live cancellation probe `wf_7d1af8fd-8b6b-4fac-ae2b-694ad56175b1` ended `cancelled`, with no agent-failure event. Its root was `agt_d6915791-4918-486f-ad46-fbdfc2333090`, Luna high, with no children. The cancellation response reported the still-settling lease before polling confirmed terminal cancellation.

The follow-up verification workflow `wf_514112d9-15e1-4ffc-bc61-17fd912917d9` completed mechanically, with a model-judged `partial` root result because its own redundant test was intentionally denied. A fresh Luna-high CLI host (`01a078fd-4594-7201-baa8-1b519e520c25`) ran the focused tests successfully, discovered Banana Split, started a Luna-high coordinator (`agt_e631c328-306c-4eea-8bc8-9096285ee07f`) in the cheap tier, and relayed `decline` without intervention. One Luna-low review child (`agt_ebe40331-c7a0-43b7-bce2-f9ab5a99a278`) found no issues and was accepted. The coordinator continued on the same turn after denial and did not retry the command.

This verification had one recovered malformed spawn call: the coordinator supplied unsupported permission field names, read the error, and corrected its request. It accepted the child without optional feedback despite the test prompt asking for notes. Feedback retention had already passed in the initial lifecycle test; this follow-up did not exercise it. All three managed turns had readable names and zero further Banana calls after a successful closing call. The clone still has only the two pre-existing formatter/test edits.

Across this follow-up investigation there were four Luna-high managed roots, one Luna-low child, and the separate Luna-high CLI host. The first root (`wf_1992af02-37a1-41cd-a2ba-f1208b457913`) used the wrong host-capability request instead of a native command approval and ended `partial`; it provided no denial evidence. A rejected workflow-start attempt allocated no agent before the scratch tier catalog was aligned with the newly built default preset name. Neither issue was counted as a passed approval check.

## Environment and task

The clone had no Git remotes, no Sunlight project setup, and a clean worktree before testing. Elixir 1.19.5 and Erlang/OTP 29 were available. `mix deps.get` installed the locked dependencies without changing `mix.lock`.

A fresh **gpt-5.6-luna / high** host received an ordinary request to improve connection-error messages, delegate implementation and independent review, and select the workflow-local cheap tier. The prompt did not name Banana Split. The host discovered its skill and used the exact shared filesystem throughout.

The implementation changed only `lib/blackbox/error_formatter.ex` and `test/blackbox/error_formatter_test.exs`. It added readable timeout/refusal messages without a destination, handled missing reasons without empty placeholders, and retained nested connection-error context. No commits, publishing, deployment, or remote changes occurred.

## Checks

| Check | Result |
| --- | --- |
| Banana Split unit suite | 47 passed, 0 failed |
| Untouched BlackBox full suite | 271 tests, 7 failures |
| Final focused formatter tests | 5 passed, 0 failed |
| Focused formatting and diff checks | Passed |
| Final BlackBox full suite | 274 tests, 5 failures |
| New full-suite failure names | None; all five also failed in the baseline |
| Readable managed names | Present on all seven managed threads |
| Calls after a successful closing call | Zero across thirteen own managed turns |
| JSON result parsing failures | None observed |
| Feedback retention | Four acceptances and one revision retained feedback |

The two baseline planning-channel timeout tests passed on the final run. This is not evidence that the formatter change fixed them. Remaining failures concern CLI doctor status, three planning API context-refresh tests, and rewind-message state.

The host initially found one incorrect new assertion about nested atom formatting, corrected the expected existing `:closed` representation, and reran the focused checks successfully. Managed agents could not run Mix inside their ordinary sandbox because Mix.PubSub needed a local TCP socket; host execution supplied the test evidence.

## Live workflows

| Purpose | Workflow | Root agent | Mechanical status / root outcome |
| --- | --- | --- | --- |
| Fresh/inherited lifecycle and revision | `wf_1bec8d49-555a-4005-9a12-41e49bbb4322` | `agt_38d070a8-466b-4be7-ab8b-91f538863487` | completed / success |
| Ordinary implementation and review | `wf_e06b9efc-c804-41d4-8317-4b2ff5b7f174` | `agt_218471aa-0d3f-433a-a8a7-d6a316343bbf` | failed / no committed root result |
| Controlled approval continuation | `wf_a738b1f4-3d61-4d52-9239-cc0f6bee2fa7` | `agt_aa50e6a3-31fd-4f0a-9399-d54129fb7b2a` | completed / partial |

The lifecycle probe used a Luna-high root and two Luna-high children, one fresh and one inherited. The fresh child revised and resubmitted on the same thread; both children were accepted with notes. The parent and inherited child each initially sent a malformed finish request with `outcome` and `summary` at the top level instead of inside `result`. Both requests were rejected before closing, and both agents corrected them without intervention.

The natural workflow used a Luna-high coordinator and two Luna-medium inherited children. The implementation child and independent reviewer inspected the same physical files and were both accepted. It had no failed Banana dynamic-tool calls or repeated closing calls. Its failure came later during command approval.

Across the initial three workflows: **four distinct children and three roots**, with five managed agents using Luna high and two using Luna medium. The ordinary host was separately Luna high. There was one intentional revision cycle, two command approvals, and one failed coordinator. Accepted child results survived that failure. All workflows are terminal and no approvals remain pending.

## Approval failure and controlled check

The coordinator requested permission to run the focused formatter/tests outside the sandbox. The host had already run equivalent checks, so it called `banana_approval_respond` with `decision: "cancel"` and put its successful test evidence in `details.reason`.

For command approvals, Banana Split relays only `{decision}`. App Server received `cancel`, interrupted the turn, and Banana Split recorded `containing_turn_not_completed`. The evidence in `details.reason` was not delivered as a message to the coordinator. There is no evidence of a spontaneous scheduler interruption.

The [App Server documentation](https://learn.chatgpt.com/docs/app-server#approvals) distinguishes command-approval decision values. The actual escalation request in this test advertised `accept`, an accept-with-policy-amendment option, and `cancel`; it did **not** advertise `decline`.

A controlled follow-up initially aimed to test declining just the command. Since decline was not advertised, the supervising test runner instead accepted the already-authorized focused check. It ran successfully, and the agent completed its turn normally. Its root outcome was honestly `partial` because the requested decline scenario had not occurred. This verifies the supported accept path, not an unadvertised decline path.

The initial report recommended approval wording changes only. That recommendation was too narrow and is superseded by the runtime correction above. The original three-workflow test itself made no runtime changes.

## Evidence

- Ordinary host thread: `01a076f7-026f-7c42-8ceb-c7d8b6c81614`.
- Implementation child: `agt_d3c1fe1d-4c60-4a98-8333-250665a4b74f`.
- Review child: `agt_86692b0f-1d50-4cbd-adea-89f011485a01`.
- Cancelled approval: `apr_e4e142fb-f667-4f76-a0cc-5d22162dc998`.
- Accepted controlled approval: `apr_56d10c40-bb1d-4896-bd8e-7a4ad3a0b6a6`.
- Local prompts, tier catalog, host JSONL, baseline/final test logs, thread reads, and computed checks: `.banana-test/blackbox-verification/`.
- Runtime-correction prompts, fresh host JSONL, focused live audit, and thread reads: `.banana-test/approval-fix/`.
- Durable workflow records: `~/Library/Application Support/BananaSplit/state-{a,b}.json`.

Inherited history was excluded from own-turn counts using each agent's routing history. The supervising runner sent no corrective messages to the ordinary host or its agents. Host-run tests and the explicit controlled approval decision are recorded separately from that absence of intervention.
