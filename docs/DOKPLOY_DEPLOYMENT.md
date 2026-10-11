# Deploy NPATI Agent with Dokploy

Use `docker-compose.dokploy-isolated.yml` for this deployment. It builds one API image containing the frontend from the
repository and keeps PostgreSQL/pgvector, Redis, MinIO, Crawl4AI, OmniRoute, and the worker
on an internal Compose network.

`sandbox-runner` starts by default with the other services; no Compose profile is
required. All ten services start during deployment. Project execution and preview
use this single shared runner, with the existing project runtime volumes preserved.

## 1. Create the Compose service

1. In Dokploy, create a **Docker Compose** service (not Docker Stack).
2. Connect the Git repository and production branch.
3. Set the Compose path to `./docker-compose.dokploy-isolated.yml`.
4. Enable **Isolated Deployments**.
5. Copy the variables from `.env.production.example` into the Dokploy Environment editor
   and replace every placeholder.

Generate each secret separately:

```bash
openssl rand -hex 32
```

Use hexadecimal values for `NPATI_POSTGRES_PASSWORD`, because it is embedded in a database
URL. Do not set `NPATI_JWT_SECRET` on a self-hosted installation: access tokens are verified
through the central NPATI backend. For ordinary self-hosting, keep `NPATI_DEPLOYMENT_TYPE=self_hosted` and do not set
`NPATI_HOSTED_REGISTRATION_TOKEN`. For the official `ai.npati.com` deployment, set
`NPATI_DEPLOYMENT_TYPE=npati_hosted` and set the hosted registration token to the same
server-only value configured in the central NPATI backend.

This Compose explicitly selects `NPATI_PROJECT_RUNTIME_MODE=shared`: sites run inside
one runner for both registration types. `NPATI_DEPLOYMENT_TYPE` controls account
registration and browser sessions; it does not override this execution architecture.
Keep the hosted registration type and token for the official `ai.npati.com` deployment.

Set `OMNIROUTE_MANAGEMENT_PASSWORD` to a unique, strong password before first deployment.
The Compose file supplies it as OmniRoute's `INITIAL_PASSWORD`, and Agent API uses the
same value for provider management. On an existing installation, `INITIAL_PASSWORD` does
not replace a password already stored in OmniRoute's database. Change that password
through OmniRoute's Security settings, and keep the Dokploy variable in sync.

Agent API and company worker use `MINIO_ACCESS_KEY` and `MINIO_SECRET_KEY` when
both are explicitly configured. Otherwise, leave both blank to use
`MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`. A separate API credential pair must
belong to an existing MinIO user or service account with access to the NPATI
buckets; setting the environment variables does not create that account.

If startup reports `diagnosticCode: InvalidAccessKeyId`, the MinIO endpoint did
not recognize the access key sent by API. Check the selected credential pair
and the actual running MinIO instance. Changing API credentials requires
recreating API and company-worker containers; changing MinIO root credentials
requires recreating MinIO as well. Preserve the `minio-data` volume.

When API fails to listen, its `API startup failed` log now includes the MinIO
endpoint, resolved addresses, whether the API key matches the configured root
username, and whether credentials contain leading/trailing whitespace. No key,
password or credential hash is printed. This log is available even while the
API container is restarting. A separate registered MinIO user is expected to
have `accessKeyMatchesRootUser: false`; this field alone does not reject it.

The combined image serves React assets and API routes on container port 3001.
MinIO initialization is required before that server listens, so a rejected
storage credential prevents both frontend and API from starting. Domain port
13001 is not the container port and cannot fix a storage authentication failure.

API and worker now address MinIO through the project-specific network alias
`${COMPOSE_PROJECT_NAME}-minio-internal`, attached to the existing `npati-agent`
network. This avoids resolving a different service named `minio` if a shared
proxy network contains other deployments. Compose derives the project name
from Dokploy's `-p` argument; do not override it with another deployment's name.
Enable Dokploy's Isolated Deployments as described above. The alias prevents a
generic-name collision but does not correct an unregistered API credential.
No container or data volume name is changed by this alias update.

To test credentials from the **actual containers** without displaying their values,
run this command on the Docker host from the repository directory:

```bash
node scripts/diagnose-minio-docker.mjs <agent-api-container> <minio-container>
```

The probe uses `mc` inside the existing MinIO container and makes read-only
authenticated requests. It creates no additional container and works even if
API keeps restarting. `root.accepted: true` and `api.code: InvalidAccessKeyId`
prove that the API key is not recognized by that selected MinIO instance.
An API user may legitimately differ from root; matching values are not required
when both probes succeed. If the probes succeed but API startup fails, check
`MINIO_ENDPOINT`, port, TLS, DNS routing, and bucket permissions. The probe
intentionally tests the selected instance directly, rather than trusting DNS.

If pulling the default image from Quay fails, `MINIO_IMAGE` can select a
digest-pinned image from your own registry or a verified mirror. This changes
the image source only; keep the existing `minio-data` volume and credentials.

## 2. Configure the domain

In the Compose service's **Domains** tab, add the public HTTPS domain with:

- Service: `agent-api`
- Container port: `3001`
- HTTPS/certificate: enabled

Do not expose or attach public domains to PostgreSQL, Redis, MinIO, Qdrant,
Crawl4AI, or OmniRoute. The API container serves the frontend and handles browser API traffic at `/api/`.

For an existing installation, update the Dokploy domain from `web:3000` to
`agent-api:3001` before redeploying. The Compose deployment removes the obsolete
web container with `--remove-orphans`; keep the same Compose project and persistent volumes.

Set both of these variables to the same externally reachable HTTPS origin, without a
trailing slash:

```env
NPATI_WEB_ORIGIN=https://agent.example.com
NPATI_AGENT_PUBLIC_DOMAIN=https://agent.example.com
```

`NPATI_BACKEND_URL` must point to the reachable central NPATI backend origin, for example
`https://www.npati.com`. It must not point to `localhost` from inside the deployment.

After changing a domain in Dokploy, redeploy the Compose service so its Traefik routing is
regenerated.

## 3. First deployment

Use Dokploy's Compose preview before deploying. The deployment is ready when these services
are healthy:

- `agent-api`
- `company-worker`
- `crawler`
- `omniroute`
- `browser-use-worker`
- `postgres-projects`
- `minio`
- `redis`
- `postgres`

The Agent's PostgreSQL schema migrations are idempotent and run automatically when Agent API
initializes its workspace store. No separate migration command is required for a new Agent
deployment.

### Website Builder shared runtime on this VPS

In the Dokploy Compose Environment editor set
`NPATI_SANDBOX_RUNNER_MODE=local`, `NPATI_SANDBOX_RUNNER_URL=http://sandbox-runner:7865`,
a unique `NPATI_SANDBOX_RUNNER_SECRET` of at least 32 characters, and a stable
`NPATI_PREVIEW_SECRET`. The API, company worker, and runner receive the same
runner secret from Compose. Do not attach a public domain to `sandbox-runner`.

The default self-hosted Compose now builds one `npati-project-runtime` container.
All managed projects use separate workspaces, UIDs, processes and assigned ports
inside it. There is no Docker socket or per-project Docker sandbox/proxy pair.
The allowlisted network proxy runs inside the runtime.

The runner uses Bubblewrap user/mount/PID/IPC/network namespaces and slirp4netns,
not Landlock ABI 6. Linux 5.15 has these kernel mechanisms; they must be enabled
and permitted by the host security policy. Docker Desktop uses its Linux VM;
native Windows containers are not supported. The runner maps `/dev/net/tun` for
unprivileged network setup; the host must provide the standard Linux TUN device.
Startup checks an actual
unprivileged namespace launch and fails closed if unavailable. Configure total runtime resources with
`NPATI_PROJECT_RUNTIME_CPU` (default 4) and `NPATI_PROJECT_RUNTIME_MEMORY`
(default `4g`); these resources are shared between projects.

The selected Compose service uses the committed namespace-enabled Docker seccomp
profile and `apparmor=unconfined` only for sandbox-runner. It retains
`no-new-privileges`, the limited existing capabilities, and no Docker socket;
neither privileged mode nor SYS_ADMIN is enabled. The profile is derived from
https://github.com/moby/profiles/blob/main/seccomp/default.json, with namespace
setup syscalls allowed. Project commands drop supervisor privileges, disable
further user namespaces and see only their writable project and read-only tools.
UID 0 inside the private user namespace maps to the project's unprivileged UID
outside it. A second seccomp filter denies namespace creation/joining, mount,
ptrace and BPF operations for project code; ordinary processes/threads remain supported.
Keep the seccomp file in the repository; its path is relative to the Compose file.
The runner also requires `systempaths=unconfined`: Docker's default masked `/proc`
paths can prevent Bubblewrap from mounting a private procfs on Linux 5.15
(`bwrap: Can't mount proc on /proc: Operation not permitted`). This setting applies
only to the runner. Project commands receive a separate read-only `/proc`, retain
private PID/user/network namespaces and cannot mount or join other namespaces.
See the [Moby explanation](https://github.com/moby/buildkit/blob/master/docs/rootless.md).
Host configurations blocking user namespaces require administrator configuration;
support on every kernel/security policy cannot be guaranteed. If startup reports
`Project namespaces unavailable`, inspect this error and the host namespace policy.
Updating to Linux 6.12 is not required by this implementation.

The NPATI coding agent stays in the API. Its approved shell tools call the
authenticated runner to edit/test project files, synchronize changes back to
canonical storage and run previews. `/settings/code` configures that existing
agent. External CLI agents are not installed in this stage; future installations
must be project-local and persistent.

Verify the runner RPC, file edits, npm installation, two previews and cross-project
isolation by running `scripts/verify-shared-project-runtime.mjs` with Node inside
agent-api. The script reads its runner URL/secret without printing the secret and
removes its temporary projects afterward; it does not create Docker containers.

The deployed `docker-compose.dokploy-isolated.yml` keeps its existing filename
for Dokploy compatibility, but runs the shared project runtime. It defines exactly
10 services: agent-api, company-worker, sandbox-runner, postgres,
postgres-projects, redis, minio, omniroute, crawler and browser-use-worker.
Frontend assets are served by agent-api.

### PostgreSQL vector search without Qdrant

This Compose no longer starts Qdrant or supplies `QDRANT_URL` to API/worker.
Company Knowledge already writes document chunks and embeddings into PostgreSQL
and performs scoped vector and full-text retrieval there. SQLite FTS5 remains
an in-process supplementary text index; it adds no container. Existing Qdrant
support in the code is retained for other deployment configurations.

On redeployment, `--remove-orphans` removes the old Qdrant container without
deleting its named data volume. Preserve and back up the existing
`<compose-project>_qdrant-data` volume until production data has been checked.
Do not assume every Qdrant point exists in PostgreSQL: supplementary indexing
previously ran before the PostgreSQL completion transaction. Documents left
failed/processing must be inspected and, where appropriate, retried from the
existing MinIO source files through Knowledge processing. Qdrant-only records
without source files require a separate verified migration before discarding
the old volume. No automatic import or volume deletion is performed.

PostgreSQL's current knowledge schema has scope/full-text indexes but no vector
HNSW/IVFFlat index. Large datasets require a measured index plan matching the
actual embedding dimensions/model; removing Qdrant does not certify search latency.

All project sites run inside sandbox-runner, with separate directories, UIDs,
processes and assigned ports. Its internal allowlisted proxy runs in the same
container. There are no image preparation services or per-project Docker
containers. The runner has no Docker CLI or mounted Docker socket. The two
project runtime volumes preserve project files and supervisor state.

Use Dokploy's normal Compose deployment command with `up -d --build`.
Set `NPATI_SANDBOX_RUNNER_SECRET` to at least 32 characters and keep the same
value on API, worker and runner. Registry image overrides and signature identity
variables are unused in this deployment. Host namespace and firewall requirements
listed above still apply; do not disable isolation to work around an older host.

### Validate the isolated deployment locally

Use the same `docker-compose.dokploy-isolated.yml` as Dokploy. The preparation
script creates only test environment values in an ignored artifact directory;
it does not generate another Compose file or alter the service configuration.

```bash
node scripts/prepare-docker-validation.mjs
docker compose --env-file artifacts/docker-validation-source/.env.validation -f docker-compose.dokploy-isolated.yml config --quiet
docker compose --env-file artifacts/docker-validation-source/.env.validation -f docker-compose.dokploy-isolated.yml up -d --build
```

Test credentials and volumes belong to the separate
`npati-isolated-source-20261011` project. Supply `MINIO_IMAGE` to the preparation
script only if testing an explicitly selected mirror. The shared runner is
built by this same YAML; projects do not create Docker containers.
The Dokploy file exposes API port 3001 to Docker networks and publishes it only
on host loopback (`127.0.0.1`). `NPATI_AGENT_PUBLISHED_PORT` selects the host port
(default 3001; the validation environment uses 13001). Dokploy routes the public
domain to agent-api's container port 3001.

This proves deployment behaviour with the recorded test environment, not with
unavailable production credentials. Separate `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`
values must belong to an existing MinIO account; setting environment variables
does not create that account.

Read [shared runtime deployment and migration](website-builder/SHARED_PROJECT_RUNTIME.md)
before switching an existing installation. The runtime's `projects` and state
volumes are persistent; old per-project containers are not automatically deleted.

### Redis host setting

Redis requires `vm.overcommit_memory=1` on the **Linux host** for reliable background
saves. On the Dokploy server itself (via SSH or its server terminal, not a container
terminal), run:

```bash
sudo sysctl -w vm.overcommit_memory=1
printf 'vm.overcommit_memory = 1\n' | sudo tee /etc/sysctl.d/99-npati-redis.conf
sysctl vm.overcommit_memory
```

The final command should print `vm.overcommit_memory = 1`. The sysctl file preserves
the setting after a reboot. This setting belongs to the host kernel and cannot be
fixed by reinstalling Redis or adding `sysctls` to the Compose service.

### OmniRoute startup messages

The bundled OmniRoute image may report that Antigravity or Qoder OAuth client secrets
are absent. These are optional integrations; they do not affect other connected
providers.

If OmniRoute 3.8.50 reports `no such table: compression_run_telemetry` during its
cleanup cycle, the optional telemetry table has not yet been created. This does not
stop model requests. After backing up the `omniroute-data` volume, run the following
once in the **OmniRoute container terminal** to create the table with OmniRoute's
own schema:

```bash
node <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('/app/data/storage.sqlite');
db.exec(`CREATE TABLE IF NOT EXISTS compression_run_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  request_id TEXT, model TEXT, provider TEXT, source TEXT,
  tokens_before INTEGER NOT NULL, tokens_after INTEGER NOT NULL,
  ratio REAL, cost_delta REAL, output_styles TEXT,
  output_style_bypass TEXT, output_tokens INTEGER
)`);
console.log('Compression telemetry table is ready');
db.close();
NODE
```

Previous error lines remain in Dokploy's `All time` view; the next cleanup cycle
should no longer report this missing table.

Verify externally:

```bash
curl -fsS https://agent.example.com/
curl -fsS https://agent.example.com/api/health
```

Then open `/settings/capabilities` and complete **Connect NPATI Account** using the central
NPATI authorization flow.

## Persistence and backups

The production Compose file uses named volumes for:

- PostgreSQL
- Redis
- MinIO
- OmniRoute
- crawler state
- Agent local state and installation identity

Configure Dokploy backups for at least `postgres-data`, `minio-data`, and `agent-data`.
Preserve the former `qdrant-data` volume separately during migration. The `agent-data` volume contains the persistent installation ID and
installation authorization state; losing it makes the deployment appear as a new Agent
installation.

Before an upgrade, back up all named volumes. Never deploy with `docker compose down -v` or
select an option that deletes volumes.

## Production checklist

- DNS points to the Dokploy server.
- HTTPS is active before account pairing.
- All placeholder secrets were replaced with independent random values.
- `NPATI_AUTH_STRICT=true` and legacy password authentication remains disabled.
- The central NPATI backend is reachable from the Agent containers.
- No database or internal-service port is published publicly.
- Named-volume backups are configured and a restore procedure has been tested.
- Provider credentials are added through the Agent/OmniRoute connection flow, not committed
  to Git.
