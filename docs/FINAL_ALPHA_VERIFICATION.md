# Banana Split internal alpha verification

Assessment: ready for supervised internal-alpha use. The concluding coordination checks passed with no new confirmed Banana Split defect. The final benchmark needed a host documentation repair, so it is not a fully autonomous task-completion pass. All three test workflows and their hosts have finished; the approved loop is stopped.

Installed version: `1.0.0+codex.20260907191445`.
Test project: `/Volumes/OS/Development/Banana-Test-Project`, a disposable BlackBox clone without remotes. Sunlight and native Codex subagents were not used. All three concluding hosts are fresh Luna-high CLI threads using the shipped `cost-optimized` catalog, without overrides.

## Product changes

The [original five coordination fixes](FIVE_FIXES_VERIFICATION.md) are implemented. The subsequent [iteration log](ITERATION_LOOP_VERIFICATION.md) records additional reproduced fixes, their before/after evidence, and installed checks. These include turn-closing feedback and parsing contracts, durable message and context delivery, approval binding and lifetime, cancellation settling, permission narrowing, restart/reinstall handling, and inspectable diagnostics.

Shipped instructions explain Banana Split's coordination contract. Task-specific procedures and test conditions remain in assignments or fixtures. The proposed Git-specific wording was removed before installation. Generic coding advice was removed or generalized, and the boundary is now explicit in the design specification. No automatic retries, watchdogs, mandatory role policies or artifact acceptance gates were added.

## Concluding installed runs

| Run | Work | Managed agents | Verified result |
| --- | --- | --- | --- |
| 122 | Dependency planner with separate implementation, tests, examples and documentation owners | 5: Sol-medium root and 4 fresh Luna-xhigh children | Success; 18 host tests, 311 independent module/example checks and 14 CLI checks. Four acceptances, one formal revision. |
| 123 | Updated requirements delivered after initial submissions; original workers revise and resubmit | 4: Sol-medium root and 3 Luna-xhigh children, including one inherited child | Success; three original workers, six submissions, three formal revisions and three acceptances. Both file versions and the inherited native boundary verified. |
| 124 | Recursive error-message catalog against the actual BlackBox formatter | 37: 5 Sol-medium coordinators including root, 32 fresh Luna-xhigh leaves | Coordination passed: 36 acceptances, exact context delivery to all 37 agents, 32 verified original case authors and formatter results, event-derived active-turn peak 16. Catalog needed a host repair after root completion. |

Across the three concluding runs, 46 managed agents executed 75 native turns and 170 Banana tool calls, with 43 acceptances and 4 formal revisions. All native model/effort routing and permission checks passed. There were no managed-tool rejections, missing dispositions or tool calls after successful closure; every first message after closure was a final response. Two run 122 command approvals were declined under that test's temporary-file constraint; the same agent continued and completed its work. Those declines are expected permission behavior, not runtime failures.

The most recent source check, 114 automated tests with 832 assertions, macOS build, Windows cross-build, plugin validation, skill validation and diff checks passed. Fresh hosts and the existing main-session MCP proxy work after reinstall; no Codex application restart was required. Windows cross-compilation is not a claim of live Windows acceptance.

## Remaining limitations

Run 124's root reported success while its catalog omitted the required input terms and runnable validation command. The controller and host independently found the gap after the root completed; both late correction messages were correctly rejected without side effects. The host then repaired only the catalog and disclosed the intervention. The final catalog, all 32 inputs/messages, validator and original leaf authors passed independent checks. This host repair exceeded the benchmark's host-only-report write condition; it must not be credited as compliance with the original managed ownership plan. No product instruction or enforcement rule was added for this task-specific omission.

The run 124 capacity sampler stopped after its private 10-second RPC timeout, so it does not cover the whole workflow. Its 109 retained samples reached 16 active turns; independent retained-event accounting also gives a workflow peak of 16. A several-minute review pause later ended without intervention. No cause was established for the pause or sampler timeout, and neither was used to justify a speculative runtime fix.

Cheap agents can still make task and reporting mistakes. For example, a host called a shared runtime capacity sample a per-workflow peak, and a root called ordinary requested corrections formal revisions. The runtime's recorded operations and native transcripts establish the actual counts. Final summaries and parent acceptance are not proof of task correctness by themselves.

Earlier no-Git and no-other-cycle conditions were test-only restrictions. Violating them was an assignment-compliance failure, not evidence that Banana Split should forbid Git. Native write boundaries do not provide general read isolation or guarantee obedience to arbitrary prose restrictions.

These tests support supervised internal use. They do not establish reliable unattended judgment, comprehensive platform acceptance, or correctness under every possible native App Server failure. Original reports and discrepant observations remain preserved in the iteration evidence.

## Evidence

- [Detailed iteration history](ITERATION_LOOP_VERIFICATION.md), including failures, harness corrections and source-native versus installed test distinctions.
- Controller artifacts: `.banana-test/iteration-loop/122/`, `123/` and `124/` in the Banana Split repository.
- Final broader workflow: `wf_a9486900-69e4-4892-be33-000ee3942309`; root `agt_4bdb9785-adaf-461e-93e5-8ef7d7c3b2ed`.
- The test project's four protected baseline hashes remain unchanged and it still has no remotes. Existing unrelated changes are preserved. The runtime remains running for other retained workflows; no unrelated work was cancelled or restarted.
