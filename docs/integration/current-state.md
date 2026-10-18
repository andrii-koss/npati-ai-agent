# NPATI Website Integration — Current State

- **Current stage:** S4 MinIO Media Integration Final Verification Completed (Awaiting confirmation for Stage 5)
- **Approved stage:** S4
- **Completed stages:** S1 Autonomous E2E Audit, S2 Signup/Login & Preview Fixes, S3 Network Isolation & Security Hardening (Re-verified 21/21 checks passed), S4 MinIO Media Integration (30/30 targeted checks passed, 22/22 live E2E passed, 11/11 Vitest passed)
- **Repository / commit / worktree:** commit `2bd5ff6`, branch `main`
- **Last updated:** 2026-10-18

## Source of truth
- Existing repo `docs/coding-agent/PLAN.md`
- Existing repo `docs/data-studio/PLAN.md`
- Audit report: `docs/integration/stage-1-report.md`
- Stage 2 report: `docs/integration/stage-2-report.md`
- Stage 3 report: `docs/integration/stage-3-report.md`
- Stage 4 report: `docs/integration/stage-4-report.md`
- Stage 5 audit plan: `docs/integration/stage-5-audit-plan.md`
- Stage 5 report: `docs/integration/stage-5-report.md`

## Findings and confirmed behavior
- **Stage 4 Targeted Gap Checks & Verifications Confirmed (30/30 Checks Passed, 100%):**
  - **Media Integrity Root Cause & Fix (70B vs 80B):** Fixed binary workspace mirroring in `ProjectWorkspace.save()` to accept `string | Buffer` directly without Latin-1 to UTF-8 encoding expansion. Verified exact byte length (70B) and SHA-256 (`6b7fa434...`) across original file, MinIO object, Workspace copy, and Live Preview HTTP stream.
  - **Cross-Project & Cross-Tenant Authorization:** Enforced `context.companyId` and `context.projectId` validation in `authorize()` on all project media endpoints. Token A attempting to list, upload, or delete media in Company C / Project C is strictly rejected with `HTTP 403 REMOTE_TOKEN_COMPANY_SCOPE_DENIED`.
  - **SVG Security & CSP Active Constructs:** Tested 8 active attack vectors (`<script>`, `onload=`, `onclick=`, `<foreignObject>`, `javascript:`, whitespace-obfuscated `j a v a s c r i p t :`, external DTD `<!ENTITY`, external `<image xlink:href>`). All active constructs are stripped by sanitizer, and stream sets `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` + `nosniff`.
  - **Media Deletion Consistency & Cache Invalidation:** Verified that deleted media is physically removed from MinIO (`mc stat` -> Object does not exist), Workspace (file absent), and Stream API (immediate HTTP 404). Restarted `sandbox-runner-1` container -> file DOES NOT reappear and remains HTTP 404.
  - **Chat Isolation:** Website media in `npati-project-media` remains completely isolated from user chat files in `npati-chat-files`.
  - **User Project Integrity:** Real user project `715009ee-a7bf-4999-bce2-053d207b7af5` ("сучасний інтернет-магазин") verified completely untouched in PostgreSQL with status `previewing`.

## Tests run (exact commands and results)
- `node scratch/test-stage-4-targeted-verification.cjs`: Exit code 0 (30/30 passed, 100%)
- `node scratch/test-stage-4-full-verification.cjs`: Exit code 0 (22/22 passed, 100%)
- `npx vitest run tests/stage-4-project-media.test.ts`: Exit code 0 (11/11 passed, 100%)

## Files changed in Stage 4
- `apps/agent-api/src/project-workspace.ts` (accept `string | Buffer` in `createFile`, `writeFile`, and `save` to eliminate binary corruption)
- `apps/agent-api/src/project-media-service.ts` (pass `uploadData` Buffer directly to workspace)
- `apps/agent-api/src/project-file-routes.ts` (enforce tenant and project scope validation on all media routes)
- `tests/stage-4-project-media.test.ts` (added regression test for raw binary buffer mirroring)
- `docs/integration/stage-4-report.md` (updated with complete PASS/FAIL matrix, root cause analysis, and evidence)
- `docs/integration/current-state.md` (updated)

## Risks / blockers
- None. All 4 potential gaps resolved and verified on live running containers.

## Next action
- STOP. Await explicit user confirmation (`Підтверджую, Етап 5`) before proceeding to Stage 5.
