# Data Studio self-hosting guide (D1–D7)

This document covers the operational side of the Data Studio module: the separate Postgres for
project data, environments, promote, backups, quotas and external databases. It assumes the
standard `docker compose` installation described in the root `README.md`.

## 0. Dokploy / single-host production checklist

`docker-compose.dokploy.yml` defines **12 services**. Two of them are gated behind compose
profiles, so they only start when the profiles are enabled:

| Service | Profile | Why it matters |
| --- | --- | --- |
| `postgres-projects` | `data-studio` | the Data Studio project databases. Without this profile there is **no 12th container** and Data Studio reports the backend as unavailable |
| `sandbox-runner` | `local-sandbox` | Terminal, Live Preview, browser QA and store-preview runs |

In Dokploy set the following environment variables on the application (Environment tab) and
redeploy:

```dotenv
# 1. Start the profile-gated services (comma separated, no spaces).
COMPOSE_PROFILES=local-sandbox,data-studio

# 2. Project cluster credentials — the SAME value is used by postgres-projects and agent-api.
NPATI_PROJECTS_POSTGRES_ADMIN_USER=npati_projects_admin
NPATI_PROJECTS_POSTGRES_ADMIN_PASSWORD=<openssl rand -hex 32>

# 3. Local sandbox runner on the same host (it is reachable as http://sandbox-runner:7865).
NPATI_SANDBOX_RUNNER_MODE=local
NPATI_SANDBOX_RUNNER_URL=http://sandbox-runner:7865
NPATI_SANDBOX_RUNNER_SECRET=<openssl rand -hex 32>   # must be at least 32 characters
NPATI_PREVIEW_SECRET=<openssl rand -hex 32>          # keeps preview links valid across restarts

# 4. Public HTTPS base URL of the Project API (Data Studio gateway).
#    Point a domain/proxy at the agent-api (port 3001) and set it here: the sandbox then receives
#    PROJECT_API_URL / PROJECT_PUBLISHABLE_KEY, the SDK is vendored, and the sandbox egress
#    allowlist gets this host automatically.
NPATI_PROJECT_API_PUBLIC_URL=https://api.example.com
```

After the redeploy verify:

```bash
docker compose -p <project> ps                  # expect 12 services Up (postgres-projects included)
docker compose -p <project> logs agent-api | grep -i "data studio" || true
curl -fsS https://api.example.com/health        # Project API host reachable from outside

# Inside the app: Company → Data must offer "New DataBackend".
```

If `postgres-projects` is still missing, the profile variable did not reach the deploy: check
`docker compose -p <project> config --services` (it lists the active services) or pass
`--profile data-studio` explicitly in the Dokploy command field.

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
- Deleting a DataBackend is refused while active Projects are attached. Afterwards the backend is
  marked `deleting`, its runtime roles are suspended, and databases, roles, keys and secrets are
  purged after the snapshot retention window (`remove_after`). Use `immediate: true` in the API to
  purge right away (for example in disposable test environments).
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
