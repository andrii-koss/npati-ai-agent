# NPATI Coding Agent — Current State

Update this file after every completed step.

## Current step
- Last completed: **C1 — Code Project & Workspace foundation** (plus the C0 audit in `00-audit.md`)
- Next: **C1c — tamper-evident audit log** (then C1a feature flags/versioning, then C1b images), per the hard order in `docs/coding-agent/00-audit.md` section 13.

## Implemented
- **`code_project` project type** on the existing `Project` entity (no new entity): the enum and CHECK
  constraint were extended additively, so Website Builder projects keep working unchanged.
- **Classification and retention** exist on projects and sessions: `data_classification`
  (`public | internal | confidential | restricted`, default `confidential`) and `retention_class`
  (`ephemeral | short | standard | extended | until_deleted`, default `standard`), with helpers
  (`isClassificationAtLeast`, `strictestClassification`). Sessions inherit the project classification;
  raising is always allowed, lowering requires an administrative role (`admin:all`/`owner` today,
  C5a replaces this with real roles).
- **Toolchain detection** (`code-toolchain-detector.ts`): Node (npm/pnpm/yarn from lockfiles),
  Python (pip/poetry/uv, pytest/ruff/mypy), Go, Rust, Java (maven/gradle), PHP (composer), plus a
  Makefile fallback that never overrides an explicit package-manager script. The result is stored as
  project metadata (`projects.toolchain`) with `source: detected|manual`, `detectedAt` and `evidence`,
  and can be corrected by the owner through the API/UI.
- **CodeSession** (`code_sessions` table + store/service/API): tied to the existing company Run via
  `run_id` (reuse, not duplication), with mode, model profile, status, parent session, summary,
  classification, retention and a reserved `tool_manifest_version` column that C1a will fill.
- **Repository import reuses the Website Builder path**: `CodeService.createProject` calls the
  existing `ProjectImportService.importRepository` (sandbox clone + Company-vault credential for
  private repositories), then detects the toolchain from the resulting workspace. Import failures are
  structured (`repository_import_failed`, retryable) and never carry credentials.
- **Sandbox image (C1 part)**: `Dockerfile.project-sandbox` now ships the base coding toolchain
  (`ripgrep`, `build-base`/`make`/`g++`, `bash`, `patch`, `diffutils`, `jq`, `unzip`, `curl`,
  `openssh-client`, `git`) on top of Node/Python/PHP; the container stays unprivileged
  (`USER 10001:10001`) and the existing isolation (read-only rootfs, `--cap-drop ALL`, tmpfs
  workspace, internal network + egress proxy, no host mounts, no docker socket) is unchanged.
- **Configuration instead of literals** (`code-agent-config.ts`): the plan's limits table is a typed,
  env-overridable configuration (`NPATI_CODE_*`, documented in `.env.example`), and
  `CODE_AGENT_ENABLED_BY_DEFAULT = false` records that the feature is dark until C1a.
- **Minimal UI**: Settings → **Code** (`/settings/code`) with a settings card next to Website
  Builder, four statistics, project table (repository, toolchain chips, classification/retention
  badges), detail drawer with verify-command editing, session table with create/archive, and a limits
  block fed by `GET …/code/limits`.
- **API (company-scoped, ownership checked server-side)**: `GET/POST /companies/:companyId/code/projects`,
  `POST …/projects/:projectId/code/detect-toolchain`, `PATCH …/projects/:projectId/code`,
  `GET …/code/sessions`, `POST …/projects/:projectId/code/sessions`,
  `GET …/code/sessions/:sessionId`, `POST …/code/sessions/:sessionId/archive`, `GET …/code/limits`.

## Files / migrations / capabilities changed
- Migration: **`packages/workspace/src/migration-065.ts`** (`065_code_projects_and_sessions`),
  registered in `packages/workspace/src/postgres-store.ts`. Additive only: extend the project type
  CHECK, add `data_classification`, `retention_class`, `toolchain`, `default_branch`, create
  `code_sessions` + indexes. No destructive statement, so a rollback stays a flag change.
- Workspace package: `types.ts` (types, enums, helpers, store interface), `postgres-store.ts`
  (columns, create/update project, session CRUD), `in-memory-store.ts` (mirror for tests).
- agent-api: **new** `code-toolchain-detector.ts`, `code-agent-config.ts`, `code-service.ts`,
  `code-routes.ts`; changed `project-service.ts` (`updateCodeSettings`), `project-routes.ts`
  (type enum), `app.ts` (service + routes wiring, `codeAgentLimits` config), `server.ts`
  (limits from env), `Dockerfile.project-sandbox` (toolchain).
- web: **new** `CodeSettingsPage.tsx`; changed `App.tsx` (card + route) and `styles.css`.
- Config/docs: `.env.example` (`NPATI_CODE_*`), this file.
- **Capabilities: none added in C1** (no tools yet), so the registry counters stay at
  **348 inventory / 84 agent-callable** and the matrix audit script keeps passing.

## Verification
- `npm run typecheck` → 0 errors (13 workspaces).
- `npm run build --workspace @npati/agent-api` → exit 0; `npm run build --workspace @npati/web` → exit 0.
- New suite `tests/coding-agent-c1-foundation.test.ts` → **16/16**, covering: toolchain detection for
  Node/Python/Go/Rust (+Makefile precedence), the configuration defaults and env overrides,
  code-project create/detect/list/edit with revision checks, session create/list/get/archive,
  classification inheritance plus downgrade rejection (owner vs admin), archived-project and
  cross-project parent session refusals, HTTP status contracts (201/400/401/403/503),
  `security-gate` cases for cross-company/cross-user isolation, a private-repository import failure
  that must not echo the credential, and a `code_unavailable` check for the dark-launch state.
- Regression slice (24 files, **309 tests passed**): capability registry + inspector + counters,
  project foundation/intent/preview/workspace/files/terminal/sandbox-egress/sandbox-provider/deploy,
  Website Builder schema + chat e2e, Data Studio UI/mobile/D7, agent-api, architecture,
  effective-capability-resolver.

## Real E2E status
- Verified: everything above runs against `InMemoryWorkspaceStore` and Fastify injection, i.e. the
  full C1 logic (schema types, detection, service rules, routes, isolation).
- **Not verified here:** the new `code_sessions`/project columns against a live PostgreSQL (no Docker
  in this environment — the migration is additive and mirrors migration 060–064 patterns, but a real
  `npm run gate:upgrade`/Docker run is still required), the rebuilt sandbox image (needs a Docker
  build), and a real private-repository clone through the sandbox runner.
- Sandbox isolation properties (unprivileged user, no host visibility, egress allowlist) remain
  covered by the existing `tests/project-sandbox-provider.test.ts` and
  `tests/project-sandbox-egress.test.ts`; C1 changed image contents only.

## Known risks / open questions
1. **Go/Rust/Java runtimes are not in the sandbox image.** Detection already reports them, but
   running their verify commands needs the toolchains. Decision deferred to **C1b** (digest-pinned
   image variants), recorded in the audit section 7.4 — the owner must confirm this is acceptable.
2. **Lowering classification/retention uses `admin:all`/`owner`** as a stand-in; C5a must replace it
   with the real role model (and multi-user Company support, which does not exist yet).
3. **C1 has no feature flag yet** (C1a): the feature is dark by convention
   (`CODE_AGENT_ENABLED_BY_DEFAULT = false`) and routes currently rely on the existing owner/admin
   permission checks. C1a must gate every route and add the kill switch.
4. **No audit-log writes yet** (C1c): creating a code project/session is not yet recorded in a
   tamper-evident log; today it is only visible through the existing audit/activity surfaces.
5. **`verifyCommands: {}` intentionally clears all commands** (the UI sends it only when the four
   fields are emptied); C2/C4 should decide whether an empty command set blocks verification runs.
6. Naming: the project type is `code_project`; the audit/plan wording "code repository" refers to the
   same thing, so no rename is expected.

## Next-session handoff
- Read `docs/coding-agent/PLAN.md` (version 4, section C1c), `docs/coding-agent/00-audit.md`
  sections 9.4 and 13, and this file.
- Execute **only C1c** (tamper-evident audit log): append-only table with hash chain, DB-level denial
  of UPDATE/DELETE, `AuditLog.record()` used by privileged paths (starting with feature-flag changes
  in C1a and the C1 classification/retention decisions), fail-closed behaviour, daily anchor outside
  the Core DB, verification API + background verifier, and its `security-gate` tests.
- Do not start C1a in that session; C1a comes after C1c (order is hard, `00-audit.md` section 13).
