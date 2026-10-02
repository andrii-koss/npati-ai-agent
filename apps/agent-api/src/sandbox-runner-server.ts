import Fastify from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { DockerSandboxProvider } from "./docker-sandbox-provider";
import { SandboxProviderError, type SandboxScope } from "./sandbox-provider";

const secret = process.env.NPATI_SANDBOX_RUNNER_SECRET ?? "";
if (secret.length < 32 || process.env.NPATI_SANDBOX_RUNNER_ISOLATED_HOST !== "true") throw new Error("Sandbox runner requires a dedicated host and 32-character secret");
const provider = new DockerSandboxProvider({
  image: process.env.NPATI_SANDBOX_IMAGE ?? "npati/project-sandbox:local",
  proxyImage: process.env.NPATI_SANDBOX_EGRESS_IMAGE ?? "npati/sandbox-egress:local",
  cpu: process.env.NPATI_SANDBOX_CPU ?? "1",
  memory: process.env.NPATI_SANDBOX_MEMORY ?? "1024m",
  diskBytes: Number(process.env.NPATI_SANDBOX_DISK_BYTES) || 512 * 1024 * 1024,
  pids: Number(process.env.NPATI_SANDBOX_PIDS) || 128,
  maxFiles: Number(process.env.NPATI_SANDBOX_SYNC_MAX_FILES) || 500,
  maxBytes: Number(process.env.NPATI_SANDBOX_SYNC_MAX_BYTES) || 20_000_000,
  allowedHosts: process.env.NPATI_SANDBOX_ALLOWED_HOSTS ?? "registry.npmjs.org,registry.yarnpkg.com,pypi.org,files.pythonhosted.org,repo.packagist.org,packagist.org,github.com,codeload.github.com,api.github.com,objects.githubusercontent.com",
});
const app = Fastify({ bodyLimit: 25_000_000, logger: false });
const seen = new Map<string, number>();
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
  try {
    const parsed = JSON.parse(request.body) as { operation: string; payload: Record<string, unknown> };
    const p = parsed.payload ?? {};
    const scope = p.scope as SandboxScope;
    const id = String(p.sandboxId ?? "");
    let result: unknown;
    switch (parsed.operation) {
      case "createSandbox": result = await provider.createSandbox(scope); break;
      case "startSandbox": result = await provider.startSandbox(scope, id); break;
      case "stopSandbox": result = await provider.stopSandbox(scope, id); break;
      case "destroySandbox": result = await provider.destroySandbox(scope, id); break;
      case "executeCommand": result = await provider.executeCommand(scope, id, String(p.command ?? ""), p.options as any); break;
      case "uploadFiles": result = await provider.uploadFiles(scope, id, p.files as any); break;
      case "downloadFiles": result = await provider.downloadFiles(scope, id); break;
      case "exposePort": result = await provider.exposePort(scope, id, Number(p.port)); break;
      case "getLogs": result = await provider.getLogs(scope, id, p.processId as string | undefined); break;
      case "getStatus": result = await provider.getStatus(scope, id); break;
      case "startProcess": result = await provider.startProcess(scope, id, String(p.command ?? ""), p.options as any); break;
      case "stopProcess": result = await provider.stopProcess(scope, id, String(p.processId ?? "")); break;
      case "getProcessStatus": result = await provider.getProcessStatus(scope, id, String(p.processId ?? "")); break;
      default: throw new SandboxProviderError("invalid_operation", "Unknown sandbox operation", 400);
    }
    return { result: result ?? null };
  } catch (error) {
    const known = error instanceof SandboxProviderError ? error : new SandboxProviderError("runner_failure", "Sandbox runner operation failed", 503);
    return reply.code(known.status).send({ error: { code: known.code, message: known.message, retryable: known.retryable } });
  }
});
app.listen({ host: "0.0.0.0", port: Number(process.env.NPATI_SANDBOX_RUNNER_PORT) || 7865 }).catch(() => process.exit(1));