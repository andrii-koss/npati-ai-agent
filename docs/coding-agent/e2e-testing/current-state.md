# E2E QA Session Handoff

Status: STAGE 3 COMPLETE & SECURITY GATE VERIFIED (Ready for Stage 4: Regression Suite)
Current step: Transition to Stage 4 (Regression Suite: 20–30 scenarios)
Last confirmed step: Stage 3 & Security Gate confirmed by user
Repo SHA: `bde1d0af45a402ef93e14e77d3d42d9212358892`
Test environment: REAL ISOLATED DOCKER (Agent API `:13002`, Ephemeral DB `npati_e2e_smoke`, OmniRoute `:20128`, Sandbox Runner `:7865`)

## What was executed (exact commands and outcome)
1. **Sandbox Search Hardening**:
   - Added explicit `--` delimiter before target path in `ProjectSandboxService.search()` and `code-tool-runtime-workspace.ts`.
   - Verified Base64 query parameterization: arbitrary quotes, pipes, subshells do not break execution or leak to shell.
   - Verified that `rg` does NOT follow symlinks (`-L`/`--follow` absent).
   - Validated `safeProjectPath()`: path traversal, alternative encodings, and secret file accesses strictly rejected.
2. **Token Budget Hardening**:
   - Fixed local/self-hosted default session budget to `1_000_000` tokens (50% of the `2_000_000` user daily budget) in `code-run-quota.ts`.
   - Preserved unmodified production quotas (`DEFAULT_CODE_RUN_BUDGET.maxTokens = 100_000`, `maxTokensPerUserPerDay = 2_000_000`).
   - Verified that `CodeRunSharedQuota.checkQuota` actively blocks runs when tokens exceed allowance.
3. **Argument Recovery Bounded Protection**:
   - Added regression test in `tests/code-search-and-recovery.test.ts` for alternation (`invalid A -> valid A -> invalid A`).
   - Verified that consecutive errors without success stop with `invalid_arguments_exhausted` when `count > MAX_ARGUMENT_CORRECTIONS (2)`.
   - Verified that turn count advances, strictly bounded by `maxStepsPerRun: 40`.
4. **Tool Name Canonicalization Negative Testing**:
   - Added negative tests in `tests/code-search-and-recovery.test.ts` for unknown tools, namespace spoofing (`npati_admin`), alias collisions, and unauthorized write tools called via aliases.
5. **Full Suite & Type Safety Verification**:
   - `npx vitest run tests/code-search-and-recovery.test.ts` -> 15/15 Passed.
   - `npx tsc --noEmit --skipLibCheck` in `apps/agent-api` -> Exit code 0 (clean).
   - `node scripts/run-coding-agent-smoke.mjs` -> 15/15 Passed (225.1s).
   - Autonomous website generation (T011) and multi-turn continuation (T012) verified autonomously via live model, mutating tools (`code.fs.write`, `code.fs.apply_patch`), and Playwright DOM assertions (button red, Reset button functional, counter verified).

## Evidence paths / reports
- HTML Report: [`test-results/coding-agent/smoke-report.html`](file:///d:/npati/NPATI%20Agent/test-results/coding-agent/smoke-report.html)
- JSON Report: [`test-results/coding-agent/smoke-report.json`](file:///d:/npati/NPATI%20Agent/test-results/coding-agent/smoke-report.json)
- Standalone Runner: [`scripts/run-coding-agent-smoke.mjs`](file:///d:/npati/NPATI%20Agent/scripts/run-coding-agent-smoke.mjs)
- Security & Recovery Tests: [`tests/code-search-and-recovery.test.ts`](file:///d:/npati/NPATI%20Agent/tests/code-search-and-recovery.test.ts)
- Vitest Suite: [`tests/coding-agent-e2e/smoke.test.ts`](file:///d:/npati/NPATI%20Agent/tests/coding-agent-e2e/smoke.test.ts)

## Test Results Summary
| Scenario ID | Name | Outcome | Duration | Notes |
|---|---|---|---|---|
| T001 | `chat-auth-real` | **Passed** | 54ms | Unauthenticated rejected 401, bad signature 401, valid JWT 200 |
| T002 | `chat-streaming-lifecycle` | **Passed** | 3,028ms | Live model stream, delta events verified |
| T003 | `create-isolated-project-api` | **Passed** | 131ms | Created project with idempotency key |
| T004 | `write-read-files-api` | **Passed** | 131ms | File creation and content retrieval verified |
| T005 | `edit-existing-file-cas-api` | **Passed** | 124ms | CAS revision conflict 409 vs valid 200 |
| T006 | `safe-terminal-api` | **Passed** | 81ms | Safe terminal status available |
| T007 | `project-files-tree-api` | **Passed** | 138ms | Directory tree traversal verified |
| T008 | `preview-http-proxy` | **Passed** | 15,042ms | Preview server launched, reverse-proxy HTTP 200 verified |
| T009 | `conversation-multi-turn-memory`| **Passed** | 39,503ms | Retained memory across turns |
| T010 | `runs-and-changes-api` | **Passed** | 80ms | Trace query verified, 0 secret leakage |
| T011 | `autonomous-website-creation-chat` | **Passed** | 60,418ms | Real Chat -> Coding Runtime -> mutating call `code.fs.write` -> Playwright counter works |
| T012 | `autonomous-website-continuation-edit` | **Passed** | 73,179ms | Multi-turn continuation -> mutating call `code.fs.apply_patch` -> red button & working Reset verified via Playwright |
| T013 | `real-sandbox-terminal-execution` | **Passed** | 855ms | Safe command executed in sandbox runner container |
| T014 | `real-sandbox-vite-build-execution` | **Passed** | 31,970ms | Vite project build in sandbox verified |
| T015 | `activity-and-run-trace-deep-audit` | **Passed** | 367ms | Full PostgreSQL trace integrity verified |

## Next instruction
- Ready to proceed to **Stage 4: Regression Testing (20–30 scenarios)** according to `docs/coding-agent/e2e-testing/PLAN.md`.
- No synthetic fixtures. Real Chat API, real coding runtime, Playwright DOM verification.
- Stop and report after Stage 4 completion without proceeding to Stage 5 automatically.
