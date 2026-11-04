import { logBuildInfo } from "./build-info";
import path from "node:path";
import { OmniRouteEngine } from "@npati/omniroute-adapter";
import { PostgresWorkspaceStore } from "@npati/workspace";
import { createWebResearch } from "@npati/web-research";
import { CompanyDelegationRuntime } from "./company-runtime";
import { AIPreferencesStore, selectedCompanyInferenceModels } from "./ai-preferences";
import { CompanyRunQueueWorker } from "./company-run-queue";
import { CompanyToolRuntime } from "./company-tool-runtime";
import { MinioObjectStorage } from "./object-storage";
import { PostgresFileMetadataRepository } from "./file-metadata";
import { CompanyKnowledgeProcessor,CompanyKnowledgeRepository } from "./company-knowledge";
import { CompanyKnowledgeWorker } from "./company-knowledge-queue";
import { ProductionQdrantClient } from "./qdrant-client";
import { ProductionMemoryEngineRegistry, QdrantMemoryEngineAdapter, SqliteFts5MemoryEngine } from "./knowledge-memory-engine";
import {CompanyApprovalsRepository} from "./approvals-repository";
import {GuardrailPolicyRepository} from "./guardrail-policy-repository";
import {WasmExecSandbox} from "./wasm-exec-sandbox";
import {AuditRepository} from "./audit-repository";
import {EmailInboxRepository} from "./email-inbox-repository";
import {EmailAgentTools} from "./email-agent-tools";
import {BrowserCredentialsRepository} from "./browser-credentials-repository";
import {BrowserUseClient} from "./browser-tool";
import {ChatFileService} from "./chat-file-service";
import { ProjectService } from "./project-service";
import { MountedWorkspaceProvider } from "./mounted-workspace-provider";
import { ProjectWorkspaceBaseResolver } from "./workspace-base-resolver";
import { FeatureFlagService } from "./feature-flags";
import { ProjectTerminalEventsRepository } from "./project-terminal-events";
import { ProjectSandboxService } from "./project-sandbox-service";
import { RemoteSandboxProvider } from "./sandbox-provider";
import { createProviderDataGuard, conservativeHostedPolicy } from "./provider-data-guard";
import { keepPoolErrorsFromCrashing } from "./pg-pool-errors";

keepPoolErrorsFromCrashing();
const databaseUrl=process.env.DATABASE_URL,redisUrl=process.env.REDIS_URL;
if(!databaseUrl||!redisUrl)throw new Error("DATABASE_URL and REDIS_URL are required by the Company worker");
const baseAi=new OmniRouteEngine({baseUrl:process.env.OMNIROUTE_BASE_URL,apiKey:process.env.OMNIROUTE_API_KEY,transcriptionModel:process.env.OMNIROUTE_TRANSCRIPTION_MODEL,embeddingModel:process.env.OMNIROUTE_EMBEDDING_MODEL,rerankModel:process.env.OMNIROUTE_RERANK_MODEL});
// C5b: this process builds its own engine, so it must apply the same provider data guard as the API process;
// otherwise background work (knowledge processing, email AI, memory engines) would be an unguarded path.
const ai=process.env.NPATI_CODE_PROVIDER_DATA_ENFORCEMENT==="true"
  ?createProviderDataGuard(baseAi,{resolvePolicy:(input)=>conservativeHostedPolicy(input)})
  :baseAi;
const store=new PostgresWorkspaceStore(databaseUrl);await store.initialize();
const research=createWebResearch(baseAi,process.env.CRAWL4AI_BASE_URL);
const attachments=process.env.NPATI_DATA_DIR?path.join(process.env.NPATI_DATA_DIR,"chat-attachments"):undefined;
const required=["MINIO_ENDPOINT","MINIO_ACCESS_KEY","MINIO_SECRET_KEY"] as const;for(const name of required)if(!process.env[name])throw new Error(name+" is required by the Company worker");
const storage=new MinioObjectStorage({endPoint:process.env.MINIO_ENDPOINT!,port:Number.parseInt(process.env.MINIO_PORT??"9000",10),useSSL:process.env.MINIO_USE_SSL==="true",accessKey:process.env.MINIO_ACCESS_KEY!,secretKey:process.env.MINIO_SECRET_KEY!,region:process.env.MINIO_REGION,operationTimeoutMs:Number.parseInt(process.env.MINIO_OPERATION_TIMEOUT_MS??"15000",10),streamIdleTimeoutMs:Number.parseInt(process.env.MINIO_STREAM_IDLE_TIMEOUT_MS??"30000",10),streamTotalTimeoutMs:Number.parseInt(process.env.MINIO_STREAM_TOTAL_TIMEOUT_MS??"300000",10)});await storage.initialize();
const files=new PostgresFileMetadataRepository(databaseUrl),knowledge=new CompanyKnowledgeRepository(databaseUrl);
const approvals=new CompanyApprovalsRepository(databaseUrl),guardrails=new GuardrailPolicyRepository((store as any).pool);
const audit=new AuditRepository(databaseUrl);
const emailRepo=new EmailInboxRepository(databaseUrl),emailTools=new EmailAgentTools(emailRepo);
const browserCredentials=new BrowserCredentialsRepository(databaseUrl);
const chatFiles=new ChatFileService(storage,files,store,attachments);
const browserTool=process.env.BROWSER_USE_WORKER_URL&&process.env.NPATI_BROWSER_INTERNAL_TOKEN
  ?new BrowserUseClient(process.env.BROWSER_USE_WORKER_URL,process.env.NPATI_BROWSER_INTERNAL_TOKEN,browserCredentials,undefined,chatFiles):undefined;
const qdrant=process.env.QDRANT_URL?new ProductionQdrantClient(process.env.QDRANT_URL,"npati_company_knowledge",process.env.QDRANT_INT8_ENABLED!=="false"):undefined;
const memoryEngines=new ProductionMemoryEngineRegistry([
 ...(qdrant?[new QdrantMemoryEngineAdapter(qdrant)]:[]),
 ...(process.env.FTS5_DB_PATH?[new SqliteFts5MemoryEngine(process.env.FTS5_DB_PATH)]:[]),
]);
const knowledgeProcessor=new CompanyKnowledgeProcessor(knowledge,files,storage,ai,memoryEngines);
const projects = new ProjectService(store);
/**
 * C15: the worker resolves a project's canonical workspace through the **same** resolver and the **same**
 * allowlist the API reads, so a mounted project is the same directory for a background run as it is for an
 * interactive one. A managed-only resolver here would be a second source of truth for the same project — the
 * exact thing this step forbids — and the flag is read from the same store, so a kill switch is felt in both
 * processes.
 */
const projectWorkspaceRoot = process.env.NPATI_PROJECT_WORKSPACE_ROOT ?? path.join(process.env.NPATI_DATA_DIR ?? ".data", "project-workspaces");
const projectWorkspaceBases = new ProjectWorkspaceBaseResolver({
  root: projectWorkspaceRoot,
  mounts: { lookup: async (ctx, companyId, projectId) => store.getProjectMountedFolder(ctx, companyId, projectId).catch(() => null) },
  flags: new FeatureFlagService(store),
  protectedRoots: process.env.NPATI_DATA_DIR ? [path.resolve(process.env.NPATI_DATA_DIR)] : [],
});
const projectWorkspace = new MountedWorkspaceProvider(projects, { root: projectWorkspaceRoot, bases: projectWorkspaceBases, maxFileBytes: Number(process.env.NPATI_PROJECT_MAX_FILE_BYTES) || undefined, maxFiles: Number(process.env.NPATI_PROJECT_MAX_FILES) || undefined });
const terminalEvents = new ProjectTerminalEventsRepository(projects, (store as any).pool);
const runnerUrl = process.env.NPATI_SANDBOX_RUNNER_URL, runnerSecret = process.env.NPATI_SANDBOX_RUNNER_SECRET;
const projectSandbox = runnerUrl && runnerSecret ? new ProjectSandboxService(projects, store, projectWorkspace, new RemoteSandboxProvider(runnerUrl, runnerSecret), terminalEvents, browserCredentials, {
  commandTimeoutMs: Number(process.env.NPATI_TERMINAL_TIMEOUT_MS) || undefined,
  installBuildTimeoutMs: Number(process.env.NPATI_TERMINAL_BUILD_TIMEOUT_MS) || undefined,
  outputLimitBytes: Number(process.env.NPATI_TERMINAL_OUTPUT_LIMIT_BYTES) || undefined,
  inactivityMs: Number(process.env.NPATI_SANDBOX_IDLE_MS) || undefined,
  syncMaxFiles: Number(process.env.NPATI_SANDBOX_SYNC_MAX_FILES) || undefined,
  syncMaxBytes: Number(process.env.NPATI_SANDBOX_SYNC_MAX_BYTES) || undefined,
}) : undefined;
const idleTimer = projectSandbox ? setInterval(() => { void projectSandbox.stopInactive(); }, 60_000) : undefined;
idleTimer?.unref();
const runtime=new CompanyDelegationRuntime(store,ai,Number.parseInt(process.env.NPATI_COMPANY_RUN_TIMEOUT_MS??"120000",10),new CompanyToolRuntime(ai,research?.provider,attachments,chatFiles,knowledge,new WasmExecSandbox(),emailTools,browserTool,projectWorkspace,store,projectSandbox),(ctx,companyId,query)=>knowledgeProcessor.retrieveContext(ctx,companyId,query),undefined,undefined,(ctx,companyId)=>guardrails.get(ctx,companyId),approvals,audit,undefined,selectedCompanyInferenceModels(new AIPreferencesStore(store)),true);
const runWorker=new CompanyRunQueueWorker(redisUrl,store,runtime,{concurrency:Number.parseInt(process.env.NPATI_COMPANY_WORKER_CONCURRENCY??"2",10),leaseMs:Number.parseInt(process.env.NPATI_COMPANY_RUN_LEASE_MS??"180000",10),recoveryMs:Number.parseInt(process.env.NPATI_COMPANY_RECOVERY_INTERVAL_MS??"30000",10)});
const knowledgeWorker=new CompanyKnowledgeWorker(redisUrl,knowledge,knowledgeProcessor);
for(const signal of ["SIGTERM","SIGINT"] as const)process.once(signal,()=>{ if (idleTimer) clearInterval(idleTimer); void Promise.all([runWorker.stop(),knowledgeWorker.stop(),approvals.close(),audit.close(),emailRepo.close(),browserCredentials.close(),chatFiles.close()]); });
logBuildInfo("company-worker");
console.info("[company-worker] Starting company run and knowledge workers");
await Promise.all([runWorker.start(),knowledgeWorker.start()]);
