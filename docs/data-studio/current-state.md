# NPATI Data Studio + Project Auth — Current State

## Status

- Current step: D6 completed at code and automated-test level (see D6 verification). Live PostgreSQL / Live Preview (Expo Web) acceptance remains unverified because the local Docker daemon is unavailable.
- Completed steps: D0 audit, D1 core backend engine & provisioning, D2 Data Studio UI & management API, D3 Agent capabilities, approval, and schema templates, D4 Project Auth (end-user auth, sessions, tokens, RLS compiler, GDPR), D5 Project API gateway, keys, SDK and sandbox integration (including the D5 completion pass below), D6 mobile_app projects (Expo template, Expo Web preview, deep links, shared DataBackend).
- Next step: D7 (promote dev → prod, real dump/restore, quotas, external provider, drift remediation). Not started.
- Source of truth: `docs/data-studio/PLAN.md`, `docs/data-studio/00-audit.md`, and repository code.

## Implemented in D1

- Core DB migration `060_data_backends` adds `data_backends`, environments, encrypted secret records, migration history and locks, snapshots, UI metadata, access policies, and nullable `projects.data_backend_id` with a same-company foreign key. `Project` and Postgres project reads expose the optional backend ID. In-memory projects remain valid without a backend.
- `DataBackendRepository` applies workspace/company/owner scoping, keeps role passwords encrypted with the existing `CryptoVault`, checks project attachment in a transaction, and holds a Core lock with expiry for schema changes.
- `DataBackendService` creates and provisions dev/prod databases, lists/reads/renames/archives/activates backends, attaches or detaches projects, and requires name confirmation plus no active attached projects for removal. Archiving disables runtime login and terminates existing runtime sessions. Project deletion leaves the backend intact.
- `DatabaseProvisioner` defines provision, deprovision, connections by role, rotation, snapshot, restore and usage. `SharedPostgresProvisioner` creates one database per backend and environment with separate migrator and runtime roles. It removes PUBLIC database connect and schema privileges, limits connections and query time, and stores role passwords only in encrypted Core storage. The project database and backup tooling are available only to the API process.
- `DataProvider` and `PostgresDataProvider` compile structured schema operations, validate and quote identifiers, bind row values and filters, use runtime credentials for data operations, enable and force RLS for new collections and join tables, introspect the live schema, and compute a stable schema fingerprint. Runtime has no table grants or policies by default.
- `ProjectMigrationEngine` has dry run, transactional apply, separate `_npati_migrations` history, Core mirror, checksum, destructive and snapshot flags, safe rollback, Core TTL and PostgreSQL advisory locks, and drift detection.
- Company-scoped API routes expose DataBackend create, read, list, rename, archive, activate, remove and project attach/detach.
- Compose files add an opt-in `data-studio` profile with a separate `postgres-projects` volume, internal network, healthcheck, resource limits and no host port.

## Implemented in D2

- Core DB migration `061_data_studio_expected_schema` adds `expected_schema` (jsonb) to `data_backend_environments` and `acquired_at` (timestamptz) to `data_backend_migration_locks`.
- Management Data Access in `ProjectMigrationEngine`:
  - Added `ownerQuery`, `listOwnerRows`, `createOwnerRow`, `updateOwnerRow`, `deleteOwnerRows`.
  - Secure parameterized queries with strict identifier quoting. Supports `DEFAULT VALUES` when creating rows with only generated columns.
- `DataStudioUiService` (`apps/agent-api/src/data-studio/studio-service.ts`):
  - Multi-tenant context validation: verifies `user -> company -> project -> dataBackend -> environment`.
  - Overview: fetches backend, environment sync status, live schema introspection, expected schema diff, migration lock status, and migration history.
  - Operation validation: `validateOperation` verifies all collection and field identifiers against SQL injection and reserved keywords.
  - Schema dry-run preview & apply: checks `expectedFingerprint` to prevent race conditions, enforces confirmation for destructive/snapshot-requiring migrations, and blocks schema mutations in `prod` (requiring Promote in D7) or when `drift_detected`.
  - Schema rollback: safe revert of reversible migrations.
  - Row CRUD: filtered, sorted, paginated queries, creation, update, and bulk delete with required user confirmation.
  - CSV & JSON Import: schema-based type validation (numbers, booleans, UUIDs, dates, JSON), limit of 1 MB and 500 rows per batch.
  - CSV & JSON Export: formula injection escaping (cells starting with `=`, `+`, `-`, `@` prefixed with `'`).
- UI Routes (`apps/agent-api/src/data-studio/studio-routes.ts`):
  - Fastify endpoints registered at `/companies/:companyId/projects/:projectId/data-studio/:environment` with workspace permissions (`workspace:read` / `business:manage`).
- Frontend UI (`apps/web/src/DataStudioPage.tsx`, `DataBackendSection.tsx`, `ProjectSection.tsx`):
  - Integrated into NPATI navigation: Company -> Data Backends tab, Project card Data badge & link, direct URL route `/companies/:companyId/projects/:projectId/data`.
  - Header: displays backend name, environment switcher (dev/prod), sync status badge (synced / drift_detected / reconciliation_required), migration lock holder and acquired time.
  - Schema Drift & Prod warning banners: informative diff modal, blocks Apply when drifted, blocks schema editing in production.
  - Collections sidebar: list, create, rename, and delete collections with destructive confirmation dialog.
  - Schema Editor:
    - Field listing with types, nullability, default values, and enum options.
    - Add/remove fields and relationships (`many-to-one`, `one-to-many`, `many-to-many`).
    - Schema Diff & Dry-run modal: shows planned SQL migration, rollback availability, destructive warning, snapshot requirement, and Apply button.
    - Migrations history table: shows author (User vs Agent), `runId` link ("View Run"), status, flags, and Revert button.
  - Data View:
    - Tabular row browser with search, multi-condition filters, sorting, and pagination.
    - Row editor drawer generated from schema field definitions.
    - Row deletion and bulk deletion with confirmation modal.
    - Import / Export modal with CSV/JSON support and formula safety.
  - Empty states: project without DataBackend prompts user to attach or create a backend.
  - Responsive layout: scrollable tables and slide-over panels for mobile/tablet screens.

## Implemented in D3

- Canonical Agent Capabilities registered in `defaultCapabilityRegistry` and `CAPABILITY_MATRIX` (total capabilities increased from 334 to 344; agent-callable from 70 to 80):
  1. `project.data.schema.inspect`: low risk, inspects tables, columns, relations, fingerprint, drift status.
  2. `project.data.schema.apply`: high risk, applies structured schema operation (create/drop collection, add/drop field, create relation, etc.). Approval required if destructive.
  3. `project.data.rows.list`: low risk, paginated row query with filters and sorting.
  4. `project.data.rows.read`: low risk, reads single row by ID.
  5. `project.data.rows.create`: medium risk, inserts single row (max 100 rows/run).
  6. `project.data.rows.update`: medium risk, updates single row by ID.
  7. `project.data.rows.delete`: high risk, bulk row deletion requiring human confirmation.
  8. `project.data.migrations.list`: low risk, lists applied migration history.
  9. `project.data.templates.list`: low risk, lists pre-built schema templates.
  10. `project.data.templates.apply`: high risk, previews and applies a complete schema template atomically with single human confirmation.
- Capability Groups & Authorization:
  - Capabilities grouped under `DATA_CAPABILITY_GROUPS`: `data.read`, `data.write`, `data.schema`, `auth.admin`.
  - Evaluated via `isDataCapabilityPermitted(agent.tools, tool)` in `CompanyToolRuntime`. Agents without matching group receive permission denied errors.
- Schema Templates Catalog (`packages/shared/src/project-data-templates.ts`):
  - Catalog of 4 templates: `ecommerce` (8 collections: categories, products, product_variants, carts, cart_items, orders, order_items, addresses), `blog` (4 collections: posts, categories, tags, comments), `crm` (4 collections: contacts, companies, deals, notes), `saas-basic` (3 collections: organizations, memberships, subscriptions).
  - Validation engine `validateTemplate`: strictly enforces that private collections (`KNOWN_PRIVATE_COLLECTIONS`) must declare owner-based access policies with `ownerField`. Rejects templates without required policies (`TEMPLATE_POLICY_MISSING`).
  - Declares GDPR strategies (`delete`, `anonymize`, `detach`, `retain`) for user-related collections.
  - Atomic application: compiles all collections and relations into ordered migrations, provides combined dry-run diff preview, applies all operations within a transaction, and rolls back in reverse order on failure. Requires single human approval.
- Agent Data Studio Service (`apps/agent-api/src/data-studio/agent-data-service.ts`):
  - Integrated into `CompanyToolRuntime` and `app.ts`.
  - Locked to `environment="dev"`. Addressing `prod` directly throws `PROD_ENVIRONMENT_FORBIDDEN`.
  - Rejects arbitrary SQL; agents can only invoke structured `SchemaOperation` or templates.
  - Validates identifiers against SQL injection, reserved keywords, and length limits.
  - Updates `PROJECT.md` Shared Project Context with synced schema overview (`## Data Schema (Data Studio)`) omitting row data and secrets.
- Intent Router Integration:
  - Added `ADD_DATA_MODEL` and `EDIT_DATA_MODEL` to `ProjectIntent`.
  - Natural language classifiers in `classifyProjectIntent` recognizing Ukrainian and English prompts.
  - Hybrid router routes data model actions to primary domain `"storage"`.
- Execution Limits:
  - Max 50 schema operations per run (`MAX_SCHEMA_OPS_PER_RUN = 50`).
  - Max 100 rows per agent insert or delete (`MAX_ROWS_PER_MUTATION = 100`).

## Implemented in D4

- Project Auth Schema & System Tables:
  - Migrator initializes system tables with prefix `_npati_auth_*`: `_npati_auth_users`, `_npati_auth_roles`, `_npati_auth_user_roles`, `_npati_auth_refresh_tokens`, `_npati_auth_verification_tokens`, `_npati_auth_reset_tokens`.
  - Foreign key constraints with `ON DELETE CASCADE` between users and authentication tokens/roles.
  - Protected identifier quoting prevents collisions with user tables.
- Cryptography & Security Engine (`apps/agent-api/src/data-studio/auth-crypto.ts`):
  - Memory-hard password hashing using `scrypt` (`N=16384, r=8, p=1, keyLen=32`) with random 16-byte salt and constant-time `timingSafeEqual` comparison.
  - Dummy scrypt execution on non-existent users during login and password reset to prevent user enumeration via timing analysis.
  - In-memory lockout rate limiter (`AuthRateLimiter`) with 5-attempt threshold and 15-minute temporary lockout.
  - Asymmetric Ed25519 JWT access tokens signed with isolated keys per `DataBackend + environment`, containing `kid`, `iss`, `aud`, `sub`, and role claims.
  - Asymmetric key rotation (`rotateSigningKey` / `rotateBundle`) allowing previous keys to remain valid until access token TTL expires while signing new tokens with the new active key.
  - Opaque refresh tokens stored strictly as SHA-256 hash in `_npati_auth_refresh_tokens`. Automatic token rotation on refresh, and reuse detection that immediately revokes the entire token family.
- Email Provider Abstraction (`apps/agent-api/src/data-studio/email-provider.ts`):
  - Pluggable `EmailProvider` interface.
  - `UnconfiguredEmailProvider` fails explicitly with `EMAIL_SERVICE_UNCONFIGURED` and friendly instruction to configure email before sending verification or reset emails.
  - `MockEmailProvider` captures sent emails in memory for unit testing and local development.
- Access Policies & PostgreSQL RLS Compiler (`apps/agent-api/src/data-studio/rls-compiler.ts`):
  - Compiles declarative policies (`public`, `authenticated`, `owner`, `role`) into `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and scoped `CREATE POLICY` statements.
  - Enforces both `USING` and `WITH CHECK` clauses for data modification actions.
  - Uses `current_setting('npati.auth.user_id', true)` and `current_setting('npati.auth.user_role', true)` configured per-transaction/query.
  - Computes deterministic SHA-256 policy fingerprints for drift detection.
- GDPR Data Portability & Deletion (`apps/agent-api/src/data-studio/auth-service.ts`):
  - Automatic discovery of user reference collections via `information_schema.columns` (`user_id`, `owner_id`, `author_id`, `account_id`, `created_by`).
  - Configurable collection-level GDPR strategies: `delete`, `detach`, `anonymize`, `retain` (defaulting to `anonymize` for transactional/audit collections like orders and payments).
  - `previewDeleteUser` computes affected row counts per collection before deletion.
  - `exportUserData` exports complete user profile, metadata, and all related collection records in a portable JSON format.
  - `deleteUser` executes non-cascading strategy application inside an atomic transaction, requiring explicit `confirmed: true`.
- Canonical Agent Capabilities registered in `defaultCapabilityRegistry` and `CAPABILITY_MATRIX` (total capabilities increased from 344 to 346, agent-callable from 80 to 82):
  1. `project.auth.inspect` (inventory ID 345): low risk, inspects auth settings, active roles, access policies, without leaking passwords, hashes, or tokens.
  2. `project.auth.configure` (inventory ID 346): medium/high risk, updates auth settings and applies access policies, requiring human approval for sensitive security mutations.
  - Integrated into `CompanyToolRuntime` and classified in `company-runtime.ts`.
- Data Studio UI (Authentication Tab in `apps/web/src/DataStudioAuthSection.tsx`):
  - Sub-tabs: Users, Settings, Permissions (RLS), and GDPR Audit/Export.
  - Users view: search, status filter (`active`, `suspended`, `pending`), toggle status, role management modal, GDPR export, and GDPR deletion preview modal.
  - Settings view: registration toggle, email verification requirement, password length, numeric and symbol requirements, token TTLs, and one-click JWT signing key rotation with confirmation.
  - Permissions (RLS) view: per-collection policy editor (Public, Authenticated, Owner, Role), custom owner field selector, and live SQL preview showing generated Postgres RLS statements.
  - Confirmation modals and notifications with bilingual support (Ukrainian & English).

## Explicitly outside D4

- No public Project API gateway or publishing of `PROJECT_PUBLISHABLE_KEY` / `PROJECT_SECRET_KEY` (D5).
- No CORS middleware or client SDK distribution for mobile/web apps (D5).
- No Project Auth UI widgets in Website Builder canvas (D6).
- No environment promote workflow (D7).

## Verification

- Automated tests:
  - `tests/data-studio-project-auth.test.ts` (19 passing tests):
    1. Scrypt password hashing & policy enforcement.
    2. Rate limiting & brute force lockout without user enumeration.
    3. Ed25519 JWT signing, verification, kid header, wrong issuer/audience rejection, and expiration handling.
    4. Key rotation with graceful backward compatibility for previous keys.
    5. Opaque refresh token generation and SHA-256 hashing.
    6. Email provider abstraction with `EMAIL_SERVICE_UNCONFIGURED` handling.
    7. PostgreSQL RLS compiler with ENABLE/FORCE RLS, USING, WITH CHECK, and fingerprint calculation.
    8. End-to-end registration, email verification, login, refresh with rotation, token reuse detection revoking whole family, and logout.
    9. Password reset flow with single-use hashed token and session invalidation.
    10. GDPR preview, portable JSON data export, and non-cascading deletion strategies (`retain`, `detach`, `delete`, `anonymize`).
    11. Cross-tenant isolation between different companies and workspaces.
    12. Agent capabilities `project.auth.inspect` and `project.auth.configure` execution through `CompanyToolRuntime` with credential leak protection.
    13. HTTP Fastify routes for registration, user listing, and settings update.
  - All Data Studio test suites pass (48 passing tests across 7 files):
    - `data-studio-project-auth.test.ts` (19 tests)
    - `data-studio-ui-api.test.ts` (10 tests)
    - `data-studio-agent-capabilities.test.ts` (11 tests)
    - `data-studio-core-migration.test.ts`
    - `data-studio-identifiers.test.ts`
    - `data-studio-routes.test.ts`
    - `data-studio-schema.test.ts`
  - Regression test suites pass:
    - `developer-capability-inspector.test.ts` (8 passing tests, updated to 346 total items / 82 agent-callable tools)
    - `capability-registry.test.ts` (10 passing tests, verified metadata and API exposure)
- TypeScript Typecheck: `npm run typecheck` passes with 0 errors across all 13 workspace packages.
- Web Production Build: `npm --workspace=@npati/web run build` passes with code 0.

## Known issues and risks

- Live PostgreSQL acceptance remains unverified in this test environment due to Docker daemon absence. Integration tests with real Postgres should run in a CI or Docker-enabled environment.
- In-memory workspace store used in mock unit tests; full Postgres store integration test requires a live Postgres instance.
- Pre-existing red suites outside D5's code paths: `company-runtime.test.ts` (4 failures: A2A planning, OmniRoute Fusion, cancel, provider-failure status) and `manual-product-e2e-web.test.ts` (1 failure: run status does not become `failed`). They fail in isolation as well as under load. Neither these tests nor `company-runtime.ts` was touched by D4/D5 (`company-runtime.ts` was last changed in D3, the tests in earlier commits), so they are recorded as pre-existing rather than silenced.

## D5 handoff

D5 (Project API Gateway) can build upon:
1. `ProjectKeyManager` and Ed25519 JWT verification for authenticating client incoming requests.
2. `_npati_auth_users` and RLS `set_config('npati.auth.user_id', ...)` session binding.
3. Pre-existing `DataBackendRepository` storing project publishable and secret keys.
4. Fastify public route patterns established in `auth-routes.ts`.

## Implemented in D5

Architecture decision (from audit): the Project API gateway is a module inside the existing Fastify `agent-api`, with its own public routes, runtime-only pools, CORS and rate limiting. The external URL (`/v1/projects/:projectId/...`) allows extracting it into a separate service later.

- Gateway (`apps/agent-api/src/data-studio/gateway-service.ts`, `gateway-routes.ts`):
  - `/v1/projects/:projectId/data/:collection[/:id]`: list/get/create/update/delete with filters (`filter[field]=` or JSON object), sorting, pagination (max 100 rows), field selection and relation `include`.
  - Auth routes over D4 `ProjectAuthService`: register/signup, login/signin, logout/signout, refresh, me, verify-email, forgot-password, reset-password.
  - Unified error envelope `{ error: { code, message, status } }`.
  - Per-project OpenAPI (`openapi.json`), generated TS types (`types.ts`) and Swagger `docs`, generated from the live schema (`openapi-generator.ts`). These require a valid Project API key; the environment is taken from the key.
  - Write routes have a 1 MB body limit (`PROJECT_API_BODY_LIMIT`). Invalid `filter` JSON returns `400 INVALID_FILTER`.
- Request execution: runtime-role pool only (`provisioner.getConnection(..., "runtime")`); every request runs `BEGIN` → `set_config(name, $1, true)` for `npati.auth.user_id`, `npati.auth.user_role`, `npati.project_id`, `npati.user_id` → query → `COMMIT/ROLLBACK`. Claims are transaction-local, so they are pooling-safe. Identifiers are validated against `information_schema` and quoted; values are always bound. Migrator/provisioner credentials are never used by the gateway.
  - Fixed in D5 completion: the previous code used `$2`/`$3` placeholders with a single value, which real Postgres rejects.
- Keys (`api-key-manager.ts`): `npati_pk_<env>_*` / `npati_sk_<env>_*` per DataBackend + environment, stored in Core `providerConfig` (secret only as SHA-256 hash + `CryptoVault`-encrypted copy), rotation, constant-time secret comparison. The environment is encoded in the key and validated, so dev keys never work on prod.
  - Rotation keeps a grace period: `previousKeys` (max 5, with `deprecatedAt`) is persisted instead of being discarded, and `validateKey` still accepts those keys with `isDeprecated: true`, so clients are not cut off the moment an owner rotates.
  - Data Studio → API exposes Reveal secret key (`business:manage`), Rotate keys (returns the new secret once) and the OpenAPI document through the owner-authenticated route `/data-studio/:environment/api/openapi.json`.
  - Secret key is rejected when an `Origin` header is present (`SECRET_KEY_IN_BROWSER`). It runs as the runtime role with `npati.auth.user_role = service_role`; it is NOT BYPASSRLS. Service access works only where policies explicitly grant `role = service_role`.
- Protection: CORS allowlist `providerConfig.corsOriginsByProject[projectId]` (exact origin match, per Project, per environment) for preflight and requests; rate limits per key and per IP (`rate-limiter.ts`, 429 `RATE_LIMIT_EXCEEDED`); access-policy check before every query (`POLICY_DENIED`), then RLS in the DB.
  - Gateway routes are registered with `{ config: { cors: false } }`, so the application-wide `@fastify/cors` plugin no longer answers or decorates `/v1/projects/*`; the per-Project allowlist is the effective control for both preflight (`OPTIONS`) and requests.
  - Auth routes use the same 1 MB body limit as data writes; `filter` clauses are bounded to 10, sort clauses to 5, selected fields to 50 and relation includes to 5 (`INVALID_FILTER` / `INVALID_QUERY`).
- SDK: `packages/project-client` (`createProjectClient({ apiUrl, publishableKey })`): `auth.signUp/signIn/signOut/getUser/getSession/refreshToken/verifyEmail/forgotPassword/resetPassword/onAuthStateChange` and `from(collection).list/get/create/update/delete`. Plain `fetch`, works in browser, Node and React Native; token storage is pluggable (`ProjectClientStorage`). `createProjectClient` throws if a secret key is passed in a browser. Typed via the generated `types.ts`.
- SDK delivery to the sandbox (fixes the D5 blocker): the SDK is vendored into the Project workspace as `npati-client.ts` by `ensureProjectSdkFile` (`project-sdk-file.ts`), so the sandbox and generated code import `./npati-client` without any package install. The source is read from `NPATI_PROJECT_CLIENT_PATH`, `/opt/npati-project-sdk/index.ts` (shipped by the agent-api image) or the repository checkout. The Shared Project Context documents that import path. `project.api.inspect` also reports `sdk: { file, importPath, available }`.
- Website Builder integration:
  - `ProjectSandboxService` injects only `PROJECT_API_URL` and `PROJECT_PUBLISHABLE_KEY` (from `getSandboxEnvironment`, dev only, derived from `NPATI_PROJECT_API_PUBLIC_URL`).
  - Background processes (the Live Preview dev server started through `project.terminal.process`) receive those two variables but nothing else: `sandboxProcessEnvironment` accepts only `SANDBOX_PROCESS_ENVIRONMENT_ALLOWLIST` and rejects secret references, so enabling the Project API no longer breaks Live Preview.
  - `isForbiddenSandboxVariable` removes `PROJECT_SECRET_KEY`, `DATABASE_URL`, `PG*`, `POSTGRES*`, `NPATI_PROJECTS_POSTGRES*`, `*_DB_URL/PASSWORD/USER/HOST` even if requested via `environmentReferences`.
  - Sandbox egress: `sandboxAllowedHostsWithProjectApi` adds only the Project API host to the existing egress proxy allowlist; database-like hosts are never added. Sandboxes still have no network route to `postgres-projects`.
  - SSR/server actions in dev/preview use the user JWT + RLS; `PROJECT_SECRET_KEY` is deploy-only (D7/DeployProvider after approval) and is never written into sandbox or Project Context.
  - Compact SDK/API documentation is added to `PROJECT.md` (`agent-data-service.ts`).
- Capability: `project.api.inspect` (low risk, endpoints/schema, no keys) in `project-data-capabilities.ts`, handled by `CompanyToolRuntime`. Client code generation uses the existing `project.files.*` capabilities.
- Logging & usage: Core migration `062` adds `project_api_request_logs` (method, path without query string, status, duration, key type, IP; no bodies, keys or tokens). Usage = request counts + DB size (`provisioner.getUsage`) + collections count. Shown in Data Studio → API tab (`apps/web/src/DataStudioApiSection.tsx`).

## Explicitly outside D5

- Promote dev → prod, deploy-time secret key injection (D7).
- Hard quota enforcement / blocking writes at limit (D7). D5 only counts and displays usage.
- Rate limiter is in-memory per API process. Multi-instance deployments need a shared store.
- No response-size limit is enforced (row, field, filter, sort and include bounds are); requests rejected before authentication (401/403/429) are not written to `project_api_request_logs`.
- mobile_app projects, secure token storage in React Native (D6).

## D5 verification

- `tests/data-studio-d5-completion.test.ts` (8) covers the D5 completion pass: background-process environment allowlist, Live Preview process start receiving only `PROJECT_API_URL` / `PROJECT_PUBLISHABLE_KEY`, SDK vendoring into the Project workspace (idempotent, present in the sandbox sync file list), the Shared Project Context import path, API key rotation grace (`previousKeys`, `isDeprecated`, retention window) and the `project.api.inspect` registry/group wiring.
- `tests/data-studio-project-api.test.ts` (5) and `tests/data-studio-project-api-http.test.ts` (14), all passing. They cover:
  - publishable CRUD under policies;
  - owner collection denied to anonymous users, with the user id bound for authenticated users;
  - the unified error envelope;
  - secret key rejected with an Origin and running as `service_role` without `SET ROLE`/BYPASSRLS;
  - foreign origin and preflight rejected;
  - Project A's origin rejected on DataBackend B;
  - A keys rejected on B and dev keys rejected on prod;
  - 429 on the per-key limit;
  - SQL injection via sort, fields, filter keys, collection name and invalid filter JSON;
  - docs/OpenAPI/types require a key;
  - logs without keys, tokens or query values;
  - sandbox env limited to the two variables, with forbidden variables stripped;
  - the egress allowlist adds only the API host.
- Capability counters are synchronized with the registry again: 347 capabilities total, 83 agent-callable (`developer-capability-inspector.test.ts`, `capability-registry.test.ts`, `full-capability-regression.test.ts`, `control-plane-ui-and-revisions.test.ts`, `invariants-and-anti-patterns.test.ts`, `phase13-upgrade-gate-expanded.test.ts`, `phase14-final-production-acceptance.test.ts`, `production-acceptance.test.ts`, `upgrade-compatibility-and-release-gate.test.ts`, `manual-product-e2e-web.test.ts`). These files had been stale since D3/D4 (`334`/`70`) and D5 added the `project.api.inspect` capability without updating them; the `project.api.inspect` assertions are now covered directly.
- Data Studio UI fixes found during the same pass: `DataStudioApiSection` and `DataStudioAuthSection` now request `/api/...` (only `/api/` is proxied by Vite and nginx), and the OpenAPI link no longer points at a keyless public URL.
- Not verified automatically: live Postgres RLS with the gateway, the generated shop running in Live Preview, and the end-to-end chat acceptance scenario. These need Docker (`postgres-projects` + sandbox runner).

## Manual acceptance check (requires Docker)

1. `docker compose --profile data-studio up -d`; set `NPATI_PROJECT_API_PUBLIC_URL`.
2. In chat: "Створи інтернет-магазин". Expect the agent to apply the ecommerce template → configure auth/policies → generate a frontend that imports `createProjectClient` from `./npati-client` (vendored into the workspace) using `PROJECT_API_URL` and `PROJECT_PUBLISHABLE_KEY`.
3. Add the Project preview origin to the CORS allowlist in Data Studio → API.
4. In Live Preview: register, browse products, add to cart, create an order. In Data Studio → Data → orders, the owner sees the order. Data Studio → API shows request logs.

## D6 handoff

D6 can rely on:
1. `packages/project-client` SDK (fetch-based, RN compatible; token storage is pluggable and must use secure storage in D6).
2. The same `/v1/projects/:projectId` gateway, keys and CORS allowlist per Project. Mobile clients send no Origin header, so key + JWT + rate limits are the controls there.
3. `getSandboxEnvironment` / `isForbiddenSandboxVariable` for injecting only publishable config into the mobile_app sandbox, plus `SANDBOX_PROCESS_ENVIRONMENT_ALLOWLIST` / `sandboxProcessEnvironment` for background processes (Expo/Metro dev server).
4. `project.api.inspect` (now reporting `sdk: { file, importPath, available }`) and the PROJECT.md SDK section for agent code generation.
5. `ensureProjectSdkFile` / `PROJECT_SDK_IMPORT_PATH` when a mobile app should be generated against the vendored client; a React Native build outside the sandbox should still consume the `@npati/project-client` package.

## Implemented in D6

Architecture decisions:
- A mobile app is a **Project of type `mobile_app`** attached to the **same DataBackend** as the website: same collections, same end users, same access policies and RLS. No database copy, no second Auth installation.
- Preview is an **Expo Web export served statically** through the existing preview proxy (port 3000). Metro's dev server is intentionally not the default because the proxy has no WebSocket support and caps responses at 8 MB; a static export keeps Live Preview inside the current limits. Store builds stay out of scope.
- Deep links are covered by a **per-project redirect URL allowlist** in Core (`project_redirect_urls`); the gateway never trusts a client-supplied redirect.

Core DB (migration `063_mobile_app_projects`, registered in `packages/workspace/src/postgres-store.ts`):
- `projects.type` CHECK extended with `mobile_app` (new project types still need a migration).
- `projects.app_scheme` (deep link scheme of the generated app).
- `project_redirect_urls` (id, workspace, company, project, environment, url, created_at) with a unique index per (project, environment, url).
- Store contract: `ProjectType` + `PROJECT_TYPES`, `Project.appScheme`, `ProjectInput.dataBackendId`/`appScheme`; `createProject` now persists `data_backend_id` and `app_scheme` (the composite FK keeps the backend inside the same Company).

Generated app template (`packages/shared/src/mobile-app-template.ts`):
- `createMobileAppScaffold()` writes an Expo (SDK 51) + TypeScript app: `package.json`, `app.config.js`, `tsconfig.json`, `App.tsx`, `src/config.ts`, `src/api.ts` (SDK client with `expo-secure-store`), `src/validation.ts`, `src/schema.ts`, auth / list / detail / form screens and a `README.md` with the D6 rules.
- `app.config.js` reads `PROJECT_API_URL` / `PROJECT_PUBLISHABLE_KEY` from the sandbox environment into Expo `extra`, so the sandbox environment contract stays at exactly those two variables.
- Helpers: `slugifyProjectName`, `defaultAppScheme`, `isValidAppScheme`, `normalizeAuthRedirectUrl`, `isAuthRedirectAllowed`, `MOBILE_APP_FRAMEWORK`, `MOBILE_APP_PREVIEW_PORT`.

SDK (`packages/project-client`):
- `createSecureStoreStorage(secureStore)` maps the session (including the refresh token) onto `expo-secure-store` (Keychain / Keystore), never plain AsyncStorage.
- `buildAuthRedirectUrl(scheme)` and `parseAuthDeepLink(url)` for verification / reset deep links (`kit` inferred from `kind` or the path).
- `forgotPassword(email, { redirectTo })` and `signUp({ ..., redirectTo })` request a deep link; `createProjectClient` now refuses a secret key in a browser **or** a React Native runtime.

Project Auth redirect allowlist:
- `ProjectRedirectRepository` (Core) normalizes targets (absolute URL, no query, no fragment, no credentials, custom schemes allowed), dedupes, caps at 20 per project + environment and rejects unknown targets with `REDIRECT_NOT_ALLOWED`.
- `ProjectAuthService` validates `redirectTo` before issuing any token, builds `<redirect>?token=...` and passes it to the email provider (`ProjectEmailOptions.link`; `MockEmailProvider` records it). Admin routes: `GET/PUT /companies/:companyId/projects/:projectId/data-studio/:environment/auth/redirects`.
- Data Studio → Authentication → Settings has a "Redirect URLs (deep links)" editor; the generated app README points at it.

Project creation and orchestration:
- `POST /companies/:companyId/projects` accepts `mobile_app`, `dataBackendId` and `appScheme`; `ProjectService.create` validates the scheme (`mobile_app` only) and passes the backend through.
- Intent Router: mobile requests (`isMobileAppRequest`, "створи мобільний додаток", "react native", "expo", "android/ios app") are recognized inside `CREATE_PROJECT` and carry `targetDetails.projectType = "mobile_app"` + `framework: "Expo"`; `extractFramework` also knows Expo.
- `ProjectOrchestrator` branches on the type: it resolves the shared DataBackend (single ready backend → use it; one named in the prompt → use it; several → `DATA_BACKEND_CHOICE_REQUIRED` asking the owner which one; none → `DATA_BACKEND_REQUIRED`), creates the project with that backend, sets `framework: "Expo"` / `runtime: "expo"`, scaffolds the Expo template, registers `<scheme>://auth/callback` for dev and prod, writes a mobile-specific `PROJECT.md` (shared DataBackend, publishable key only, `./npati-client`, secure storage) and uses a "Mobile App Builder" agent (`canBuildMobileApp`).
- Preview stack detection: `detectProjectStack` recognizes Expo (`expo` dependency or `react-native` + `app.json`/`app.config.js`) and returns framework `expo`, port 3000 and `expo export --platform web` + static serve. `expo` was added to the terminal policy framework CLI, and `expo export` is classified as an install/build command.
- Web UI: `mobile_app` is selectable in Projects and in the Website Builder dashboard (which now scaffolds the Expo template instead of a Next.js/Vite one); type labels are localized in all seven locales.

Build boundary (`apps/agent-api/src/build-provider.ts`, new):
- `BuildProvider` / `BuildError` / `BuildResult` with `MobilePlatform = "ios" | "android"`, plus `UnconfiguredBuildProvider` that fails with `BUILD_PROVIDER_UNCONFIGURED` (503) and a documented `EasBuildProvider` TODO. Nothing wires it to a capability yet: store builds need Apple/Google accounts, signing keys and approval, and are a later step.

## Explicitly outside D6

- iOS/Android store builds, signing credentials, TestFlight/Play submission and push notifications (later step as a high-risk action with approval).
- Physical device / simulator runs: Live Preview is Expo Web in the sandbox only.
- Real email delivery: only `UnconfiguredEmailProvider` (fails explicitly) and `MockEmailProvider` exist, so deep links can be validated and recorded but not yet delivered to a mailbox.

## D6 verification

- `tests/data-studio-mobile-app.test.ts` (11) covers: the Expo template and its preview script, absence of `PROJECT_SECRET_KEY`/`npati_sk_*`/`DATABASE_URL`/`postgres://` in generated files, scheme derivation and rejection of reserved schemes, redirect normalization (query/fragment/credentials rejected), exact-match allowlist behaviour, repository dedupe/cap/`REDIRECT_NOT_ALLOWED`, `ProjectAuthService` redirect enforcement before token issuance plus the admin list/update round trip, React Native secure storage mapping, deep link parsing, the secret-key guard in an RN runtime, `mobile_app` creation with a shared `dataBackendId` and default scheme, scheme/type validation, mobile intent classification (3 languages), Expo stack detection, and the unchanged sandbox environment contract.
- Regression suites for Project Auth, gateway, Data Studio routes/UI/capabilities, project foundation, intent router, preview, terminal policy, website builder, capability counters and the capability inspector are expected green (see the run log referenced from the step report).

## D7 handoff

D7 (promote, real dump/restore, quotas, external provider, drift remediation) can rely on:
1. `DataBackendService`/`DatabaseProvisioner` snapshots and `ProjectMigrationEngine` drift detection as the promote/demote seam between dev and prod.
2. Per-project registries that already carry environment scoping: `project_redirect_urls`, `project_api_request_logs`, access policies and provider config.
3. `BuildProvider` as the seam for mobile build/publish work, with `ProjectRedirectRepository` and the SDK deep link helpers already in place.
4. The `mobile_app` project type and `projects.app_scheme` for release metadata (bundle identifiers, store tracks) instead of new tables.
