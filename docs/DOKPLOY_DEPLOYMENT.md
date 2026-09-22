# Deploy NPATI Agent with Dokploy

Use the dedicated `docker-compose.dokploy.yml`. It builds the web/API images from the
repository and keeps PostgreSQL, Redis, MinIO, Qdrant, Crawl4AI, OmniRoute, and the worker
on an internal Compose network.

## 1. Create the Compose service

1. In Dokploy, create a **Docker Compose** service (not Docker Stack).
2. Connect the Git repository and production branch.
3. Set the Compose path to `./docker-compose.dokploy.yml`.
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

Set `OMNIROUTE_MANAGEMENT_PASSWORD` to a unique, strong password before first deployment.
The Compose file supplies it as OmniRoute's `INITIAL_PASSWORD`, and Agent API uses the
same value for provider management. On an existing installation, `INITIAL_PASSWORD` does
not replace a password already stored in OmniRoute's database. Change that password
through OmniRoute's Security settings, and keep the Dokploy variable in sync.

## 2. Configure the domain

In the Compose service's **Domains** tab, add the public HTTPS domain with:

- Service: `web`
- Container port: `3000`
- HTTPS/certificate: enabled

Do not expose or attach public domains to `agent-api`, PostgreSQL, Redis, MinIO, Qdrant,
Crawl4AI, or OmniRoute. Browser API traffic goes through the web container at `/api/`.

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

- `web`
- `agent-api`
- `company-worker`
- `crawler`
- `omniroute`
- `qdrant`
- `minio`
- `redis`
- `postgres`

The Agent's PostgreSQL schema migrations are idempotent and run automatically when Agent API
initializes its workspace store. No separate migration command is required for a new Agent
deployment.

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
- Qdrant
- OmniRoute
- crawler state
- Agent local state and installation identity

Configure Dokploy backups for at least `postgres-data`, `minio-data`, `agent-data`, and
`qdrant-data`. The `agent-data` volume contains the persistent installation ID and
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
