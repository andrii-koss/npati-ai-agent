# NPATI Website Builder â€” Current State

## Status

- Current phase: Phase 2, Step 11 (Browser QA implemented; live runner validation pending)
- Completed steps: Step 0 architecture audit; Step 1 Project foundation; Step 2 ProjectWorkspace and Files capabilities; Step 3 SandboxProvider and Terminal; Step 4 Preview Server, Live Preview, and Changes; Step 5 Intent Router, Active Project Context, Activity & Run Trace; Step 6 Git & Checkpoints; Step 7 Project Import & Templates; Step 8 Multi-Agent Orchestration; Step 9 Agent Worktrees; Step 10 DeployProvider & Dokploy Integration; Step 11 Browser QA
- Next step: none in this roadmap; do not start another step automatically

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

Two deployment modes are supported:

- **REMOTE** (default): keep the runner on a separate host with `NPATI_SANDBOX_RUNNER_MODE=remote`, an HTTPS `NPATI_SANDBOX_RUNNER_URL`, and the shared `NPATI_SANDBOX_RUNNER_SECRET` (at least 32 characters). Start `docker-compose.sandbox-runner.yml` on that host with `NPATI_SANDBOX_RUNNER_ISOLATED_HOST=true`. Keep HTTPS ingress restricted to API and worker.
- **LOCAL_DOKPLOY**: set `NPATI_SANDBOX_RUNNER_MODE=local`, `NPATI_SANDBOX_RUNNER_URL=http://sandbox-runner:7865`, and the same 32-character secret on agent-api, company-worker, and runner. Set a stable `NPATI_PREVIEW_SECRET` on agent-api so signed browser preview URLs remain valid across API restarts. The `local-sandbox` Compose profile builds `npati/project-sandbox:local` and `npati/sandbox-egress:local` as completed image jobs before starting the runner; both tags must exist on the host Docker daemon. Set `COMPOSE_PROFILES=local-sandbox` in Dokploy, or start with `docker compose --profile local-sandbox -f docker-compose.dokploy.yml up -d --build`. The runner has no published port and is reachable only over `npati-sandbox-control`, an internal Docker network shared with API and worker.

Both modes route Live Preview as browser -> authenticated agent-api route -> HMAC-authenticated runner request -> dev server inside the scoped sandbox. Agent-api never joins per-sandbox networks and never connects to a sandbox container IP. The runner verifies the sandbox scope before forwarding. Docker socket access gives the local runner control over Docker on that VPS; restrict who can change its image, environment, and control network.

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

## Implemented in Step 9

- Isolated Git worktrees and branches per specialist agent (`agent/{slug}`, e.g. `agent/frontend`, `agent/seo`, `agent/designer`).
- Base branch `project/main` created automatically and checked out before allocating agent worktrees.
- Strict isolation between branches: changes written in one agent's worktree remain isolated on its branch and are completely invisible in other agents' worktrees until reviewed and merged into `project/main`.
- Completion pipeline:
  1. **Review**: Generates unified diff of agent's changes against `project/main` (`git diff project/main...agent/{slug}`).
  2. **Merge**: Merges the agent's branch into `project/main` using `git merge --no-ff` under a serialized per-project mutex lock (`mergeLocks`) to prevent Git index corruption during concurrent merges.
  3. **Build**: Verifies preview and build status (`projectPreviewService.buildProject()`).
- Structured merge conflict escalation:
  - Detects conflict state and extracts conflicting paths via `git diff --name-only --diff-filter=U`.
  - Aborts in-progress merge cleanly using `git merge --abort`.
  - Appends a structured audit event (`project-merge-conflict`) containing conflicting paths, agent ID, and branch.
  - Throws `GitConflictEscalationError` with details (`conflictingFiles`, `branch`, `targetBranch`) for structured escalation.
- Dual-mode support (Backward compatibility with Step 8):
  - Preserves Step 8 shared-workspace mode without breaking changes.
  - Switchable via `worktreeMode` option in `ProjectMultiAgentService` or `NPATI_PROJECT_WORKTREE_MODE` environment variable (`true`/`1` to enable, defaults to false/shared-workspace).
- Comprehensive worktree cleanup:
  - Cleans up individual agent worktrees upon task completion or error (`removeAgentWorktree`).
  - Batch cleanup (`cleanupAllWorktrees`) runs in the outer orchestrator `finally` block to guarantee no dangling worktree directories or Git refs remain even if agent execution crashes or is aborted.
- Security and tenant isolation:
  - `safeAgentSlug` strictly rejects paths containing path traversal characters (`/`, `\`, `..`).
  - `.worktrees` directory is protected in `LocalProjectWorkspace.safeProjectPath` and hidden from `tree`, `getChanges`, and `setBaseline`.
  - `.worktrees` and `.npati-worktrees` are automatically ignored in the repository's `.gitignore`.
  - Tenant isolation verified: Tenant B cannot access or create worktrees for Tenant A's project.
- Filesystem workspace routing:
  - `LocalProjectWorkspace` supports optional `agentId` on all file operations (`read`, `write`, `edit`, `delete`, `move`, `list`, `tree`, `search`).
  - When an agent worktree is registered via `registerWorktree(agentId, worktreePath)`, all file operations for that agent transparently route to its isolated worktree directory.
  - Unregistering via `unregisterWorktree(agentId)` restores default workspace routing.

## Step 9 verification and limits

- `tests/project-git-worktrees.test.ts`: 10/10 passed, covering:
  1. Creation of isolated worktree and branch from `project/main`.
  2. Strict isolation between agent branches.
  3. Review -> merge pipeline and `project/main` update.
  4. Merge conflict detection, clean `git merge --abort`, and `GitConflictEscalationError` throwing.
  5. Individual agent worktree cleanup and `git worktree prune`.
  6. Batch agent worktree cleanup.
  7. `LocalProjectWorkspace` routing to worktree when registered.
  8. Prevention of worktree path traversal attacks.
  9. Tenant isolation enforcement between tenants.
  10. Full multi-agent workflow execution in worktree mode with review, merge, and events.
- Regression test suites:
  - `tests/project-multi-agent.test.ts`: 16/16 passed (Step 8 shared-workspace mode unchanged).
  - All 13 project test suites: 149/149 passed.
- Monorepo typecheck: `npm run typecheck` passed with code 0 across all 13 workspaces.
- Capability matrix audit: `npm run audit:capabilities` passed 100% (306/306 catalog entries, all test files intact).
- Production builds: `npm run build --workspace=@npati/agent-api` and `npm run build --workspace=@npati/web` built successfully with 0 errors.

## Implemented in Step 10: DeployProvider & Dokploy Integration

- **DeployProvider Interface & Dokploy Adapter**:
  - Defined pluggable `DeployProvider` interface in `apps/agent-api/src/deploy-provider.ts` with `name`, `validateConfig`, `deploy`, `checkStatus`, and `rollback`.
  - Implemented `DokployDeployProvider` supporting deployment to Dokploy via REST API (`/api/application.deploy`).
  - Strict HTTPS endpoint validation; strips any embedded credentials in URLs; rejects insecure HTTP endpoints in production.
  - Token and secret redaction (`redactMessage`): authorization tokens and secrets are strictly redacted from error messages, output payloads, and logs to eliminate credential leakage.
  - Supports configurable transport (`typeof fetch`) allowing isolated unit and integration testing without live external infrastructure.

- **ProjectDeployService & Preflight Checks**:
  - `ProjectDeployService` in `apps/agent-api/src/project-deploy-service.ts` provides complete deployment lifecycle orchestration.
  - **Preflight Inspection**: Before approval or deployment, computes a comprehensive preflight summary displaying:
    1. **Environment**: Production, Staging, or Preview.
    2. **Branch**: Current Git branch (`gitStatus.branch` or fallback).
    3. **Files changed**: Total count, staged, unstaged, and untracked file lists.
    4. **Build status**: Current project build health (`ready`, `building`, `failed`).
    5. **Tests**: Test status (`passed`, `failed`, `skipped`).
    6. **Target**: Hosting provider name, sanitized target endpoint, application/project ID, and domain.
  - **High-Risk Approval Enforcement**:
    - Deploy is strictly classified as a high-risk operation (`risk: "high"`, `requiresConfirmation: true`).
    - Attempting deployment without confirmed approval throws `DeployApprovalRequiredError` with status 403, returning the complete preflight summary and approval payload for human confirmation.
    - Approval gating integrates with NPATI's existing durable approval mechanism (`durableApprovals` / `riskApprovalService`).
  - **Credential Security & Tenant Isolation**:
    - Raw API tokens, passwords, and keys in request payloads are strictly forbidden (`raw_credential_forbidden` error).
    - Credentials must reference a `credentialId` from the Company encrypted vault (`resolveCredential`), scoped to the authenticated tenant/company.
    - Tenant isolation: Tenants cannot deploy or inspect other tenants' projects or access vault credentials outside their company.
  - **Post-Deploy Operations**:
    - Records deployment in `project_deployments` store with commit hash, provider, environment, target URL, and execution duration.
    - Updates Project preview/deploy attributes: `deploymentUrl`, `deploymentStatus: "deployed"`, and `lastDeployedAt`.
    - Automatically creates a post-deployment Git safety checkpoint (`Deploy: <environment>`).

- **Database Migration 057**:
  - Created `packages/workspace/src/migration-057.ts` adding table `project_deployments` (with composite foreign key to `projects`, status checks, and descending timestamp index) and adding `deployment_url`, `deployment_status`, `last_deployed_at` to `projects`.
  - Full rollback function `rollbackMigration057` provided.
  - Implemented store methods in `InMemoryWorkspaceStore` and `PostgresWorkspaceStore`: `createProjectDeployment`, `listProjectDeployments`, `getProjectDeployment`, `updateProjectDeployment`, and updated `updateProjectPreview`.

- **Intent Router & Orchestrator**:
  - Intent `DEPLOY_PROJECT` is fully working and executable with active project context in `packages/shared/src/project-intent.ts`.
  - Matches deploy prompts in Ukrainian (e.g., "Задеплой проєкт на продакшн dokploy", "опублікуй сайт") and English (e.g., "Deploy this website to Dokploy production", "deploy to dokploy").
  - `ProjectOrchestrator` handles `DEPLOY_PROJECT` intent, selecting specialist agents with deploy capabilities and executing deployment with preflight and approval validation.

- **Capabilities & Permission Matrix**:
  - `project.deploy.publish` (Inventory ID 331, risk: high, requiresConfirmation: true) for triggering deployments.
  - `project.deploy.status` (Inventory ID 332, risk: low, requiresConfirmation: false) for inspecting deployment status and target URLs.
  - Mapped to test suite `tests/project-deploy.test.ts`.
  - Added "Deploy" permission group toggle in Company agent editor drawer (`CompanyPage.tsx`).

- **Web UI & Project Page**:
  - Added "Deploy" bottom tab to `apps/web/src/ProjectPage.tsx` with:
    - Environment selector (Production / Staging).
    - Preflight inspection button displaying Environment, Branch, Files changed, Build status, Tests, and Target.
    - Company Vault Credential ID input for Dokploy.
    - Deploy trigger button with confirmation.
    - Historical deployments list showing status, provider, environment, commit hash, timestamp, and target link.
    - Live site button (🚀) in project header linking directly to the deployed production site.
  - Added responsive CSS styling in `apps/web/src/styles.css`.

## Step 10 verification and limits

- `tests/project-deploy.test.ts`: 9/9 passed, covering:
  1. Comprehensive preflight summary generation (Environment, Branch, Files changed, Build status, Tests, Target).
  2. Deploy without approval blocked with 403 `approval_required` and preflight payload.
  3. Forged and mismatched approval token rejection.
  4. Successful deployment execution when approval is granted, updating store and project record.
  5. Raw credentials strictly forbidden in request payload.
  6. Credential leakage prevention: tokens masked with `[REDACTED]` from error messages and logs.
  7. Tenant and project isolation enforcement.
  8. Dokploy endpoint URL validation and non-HTTPS rejection in production.
  9. `DEPLOY_PROJECT` intent classification and capability matrix registration.
- Project test suites regression: 85/85 passed across all 8 project suites:
  - `tests/project-deploy.test.ts` (9/9 passed)
  - `tests/project-git-checkpoints.test.ts` (13/13 passed)
  - `tests/project-git-worktrees.test.ts` (10/10 passed)
  - `tests/project-preview.test.ts` (19/19 passed)
  - `tests/project-files-integration.test.ts` (4/4 passed)
  - `tests/project-terminal-integration.test.ts` (10/10 passed)
  - `tests/project-import.test.ts` (9/9 passed)
  - `tests/project-workspace.test.ts` (11/11 passed)
- Capability matrix audit: `npm run audit:capabilities` passed 100% (306/306 core entries, 0 gaps, 0 duplicates).
- Monorepo typecheck: `npm --prefix packages/workspace run typecheck`, `npm --prefix packages/shared run typecheck`, `npm --prefix apps/agent-api run typecheck`, `npm --prefix apps/web run typecheck` all passed with code 0.
- Production builds: `npm --prefix apps/agent-api run build` and `npm --prefix apps/web run build` succeeded with 0 errors.
## Steps 1–11 verification (2026-10-02)

| Step | Implementation evidence | Focused verification |
| --- | --- | --- |
| 1 Project | `project-service.ts`, `project-routes.ts`, migration 054 | `project-foundation.test.ts` |
| 2 Workspace/Files | `project-workspace.ts`, `project-file-routes.ts` | `project-workspace.test.ts`, `project-files-integration.test.ts` |
| 3 Sandbox/Terminal | `sandbox-provider.ts`, `docker-sandbox-provider.ts`, `project-sandbox-service.ts` | `project-sandbox-provider.test.ts`, `project-terminal-*.test.ts` |
| 4 Preview | `project-preview-service.ts`, `project-preview-routes.ts` | `project-preview.test.ts` |
| 5 Intent/Trace | `project-intent.ts`, `project-orchestrator.ts` | `project-intent-router.test.ts` |
| 6 Git/Checkpoints | `project-git-service.ts`, migration 056 | `project-git-checkpoints.test.ts` |
| 7 Import/Templates | `project-import-service.ts` | `project-import.test.ts` |
| 8 Multi-agent | `project-multi-agent.ts`, `project-task-graph.ts` | `project-multi-agent.test.ts` |
| 9 Worktrees | `project-git-service.ts` worktree methods | `project-git-worktrees.test.ts` |
| 10 Deploy | `project-deploy-service.ts`, migration 057 | `project-deploy.test.ts` |
| 11 Browser QA | `project-browser-qa-service.ts`, sandbox runner operation, migration 058 | `project-browser-qa.test.ts` |

All 15 project test suites passed (163 tests). This verifies repository behavior with mocks and local services, not a live Docker browser or production infrastructure.

## Step 11 Browser QA

- Added `project.qa.inspect` and `project.qa.report` to the existing capability catalog, matrix, Company tool runtime and Inspector. The QA tab uses Company-scoped routes and durable project reports.
- QA runs in a dedicated, short-lived Playwright container attached only to the verified project's internal sandbox network. The runner checks the sandbox scope before launch. It opens only that sandbox's preview host and port, blocks browser requests to other origins, and checks local links without following redirects.
- The runner records browser console error counts, HTTP status, local broken links, basic DOM accessibility checks, navigation/resource timing, rendered HTML byte size and a viewport screenshot. The screenshot is rendered from viewport element geometry using neutral blocks; it never copies page text, media, CSS images or source pixels. Raw page HTML, console text, URL query parameters and secrets are not returned in reports or agent tool results.
- QA input is bounded to local paths, known viewports, 1–60 seconds, 50 KB–2 MB screenshot size, and up to 50 local links. The Docker runner has CPU, memory, PID and temporary disk limits, a read-only filesystem, no mounted workspace or credentials, no direct external network, and removes its container after execution.
- Migration 058 stores scoped reports in the existing workspace migration system. Read and write operations first resolve the authenticated Company and Project. Agent calls also check the agent's persisted capability allowlist. Tool responses omit screenshot bytes; authorized UI report reads can display the redacted image.
- Start the Project preview before running QA. The QA action never silently starts a dev server or executes package commands. Multi-agent QA fails closed if the browser runner cannot return results.

### Step 11 deployment and manual check

On the dedicated sandbox runner host, build `docker build -f apps/agent-api/Dockerfile.browser-qa -t npati/browser-qa:local .` and configure `NPATI_BROWSER_QA_IMAGE` on the existing runner service. Apply migration 058 through the normal API startup migration path. Start a Project preview, open its QA tab, run desktop and mobile inspections, inspect issues and the saved report, then verify another Company cannot read the report. An old sandbox can be inspected because the runner targets its verified container name directly.

### Step 11 verification and limits

- Project suites: 163/163 passed. Root typecheck, API build, web build, sandbox-runner Compose config and the 306 baseline capability audit passed.
- Full suite after updating stale catalog assertions: 1804 passed, 1 failed, 2 skipped. The sole failure is the previously documented NovaScale repeat-profile wording assertion (`novascale-exact-regression.test.ts`). The earlier 330/66 count assertions and the ID upper bound were updated to 334/70.
- No root or workspace lint script exists. Root `npm run build` stops before compilation because `OMNIROUTE_VERSION` is absent; API and web builds pass separately. A live Playwright image build and end-to-end browser run were not exercised in this environment; the Docker path, image and migration apply/rollback require deployment validation.
- The screenshot is a redacted layout wireframe and supports position/spacing review rather than text, color or image comparison. Basic a11y checks are not a full WCAG audit. Link checking is limited to local links. A compromised preview can still attack the browser process inside the isolated QA container; keep the runner host dedicated and current.
## Chat end-to-end verification (2026-10-02)

- The exact hosting-company request with Next.js and Live Preview originally resolved to `PREVIEW_PROJECT` before a Project existed. Creation now takes precedence when one request also asks for preview; the result is `CREATE_WEBSITE` with the Next.js target.
- Ordinary web Chat uses `/chat/stream`. That route now sends Project intents through the existing Project Orchestrator and returns Project context, card, action, conversation and Company run ID. The web client sends the active Project ID for the next turn, scoped to the active Company. A new create intent starts a new Project even when an older Project is active.
- `tests/website-builder-chat-e2e.test.ts` injects both exact user requests through `/chat/stream` with an isolated in-memory Company and an AI test double. It verifies one Project is created, the follow-up targets that same Project, `PROJECT.md` exists, and Changes, Activity and Run Trace endpoints respond. The selected agent is recorded in the run. The requested framework is stored on the Project.
- This test does not claim a generated Next.js site: the AI test double does not write application files. It confirms a failed build state and no Preview URL when the sandbox runner is absent. The runner requires a dedicated isolated host; the local Docker Desktop runs the main NPATI stack and is not suitable for that runner. Dependencies, a real Next.js build, browser QA, and Live Preview remain unverified in a live deployment.
- Verification: 16 focused tests passed; monorepo typecheck and separate API and web builds passed. Full suite: 1805 passed, 2 skipped, 1 pre-existing NovaScale repeat-profile wording assertion failed. No lint script is defined.