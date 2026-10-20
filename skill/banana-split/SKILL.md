---
name: banana-split
description: Use Banana Split by default whenever a task calls for subagents, multiple agents, parallel workers, delegated workers, or supervised agent coordination, including across Claude and Codex. It replaces the built-in subagent systems (Codex subagents and Claude's Agent/Task subagents); use those only when the user explicitly asks for native or standard subagents. Runs the task as a workflow of independent full agent threads that delegate recursively, message each other by thread ID, ask for advice, and have parents review their children's work.
---

# Banana Split

A Banana Split workflow is a tree of agents. Each agent is its own **full thread**, it can create children, and it can message any other agent in the workflow by thread ID. A shared **directory** file records who exists, what each agent is doing and where things stand. The user's conversation stays the cockpit.

## Threads, not subagents

- Every agent is a full, top-level thread, started with whatever thread tools this environment offers: T3 thread launch or fork, Codex threads, Claude sessions, or a CLI.
- Banana Split **replaces** the built-in subagent systems for any delegation, whether or not the user names Banana Split. Do **not** use the Codex subagent tools (`spawn_agent`, `send_message`, `wait_agent` and similar) or Claude's Agent/Task subagents, unless the user explicitly asks for native or standard subagents.
- If full threads can't be started in this environment, tell the user and ask how to proceed. Don't silently fall back to native subagents.
- Do not use one-shot delegation that can't be messaged afterward, such as T3's `delegate_task`, for agents that need back-and-forth, review or later contact. A one-shot tool is fine only for fire-and-forget work where the returned result is all that's needed.
- **Context source.** For a fresh child, start a new thread with a standalone brief. For a child that should inherit context, *fork* the parent's thread; don't paste a summary into a fresh one. A fork carries the parent's model unless the forking tool lets you change it.
- Mix providers freely when the environment allows it. Choose whatever model suits the assignment (see [Tiers](#tiers)).

## Starting a workflow (host)

1. Choose a workflow ID: a short slug plus the date, e.g. `onboarding-review-2026-10-20`.
2. Create the directory at `<workspace>/.banana-split/<workflow-id>/directory.md` (format below). Results and scratch files from agents may go in the same folder.
3. For anything beyond a couple of assignments, launch a **root coordinator** thread so that the user's conversation stays free for progress updates and decisions. For small work, the host may coordinate directly.
4. Carry every user requirement into the root brief: scope, file ownership, permitted commands, read-only or not, tier, deadline, and what to return. The root carries them into its children's briefs.

## Writing a brief

Every brief must stand on its own and include:

- **Objective**: one specific sentence first, because it often becomes the thread title.
- **Ownership**: what the agent owns, and what it must not touch.
- **Done means**: the concrete result to submit, and where it goes.
- **Reporting**: the parent's role and thread ID, the workflow ID and the directory path.
- **Context**: whether the agent was forked or started fresh, plus anything a fresh agent needs.
- **Constraints**: the user's restrictions, carried down from the parent's own brief.

## Messages

Open every message with a header so the recipient can reply without looking anything up:

```
[banana-split <workflow-id>] from <role> (<thread-id>) · directory: <path>
```

- Message any agent directly by thread ID. Messaging an idle agent wakes it, so waking someone is just messaging them.
- Keep messages self-contained. The recipient may be busy, may have lost track of the topic, or may be a fresh thread.
- **A question creates an obligation.** If someone asks you something, answer before you finish, even if the answer is "I don't know; ask <id>."

## Behaviour expected of every agent

- **Delegate generously, and go deep when it helps.** When a piece of work deserves its own focus, give it its own thread. Children may delegate further; don't hesitate to build depth or breadth when the work calls for it. Don't delegate what is faster to do yourself.
- **Record when you act.** Append a line to the directory when you spawn a child (you know its ID), change status, submit, accept or finish. Don't save logging for the end.
- **Don't poll.** After delegating, do any useful independent work, then end your turn. Whoever has news will message you. Check in on a child only if it has clearly gone silent past a reasonable time.
- **Review your children.** A child submits its result to its parent. The parent checks it against the brief and either **accepts** it or sends **specific revision feedback**, and the child revises and resubmits. A child is not done until its parent accepts. Review only your direct children; trust them to have reviewed theirs.
- **Escalate judgment calls.** If an action falls outside your brief or authority (destructive changes, scope expansion, new permissions, spending), message your parent with what you want to do and why. Parents decide within the user's instructions and escalate to the host only when the user's intent is unclear. Native tool approval prompts still go to the user as usual.
- **Before you finish**, check that every child is accepted or cancelled, every question you were asked is answered, and your directory lines are current. Then submit to your parent; the root submits to the host.
- **Report honestly.** Every submission states its outcome as `success`, `partial`, `blocked` or `failed`, with a summary, evidence and any open issues. Never upgrade a partial result to success.
- **Stay in your lane.** Agents share the workspace. Edit only what your brief gives you, and coordinate through the owner for anything else.

## The directory

The directory is an append-only Markdown file. Agents only append and never rewrite another agent's lines. An agent's current status is its latest line.

```markdown
# <workflow objective>

workflow: <workflow-id> · host: <thread-id> · tier: <tier> · started: <date>

## Log
- <time> | <thread-id> | spawned | parent=<thread-id> role="<one line>" provider=<p> model=<m> effort=<e> context=fresh|forked
- <time> | <thread-id> | working | <what it's doing>
- <time> | <thread-id> | waiting | on <thread-id(s)>: <for what>
- <time> | <thread-id> | submitted | <outcome>: <one line> · result: <path or summary>
- <time> | <parent-id> | revise | <child-id>: <one line>
- <time> | <parent-id> | accepted | <child-id>
- <time> | <thread-id> | done | <outcome>
- <time> | <thread-id> | cancelled | by <thread-id>: <reason>
- <time> | <thread-id> | note | <anything notable: a tier switch, a failure, an escalation>
```

The parent writes the `spawned` line, and after that each agent writes its own lines. If the session restarts or a new session takes over, read the directory and message the relevant threads by ID to continue.

## Host loop

- Every minute or so while work is running, and whenever there's a milestone or blocker, read the directory and tell the user what finished, what's underway and what needs their attention. Summarize the current state; don't narrate each read.
- Handle escalations promptly. Ask the user only when their instructions don't already settle the question.
- **Controls the user may request:**
  - *Freeze*: tell agents to stop spawning new children.
  - *Cancel*: tell the agents in the subtree to stop, and log `cancelled`. Cancellation does not undo changes already made.
  - *Switch tier*: log a `note` and tell coordinators. Only new agents and later turns use the new tier.
- **Finishing.** Being "done" in the directory is not the same as the user's task succeeding. Verify the root's result against the user's request, and address any remaining authorized work, before reporting.

## Final recap

Alongside the answer to the user's task, include:

- the root's outcome and summary, the workflow ID, the directory path, and the root thread ID;
- the tiers used and any switches;
- the number of distinct agents across all depths, with the root counted separately;
- models and reasoning efforts grouped by agent count, with the root separate;
- notable events: revisions, failures, escalations, cancellations;
- the host's own model and effort, if known.

## Tiers

Each tier maps four presets to a model and reasoning effort. The parent picks a preset to suit the assignment, and the tier decides the model. With no selection, use `default`. Map "cheap" or "cost optimized" to `cost-optimized`, "high performance" to `performance-optimized`, and "max" or "maximum performance" to `max-performance`. Tiers mix Claude and Codex models. The table and preset guidance are in [references/tiers.md](references/tiers.md). The root coordinator uses `default-judgment` unless the user says otherwise.
