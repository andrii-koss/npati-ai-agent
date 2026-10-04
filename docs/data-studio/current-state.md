# NPATI Data Studio + Project Auth — Current State

## Status

- Current step: D2 completed. All unit, API, schema, and UI tests pass. Typecheck clean across all packages. Web production build passes. Live PostgreSQL acceptance remains unverified because the local Docker daemon is unavailable.
- Completed steps: D0 audit, D1 core backend engine & provisioning, D2 Data Studio UI & management API.
- Next step: D3 (Agent capabilities for Data Studio).
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

## Explicitly outside D2

- No agent capabilities / capability groups for Data Studio (D3).
- No Project Auth (client login, registration, sessions, email verification, passwords, RLS user mapping) (D4).
- No public Project API gateway or publishing of `PROJECT_PUBLISHABLE_KEY` / `PROJECT_SECRET_KEY` (D5).
- No automated reconciliation on schema drift (drift is detect-and-inspect only in D2).
- No environment promote workflow (D7).

## Verification

- Automated tests:
  - `tests/data-studio-ui-api.test.ts` (10 passing tests): overview, tenant isolation, SQL injection prevention in identifiers, prod schema change blocking, drift blocking Apply, row CRUD, CSV export formula injection escaping, CSV import type validation, multi-project backend sharing, service availability.
  - All Data Studio test suites pass (18 tests total across 5 files):
    - `data-studio-core-migration.test.ts`
    - `data-studio-identifiers.test.ts`
    - `data-studio-routes.test.ts`
    - `data-studio-schema.test.ts`
    - `data-studio-ui-api.test.ts`
- TypeScript Typecheck: `npm run typecheck` passes with 0 errors across all 13 workspace packages.
- Web Production Build: `npm --workspace=@npati/web run build` compiles Vite bundle and CSS assets successfully.

## Known issues and risks

- Live PostgreSQL acceptance remains unverified in this test environment due to Docker daemon absence. D1/D2 integration tests with real Postgres should run in a CI or Docker-enabled environment.
- In-memory workspace store used in mock unit tests; full Postgres store integration test requires a live Postgres instance.
- Schema drift auto-reconciliation is intentionally omitted in D2; operators must resolve drift manually or in future reconciliation tooling.

## D3 handoff

D3 can build upon:
1. `validateOperation` and `DataStudioUiService` schema operation pipelines.
2. `ProjectMigrationEngine` dry-run, apply, and row query/mutation operations (`listOwnerRows`, `createOwnerRow`, `updateOwnerRow`, `deleteOwnerRows`).
3. Registered UI routes and migration history attribution (storing `runId` and agent author in `data_backend_migrations`).
4. Implement agent capabilities in `apps/agent-api` and `@npati/agent`:
   - `data_studio_inspect` (inspect schema, drift, collections, relations)
   - `data_studio_migrate` (propose schema operations with diff dry-run and apply)
   - `data_studio_query` (filtered row queries)
   - `data_studio_mutate` (create, update, delete rows)
   - Capability group assignment with risk tiers and approval gates.
