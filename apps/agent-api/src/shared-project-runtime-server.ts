import Fastify from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SharedProjectRuntimeProvider } from "./shared-project-runtime-provider";
import { authenticateRunnerRequest } from "./runner-readiness";
import { assertProjectRuntimeProvider, SandboxProviderError, type SandboxScope, type SandboxCreateOptions, type SandboxCommandOptions, type SandboxFile, type PreviewProxyRequest } from "./sandbox-provider";
import { runnerFailure } from "./sandbox-runner-diagnostics";

const secret = process.env.NPATI_SANDBOX_RUNNER_SECRET ?? "";
assertProjectRuntimeProvider("shared");
if (secret.length < 32 || process.env.NPATI_SANDBOX_RUNNER_MODE !== "local") throw new Error("Shared runtime requires local self-hosted mode and a 32-character runner secret");
const provider = new SharedProjectRuntimeProvider();
const seen = new Map<string, number>();
const app = Fastify({ bodyLimit: 25_000_000, logger: false });
app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));
const execute = promisify(execFile);
async function readiness() {
  const reasons: string[] = [];
  const isolation = await execute("/usr/local/bin/npati-project-exec", ["--check"]).then(result => result.stdout.trim()).catch(() => { reasons.push("project_isolation_unavailable"); return null; });
  const proxy = await fetch("http://127.0.0.1:8080/health", { signal: AbortSignal.timeout(3000) }).then(response => response.ok).catch(() => false);
  if (!proxy) reasons.push("egress_proxy_unavailable");
  const firewalls = await Promise.all(["iptables", "ip6tables"].map(program => execute(program, ["-C", "OUTPUT", "-m", "owner", "--uid-owner", "10000-60000", "-j", "NPATI_PROJECTS"]).then(() => true).catch(() => false)));
  const network = firewalls.every(Boolean);
  if (!network) reasons.push("network_policy_unavailable");
  return { docker_ready: true, required_images_ready: true, egress_proxy_ready: proxy, network_policy_ready: network, dns_policy_ready: network,
    overall_ready: Boolean(isolation) && proxy && network, reasons, details: { runtimeMode: "shared", dockerRequired: false, isolation, projectRoot: "/projects" }, checkedAt: Date.now() };
}
app.get("/health", async (_request, reply) => { const report = await readiness(); return reply.code(report.overall_ready ? 200 : 503).send(report); });
app.post<{ Body: string }>("/v1/readiness", async (request, reply) => {
  const auth = authenticateRunnerRequest({ headers: request.headers, body: request.body ?? "", secret, seen });
  if (!auth.ok) return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
  return readiness();
});
app.post<{ Body: string }>("/v1/sandbox", async (request, reply) => {
  const auth = authenticateRunnerRequest({ headers: request.headers, body: request.body ?? "", secret, seen });
  if (!auth.ok) return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
  let operation = "unknown", scope: SandboxScope | undefined;
  try {
    const parsed = JSON.parse(request.body) as { operation: string; payload: Record<string, unknown> };
    operation = parsed.operation;
    const p = parsed.payload ?? {}; scope = p.scope as SandboxScope;
    if (!scope?.workspaceId || !scope.userId || !scope.companyId || !scope.projectId) throw new SandboxProviderError("invalid_scope", "Project context is incomplete", 400);
    const id = String(p.sandboxId ?? "");
    let result: unknown;
    switch (operation) {
      case "createSandbox": result = await provider.createSandbox(scope, p.options as SandboxCreateOptions); break;
      case "processCapabilities": result = await provider.processCapabilities(); break;
      case "getStatus": result = await provider.getStatus(scope, id); break;
      case "startSandbox": result = await provider.startSandbox(scope, id); break;
      case "stopSandbox": result = await provider.stopSandbox(scope, id); break;
      case "destroySandbox": result = await provider.destroySandbox(scope, id); break;
      case "uploadFiles": result = await provider.uploadFiles(scope, id, p.files as SandboxFile[]); break;
      case "downloadFiles": result = await provider.downloadFiles(scope, id); break;
      case "executeCommand": result = await provider.executeCommand(scope, id, String(p.command ?? ""), p.options as SandboxCommandOptions); break;
      case "startProcess": result = await provider.startProcess(scope, id, String(p.command ?? ""), p.options as SandboxCommandOptions); break;
      case "stopProcess": result = await provider.stopProcess(scope, id, String(p.processId ?? "")); break;
      case "getProcessStatus": result = await provider.getProcessStatus(scope, id, String(p.processId ?? "")); break;
      case "getLogs": result = await provider.getLogs(scope, id, p.processId as string | undefined); break;
      case "getProcessOutput": result = await provider.getProcessOutput(scope, id, String(p.processId ?? "")); break;
      case "exposePort": result = await provider.exposePort(scope, id, Number(p.port)); break;
      case "proxyPreview": result = await provider.proxyPreview(scope, id, p.options as PreviewProxyRequest); break;
      default: throw new SandboxProviderError("invalid_operation", "Operation is unavailable in shared runtime", 400);
    }
    console.info("[project-runtime] " + JSON.stringify({ operation, projectId: scope.projectId, status: "ok" }));
    return { result: result ?? null };
  } catch (error) {
    const known = runnerFailure(error, operation);
    console.error("[project-runtime] " + JSON.stringify({ operation, projectId: scope?.projectId, errorCode: known.code }));
    return reply.code(known.status).send({ error: { code: known.code, message: known.message, retryable: known.retryable, operation } });
  }
});
app.listen({ host: "0.0.0.0", port: 7865 }).catch(() => process.exit(1));
