# Async Coding Agent — Step 6: Continue / send_message / interrupt

Date: 2026-10-10. Status: **implemented and verified**.

Step 6 publishes backend controls through the existing CodingAgentRunner, C6a run log,
C10 resume, durable session inbox and Step 4 process outbox. UI integration belongs to Step 8.

## Published contract

Manifest **v11**, 43 tools. Added `code.agent.spawn_async@1`, `code.agent.continue@1`,
`code.agent.send_message@1` and `code.agent.interrupt@1`. The blocking
`code.agent.spawn@1` and manifests v1–v10 retain their published schemas and checksums.
The catalog contains 391 capabilities: 127 callable and 264 runtime entries.

All three controls also have authenticated POST routes:

`/companies/:companyId/code/sessions/:sessionId/runs/:parentRunId/children/:childRunId/{continue|send_message|interrupt}`

Routes use the existing RBAC/audit journal and require `workspace:write`.
Company, parent session, parent run and child run are resolved against durable records.
Foreign parent/child/session identities produce 404; responses expose codes, not internal errors.
The runtime refuses every `code.agent.*` tool on a child run.

## Behavior

- Async spawn creates an idempotent, tenant-scoped child session linked to its parent before
  dispatch. Its inbox is distinct; quota checks and usage retain the root session key.
  File mutations must stay inside their recorded write paths; writing children cannot bypass
  confinement through arbitrary shell/git/dependency tools.
- `send_message` accepts `requestId` and `text`, uses the child's durable steer inbox,
  deduplicates retries and admits input at the next runner boundary. Messages submitted while
  paused are admitted by Continue; queued input remains queued. No second driver is started.
- `interrupt` persists intent, then signals the same local runner. A remote owner consumes
  intent from the same process store. Receipts distinguish requested, pending_remote and already
  settled; they never assert that an unobserved producer has stopped.
- Cooperative interruption leaves the run interrupted, releases its lease and retains the
  active-child/sandbox fence. It does not publish a terminal completion.
- `continue` reconstructs the recorded task through C10 and keeps the same child run id,
  delegation and turn ceiling. Unique lease ownership prevents concurrent Continue from
  creating two drivers. Accepted request ids remain available for retry deduplication,
  including older receipts after later continuations (bounded to 256 continuations per child).
- Unknown mutating outcomes refuse automatic continuation before acquiring a lease or calling
  the model. Missing/expired dispatched children are never restarted from their initial prompt.
  A dispatch whose completion is uncertain remains fenced for explicit recovery.
- A parent's normal finish waits for children. Stop persists terminal cancellation intent and
  cancels/settles them before terminal state or sandbox release. An unresolved child leaves the
  parent interrupted and fenced. A stopped child cannot subsequently be continued.
- PostgreSQL retention and erasure protect paused children and their run evidence. A stale
  executor cannot overwrite a continuation's operation after its new lease has ended.

## Flags and rollback

`code.async_agent_control` remains off by default, including self-hosted installations.
Admission also requires async subagents, tracked processes, async inbox and their existing flags.
Continue additionally uses C10's `code.session_resume` gate. No flags were enabled here.

Rollback refuses new spawn/Continue/messages; authenticated interruption and parent Stop still
allow existing work to drain. In-flight children finish through the existing completion outbox.
A paused child remains fenced until an explicit stop or a later authorized continuation.

## Verification

- `tests/coding-agent-async-controls.test.ts`: real runner, inbox and C10 tests cover pause/resume,
  live steering, remote intent, restart, concurrent and historical retries, unknown outcomes,
  tenant scope, real RBAC, parent terminal fences and enforced write paths.
- PostgreSQL tests use a disposable pgvector/PostgreSQL 17 container and independent pools:
  deterministic session creation, control state, child lease continuation, paused input,
  stale-owner rejection, retention and child-session erasure fencing.
- Hermetic security gate: **161 suites, 2347 passed, 0 failed/skipped**.
- Database gate: **2 suites, 4 passed, 0 failed/skipped**.
- Web regression: **11 suites, 90 passed**.
- Workspace and test typechecks, lint/XSS, schema and capability audits, and diff whitespace
  checks pass. Manifest v11 checksum:
  `a1c20d6e1be84667c158b84f65e4afba78918b6794582752c7339218f826be6b`.

Logs: `artifacts/async-step6-security-gate.log`, `artifacts/async-step6-security-gate-db.log`,
`artifacts/async-step6-controls-tests.log`, `artifacts/async-step6-web-tests.log`.

The full repository suite and browser UI recovery drills were not run. Steps 7–8 remain unstarted.
