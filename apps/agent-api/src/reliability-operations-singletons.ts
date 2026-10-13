import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthProvider } from "./auth";
import { AuthenticationError } from "./auth";
import { CacheManagementService, OutputStyleModifier, CompressionEvalHarness } from "./output-styles-eval-and-cache";
import { SemanticCache } from "./semantic-cache";
import { DatabaseBackupManager, SessionSearchEngine } from "./telemetry-backups-and-session-search";
import { AdaptiveAdmissionQueue, AdmissionError } from "./resilience-admission-queue";
import { QuotaShareRouter } from "./routing-transparency-and-dedup";
import { AtomicRpmLeaseManager } from "./atomic-rpm-rolling-leases";
import { GroupSessionManager } from "./group-sessions";
import { SessionToolRegistry } from "./session-tools";
import { ToolPolicyEngine } from "./tool-policy-engine";

// Shared singletons for production runtime operational components
export const globalCacheService = new CacheManagementService();
export const globalSemanticCache = new SemanticCache<string>(3600_000, 1000);
export const globalBackupManager = new DatabaseBackupManager();
export const globalSessionSearch = new SessionSearchEngine();
export const globalAdmissionQueue = new AdaptiveAdmissionQueue({
  maxConcurrent: Number.parseInt(process.env.NPATI_ADMISSION_MAX_CONCURRENT ?? "20", 10),
  maxConcurrentPerTenant: Number.parseInt(process.env.NPATI_ADMISSION_MAX_CONCURRENT_PER_TENANT ?? "10", 10),
  maxQueueLength: Number.parseInt(process.env.NPATI_ADMISSION_MAX_QUEUE_LENGTH ?? "200", 10),
  freeShedThreshold: Number.parseFloat(process.env.NPATI_ADMISSION_FREE_SHED_THRESHOLD ?? "0.75"),
});
export const globalQuotaRouter = new QuotaShareRouter();
export const globalLeaseManager = new AtomicRpmLeaseManager(60_000);
export const globalGroupSessions = new GroupSessionManager();
export const globalToolPolicyEngine = new ToolPolicyEngine([
  { id: "deny-dangerous", effect: "deny", toolPattern: "dangerous.*", reason: "Dangerous system tools are restricted" },
  { id: "deny-rm", effect: "deny", toolPattern: "fs.delete.*", reason: "Destructive file operations are restricted" },
]);
export const globalSessionTools = new SessionToolRegistry(globalToolPolicyEngine);

export async function authorize(auth: AuthProvider, request: FastifyRequest, permission = "chat:use") {
  const scope = await auth.authenticate(request);
  if (!scope.permissions.some((p) => p === permission)) {
    throw new AuthenticationError(`Missing permission: ${permission}`, 403, "FORBIDDEN");
  }
  return scope;
}

export function sendError(reply: FastifyReply, error: unknown, defaultStatus = 400) {
  if (error instanceof AuthenticationError) {
    return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof AdmissionError) {
    if (error.retryAfterMs > 0) reply.header("retry-after", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
    return reply.code(error.code === "ADMISSION_CANCELLED" ? 499 : 429).send({ error: { code: error.code, message: error.message } });
  }
  const err = error && typeof error === "object" ? (error as { status?: number; code?: string }) : undefined;
  const status = Number(err?.status ?? defaultStatus);
  return reply.code(status).send({
    error: {
      code: err?.code ?? "OPERATION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}
