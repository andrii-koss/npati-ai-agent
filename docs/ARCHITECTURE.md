# Architecture

NPATI Agent is split into application, domain, and infrastructure boundaries so a
self-hosted installation does not need private NPATI infrastructure secrets.

## FROZEN ARCHITECTURAL DECISION — Shared Local Runtime

```text
NPATI
├── web
├── api
├── worker
├── postgres
├── redis
├── ...
└── shared-project-runtime   ← ONE container
    ├── /projects/site
    ├── /projects/blog
    ├── /projects/crm
    └── /projects/mobile
```

LOCAL/SELF-HOSTED runs all Projects in one shared runtime. Coding Agent, async subagents,
background jobs, Preview and website editing reuse scoped project directories and processes.
Creating Projects must never increase the Docker container count. Shared mode has no per-project
workload or egress proxy containers and no fallback to the isolated provider.

HOSTED/ISOLATED may retain per-project Docker isolation under an explicitly isolated profile.
This decision may change only at the owner's explicit request. See the authoritative
[runtime contract and enforcement](website-builder/SHARED_PROJECT_RUNTIME.md).

## Runtime flow

```text
Browser
  |
  v
apps/web
  |
  v
apps/agent-api
  |-- packages/agent (routing and orchestration)
  |-- packages/business-brain (business-domain logic)
  |-- packages/memory (scoped memory)
  |-- packages/skills (skill registry)
  |-- packages/omniroute-adapter --> vendor/omniroute
  |-- packages/hub-connector --> central NPATI backend / optional Hub
  |-- PostgreSQL (metadata and durable state)
  |-- Redis (leases, queues, cache, limits)
  `-- MinIO (private binary objects)
```

## Boundaries

- The browser talks to Agent API and never receives infrastructure secrets.
- NPATI identity originates from the central NPATI backend. A self-hosted Agent stores
  only its installation credential and local session state, not the user's NPATI password.
- Business, Company, and neutral-chat contexts are resolved explicitly and remain isolated.
- `packages/omniroute-adapter` is the only NPATI package that knows OmniRoute HTTP details.
- `packages/hub-connector` owns central NPATI and Hub transport details.
- PostgreSQL is authoritative for structured application state.
- MinIO stores private binary objects; PostgreSQL stores ownership and metadata.
- Redis data is operational and recoverable, not the sole source of business data.
- High-risk or destructive tools pass through policy and approval checks.

## Capability source of truth

The canonical inventory lives in:

- `packages/shared/src/capability-matrix.ts`
- `packages/shared/src/capability-catalog.ts`
- `packages/shared/src/effective-capabilities.ts`

The API exposes the evaluated inventory at `GET /capabilities/inspect`, and the web UI
renders it at `/settings/capabilities`. See [Capabilities](CAPABILITIES.md).
