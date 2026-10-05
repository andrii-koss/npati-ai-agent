# NPATI Coding Agent — Current State

Update this file after every completed step.

## Current step
- Last completed: **C1c — tamper-evident audit log** (after C0 audit and C1 foundation)
- Next: **C1a — feature flags, staged rollout and versioning** (then C1b images), per the hard order in `docs/coding-agent/00-audit.md` section 13.

## Implemented (C1c, latest step)
- **Append-only journal** `audit_log`, deliberately separate from Activity and from
  `company_audit_logs`: `audit_id`, `sequence` (per company), `created_at`, `actor`, `actor_role`,
  `request_id`, `correlation_id`, `snapshot_id` (null until C6b), `action`, `resource_type`,
  `resource_id`, `project_id`, `decision` (`allowed|denied|approved|rejected`), `payload_hash`,
  `prev_hash`, `entry_hash`, redacted `metadata`. Migration **066** also revokes UPDATE/DELETE from
  PUBLIC and installs two triggers: one that raises on any UPDATE/DELETE (covering the table owner,
  which a REVOKE alone would not) and one that enforces the hash chain on INSERT (first entry of a
  company must be sequence 1 with no `prev_hash`; every later entry must continue the previous
  `entry_hash` with the next sequence), so a rogue INSERT cannot fork or reorder a chain.
- **Hash chain** `entry_hash = sha256(prev_hash | canonical(entry))` with canonical JSON (recursively
  sorted keys) computed by one shared module (`packages/workspace/src/audit-chain.ts`), so PostgreSQL
  and the in-memory store produce identical hashes and the verifier is a pure, unit-testable function.
  Appends take a per-company advisory lock inside a transaction, so concurrent privileged actions
  cannot interleave.
- **`AuditLogService`** (`apps/agent-api/src/audit-log.ts`): the `record()` interface later steps use.
  It redacts metadata (secrets by key and by the project's `CredentialMasker` patterns; prompt/content
  keys dropped entirely), stores only the canonical hash of the action payload, and **throws
  `AuditUnavailableError` on any write failure (fail closed)**.
- **Verification**: `verifyChain(company, range)` API + a background verifier
  (`NPATI_AUDIT_VERIFY_INTERVAL_MS`, default 6 h) that runs without a user context through a
  workspace-scoped system path and logs a critical alert per broken chain. After a break, the service
  refuses new privileged writes for that company (`blockOnBreak`, default true, documented off-switch)
  until an operator clears it.
- **Daily anchors**: every day the head hash of each company is stored in `audit_anchors` **and**
  written as an HMAC-SHA256-signed JSON file outside the Core database
  (`NPATI_AUDIT_ANCHOR_DIR`, default `<data dir>/audit-anchors`); the signature is verified on read, so
  an attacker who rewrites the table (and matches the chain) still disagrees with the anchor.
- **Access and export**: journal, verification, anchors and export require the owner/admin role
  (`*`/`owner`/`admin:all`/`audit:read`) and are refused *before* any company lookup (403
  `audit_read_denied`); anonymous callers get 401 with the authentication error's own code; a
  deployment without the journal returns 503 `audit_unavailable`. The export endpoint is itself
  audited (`audit.export`), supports filters (actor, request_id, correlation_id, action, fromSequence)
  and returns JSONL. Retention is configured (`NPATI_AUDIT_RETENTION_DAYS`, only ids/hashes/metadata).
- **Privileged paths wired in C1c (fail closed)**: approval decisions
  (`approval.decide`, with the hash of the exact payload the approver saw, so approval/execution
  substitution is detectable), guardrail policy changes (`policy.guardrail.update`, before/after
  policies hashed, blocked-term values never stored), code project/session actions
  (`code.project.create`, `code.project.update`, `code.session.create`, `code.session.archive`,
  `code.session.status`) and audit export. Company deletion is the next hook (see risks).

## Files / migrations / capabilities changed (C1c)
- Migration **`packages/workspace/src/migration-066.ts`** (`066_tamper_evident_audit_log`), registered
  in `postgres-store.ts`; new module `packages/workspace/src/audit-chain.ts` (exported from the
  package index).
- Workspace package: `types.ts` (audit types + store interface incl. the system path),
  `postgres-store.ts` (advisory-locked append, list/verify/state/anchors, system path), `in-memory-store.ts`
  (same semantics; entries are stored and returned as clones with no update/delete path).
- agent-api: **new** `audit-log.ts`, `audit-config.ts`; changed `audit-routes.ts` (journal, verify,
  anchors, export + owner/admin gating), `approvals-routes.ts` (audited decisions),
  `guardrail-policy-routes.ts` (audited policy changes), `code-service.ts` (audited code actions),
  `app.ts` (service construction, route wiring, verify + anchor timers, `AUDIT_SYSTEM_WORKSPACE`).
- Config/docs: `.env.example` (`NPATI_AUDIT_*`, `NPATI_WORKSPACE_ID`), this file.
- Capabilities: none added (still **348 inventory / 84 agent-callable**).

## Verification (C1c)
- `npm run typecheck` → 0 errors (13 workspaces); both builds exit 0 (agent-api, web).
- `tests/coding-agent-c1c-audit-log.test.ts` → **10/10** (always runs): chain continuity and head
  hash, four tamper cases detected by the pure verifier (content rewrite, hash rewrite, sequence gap,
  duplicate sequence), payload binding (substitution changes the recorded hash), fail-closed on a
  failing store, break → privileged writes blocked → cleared after investigation, secret/prompt
  redaction (keys and `CredentialMasker` patterns), per-company and per-workspace isolation, signed
  daily anchors (signature verified, rewritten anchor detected), and API access control
  (403 for a plain member on all four endpoints, 401 anonymous, 200 + `audit.export` recorded for
  admin, 503 when the journal is not configured).
- `tests/coding-agent-c1c-audit-postgres.test.ts` → **3 tests, skipped without `DATABASE_URL`** (their
  names carry the skip reason). They are the DB-level guarantees: the append-only trigger rejects
  UPDATE/DELETE for the application role, a rogue INSERT that would fork the chain is rejected by the
  chain guard, and a superuser bypass (trigger disabled, row edited) is detected by `verifyChain`
  which then blocks new privileged writes.
- Regression slice with the C1 suite: 30 passed / 3 skipped (projects, code foundation).

## Real E2E status (C1c)
- Verified in-process: the whole chain model, redaction, fail-closed behaviour, blocking, anchors
  (including real file writes and signature checks), API authorization and audit-export recording.
- **Not verified here (needs PostgreSQL):** the triggers and REVOKE themselves, the advisory-lock
  concurrency path in a real database, and anchor rows written by the background timer. These are
  covered by the three DB-bound tests above, which must be executed by the DB-backed job
  (`npm run gate:upgrade`, the Docker CI job, and the SG-* checkpoints) — this is the one deliberate
  skip in the step and it is reported as such rather than weakened.

## Known risks / open questions (C1c)
1. **A superuser can still disable the triggers.** That is exactly why the hash chain and the external
   signed anchor exist: such an edit is detectable, and the service then blocks new privileged writes.
   The anchor is only as trustworthy as the key in `NPATI_AUDIT_ANCHOR_KEY`/`NPATI_ENCRYPTION_KEY` and
   the storage holding the anchor directory (recommendation: a volume that is not part of the database
   backup rotation, or object storage with object-lock — decided in R1).
2. **`blockOnBreak` defaults to true**, so a break halts privileged audit writes until an operator
   investigates and clears it. The off-switch (`NPATI_AUDIT_BLOCK_ON_BREAK=false`) is documented; the
   owner should confirm the default is acceptable for production.
3. **Retention is configured but not enforced** (`NPATI_AUDIT_RETENTION_DAYS`); pruning is R1 work and
   must never delete rows that an anchor/verification still needs.
4. **Company deletion is not yet audited.** The hook (`beforeDeleteCompany` in `app.ts`) is the next
   natural insertion point; it needs the company id before the row disappears, so it should be wired
   together with the C1a flag work or as a small follow-up in C5a (RBAC/export/delete events).
5. **Not every privileged event is wired yet**: feature flags and kill switch (C1a), protected-branch
   and network allowlist changes (C4b/C5a), image allow/revoke (C1b), `SecretLease` metadata (C4),
   RBAC/role changes and ProviderDataPolicy (C5a/C5b) will call `AuditLogService.record()` as those
   features appear.
6. The background verifier uses `NPATI_WORKSPACE_ID` (default `dev-workspace`, matching the local auth
   provider). A multi-workspace deployment must iterate workspaces; the store's system path is already
   workspace-scoped for that reason.

## Next-session handoff
- Read `docs/coding-agent/PLAN.md` (version 4, section C1a), `docs/coding-agent/00-audit.md`
  sections 3, 9 and 13, and this file.
- Execute **only C1a**: feature-flag store with global/company/user scope and history, the master kill
  switch plus the sub-flags (dark by default), server-side checks with ≤30 s cache TTL, the
  History/read-only mode when disabled, `code.*` tool-schema version registry, the session tool
  manifest, upcasters for old events, API versioning and the CI snapshot guard. **Every flag change
  must be written through `AuditLogService.record()` (C1c) — flag changes are privileged actions, and
  if the journal write fails the change must be refused.**
- Do not start C1b in that session; images come after C1a (order in `00-audit.md` section 13).
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

## Implemented (C1)
- **`code_project` project type** on the existing `Project` entity (no new entity), and classification
  plus retention fields on projects and sessions (defaults `confidential` / `standard`), with session
  inheritance and role-gated downgrades.
- **Toolchain detection** for Node/Python/Go/Rust/Java/PHP (+Makefile fallback), stored as project
  metadata with `source`, `detectedAt` and `evidence`, editable by the owner.
- **CodeSession** records tied to the existing company run, repository import through the Website
  Builder path, the sandbox image extended with the base coding toolchain, limits as configuration,
  and the minimal Settings → Code UI.

## Files / migrations / capabilities changed (C1)
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

## Verification (C1)
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

## Real E2E status (C1)
- Verified: everything above runs against `InMemoryWorkspaceStore` and Fastify injection, i.e. the
  full C1 logic (schema types, detection, service rules, routes, isolation).
- **Not verified here:** the new `code_sessions`/project columns against a live PostgreSQL (no Docker
  in this environment — the migration is additive and mirrors migration 060–064 patterns, but a real
  `npm run gate:upgrade`/Docker run is still required), the rebuilt sandbox image (needs a Docker
  build), and a real private-repository clone through the sandbox runner.
- Sandbox isolation properties (unprivileged user, no host visibility, egress allowlist) remain
  covered by the existing `tests/project-sandbox-provider.test.ts` and
  `tests/project-sandbox-egress.test.ts`; C1 changed image contents only.

## Known risks / open questions (C1)
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
