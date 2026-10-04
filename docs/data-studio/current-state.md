# NPATI Data Studio + Project Auth — Current State

## Status

- Current step: D3 completed. All unit, API, schema, UI, agent capability, template, intent router, and capability inspector tests pass. Typecheck clean across all 13 workspace packages. Web production build passes. Live PostgreSQL acceptance remains unverified because the local Docker daemon is unavailable.
- Completed steps: D0 audit, D1 core backend engine & provisioning, D2 Data Studio UI & management API, D3 Agent capabilities, approval, and schema templates.
- Next step: D4 (Project Auth: client auth, sessions, tokens, RLS compiler).
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
  - Natural language classifiers in `classifyProjectIntent` recognizing Ukrainian and English prompts ("додай у проєкт таблиці для інтернет-магазину", "створи інтернет-магазин", "додай таблицю для замовлень", "зміни структуру таблиці products", "видали колонку з таблиці").
  - Hybrid router routes data model actions to primary domain `"storage"`.
- Execution Limits:
  - Max 50 schema operations per run (`MAX_SCHEMA_OPS_PER_RUN = 50`).
  - Max 100 rows per agent insert or delete (`MAX_ROWS_PER_MUTATION = 100`).

## Explicitly outside D3

- No Project Auth (client login, registration, JWT sessions, RLS user mapping, password hashing, email verification) (D4).
- No public Project API gateway or publishing of `PROJECT_PUBLISHABLE_KEY` / `PROJECT_SECRET_KEY` (D5).
- No Project Auth UI in Website Builder (D6).
- No environment promote workflow (D7).

## Verification

- Automated tests:
  - `tests/data-studio-agent-capabilities.test.ts` (11 passing tests): canonical registry & matrix registration, capability group permissions (`data.read`/`data.write`/`data.schema`), template validation requiring owner policies, template catalog validation, identifier & field type validation, approval requirement for destructive changes and execution upon approval, atomic ecommerce template application and `PROJECT.md` context sync, tenant isolation & cross-company protection, missing backend error handling, `CompanyToolRuntime` agent authorization, intent classification for Ukrainian/English phrases.
  - All Data Studio test suites pass (29 passing tests across 6 files):
    - `data-studio-agent-capabilities.test.ts`
    - `data-studio-core-migration.test.ts`
    - `data-studio-identifiers.test.ts`
    - `data-studio-routes.test.ts`
    - `data-studio-schema.test.ts`
    - `data-studio-ui-api.test.ts`
  - Regression test suites pass:
    - `developer-capability-inspector.test.ts` (8 passing tests, updated to 344 total items / 80 agent-callable tools)
    - `capability-registry.test.ts` (10 passing tests, verified metadata and API exposure)
    - `risk-approval.test.ts` (10 passing tests)
    - `project-intent-router.test.ts` (21 passing tests, tenant isolation and project context)
- TypeScript Typecheck: `npm run typecheck` passes with 0 errors across all 13 workspace packages.
- Web Production Build: `npm --workspace=@npati/web run build` passes with code 0.

## Known issues and risks

- Live PostgreSQL acceptance remains unverified in this test environment due to Docker daemon absence. Integration tests with real Postgres should run in a CI or Docker-enabled environment.
- In-memory workspace store used in mock unit tests; full Postgres store integration test requires a live Postgres instance.

## D4 handoff

D4 (Project Auth) can build upon:
1. `validateTemplate` access policies: templates declare `accessPolicies` (`rule: "owner"`, `ownerField: "owner_id"`) and `gdprStrategies`. D4 will compile these into PostgreSQL RLS policies (`CREATE POLICY ... USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id)`).
2. `AgentDataStudioService` and `ProjectMigrationEngine` for managing auth tables (`_npati_auth_users`, `_npati_auth_sessions`, `_npati_auth_identities`) in project databases.
3. Pre-existing `auth.admin` capability group in `DATA_CAPABILITY_GROUPS`.
4. Tenant isolation and DataBackend dev/prod environment model.
