# NPATI — Incremental async Coding Agent: implementation plan

Status: **restored** on 2026-10-10. This document was referenced by every step report
(`async-inbox-step-1.md`, `async-inbox-step-2.md`, `async-process-step-3.md`,
`async-completions-step-4.md`) but did not exist inside the repository — the links were
broken and the plan lived outside the repo. The eight steps below are the owner's
authoritative structure, transcribed verbatim; they are **not** reconstructed from file
names. Step 5 carries the detailed owner requirements for that step.

## Ground rules (apply to every step)

- Reuse the existing Coding Agent primitives. **No second runner, policy engine, process
  manager, queue, approval system or Activity channel.**
- Every new path is behind a feature flag and **off by default**, including on self-hosted
  installs. Rollback = turning the flag off.
- `code.*` tools, APIs and persisted JSON formats are versioned; a published version is
  never edited in place.
- DB changes are additive (expand/contract) and go through the existing migration system.
- Secrets never enter prompts, logs, Activity, tool results or diffs.
- A step is not done until its acceptance list is demonstrated by fact, not by narration.

## Steps

### Step 1 — Durable inbox and boundary admission

Backend inbox plus admission at the boundary, so a message that arrives while the agent is
working is durably recorded instead of being lost or dropped on the floor.

Report: [async-inbox-step-1.md](async-inbox-step-1.md).

### Step 2 — New messages during an active run

Messages that arrive mid-run are delivered to the active run through the inbox, without
starting a second run or corrupting the transcript.

Report: [async-inbox-step-2.md](async-inbox-step-2.md).

### Step 3 — Background jobs and promotion of the same process

A long-running process is promoted to a background job **in place** — the same process, not
a copy — and the UI can follow it after the foreground view is gone.

Report: [async-process-step-3.md](async-process-step-3.md).

### Step 4 — Completion → inbox and selective result collection

A finished child/completion is delivered to the inbox, and the parent collects results
selectively (completion outbox + collector) instead of receiving everything at once.

Report: [async-completions-step-4.md](async-completions-step-4.md).

### Step 5 — Detached async subagents on top of C12

Requirements (owner, verbatim):

- reuse the existing `CodingAgentRunner`;
- reuse C12 validation / scope / digest / depth / parallel limits;
- the parent receives an **accepted receipt and the child id without awaiting the full
  child run**;
- the legacy blocking `code.agent.spawn` stays compatible;
- durable child session;
- the child operation is attached to the **existing child run**, with no duplicated run
  state;
- child completion uses the **completion outbox / collector from Step 4**;
- root budget/quota is **not** duplicated onto the child;
- an unknown outcome is **never replayed blindly**;
- a required active child must not allow parent terminal/sandbox cleanup without a wait or
  an explicit cancel+settle;
- default read-only, or disjoint approved write scopes;
- **no** second runner, policy engine or process manager.

Acceptance:

- two child starts return ids before their completion;
- the parent continues with its next model step;
- admission rollback;
- shared root quota;
- depth/scope/readOnly/foreign-tenant enforcement;
- child failure and digest handling;
- concurrent edit conflict;
- parent Stop and sandbox lifetime;
- restart recovery without duplicate child spawn.

Status: **partial** after code review on 2026-10-10. Acceptance gaps and corrections:
[async-subagents-step-5.md](async-subagents-step-5.md).

### Step 6 — Continue / send_message / interrupt

Status: **implemented and verified** on 2026-10-10. Versioned tool/API controls, durable child
session/inbox routing, C10 continuation, cooperative interrupt, rollback drain and parent Stop
fences are implemented. Hermetic and PostgreSQL acceptance evidence:
[async-controls-step-6.md](async-controls-step-6.md). UI integration remains Step 8.

### Step 7 — Collect barrier before the existing verification/self-review

Not started.

### Step 8 — One UI, recovery drills and rollout

Not started. Rollout beyond `internal` additionally requires the security gate (G1) and
rollout readiness (R1) to be signed.
