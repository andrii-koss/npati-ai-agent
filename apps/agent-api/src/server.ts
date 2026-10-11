import { logBuildInfo } from "./build-info";
import { buildApp } from "./app";
import { resolveCodeAgentLimits } from "./code-agent-config";
import { MinioObjectStorage } from "./object-storage";

const minioEndpoint = process.env.MINIO_ENDPOINT;
const minioAccessKey = process.env.MINIO_ACCESS_KEY;
const minioSecretKey = process.env.MINIO_SECRET_KEY;
const objectStorage = minioEndpoint && minioAccessKey && minioSecretKey ? new MinioObjectStorage({
  endPoint: minioEndpoint,
  port: Number.parseInt(process.env.MINIO_PORT ?? "9000", 10),
  useSSL: process.env.MINIO_USE_SSL === "true",
  accessKey: minioAccessKey,
  secretKey: minioSecretKey,
  region: process.env.MINIO_REGION ?? "us-east-1",
  operationTimeoutMs: Number.parseInt(process.env.MINIO_OPERATION_TIMEOUT_MS ?? "15000",10),
  streamIdleTimeoutMs: Number.parseInt(process.env.MINIO_STREAM_IDLE_TIMEOUT_MS ?? "30000",10),
  streamTotalTimeoutMs: Number.parseInt(process.env.MINIO_STREAM_TOTAL_TIMEOUT_MS ?? "300000",10),
}) : undefined;

const port = Number.parseInt(process.env.NPATI_AGENT_API_PORT ?? "3001", 10);
const app = buildApp({
  webDistDirectory: process.env.NPATI_WEB_DIST_DIR,
  webOrigin: process.env.NPATI_WEB_ORIGIN,
  omnirouteBaseUrl: process.env.OMNIROUTE_BASE_URL,
  omnirouteApiKey: process.env.OMNIROUTE_API_KEY,
  omnirouteManagementPassword: process.env.OMNIROUTE_MANAGEMENT_PASSWORD,
  omnirouteTranscriptionModel: process.env.OMNIROUTE_TRANSCRIPTION_MODEL,
  omnirouteTtsModel: process.env.OMNIROUTE_TTS_MODEL,
  omnirouteEmbeddingModel: process.env.OMNIROUTE_EMBEDDING_MODEL,
  omnirouteRerankModel: process.env.OMNIROUTE_RERANK_MODEL,
  omnirouteVisionModel: process.env.OMNIROUTE_VISION_MODEL,
  dataDirectory: process.env.NPATI_DATA_DIR,
  projectWorkspaceRoot: process.env.NPATI_PROJECT_WORKSPACE_ROOT,
  // C1: Coding Agent limits come from configuration (env-overridable), never from literals.
  codeAgentLimits: resolveCodeAgentLimits(),
  hubBaseUrl: process.env.NPATI_HUB_BASE_URL,
  hubApiKey: process.env.NPATI_HUB_API_KEY,
  npatiBackendUrl: process.env.NPATI_BACKEND_URL ?? process.env.NPATI_HUB_BASE_URL,
  npatiJwtSecret: process.env.NPATI_JWT_SECRET ?? process.env.JWT_SECRET,
  strictAuth: process.env.NPATI_AUTH_STRICT !== "false",
  agentPublicDomain: process.env.NPATI_AGENT_PUBLIC_DOMAIN ?? process.env.NPATI_WEB_ORIGIN,
  messagingWebhookBaseUrl: process.env.NPATI_MESSAGING_WEBHOOK_BASE_URL,
  agentVersion: process.env.NPATI_AGENT_VERSION ?? process.env.npm_package_version ?? "0.1.0",
  deploymentType: process.env.NPATI_DEPLOYMENT_TYPE === "npati_hosted" ? "npati_hosted" : "self_hosted",
  hostedRegistrationToken: process.env.NPATI_HOSTED_REGISTRATION_TOKEN,
  allowLegacyPasswordAuth: process.env.NPATI_ALLOW_LEGACY_PASSWORD_AUTH === "true",
  databaseUrl: process.env.DATABASE_URL,
  crawlerBaseUrl: process.env.CRAWL4AI_BASE_URL,
  companyRunTimeoutMs: Number.parseInt(process.env.NPATI_COMPANY_RUN_TIMEOUT_MS ?? '120000', 10),
  redisUrl: process.env.REDIS_URL,
  browserUseWorkerUrl: process.env.BROWSER_USE_WORKER_URL,
  browserUseInternalToken: process.env.NPATI_BROWSER_INTERNAL_TOKEN,
  objectStorage,
  storageReconcilerOptions: {
    intervalMs: Number.parseInt(process.env.NPATI_STORAGE_RECONCILE_INTERVAL_MS ?? "21600000",10),
    orphanGraceMs: Number.parseInt(process.env.NPATI_STORAGE_ORPHAN_GRACE_MS ?? "86400000",10),
    leaseMs: Number.parseInt(process.env.NPATI_STORAGE_RECONCILE_LEASE_MS ?? "1800000",10),
    pageSize: Number.parseInt(process.env.NPATI_STORAGE_RECONCILE_PAGE_SIZE ?? "250",10),
  },
});

logBuildInfo("agent-api");
try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
