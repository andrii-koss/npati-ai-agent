# NPATI Website Builder — Current State

## Status

- Current phase: Phase 1, Step 4
- Completed steps: Step 0 architecture audit; Step 1 Project foundation; Step 2 ProjectWorkspace and Files capabilities; Step 3 SandboxProvider and Terminal; Step 4 Preview Server, Live Preview, and Changes
- Next step: Step 5 (Intent Router), only on a separate request

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

## Implemented in Step 3

- `SandboxProvider` defines create, start, stop, destroy, command execution, file transfer, port exposure, logs, status, and long-running process operations. The API uses `RemoteSandboxProvider` over signed HTTPS requests. Production configuration rejects loopback runner URLs. The trusted `DockerSandboxProvider` is packaged as a separate runner service and is never instantiated in the API or Company worker. Both API and queued Company worker use the remote provider and shared ProjectWorkspace volume.
- The Docker provider creates one scope-labeled container and internal network per Project, with an unprivileged UID 10001, read-only image, all capabilities dropped, no-new-privileges, CPU/RAM/pids limits, and a size-limited tmpfs workspace. Only the trusted runner host has a Docker socket. The sandbox has no host mounts or host environment secrets. A dedicated egress proxy on the internal network resolves and permits only configured public registry hosts, and checks HTTPS SNI against the approved CONNECT hostname.
- `ProjectSandboxService` resolves Company and Project from the authenticated context, checks the agent's stored Terminal allowlist, validates any supplied sandbox ID against the Project, creates or restarts the sandbox, uploads source files, then synchronizes generated source with expected file revisions. Resource, command, build, output, and inactivity limits are configurable. Idle shutdown checks runner activity before stopping a sandbox, so an API instance does not stop a command recently started by a worker. Archive/delete destroys the sandbox before removing the Project record.
- `project.terminal.exec` and `project.terminal.process` are canonical agent capabilities. The Run planner receives authorized Project IDs when an agent has Terminal. A fail-closed command classifier allows simple read/build commands, controls package installs, and requires existing durable approval for shell composition, destructive and unknown commands, plus use of external credential references. Approval payloads contain hashes of the command and credential references, not raw command or secret values.
- Terminal environment values resolve only through the existing Company encrypted credential repository. Agent prompts and tool inputs carry references. Command output and terminal events redact known values and common credential patterns. Migration 055 adds a Project-scoped terminal event log; Project Terminal and Logs tabs are read-only.
- The active capability catalog and Inspector contain 316 entries: the original 306 plus eight Project Files and two Project Terminal tools. The original 306 inventory audit remains unchanged.

## Step 3 files and modules

- Provider and runner: `apps/agent-api/src/sandbox-provider.ts`, `docker-sandbox-provider.ts`, `sandbox-runner-server.ts`, `sandbox-egress-proxy.mjs`, `terminal-command-policy.ts`; sandbox and proxy Dockerfiles plus `docker-compose.sandbox-runner.yml`.
- Project and Run integration: `apps/agent-api/src/project-sandbox-service.ts`, `project-terminal-events.ts`, `project-terminal-routes.ts`, `project-service.ts`, `company-runtime.ts`, `company-tool-runtime.ts`, `app.ts`, `worker.ts`, and root `docker-compose.yml`.
- Storage and registry: `packages/workspace/src/migration-055.ts`, Project sandbox setters in the workspace stores/types, `packages/shared/src/project-terminal-capabilities.ts` and the canonical catalog/matrix.
- UI and tests: `apps/web/src/CompanyPage.tsx`, `ProjectPage.tsx`, Terminal policy/integration/provider/egress tests, and existing capability count regression tests.

## Step 3 runner deployment

The runner belongs on a **separate, dedicated host**. Build the two sandbox images there with `docker build -f apps/agent-api/Dockerfile.project-sandbox -t npati/project-sandbox:local apps/agent-api` and `docker build -f apps/agent-api/Dockerfile.sandbox-egress -t npati/sandbox-egress:local apps/agent-api`, then start `docker compose -f docker-compose.sandbox-runner.yml up -d --build`. Set a unique `NPATI_SANDBOX_RUNNER_SECRET` of at least 32 characters. Put an HTTPS reverse proxy in front of the runner's host-loopback port 7865, restrict ingress to the API/worker network, and set `NPATI_SANDBOX_RUNNER_URL` and the same secret on API/worker instances. Do not deploy the runner Compose service on an NPATI API host. Keep Docker images and registry allowlist under operator control.

Optional limits: `NPATI_SANDBOX_CPU`, `NPATI_SANDBOX_MEMORY`, `NPATI_SANDBOX_DISK_BYTES`, `NPATI_SANDBOX_PIDS`, `NPATI_SANDBOX_ALLOWED_HOSTS` on the runner; `NPATI_TERMINAL_TIMEOUT_MS` (default 120000), `NPATI_TERMINAL_BUILD_TIMEOUT_MS` (default 600000), `NPATI_TERMINAL_OUTPUT_LIMIT_BYTES` (default 64000), `NPATI_SANDBOX_IDLE_MS` (default 900000), `NPATI_SANDBOX_SYNC_MAX_FILES` (default 500), and `NPATI_SANDBOX_SYNC_MAX_BYTES` (default 20000000) on API/worker instances. Runner configuration must be present on all instances that execute Company Runs. For builds that may use the full 600-second Terminal limit, configure the existing `NPATI_COMPANY_RUN_TIMEOUT_MS` above that limit (including planning/final response time) and `NPATI_COMPANY_RUN_LEASE_MS` above the Run timeout to avoid worker recovery during a build.

## Step 3 verification and limits

- Focused Project foundation, Files, Terminal, approval, and capability tests pass. The full suite completed with 1,705 passed, 2 pre-existing failures (`workspace-store` creation order and `novascale-exact-regression` repeat wording), and 2 skipped. All 48 focused Sandbox/Terminal tests passed after the final process and idle changes.
- Root `npm run typecheck`, API/web builds, and `npm run audit:capabilities` pass. No NPATI lint script is defined. Root `npm run build` is blocked by the existing missing `OMNIROUTE_VERSION` file before compilation.
- No Docker daemon or PostgreSQL test service was available in this workspace, so real remote-runner network isolation, image build, live `npm install && npm run build`, and migration 055 apply/rollback have not been exercised here. The fake-provider integration tests verify Run dispatch, approvals, tenant checks, timeout/error mapping, redaction, revision conflicts, and Terminal APIs.
- A sandbox stopped for inactivity loses its tmpfs dependencies; the next command uploads source files again, and package installation may need to be repeated. The runner has no automatic orphan reconciliation if the API crashes during creation or deletion. Project source directories still retain files after Project deletion, as noted in Step 2. Generated binary files outside ignored build artifacts return `unsupported_binary_file` because the Step 2 ProjectWorkspace stores text content only.
- Preview proxy and port exposure, Git operations beyond ordinary `git status`/`git diff` commands, deployment, manual Terminal input, and multi-agent coordination remain outside Step 3.

## Implemented in Step 4

- `ProjectPreviewService` detects package managers (lockfiles: `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `package-lock.json`, `packageManager` field in `package.json`), frameworks (Next.js, Vite, Astro, Nuxt, Remix, SvelteKit, Static HTML, Python, PHP), dev commands (from `scripts.dev`, `scripts.start`, or framework defaults without hardcoded `npm run dev`), and ports (auto-detected from command flags or framework defaults).
- Authenticated reverse proxy with cryptographically signed HMAC-SHA256 temporary tokens (default 15-minute TTL, refreshed from UI). Tokens are strictly bound to `user + company + project + sandbox`. Expired tokens, cross-project/cross-company tampering, and forged IDs are rejected with 401/403.
- Dev server runs as a sandbox process via `project.terminal.process` and port is exposed through `SandboxProvider.exposePort`.
- Crash & auto-restart monitoring: dev server process status is monitored. On crash or abnormal exit, the service automatically restarts the server up to 3 times. If failures persist, the project transitions to `failed` with captured runtime/build error logs.
- Port-in-use conflicts (e.g. `EADDRINUSE`) are parsed into structured errors.
- Build and runtime errors render styled error state cards in the preview UI rather than showing a blank white iframe.
- Project status transitions (`creating`, `ready`, `working`, `building`, `previewing`, `failed`) and `last_build_status` persist in PostgreSQL and in-memory stores via `updateProjectPreview`.
- Capabilities registered in canonical catalog and Inspector:
  - `project.preview.start` (ID 317)
  - `project.preview.stop` (ID 318)
  - `project.preview.status` (ID 319)
- Agent editor in Company settings includes the "Preview" permission group.
- Changes tracking: `LocalProjectWorkspace.getChanges` and `setBaseline` calculate modified, added, and deleted files with full unified diffs (`--- a/...`, `+++ b/...`, `@@ ... @@`) relative to project baseline.
- Modern ProjectPage UI:
  - Header: project name, status badge, branch pill, framework pill, build status pill, Start/Stop Preview buttons, Open in New Tab, and Refresh.
  - 3-column layout: Files explorer with search and file quick-viewer on the left; Developer Agent Chat thread and prompt composer in the center; Live Preview with Desktop/Tablet/Mobile device mode toggles and reload button on the right.
  - Bottom drawer tabs: Changes (file list with status badges and unified diff viewer with addition/deletion line highlights), Terminal (events and outputs), Logs (raw sandbox/dev server logs), and Activity.
  - Mobile responsive design with tab/panel switching.

## Step 4 files and modules

- Preview service & routes: `apps/agent-api/src/project-preview-service.ts`, `apps/agent-api/src/project-preview-routes.ts`.
- Workspace diffs & baseline: `apps/agent-api/src/project-workspace.ts`.
- Project service & store: `apps/agent-api/src/project-service.ts`, `packages/workspace/src/types.ts`, `packages/workspace/src/postgres-store.ts`, `packages/workspace/src/in-memory-store.ts`.
- Capabilities & Matrix: `packages/shared/src/project-preview-capabilities.ts`, `packages/shared/src/capability-catalog.ts`, `packages/shared/src/capability-matrix.ts`, `packages/shared/src/index.ts`.
- Agent runtime: `apps/agent-api/src/company-tool-runtime.ts`, `apps/agent-api/src/company-runtime.ts`, `apps/agent-api/src/app.ts`.
- Sandbox provider: `apps/agent-api/src/docker-sandbox-provider.ts`, `apps/agent-api/src/sandbox-runner-server.ts`, `apps/agent-api/src/project-sandbox-service.ts`.
- Web UI: `apps/web/src/ProjectPage.tsx`, `apps/web/src/ProjectSection.tsx`, `apps/web/src/CompanyPage.tsx`, `apps/web/src/styles.css`.
- Tests: `tests/project-preview.test.ts`.

## Step 4 verification

- `tests/project-preview.test.ts`: 19/19 passed, covering stack detection, token signing & security validation, dev server start/stop, auto-restart crash limits, error card rendering, unified diff calculation, capability inspection, and end-to-end acceptance run.
- All 5 project test suites: 47/47 passed (`project-workspace`, `project-sandbox-provider`, `project-files-integration`, `project-preview`, `project-terminal-integration`).
- Capability matrix audit: `npm run audit:capabilities` passed 100% (306/306 core items validated with 0 gaps/duplicates).
- Monorepo typecheck: `npm run typecheck` passed with code 0 across all workspaces.
- Production builds: `npm run build --workspace=@npati/agent-api` and `npm run build --workspace=@npati/web` built successfully.
