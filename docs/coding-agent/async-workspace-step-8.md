# Async Coding Agent — Step 8: unified workspace, recovery drills and staged rollout

Date: 2026-10-10. Implementation and local recovery drills completed. Rollout remains dark;
promotion beyond `internal` requires the separately signed G1 and R1 gates.

## One workspace

`CodeWorkspacePage` now uses `AsyncWorkspacePanel` for the existing session inbox and durable
operations. When enabled, its queue/steer composer replaces the direct run-start form. The
authoritative inbox run identity reconnects the existing Activity, changes and usage views.
The existing chat still uses the same inbox and dispatcher; switching views creates no runner.

- Shell processes and child agents appear together with lifecycle, cancellation and result
  collection state. Unknown outcomes remain visibly fenced.
- Queue/steer, pending-message edit and discard use the Step 1/2 endpoints and revision checks.
  Completion notices cannot be edited through this UI.
- Continue, child messages and Interrupt use the Step 6 routes. Failed Continue/message retries
  retain request identity; double clicks are serialized. Continue keeps the existing child run.
- Process output and Stop invoke the existing canonical tools through the policy/RBAC/audit
  runtime. Output uses the absolute byte cursor, is bounded to 64,000 characters per displayed
  chunk, reports loss/truncation and renders as text. Reading it does not admit a model result.
- The existing parent Stop, approvals, Activity, changes and verification UI remain authoritative.
  The recovery button reads the existing C10 notice. It does not claim to execute the continuation
  that the C10 resume API only prepares.

## Additive API and rollback

The new authenticated GET is
`/companies/:companyId/projects/:projectId/code/sessions/:sessionId/async-workspace`.
Its `schemaVersion: 1` projection contains scoped operation identities, lifecycle and collection
metadata plus available feature capabilities. It uses the existing project transaction and
`code.changes.read` authorization, checks session/company/project/user/workspace, sets `no-store`,
and returns no task, command, transcript, output, secret, lease owner or delegation payload.
Reading performs no producer dispatch, result admission, completion acknowledgment or lease claim.

`code.async_workspace` is separately opt-in and off by default, including self-hosted installations.
Existing inbox/process/child/control/resume flags still govern their own actions. No migration,
tool or catalogue addition is needed: manifest v11 and all 43 published tools are unchanged.

The shell wait/stop adapter now rejects child-operation handles. The legacy shell list skips them;
children must use their own collector and Step 6 control path. This closes a bypass exposed by
presenting all operation identities together.

Polling is bounded to one request at a time and three seconds between refresh opportunities,
pauses while the tab is hidden, and refreshes on focus/online/visibility restoration. Disposal
aborts and fences late replies even if a transport ignores abort. A scope change clears drafts,
output cursors and retry identities. An unavailable snapshot disables controls and cannot fall
through to another run-start request. Browser storage is not an authority or an execution queue.

## Recovery evidence

| Drill | Evidence |
| --- | --- |
| Observer restart / page reload | Same durable operation identities; read-only store journal; real React browser reload issues no mutation. |
| Lost connection / reconnect | Controls disabled while offline, scoped GET refresh restores them; no producer/control writes. |
| Lost Continue response | Real browser retries the same request ID; Step 6 tests prove deduplication and concurrent C10 lease fencing. |
| Tenant/session switch and delayed responses | Backend identity/scope rejection and frontend disposed-observer tests fence old replies. |
| Completion after worker restart | Independent PostgreSQL pools reconstruct a collected child without changing its journal or inbox admission. |
| Interrupted/unknown child | Projection is observation only; shell wait/stop cannot reach the child producer; Step 5/6/7 suites prove unknown-write non-replay. |
| Parent takeover / paused collection / cleanup | Step 7 regression proves same-handle adoption, selective collection and sandbox lifetime fences. |
| Rollback with pending operations | Disabling optional capabilities preserves operation records; Step 6 regression proves drain/Stop fences. |
| Two concurrent children exhaust one budget | Two existing child adapters execute the real runner concurrently, charge 6,000 tokens each to the root session through `CodeRunSharedQuota`/`A2AQuotaManager`; the next root call stops as `budget_exhausted`, with no child allowance minted. Closes the remaining Step 5 drill. |

Backend coverage is `tests/coding-agent-async-workspace.test.ts`, registered in the fixed security
gate and test typecheck. PostgreSQL coverage extends `coding-agent-async-inbox-postgres.test.ts`.
Web tests cover rendering, scopes, transport failures, serialized reads and retry identities.
`scripts/verify-async-workspace-browser.mjs` exercises the actual React panel in headless Edge
with mocked existing HTTP contracts: Continue retry, child message, steer/edit/discard, inert
process output, reload and reconnect. The DB and runner tests exercise the corresponding server
contracts separately; this browser drill does not represent a live-model/provider acceptance run.

To repeat the browser drill without changing repository dependencies:

```powershell
npm install --prefix artifacts/async-step-8-browser --no-save --package-lock=false playwright@1.64.0
node scripts/verify-async-workspace-browser.mjs
```

Use `NPATI_DRILL_PLAYWRIGHT` for another Playwright entry point and `NPATI_DRILL_BROWSER` for
an installed browser executable. The script owns a loopback Vite server and closes it and its
browser in `finally`. It never connects to the running deployment.

## Staged rollout and rollback procedure

1. Keep all async flags off. Preserve these test artifacts, the deployed revision, manifest checksum
   and existing G1/R1 reports. Obtain their required signatures before promotion beyond `internal`;
   `allowPreGateRollout` is not a substitute for those signatures.
2. Select one internal company/user through the existing Feature Flags surface. Enable only the
   required existing master/read/shell/background/subagent/resume prerequisites, then async inbox,
   processes, subagents, controls, collect barrier and workspace flags for that scoped cohort.
   Do not broaden global scope as part of an internal check.
3. On that cohort, repeat message, same-child Continue, process output, parent Stop, reload and
   reconnect checks. Inspect the existing Activity/usage/approval views and durable completion
   admission; confirm one producer identity and one result admission per operation.
4. After signed G1/R1 and successful internal evidence, use the existing stages and cohort controls
   for canary, beta and GA. Observe admission failures, quota stops, unresolved operations, pending
   completions and verification failures in existing telemetry. Record operator, cohort and verdict.
5. For rollback, disable optional workspace/control and new-work subagent admission first. Allow
   existing producers/collector/inbox to drain, or stop them through the existing parent Stop path.
   Inspect interrupted/unknown operations before cleanup. Preserve the active-operation fence;
   never erase durable records or replay an ambiguous write to obtain a green rollout result.
   A master kill switch remains available for immediate revocation.

No rollout flags were enabled, no application containers were rebuilt or deployed, and no
production promotion was performed. Live provider crash tests and external G1/R1 signatures
remain release prerequisites rather than claims made by these local drills.

## Verification

Hermetic gate: **163 suites / 2385 passed / 0 failed / 0 skipped**. PostgreSQL gate:
**2 suites / 4 passed / 0 failed / 0 skipped**. Web: **12 suites / 102 passed**. Browser:
**6 drills passed**. Workspace/test typechecks, lint/XSS, tool/catalog audits and whitespace checks pass.
Detailed evidence is recorded in [the security gate report](security-gate-report.md). Browser evidence:
`artifacts/async-step-8-browser-report.json`; backend/web/typecheck/gate logs use the
`artifacts/async-step-8-` prefix. The PostgreSQL drill uses a disposable container, not the
installation's existing databases.
