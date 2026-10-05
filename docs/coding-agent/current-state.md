# NPATI Coding Agent — Current State

Update this file after every completed step.

## Current step
- Last completed: **C1b — sandbox image supply chain** (after C0 audit, C1 foundation, C1c audit log, C1a flags/versioning)
- Next: **C2 — the `code.*` tools** (read/search first), per the hard order in `docs/coding-agent/00-audit.md` section 13.

## Implemented (C1b, latest step)
- **Declarative image catalog** `docker/sandbox/images.json` (schema v1, six variants: base, node, python,
  php, go, rust, java) where every reference must be `repo@sha256:<64hex>`; the catalog is validated
  strictly (no tags or `:latest`, mandatory `sbomPath`/`scanAt`/known `status`/`variant`, no duplicate
  digests or ids). A missing catalog yields an empty catalog plus a log — never "trust everything".
  **All digests are deterministic placeholders** until the first real build; this is stated in the
  catalog warnings, in `docs/coding-agent/sandbox-images.md`, and enforced by `--require-verified`
  (which is red by design today).
- **Dockerfiles** `docker/sandbox/Dockerfile.{base,node,python,php,go,rust,java}`: digest-pinned base
  (`ARG UPSTREAM_BASE=...@sha256:<digest>`), pinned package/runtime versions (pnpm 10.15.0, yarn 1.22.22,
  pytest 8.3.3, ruff 0.6.9, mypy 1.11.2, poetry 1.8.4, uv 0.4.20, OpenJDK 21 + Maven/Gradle), Go with
  `GOTOOLCHAIN=local`, unprivileged `USER 10001:10001`, `WORKDIR /workspace`, no docker socket and no
  privileged mode — this closes the Go/Rust/Java toolchains C1 deliberately deferred.
- **SBOM and scanning**: `docker/sandbox/sbom/*.spdx.json` per image (placeholder inventory, clearly
  marked, replaced by real `syft` output in CI); `scripts/sandbox-image-scan.mjs` blocks publication on
  any critical finding and requires a waiver (owner + reason + expiry) for high findings.
- **Signing and trusted registry**: `CosignImageSignatureVerifier` (keyless, certificate identity +
  OIDC issuer) and `NullImageSignatureVerifier`, which **always refuses** — with no configured verifier
  every image is denied (fail closed).
- **Admission control in the sandbox provider**: `SandboxImagePolicy.admit()` runs **before**
  `docker create`, the admitted digest (not the configured tag) is what reaches the command line, and a
  refusal creates neither container nor network. Refusal codes: `image_not_pinned`, `image_not_allowed`,
  `image_revoked` (409 + `forcedUpgrade`/`replacement`), `image_digest_mismatch`, `image_scan_stale`
  (older than `NPATI_CODE_MAX_IMAGE_AGE_DAYS`, default 14), `image_scan_failed`, `image_waiver_expired`,
  `image_signature_invalid`, `image_admin_required`, `sandbox_image_policy_unavailable`.
- **Deny by default in three places**: no signature verifier → refusal; no audit journal →
  `allow`/`revoke`/`waiver` are not applied (the journal is written **before** the change); no injected
  policy in the provider → refuse instead of starting.
- **Dev mode** (`NPATI_SANDBOX_ALLOW_UNVERIFIED_IMAGES=true`, default false) allows a locally built image
  only when the environment is `development`/`test` **and** no production flag is enabled for the
  company; such an image is recorded `unverified` and can never become `verified`.
- **Rollout and digest immutability**: `selectForRollout` keeps a session on its own digest; a new digest
  is adopted only when `code.sandbox_image.<digest-prefix8>` is enabled (the namespace was added to the
  flag-key validator, otherwise the operator could not have enabled it at all); after a revoke the policy
  returns `forcedUpgrade` with the last verified image of the same variant, so the runtime can notify and
  move the session.
- **Container hardening**: `buildSandboxCreateArgs()` (pure, testable) emits `--user 10001:10001`,
  `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, tmpfs `/workspace` owned by 10001,
  the internal network and an optional seccomp profile (`NPATI_SANDBOX_SECCOMP_PROFILE`), and never
  `--privileged`, a docker socket, host mounts, `--pid=host`, `--network=host` or `:latest`.
- **API and UI**: `GET/POST /companies/:companyId/code/sandbox-images`, `POST .../revoke`,
  `POST .../:imageId/scan`, `POST .../admission-check` (all responses carry `apiVersion`), and the
  «Sandbox images» panel on Settings → Code with status/scan badges, revoke confirmation, scan recording
  and a manual admission check.
- **CI**: `.github/workflows/sandbox-images.yml` (verify → build/SBOM/scan/sign, weekly `rescan` with an
  issue on critical) plus `npm run audit:sandbox-images` in the existing platform job; the local guard
  `scripts/sandbox-image-verify.mjs` runs on pure Node (no TS loader) and also checks the Dockerfiles
  (digest-pinned `FROM`, `USER 10001:10001`, no `--privileged`/`docker.sock`).

## Files / migrations / capabilities changed (C1b)
- Migration **`packages/workspace/src/migration-068.ts`** (`068_sandbox_image_supply_chain`): table
  `sandbox_images` with digest, status, signature/issuer, SBOM path, scan data, waiver fields,
  `previous_reference` and revoke audit fields.
- Workspace package: `types.ts` (`SandboxImage*` types, `SANDBOX_IMAGE_REFERENCE_PATTERN`, five store
  methods), `postgres-store.ts`, `in-memory-store.ts`.
- agent-api: **new** `sandbox-image-policy.ts`, `sandbox-image-catalog.ts`, `sandbox-image-signature.ts`,
  `sandbox-image-routes.ts`; changed `docker-sandbox-provider.ts` (admission + seccomp),
  `sandbox-runner-server.ts` (policy construction), `app.ts` (policy + route registration),
  `feature-flags.ts` (rollout flag namespace).
- New: `docker/sandbox/**` (7 Dockerfiles, catalog, 6 SBOMs, negative self-test fixture),
  `scripts/sandbox-image-{lib,build,sbom,scan,sign,verify}.mjs`, `.github/workflows/sandbox-images.yml`,
  `docs/coding-agent/sandbox-images.md`; changed `.github/workflows/ci.yml`, `package.json`
  (`audit:sandbox-images`), `apps/agent-api/Dockerfile.project-sandbox` (kept buildable, digest via
  `--build-arg`), `.env.example` (six new sandbox variables).
- web: **new** `CodeSandboxImagesPanel.tsx`; changed `CodeSettingsPage.tsx`, `styles.css`.
- Capabilities: none added (still **348 / 84**) — unchanged by design, tools arrive in C2.

## Verification (C1b)
- `npm run typecheck` → **0 errors**; `npm run build` for agent-api and web → **exit 0**;
  `node scripts/sandbox-image-verify.mjs` → **exit 0** (0 errors, 6 placeholder warnings);
  `node scripts/verify-code-tool-schemas.mjs --check` → **exit 0**.
- `tests/coding-agent-c1b-images.test.ts` **14/14** and `tests/coding-agent-c1b-image-api.test.ts` **7/7**,
  and the full security-gate regression slice — **18 files, 197 tests, all passing** (C1, C1a flags,
  C1a versioning, C1a artifact guard, C1c audit, projects, sandbox provider/egress/terminal, capability
  registry and full capability regression, invariants, Website Builder, Data Studio, agent-api, architecture).
- Fixed during the step (all seven failures were real, none was solved by weakening a check):
  five test fixtures used a bare hex digest where the canonical form is `sha256:<hex>`;
  `AuthenticationError` was mapped to 400 instead of 401 by the image routes; an unexpected internal
  failure mapped to 400 instead of 500; and `newDigestAdopted` built the rollout flag key from
  `digest.slice(0,8)` — i.e. `sha256:b` — while the flag namespace was not even accepted by the key
  validator, so the documented rollout mechanism could not be enabled at all.

## Real E2E status (C1b)
- Verified in-process: admission decisions and every refusal code, fail-closed audit for image
  administration, catalog validation, the hardened command line, rollout/revoke semantics, the API error
  contracts and both builds.
- **Not verified here (no Docker registry, no `syft`/`trivy`/`cosign`):** actual image builds, real
  SPDX inventories, vulnerability scans, cosign signatures, and a container actually starting from an
  admitted digest. The catalog digests are placeholders, so the deploy gate (`--require-verified`) is red
  by design until the first real build; the workflow YAML was written by hand and has not been parsed by
  GitHub yet. Migration 068 and the DB store methods have not run against a live PostgreSQL.

## Known risks / open questions (C1b)
1. **Dev workflow break (needs confirmation)**: the default `NPATI_SANDBOX_IMAGE` is a tag, so from C1b the
   sandbox refuses to start until either a digest from the catalog plus cosign identity/issuer is
   configured, or `NPATI_SANDBOX_ALLOW_UNVERIFIED_IMAGES=true` is combined with `NODE_ENV=development`.
   This is intentional deny-by-default, but it changes the local flow.
2. **Runner without `DATABASE_URL` sees only the file catalog**, so a `revoke` performed through the API
   does not reach it (a warning is logged). Production runners must have database access; alternatively a
   periodic catalog pull from the API can be added.
3. The negative-check fixture (`docker/sandbox/.negative-check.json`) stays in the repo deliberately: the
   CI `verify` job asserts that the guard **fails** on it. It can be moved to `tests/fixtures/` if that is
   preferred.
4. `apps/agent-api/Dockerfile.project-sandbox` remains tag-buildable so the existing CI/Dokploy path keeps
   working; the digest-pinned production path is `docker/sandbox/*` with `--build-arg BASE_IMAGE=…@sha256:…`.
   Forcing a digest there would break the current CI job until a real digest exists.
5. `docker/sandbox/images.json` entries are `unverified` placeholders; the real rotas must be filled by the
   first successful workflow run, and only then may any of them be promoted to `verified`.
6. The gVisor/Kata/Firecracker decision is documented (evaluated, not implemented) in
   `docs/coding-agent/sandbox-images.md`; a stronger runtime would be an alternative `SandboxRuntimeProvider`.

## Implemented (C1a, latest step)
- **Feature-flag store** (migration **067**, additive): `feature_flags` with scope `global|company|user`,
  `stage` (`off|internal|allowlist|percent|ga`), `enabled`, `rollout_percent`, `allowlist`, `revision`,
  `updated_by`, unique on (workspace, scope, scope_id, flag_key); `feature_flag_history` records every
  change (previous/next value, actor) so "who turned it on" is answerable without the journal — the
  privileged action itself is additionally in the C1c AuditLog.
- **`FeatureFlagService`** (`apps/agent-api/src/feature-flags.ts`): master `coding_agent.enabled` plus
  sub-flags `code.read`, `code.write`, `code.shell`, `code.git`, `code.subagents`,
  `code.background_runs`, `code.mounted_folder`, `code.hooks`, `code.mcp`, `code.full_auto_sandbox`
  and the `code.model_profile.<id>` template; keys outside the `code.` namespace are rejected
  (`invalid_flag_key`). Resolution is user → company → global; stages are `off` = deny,
  `internal` = admin/owner only, `allowlist` = id list, `percent` = deterministic FNV bucket,
  `ga` = allow. The in-process cache is capped at 30 s (`NPATI_CODE_FLAG_CACHE_TTL_MS`, default 15 s)
  and `invalidate()` is called on every write, so a kill switch acts immediately.
- **Master flag is a veto switch**: an explicit `off` at a broader scope stops the feature even where a
  narrower scope enabled it (this is what makes an incident stop authoritative); sub-flags keep
  most-specific-wins. This semantics change is called out below for confirmation.
- **Dark launch by default**: nothing is enabled out of the box; mutations require master +
  `code.write`, and the check exists in **both** the route and `CodeService`, so a direct service call
  is refused too (403 `feature_disabled` with the offending `flagKey`). A missing flag service means
  **deny**, never allow. Reads stay available — this is the History (read-only) mode: project/session
  lists, details, limits, flags and `archive` keep working while the feature is off, so a user can
  still see and remove their data. Website Builder and Data Studio are untouched.
- **Kill switch** (`POST /companies/:companyId/code/flags/kill-switch`): audited (`flag.kill_switch`)
  before the state change, disables master at the requested scope, invalidates the cache, moves
  `active|paused|awaiting_approval` sessions of that company to the new `suspended_by_flag` status and
  best-effort stops the sandbox of those projects (full cleanup and SecretLease revocation are C4/C6).
- **Auto-disable on a security event** (`NPATI_CODE_AUTO_DISABLE_ON_AUDIT_BREAK`, default true):
  `evaluateAutoDisable({ type: "audit_chain_broken" })` disables master globally and audits
  `flag.auto_disable`; the owner sees the new state in the UI.
- **Administration**: only `*`/`owner`/`admin:all` may change flags (403 `flag_admin_required`, checked
  before any company lookup); `expectedRevision` gives 409 `flag_revision_conflict`; promoting a stage
  above `internal` returns 409 `gate_not_passed` unless `NPATI_ALLOW_PRE_GATE_ROLLOUT=true`, because G1
  and R1 have not been passed. Every change goes through `AuditLogService.record()` **before** it is
  applied, so an audit outage refuses the change (fail closed).
- **UI**: Settings → Code → «Feature flags (experimental)» — master switch, kill switch with
  confirmation, the ten sub-flags, scope selector (company/global with a warning), dark-launch alert
  and change history; the page switches to History read-only (mutating buttons disabled with an
  explanation) when master is off.
- **Versioning**: `code-tool-registry.ts` (schemas as `name@version`, canonical JSON checksum,
  `CODE_TOOL_MANIFEST_VERSION`, `assertManifestConsistent`, `resolveManifestForSession`),
  `persisted-schema-upcast.ts` (`PERSISTED_SCHEMA_VERSIONS` for session transcript, summary, checkpoint
  metadata, model profile and tool result; `upcastPersisted` reads old records without migrating
  history and refuses records newer than the code), `api-versioning.ts` (`API_VERSION = "v1"`, 90-day
  deprecation window, `x-npati-api-version` request header, `unsupported_api_version` for an unknown
  version) — code API responses now also carry the `x-npati-api-version` header.
- **CI guard**: `scripts/verify-code-tool-schemas.mjs` (`npm run audit:code-tools`) compares the
  published artifact `apps/agent-api/src/code-tool-schemas.published.json` with the frozen snapshot
  `tests/fixtures/code-tool-schema-snapshot.json` and fails the build for a changed schema without a
  version bump, a removed published version, a new version without a manifest bump, or a tampered
  checksum; `tests/coding-agent-c1a-tool-schema-artifact.test.ts` keeps registry ↔ artifact ↔ snapshot
  in sync (vite compiles TS, so the guard itself needs no TS loader).
- **Session manifest pinning**: a new `CodeSession` records `toolManifestVersion` (manifest v1 today),
  and `app.ts` publishes the manifest at startup after `assertManifestConsistent()`.

## Files / migrations / capabilities changed (C1a)
- Migration **`packages/workspace/src/migration-067.ts`** (`067_feature_flags_and_versioning`),
  registered in `postgres-store.ts`.
- Workspace package: `types.ts` (flag types, `CodeToolManifest`, `suspended_by_flag` status, five new
  store methods), `postgres-store.ts`, `in-memory-store.ts` (mirrored).
- agent-api: **new** `feature-flags.ts`, `code-tool-registry.ts`, `persisted-schema-upcast.ts`,
  `api-versioning.ts`, `code-tool-schemas.published.json`; **new** `scripts/verify-code-tool-schemas.mjs`,
  `tests/fixtures/code-tool-schema-snapshot.json`; changed `code-routes.ts` (mutation gates, three flag
  routes, API-version check + header), `code-service.ts` (deny-by-default `assertWriteEnabled`,
  manifest pinning), `app.ts` (flag service + manifest publication).
- web: **new** `CodeFlagsPanel.tsx`; changed `CodeSettingsPage.tsx`, `styles.css`.
- Config/docs: `.env.example` (`NPATI_CODE_FLAG_CACHE_TTL_MS`, `NPATI_ALLOW_PRE_GATE_ROLLOUT`,
  `NPATI_CODE_AUTO_DISABLE_ON_AUDIT_BREAK`), `package.json` (`audit:code-tools`), this file.
- Capabilities: none added (still **348 / 84**); rule 24 in action — the flag plumbing exists, the
  `code.*` capabilities and the Inspector's per-capability flag badge arrive with C2.

## Verification (C1a)
- `npm run typecheck` → **0 errors** (13 workspaces); `npm run build` for agent-api and web → **exit 0**.
- `npm run audit:code-tools` → **exit 0** (`0 tool(s), manifest v1, checksum e3b0c44…b855`); drift was
  demonstrated to fail in all four cases (changed schema without bump, removed version, new version,
  tampered checksum).
- New/updated suites: `tests/coding-agent-c1a-flags.test.ts` **12/12** (dark launch denies mutations
  through both the API and a direct service call; per-company and per-user isolation; master veto over
  sub-flags; key validation; non-admin refusal; fail-closed audit; revision conflict; gate above
  `internal`; kill switch suspends sessions, invalidates the cache immediately and is audited;
  auto-disable on a broken chain; 503 when flags are not configured),
  `tests/coding-agent-c1a-versioning.test.ts` **17/17**,
  `tests/coding-agent-c1a-tool-schema-artifact.test.ts` **6/6**, plus the C1 suite **16/16** (updated
  for deny-by-default and the pinned manifest) and the C1c suite **10/10** — the four security-gate
  suites together are **61/61**.
- Regression slice (23 files) in the same run: **216 passed, 3 skipped (DB-bound C1c), 1 failed** — the
  failure was a stale `toolManifestVersion: null` expectation caused by the new manifest pinning, and
  it is fixed. Pre-existing failures are unchanged and unrelated: `company-runtime.test.ts` (4),
  `manual-product-e2e-web.test.ts` (1), `production-durable-approvals.test.ts` (1, reproduced on a
  clean HEAD).

## Real E2E status (C1a)
- Verified in-process: flag resolution across scopes and stages, master veto, cache invalidation and
  the immediate kill-switch effect, session suspension, audit-before-apply, API error contracts, the
  versioning helpers, the artifact/snapshot guard, and both builds.
- **Not verified here:** the flag tables and the `suspended_by_flag` CHECK against a live PostgreSQL
  (migration 067 is additive and follows 065/066; the DB-backed job must apply it), the UI panel in a
  browser, and the C1c DB-bound triggers (unchanged, 3 tests skipped without `DATABASE_URL`).

## Known risks / open questions (C1a)
1. **Master flag is now a veto switch** (a broader `off` overrides a narrower `on`). It is required for
   an incident kill switch, but it is a semantics decision — confirm it, or switch to a separate
   "incident stop" row that outranks every scope.
2. `stage: "internal"` admits only admin/owner; ordinary users need `allowlist`/`percent`/`ga`. This is
   the conservative reading of the plan and is easy to relax in one condition.
3. A rejected flag change (revision conflict) already has a `flag.change` entry, because the audit is
   written first (fail closed). If "audit only applied changes" is preferred, the order must change
   together with a compensating entry.
4. `tsx` is still not declared in `devDependencies`; the new guard no longer needs it, but the older
   `gate:agent` script has the same latent dependency.
5. Auto-disable currently reacts to the audit-chain-broken event; error-rate and budget thresholds
   need the metrics that arrive with C6/R1.
6. Kill-switch cleanup is best-effort for sandboxes and does not revoke SecretLeases (C4) or suspend
   runs (C6 adds run-level `suspended_by_flag`; C1a suspends sessions).

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
- Read `docs/coding-agent/PLAN.md` (version 4, section C2), `docs/coding-agent/00-audit.md`
  sections 5, 6 and 13, and this file.
- Execute **only C2**: register the first `code.*` capabilities and tools in the canonical capability
  registry (domain/type/risk/agent-callable/approval/schema version, visible in the Capability
  Inspector — remember to update the inventory counter contracts **and** the `code.*` domain, which does
  not exist yet), starting with read-only tools (`code.fs.read`, `code.fs.list`, `code.search`) built on
  the C1 workspace and the C1b sandbox: versioned argument/result JSON schemas, per-tool limits,
  structured errors (`status`, `message`, `step`, `tool`, `retryable`), an Activity event, a feature-flag
  check per call, `tool_call_id` idempotency, and secret redaction in output. Publish the tool manifest
  (bump `CODE_TOOL_MANIFEST_VERSION`, refresh `apps/agent-api/src/code-tool-schemas.published.json` and
  the snapshot fixture via `npm run audit:code-tools -- --update`) so sessions pin the new versions, and
  add the Inspector badge that shows the flag state per `code.*` capability.
- Every new tool must run **only** in the sandbox admitted by the C1b policy, must respect the C1a flags
  (`code.read` for reads), and its privileged actions must go through `AuditLogService.record()`.
- Do not start C3 in that session; the order in `00-audit.md` section 13 is binding.
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
