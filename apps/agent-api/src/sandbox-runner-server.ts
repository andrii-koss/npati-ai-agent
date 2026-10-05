import Fastify from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { DockerSandboxProvider, sandboxAllowedHostsWithProjectApi } from "./docker-sandbox-provider";
import { dockerFailure } from "./sandbox-runner-diagnostics";
import { SandboxProviderError, type SandboxScope } from "./sandbox-provider";

const secret = process.env.NPATI_SANDBOX_RUNNER_SECRET ?? "";
if (secret.length < 32 || !["local", "remote"].includes(process.env.NPATI_SANDBOX_RUNNER_MODE ?? "remote")) throw new Error("Sandbox runner requires a valid mode and 32-character secret");
if ((process.env.NPATI_SANDBOX_RUNNER_MODE ?? "remote") === "remote" && process.env.NPATI_SANDBOX_RUNNER_ISOLATED_HOST !== "true") throw new Error("Remote sandbox runner requires an isolated host");
const provider = new DockerSandboxProvider({
  image: process.env.NPATI_SANDBOX_IMAGE ?? "npati/project-sandbox:local",
  proxyImage: process.env.NPATI_SANDBOX_EGRESS_IMAGE ?? "npati/sandbox-egress:local",
  cpu: process.env.NPATI_SANDBOX_CPU ?? "1",
  memory: process.env.NPATI_SANDBOX_MEMORY ?? "1536m",
  diskBytes: Number(process.env.NPATI_SANDBOX_DISK_BYTES) || 1536 * 1024 * 1024,
  pids: Number(process.env.NPATI_SANDBOX_PIDS) || 128,
  maxFiles: Number(process.env.NPATI_SANDBOX_SYNC_MAX_FILES) || 500,
  maxBytes: Number(process.env.NPATI_SANDBOX_SYNC_MAX_BYTES) || 20_000_000,
  allowedHosts: sandboxAllowedHostsWithProjectApi(process.env.NPATI_SANDBOX_ALLOWED_HOSTS ?? "registry.npmjs.org,registry.yarnpkg.com,pypi.org,files.pythonhosted.org,repo.packagist.org,packagist.org,github.com,codeload.github.com,api.github.com,objects.githubusercontent.com", process.env.NPATI_PROJECT_API_PUBLIC_URL),
});
const dockerExec = promisify(execFile);
async function runnerPreflight(): Promise<void> {
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
app.post<{ Body: string }>("/v1/sandbox", async (request, reply) => {
  const timestamp = String(request.headers["x-npati-timestamp"] ?? "");
  const nonce = String(request.headers["x-npati-nonce"] ?? "");
  const signature = String(request.headers["x-npati-signature"] ?? "");
  const now = Date.now(), time = Number(timestamp);
  if (!Number.isSafeInteger(time) || Math.abs(now - time) > 30_000 || !/^[0-9a-f-]{36}$/i.test(nonce) || !/^[0-9a-f]{64}$/i.test(signature) || seen.has(nonce)) return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid runner authentication" } });
  const expected = createHmac("sha256", secret).update(`${timestamp}.${nonce}.${request.body}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid runner authentication" } });
  seen.set(nonce, now);
  for (const [key, value] of seen) if (now - value > 60_000) seen.delete(key);
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
      case "createSandbox": result = await provider.createSandbox(requestScope); break;
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
    const systemCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const known = error instanceof SandboxProviderError ? error : systemCode === "EACCES" || systemCode === "EPERM" ? new SandboxProviderError("sandbox_workspace_permission_denied", "Sandbox workspace is not writable", 503) : systemCode === "ENOSPC" ? new SandboxProviderError("sandbox_storage_full", "Sandbox storage is full", 503) : new SandboxProviderError("runner_failure", `Sandbox runner ${operation} failed`, 503);
    const d = known.diagnostics;
    const resources = resourceNames(d?.sandboxId ?? sandboxId);
    console.error("[sandbox-runner] " + JSON.stringify({ operation, projectId: scope?.projectId ?? null, sandboxId: d?.sandboxId ?? (sandboxId || null), image: d?.image ?? null, container: d?.container ?? resources.container, network: d?.network ?? resources.network, status: "error", httpStatus: known.status, errorCode: known.code, errorMessage: known.message, dockerAction: d?.dockerAction ?? null, dockerStderr: d?.dockerStderr ?? null }));
    return reply.code(known.status).send({ error: { code: known.code, message: known.message, retryable: known.retryable, operation } });
  }
});
app.listen({ host: "0.0.0.0", port: Number(process.env.NPATI_SANDBOX_RUNNER_PORT) || 7865 }).catch(() => process.exit(1));
