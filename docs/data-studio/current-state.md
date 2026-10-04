# NPATI Data Studio + Project Auth — Current State

## Status

- Current step: D1 implemented in the repository; live PostgreSQL acceptance remains unverified because the local Docker daemon is unavailable.
- Completed steps: D0 audit. D1 code and automated checks are described below. D2 has not started.
- Source of truth: `docs/data-studio/PLAN.md`, `docs/data-studio/00-audit.md`, and repository code.

## Implemented in D1

- Core DB migration `060_data_backends` adds `data_backends`, environments, encrypted secret records, migration history and locks, snapshots, UI metadata, access policies, and nullable `projects.data_backend_id` with a same-company foreign key. `Project` and Postgres project reads expose the optional backend ID. In-memory projects remain valid without a backend.
- `DataBackendRepository` applies workspace/company/owner scoping, keeps role passwords encrypted with the existing `CryptoVault`, checks project attachment in a transaction, and holds a Core lock with expiry for schema changes.
- `DataBackendService` creates and provisions dev/prod databases, lists/reads/renames/archives/activates backends, attaches or detaches projects, and requires name confirmation plus no active attached projects for removal. Archiving disables runtime login and terminates existing runtime sessions. Project deletion leaves the backend intact.
- `DatabaseProvisioner` defines provision, deprovision, connections by role, rotation, snapshot, restore and usage. `SharedPostgresProvisioner` creates one database per backend and environment with separate migrator and runtime roles. It removes PUBLIC database connect and schema privileges, limits connections and query time, and stores role passwords only in encrypted Core storage. The project database and backup tooling are available only to the API process.
- `DataProvider` and `PostgresDataProvider` compile structured schema operations, validate and quote identifiers, bind row values and filters, use runtime credentials for data operations, enable and force RLS for new collections and join tables, introspect the live schema, and compute a stable schema fingerprint. Runtime has no table grants or policies by default. The D1 integration test explicitly grants a collection and adds a test policy to exercise runtime writes; policy compilation belongs to D4.
- `ProjectMigrationEngine` has dry run, transactional apply, separate `_npati_migrations` history, Core mirror, checksum, destructive and snapshot flags, safe rollback, Core TTL and PostgreSQL advisory locks, and drift detection. Core keeps UI metadata and policy intent; actual project schema is the structural source of truth, compared with the last successful fingerprint.
- Company-scoped API routes expose DataBackend create, read, list, rename, archive, activate, remove and project attach/detach. No schema or row API route is exposed in D1.
- Compose files add an opt-in `data-studio` profile with a separate `postgres-projects` volume, internal network, healthcheck, resource limits and no host port. API receives the admin credential from environment; worker does not. Runtime image includes `pg_dump` and `pg_restore`. `.env` examples and `docs/INSTALLATION.md` describe startup.
- Limits are configurable for collections, fields, database bytes, rows per response and queries per minute. Database outages return a structured Data Studio error without stopping the NPATI API.

## Explicitly outside D1

- No UI, agent capabilities/groups, Project Auth, Project API gateway, policy compiler, automatic reconciliation, or external Postgres provider. The Core policy/UI metadata tables are foundations for later steps.
- `PROJECT_PUBLISHABLE_KEY` and `PROJECT_SECRET_KEY` are not issued in D1.

## Verification

- Focused D1 unit and route tests pass. A PostgreSQL integration test covers provisioning, tenant isolation, role attributes, RLS default-deny, migration/rollback, drift and deprovision, but skips unless `NPATI_DATA_TEST_CORE_URL` and `NPATI_DATA_TEST_PROJECTS_ADMIN_PASSWORD` are set. It has not run against a live server here because Docker Desktop's daemon is unavailable.
- `npm run typecheck` and direct API build pass. Direct web build and both Compose configuration checks pass. The full test suite still fails in existing approval/chat/project-router tests; the focused D1 suite passes (8 tests, live integration skipped).
- No lint script exists in the root or workspace package scripts.
- Root `npm run build` fails before compilation because `OMNIROUTE_VERSION` is absent in this checkout; this also happened before D1.

## Known issues and risks

- The live PostgreSQL integration acceptance, especially privilege isolation, snapshot restore and concurrent lock behavior, remains unverified in this environment. D1 should not be considered production ready until it passes against PostgreSQL 17.
- Snapshots are retained as files with expiry metadata. Automatic expiry cleanup, off-host backups and restore orchestration are not implemented in D1.
- A Core DB failure after a project migration commits can leave its Core mirror/fingerprint stale. The next drift check blocks further migration; operator reconciliation is required. A durable cross-database recovery workflow remains future work.
- Query rate limiting is process-local. Global distributed limits and public Project API protections belong to D5.
- Runtime DML becomes usable only after explicit grants and RLS policies. The policy compiler and authorization context are D4 work; no production row API is exposed yet.

## D2 handoff

D2 can build on the Core backend/environment entities, scoped DataBackend routes, `DatabaseProvisioner`, `DataProvider`, migration engine, schema introspection and fingerprints. First run the D1 PostgreSQL integration test on an isolated Core DB and `postgres-projects` cluster, then resolve any live PostgreSQL compatibility issues before adding D2 UI or agent capabilities.
