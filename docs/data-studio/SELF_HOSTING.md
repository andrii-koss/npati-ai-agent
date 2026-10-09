# Data Studio self-hosting guide (D1–D7)

This document covers the operational side of the Data Studio module: the separate Postgres for
project data, environments, promote, backups, quotas and external databases. It assumes the
standard `docker compose` installation described in the root `README.md`.

## 0. Dokploy / single-host production checklist

`docker-compose.dokploy.yml` defines **12 services**: web, agent-api, company-worker,
sandbox-runner, crawler, browser-use-worker, omniroute, qdrant, minio, redis, postgres and
**`postgres-projects`**. In this file every service starts unconditionally — the compose profiles
(`data-studio`, `local-sandbox`) exist only in the local development file `docker-compose.yml`,
where they are opt-in.

| Service | Holds | Why it matters |
| --- | --- | --- |
| `postgres-projects` | one **database + three roles per DataBackend + environment** | Data Studio project data; without it Data Studio reports the backend as unavailable. It is a single container for all projects, not one container per database |
| `sandbox-runner` | generated sites/apps | Terminal, Live Preview, browser QA, mobile preview |
| `postgres` | NPATI Core metadata only | never stores project rows |

In Dokploy set the following environment variables on the application (Environment tab) and
redeploy:

```dotenv
# 1. Project cluster credentials — the SAME value is used by postgres-projects and agent-api.
#    Both services now require it, so the deploy fails fast instead of starting a broken cluster.
NPATI_PROJECTS_POSTGRES_ADMIN_USER=npati_projects_admin
NPATI_PROJECTS_POSTGRES_ADMIN_PASSWORD=<openssl rand -hex 32>

# 2. Local sandbox runner on the same host (it is reachable as http://sandbox-runner:7865).
NPATI_SANDBOX_RUNNER_MODE=local
NPATI_SANDBOX_RUNNER_URL=http://sandbox-runner:7865
NPATI_SANDBOX_RUNNER_SECRET=<openssl rand -hex 32>   # must be at least 32 characters
NPATI_PREVIEW_SECRET=<openssl rand -hex 32>          # keeps preview links valid across restarts

# 3. Public HTTPS base URL of the Project API (Data Studio gateway).
#    Point a domain/proxy at the agent-api (port 3001) and set it here: the sandbox then receives
#    PROJECT_API_URL / PROJECT_PUBLISHABLE_KEY, the SDK is vendored into the Project workspace, and
#    the sandbox egress allowlist gets this host automatically.
NPATI_PROJECT_API_PUBLIC_URL=https://api.example.com
```

After the redeploy verify:

```bash
docker compose -p <project> ps                  # expect 12 services Up, postgres-projects included
curl -fsS https://api.example.com/health        # the Project API domain answers
# Inside the app: Company → Data must offer "New DataBackend".
```

If `postgres-projects` is still missing after an upgrade from an older revision, the container may
have been left out by the previous deploy. Force it once:

```bash
cd /etc/dokploy/compose/<project>/code
grep -n 'COMPOSE_PROFILES' .env                 # remove the variable: it is obsolete in this file
docker compose -p <project> --env-file .env -f ./docker-compose.dokploy.yml config --services
docker compose -p <project> --env-file .env -f ./docker-compose.dokploy.yml up -d --remove-orphans
docker ps -a --filter "name=postgres-projects" --format '{{.Names}} {{.Status}}'
docker logs --tail 50 <project>-postgres-projects-1
```

Reading `docker ps -a`: the container exists but restarts → check the password variable and the
`postgres-projects-data` volume; the container is absent → the running revision still has the old
profile gating, pull the current `main` and redeploy.

## 1. Containers and volumes
| Service | Purpose | Notes |
| --- | --- | --- |
| `postgres` | NPATI Core DB (`pgvector/pgvector:pg17`) | metadata only: DataBackends, environments, secrets, access policies, logs |
| `postgres-projects` | project databases | enabled by the `data-studio` compose profile, internal network only, no host port |
| `agent-api` | control plane + Project API gateway | holds the only provisioner credentials |
| `sandbox-runner` | runs generated sites/apps | `local-sandbox` profile, never receives DB credentials |

Volumes: `postgres-projects-data` (databases) and `postgres-projects-snapshots`
(`NPATI_PROJECTS_SNAPSHOT_DIR`, default `/app/project-snapshots`). Mount the snapshot volume on
storage you actually back up: it is the recovery path for a bad migration or promote.

```bash
# start with project databases enabled
docker compose --profile data-studio up -d

# generate the project cluster admin password and put it in .env
openssl rand -hex 32   # -> NPATI_PROJECTS_POSTGRES_ADMIN_PASSWORD
```

Compose profiles: `data-studio` starts `postgres-projects`; `local-sandbox` starts the sandbox
runner. On platforms such as Dokploy set `COMPOSE_PROFILES=data-studio,local-sandbox`.

## 2. Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `NPATI_PROJECTS_POSTGRES_HOST/PORT` | `postgres-projects:5432` | project cluster endpoint |
| `NPATI_PROJECTS_POSTGRES_ADMIN_USER/PASSWORD` | – | provisioner credentials (agent-api only) |
| `NPATI_PROJECTS_SNAPSHOT_DIR` | `.data/data-backend-snapshots` | where `pg_dump` files are written |
| `NPATI_PROJECTS_SNAPSHOT_RETENTION_DAYS` | `30` | snapshot retention; also delays DataBackend purge |
| `NPATI_DATA_MAX_*` | `50/100/100/600/1e9` | collections, fields, rows, queries/min, database bytes |
| `NPATI_DATA_MAX_CONNECTIONS` | `10` | warning threshold for connections (Postgres enforces the role limit) |
| `NPATI_DATA_BACKUP_INTERVAL_MINUTES` | `1440` (prod), `0` (dev) | automatic snapshot interval |
| `NPATI_DATA_BACKUP_KEEP` | `7` | how many automatic snapshots to keep |
| `NPATI_DATA_BACKUP_TICK_SECONDS` | `300` | how often the scheduler checks due backups |
| `NPATI_DATA_BACKUP_DISABLED` | – | set to `true` to stop the scheduler |
| `NPATI_PROMOTE_DATA_MAX_ROWS` | `500` | rows per collection copied when a promote requests data |
| `NPATI_PROJECT_API_PUBLIC_URL` | – | public HTTPS URL of the Project API (sandbox/generated apps) |

The Core DB stores one environment row per DataBackend and environment (`dev`, `prod`) with its
own database, three roles (provisioner/admin, migrator, runtime), Project API keys and JWT
signing keys. The runtime role is never a table owner, has no `SUPERUSER`/`CREATEDB`/
`CREATEROLE`/`BYPASSRLS`, and only receives explicit `GRANT`s.

## 2b. Managing tables from the UI

Settings → **Data Studio** (`/settings/data-studio`) is the owner-facing schema workbench:

- pick Company → Project → environment (`dev` / `prod`); the header shows the DataBackend, its
  sync status, any held migration lock and the live table list (fields, RLS state, policies,
  indexes);
- **New table** opens a left drawer: *From a schema* lists the built-in templates
  (e-commerce, blog, CRM, SaaS) with the collections and fields they create, plus an optional
  "add demo data" switch that only affects `dev`; *Manually* builds a table from a name and typed
  fields;
- editing a table (rename, add/change/drop a field) and deleting it go through the same
  preview → apply flow: the UI shows the generated SQL, the flags (`reversible`, `destructive`,
  `requiresSnapshot`) and requires a typed confirmation for deletion. A snapshot is taken
  automatically for destructive operations;
- `prod` is intentionally read-only there: promote the schema from **Promote & Quotas** instead.

The same operations are available to agents through the `project.data.schema.*` and
`project.data.templates.apply` capabilities (approval required).

## 3. Promote dev → prod
Promote is a DataBackend-level operation: `dev` is the environment agents and Live Preview write
to, `prod` is what the generated site/app serves. Promote replays the applied dev migrations onto
prod.

1. Data Studio → **Promote & Quotas** → *Preview promote*. The preview shows the pending
   migrations with their SQL, the flags (`reversible`, `destructive`, `requiresSnapshot`), the
   collection diff and — when "copy dev data" is enabled — the rows that would be copied.
2. Promote is blocked while prod reports `drift_detected`; inspect the diff and reconcile first.
   Promote is also serialized by the migration lock per backend + environment.
3. Approving takes a `pre_promote` snapshot of prod, applies the operations in version order and
   refreshes the prod fingerprint. `Reject` records the decision in the promote history.

Only the schema is promoted. Dev rows move to prod solely when the operator explicitly enables
`withData`; seeds are never promoted implicitly. Deploys never apply migrations: production
schema changes go through promote (direct prod schema edits are refused with `PROMOTE_REQUIRED`).

## 4. Backups and restore

- Automatic snapshots (`kind=scheduled`) follow the per-environment policy in Data Studio →
  **Backups** (interval + keep). `dev` defaults to disabled, `prod` to daily.
- Snapshots are also taken before every destructive/`requiresSnapshot` migration, before each
  promote (`pre_promote`) and before every restore (`pre_restore`).
- Manual snapshots and restore live in the same tab. Restore requires an explicit confirmation
  and is refused with `APPROVAL_REQUIRED` otherwise; for `prod` the environment name must be
  typed. Restore replaces the schema **and** the data of that environment.
- Retention: automatic snapshots are pruned beyond `keep`; everything else is pruned after
  `NPATI_PROJECTS_SNAPSHOT_RETENTION_DAYS`. Pruning removes the `.dump` file and its Core row.
- GDPR note: rows deleted through Project Auth GDPR flows are removed from the live database, but
  they remain inside snapshots until those snapshots expire with the retention window.

## 5. Quotas and monitoring

Data Studio → **Promote & Quotas** shows database size vs. limit, open connections, request
counts and the collections count. At 80% of the size limit the environment reports `warning`; at
100% it reports `exceeded` and the Project API refuses writes with `507 QUOTA_EXCEEDED` until data
is removed or the limit is raised. Limits can be overridden per environment (they are stored in
Core, not in the project database).

## 6. External databases (bring your own Postgres)

`external_postgres` DataBackends are supported for Neon, Supabase, RDS or any reachable Postgres:

1. Data Studio → **Data Backends** → create with provider `external_postgres` and a
   `postgres://user:password@host:5432/database` connection string. The connection string is
   encrypted in Core secret storage and never returned by the API.
2. NPATI introspects the target and tries to create a **migrator** and a **runtime** role. If that
   succeeds the backend runs in `managed` mode and behaves exactly like `postgres-projects`.
3. If the provider forbids role creation (typical for managed plans) the backend is marked
   `restricted`: NPATI then uses the owner credentials for migrations and data, says so in the UI,
   and credentials rotation must be done in the provider. RLS still applies to the policies NPATI
   creates, but the owner role may bypass it — treat restricted mode as a lower guarantee.
4. Drift detection runs before every migration and promote, because such databases can change
   outside NPATI. `synced` / `drift_detected` / `reconciliation_required` are shown in Data Studio;
   NPATI never reconciles automatically.
5. External databases are never dropped. Deleting the DataBackend removes NPATI-managed roles and
   secrets only.

## 7. Lifecycle

- Archiving a Project only changes its status; other Projects of the same DataBackend keep working.
  Deleting a Project detaches it and removes its CORS origins, redirect URLs and API logs.
- A DataBackend can be **transferred to another company** of the same workspace
  (Data Studio → open the database → *Transfer to another company*). Only Core metadata changes
  owner: the databases, roles and every row stay in place, so keys, Auth settings, access policies,
  backups and the promote journal move with it. Projects of the previous company are detached
  first, because a Project can never leave its company; attach the transferred database to the new
  company's Projects afterwards. Typical flow: create the new company → transfer the database →
  attach it to the new site/app → delete the old company.
- A company that still owns DataBackends cannot be deleted: the API answers
  `Company cannot be deleted while it owns N DataBackend(s)` (the foreign key is `ON DELETE
  RESTRICT`, so this is enforced by the database as well). Transfer or delete the databases first.
- Deleting a DataBackend is refused while active Projects are attached unless the confirmed request
  includes `detachProjects: true`. Settings → Data Studio explains that attached projects lose access,
  requires the exact database name, and sends this option. Detaching projects and scheduling deletion
  happen in one tenant-scoped transaction; the projects themselves are preserved. Afterwards the backend is
  marked `deleting`, its runtime roles are suspended, and databases, roles, keys and secrets are
  purged after the snapshot retention window (`remove_after`). Use `immediate: true` in the API to
  purge right away (for example in disposable test environments). Settings displays “Pending deletion”
  and the removal deadline while retention is active. Repeating the request does not extend that deadline.
- Activating an archived backend only re-enables the runtime role; the data is untouched.

## 8. Upgrades and troubleshooting

- Upgrading: pull the new images, restart `agent-api`. Core migrations run automatically on start
  (`schema_migrations` versions `060`…`064` so far); project databases keep their own
  `_npati_migrations` history.
- `PROJECT_DATABASE_UNAVAILABLE` — `postgres-projects` is down or the profile is not enabled;
  NPATI keeps running, Data Studio reports the backend as unavailable.
- `DATABASE_EXISTS` — the project database already exists for that backend + environment; the
  backend is already provisioned (use *Activate* instead of recreating it).
- `SNAPSHOT_REQUIRED` — a destructive rollback needs a snapshot; restore one from the Backups tab.
- `DRIFT_BLOCKED` — the project schema changed outside NPATI; inspect the diff, decide, then
  promote or restore.
- `PROJECT_DATABASE_UNAVAILABLE`, `BACKUP_TOOL_UNAVAILABLE` — `pg_dump`/`pg_restore` are missing in
  the runtime image; the shipped image installs `postgresql-client`.
- `QUOTA_EXCEEDED` — the environment hit its database size limit; raise the limit or delete data.
