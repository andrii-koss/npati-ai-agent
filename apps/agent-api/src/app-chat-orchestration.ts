import type { FastifyBaseLogger } from "fastify";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import {
  isChatCapableModel,
  isNonChatSpecialtyModel,
  type AIEngine,
} from "@npati/omniroute-adapter";
import type { PriorityTier } from "./resilience-admission-queue";
import type { AppConfig } from "./app";
import type { createCoreServices } from "./core-services";
import type { createDataBackendServices } from "./data-backend-services";
import type { CompanyDelegationRuntime } from "./company-runtime";
import type { CompanyKnowledgeRepository } from "./company-knowledge";
import type { EmailInboxRepository } from "./email-inbox-repository";
import type { EmailInboxWorker } from "./email-worker";
import type { EmailAttachmentStorage } from "./email-attachment-storage";
import type { BrowserCredentialsRepository } from "./browser-credentials-repository";
import type { CompanyAutomationsRepository, CompanyAutomation } from "./automations-repository";
import type { CompanyRunQueueProducer } from "./company-run-queue";
import type { ContentLibraryStore } from "./content-library-store";
import type { AuditRepository } from "./audit-repository";
import type { GuardrailPolicyRepository } from "./guardrail-policy-repository";
import type { ScopedMemoryEngine } from "./scoped-memory";
import type { AIPreferencesStore } from "./ai-preferences";
import { createChatOrchestration } from "./chat-orchestration";

export interface AppChatOrchestrationDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  agent: ReturnType<typeof createCoreServices>["agent"];
  aiEngine: AIEngine;
  aiPreferences: AIPreferencesStore;
  apiKeysRepo: ReturnType<typeof createCoreServices>["apiKeysRepo"];
  auditRepo?: AuditRepository;
  automationsRepo: CompanyAutomationsRepository;
  browserCredentials?: BrowserCredentialsRepository;
  chatFiles?: ReturnType<typeof createCoreServices>["chatFiles"];
  companyRunQueue?: CompanyRunQueueProducer;
  companyRuntime: CompanyDelegationRuntime;
  contentLibrary: ContentLibraryStore;
  dataBackendService?: ReturnType<typeof createDataBackendServices>["dataBackendService"];
  emailAttachmentStorage?: EmailAttachmentStorage;
  emailInboxRepo: EmailInboxRepository;
  emailInboxWorker: EmailInboxWorker;
  fileRepository: ReturnType<typeof createCoreServices>["fileRepository"];
  guardrailPolicies: GuardrailPolicyRepository;
  hub: ReturnType<typeof createCoreServices>["hub"];
  knowledgeRepo?: CompanyKnowledgeRepository;
  memoryDocuments: ReturnType<typeof createCoreServices>["memoryDocuments"];
  objectStorage?: ReturnType<typeof createCoreServices>["objectStorage"];
  persistBusinessLogo: ReturnType<typeof createCoreServices>["persistBusinessLogo"];
  researchBundle?: ReturnType<typeof createCoreServices>["researchBundle"];
  runAutomation: (automation: CompanyAutomation, executionKey: string) => Promise<{ result: string }>;
  scopedMemory: ScopedMemoryEngine;
  webResearch: ReturnType<typeof createCoreServices>["webResearch"];
  workspaceStore: WorkspaceStore;
}

export function createAppChatOrchestration(deps: AppChatOrchestrationDeps) {
  const {
    config,
    log,
    agent,
    aiEngine,
    aiPreferences,
    apiKeysRepo,
    auditRepo,
    automationsRepo,
    browserCredentials,
    chatFiles,
    companyRunQueue,
    companyRuntime,
    contentLibrary,
    dataBackendService,
    emailAttachmentStorage,
    emailInboxRepo,
    emailInboxWorker,
    fileRepository,
    guardrailPolicies,
    hub,
    knowledgeRepo,
    memoryDocuments,
    objectStorage,
    persistBusinessLogo,
    researchBundle,
    runAutomation,
    scopedMemory,
    webResearch,
    workspaceStore,
  } = deps;

  const getAIContext = async (auth: AuthContext) => {
    const preferences = await aiPreferences.get(auth);
    let manualModel =
      preferences.routing.mode === "manual" && preferences.routing.defaultModelId
        ? preferences.routing.defaultModelId
        : undefined;
    if (manualModel) {
      const added = preferences.addedModels.find((m) => m.id === manualModel);
      if (added ? !isChatCapableModel(added) : isNonChatSpecialtyModel({ id: manualModel })) {
        manualModel = undefined;
      }
    }
    const primaryModel = manualModel ?? preferences.routing.automaticModel ?? "auto";
    const fallbackModel = manualModel
      ? undefined
      : preferences.routing.fallbackOnFailure
        ? "auto/smart"
        : undefined;
    return {
      mode: preferences.routing.mode,
      model: primaryModel,
      fallbackModel: fallbackModel !== primaryModel ? fallbackModel : undefined,
      compression: preferences.routing.compression,
    };
  };

  const priorityTierFor = (auth: AuthContext): PriorityTier =>
    auth.permissions.includes("admin:all")
      ? "enterprise"
      : auth.permissions.includes("workspace:write")
        ? "pro"
        : "free";

  const admissionFor = (auth: AuthContext) => ({
    tenantId: auth.workspaceId,
    tier: priorityTierFor(auth),
    queueTimeoutMs: 30_000,
  });

  const chatOrchestration = createChatOrchestration({
    config,
    log,
    admissionFor,
    agent,
    aiEngine,
    aiPreferences,
    apiKeysRepo,
    auditRepo,
    automationsRepo,
    browserCredentials,
    chatFiles,
    companyRunQueue,
    companyRuntime,
    contentLibrary,
    dataBackendService,
    emailAttachmentStorage,
    emailInboxRepo,
    emailInboxWorker,
    fileRepository,
    getAIContext,
    guardrailPolicies,
    hub,
    knowledgeRepo,
    memoryDocuments,
    objectStorage,
    persistBusinessLogo,
    researchBundle,
    runAutomation,
    scopedMemory,
    webResearch,
    workspaceStore,
  });

  const {
    persistAutomaticCompanyMemory,
    beforeDeleteCompany,
    runBusinessMessage,
    runNeutralMessage,
  } = chatOrchestration;

  return {
    getAIContext,
    priorityTierFor,
    admissionFor,
    chatOrchestration,
    persistAutomaticCompanyMemory,
    beforeDeleteCompany,
    runBusinessMessage,
    runNeutralMessage,
  };
}
