/* Core platform services, extracted from app.ts (step 2b of docs/refactoring/PLAN.md).
 *
 * Web research and the marketplace, the project-document store, object storage, files,
 * authentication, preferences, memory engines and the guardrail/approval repositories.
 *
 * The code is moved verbatim: the only edit is `app.log`, which became the `log` parameter.
 * `baseAiEngine` and `aiEngine` are inputs because the C5b provider-data guard that builds
 * them owns mutable state assigned later in buildApp, so it stays in app.ts.
 */
import type { AppConfig } from "./app";
import { ActiveContextResolver } from "./active-context-resolver";
import { AIPreferencesStore } from "./ai-preferences";
import { CodePreferencesStore } from "./code-preferences";
import { ApiKeysRepository } from "./api-keys-repository";
import { NpatiBackendAuthProvider } from "./auth";
import { defaultCoreBackendHealthCheck } from "./backend-health-probe";
import { ChatFileService } from "./chat-file-service";
import { CompanyKnowledgeRepository } from "./company-knowledge";
import { InMemoryFileMetadataRepository, PostgresFileMetadataRepository } from "./file-metadata";
import { GuardrailPolicyRepository } from "./guardrail-policy-repository";
import { InstallationAuthStore } from "./installation-auth";
import { ProductionMemoryEngineRegistry, QdrantMemoryEngineAdapter, SqliteFts5MemoryEngine } from "./knowledge-memory-engine";
import { MemoryDocumentService } from "./memory-documents";
import { InMemoryObjectStorage } from "./object-storage";
import { assertOutboundAllowed } from "./outbound-exfiltration-guard";
import { ProductionQdrantClient } from "./qdrant-client";
import { ScopedMemoryEngine } from "./scoped-memory";
import { webResearchUrlValidator } from "./ssrf-url-validator";
import { InMemoryStorageProtection, RedisStorageProtection } from "./storage-protection";
import { StorageReconciler } from "./storage-reconciler";
import { NpatiAgent } from "@npati/agent";
import { createHubClient, createNpatiAuthClient } from "@npati/hub-connector";
import { InMemoryProvider } from "@npati/memory";
import { OmniRouteEngine, OmniRouteMarketplace, type AIEngine } from "@npati/omniroute-adapter";
import { ServiceHealth } from "@npati/shared";
import { createWebResearch } from "@npati/web-research";
import { AuthContext, InMemoryWorkspaceStore, PostgresWorkspaceStore, WorkspaceStore } from "@npati/workspace";
import path from "node:path";

/** The pino-compatible slice of Fastify's logger that this domain uses. */
export interface CoreLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface CoreServicesInput {
  config: AppConfig;
  log: CoreLogger;
  baseAiEngine: AIEngine;
  aiEngine: AIEngine;
}

export function createCoreServices(input: CoreServicesInput) {
  const { config, log, baseAiEngine, aiEngine } = input;
  const researchBundle = baseAiEngine instanceof OmniRouteEngine
    // C4b: web fetch/crawl must obey the same SSRF policy as every other outbound request, so the
    // hardened shared validator is injected instead of the package's lighter default.
    // C5b: the exfiltration guard is injected alongside it, so a search query, a fetched URL or a crawl
    // request carrying private repository content is inspected before it leaves NPATI.
    ? createWebResearch(baseAiEngine, config.crawlerBaseUrl, process.env, {
      validator: webResearchUrlValidator(),
      outboundGuard: { assertOutboundAllowed: (input) => {
        assertOutboundAllowed({
          channel: input.channel,
          parts: input.parts,
          ...(input.context
            ? { context: {
              ...(input.context.companyId ? { companyId: input.context.companyId } : {}),
              ...(input.context.projectId ? { projectId: input.context.projectId } : {}),
              ...(input.context.sessionId ? { sessionId: input.context.sessionId } : {}),
            } }
            : {}),
        });
      } },
    })
    : undefined;
  const webResearch = config.webResearch ?? researchBundle?.service;
  const marketplace = config.marketplace ?? new OmniRouteMarketplace({
    baseUrl: config.omnirouteBaseUrl,
    apiKey: config.omnirouteApiKey,
    managementPassword: config.omnirouteManagementPassword,
  });
  const attachmentDirectory = config.dataDirectory ? path.join(config.dataDirectory, "chat-attachments") : undefined;
  const hub = createHubClient({ baseUrl: config.hubBaseUrl, apiKey: config.hubApiKey });
  const agent = new NpatiAgent({ aiEngine, hub, memory: new InMemoryProvider() });
  // G1 (item 2): annotated with the interface, so the store's optional `close?.()` (the pool it owns) is
  // reachable from the shutdown hook below. The concrete implementations add nothing the composition uses.
  const workspaceStore: WorkspaceStore = config.workspaceStore ?? (config.databaseUrl ? new PostgresWorkspaceStore(config.databaseUrl) : new InMemoryWorkspaceStore());
  const memoryDocuments = new MemoryDocumentService(workspaceStore);
  const objectStorage = config.objectStorage ?? (process.env.NODE_ENV === "test" ? new InMemoryObjectStorage() : undefined);
  const fileRepository = config.fileMetadataRepository ?? (config.databaseUrl ? new PostgresFileMetadataRepository(config.databaseUrl) : new InMemoryFileMetadataRepository());
  const storageProtection = config.storageProtection ?? (config.redisUrl ? new RedisStorageProtection(config.redisUrl) : new InMemoryStorageProtection());
  const chatFiles = objectStorage ? new ChatFileService(objectStorage,fileRepository,workspaceStore,attachmentDirectory,storageProtection) : undefined;
  const persistBusinessLogo = async (context: AuthContext, businessId: string, attachment: { name: string; mimeType: string; data: Buffer; kind?: string }) => {
    if (!chatFiles) throw new Error("Persistent object storage is not configured");
    const mimeType = attachment.mimeType.toLowerCase().split(";")[0]!.trim();
    if (attachment.kind !== "image" || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
      throw new Error("Logo must be a PNG, JPEG, or WebP image");
    }
    if (!attachment.data.length || attachment.data.length > 5 * 1024 * 1024) {
      throw new Error("Logo must be between 1 byte and 5 MB");
    }
    const logo = await chatFiles.persistBusinessAsset(context, businessId, {
      kind: "image",
      name: attachment.name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 255),
      mimeType,
      data: attachment.data,
    });
    const business = await workspaceStore.updateBusiness(context, businessId, { logoFileId: logo.id });
    const linkedCompanies = (await workspaceStore.listCompanies(context, 100)).items.filter((company) => company.businessId === business.id);
    for (const company of linkedCompanies) {
      const knowledge = company.knowledge.filter((item) => {
        if (!item || typeof item !== "object") return true;
        const value = item as Record<string, unknown>;
        return value.source !== "linked_business" || value.name !== "Company logo";
      });
      knowledge.push({ attachmentId: logo.id, kind: "image", name: "Company logo", source: "linked_business" });
      await workspaceStore.updateCompany(context, company.id, { knowledge }, company.revision);
    }
    return business;
  };
  const storageReconciler = config.databaseUrl && objectStorage ? new StorageReconciler(objectStorage,fileRepository,storageProtection,{...config.storageReconcilerOptions,onResult:(summary)=>log.info(summary,"Storage reconciliation completed"),onError:(error)=>log.error(error,"Storage reconciliation failed")}) : undefined;
  const npatiBackendUrl = config.npatiBackendUrl ?? process.env.NPATI_BACKEND_URL;
  let coreBackendHealthCache: { value: ServiceHealth; expiresAt: number } | undefined;
  let coreBackendHealthPending: Promise<ServiceHealth> | undefined;
  const coreBackendHealthCheck = config.coreBackendHealthCheck ?? (async () => {
    if (coreBackendHealthCache && coreBackendHealthCache.expiresAt > Date.now()) return coreBackendHealthCache.value;
    if (!coreBackendHealthPending) coreBackendHealthPending = defaultCoreBackendHealthCheck(npatiBackendUrl)
      .then((value) => {
        coreBackendHealthCache = { value, expiresAt: Date.now() + 15_000 };
        return value;
      })
      .finally(() => { coreBackendHealthPending = undefined; });
    return coreBackendHealthPending;
  });
  const npatiJwtSecret = config.npatiJwtSecret ?? process.env.NPATI_JWT_SECRET ?? process.env.JWT_SECRET;
  const authClient = config.authClient ?? (npatiBackendUrl ? createNpatiAuthClient(npatiBackendUrl) : undefined);
  const apiKeysRepo = new ApiKeysRepository(config.databaseUrl ? (workspaceStore as any)?.pool : undefined);
  const installationAuthStore = new InstallationAuthStore(config.dataDirectory);
  const selfHosted = config.deploymentType === "self_hosted";
  const authProvider = config.authProvider ?? new NpatiBackendAuthProvider({
    jwtSecret: npatiJwtSecret,
    authClient,
    workspaceStore,
    allowDevFallback: config.strictAuth ? false : (process.env.NODE_ENV === "test"),
    apiKeysRepository: apiKeysRepo,
    ...(selfHosted ? { isInstallationOwner: async (userId: string) => {
      const state = await installationAuthStore.load();
      if (state.ownerUserId) return state.ownerUserId === userId;
      if (!state.installationToken || !authClient?.createInstallationSession) return false;
      const verified = await authClient.createInstallationSession(state.installationToken);
      return (await installationAuthStore.bindOwner(verified.user.id)) === userId;
    } } : {}),
  });
  const aiPreferences = new AIPreferencesStore(workspaceStore, config.dataDirectory);
  const codePreferences = new CodePreferencesStore(workspaceStore);
  const activeContextResolver = new ActiveContextResolver(workspaceStore);
  const knowledgeRepo = config.databaseUrl && objectStorage ? new CompanyKnowledgeRepository(config.databaseUrl) : undefined;
  const qdrant = process.env.QDRANT_URL ? new ProductionQdrantClient(process.env.QDRANT_URL, "npati_company_knowledge", process.env.QDRANT_INT8_ENABLED !== "false") : undefined;
  const memoryEngines = new ProductionMemoryEngineRegistry([
    ...(qdrant ? [new QdrantMemoryEngineAdapter(qdrant)] : []),
    ...(process.env.FTS5_DB_PATH ? [new SqliteFts5MemoryEngine(process.env.FTS5_DB_PATH)] : []),
  ]);
  const scopedMemory = new ScopedMemoryEngine(config.databaseUrl ? (workspaceStore as any)?.pool : undefined);
  const guardrailPolicies = new GuardrailPolicyRepository(config.databaseUrl ? (workspaceStore as any)?.pool : undefined);

  return {
    researchBundle,
    webResearch,
    marketplace,
    attachmentDirectory,
    hub,
    agent,
    workspaceStore,
    memoryDocuments,
    objectStorage,
    fileRepository,
    storageProtection,
    chatFiles,
    persistBusinessLogo,
    storageReconciler,
    npatiBackendUrl,
    coreBackendHealthCache,
    coreBackendHealthPending,
    coreBackendHealthCheck,
    npatiJwtSecret,
    authClient,
    apiKeysRepo,
    installationAuthStore,
    selfHosted,
    authProvider,
    aiPreferences,
    codePreferences,
    activeContextResolver,
    knowledgeRepo,
    qdrant,
    memoryEngines,
    scopedMemory,
    guardrailPolicies,
  };
}
