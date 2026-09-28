# Coordination fixes and installed verification

## Changes

1. Agent and host ordinary messages now use one eligibility rule. A recipient closing into wait, advice, or a host request buffers messages for its next eligible turn. Ordinary messages do not resolve advice/host dependencies. Closing into finish, submitted/terminal states, and pending cancellation still reject sends. The caller's post-close orchestration guard remains intact.
2. Missing-submission review errors and blocked finish errors expose child state, wait, pending approvals, and a recovery action. A parent can request formal submission from a ready worker using existing send/finish tools. No new lifecycle operation or automatic promotion of status messages was added.
3. Poll snapshots prioritize pending approvals with an explicit next action. Inherited children expose the spawning parent turn they await. The host skill resolves approvals before bulk inspection and checks actual files/tests before reporting success.
4. Managed spawn and host root-permission schemas list the supported fields. Tool descriptions expose the existing `parent` alias. Invalid child waits return eligible direct-child IDs and the message-wait alternative.
5. Managed tool failures produce bounded `tool_rejected` events without argument/error payloads. Poll, inspect, and final snapshots count recorded rejections by tool/code, revisions, acceptances, and advice resolutions. Queue reasons distinguish ready children from buffered messages. Workflow catalog source identifies configured routing versus a host override. Historical failures from older runtime versions are not backfilled.

No automatic retries, watchdogs, role policy, or extra approval gate was added. The 27 immediate wakes in the preceding scale run were legitimate and remain supported.

## Local verification

- `bun test`: 55 passed, 0 failed (306 assertions).
- `bun run check`: passed.
- Native macOS build, plugin validation, skill validation, and `git diff --check`: passed.
- New regressions cover ordinary messages during wait/advice/host closure, next-turn delivery and coalescing, rejection during finish/terminal states, and ready-worker recovery into an accepted submission without cancellation. Existing tests cover turn-closing caller guards and same-thread revisions.
- Larger live run version: `1.0.0+codex.20260907044756`.
- Follow-up installed version: `1.0.0+codex.20260907045827`, adding tool-allowlist limitations to schema descriptions and explicit handling of conflicts between agent summaries and runtime counts. Build and plugin/skill validation passed again.

## Live verification

Fresh external host: `01a07a32-fe20-7611-992b-daabd360d05c` (Luna high).
Workspace: `/Volumes/OS/Development/Banana-Test-Project`, with no Git remote and no Sunlight use.
Catalog: intentional workflow-local `cheap` override, all Luna; the shipped cost-optimized catalog is unchanged.

The live run audits the existing runtime-config and error-formatter fixes and writes report artifacts only. Its prompt asks for one intentional missing-submission review rejection, a correlated advice exchange, one same-thread revision for additional evidence, and a single aggregate focused test command. Raw artifacts are under `.banana-test/five-fixes-run/`.

### Larger run results

Workflow: `wf_d90bea64-ac12-4b7e-8a82-aa79f053d938`.
Root: `agt_ac126d0b-f42f-4272-94a2-efedc3a550dd`.
Mechanical status: **completed**. Root audit judgment: **partial**, acknowledging coverage gaps and a missing assigned report artifact.

- Eight managed agents: root Luna high, four Luna medium, three Luna low. Seven descendants across two levels; four descendants fresh and three inherited.
- 26 managed turns, 58 Banana tool calls, peak six active turns of the configured sixteen.
- All eight agents completed. Seven child submissions accepted with feedback. No cancellations, failed agents, pending approvals, or outstanding leases.
- One correlated advice request answered. **Zero formal revisions**, despite the root and external host claiming one. The claimed revision was an ordinary message exchange; the authoritative diagnostics and submission history agree on zero. A focused follow-up below covers the missing formal path.
- Six recorded rejections, exactly matching the transcript audit: one intentional `banana_review:invalid_state` probe; one unsupported tool-allowlist spawn; two sends to submitted recipients; one send to an unknown ID; one malformed finish with fields outside `result`.
- No tool calls after a successful closing disposition. Transcript items after closure were reasoning and agent messages only.
- One native Mix command approval, accepted after 13.448 seconds. The authorized aggregate passed **17 tests, 0 failures**, seed 912260. An extra formatter-only attempt failed during socket setup before assertions; it provided no additional test coverage.
- Protected-file SHA-256 values and the complete tracked Git diff exactly match the pre-run snapshot. Six report/evidence files were created under `.banana-validation-run/`.

### Direct checks of the fixes

The waiting investigator sent ordinary ready evidence, then waited for messages. Its parent made the one intentional early accept attempt. The returned error named the waiting state and instructed the parent to request `banana_finish`. The parent used that recovery, obtained a formal submission from the same child, and accepted it with feedback. Cancellation was unnecessary.

A supervising probe sent independently computed protected-file hashes while the root was closing into a message wait. After an initial observation window missed the timing, a second window caught it. Message `msg_e07af0a2-a6d7-489a-9b41-add89e4b7506` arrived at 04:55:22.371 UTC while turn `01a07a38-64d2-7ea0-ae2b-bbcca532f492` was closing. That turn released its lease at 04:55:25.057; the message was assigned to the next turn, `01a07a38-9a9c-70e3-8818-84786c83a5dd`, with a single `buffered message` continuation. This was a deliberate verification message, not a convergence intervention.

Runtime rejection counts matched all six failed calls. The two unavailable recipients were already submitted, so neither was the former closing-wait rejection bug. The approval was resolved before bulk inspection. Inherited children received readable names and explicit parent-turn dependencies.

### Remaining findings

The runtime now exposes factual counts, but models can still contradict them. Both the root and external host reported a formal revision that never occurred. The root also accepted a reviewer result whose assigned artifact was absent, though it later disclosed that gap. The error-formatter branch report retained its earlier blocked-test claim after the aggregate test passed; the integrated report reconciled the aggregate result separately.

These are observed review/reporting weaknesses in this custom all-Luna run. This verification supports supervised internal use and does not establish reliable unattended judgment. The first run's original reports and transcripts are retained as evidence rather than rewritten to conceal the discrepancies.

### Focused formal revision follow-up

A fresh Luna-high external host was launched against the second installed version, using one Luna-low child. Its task explicitly requires a first formal submission, `banana_review(decision: revise)` requesting four file hashes, a second submission on the same thread, and acceptance with feedback.

The first host startup failed at the required Banana MCP handshake after the manually initiated runtime restart. No workflow was created. A ready-runtime ping succeeded and a fresh host retry started successfully. The failed startup log is retained; this does not establish its precise cause and no retry mechanism was added.

External host: `01a07a3d-5fa0-76c2-ab07-c0ee1c865f7a` (Luna high).
Workflow: `wf_fcdec6d6-c7a7-471e-8ccf-23b63bf892cd`.
Root: `agt_8608d13f-fa8b-4a21-877e-979d9707cc11` (Luna high).
Child: `agt_49904881-84ac-4aea-a45b-a8fe1eadedee` (Luna low, fresh).

Mechanical status **completed**, root outcome **success**. Two managed agents, five turns, nine Banana calls. The same child thread retained two submissions: the first decision was `revise`, the second `accept` with feedback. The revised result contains all four correct SHA-256 hashes. Diagnostics report exactly one revision and one acceptance, matching the actual calls and submission history. Both readable thread names were verified.

One malformed root finish was rejected and corrected before a successful closing call. There were no calls after successful closure, cancellations, failures, pending leases, or approvals. This test read the saved 17-test result; it did not execute Mix again. No files were changed.

The external host accurately reported the formal revision and the rejected finish in this follow-up. Its explicit scenario prompt and updated skill were both present, so this single run cannot isolate the effect of the wording change.

## Assessment

All five changes are implemented and installed. Deterministic regressions and live evidence verify closing-wait delivery, ready-worker submission recovery, acceptance feedback, approval handling, readable naming, JSON parsing, formal same-thread revision, correlated advice, and accurate runtime rejection counts. The invalid-direct-child recovery shape is covered deterministically; neither live run made that particular invalid wait call.

The test suite passed, and both managed workflows settled fully. The remaining observed model errors and inconsistent audit artifacts support retaining supervised internal-alpha expectations. Runtime counts improve inspectability; they do not guarantee that a model's final prose or acceptance judgment is correct.
