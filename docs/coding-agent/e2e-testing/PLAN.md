# NPATI Coding Agent — Real Chat End-to-End QA Master Plan

**Document:** `docs/coding-agent/e2e-testing/PLAN.md`  
**Purpose:** перевірити реальну поведінку Coding Agent від chat message до файлів, build, preview, DOM та Activity & Run Trace.  
**Scope:** незалежне тестування, автоматизована діагностика, окремо погоджені виправлення, надійність та security.  
**Non-goal:** гарантія нульових помилок або впровадження окремого product/harness.  
**Original implementation plan:** `docs/coding-agent/PLAN.md` — read-only, не перезаписувати.

## Control and gates
- Працювати по одному етапу за сесію: E0/E1/E2/E3/E4.
- Після кожного етапу STOP. Підтвердження: `Підтверджую, Етап N`.
- У E2 окреме схвалення кожного NPATI product fix; в E3/E4 збирай дефекти, але не прав код без нового погодження.
- Невиконаний тест = Not Verified/Blocked, ніколи Passed.
- Кожен E2E включає справжній Agent Runtime, а не mocked fake.
- Без безпечної ізоляції БД, Sandbox та користувачів усі зовнішні тести Blocked.
- Bounded budgets, runtime limits, fail-closed approvals, audit logs and artifact redaction.

## End-to-end signal chain
User prompt → real Chat API + authentication → model via OmniRoute/AI Providers → Coding Runtime → Run/Tool Calls → project/workspace-scoped Sandbox → files/process/build → Live Preview HTTP → Browser Playwright DOM/console → Activity & Run Trace backend/API/UI → independently asserted outcome.

## Data driven scenario definition
Scenario: `id`, `version`, `category`, `suite` (smoke/regression/full), `preconditions`, `chat_steps` (text/locale/conversation reuse), `assertions` (files, build, typecheck, HTTP, DOM, UI behaviors, trace), `allowed_tool_alternatives`, `timeouts`, `retry_policy`, `cost_budget`, `cleanup`, `fault_profile`. Validate schema and reject unknown fields. No arbitrary shell injected by scenario data without a trusted allowlist.

## Test result record
Per attempt: suite/ID/version, scenario digest, git SHA, UTC timestamp, runtime environment digest (not secrets), provider and model ID, user/project/chat/run/tool identifiers, terminal status, actual commands and redacted outputs, file diffs, build/HTTP/DOM/trace outcomes, screenshot paths, token usage/cost, duration, reason class NPATI vs test vs provider vs infra vs model. Final status: Passed, Failed, Flaky, Skipped, Blocked or Not Verified. Retries ≤2. Cleanup report and orphan detection.

## Test runner architecture
PreflightGuard → EnvironmentFixtureManager → ScenarioParser/Validator → AuthenticatedChatDriver (API + stream) → RunEventCollector → Assertions (File/Build/HTTP/Browser/Trace/State) → FaultInjector (explicit test only) → Classification/NoProgressDetection → ReportWriter (JSON+HTML) → Cleanup. UI coverage uses Playwright real chat, not API-only. Resume state from persisted run ID; never infer completion just from LLM reply.

## Budget and security preflight
Require verified non-production DB endpoint and tenant, ephemeral account, sandbox project/runner endpoint with project-level ownership; block production origin/DB/services. Test-only fault/approval mode needs defense-in-depth: environment identity, RBAC, scoped test principals, allowlisted operations and fail-closed prod checks. Verify budget/time concurrency caps, redaction, sandbox resources, preview binding/access control. Do not automatically install untrusted package scripts, authorize privileged host commands, or leak API tokens.

## Stage 1 — E0 audit (no code)
Inspect actual repo, source paths and test coverage. Audit Chat auth/stream, OmniRoute, runtime, canonical tools, run persistence, terminal/sandbox, preview, QA, Trace UI, approvals/subagents, environment isolation, test hooks and CI. Compare to coding-agent original plan. Produce evidence-based `00-audit.md` and feasibility map; propose architecture and questions; stop.

**Gate:** repo-specific evidence, preflight plan, authorization/environment decisions documented, no implementation changes.

## Stage 2 — E1 runner and cheap smoke (5–10 tests)
Implement framework-specific integration using existing tools; test user/conversation real API, streaming, run completion, same project continuation, tools, files, build, preview, Trace, Playwright chat UX, cleanup. Make `smoke/regression/full`, `--id`, and `--retry-failed` available and document exact scripts. Reports HTML and JSON in `test-results/coding-agent`. For small tests budget is low. Classify failures; do not patch product; stop.

**Gate:** demonstrated smoke run with outputs OR environment-blocked evidence, negative test fixture validates fail behavior, secret redaction check.

## Stage 3 — E2 approved defect fixes
Only user-confirmed defect list; propose root cause and diff, require individual approval before writing product code. Isolated incremental fix, regression test, rerun actual failed E2E and targeted suites, max 3 repair attempts, honest classification/blocked. Stop.

**Gate:** per defect traceable approval → code diff → test evidence; no extra fixes.

## Stage 4 — E3 regression (20–30 tests)
Actual prompt sequences and outcomes across create/edit, multi-file, refactor, bug fix, API, Next/Vite/Node/Python if supported, build/browser QA, multilingual UA/EN/PT, multi-agent and approvals, context, reload/reconnect, Trace DB API UI parity. The 5-turn Next.js store scenario must keep SAME project and features after every turn; check actual DOM/cart/search. Repeat cheap smoke ≥3 times *within approved budget*, calculate pass/flaky rates. Diagnose but no unapproved product fixes. Stop.

**Gate:** 20–30 implemented distinct scenarios, real reports or Blocked, no silent false passes, no unapproved modifications.

## Stage 5 — E4 full (>50 scenarios) and controlled fault injection
Cover long jobs, worker restart, interrupted streams, model 429/502, tool timeout, bad build, preview crash, approvals/denials, cancellation/resume, concurrent edits/projects, compaction, path traversal and tenant isolation (safe fixtures only). Maintain separate real E2E and simulated fault labels. Assertions for no hang, retry budget, idempotent write, no repeated builds without progress, orphaned processes, lost Trace, secrets. Validate test harness with deliberately broken fixture (expected Failed). Summarize coverage, reliability baselines and gaps; stop.

**Gate:** reliable reports, reproducibility, documented limits, all 50+ scenarios either executed with evidence or correctly Blocked/Skipped with reason. Do not assert zero-error agent.

## Why loop detection matters
Use canonical normalized tool-argument fingerprints and recent window, observed file checksum deltas, command exit codes, semantic completion milestones, no-event interval, token/time spent per state transition. Repeated reads or builds alone are not proof of loop; only repeated work with no progress or budget exceed. Preserve full trace.

## What to verify in Activity & Run Trace
Cross-check event existence, correlation IDs, timestamps, ordering, status transition and retry count against actual runtime outcomes and API/UI. Refresh/reconnect/restart persistence; verify stderr/exit codes, provider 401/404/429/502, command approvals, build failures, browser errors and user-visible failure cause. In chat only concise compact status if existing design calls for it; detailed forensics live in Activity page.

## Deliverables and README
The final report includes coverage by feature and scenario, real execution evidence, baseline timing/token cost, Failed/Flaky/Blocked trends, fixes approved, secrets safety, reproducible commands and cleanup. No green-on-empty tests. Package is instructions/templates, not an already-working runner.
