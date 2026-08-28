# NPATI Agent

**Open Source AI Business Agent**

NPATI Agent is an early local foundation for a business-focused AI assistant.
Milestone one provides an independent NPATI web interface, a central Agent API,
clear domain boundaries, and an isolated OmniRoute AI engine. It does not yet
claim marketplace publishing, autonomous planning, payments, or production readiness.

## Architecture

```text
NPATI Web
    ↓
NPATI Agent API
    ↓
NPATI Agent orchestration
    ├── Business Brain
    ├── Business Memory
    ├── Skills
    ├── OmniRoute Adapter → OmniRoute
    └── Hub Connector → NPATI Hub (optional, not configured)
```

NPATI code never imports OmniRoute internals. The adapter is the single boundary
that knows its verified HTTP endpoints. OmniRoute remains an unmodified Git submodule.

## Local Development

Requirements: Docker Desktop with Compose v2. For host-only checks, use a Node.js
version accepted by OmniRoute (`22.22.2` or a supported Node 24 release).

```bash
git submodule update --init --recursive
copy .env.example .env
docker compose up --build
```

On macOS/Linux, use `cp .env.example .env`. Empty API keys are valid for the
foundation health check; NPATI Hub is optional and reports `not_configured`.

## Docker

The stack uses the single internal network `npati-agent-network` and starts:

- `npati-agent-web`
- `npati-agent-api`
- `npati-agent-omniroute`
- `npati-agent-redis` (required by the verified OmniRoute base setup)

Open NPATI Web at <http://localhost:3000>. Check the Agent API at
<http://localhost:3001/health>. OmniRoute is intentionally not published to the
host; the Agent API reaches it on the internal network.

Open the AI Provider Marketplace at <http://localhost:3000/settings/ai>.
Its audited architecture, actual OmniRoute endpoints, security model, and known
limitations are documented in
[`docs/AI_PROVIDER_MARKETPLACE.md`](docs/AI_PROVIDER_MARKETPLACE.md).

## OmniRoute

The pinned upstream version is recorded in `OMNIROUTE_VERSION`, the versioned
Docker image, and the Git submodule reference at `vendor/omniroute`. The current
pin is `v3.8.49`.
See `docs/OMNIROUTE_UPDATES.md` before changing it.

## Project Structure

```text
apps/web                 NPATI React frontend
apps/agent-api           central Fastify API
packages/agent           orchestration
packages/business-brain  business domain foundation
packages/memory          business memory abstraction
packages/skills          skill registry and demonstration skill
packages/branding        centralized brand configuration and theme
packages/omniroute-adapter AI engine boundary
packages/hub-connector   NPATI Hub boundary
packages/shared          shared contracts
vendor/omniroute         pinned upstream submodule
```

## Verification

```bash
npm install
npm run typecheck
npm test
npm run build
docker compose config --quiet
```
