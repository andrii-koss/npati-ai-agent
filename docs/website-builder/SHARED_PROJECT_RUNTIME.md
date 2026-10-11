# Shared project runtime for OSS / self-hosting

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

LOCAL/SELF-HOSTED uses one shared runtime for all Projects. Projects, Coding Agent sessions,
async subagents, background jobs and Preview create scoped directories and processes, never
per-project workload or proxy containers. Deleting a Project must never destroy the shared runtime.
An explicitly isolated profile retains per-project Docker isolation. Hosted account registration
can also use explicitly selected shared execution. The selected Dokploy deployment now uses
ten services after removal of Qdrant, including the shared sandbox-runner, all started by default.
Future implementation must not change this decision unless the owner explicitly requests an architecture change.

`NPATI_PROJECT_RUNTIME_MODE=shared|isolated` selects the execution architecture;
`NPATI_SANDBOX_RUNNER_MODE=local|remote` selects transport locality. These are separate settings.
The default local update script uses `docker-compose.sandbox-runner.yml`. API shared execution
checks authenticated runner readiness for `details.runtimeMode=shared`; the Docker provider
refuses shared mode before any Docker work. An unavailable shared runtime fails closed.

The default local `docker-compose.sandbox-runner.yml` and self-hosted `docker-compose.dokploy.yml` now run one `npati-project-runtime` container. Its Compose service/DNS alias remains `sandbox-runner`, preserving the authenticated runner URL and existing `RemoteSandboxProvider` contract. There is no Docker socket, Docker CLI, per-project sandbox container, per-project proxy container, or readiness Docker container in this execution path.

## Existing paths retained

The implementation first inspected `LocalProjectWorkspace` / `MountedWorkspaceProvider`, `SandboxProvider`, `ProjectSandboxService`, `ProjectPreviewService`, terminal command policy, and the Company/Coding Agent tool path. The new provider implements the existing sandbox contract rather than adding a second set of tools or bypassing API authorization.

Canonical source files stay in the existing workspace provider. The runtime synchronizes a working copy to `/projects/<projectId>` and retains its dependencies/build cache on a named volume. Command output is synchronized back through the existing expected-revision checks. Files, terminal commands, approvals, secret references, RBAC, terminal events, and Activity continue through the existing API services. Selecting a different `projectId` requires the same existing access checks.

Each logical sandbox stores its exact workspace/user/company/project scope, unique Linux UID, port, and process records. A mismatched scope or a process ID owned by another project is refused. Metadata and bounded process logs live in `/runtime-state`, inaccessible to project processes. Supervisor credentials are never inherited by child environments.

## Execution and isolation

- Project children drop to their own UID; project directories have mode 0700.
- A native launcher validates identity and drops supervisor privileges. Bubblewrap creates user, mount, PID, IPC, UTS and network namespaces for every command, sync operation and dev server. The selected project is writable, tools are read-only, /proc belongs to the command namespace, and further user namespaces are disabled.
- An unprivileged slirp4netns helper provides networking outside the command namespace. Its private API socket is outside project mounts. UID firewall rules allow only the proxy and that project's preview port. Preview forwarding binds runner loopback and reaches an in-namespace relay supporting localhost-bound servers.
- UID-based IPv4/IPv6 firewall rules block direct external connections and DNS, including attempts to reach an external server on the proxy's port. The existing allowlisted egress proxy runs as a process inside the runtime, not as another container.
- No project child gets root capabilities, Docker access, or privilege escalation. The trusted supervisor retains only the capabilities required to assign UIDs, manage project processes/files, and install its firewall.
- Foreground commands retain the existing timeouts. Preview processes are long-lived; stopping a logical sandbox stops only that project's UID/processes.

**Host requirement: Linux with enabled unprivileged user/mount/PID/IPC/network namespaces, and permission to apply container-local iptables/ip6tables rules.** Linux 5.15 supplies these mechanisms. Landlock is not required. Startup fails closed if namespace setup is unavailable. The selected production Compose includes namespace-enabled seccomp and AppArmor settings for this service without SYS_ADMIN or privileged mode. Host policies disabling user namespaces still need administrator configuration.

Each command has a private network. A server reaches its own loopback directly;
other commands can reach the project's running preview through gateway 10.0.2.2
at the assigned project port. The NPATI coding orchestrator remains in the API
and calls the existing shell/sync/preview contract. External CLI agents are a later stage.

Container-wide limits are configured by `NPATI_PROJECT_RUNTIME_MEMORY` (default `4g`), `NPATI_PROJECT_RUNTIME_CPU` (default `4`), and the Compose PID ceiling. Child UID process/file-descriptor limits also apply. This mode does not offer the isolated Docker provider's independent per-project CPU/RAM/disk quotas; projects share the runtime's total resources.

## Preview ports

Ports are assigned centrally and persisted; current allocation starts at 3001, skips supervisor/proxy ports, and never assigns a port already allocated to another logical sandbox. Framework default ports are requests, not fixed host ports. The Preview service uses the port returned by `exposePort`; generated Next/Vite/Expo/static commands are rewritten to that port. Custom Node servers should listen on `process.env.PORT`.

The mapping is `projectId → logical sandbox → assigned port`. Proxy requests must match that project's port. Browser traffic still follows web → API → runtime → project process. Ports are not individually published on the host.

Expo keeps the existing Expo Web export/static-preview workflow. Native device/store builds are not introduced by this change.

## Deployment and migration

### Prepared web dependencies

The runtime image contains Node/npm/pnpm/yarn, Python/Git and six prepared dependency profiles: Next.js, Vite/React, Vite/Vue, Nuxt, Astro and Expo Web. Profiles are installed when the image is built, in a separate cached Docker stage, and stored read-only under `/opt/npati-project-toolchain`. Versions/ranges are declared in `apps/agent-api/project-runtime-profiles.json`; its Next/Vite/Expo profiles match the existing generated manifests.

For Nuxt 4 development in this single-port runtime, set `experimental: { viteEnvironmentApi: true }` in `nuxt.config.ts`. The framework diagnostic uses this setting. The default separate SSR/HMR server requests another random port and is intentionally blocked by project isolation; a production `nuxt build` output can also be served with `node .output/server/index.mjs` on the assigned `PORT`. Installing the prepared dependencies does not rewrite an existing project's Nuxt configuration.

For a root `npm install` or `npm ci`, the existing provider invokes `prepare-project-dependencies.cjs` through the same project UID/namespace boundary. Exact dependency sets and compatible lock graphs can use project-owned copies of prepared modules. No writable symlinks or shared project directories are introduced. A different explicit lockfile, dependency version, workspaces/overrides, or root install lifecycle keeps the normal npm execution path. `npm ci` without a lockfile still fails normally. Commands with other managers, arguments or subdirectory cwd also retain their normal execution.

Builds still run against the project's actual source. Generated Nuxt/Astro/cache artifacts are excluded from canonical source synchronization. The final project model response is limited by instruction to verified results within 120 words; it cannot write files or execute additional tools.

Preview startup now probes the project's HTTP endpoint before publishing a ready session. It waits for server startup and the first compilation, retries temporary connection/5xx failures for up to 90 seconds, and stops a failed process instead of returning a premature ready card. A non-5xx response also permits API projects whose root is intentionally 404 or authentication-protected.

The image is larger and its first build downloads all six sets. New project requests reuse that image; they never build Docker images. This does not guarantee a fixed end-to-end latency or that every possible npm dependency combination hits a prepared profile.

Local launch uses the same Compose command as before, with the default sandbox override. Build/recreate `agent-api`, `company-worker`, and `sandbox-runner`; persistent canonical project data is retained. Existing projects whose old sandbox ID cannot be found in the shared runtime receive a new logical sandbox on their next execution, with files synchronized from the canonical workspace.

Existing legacy `npati-sb-*`, `npati-proxy-*`, and `npati-readiness-egress` containers are not automatically deleted. They are not used for newly created shared workspaces. Clean them up deliberately after confirming no isolated runner uses them. Do not remove application/data volumes.

The previous Docker provider and server are retained for remote/isolated deployments in `docker-compose.sandbox-isolated.yml`. The selected Dokploy file `docker-compose.dokploy-isolated.yml` now uses shared execution. Choose one runtime scheme for a deployment. Shared mode refuses arbitrary host-folder mounts. Using mounted folders requires an explicitly isolated deployment; a project never switches providers automatically.

Without an explicit runtime mode, `NPATI_DEPLOYMENT_TYPE=npati_hosted` defaults to isolated execution.
An explicit `NPATI_PROJECT_RUNTIME_MODE=shared` takes precedence, including for hosted accounts;
`docker-compose.dokploy-isolated.yml` selects shared execution despite its legacy filename;
vector retrieval uses the existing PostgreSQL/pgvector service instead of a Qdrant container.

After a runtime restart, recorded process IDs are marked stopped and persisted PIDs are never signaled (preventing PID-reuse bugs). Start Preview again. API Preview session tracking is still in memory, so an API restart also requires starting Preview again.

## Verification

### Coding Agent access to project databases

Coding Agent manifest v13 exposes six database tools through API-side Data Studio; project code and the model receive no database administrator credentials or Docker socket.

- `code.data.schema.inspect`: schema, attached backend ID and fingerprint.
- `code.data.schema.apply`: create a table, field or index (existing non-destructive behavior).
- `code.data.schema.modify`: rename a table, alter a field type, drop a field or table. Actual execution requires an explicit approval bound to the backend, fingerprint and exact operation. Destructive operations take a snapshot through the migration engine; incompatible casts and dependent objects fail rather than silently cascading. Access-policy metadata follows table renames/removal.
- `code.data.rows.list`: inspect up to 100 dev rows per page to select IDs.
- `code.data.rows.transfer`: copy/move 1?1000 explicit row IDs between tables in the same attached dev database with an explicit field mapping. IDs and ownership fields are preserved. Execution requires approval; moves take a snapshot. Insert/delete and the transfer journal commit in one transaction. A duplicate ID or failed constraint rolls back the entire transfer; there is no skip/overwrite mode. Preview validates the schema, fields and source IDs but does not execute an insertion, so target constraints are checked during execution. Larger transfers require additional batches and confirmations.
- `code.data.backend.attach`: attach the current database to another website/code project of the same owner, workspace and company. Preview without a target lists eligible projects with names/IDs; preview of a selected target returns its current attachment; confirmation binds that attachment so a concurrent change is refused. Requires workspace write and business management permission. Sharing changes the target's dev/prod backend reference, not the database contents, and leaves any previous backend intact. Each application still uses its Project API URL, publishable key, configured origins and access policies.

Attach the first DataBackend in Data Studio and start a new Coding Agent chat after deployment; older sessions keep their frozen manifests, including v12. Schema/row writes target dev only. Production promotion remains the existing Data Studio workflow. Plan/review sessions cannot perform these writes. Raw SQL and model-supplied approval flags are not accepted. The human approval is consumed by CodeToolRuntime and cannot be reused with changed arguments. Database changes are journaled separately from file/Git undo.

`scripts/verify-coding-agent-data.ts` exercises the real CodeToolRuntime, durable PostgreSQL approvals and project databases using temporary fixtures. It checks table/field/index creation, rename, type change, field/table deletion, snapshots, copy/move, conflict rollback, sharing across three projects, stale attachment/schema refusal, foreign-project denial, unchanged production and restricted runtime roles, then removes the temporary projects/databases. It does not call a paid model.

Runner access is measured with `scripts/benchmark-shared-project-runtime.mjs`, piped into Node inside `agent-api`. It creates and removes one temporary project, signs every request, and checks authenticated readiness before every operation as the API provider does. It measures runner RPCs and small file edits, excluding model generation, application database work, dependency installation and framework builds.

Readiness checks run concurrently. Only a successful isolation proof is cached inside the runner for at most two seconds; proxy and IPv4/IPv6 firewall checks remain live. Concurrent callers share the current check. Every operation still receives a fresh authenticated readiness response and validates the backend mode and project scope. Failed checks or operations invalidate the proof, including probes already in flight; restarting the runner starts with an empty cache. Each command still establishes its own isolation boundary.

The namespace/network probe executes `/bin/true` directly after setup. File upload/download retains the project UID, private filesystem/PID/network namespaces and command seccomp filter, but skips the network helper and preview relay because file synchronization needs no network. Commands, dependency installs and previews retain their network setup; only Preview launches the Node relay. Upload compares actual file contents without following final symlinks and preserves unchanged files, avoiding unnecessary watcher rebuilds. Upload still sends the full file snapshot and processes deletions. API canonical file reads run in batches of at most eight, preserving revision checks and sync quotas.

On 2026-10-11, the local Docker Desktop stack built from `docker-compose.dokploy-isolated.yml` measured the following medians over 10 samples per case:

| Operation | Original | First optimization | With short isolation cache |
| --- | ---: | ---: | ---: |
| Authenticated readiness | 269 ms | 120 ms | 11 ms (warm proof) |
| Project status including readiness | 297 ms | 93 ms | 14 ms |
| Small Node file edit including readiness | 477 ms | 323 ms | 223 ms |
| Upload, edit, download, each including readiness | 1399 ms | 950 ms | 563 ms |

After waiting for the cache to expire, one full readiness check took 153 ms. Cached-run p90 times were 14 ms for readiness, 368 ms for the edit and 649 ms for the sync/edit cycle. The benchmark includes cache expiry during repeated commands. These runner measurements exclude the API's canonical storage read batching.

These are local measurements, not production latency guarantees. Project size, host load, model response time and install/build work affect the time visible in the Coding Agent UI.

`scripts/verify-shared-project-runtime.cjs` creates random diagnostic projects and removes only those projects. It checks concurrent servers, port and context ownership, isolated environments/logs, cross-project reads/writes, symlink traversal, direct network/DNS bypass, and scoped stopping. Run through Node inside the API container:

```powershell
docker cp scripts/verify-shared-project-runtime.cjs npati-agent-api:/app/verify-shared-project-runtime.cjs
docker exec npati-agent-api node /app/verify-shared-project-runtime.cjs
```

`scripts/verify-shared-runtime-frameworks.cjs` checks actual installs/builds and concurrent Preview for Next.js, Vite/React, Expo Web, and Node.js. Copy it and its helper above to the API container's `/tmp`, then execute with Node. It uses diagnostic workspaces, not user projects.

Local execution on 2026-10-09 passed all four actual builds, concurrent HTTP 200 previews on ports 3001–3004, and Node tests. The filesystem/network/context isolation diagnostic also passed. Diagnostic workspaces were removed after the checks; the running stack remained at 12 containers. The legacy readiness egress container, identified by its `npati.readiness=egress` label and having no data mounts, was removed during this local migration.

Focused unit/integration tests cover port rewriting and the existing Preview, project files, terminal policy, environment validation, approval scopes, and Coding Agent security paths. This is not a claim that every repository test passes.

`scripts/verify-prepared-project-runtime.cjs` checks all six prepared profiles with actual builds and concurrent HTTP previews. Copy it, `scripts/verify-shared-project-runtime.cjs`, and `apps/agent-api/project-runtime-profiles.json` into `/app` in the API container, then execute with Node. `scripts/verify-chat-website.cjs` sends the actual Ukrainian shop request through authenticated chat using the installation owner's configured model, verifies the production-build event, and requests the resulting Next.js Preview through the web proxy. It creates a persistent test project and never prints credentials or signed preview URLs.
