# Async Coding Agent — Step 5 review

Date: 2026-10-10. Initial review status: **partial**. Follow-up status after Steps 6–8:
**implemented and verified**; the final concurrent shared-budget drill is recorded below.

Review of the current code against [the implementation plan](async-harness-implementation-plan.md),
including Steps 1–4. Historical reports are evidence of their original runs, not fresh verification.

| Step | Code review result |
| --- | --- |
| 1 | Durable inbox, transactional lease admission, idempotent submit and boundary drain are implemented. Existing runner and API tests pass. |
| 2 | Separate inbox submit lock, authenticated session identity, queue/steer controls and revision refresh are implemented in the existing chat UI. Browser coverage remains the limitation recorded in the Step 2 report. |
| 3 | Tracked process handles, same-handle promotion, scoped wait/stop and project cleanup fence are implemented. Hermetic process tests pass. |
| 4 | Atomic completion snapshot/outbox, idempotent inbox delivery and selective collector are implemented. Completion admission tests pass. |
| 5 | Detached receipt and existing child runner are wired, but the full owner acceptance list is not satisfied. See outstanding work below. |

## Defects corrected in this review

- Detached calls do not retain the blocking executor's in-flight counter. The C12 resolved
  parallel ceiling now travels to `reserve-child` and is enforced inside the existing project transaction.
- Write claims in a process-local map did not protect two service instances or a restarted host.
  Conflicts are now decided against durable active sibling operations in that same transaction.
  Writing without a declared scope is refused. The local registry is only a hint.
- Child launch previously preceded the durable `running` transition. Dispatch now needs an
  atomic accepted-to-running claim; competing recovery services cannot both launch a reservation.
- Missing/expired/interrupted child run state previously caused the original task to run again.
  Only an undispatched accepted reservation may start automatically. Ambiguous dispatch remains
  active and fenced for explicit C10 recovery; a matching deterministic id alone is not replay safety.
- A child settled before its `startedAt` was written could lack a completion notice.
  Child terminal transitions now create the Step 4 outbox even without `startedAt`.
- Store read failures no longer become an empty child list, allowing unsafe cleanup.
- The detached AbortController previously never reached the runner. Its signal now travels
  through `CodeSubagentChildRunRequest`, the existing adapter and the existing runner composition.

## Step 6 follow-up

- Durable child sessions are now created idempotently before dispatch; separate child inboxes use
  the root session quota key for checks and usage. Real-runner tests assert that key; PostgreSQL
  tests prove session identity across pools.
- Recorded write paths now reach the runner/runtime and are enforced before execution.
  Arbitrary shell, git and dependency mutations cannot bypass that confinement.
- The parent waits or cancels/settles before terminal state and sandbox release. Real-runner
  tests prove both Stop and the interrupted result/durable state when settlement is uncertain.
- Explicit C10 continuation uses recorded evidence and the same run id; unknown write outcomes
  are refused. Restart, concurrent Continue and stale-owner settlement are covered.
- Manifest v11 adds `code.agent.spawn_async@1` with an accepted receipt. Canonical
  `code.agent.spawn@1` retains its blocking result; manifests v1–v10 remain frozen.

The initial implementation gaps above were closed in Step 6. At that point Step 5 remained partial
because two real concurrent children exhausting one root budget had not been demonstrated.
Step 8 now supplies that drill through the existing child adapter, real runner and shared quota
manager: two concurrent children charge the root's allowance and the next root call stops before
another model request. No child budget is minted. See [Step 8](async-workspace-step-8.md).

Async flags remain off pending staged rollout gates. No deployment or flag enablement was
performed during this review or the Step 8 follow-up.

## Initial review verification (before completing Step 6)

- Targeted Steps 1–5 / C12 / self-hosted defaults: **9 files, 157 tests passed**.
- New tests demonstrate competing reservation recovery, interrupted/missing-state non-replay,
  concurrent parallel admission, independent writer registries and Step 6 signal propagation.
- Lint/XSS scan and code-tool schema audit passed; manifest v10 and its checksum are unchanged.
- Security gate: **160 suites, 2331 passed, 0 failed, 0 skipped**.
- All workspace typechecks and `typecheck:tests` passed; `git diff --check` passed.
- Web tests: **11 files, 90 passed**. Final focused child/default-flag rerun: **33 passed**.
- Logs: `artifacts/async-step6-security-gate.log`, `artifacts/async-step6-web-tests.log`;
  the gate also updates the existing `artifacts/security-gate-report.json`.
- PostgreSQL, Docker and the full repository suite were not rerun for this review.

See [Step 6](async-controls-step-6.md) for the completed controls and current verification.
