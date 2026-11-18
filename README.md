# NPATI Agent

NPATI Agent is a source-available (fair-code), self-hostable AI workspace for chat, business planning,
company agents, knowledge, memory, web research, and AI-provider routing.

The project is under active development. Capability status is reported honestly as
verified, partial, or not implemented; see [Capabilities](docs/CAPABILITIES.md).

## What works today

- Central NPATI account connection and installation authorization.
- Neutral chat plus isolated Business and Company contexts.
- AI-provider discovery and routing through the pinned OmniRoute adapter.
- Business profiles, goals, conversations, and explicit Business-to-Company transition.
- Company agents, hierarchy, per-agent models/instructions/tools, and delegated runs.
- Persistent conversations, scoped memory, company knowledge, and private object storage.
- Web search, URL fetch, bounded website research, citations, and background research jobs.
- Text-to-speech, speech-to-text, audio understanding, file upload, and document processing.
- Capability policies, approval gates, audit events, rate limits, and tenant isolation.
- Live capability inspection at `/settings/capabilities`.

Some UI surfaces and integrations are partial, and some catalogued capabilities are
reserved but not implemented. The capability document and inspector make that distinction
explicit. What the live V6 audit proved, and what stays blocked or untested (for example
Android APK builds, messenger delivery, isolation between two user accounts), is listed in
[Release readiness](docs/RELEASE_READINESS.md#v6-tested-scope-2026-11-17-product-commit-29ed8cb8).

## Requirements

- Docker with Compose v2
- Git with submodule support
- For host-side commands: Node.js `>=22.22.2 <23` or `>=24 <27`

## Start locally

```bash
git clone --recurse-submodules <repository-url>
cd npati-agent
cp .env.example .env
docker compose up --build
```

On Windows Command Prompt, use `copy .env.example .env`.

Open:

- Web: <http://localhost:3000>
- Agent API health: <http://localhost:3001/health>
- Capability Inspector: <http://localhost:3000/settings/capabilities>

Empty optional provider keys are acceptable for initial startup. Features that require an
external provider remain unavailable until that provider is connected.

Docker deployments serve the React frontend and `/api/*` from the same `agent-api`
container. The local UI remains at `http://localhost:3000`; Dokploy domains target
`agent-api` on container port `3001`.

## Architecture

```text
React Web
   |
Fastify Agent API
   |-- Agent orchestration and policy
   |-- Business and Company workspace
   |-- Memory, knowledge, files, jobs
   |-- OmniRoute adapter --> pinned OmniRoute submodule
   `-- NPATI backend / Hub connectors
```

See [Architecture](docs/ARCHITECTURE.md) for ownership boundaries.

## Repository layout

```text
apps/web                    React user interface
apps/agent-api              Fastify API and application composition
packages/agent              agent orchestration
packages/business-brain     business-domain logic
packages/memory             memory abstractions and engines
packages/skills             skill registry
packages/shared             contracts, capability catalog, policies
packages/omniroute-adapter  isolated OmniRoute boundary
packages/hub-connector      NPATI backend and Hub boundary
services/crawler            bounded Crawl4AI service
tests                       automated regression and security tests
vendor/omniroute            pinned upstream submodule
```

## Development checks

```bash
npm install
npm run typecheck
npm test
npm run build
npm run audit:capabilities
docker compose config --quiet
```

Generated test evidence belongs in `artifacts/`, which is gitignored.

## Documentation

- [Release readiness](docs/RELEASE_READINESS.md)
- [Capabilities](docs/CAPABILITIES.md)
- [Installation and platform support](docs/INSTALLATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Dokploy production deployment](docs/DOKPLOY_DEPLOYMENT.md)
- [AI Provider Marketplace](docs/AI_PROVIDER_MARKETPLACE.md)
- [Web Research](docs/WEB_RESEARCH.md)
- [Object Storage](docs/OBJECT_STORAGE.md)
- [Updating OmniRoute](docs/OMNIROUTE_UPDATES.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

NPATI Agent is source-available under the [Elastic License 2.0](LICENSE) (ELv2), licensor Andrii Kostashchuk
(https://en.npati.com/). You may use, change and self-host it, including inside your company. You may not offer
it to others as a hosted or managed service, disable or work around its license key (installation authorization),
or remove its licensing notices. Third-party components keep their own licenses.

## Security

Never commit `.env`, credentials, provider tokens, signing keys, database passwords, or
NPATI internal service keys. The self-hosted Agent must be treated as a public client.
