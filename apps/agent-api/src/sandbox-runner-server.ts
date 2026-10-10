import Fastify from "fastify";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DockerSandboxProvider, sandboxAllowedHostsWithProjectApi } from "./docker-sandbox-provider";
import { dockerFailure, runnerFailure } from "./sandbox-runner-diagnostics";
import { assertProjectRuntimeProvider, SandboxProviderError, type SandboxCreateOptions, type SandboxScope } from "./sandbox-provider";
import { InMemoryWorkspaceStore, PostgresWorkspaceStore } from "@npati/workspace";
import { resolveRunnerStore } from "./sandbox-runner-store";
import { SandboxImagePolicy, sandboxImagePolicyConfig, type SandboxImageAdmission } from "./sandbox-image-policy";
import { dockerEgressProbe, resolveEgressEnforcement } from "./sandbox-egress-enforcement";
import { resolveEgressAllowlist, toProxyAllowedHosts } from "./egress-allowlist";
import { RunnerMountGate, type MountedFolderAllowlistPort } from "./mounted-folder-gate";
import { mountedFolderRoots } from "./project-mount-policy";
import { authenticateRunnerRequest, createRunnerReadiness } from "./runner-readiness";
import { createReadinessNetwork, READINESS_EGRESS_SCOPE } from "./sandbox-readiness-network";
import { CosignImageSignatureVerifier } from "./sandbox-image-signature";
import {
  HostAdmissionController,
  SandboxCompanyQuota,
  resolveSandboxCompanyQuota,
  resolveSandboxResourceLimits,
  resolveHostAdmissionLimits,
  sandboxMemoryArg,
} from "./sandbox-resource-quota";

/**
 * C1b: the runner is where containers are actually created, so image admission is enforced here.
 *
 * With `DATABASE_URL` configured the runner reads the same catalogue (including revocations) as the
 * API. Without it the runner falls back to the declarative catalogue file and an in-memory store:
 * digests, signature, scan freshness and waivers are still enforced, but a revocation issued through
 * the API is only visible once the runner can reach the database — so a production runner must have
 * `DATABASE_URL` set.
 *
 * C15 adds the second reason the runner needs that database: the **mounted-folder allowlist**. The runner
 * re-reads the confirmed folder of a project from the same store, immediately before `docker create`, instead of
 * trusting the path an API sent — that read is what makes the TOCTOU re-validation an independent check rather
 * than a echo of the caller. Without a database the runner's store is the in-memory fallback, which cannot
 * contain an API-confirmed mount, so it mounts nothing (fail closed).
 *
 * G1 (item 4): resolving that store is `resolveRunnerStore`, which keeps the reason a failed migration
 * initialization gave (`runnerStoreResolution.failure`) instead of logging it once and carrying on with a store
 * that cannot answer. `imageAdmission` refuses with `runner_store_unavailable` while that reason is set, so no
 * container is created from a catalogue the runner cannot read.
 */
const runnerStoreResolution = resolveRunnerStore({
  databaseUrl: process.env.DATABASE_URL ?? process.env.NPATI_DATABASE_URL,
  createPostgresStore: (databaseUrl) => new PostgresWorkspaceStore(databaseUrl),
  createMemoryStore: () => new InMemoryWorkspaceStore(),
  report: (notice) => {
    const line = `[sandbox-image-policy] ${JSON.stringify(notice)}`;
    if (notice.event === "runner_store_unavailable") console.error(line);
    else console.warn(line);
  },
});
const runnerStore = runnerStoreResolution.then((resolution) => ({ store: resolution.store, database: resolution.database }));
async function createRunnerImagePolicy(): Promise<SandboxImagePolicy> {
  const config = sandboxImagePolicyConfig(process.env);
  const { store } = await runnerStore;
  return new SandboxImagePolicy(store, {
    ...config,
    verifier: config.signer?.identity && config.signer?.issuer ? new CosignImageSignatureVerifier() : undefined,
  });
}
const runnerImagePolicy = createRunnerImagePolicy();
const imageAdmission: SandboxImageAdmission = {
  admit: async (context, input) => {
    // G1 (item 4): fail closed. A store whose migration chain could not be initialized answers neither the
    // catalogue nor the revocation list, so admitting an image through it would be an admission decided by a
    // failure. The reason travels in the error, and `DockerSandboxProvider.admitImage` turns it into a structured
    // refusal carrying this code and this message.
    const resolution = await runnerStoreResolution;
    if (resolution.failure !== null) {
      throw new SandboxProviderError(
        "runner_store_unavailable",
        `Sandbox image admission is unavailable: the runner's workspace store could not be initialized (${resolution.failure})`,
        503,
        "image_admission",
      );
    }
    return (await runnerImagePolicy).admit(context, input);
  },
};

/**
 * C15: the runner's mount gate. It reads the allowlist **itself** (the store above, with no user context) and
 * re-runs the path validation immediately before the bind argument is built, so neither a path that changed
 * after the confirmation nor one a caller invented can reach a container. A mount is refused outright outside
 * `local` runner mode, where a host path the runner validates would not be the host path the daemon mounts.
 *
 * Deployment precondition, stated because it is real and not a detail: in local mode the runner must be able to
 * see the confirmed folder at the **same absolute path** the API recorded (the folder bound into the runner, or
 * the runner running on the host). The runner validates that path with `realpath`/`lstat`, and a path it cannot
 * resolve is a refusal (`mounted_folder_not_found`) — never an assumption that the daemon will find it.
 */
const runnerMountGate = new RunnerMountGate({
  allowlist: {
    getConfirmed: async (companyId, projectId) => {
      const { store } = await runnerStore;
      return store.getProjectMountedFolderForSystem(companyId, projectId).catch(() => null);
    },
  },
  roots: mountedFolderRoots(),
  protectedRoots: process.env.NPATI_DATA_DIR ? [path.resolve(process.env.NPATI_DATA_DIR)] : [],
  projectWorkspacesRoot: process.env.NPATI_PROJECT_WORKSPACE_ROOT ?? path.join(process.env.NPATI_DATA_DIR ?? ".data", "project-workspaces"),
  runnerMode: process.env.NPATI_SANDBOX_RUNNER_MODE,
});

assertProjectRuntimeProvider("isolated");
const secret = process.env.NPATI_SANDBOX_RUNNER_SECRET ?? "";
if (secret.length < 32 || !["local", "remote"].includes(process.env.NPATI_SANDBOX_RUNNER_MODE ?? "remote")) throw new Error("Sandbox runner requires a valid mode and 32-character secret");
if ((process.env.NPATI_SANDBOX_RUNNER_MODE ?? "remote") === "remote" && process.env.NPATI_SANDBOX_RUNNER_ISOLATED_HOST !== "true") throw new Error("Remote sandbox runner requires an isolated host");
/**
 * C4b: enforcement readiness. `NPATI_SANDBOX_EGRESS_ENFORCED` is advisory only — the provider asks this
 * object, which actually probes the freshly created run network (proxy health, no direct egress, no
 * DNS bypass) and caches the verdict for a short TTL.
 */
const dockerExec = promisify(execFile);
const dockerCommand = async (commandArgs: string[], timeoutMs = 30_000): Promise<{ ok: boolean; output: string }> =>
  dockerExec("docker", commandArgs, { timeout: timeoutMs, maxBuffer: 256_000 })
    .then(({ stdout, stderr }) => ({ ok: true, output: `${stdout}${stderr}`.trim() }))
    .catch((error: NodeJS.ErrnoException & { stderr?: string; stdout?: string }) => ({ ok: false, output: `${error.stdout ?? ""}${error.stderr ?? error.message ?? ""}`.trim() }));

const egressEnforcement = resolveEgressEnforcement(process.env, {
  probe: dockerEgressProbe({
    docker: dockerCommand,
    sandboxImage: process.env.NPATI_SANDBOX_IMAGE ?? "npati/project-sandbox:local",
  }),
  log: (event, details) => console.warn(`[sandbox-runner] ${event} ${JSON.stringify(details)}`),
});

/** C4b: readiness facts served to the API (see `runner-readiness.ts`). */
const readinessEnforcement = resolveEgressEnforcement(process.env, {
  probe: dockerEgressProbe({docker:dockerCommand,sandboxImage:process.env.NPATI_SANDBOX_IMAGE ?? "npati/project-sandbox:local"}),
  log:(event,details)=>console.warn(`[sandbox-runner] ${event} ${JSON.stringify(details)}`),
});
readinessEnforcement.scope = READINESS_EGRESS_SCOPE;
const runnerReadiness = createRunnerReadiness({
  docker: dockerCommand,
  enforcement: readinessEnforcement,
  prepareEgress: createReadinessNetwork({docker:dockerCommand,image:process.env.NPATI_SANDBOX_EGRESS_IMAGE ?? "npati/sandbox-egress:local",allowedHosts:sandboxAllowedHostsWithProjectApi(process.env.NPATI_SANDBOX_ALLOWED_HOSTS ?? toProxyAllowedHosts(resolveEgressAllowlist({env:process.env})),process.env.NPATI_PROJECT_API_PUBLIC_URL)}),
  images: {
    sandbox: process.env.NPATI_SANDBOX_IMAGE ?? "npati/project-sandbox:local",
    egressProxy: process.env.NPATI_SANDBOX_EGRESS_IMAGE ?? "npati/sandbox-egress:local",
  },
  ttlMs: Number(process.env.NPATI_SANDBOX_RUNNER_READINESS_TTL_MS) || undefined,
});

/**
 * R1 (section A, item 4): the deployment's sandbox resource settings, resolved **once** here so the container
 * flags, the aggregate Company quota and the boot log all describe the same numbers.
 */
const sandboxResourceLimits = resolveSandboxResourceLimits(process.env);
const sandboxCompanyQuota = new SandboxCompanyQuota(resolveSandboxCompanyQuota(process.env), sandboxResourceLimits);
const hostAdmission = new HostAdmissionController({ limits: resolveHostAdmissionLimits(process.env) });
console.info("[sandbox-quota] " + JSON.stringify({
  resourceLimits: sandboxResourceLimits,
  companyQuota: sandboxCompanyQuota.config,
  hostAdmission: hostAdmission.limits,
}));

const provider = new DockerSandboxProvider({
  image: process.env.NPATI_SANDBOX_IMAGE ?? "npati/project-sandbox:local",
  proxyImage: process.env.NPATI_SANDBOX_EGRESS_IMAGE ?? "npati/sandbox-egress:local",
  // R1 (section A, item 4): the R1 start values, and they are now *settings* rather than an undocumented
  // override — the former 1 vCPU / 1536m / 1536 MiB / 128 pids defaults are recorded in
  // `docs/coding-agent/security-gate-report.md` § R1-A. `NPATI_SANDBOX_MEMORY_MB` wins over the Docker-string
  // form so one number can drive both the flag and the aggregate Company quota.
  cpu: process.env.NPATI_SANDBOX_CPU ?? String(sandboxResourceLimits.cpu),
  memory: process.env.NPATI_SANDBOX_MEMORY ?? sandboxMemoryArg(sandboxResourceLimits.memoryMb),
  diskBytes: Number(process.env.NPATI_SANDBOX_DISK_BYTES) || sandboxResourceLimits.diskBytes,
  pids: Number(process.env.NPATI_SANDBOX_PIDS) || sandboxResourceLimits.pids,
  maxFiles: Number(process.env.NPATI_SANDBOX_SYNC_MAX_FILES) || 500,
  maxBytes: Number(process.env.NPATI_SANDBOX_SYNC_MAX_BYTES) || 20_000_000,
  // C4b: the effective allowlist comes from the canonical allowlist module — the approved install
  // registries plus an EMPTY run set (deny all) — and `NPATI_SANDBOX_ALLOWED_HOSTS` stays the operator
  // override. Git hosts and vendor mirrors are never implicit defaults.
  allowedHosts: sandboxAllowedHostsWithProjectApi(
    process.env.NPATI_SANDBOX_ALLOWED_HOSTS ?? toProxyAllowedHosts(resolveEgressAllowlist({ env: process.env })),
    process.env.NPATI_PROJECT_API_PUBLIC_URL),
}, imageAdmission, egressEnforcement, runnerMountGate, sandboxCompanyQuota, hostAdmission);
const runnerPreflight = async (): Promise<void> => {
  const socketPresent = await stat("/var/run/docker.sock").then((value) => value.isSocket()).catch(() => false);
  const check = async (args: string[]) => dockerExec("docker", args, { timeout: 10_000, maxBuffer: 64_000 }).then(({ stdout }) => ({ ok: true, output: stdout.trim() })).catch((error: NodeJS.ErrnoException & { stderr?: string }) => ({ ok: false, code: dockerFailure(args.slice(0, 2).join("."), error.stderr ?? error.message ?? "", false, error.code).code, output: "" }));
  const [version, info, projectImage, egressImage, networks] = await Promise.all([
    check(["version", "--format", "{{.Server.Version}}"]),
    check(["info", "--format", "{{.ServerVersion}}"]),
    check(["image", "inspect", process.env.NPATI_SANDBOX_IMAGE ?? "npati/project-sandbox:local", "--format", "{{.Id}}"]),
    check(["image", "inspect", process.env.NPATI_SANDBOX_EGRESS_IMAGE ?? "npati/sandbox-egress:local", "--format", "{{.Id}}"]),
    check(["network", "ls", "--format", "{{.Name}}"]),
  ]);
  console.info("[sandbox-runner-preflight] " + JSON.stringify({ socketPresent, dockerVersion: version.ok ? version.output : null, dockerInfo: info.ok ? info.output : null, dockerErrorCode: "code" in version ? version.code : "code" in info ? info.code : null, images: [{ name: process.env.NPATI_SANDBOX_IMAGE ?? "npati/project-sandbox:local", present: projectImage.ok }, { name: process.env.NPATI_SANDBOX_EGRESS_IMAGE ?? "npati/sandbox-egress:local", present: egressImage.ok }], controlNetworkPresent: networks.ok && networks.output.split("\n").some((name) => name.endsWith("npati-sandbox-control")), runtimeNetworks: networks.ok ? networks.output.split("\n").filter((name) => name.startsWith("npati-net-")).length : null }));
}
void runnerPreflight().catch(() => console.error("[sandbox-runner-preflight] failed"));
const resourceNames = (id: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? { container: `npati-sb-${id}`, network: `npati-net-${id}` } : { container: null, network: null };
const app = Fastify({ bodyLimit: 25_000_000, logger: false });
const seen = new Map<string, number>();
app.get("/health", async () => ({ status: "ok" }));
app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));
/**
 * C4b (owner decision): the runner is the authoritative component for network enforcement, so it exposes
 * the readiness facts to the API through the same HMAC authentication as every other endpoint. Each fact
 * is reported separately, and `required_images_ready` is checked here because only this process has docker.
 */
app.post<{ Body: string }>("/v1/readiness", async (request, reply) => {
  const auth = authenticateRunnerRequest({ headers: request.headers, body: request.body ?? "", secret, seen });
  if (!auth.ok) return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
  const report = await runnerReadiness.collect();
  return { ...report, details: { ...report.details, runtimeMode: "isolated" } };
});
app.post<{ Body: string }>("/v1/sandbox", async (request, reply) => {
  const auth = authenticateRunnerRequest({ headers: request.headers, body: request.body ?? "", secret, seen });
  if (!auth.ok) return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
  let operation = "unknown", scope: SandboxScope | undefined, sandboxId = "";
  try {
    const parsed = JSON.parse(request.body) as { operation: string; payload: Record<string, unknown> };
    operation = String(parsed.operation ?? "unknown");
    const p = parsed.payload ?? {};
    scope = p.scope as SandboxScope;
    if (!scope?.workspaceId || !scope.userId || !scope.companyId || !scope.projectId) throw new SandboxProviderError("invalid_scope", "Sandbox scope is incomplete", 400);
    const requestScope = scope;
    const id = String(p.sandboxId ?? "");
    sandboxId = id;
    let result: unknown;
    switch (operation) {
      case "processCapabilities": result = await provider.processCapabilities?.(requestScope) ?? { durableIdentity: false, terminalStatus: false }; break;
      case "createSandbox": result = await provider.createSandbox(requestScope, p.options as SandboxCreateOptions | undefined); break;
      case "startSandbox": result = await provider.startSandbox(requestScope, id); break;
      case "stopSandbox": result = await provider.stopSandbox(requestScope, id); break;
      case "destroySandbox": result = await provider.destroySandbox(requestScope, id); break;
      case "executeCommand": result = await provider.executeCommand(requestScope, id, String(p.command ?? ""), p.options as any); break;
      case "uploadFiles": result = await provider.uploadFiles(requestScope, id, p.files as any); break;
      case "downloadFiles": result = await provider.downloadFiles(requestScope, id); break;
      case "exposePort": result = await provider.exposePort(requestScope, id, Number(p.port)); break;
      case "getLogs": result = await provider.getLogs(requestScope, id, p.processId as string | undefined); break;
      case "getStatus": result = await provider.getStatus(requestScope, id); break;
      case "startProcess": result = await provider.startProcess(requestScope, id, String(p.command ?? ""), p.options as any); break;
      case "stopProcess": result = await provider.stopProcess(requestScope, id, String(p.processId ?? "")); break;
      case "getProcessOutput": if (!provider.getProcessOutput) throw new SandboxProviderError("process_output_unavailable", "Bounded process output is unavailable", 503); result = await provider.getProcessOutput(requestScope, id, String(p.processId ?? "")); break;
      case "getProcessStatus": result = await provider.getProcessStatus(requestScope, id, String(p.processId ?? "")); break;
      case "inspectBrowser": result = await provider.inspectBrowser(requestScope, id, p.options as any); break;
      case "proxyPreview": result = await provider.proxyPreview(requestScope, id, p.options as any); break;
      default: throw new SandboxProviderError("invalid_operation", "Unknown sandbox operation", 400);
    }
    if (operation === "createSandbox" && result && typeof result === "object" && "id" in result) sandboxId = String(result.id);
    const resources = resourceNames(sandboxId);
    console.info("[sandbox-runner] " + JSON.stringify({ operation, projectId: scope?.projectId ?? null, sandboxId: sandboxId || null, image: operation === "createSandbox" ? process.env.NPATI_SANDBOX_IMAGE ?? "npati/project-sandbox:local" : null, container: resources.container, network: resources.network, status: "ok", httpStatus: 200, errorCode: null, errorMessage: null, dockerStderr: null }));
    return { result: result ?? null };
  } catch (error) {
    if (!(error instanceof SandboxProviderError) && error instanceof Error) {
      console.error(`[sandbox-runner] underlying error during ${operation}:`, error.stack || error.message);
    }
    const known = runnerFailure(error, operation);
    const d = known.diagnostics;
    const resources = resourceNames(d?.sandboxId ?? sandboxId);
    console.error("[sandbox-runner] " + JSON.stringify({ operation, projectId: scope?.projectId ?? null, sandboxId: d?.sandboxId ?? (sandboxId || null), image: d?.image ?? null, container: d?.container ?? resources.container, network: d?.network ?? resources.network, status: "error", httpStatus: known.status, errorCode: known.code, errorMessage: known.message, dockerAction: d?.dockerAction ?? null, dockerStderr: d?.dockerStderr ?? null }));
    return reply.code(known.status).send({ error: { code: known.code, message: known.message, retryable: known.retryable, operation } });
  }
});
app.listen({ host: "0.0.0.0", port: Number(process.env.NPATI_SANDBOX_RUNNER_PORT) || 7865 }).catch(() => process.exit(1));
