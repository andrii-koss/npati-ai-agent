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
`https://api.npati.com`. It must not point to `localhost` from inside the deployment.

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
