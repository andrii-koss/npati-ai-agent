# Installation and platform support

The supported first-release installation method is Docker Compose. This keeps PostgreSQL,
Redis, MinIO, Qdrant, OmniRoute, the crawler, browser worker, API, and web application on
the same tested service versions on every host.

## Supported hosts

| Host | Supported path | Release verification |
| --- | --- | --- |
| Ubuntu 22.04/24.04 and compatible Linux | Docker Engine + Compose v2 | Compose validation and image builds in CI |
| Windows 10/11 | Docker Desktop with Linux containers | Node build/test CI on Windows; same Linux images |
| macOS 13+ | Docker Desktop or compatible Compose runtime | Node build/test CI on macOS; same Linux images |

Native host execution is intended for development. It requires Node.js 22.22.2 or a
supported Node 24 release plus separately managed PostgreSQL, Redis, MinIO, Qdrant,
OmniRoute, Crawl4AI, and the browser worker.

## Docker installation

~~~bash
git clone --recurse-submodules <repository-url>
cd npati-agent
cp .env.example .env
docker compose config --quiet
docker compose up --build
~~~

On Windows PowerShell:

~~~powershell
git clone --recurse-submodules <repository-url>
Set-Location npati-agent
Copy-Item .env.example .env
docker compose config --quiet
docker compose up --build
~~~

Before exposing an installation publicly, replace every development password, encryption
key, API token, and signing secret in .env. Keep NPATI_AUTH_STRICT=true.

Verify the running services:

~~~bash
docker compose ps
curl --fail http://localhost:3001/health
curl --fail http://localhost:3000/
~~~

Open http://localhost:3000 after both checks succeed.

## Development installation

~~~bash
git clone --recurse-submodules <repository-url>
cd npati-agent
npm ci
npm run typecheck
npm test
npm run build
~~~

The lockfile is authoritative. Do not replace npm ci with an unpinned global install in
CI or release verification.

## Platform release gate

The GitHub Actions workflow runs the locked dependency install, typecheck, complete test
suite, capability audit, and production build on Ubuntu, Windows, and macOS. A separate
Ubuntu job validates Compose and builds both application images.

A platform is release-supported only after its matrix job passes for the release commit.
Docker runtime smoke tests that require external provider credentials remain deployment
checks and are not implied by an image build.


## Troubleshooting an unhealthy API container

If Compose reports `dependency agent-api failed to start`, inspect the API process
rather than the dependent web or worker container:

```bash
docker compose ps agent-api
docker compose logs --tail=200 agent-api
docker inspect --format '{{json .State.Health}}' "$(docker compose ps -q agent-api)"
```

`/health/live` is the container liveness endpoint. The aggregate `/health` endpoint
also probes configured external services and is intended for diagnostics, not for
Docker lifecycle decisions. It includes a real Redis `PING` and a reachability probe
for `NPATI_BACKEND_URL`. The Connections page refreshes this aggregate status every
30 seconds, accepts cached results for at most 60 seconds, and marks services
unavailable when the health request itself fails.

For `NPATI_ENV=production`, configure unique values of at least 32 characters for
`NPATI_ENCRYPTION_KEY` and `NPATI_REMOTE_ACCESS_TOKEN_SECRET`; development defaults
are intentionally rejected. If the log mentions a missing native SQLite binding,
rebuild the API image without cache so the workspace-native dependency layer is
included: `docker compose build --no-cache agent-api`.
