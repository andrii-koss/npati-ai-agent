# NPATI Website Builder — Current State

## Status

- Current phase: Phase 1
- Completed steps: Step 0 architecture audit; Step 1 Project foundation; Step 2 ProjectWorkspace and Files capabilities
- Next step: Step 3, only on a separate request

## Source of truth

- Roadmap: `docs/website-builder/PLAN.md`
- Architecture audit: `docs/website-builder/00-audit.md`
- Repository code remains authoritative where it differs from the roadmap.

## Implemented in Step 1

- Project model and store contract with Company/tenant ownership, status, type, metadata, revision and timestamps.
- PostgreSQL migration 054 creates `projects`, a nullable `company_agent_runs.project_id` FK, and a rollback function. Existing Company runs remain valid without a Project.
- PostgreSQL and in-memory stores implement create, list, get, rename, archive and delete. Project access is scoped to authenticated workspace, Company and owner. Archived projects are hidden by default.
- `ProjectService` validates input and Company access. Routes under `/companies/:companyId/projects` use existing authentication permissions: `workspace:read` for reads and `business:manage` for mutations. Create supports an idempotency key; rename/archive use `expectedRevision`.
- Settings → Company includes Project cards, creation dialog and Open/Rename/Archive/Delete actions. Import repository and Upload project display as coming soon.

## Implemented in Step 2

- `ProjectWorkspace` defines workspace metadata and list, tree, search, read, create, write, edit, move and delete operations. The logical path is `/workspaces/{companyId}/{projectId}`. `LocalProjectWorkspace` stores source files under a configurable root (`NPATI_PROJECT_WORKSPACE_ROOT`, defaulting to `{NPATI_DATA_DIR}/project-workspaces` or `.data/project-workspaces`). The scale Compose services now mount the shared NPATI data volume.
- Every workspace operation resolves its Project through the existing `ProjectService` and checks the authenticated tenant, Company, Project, optional workspace ID and user permission. Mutations reject archived Projects.
- File paths reject traversal, absolute paths, backslashes, NUL bytes, symlinks, reserved Windows names, excessive depth and protected secret paths. Read operations reject common secret content patterns. The default limits are 1 MiB per file and 2,000 files; `NPATI_PROJECT_MAX_FILE_BYTES` and `NPATI_PROJECT_MAX_FILES` configure them.
- File revisions are SHA-256 hashes. Write, edit and move require an exact `expectedRevision` and report `revision_conflict` with `currentRevision` on mismatch. A per-project lock directory coordinates writers sharing the same storage volume.
- Eight canonical `project.files.*` capabilities are registered with low read, medium write and high delete risk. Delete uses the existing durable Run approval flow, including batch delete. Company Agents can be granted Project Read and Project Write groups in the existing agent editor; each tool call also checks the agent's stored allowlist.
- The existing Company Run execution path can create and edit Project files. When a candidate agent has Project Files tools, the planner receives the authorized Project IDs and names for that Company. Input summaries redact file content and edit text before Activity/Run audit persistence. Read-only file tree, search and read APIs power the Files tab on the Project page.
- No schema migration was needed in Step 2. The original 306-capability audit remains intact; the active catalog and Inspector now contain 314 capabilities, including eight Project Files actions.

## Files and modules

- Project foundation: `packages/workspace/src/types.ts`, `packages/workspace/src/migration-054.ts`, `packages/workspace/src/postgres-store.ts`, `packages/workspace/src/in-memory-store.ts`, `apps/agent-api/src/project-service.ts`, `apps/agent-api/src/project-routes.ts`, `apps/web/src/ProjectSection.tsx`.
- Workspace and API: `apps/agent-api/src/project-workspace.ts`, `apps/agent-api/src/project-file-routes.ts`, `apps/agent-api/src/company-tool-runtime.ts`, `apps/agent-api/src/company-runtime.ts`, `apps/agent-api/src/app.ts`, `apps/agent-api/src/server.ts`.
- Capabilities: `packages/shared/src/project-file-capabilities.ts`, `packages/shared/src/capability-catalog.ts`, `packages/shared/src/capability-matrix.ts`.
- Web: `apps/web/src/ProjectPage.tsx`, `apps/web/src/CompanyPage.tsx`, `apps/web/src/styles.css`.
- Storage deployment: `docker-compose.scale.yml`.
- Tests: `tests/project-foundation.test.ts`, `tests/project-workspace.test.ts`, `tests/project-files-integration.test.ts`; capability count assertions in existing registry, Inspector and release regression tests now reflect the expanded catalog while retaining checks for original inventory IDs 1–306.

## Verification

- Step 2 Project and integration tests: 19/19 passed, including path traversal, symlink, tenant and workspace isolation, agent permissions, concurrent revisions, approval, ordinary Run execution, API and Inspector visibility.
- `npm run typecheck`: passed across all workspaces. API and web typechecks also passed after the final path and UI changes.
- `npm run build --workspace @npati/agent-api` and `npm run build --workspace @npati/web`: passed. Root `npm run build` stops before compilation because `OMNIROUTE_VERSION` is absent; this was already documented in Step 1.
- `npm run audit:capabilities`: passed for the original 306-item inventory.
- Last full `npm test`: 1,658 passed, 3 failed, 2 skipped. `tests/capability-registry.test.ts` hit its 40-second API timeout only under full-suite load and passes when run alone. The other failures are unrelated to Project files: the pre-existing Business creation-order race in `tests/workspace-store.test.ts`, and the repeat-profile wording assertion in `tests/novascale-exact-regression.test.ts` (also fails when run alone). The 19 Step 1/2 Project tests and 37 focused Project/Company Run/approval tests passed after the final changes.
- No lint script is defined in the root or workspaces. `docker compose -f docker-compose.yml -f docker-compose.scale.yml config --quiet` passed.

## Architecture decisions

- Reuse `company_agent_runs`, the existing Company tool dispatcher, agent allowlist and approval system. No duplicate Project Run or Task tables were created.
- Keep source storage behind `ProjectWorkspace` so later sandbox or remote storage providers can implement the same interface.
- Keep the Project tenant `workspaceId` from Step 1 distinct from the logical ProjectWorkspace path. An optional supplied workspace ID is validated against the server-resolved Project.
- The Files UI is read-only in Step 2; write operations are available only to authorized Company Agents through ordinary Runs.

## Not implemented in Step 2

Sandbox, terminal, preview, Git/GitHub, deploy, manual file editing in the UI, Intent Router changes, multi-agent file coordination beyond revision checks, and ProjectTask/checkpoint tables. These belong to later steps in `docs/website-builder/PLAN.md`.

## Known risks and prerequisites

- Local Project files require a persistent shared volume wherever multiple API instances serve the same tenants. The included scale Compose override now mounts the NPATI data volume; other deployments must configure equivalent shared storage.
- A process crash during a write can leave a `.npati-write-lock` directory. Subsequent writes return `workspace_busy` until an operator removes the stale lock after checking that no writer is active.
- The secret-content filter protects common credential formats but cannot recognize every possible secret. A dedicated secret scanning and vault policy should be added before exposing generated files to untrusted external execution.
- Deleting a Project record does not yet garbage-collect its local source directory. This needs an authorized cleanup or retention policy before production use with sensitive Project files.
- Root build requires the repository's normal `OMNIROUTE_VERSION` setup. The two unrelated full-suite failures above remain open.
