# Shared project runtime for OSS / self-hosting

The default local `docker-compose.sandbox-runner.yml` and self-hosted `docker-compose.dokploy.yml` now run one `npati-project-runtime` container. Its Compose service/DNS alias remains `sandbox-runner`, preserving the authenticated runner URL and existing `RemoteSandboxProvider` contract. There is no Docker socket, Docker CLI, per-project sandbox container, per-project proxy container, or readiness Docker container in this execution path.

## Existing paths retained

The implementation first inspected `LocalProjectWorkspace` / `MountedWorkspaceProvider`, `SandboxProvider`, `ProjectSandboxService`, `ProjectPreviewService`, terminal command policy, and the Company/Coding Agent tool path. The new provider implements the existing sandbox contract rather than adding a second set of tools or bypassing API authorization.

Canonical source files stay in the existing workspace provider. The runtime synchronizes a working copy to `/projects/<projectId>` and retains its dependencies/build cache on a named volume. Command output is synchronized back through the existing expected-revision checks. Files, terminal commands, approvals, secret references, RBAC, terminal events, and Activity continue through the existing API services. Selecting a different `projectId` requires the same existing access checks.

Each logical sandbox stores its exact workspace/user/company/project scope, unique Linux UID, port, and process records. A mismatched scope or a process ID owned by another project is refused. Metadata and bounded process logs live in `/runtime-state`, inaccessible to project processes. Supervisor credentials are never inherited by child environments.

## Execution and isolation

- Project children drop to their own UID; project directories have mode 0700.
- A native launcher applies Linux Landlock filesystem restrictions to every command, sync operation, package script, and dev server. Writable access is limited to the selected project directory. Toolchain directories are readable/executable, not writable. Access through symlinks and `/proc/self/root` still encounters that boundary.
- Landlock limits TCP bind/connect to the assigned project port and the shared proxy port. Signal and abstract Unix socket scopes isolate independently launched tasks.
- UID-based IPv4/IPv6 firewall rules block direct external connections and DNS, including attempts to reach an external server on the proxy's port. The existing allowlisted egress proxy runs as a process inside the runtime, not as another container.
- No project child gets root capabilities, Docker access, or privilege escalation. The trusted supervisor retains only the capabilities required to assign UIDs, manage project processes/files, and install its firewall.
- Foreground commands retain the existing timeouts. Preview processes are long-lived; stopping a logical sandbox stops only that project's UID/processes.

**Host requirement: Linux with Landlock ABI 6 or newer (normally Linux 6.12+), and permission to apply container-local iptables/ip6tables rules.** Startup fails closed if these are unavailable; there is no unisolated fallback. The local Docker Desktop host reported Landlock ABI 7. Older VPS kernels must use the retained isolated runner or be upgraded.

Container-wide limits are configured by `NPATI_PROJECT_RUNTIME_MEMORY` (default `4g`), `NPATI_PROJECT_RUNTIME_CPU` (default `4`), and the Compose PID ceiling. Child UID process/file-descriptor limits also apply. This mode does not offer the isolated Docker provider's independent per-project CPU/RAM/disk quotas; projects share the runtime's total resources.

## Preview ports

Ports are assigned centrally and persisted; current allocation starts at 3001, skips supervisor/proxy ports, and never assigns a port already allocated to another logical sandbox. Framework default ports are requests, not fixed host ports. The Preview service uses the port returned by `exposePort`; generated Next/Vite/Expo/static commands are rewritten to that port. Custom Node servers should listen on `process.env.PORT`.

The mapping is `projectId → logical sandbox → assigned port`. Proxy requests must match that project's port. Browser traffic still follows web → API → runtime → project process. Ports are not individually published on the host.

Expo keeps the existing Expo Web export/static-preview workflow. Native device/store builds are not introduced by this change.

## Deployment and migration

Local launch uses the same Compose command as before, with the default sandbox override. Build/recreate `agent-api`, `company-worker`, and `sandbox-runner`; persistent canonical project data is retained. Existing projects whose old sandbox ID cannot be found in the shared runtime receive a new logical sandbox on their next execution, with files synchronized from the canonical workspace.

Existing legacy `npati-sb-*`, `npati-proxy-*`, and `npati-readiness-egress` containers are not automatically deleted. They are not used for newly created shared workspaces. Clean them up deliberately after confirming no isolated runner uses them. Do not remove application/data volumes.

The previous Docker provider and server are retained for remote/isolated deployments. Local isolated configuration is `docker-compose.sandbox-isolated.yml`; Dokploy isolated configuration is `docker-compose.dokploy-isolated.yml`. Choose one runtime scheme for a deployment. Shared mode refuses arbitrary host-folder mounts; such projects retain the isolated runner path, not an unchecked shared bind mount.

For `NPATI_DEPLOYMENT_TYPE=npati_hosted`, retain the isolated configuration; the shared runtime default is the OSS/self-hosted deployment scheme.

After a runtime restart, recorded process IDs are marked stopped and persisted PIDs are never signaled (preventing PID-reuse bugs). Start Preview again. API Preview session tracking is still in memory, so an API restart also requires starting Preview again.

## Verification

`scripts/verify-shared-project-runtime.cjs` creates random diagnostic projects and removes only those projects. It checks concurrent servers, port and context ownership, isolated environments/logs, cross-project reads/writes, symlink traversal, direct network/DNS bypass, and scoped stopping. Run through Node inside the API container:

```powershell
Get-Content -Raw scripts/verify-shared-project-runtime.cjs | docker exec -i npati-agent-api node
```

`scripts/verify-shared-runtime-frameworks.cjs` checks actual installs/builds and concurrent Preview for Next.js, Vite/React, Expo Web, and Node.js. Copy it and its helper above to the API container's `/tmp`, then execute with Node. It uses diagnostic workspaces, not user projects.

Local execution on 2026-10-09 passed all four actual builds, concurrent HTTP 200 previews on ports 3001–3004, and Node tests. The filesystem/network/context isolation diagnostic also passed. Diagnostic workspaces were removed after the checks; the running stack remained at 12 containers. The legacy readiness egress container, identified by its `npati.readiness=egress` label and having no data mounts, was removed during this local migration.

Focused unit/integration tests cover port rewriting and the existing Preview, project files, terminal policy, environment validation, approval scopes, and Coding Agent security paths. No claim is made that every repository test passes or that a new model-driven chat run was performed.
