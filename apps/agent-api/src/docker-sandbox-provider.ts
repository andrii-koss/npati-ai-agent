import { spawn } from "node:child_process";
import type { SandboxImageAdmission } from "./sandbox-image-policy";
import type { EgressEnforcement } from "./sandbox-egress-enforcement";
import { resolveEgressAllowlist, toProxyAllowedHosts } from "./egress-allowlist";
import { randomUUID, createHash } from "node:crypto";
import { chmod, chown, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PreviewProxyRequest, PreviewProxyResponse, SandboxBrowserQaOptions, SandboxBrowserQaResult, SandboxCommandResult, SandboxCommandOptions, SandboxCreateOptions, SandboxFile, SandboxMount, SandboxProvider, SandboxScope, SandboxStatus } from "./sandbox-provider";
import type { SandboxMountGate } from "./mounted-folder-gate";
import { SandboxProviderError, sandboxProcessEnvironment } from "./sandbox-provider";
import { dockerFailure, safeDockerStderr } from "./sandbox-runner-diagnostics";
import { safeProjectPath } from "./project-workspace";
import { classifyTerminalCommand, normalizeTerminalCommand } from "./terminal-command-policy";
import { DEFAULT_SANDBOX_RESOURCE_LIMITS, sandboxMemoryArg, type HostAdmissionController, type SandboxCompanyQuota } from "./sandbox-resource-quota";
import { gitShellHardeningEnv, resolveDepsPolicyLimits } from "./code-deps-policy";

interface RunnerLimits {
  cpu: string; memory: string; diskBytes: number; pids: number; image: string; proxyImage: string; maxFiles: number; maxBytes: number; allowedHosts: string;
}
/**
 * C4b: the default egress allowlist comes from the canonical allowlist module, never from a string
 * literal here. `NPATI_SANDBOX_ALLOWED_HOSTS` remains the operator override. The canonical default is
 * the approved install set (official registries) plus an **empty** run set, i.e. deny-all for anything
 * that is not an approved registry — git hosts and vendor mirrors are not implicit.
 */
const defaultAllowedHosts = process.env.NPATI_SANDBOX_ALLOWED_HOSTS ?? toProxyAllowedHosts(resolveEgressAllowlist({ env: process.env }));
const defaults: RunnerLimits = {
  /**
   * R1 (section A, item 4): the per-sandbox ceilings are the module-level start values of
   * `sandbox-resource-quota.ts` — 2 vCPU / 4096 MB / 10 GiB / 512 pids — and no longer literals local to this
   * file. The change from the previous literals (1 vCPU / 1536m / 1536 MiB / 128 pids) is explicit and is
   * recorded in `docs/coding-agent/r1a-limits-and-quotas-report.md`; a deployment overrides every one of them
   * with `NPATI_SANDBOX_CPU/MEMORY/DISK_BYTES/PIDS`, which the sandbox runner reads.
   *
   * Single-sourced on purpose: the aggregate Company quota multiplies these same values, so a ceiling that
   * moved in one place and not the other would make the aggregate either stricter or looser than it claims.
   */
  cpu: String(DEFAULT_SANDBOX_RESOURCE_LIMITS.cpu),
  memory: sandboxMemoryArg(DEFAULT_SANDBOX_RESOURCE_LIMITS.memoryMb),
  diskBytes: DEFAULT_SANDBOX_RESOURCE_LIMITS.diskBytes,
  pids: DEFAULT_SANDBOX_RESOURCE_LIMITS.pids,
  image: "npati/project-sandbox:local", proxyImage: "npati/sandbox-egress:local", maxFiles: 500, maxBytes: 20_000_000, allowedHosts: defaultAllowedHosts,
};
const DATABASE_HOST_PATTERN = /(^|[.-])(postgres|postgresql|pg|db|database)([.-]|$)/;

/**
 * Appends the Project API host (from NPATI_PROJECT_API_PUBLIC_URL) to the sandbox egress allowlist.
 * Only the Project API host is added; database hosts are rejected so sandboxes never reach Postgres.
 */
export function sandboxAllowedHostsWithProjectApi(baseHosts: string, projectApiPublicUrl?: string): string {
  const hosts = baseHosts.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (projectApiPublicUrl) {
    let host: string | undefined;
    try { host = new URL(projectApiPublicUrl).hostname.toLowerCase(); } catch { host = undefined; }
    if (host && /^[a-z0-9.-]+$/.test(host) && !host.startsWith(".") && !host.endsWith(".") && !DATABASE_HOST_PATTERN.test(host) && !hosts.includes(host)) hosts.push(host);
  }
  return hosts.join(",");
}
const uuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const label = (scope: SandboxScope) => createHash("sha256").update([scope.workspaceId, scope.userId, scope.companyId, scope.projectId].join(":")).digest("hex");
function args(cmd: string, values: string[], timeoutMs = 30_000, stdin?: string | Buffer, outputLimit = 128_000): Promise<{ code: number; stdout: Buffer; stderr: Buffer; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, values, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, timedOut = false, finished = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    const push = (target: Buffer[], chunk: Buffer) => { size += chunk.length; if (size <= outputLimit) target.push(chunk); else { timedOut = true; child.kill("SIGKILL"); } };
    child.stdout.on("data", (chunk: Buffer) => push(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => push(stderr, chunk));
    child.on("error", (error) => { if (!finished) { finished = true; clearTimeout(timer); reject(error); } });
    child.on("close", (code) => { if (!finished) { finished = true; clearTimeout(timer); resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut }); } });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}
const text = (bytes: Buffer) => bytes.toString("utf8").slice(0, 128_000);
export async function assignSandboxOwner(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await assignSandboxOwner(child);
    else { await chmod(child, 0o666).catch(() => undefined); await chown(child, 10001, 10001).catch(() => undefined); }
  }
  await chmod(directory, 0o777).catch(() => undefined);
  await chown(directory, 10001, 10001).catch(() => undefined);
}
/**
 * C1b: the full `docker create` command line for a project sandbox, as a pure function.
 *
 * Kept separate from the provider so the hardening properties are directly testable: unprivileged
 * user, read-only root filesystem, all capabilities dropped, no-new-privileges, tmpfs workspace, an
 * internal network only, and (when configured) a seccomp profile. There is deliberately no
 * `--privileged`, no host path mount and no docker socket.
 *
 * C15 adds exactly one host path, and only when a mounted local folder was confirmed for this project:
 * `--mount type=bind,source=<canonical folder>,target=/workspace`. The owner decision that makes this
 * acceptable is that the folder is then the project's **canonical workspace** — the provider reads and writes
 * the same directory — so the bind is not a copy and not a second view of the project.
 *
 * The conflict with the C14 `--tmpfs /workspace` is resolved by making the two **mutually exclusive**: a
 * container has either the bounded tmpfs workspace (no mount) or the bind mount (mounted project), never both,
 * because Docker refuses two mounts at one destination and, more importantly, a mount shadowed by a tmpfs would
 * be a silent no-op — the agent would work in the throwaway filesystem while the user's folder stayed
 * untouched. The runtime directory (`/workspace/.npati-runtime`, where the npm/pip caches and `HOME` live) is
 * a **bounded tmpfs in both cases**, mounted over the subdirectory, so cache writes never land in the user's
 * folder and the size ceilings of the sandbox still apply to everything except the mount itself.
 *
 * Honest limit, stated here because it is a real consequence and not a detail: `size=` bounds a tmpfs, so a
 * mounted folder is **not** size-capped by the sandbox. It is the operator's own disk, chosen explicitly by an
 * owner/admin through the allowlist, and the resource ceilings of the container (CPU, memory, pids) still
 * apply to whatever runs against it.
 */
export function buildSandboxCreateArgs(input: {
  sandboxName: string;
  sandboxId: string;
  network: string;
  scope: SandboxScope;
  image: string;
  cpus: string;
  memory: string;
  pids: number;
  diskBytes: number;
  seccompProfile?: string;
  /** C15: the one host path a sandbox may see, derived from the mounted-folder allowlist. */
  mount?: SandboxMount;
}): string[] {
  const runtimeTmpfs = `/workspace/.npati-runtime:rw,exec,nosuid,nodev,uid=10001,gid=10001,size=${Math.min(input.diskBytes, 256 * 1024 * 1024)}`;
  /**
   * Either the bounded tmpfs workspace (what every project got before C15, byte-for-byte unchanged) or the
   * single bind mount of the confirmed folder, followed by the bounded runtime tmpfs that keeps `HOME` and the
   * package caches writable — which is also what makes an `ro` mount usable rather than merely mounted.
   */
  const workspaceMount = input.mount
    ? [
      "--mount", `type=bind,source=${input.mount.source},target=${input.mount.target}${input.mount.readOnly ? ",readonly" : ""}`,
      "--tmpfs", runtimeTmpfs,
    ]
    : ["--tmpfs", `/workspace:rw,exec,nosuid,nodev,uid=10001,gid=10001,size=${input.diskBytes}`];
  return [
    "create", "--name", input.sandboxName, "--label", `npati.scope=${label(input.scope)}`, "--label", `npati.sandbox=${input.sandboxId}`,
    "--network", input.network, "--network-alias", "project-preview", "--user", "10001:10001", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    ...(input.seccompProfile ? ["--security-opt", `seccomp=${input.seccompProfile}`] : []),
    "--cpus", input.cpus, "--memory", input.memory, "--pids-limit", String(input.pids),
    ...workspaceMount,
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,uid=10001,gid=10001,size=64m",
    "--workdir", "/workspace", "--env", "HOME=/workspace/.npati-runtime",
    "--env", "NPM_CONFIG_CACHE=/workspace/.npati-runtime/npm",
    "--env", "npm_config_proxy=http://egress:8080",
    "--env", "npm_config_https_proxy=http://egress:8080",
    "--env", "npm_config_audit=false",
    "--env", "npm_config_fund=false",
    "--env", "PIP_CACHE_DIR=/workspace/.npati-runtime/pip",
    "--env", "PIP_TARGET=/workspace/.npati-runtime/python",
    "--env", "PYTHONPATH=/workspace/.npati-runtime/python",
    "--env", "NEXT_TELEMETRY_DISABLED=1",
    "--env", "HTTP_PROXY=http://egress:8080",
    "--env", "HTTPS_PROXY=http://egress:8080",
    "--env", "http_proxy=http://egress:8080",
    "--env", "https_proxy=http://egress:8080",
    "--env", "NO_PROXY=localhost,127.0.0.1",
    input.image, "sleep", "infinity",
  ];
}

export class DockerSandboxProvider implements SandboxProvider {  private readonly limits: RunnerLimits;
  private readonly activity = new Map<string, number>();
  private touch(id: string) { this.activity.set(id, Date.now()); }
  constructor(limits: Partial<RunnerLimits> = {}, /** C1b admission policy; absent means every image is refused. */ private readonly imagePolicy?: SandboxImageAdmission,
    /** C4b enforcement probe; absent means every sandbox creation is refused (fail closed). */
    private readonly egressEnforcement?: EgressEnforcement,
    /**
     * C15: the mount gate. It is the **runner's own** re-check of the path it is about to hand to
     * `docker create` — the allowlist read from the runner's database plus the same path validation the API ran
     * — and it is a required collaborator of a mount. Without it a mount is refused
     * (`mounted_folder_gate_unavailable`), because "the API validated this already" is exactly the assumption
     * the TOCTOU window between the confirmation and the create invalidates.
     */
    private readonly mountGate?: SandboxMountGate,
    /**
     * R1 (section A, item 4): the aggregate Company quota — five parallel sandboxes and their summed CPU,
     * memory, disk and pids. Applied in `createSandbox` **before** any Docker call, so a Company over its quota
     * costs no container, no network and no pull; released in `destroySandbox`.
     *
     * Optional, and `undefined` means "not configured": a provider constructed by an existing test or by a
     * deployment that has not opted in behaves exactly as it did before this step.
     */
    private readonly companyQuota?: SandboxCompanyQuota,
    /**
     * R1 (section A, item 4): admission control on the **host's** own load. It gates container creation and
     * nothing else — see the header of `sandbox-resource-quota.ts` for why it must never be wired into the
     * Company run gate.
     */
    private readonly hostAdmission?: HostAdmissionController) { this.limits = { ...defaults, ...limits };
    // An empty allowlist is a legitimate deny-all state (C4b run phase), not a configuration error.
    const allowlistEntries = this.limits.allowedHosts.split(",").map((host) => host.trim()).filter(Boolean);
    const validAllowlistEntry = (host: string) => /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host);
    if (!allowlistEntries.every(validAllowlistEntry)) throw new Error("Invalid sandbox allowlist");
    if (!/^(?:0\.[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]+)?)$/.test(this.limits.cpu) || !/^[1-9][0-9]*(?:[kmg])?$/i.test(this.limits.memory) || !Number.isSafeInteger(this.limits.diskBytes) || this.limits.diskBytes < 16_000_000 || !Number.isSafeInteger(this.limits.pids) || this.limits.pids < 16) throw new Error("Invalid sandbox resource limits"); }
  private async docker(argsList: string[], timeoutMs = 30_000, stdin?: string | Buffer, outputLimit?: number) {
    const action = [argsList[0], argsList[0] === "network" ? argsList[1] : undefined].filter(Boolean).join(".");
    let result: Awaited<ReturnType<typeof args>>;
    try { result = await args("docker", argsList, timeoutMs, stdin, outputLimit); }
    catch (error) { throw dockerFailure(action, error instanceof Error ? error.message : "Docker CLI failed to start", false, (error as NodeJS.ErrnoException)?.code); }
    if (result.code !== 0 || result.timedOut) throw dockerFailure(action, text(result.stderr) || text(result.stdout), result.timedOut);
    return result;
  }
  private names(id: string) {
    if (!uuid(id)) throw new SandboxProviderError("invalid_sandbox", "Invalid sandbox ID", 400);
    return { sandbox: `npati-sb-${id}`, network: `npati-net-${id}`, proxy: `npati-proxy-${id}` };
  }
  private async inspect(scope: SandboxScope, id: string) {
    const names = this.names(id);
    const found = await args("docker", ["inspect", "--format", "{{json .Config.Labels}}", names.sandbox]);
    if (found.code !== 0) {
      if (/(?:no such object|no such container)/i.test(text(found.stderr))) throw new SandboxProviderError("sandbox_not_found", "Sandbox not found", 404);
      throw dockerFailure("inspect", text(found.stderr), found.timedOut);
    }
    let labels: Record<string, string>;
    try { labels = JSON.parse(text(found.stdout)); } catch { throw new SandboxProviderError("sandbox_corrupt", "Sandbox metadata is invalid", 503); }
    if (labels["npati.scope"] !== label(scope) || labels["npati.sandbox"] !== id) throw new SandboxProviderError("sandbox_scope_denied", "Sandbox scope denied", 403);
    return names;
  }
  private async state(scope: SandboxScope, id: string): Promise<SandboxStatus> {
    const names = await this.inspect(scope, id);
    const inspect = await this.docker(["inspect", "--format", "{{.Created}}|{{.State.Status}}|{{.State.StartedAt}}", names.sandbox]);
    const [createdAt, value, startedAt] = text(inspect.stdout).trim().split("|");
    const storedAt = this.activity.get(id) ?? Date.parse(startedAt ?? "");
    return { id, state: value === "running" ? "running" : value === "created" ? "created" : value === "exited" ? "stopped" : "failed", createdAt: createdAt ?? new Date().toISOString(), lastActivityAt: new Date(Number.isFinite(storedAt) ? storedAt : Date.now()).toISOString() };
  }
  async createSandbox(scope: SandboxScope, options: SandboxCreateOptions = {}): Promise<SandboxStatus> {
    /**
     * R1 (section A, item 4): the two **deployment** limits, checked before anything else and before any Docker
     * call. Order matters for the diagnosis: "the host is overloaded" and "this Company is at its quota" are
     * operational facts an operator acts on differently, and neither should be reported as an image-policy
     * refusal. The host comes first because it is a property of the machine rather than of the tenant.
     */
    this.hostAdmission?.assertAdmitted();
    let quotaHeld = false;
    if (this.companyQuota) {
      this.companyQuota.admit({ companyId: scope.companyId, projectId: scope.projectId });
      quotaHeld = true;
    }
    try {
      // C1b: admission control happens before any container is created. The policy decides which digest
      // may run and returns the exact reference to use, so a tag never reaches `docker create`.
      const admitted = await this.admitImage(scope);
      // C15: the mount is re-authorised here, immediately before the container exists. It reads the allowlist
      // from the database itself rather than trusting the payload, and re-runs the path validation, so neither a
      // path that changed since the confirmation nor a path a client invented can become a bind mount.
      const mount = await this.authorizeMount(scope, options.mount);
      return await this.createSandboxInternal(scope, admitted, mount);
    } catch (error) {
      /**
       * A creation that failed must not keep the Company's capacity: the container does not exist, and a leak
       * here would refuse the Company its next sandbox for the life of the process. `release` is idempotent, so
       * a failure that happened after the container was really removed cannot double-count either.
       */
      if (quotaHeld) this.companyQuota?.release({ companyId: scope.companyId, projectId: scope.projectId });
      throw error;
    }
  }

  /**
   * C15: the runner-side mount gate.
   *
   * The window this closes is real and narrow: an owner confirms a folder, and between that moment and the
   * container creation the directory can be replaced by a symlink or a junction, or the API can be bypassed
   * entirely and a payload sent straight to the runner's HTTP endpoint. So the runner does not ask "did the API
   * approve this path" — it asks the database, with no user context, "which folder is confirmed for this
   * project", and then validates **that** path itself. A mismatch (including a misspelled path that resolves to
   * the same directory being accepted, because the comparison is on the canonical key) is a refusal.
   */
  private async authorizeMount(scope: SandboxScope, requested: SandboxMount | undefined): Promise<SandboxMount | undefined> {
    if (!requested) return undefined;
    const gate = this.mountGate;
    if (!gate) throw new SandboxProviderError("mounted_folder_gate_unavailable", "The sandbox runner has no mounted-folder allowlist, so no host folder can be mounted", 403, "sandbox.create");
    return gate.authorizeMount({ companyId: scope.companyId, projectId: scope.projectId, requested });
  }

  /**
   * Resolves the image for this sandbox through the admission policy. Deny by default: without a
   * configured policy no image is admitted (`sandbox_image_policy_unavailable`), and every policy
   * refusal becomes a structured `SandboxProviderError` with the policy's own code.
   */
  private async admitImage(scope: SandboxScope): Promise<{ reference: string; dev: boolean }> {
    if (!this.imagePolicy) {
      this.logAdmission("denied", { code: "sandbox_image_policy_unavailable", reference: this.limits.image, companyId: scope.companyId });
      throw new SandboxProviderError("sandbox_image_policy_unavailable", "Sandbox image admission policy is not configured", 403, "image_admission");
    }
    try {
      const result = await this.imagePolicy.admit(
        { workspaceId: scope.workspaceId, userId: scope.userId, permissions: ["workspace:read"] },
        { companyId: scope.companyId, reference: this.limits.image },
      );
      this.logAdmission("allowed", { reference: result.reference, dev: result.dev, companyId: scope.companyId });
      return { reference: result.reference, dev: result.dev };
    } catch (error) {
      const failure = error as { code?: string; message?: string; status?: number; details?: Record<string, unknown> };
      const code = failure.code ?? "sandbox_image_denied";
      this.logAdmission("denied", { code, reference: this.limits.image, companyId: scope.companyId, details: failure.details ?? {} });
      throw new SandboxProviderError(code, failure.message ?? "Sandbox image was refused by policy", failure.status === 409 ? 409 : 403, "image_admission");
    }
  }

  private logAdmission(outcome: "allowed" | "denied", meta: Record<string, unknown>) {
    console.info(`[sandbox-image-admission] ${outcome} ${JSON.stringify(meta)}`);
  }

  private async createSandboxInternal(scope: SandboxScope, admitted: { reference: string; dev: boolean }, mount?: SandboxMount): Promise<SandboxStatus> {
    if (!scope.workspaceId || !scope.userId || !scope.companyId || !scope.projectId) throw new SandboxProviderError("invalid_scope", "Sandbox scope is incomplete", 400);
    const id = randomUUID(), names = this.names(id);
    let phase = "network.create";
    try {
      await this.docker(["network", "create", "--driver", "bridge", "--internal", "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated", names.network]);
      phase = "proxy.create";
      await this.docker(["create", "--name", names.proxy, "--network", "bridge", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "128m", "--pids-limit", "64", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m",
        "--env", `ALLOWED_HOSTS=${this.limits.allowedHosts}`,
        // C4b: the proxy enforces the same policy knobs the operator configures for the runner.
        "--env", `ALLOWED_GIT_HOSTS=${process.env.NPATI_SANDBOX_EGRESS_GIT_HOSTS ?? "github.com,codeload.github.com,gitlab.com,bitbucket.org"}`,
        "--env", `NPATI_SANDBOX_EGRESS_MAX_REDIRECTS=${process.env.NPATI_SANDBOX_EGRESS_MAX_REDIRECTS ?? "5"}`,
        "--env", `NPATI_SANDBOX_EGRESS_DNS_TTL_MS=${process.env.NPATI_SANDBOX_EGRESS_DNS_TTL_MS ?? "30000"}`,
        ...(process.env.NPATI_EGRESS_AUDIT_HOOK ? ["--env", `NPATI_EGRESS_AUDIT_HOOK=${process.env.NPATI_EGRESS_AUDIT_HOOK}`] : []),
        this.limits.proxyImage]);
      phase = "proxy.network.connect";
      await this.docker(["network", "connect", "--alias", "egress", names.network, names.proxy]);
      phase = "proxy.start";
      await this.docker(["start", names.proxy]);
      // C4b: enforcement must be PROVEN on this run's network before any workload container exists.
      // The network is created `--internal` with an isolated gateway, so the only reachable peer is the
      // proxy; the probe additionally verifies that direct egress and outside DNS are impossible.
      // The NPATI_SANDBOX_EGRESS_ENFORCED flag alone never authorizes a container (owner decision).
      if (!this.egressEnforcement) {
        throw new SandboxProviderError("network_enforcement_unavailable",
          "Sandbox egress enforcement probe is not configured", 503, "sandbox", "code.shell.exec", true);
      }
      this.egressEnforcement.scope = { proxy: names.proxy, network: names.network };
      phase = "egress.verify";
      await this.egressEnforcement.assertEnforced();
      phase = "sandbox.create";
      await this.docker(buildSandboxCreateArgs({
        sandboxName: names.sandbox, sandboxId: id, network: names.network, scope, image: admitted.reference,
        cpus: this.limits.cpu, memory: this.limits.memory, pids: this.limits.pids, diskBytes: this.limits.diskBytes,
        seccompProfile: process.env.NPATI_SANDBOX_SECCOMP_PROFILE,
        ...(mount ? { mount } : {}),
      }));
      this.touch(id);
      return this.state(scope, id);
    } catch (error) {
      if (error instanceof SandboxProviderError) error.diagnostics = { ...error.diagnostics, dockerAction: phase, sandboxId: id, image: phase.startsWith("proxy") ? this.limits.proxyImage : phase.startsWith("sandbox") ? admitted.reference : undefined, container: phase.startsWith("proxy") ? names.proxy : phase.startsWith("sandbox") ? names.sandbox : undefined, network: names.network };
      await args("docker", ["rm", "-f", names.sandbox]).catch(() => undefined);
      await args("docker", ["rm", "-f", names.proxy]).catch(() => undefined);
      await args("docker", ["network", "rm", names.network]).catch(() => undefined);
      throw error;
    }
  }
  async startSandbox(scope: SandboxScope, id: string) {
    const names = await this.inspect(scope, id);
    const status = await this.state(scope, id);
    if (status.state !== "running") {
      await this.docker(["start", names.sandbox]);
      await this.docker(["exec", names.sandbox, "mkdir", "-p", "/workspace/.npati-runtime/npm", "/workspace/.npati-runtime/pip", "/workspace/.npati-runtime/python"]).catch(() => undefined);
    }
    this.touch(id);
    return this.state(scope, id);
  }
  async stopSandbox(scope: SandboxScope, id: string) { const names = await this.inspect(scope, id); if ((await this.state(scope, id)).state === "running") await this.docker(["stop", "--time", "5", names.sandbox], 15_000); return this.state(scope, id); }
  async destroySandbox(scope: SandboxScope, id: string) { const names = await this.inspect(scope, id); await this.docker(["rm", "-f", names.sandbox]); await this.docker(["rm", "-f", names.proxy]); await this.docker(["network", "rm", names.network]); this.activity.delete(id); this.companyQuota?.release({ companyId: scope.companyId, projectId: scope.projectId }); }
  async getStatus(scope: SandboxScope, id: string) { return this.state(scope, id); }
  async executeCommand(scope: SandboxScope, id: string, command: string, options: SandboxCommandOptions): Promise<SandboxCommandResult> {
    const names = await this.inspect(scope, id);
    const normalized = normalizeTerminalCommand({ command, cwd: options.cwd });
    classifyTerminalCommand({ command: normalized.command, cwd: normalized.cwd });
    this.touch(id);
    const env = Object.entries(options.environment ?? {});
    if (env.some(([key]) => !/^[A-Z_][A-Z0-9_]{0,63}$/.test(key))) throw new SandboxProviderError("invalid_environment", "Invalid environment key", 400);
    const isExplicitInstall = /^(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add)\b/.test(command.trim());
    const ensureDepsScript = !isExplicitInstall ? `if [ -f package.json ] && [ ! -d node_modules ]; then
  if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile;
  elif [ -f yarn.lock ]; then yarn install;
  elif [ -f package-lock.json ]; then npm ci;
  else npm install;
  fi
fi
` : "";
    const script = env.map(([key, value]) => `export ${key}="$(printf %s ${Buffer.from(value).toString("base64")} | base64 -d)"`).join("\n") + "\n" + ensureDepsScript + command + "\n";
    const started = Date.now();
    let result: Awaited<ReturnType<typeof args>>;
    try { result = await args("docker", ["exec", "-i", "--workdir", normalized.cwd === "." ? "/workspace" : `/workspace/${normalized.cwd}`, names.sandbox, "timeout", "-s", "TERM", "-k", "2", String(Math.max(1, Math.ceil(options.timeoutMs / 1000))), "sh", "-s"], Math.min(options.timeoutMs, 600_000) + 5_000, script, Math.min(options.outputLimitBytes, 128_000)); }
    catch (error) { throw dockerFailure("exec", error instanceof Error ? error.message : "Docker CLI failed to start", false, (error as NodeJS.ErrnoException)?.code); }
    if (result.code !== 0 && /^(?:error response from daemon|cannot connect to the docker daemon|permission denied while trying to connect|docker: error)/i.test(text(result.stderr).trim())) throw dockerFailure("exec", text(result.stderr), result.timedOut);
    if (result.timedOut) await this.stopSandbox(scope, id).catch(() => undefined);
    if (result.code !== 0 && !result.timedOut) {
      console.warn(`[sandbox-runner] command failed (exit ${result.code}):\nSTDOUT: ${text(result.stdout).slice(0, 1000)}\nSTDERR: ${text(result.stderr).slice(0, 1000)}`);
    }
    return {
      status: result.timedOut || result.code === 124 || result.code === 137 ? "timed_out" : result.code === 0 ? "completed" : "failed", exitCode: result.timedOut ? null : result.code,
      stdout: text(result.stdout), stderr: text(result.stderr), durationMs: Date.now() - started, step: "command", tool: "project.terminal.exec", retryable: result.timedOut,
    };
  }
  async inspectBrowser(scope: SandboxScope, id: string, options: SandboxBrowserQaOptions): Promise<SandboxBrowserQaResult> {
    const names = await this.inspect(scope, id);
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 ||
        !/^\/(?!\/)[A-Za-z0-9/_~.%-]*$/.test(options.path) || options.path.includes("..") ||
        !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60000 ||
        !Number.isInteger(options.maxScreenshotBytes) || options.maxScreenshotBytes < 50000 || options.maxScreenshotBytes > 2000000 ||
        !Number.isInteger(options.maxBrokenLinks) || options.maxBrokenLinks < 1 || options.maxBrokenLinks > 50 ||
        !Number.isInteger(options.viewport.width) || options.viewport.width < 320 || options.viewport.width > 1920 ||
        !Number.isInteger(options.viewport.height) || options.viewport.height < 320 || options.viewport.height > 1200) {
      throw new SandboxProviderError("invalid_qa_options", "Invalid browser QA options", 400, "browser_qa", "project.qa.inspect");
    }
    const container = `npati-qa-${randomUUID()}`;
    this.touch(id);
    try {
      const result = await args("docker", ["run", "--rm", "--name", container, "--network", names.network,
        "--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--cpus", "1", "--memory", "768m", "--pids-limit", "256", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
        "--env", "HOME=/tmp", "-i", process.env.NPATI_BROWSER_QA_IMAGE || "npati/browser-qa:local"],
        options.timeoutMs + 5000, JSON.stringify({ ...options, host: names.sandbox }), 3_000_000);
      if (result.timedOut) throw new SandboxProviderError("qa_timeout", "Browser QA timed out or exceeded its output limit", 504, "browser_qa", "project.qa.inspect");
      if (result.code !== 0) throw new SandboxProviderError("qa_failed", "Browser QA runner failed", 503, "browser_qa", "project.qa.inspect");
      const parsed = JSON.parse(result.stdout.toString("utf8")) as SandboxBrowserQaResult;
      if (!Number.isInteger(parsed.statusCode) || !Array.isArray(parsed.brokenLinks) || !Array.isArray(parsed.accessibility))
        throw new SandboxProviderError("qa_invalid_result", "Browser QA runner returned invalid output", 503, "browser_qa", "project.qa.inspect");
      return parsed;
    } finally {
      await args("docker", ["rm", "-f", container], 5000).catch(() => undefined);
    }
  }
  async uploadFiles(scope: SandboxScope, id: string, files: SandboxFile[]) {
    const names = await this.inspect(scope, id);
    this.touch(id);
    if (files.length > this.limits.maxFiles || files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > this.limits.maxBytes) throw new SandboxProviderError("upload_limit", "Upload exceeds sandbox limits", 413);
    const sanitized = files.map((file) => ({ path: safeProjectPath(file.path), content: file.content }));
    const script = `let chunks=[];process.stdin.on("data",c=>chunks.push(c));process.stdin.on("end",async()=>{try{const files=JSON.parse(Buffer.concat(chunks).toString("utf8"));const fs=require("node:fs/promises");const path=require("node:path");for(const file of files){const target=path.resolve("/workspace",file.path);if(!target.startsWith("/workspace/"))throw Error("Unsafe path: "+file.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,file.content,"utf8");}}catch(e){process.stderr.write(String(e));process.exitCode=1}})`;
    await this.docker(["exec", "-i", names.sandbox, "node", "-e", script], 120_000, JSON.stringify(sanitized));
  }
  async downloadFiles(scope: SandboxScope, id: string): Promise<SandboxFile[]> {
    const names = await this.inspect(scope, id);
    this.touch(id);
    const listed = await this.docker(["exec", names.sandbox, "find", "/workspace", "-type", "f", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/vendor/*", "-not", "-path", "*/.npati-runtime/*", "-not", "-path", "*/dist/*", "-not", "-path", "*/build/*", "-not", "-path", "*/.next/*", "-not", "-path", "*/.cache/*", "-not", "-path", "*/.venv/*", "-not", "-path", "*/__pycache__/*", "-print0"], 30_000, undefined, 256_000);
    const paths = listed.stdout.toString("utf8").split("\0").filter(Boolean);
    if (paths.length > this.limits.maxFiles) throw new SandboxProviderError("download_limit", "Too many sandbox files", 413);
    const files: SandboxFile[] = [];
    let total = 0;
    for (const absolute of paths) {
      if (!absolute.startsWith("/workspace/")) throw new SandboxProviderError("unsafe_path", "Sandbox returned an unsafe path", 400);
      const relative = safeProjectPath(absolute.slice("/workspace/".length));
      const result = await this.docker(["exec", names.sandbox, "cat", "--", absolute], 30_000, undefined, this.limits.maxBytes);
      total += result.stdout.length;
      if (total > this.limits.maxBytes) throw new SandboxProviderError("download_limit", "Sandbox files exceed sync limit", 413);
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout); }
      catch { throw new SandboxProviderError("unsupported_binary_file", "Sandbox generated a binary file outside ignored build artifacts", 422, "download"); }
      if (content.includes("\0")) throw new SandboxProviderError("unsupported_binary_file", "Sandbox generated a binary file outside ignored build artifacts", 422, "download");
      files.push({ path: relative, content });
    }
    return files;
  }
  async proxyPreview(scope: SandboxScope, id: string, options: PreviewProxyRequest): Promise<PreviewProxyResponse> {
    const names = await this.inspect(scope, id);
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 ||
        !options.path.startsWith("/") || options.path.startsWith("//") || options.path.length > 4096 ||
        !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(options.method) ||
        (options.body && options.body.length > 8_000_000)) {
      throw new SandboxProviderError("invalid_preview_request", "Invalid preview request", 400);
    }
    const script = `let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",async()=>{try{const q=JSON.parse(input);const url=new URL(q.path,"http://127.0.0.1:"+q.port);if(url.hostname!=="127.0.0.1")throw Error("Invalid preview path");const r=await fetch(url,{method:q.method,headers:q.headers,body:q.body?Buffer.from(q.body,"base64"):undefined,signal:AbortSignal.timeout(20000),redirect:"manual"});const data=Buffer.from(await r.arrayBuffer());if(data.length>8000000)throw Error("Preview response too large");process.stdout.write(JSON.stringify({status:r.status,headers:Object.fromEntries(r.headers),body:data.toString("base64")}));}catch(e){process.stderr.write(String(e));process.exitCode=1}})`;
    const result = await args("docker", ["exec", "-i", names.sandbox, "node", "-e", script], 25_000, JSON.stringify(options), 16_000_000);
    if (result.code !== 0 || result.timedOut) {
      if (/^(?:error response from daemon|cannot connect to the docker daemon|permission denied while trying to connect|docker: error)/i.test(text(result.stderr).trim())) throw dockerFailure("exec", text(result.stderr), result.timedOut);
      const error = new SandboxProviderError("preview_upstream_failed", "Preview server is unavailable", 502);
      error.diagnostics = { dockerAction: "preview.fetch", dockerStderr: safeDockerStderr(text(result.stderr)), sandboxId: id, container: names.sandbox, network: names.network };
      throw error;
    }
    this.touch(id);
    return JSON.parse(result.stdout.toString("utf8")) as PreviewProxyResponse;
  }
  async exposePort(scope: SandboxScope, id: string, port: number): Promise<{ port: number; internalHost: string }> {
    const names = await this.inspect(scope, id);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxProviderError("invalid_port", "Invalid port number", 400);
    }
    const inspect = await args("docker", ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", names.sandbox]);
    if (inspect.code !== 0 || inspect.timedOut) throw dockerFailure("inspect.network", text(inspect.stderr), inspect.timedOut);
    const internalIp = text(inspect.stdout).trim();
    const internalHost = internalIp || names.sandbox;
    return { port, internalHost };
  }
  async getLogs(scope: SandboxScope, id: string, processId?: string) {
    const names = await this.inspect(scope, id);
    if (processId) { if (!uuid(processId)) throw new SandboxProviderError("invalid_process", "Invalid process ID", 400); const result = await this.docker(["exec", names.sandbox, "cat", "--", `/tmp/npati-process-${processId}.log`]); return text(result.stdout); }
    const result = await this.docker(["logs", "--tail", "100", names.sandbox]); return text(result.stdout) + text(result.stderr);
  }
  async processCapabilities(_scope: SandboxScope) { return { durableIdentity: true, terminalStatus: true }; }
  async getProcessOutput(scope: SandboxScope, id: string, processId: string) {
    const names = await this.inspect(scope, id);
    if (!uuid(processId)) throw new SandboxProviderError("invalid_process", "Invalid process ID", 400);
    const script = `const fs=require('fs');let tail='',total=0;const s=fs.createReadStream(process.argv[1],{encoding:'utf8'});s.on('data',c=>{total+=c.length;tail=(tail+c).slice(-64000)});s.on('end',()=>process.stdout.write(JSON.stringify({output:tail,earliestOffset:total-tail.length,nextOffset:total})));s.on('error',()=>process.exit(44));`;
    const result = await args("docker", ["exec", names.sandbox, "node", "-e", script, `/tmp/npati-process-${processId}.log`], 30000, undefined, 512000);
    if (result.code !== 0 || result.timedOut) throw new SandboxProviderError("process_output_unavailable", "Process output is unavailable", 503);
    return JSON.parse(result.stdout.toString("utf8")) as { output: string; earliestOffset: number; nextOffset: number };
  }
  async startProcess(scope: SandboxScope, id: string, command: string, options: SandboxCommandOptions): Promise<SandboxCommandResult> {
    const names = await this.inspect(scope, id);
    const normalized = normalizeTerminalCommand({ command, cwd: options.cwd });
    classifyTerminalCommand({ command: normalized.command, cwd: normalized.cwd });
    const environment = [...sandboxProcessEnvironment(options.environment), ...Object.entries(gitShellHardeningEnv(resolveDepsPolicyLimits()))];
    this.touch(id);
    const processId = options.processId ?? randomUUID(), marker = `/tmp/npati-process-${processId}`;
    if (!uuid(processId)) throw new SandboxProviderError("invalid_process", "Invalid process ID", 400);
    const ensureDepsScript = `if [ -f package.json ] && [ ! -d node_modules ]; then
  if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile;
  elif [ -f yarn.lock ]; then yarn install;
  elif [ -f package-lock.json ]; then npm ci;
  else npm install;
  fi
fi
`;
    const command64 = Buffer.from("set -e\n" + ensureDepsScript + "\n" + command).toString("base64");
    const environmentScript = environment.map(([key, value]) => `export ${key}="$(printf %s ${Buffer.from(value).toString("base64")} | base64 -d)"`).join("\n");
    const script = `set -e
${this.processLock(marker)}
if [ -f ${marker}.cancel ] || [ -f ${marker}.claim ]; then exit 0; fi
touch ${marker}.claim ${marker}.log
${environmentScript}
setsid sh -c 'echo $$ > ${marker}.pid; foreground=""; if timeout --help 2>&1 | grep -q -- "--foreground"; then foreground="--foreground"; fi; printf %s ${command64} | base64 -d | timeout $foreground -s TERM -k 2 ${Math.max(1, Math.ceil(options.timeoutMs / 1000))} sh -s >> ${marker}.log 2>&1; echo $? > ${marker}.exit' 9>&- </dev/null >/dev/null 2>&1 &
i=0; until [ -s ${marker}.pid ]; do i=$((i+1)); [ "$i" -lt 100 ] || exit 75; sleep 0.01; done`;
    await this.docker(["exec", "-i", "--workdir", normalized.cwd === "." ? "/workspace" : `/workspace/${normalized.cwd}`, names.sandbox, "sh", "-s"], 15_000, script);
    return this.getProcessStatus(scope, id, processId);
  }
  private processLock(marker: string) {
    return `exec 9>${marker}.lock; i=0
until flock -n 9; do i=$((i+1)); [ "$i" -lt 100 ] || exit 75; sleep 0.05; done`;
  }
  private groupAliveScript() {
    // Zombies cannot write; kill(0) alone would keep their sandbox pinned forever.
    return `const fs=require("fs");const pid=fs.readFileSync(process.argv[1],"utf8").trim();if(!/^[1-9][0-9]*$/.test(pid))process.exit(76);let alive=false;for(const entry of fs.readdirSync("/proc")){if(!/^[0-9]+$/.test(entry))continue;try{const stat=fs.readFileSync("/proc/"+entry+"/stat","utf8");const parts=stat.slice(stat.lastIndexOf(")")+2).split(" ");if(parts[2]===pid&&!["Z","X"].includes(parts[0]))alive=true}catch{}}process.stdout.write(alive?"alive":"dead")`;
  }
  async getProcessStatus(scope: SandboxScope, id: string, processId: string): Promise<SandboxCommandResult> {
    const names = await this.inspect(scope, id);
    if (!uuid(processId)) throw new SandboxProviderError("invalid_process", "Invalid process ID", 400);
    const marker = `/tmp/npati-process-${processId}`;
    const result = await this.docker(["exec", names.sandbox, "sh", "-c", `${this.processLock(marker)}
if [ -f ${marker}.pid ] && [ "$(node -e '${this.groupAliveScript()}' ${marker}.pid)" = alive ]; then echo running
elif [ -f ${marker}.exit ]; then cat ${marker}.exit
elif [ -f ${marker}.cancel ]; then echo stopped
elif [ -f ${marker}.claim ]; then echo unknown
else echo missing; fi`]);
    const value = text(result.stdout).trim();
    if (value === "missing") throw new SandboxProviderError("process_not_found", "Process handle is missing", 404);
    if (value === "unknown" || !/^(running|stopped|[0-9]+)$/.test(value)) throw new SandboxProviderError("process_outcome_unknown", "Producer outcome is unconfirmed", 409);
    const exitCode = /^\d+$/.test(value) ? Number(value) : null;
    const status = value === "running" ? "running" : value === "stopped" ? "stopped" : exitCode === 0 ? "completed" : exitCode === 124 ? "timed_out" : "failed";
    return { status, exitCode, stdout: "", stderr: "", durationMs: 0, step: status, tool: "project.terminal.process", retryable: false, processId };
  }
  async stopProcess(scope: SandboxScope, id: string, processId: string): Promise<SandboxCommandResult> {
    const names = await this.inspect(scope, id);
    if (!uuid(processId)) throw new SandboxProviderError("invalid_process", "Invalid process ID", 400);
    const marker = `/tmp/npati-process-${processId}`;
    await this.docker(["exec", names.sandbox, "sh", "-c", `${this.processLock(marker)}
touch ${marker}.cancel ${marker}.log
if [ ! -f ${marker}.exit ] && [ -f ${marker}.pid ]; then
 pid="$(cat ${marker}.pid)"; case "$pid" in ''|*[!0-9]*) exit 76;; esac
 /bin/kill -TERM "-$pid" 2>/dev/null || true
 sleep 0.1; /bin/kill -KILL "-$pid" 2>/dev/null || true
fi`]);
    // Never fabricate an exit code. A surviving group remains running and pins cleanup.
    let result = await this.getProcessStatus(scope, id, processId);
    for (let attempt = 0; result.status === "running" && attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = await this.getProcessStatus(scope, id, processId);
    }
    return result;
  }
}
