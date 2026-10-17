# NPATI Website Integration — Current State

- **Current stage:** S5 Completed (Awaiting user review of Stage 5 report)
- **Approved stage:** S5
- **Completed stages:** S1 Audit, S2 Signup/Login & Preview Fixes, S3 Network Isolation & Security Hardening, S4 MinIO Media Integration, S5 Delete Website Lifecycle & Soft Delete
- **Repository / commit / worktree:** commit `2bd5ff6`, branch `main`
- **Last updated:** 2026-10-17

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
- **Stage 5 Delete Website Lifecycle Fully Implemented:**
  - **Soft Delete on 30 Days (Zero Data Loss):** Website files, workspace, MinIO media assets, and DataStudio connections remain completely intact for 30-day recovery.
  - **Process Stop vs Destroy:** Uses `stopSandbox` (process kill) during soft delete instead of `destroySandbox` (`rm -rf`).
  - **Immediate Access Blocking:** Preview Proxy rejects with 409 `project_deleted`, Project API Gateway throws 404 `PROJECT_NOT_FOUND`, Media streaming returns 404, CORS permissions detached for deleted project only.
  - **Data Studio Database Preservation:** `data_backend_id` preserved; PostgreSQL databases (`db_..._dev`, `db_..._prod`) are NEVER dropped (`DROP DATABASE` / `DROP SCHEMA` prohibited).
  - **Dry-Run `delete-plan`:** Pure non-mutating preview of affected resources.
  - **Lifecycle State Machine & Migration 092:** `projects_status_check` updated with `soft_deleted`, `purging`, `deleted`; added `deleted_at`, `purge_after`, `deletion_reason`, `restored_at`; persistent audit table `project_lifecycle_records` created.
  - **SVG Security:** Sanitization for `<script>`, event handlers (`onload`, etc.), `<foreignObject>`, and XXE entity injections. Safe response headers (`Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`).
  - **Backward Compatibility:** `DELETE /companies/:companyId/code/projects/:projectId` migrates to Soft Delete by default.
  - **Real Infrastructure Verified:** Tests executed on live Docker stack with disposable projects; real project `715009ee-a7bf-4999-bce2-053d207b7af5` untouched.

## Tests run (exact commands and results)
- `npx vitest run tests/stage-5-delete-lifecycle.test.ts`: Exit code 0 (14/14 passed)
- `npx vitest run tests/coding-agent-c7-project-lifecycle.test.ts tests/coding-agent-c7-workspace-cleanup.test.ts`: Exit code 0 (26/26 passed)
- Live container test on Docker stack (`scratch/test-stage-5-live.cjs`): 100% passed across all 11 validation checkpoints (SVG sanitization, dry-run plan, soft delete zero data loss, access denial 404, isolation of Project B, restore unblocking, retention guard enforcement, hard purge of dedicated MinIO media, preservation of Data Studio DB, repeat purge idempotency, real project immutability).

## Files changed in Stage 5
- `packages/workspace/src/types/project.ts`
- `packages/workspace/src/migration-092.ts` (created)
- `packages/workspace/src/postgres-store-migrations-late.ts`
- `packages/workspace/src/postgres-store-schema.ts`
- `packages/workspace/src/postgres-project-repositories.ts`
- `packages/workspace/src/in-memory-project-store.ts`
- `packages/workspace/src/in-memory-store.ts`
- `apps/agent-api/src/project-sandbox-service.ts`
- `apps/agent-api/src/svg-sanitizer.ts` (created)
- `apps/agent-api/src/project-media-service.ts`
- `apps/agent-api/src/project-file-routes.ts`
- `apps/agent-api/src/data-studio/service.ts`
- `apps/agent-api/src/data-studio/gateway-service.ts`
- `apps/agent-api/src/project-preview-service.ts`
- `apps/agent-api/src/project-lifecycle-service.ts` (created)
- `apps/agent-api/src/code-project-lifecycle-routes.ts`
- `apps/agent-api/src/code-rbac.ts`
- `apps/agent-api/src/code-route-lifecycle.ts`
- `apps/agent-api/src/code-route-wiring.ts`
- `apps/agent-api/src/app.ts`
- `tests/stage-5-delete-lifecycle.test.ts` (created)
- `docs/integration/stage-5-report.md` (created)
- `docs/integration/current-state.md` (updated)

## Risks / blockers
- None. All 12 mandatory requirements verified and active in running stack.

## Next action
- STOP. Await user confirmation before moving to Stage 6.
