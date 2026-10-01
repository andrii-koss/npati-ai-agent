# NPATI Website Builder — Current State

## Status

- Current phase: Phase 1
- Completed steps: Step 0 architecture audit; Step 1 Project foundation
- Next step: Step 2 ProjectWorkspace and Files, only on a separate request

## Source of truth

- Roadmap: `docs/website-builder/PLAN.md`
- Architecture audit: `docs/website-builder/00-audit.md`
- Repository code remains authoritative where it differs from the roadmap.

## Implemented in Step 1

- Project model and store contract with Company/tenant ownership, status, type, metadata, revision and timestamps.
- PostgreSQL migration 054 creates `projects`, a nullable `company_agent_runs.project_id` FK, and a rollback function. Existing Company runs remain valid without a Project.
- PostgreSQL and in-memory stores implement create, list, get, rename, archive and delete. Project access is scoped to authenticated workspace, Company and owner. Archived projects are hidden by default.
- `ProjectService` validates input and Company access. Routes under `/companies/:companyId/projects` use existing authentication permissions: `workspace:read` for reads and `business:manage` for mutations. Create supports an idempotency key; rename/archive use `expectedRevision`.
- Settings → Company now includes Project cards, creation dialog and Open/Rename/Archive/Delete actions. Import repository and Upload project display as coming soon. `/projects/:companyId/:projectId` is a header/status placeholder.
- No Project capabilities were added in Step 1, so Capability Inspector metadata is unchanged.

## Files and modules

- Data: `packages/workspace/src/types.ts`, `packages/workspace/src/migration-054.ts`, `packages/workspace/src/postgres-store.ts`, `packages/workspace/src/in-memory-store.ts`.
- API: `apps/agent-api/src/project-service.ts`, `apps/agent-api/src/project-routes.ts`, `apps/agent-api/src/app.ts`.
- Web: `apps/web/src/ProjectSection.tsx`, `apps/web/src/ProjectPage.tsx`, `apps/web/src/CompanyPage.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles.css`.
- Tests: `tests/project-foundation.test.ts`.
- Handoff: `docs/website-builder/current-state.md`.

## Verification

- `npm run typecheck`: passed across all workspaces.
- `npm test -- tests/project-foundation.test.ts`: passed, 4 tests.
- Broader selected regression suite: 69/70 passed. The existing `tests/workspace-store.test.ts` test “supports business CRUD and current business selection” fails when two businesses have equal `createdAt`: its existing sort falls back to random UUID order, while the test expects creation order. The failing sort is present in HEAD and was not changed by Step 1.
- `npm run build --workspace @npati/agent-api` and `npm run build --workspace @npati/web`: passed.
- Root `npm run build`: blocked before compilation because `OMNIROUTE_VERSION` is absent; this was also observed during Step 0.
- No root/workspace lint script is defined.
- Migration up/down operations are asserted in a unit test; a live PostgreSQL apply/rollback was not run in this environment.
- `git diff --check`: run after implementation. The website-builder docs were already untracked at the start of Step 1.

## Architecture decisions

- Reuse `company_agent_runs`; no duplicate project run table or execution engine.
- Keep `project_id` nullable so existing Company runs and Activity are unaffected.
- `workspace_id` in `projects` is the existing NPATI tenant workspace, not the future source-file ProjectWorkspace.
- Project owner is the Company owner; team Project ACL is not introduced.

## Not implemented in Step 1

ProjectWorkspace, source files, sandbox, terminal, preview, Git/GitHub, website intent routing, ProjectTask and checkpoints. Those belong to later steps in `docs/website-builder/PLAN.md`.

## Known risks and prerequisites for Step 2

- Run migration 054 up and down against a disposable PostgreSQL 17 database before production deployment.
- Existing root build needs `OMNIROUTE_VERSION` restored by the repository's normal setup; do not synthesize a version in Project code.
- The Business ordering test is independently failing and should be addressed in its own change.
- Step 2 must enforce path normalization, symlink containment, file size limits, per-file revision, and Project Read/Write permissions before any agent can access project files.

