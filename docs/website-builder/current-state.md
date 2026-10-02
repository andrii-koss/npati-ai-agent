# NPATI Website Builder â€” Current State

## Status

- Current phase: Phase 1, Step 5 (Completed)
- Completed steps: Step 0 architecture audit; Step 1 Project foundation; Step 2 ProjectWorkspace and Files capabilities; Step 3 SandboxProvider and Terminal; Step 4 Preview Server, Live Preview, and Changes; Step 5 Intent Router, Active Project Context, Activity & Run Trace
- Next step: Step 6 (Git & Checkpoints), only on a separate request

## Source of truth

- Roadmap: `docs/website-builder/PLAN.md`
- Architecture audit: `docs/website-builder/00-audit.md`
- Repository code remains authoritative where it differs from the roadmap.

## Implemented in Step 1

- Project model and store contract with Company/tenant ownership, status, type, metadata, revision and timestamps.
- PostgreSQL migration 054 creates `projects`, a nullable `company_agent_runs.project_id` FK, and a rollback function. Existing Company runs remain valid without a Project.
- PostgreSQL and in-memory stores implement create, list, get, rename, archive and delete. Project access is scoped to authenticated workspace, Company and owner. Archived projects are hidden by default.
- `ProjectService` validates input and Company access. Routes under `/companies/:companyId/projects` use existing authentication permissions: `workspace:read` for reads and `business:manage` for mutations. Create supports an idempotency key; rename/archive use `expectedRevision`.
- Settings â†’ Company includes Project cards, creation dialog and Open/Rename/Archive/Delete actions. Import repository and Upload project display as coming soon.

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
- Tests: `tests/project-foundation.test.ts`, `tests/project-workspace.test.ts`, `tests/project-files-integration.test.ts`; capability count assertions in existing registry, Inspector and release regression tests now reflect the expanded catalog while retaining checks for original inventory IDs 1â€“306.

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

## Implemented in Step 5

- Extended existing `HybridRouter` with 14 canonical project intents: `CREATE_PROJECT`, `CREATE_WEBSITE`, `EDIT_PROJECT`, `EDIT_WEBSITE`, `CONTINUE_PROJECT`, `DEBUG_PROJECT`, `REVIEW_PROJECT`, `IMPROVE_PROJECT`, `TEST_PROJECT`, `BUILD_PROJECT`, `PREVIEW_PROJECT`, `CONNECT_REPOSITORY`, `COMMIT_PROJECT`, `DEPLOY_PROJECT`. Executable in Step 5: `CREATE_*`, `EDIT_*`, `CONTINUE_PROJECT`, `DEBUG_PROJECT`, `BUILD_PROJECT`, `PREVIEW_PROJECT`, `TEST_PROJECT`. Unsupported intents (Git, Deploy, Review, Improve) are recognized with clear explanatory messages indicating their roadmap release phases.
- Context-aware classification: Pure explanations ("Ð©Ð¾ Ñ‚Ð°ÐºÐµ Next.js?", "What is React?") take precedence and route to `CHAT`. Website creation prompts route to `CREATE_WEBSITE`/`CREATE_PROJECT`. Modification prompts with an active project context route directly to `EDIT_PROJECT`, while prompts without an active project ask for project clarification.
- Active Project Context in chat: `active_company_id`, `active_project_id`, `active_workspace_id`. Stored in chat state and persisted in session storage. Resolved fail-closed on the server via `ActiveContextResolver`, strictly validating that the project belongs to the user's active company and workspace and is not archived.
- Project Manager as orchestration layer (`ProjectOrchestrator`): Operates on top of existing `CompanyDelegationRuntime` (single mode). Specialist agents are selected based on role keywords, semantic descriptions, system instructions, and tool capabilities (`project.files.*`, `project.terminal.*`), NEVER checking `agent.name`. Falls back to the Company's Main Agent.
- Targeted edits mandate: Injected system instructions enforce "surgical, targeted edits, not blind rewrite", requiring agents to search and inspect relevant files before modifying.
- Shared Project Context: `PROJECT.md` in project root with purpose, tech stack, conventions, and status; updated after runs; separated from Company Memory and without secrets.
- Build repair loop: Automatically runs dev/build checks with up to 3 repair attempts on failure. If the limit is reached, transitions run to `failed` with captured error details (`step`, `tool`, `retryable: false`).
- Activity & Run Trace integration: Runs are linked to projects via `company_agent_runs.project_id`. The Project page includes an Activity tab with "View Run â†’" buttons linking directly to `/activity?runId=...`. Activity trace displays a `ðŸŒ� Project` pill and "Open Project â†’" button.
- Chat UX: Interactive Project card in chat showing title, status badge, framework, build status, assigned agent, and action buttons (`Open Project`, `Preview`, `Changes`, `View Run`).
- Company enforcement: Creating a website from chat requires an active Company. Prompts user to select or create a company if none is active; never silently creates a company.

## Step 5 files and modules

- Router & intents: `packages/shared/src/project-intent.ts`, `packages/shared/src/hybrid-router.ts`, `packages/shared/src/index.ts`.
- Workspace stores & types: `packages/workspace/src/types.ts`, `packages/workspace/src/postgres-store.ts`, `packages/workspace/src/in-memory-store.ts`.
- Orchestrator & resolver: `apps/agent-api/src/project-orchestrator.ts`, `apps/agent-api/src/active-context-resolver.ts`, `apps/agent-api/src/company-runtime.ts`, `apps/agent-api/src/project-preview-routes.ts`, `apps/agent-api/src/app.ts`.
- Web UI & styles: `apps/web/src/BusinessWorkspace.tsx`, `apps/web/src/ProjectPage.tsx`, `apps/web/src/ActivityPage.tsx`, `apps/web/src/styles.css`.
- Tests: `tests/project-intent-router.test.ts`.

## Step 5 verification

- `tests/project-intent-router.test.ts`: 14/14 passed, covering EN/UK intent classification, explanation vs creation, active project edit vs unattached edit clarification, future intent rejection, agent selection by role/capabilities, tenant isolation, PROJECT.md creation, build repair loop limits, self-healing recovery, and run trace linking.
- All 9 project test suites: 100/100 passed (`project-foundation`, `project-files-integration`, `project-workspace`, `project-preview`, `project-terminal-integration`, `project-terminal-policy`, `project-sandbox-egress`, `project-sandbox-provider`, `project-intent-router`).
- Hybrid router suite: 13/13 passed (`tests/hybrid-router.test.ts`).
- Capability matrix audit: `npm run audit:capabilities` passed 100% (306/306 core items validated).
- Monorepo typecheck: `npm run typecheck` passed with code 0 across all 12 workspaces.
- Production builds: `npm run build --workspace=@npati/agent-api` and `npm run build --workspace=@npati/web` built successfully.

## Step 6 review of Steps 3–5

- Step 3 project file and terminal boundaries, Step 4 preview and workspace diff, and Step 5 project intents and orchestration were checked against their source modules and regression suites. Project data remains scoped through the existing Company and Workspace stores; the Git layer uses the same project lookup.
- The Step 5 regression suite now treats `COMMIT_PROJECT` and `CONNECT_REPOSITORY` as executable. Deploy, Review, and Improve remain future work.
- The Project workspace is the local source mirrored into the remote execution sandbox. Git runs against this scoped local workspace; the remote sandbox continues to run terminal and preview processes.

## Implemented in Step 6

- Git service and authenticated project routes provide status, diff, log, branch, stage, commit, file restore, checkpoint create/list/restore. Git hooks are disabled for service commands; staging and commits reject protected paths. Paths and project identity are validated before access.
- Checkpoints are persisted in `project_checkpoints` via migration 056 and point to Git commits retained by `refs/npati/checkpoints/*`. A restore creates a pre-restore checkpoint first. Pre-run and successful post-run checkpoints are automatic; file and line thresholds are configurable with `NPATI_CHECKPOINT_FILE_THRESHOLD` and `NPATI_CHECKPOINT_LINE_THRESHOLD`.
- Project page shows checkpoint history, names, descriptions, commit hashes, and Restore. The agent editor has a Git permission group. Git capabilities are registered in the catalog and matrix with risk and confirmation metadata.
- `COMMIT_PROJECT` creates a real commit and checkpoint. `CONNECT_REPOSITORY` validates and persists a credential-free GitHub HTTPS URL in Project metadata.
- GitHub push and pull request creation execute only through the Company tool runtime's existing approval flow. Direct HTTP push/PR routes reject requests, including client-supplied `approved` flags and tokens. Agent calls use a Company vault credential UUID whose `token` field is resolved server-side. Remote errors do not return credentials or Git command output.
- Conflicted Git indexes produce structured `GIT_CONFLICT` errors with affected paths. The service does not choose conflict sides automatically; it immediately escalates to the user, staying below the two-attempt limit.

## Step 6 verification and limits

- Git/checkpoint tests cover commit/diff/file restore, checkpoint restore and pre-restore backup, URL validation, forged HTTP approval, token non-disclosure, tenant isolation, traversal rejection, and conflict preservation.
- The root `npm run build` command is blocked by a missing repository `OMNIROUTE_VERSION` file during catalog generation; direct API and web workspace builds are used to validate the Step 6 code.
- No live GitHub push or pull request was performed; that path requires a configured Company vault credential, approved Company run, and external GitHub access. Git runs on the scoped local Project workspace that syncs with the remote sandbox, rather than inside the remote container.
- Final checks: `npm run typecheck` passed; API and web workspace builds passed; `npm run audit:capabilities` passed for the original 306 inventory entries; Git/checkpoint tests passed (13/13). Full `npm test`: 1754 passed, 2 skipped, 1 failed. The remaining failure is `tests/novascale-exact-regression.test.ts`, where the existing Business Profile chat path says "created" on a repeat request instead of "already exists"; it is outside the Website Builder Step 6 code. No workspace defines a lint script.
- `COMMIT_PROJECT` and `CONNECT_REPOSITORY` now record completed Company Runs linked to the Project, so Activity can show these actions. Their integrated intent test passed (15/15 in the Step 5/6 intent suite).

## Implemented in Step 7

- Empty Projects can import a GitHub repository or upload a ZIP from the Project page. The import uses the existing Project, Company Run, sandbox, workspace, Git connection, Company credential vault, and Preview services.
- Repository clone executes only inside the scoped sandbox, with a 120-second default timeout (300-second maximum), shallow single-branch checkout, and a credential-free GitHub URL. For private repositories, a Company vault credential ID resolves a `token` field server-side; the token is passed as command environment data and is never included in the Git command, Project metadata, API response, or Run result. Client-supplied raw tokens are rejected.
- ZIP uploads are limited to 10 MiB compressed, 20 MiB expanded, 500 text files, and 1 MiB per file. ZIP paths, duplicate names, symlinks, unsupported compression, encrypted entries, and excessive compression ratios are rejected before workspace writes. Repository imports use the same file count, content, and path limits before local writes.
- Imported source is inspected with the existing stack detector. The service creates `PROJECT.md` when absent, sets the workspace baseline, installs dependencies inside the sandbox using the detected package manager, and starts Live Preview. A linked Company Run records completion or failure; install failures mark the Project failed and do not start Preview.
- No database migration or new capability was needed for this step.

## Step 7 verification and limits

- `tests/project-import.test.ts` covers ZIP slip and bomb rejection, Vite ZIP and Next.js repository flows, large repository rejection, denied private repository access without token disclosure, failed install, tenant isolation, and sandbox-only clone with environment-based credentials.
- Live GitHub clone and a real remote sandbox Preview were not available in this workspace, so the end-to-end external acceptance flow still requires manual verification with a configured sandbox runner and reachable GitHub repository.
- Imports require an empty Project workspace and source files supported by the existing text-only Project workspace. Binary assets, protected secret paths, and files over 1 MiB are rejected. A failed install leaves imported files available for inspection; retry requires a new empty Project.- Final checks for Step 7: focused import tests 9/9 passed; monorepo typecheck passed; API and Web production builds passed. The full suite had 1,764 passed, 2 skipped, and the same pre-existing NovaScale repeat-response failure recorded in Step 6. Root build remains blocked before compilation by the missing `OMNIROUTE_VERSION` file. No workspace lint script is defined.

## Implemented in Step 8

- Multi-agent orchestration for Project development builds on top of the existing Company execution engine (`CompanyDelegationRuntime`, `pipeline` mode, `ProjectMultiAgentService`) without creating a separate engine.
- Main Agent plans website implementation tasks and decomposes them into a directed acyclic graph (DAG) with explicit `depends_on` relationships and safe file scopes. Enforces that Design precedes implementation, QA follows all implementation tasks, and SEO can run in parallel with frontend development once page structure is defined. Cycles and path traversal are rejected fail-closed.
- Specialist agents are selected based on role keywords, semantic descriptions, system instructions, guidelines, capabilities (`tools`), model availability, and hierarchy edges (`selectProjectTaskAgent`), never checking `agent.name`. If fewer than two active project specialists exist, execution cleanly falls back to single-agent mode.
- Parallel execution is restricted strictly to tasks without file scope conflicts (`taskScopesConflict`).
- Hierarchical file locking and leases are implemented in `ProjectFileLeaseManager`:
  - Scopes can lock individual files or entire directories with configurable TTL (`NPATI_FILE_LOCK_TTL_MS`, default 30s).
  - Deadlock prevention via canonical lexicographical sorting of requested paths, plus wait-for graph cycle detection that immediately fails with `deadlock_detected` on circular wait. Contention wait times out with `lock_timeout`.
  - Immediate lease release when an agent task finishes or crashes, and automatic background eviction of expired leases.
  - Runtime tool execution in `CompanyToolRuntime` verifies active leases before `create`, `write`, `edit`, `delete`, or `move` operations, blocking conflicting concurrent edits with 409 status.
- SHA-256 `expectedRevision` optimistic concurrency with automatic 3-way line merge retry loop (up to 3 attempts). On base content unavailability, overlapping line edits, or retry exhaustion, execution cleanly escalates to the Main Agent.
- Context isolation and peer status visibility: Each specialist agent is passed its specific task, role, peer task statuses (`queued/running/completed/failed/waiting`), allowed file scope, Project Context, dependencies, and outputs of prior tasks. Raw conversation history is isolated (`noMemory: true`).
- QA loop: `implementation -> build/preview -> QA inspection -> issues -> Developer targeted repair` with a strict limit of 2 iterations, returning a final report with open issues if repairs fail.
- `IMPROVE_PROJECT`: Designer, Frontend, SEO, QA, and Security specialists analyze the project in parallel with tools suppressed (`suppressTools: true`). The Main Agent then synthesizes their findings into an improvement plan and dependency-ordered tasks without rewriting the entire website.
- Model call budget: `NPATI_PROJECT_MAX_MODEL_CALLS` (default 40, max 100). Passes `callBudget` to the delegation runtime; when exhausted, terminates execution immediately with `MODEL_CALL_BUDGET_EXCEEDED` and transitions remaining queued tasks to `waiting`.
- UI:
  - Activity Page displays the "Project task plan" with statuses, agent IDs, roles, and dependencies (`After: ...`), and "Agent team" badge list.
  - Project Page Activity tab displays run history with agent team badges, task rows with status pills, and task dependencies.
- Parent runs persist step delegations to the workspace store via `replaceCompanyAgentRunSteps`, populating first-class delegation steps in `CompanyAgentRunDetails`.

## Step 8 verification and limits

- `tests/project-multi-agent.test.ts`: 16/16 passed, covering parallel execution of independent scopes, serialized conflicting paths, non-hanging execution on agent crash, cycle and path traversal rejection, disjoint 3-way line merging, overlapping edit escalation, hierarchical file lock conflict detection, deadlock prevention and timeout, immediate release on crash, TTL auto-eviction, 2-iteration QA review/repair loop, model call budget limit enforcement, peer task status visibility and context isolation, IMPROVE_PROJECT multi-agent analysis without tool execution, and Company delegation modes regression.
- Project test suites: 75/75 passed across 7 project test files (`project-foundation`, `project-files-integration`, `project-workspace`, `project-git-checkpoints`, `project-import`, `project-intent-router`, `project-preview`).
- Capability matrix audit: `npm run audit:capabilities` passed 100% (306/306 core items validated).
- Monorepo typecheck: `npm run typecheck` passed with code 0 across all 12 workspaces.
- Production builds: `npm run build --workspace=@npati/agent-api` and `npm run build --workspace=@npati/web` built successfully.
- Full test suite baseline: unaffected, with existing 2 pre-existing suite failures unchanged.