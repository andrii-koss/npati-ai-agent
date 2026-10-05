export interface AuthContext {
  userId: string;
  externalSubject?: string;
  workspaceId: string;
  permissions: string[];
  apiKeyId?: string;
  companyId?: string;
}

export type BusinessStage = "idea" | "starting" | "operating" | "growing" | "scaling";
export type TeamType = "solo" | "team";
export type PresenceType = "online" | "local" | "both";

export interface Business {
  id: string; workspaceId: string; ownerUserId: string; name: string;
  businessType?: string; industry?: string; niche?: string; country?: string; market?: string; website?: string;
  legalName?: string; contactEmail?: string; contactPhone?: string; postalAddress?: string; registrationDetails?: string; logoFileId?: string;
  businessStage: BusinessStage; teamType?: TeamType; businessModel?: string; presenceType?: PresenceType;
  description?: string; audienceSummary?: string; productsServicesSummary?: string;
  activationStatus: "draft" | "active"; createdAt: string; updatedAt: string;
}
export type BusinessInput = Partial<Omit<Business, "id" | "workspaceId" | "ownerUserId" | "activationStatus" | "createdAt" | "updatedAt">> & { name: string };
export interface BusinessPage { items: Business[]; nextCursor: string | null; }

export interface Company {
  id: string; workspaceId: string; userId: string; businessId?: string;
  name: string; website?: string; industry?: string; description?: string;
  productsServices?: string; languages: string[]; brandTone?: string; companyInstructions?: string;
  knowledge: unknown[]; memory: Record<string, unknown>; mainAgentId?: string;
  status: "active" | "inactive"; revision: number; createdAt: string; updatedAt: string;
}
export type CompanyInput = Partial<Omit<Company, "id" | "workspaceId" | "userId" | "mainAgentId" | "revision" | "createdAt" | "updatedAt">> & { name: string };
export interface CompanyPage { items: Company[]; nextCursor: string | null; }

export type ProjectType = "website" | "web_app" | "landing_page" | "mobile_app" | "code_project";
export const PROJECT_TYPES: readonly ProjectType[] = ["website", "web_app", "landing_page", "mobile_app", "code_project"] as const;
export type ProjectStatus = "creating" | "ready" | "working" | "building" | "previewing" | "failed" | "archived";

/**
 * Data classification and retention classes (C1). The enums live here so every entity created in
 * C1-C6 carries both fields; the real retention windows are decided in R1.
 */
export type DataClassification = "public" | "internal" | "confidential" | "restricted";
export const DATA_CLASSIFICATIONS: readonly DataClassification[] = ["public", "internal", "confidential", "restricted"] as const;
export const DEFAULT_DATA_CLASSIFICATION: DataClassification = "confidential";
export type RetentionClass = "ephemeral" | "short" | "standard" | "extended" | "until_deleted";
export const RETENTION_CLASSES: readonly RetentionClass[] = ["ephemeral", "short", "standard", "extended", "until_deleted"] as const;
export const DEFAULT_RETENTION_CLASS: RetentionClass = "standard";

const classificationRank: Record<DataClassification, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
/** True when `value` is at least as strict as `floor`. */
export function isClassificationAtLeast(value: DataClassification, floor: DataClassification): boolean {
  return classificationRank[value] >= classificationRank[floor];
}
/** Returns the stricter of two classifications (used for inheritance). */
export function strictestClassification(a: DataClassification, b: DataClassification): DataClassification {
  return classificationRank[a] >= classificationRank[b] ? a : b;
}

/** Toolchain metadata detected from the workspace and editable by the owner (C1). */
export interface CodeVerifyCommands { test?: string; lint?: string; typecheck?: string; build?: string; }
export interface CodeToolchain {
  languages: string[];
  packageManagers: string[];
  verifyCommands: CodeVerifyCommands;
  /** Where the values came from: `detected` by the scanner or `manual` after a user edit. */
  source: "detected" | "manual";
  detectedAt: string;
  /** Files that produced the detection, for explainability in the UI. */
  evidence: string[];
}
export interface ProjectCodeSettings {
  toolchain?: CodeToolchain;
  defaultBranch?: string;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
}

export interface Project {
  id: string; companyId: string; workspaceId: string; createdBy: string;
  name: string; description?: string; type: ProjectType; status: ProjectStatus;
  framework?: string; runtime?: string; repositoryProvider?: string; repositoryUrl?: string; repositoryBranch?: string;
  sandboxId?: string; previewUrl?: string; previewPort?: number; lastRunId?: string; lastBuildStatus?: string;
  deploymentUrl?: string; deploymentStatus?: string; lastDeployedAt?: string;
  dataBackendId?: string;
  /** Deep link scheme of a generated mobile app (mobile_app projects). */
  appScheme?: string;
  /** C1: code project metadata, classification and retention. */
  toolchain?: CodeToolchain | null;
  defaultBranch?: string | null;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
  revision: number; createdAt: string; updatedAt: string;
}
export interface ProjectInput {
  name: string; description?: string; type: ProjectType; dataBackendId?: string; appScheme?: string;
  /** C1: optional overrides; the store applies the defaults when omitted. */
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  defaultBranch?: string;
  toolchain?: CodeToolchain;
}

/** C1c: tamper-evident audit log types. */
export type AuditDecision = "allowed" | "denied" | "approved" | "rejected";
export interface AuditEntryInput {
  actor: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  projectId?: string | null;
  decision: AuditDecision;
  /** SHA-256 of the canonical action payload; computed by the caller or by `AuditLogService`. */
  payloadHash: string;
  requestId?: string | null;
  correlationId?: string | null;
  snapshotId?: string | null;
  /** Already-redacted metadata: must never contain secrets or prompt content. */
  metadata?: Record<string, unknown>;
}
export interface AuditEntry extends AuditEntryInput {
  id: string;
  workspaceId: string;
  companyId: string;
  sequence: number;
  createdAt: string;
  prevHash: string | null;
  entryHash: string;
  metadata: Record<string, unknown>;
}
export interface AuditAnchor {
  id: string;
  workspaceId: string;
  companyId: string;
  day: string;
  sequence: number;
  entryCount: number;
  headHash: string;
  anchorPath?: string | null;
  signature?: string | null;
  createdAt: string;
}
export interface AuditChainState { companyId: string; entryCount: number; headSequence: number; headHash: string | null; }
export interface AuditChainVerification {
  companyId: string;
  ok: boolean;
  entryCount: number;
  /** Sequence number of the first entry that breaks the chain, when `ok` is false. */
  brokenAtSequence?: number;
  reason?: string;
  /** Hash of the last verified entry; compared against the latest anchor. */
  headHash: string | null;
}

/** C1a: feature flags with staged rollout. */
export type FeatureFlagScope = "global" | "company" | "user";
export const FEATURE_FLAG_SCOPES: readonly FeatureFlagScope[] = ["global", "company", "user"] as const;
export type FeatureFlagStage = "off" | "internal" | "allowlist" | "percent" | "ga";
export const FEATURE_FLAG_STAGES: readonly FeatureFlagStage[] = ["off", "internal", "allowlist", "percent", "ga"] as const;

export interface FeatureFlag {
  id: string;
  workspaceId: string;
  scope: FeatureFlagScope;
  /** Empty string for the global scope; company id or user id otherwise. */
  scopeId: string;
  flagKey: string;
  stage: FeatureFlagStage;
  enabled: boolean;
  rolloutPercent: number;
  allowlist: string[];
  revision: number;
  updatedBy: string;
  updatedAt: string;
}
export interface FeatureFlagInput {
  scope: FeatureFlagScope;
  scopeId?: string;
  flagKey: string;
  stage?: FeatureFlagStage;
  enabled?: boolean;
  rolloutPercent?: number;
  allowlist?: string[];
  expectedRevision?: number;
}
export interface FeatureFlagHistoryEntry {
  id: string;
  workspaceId: string;
  flagKey: string;
  scope: FeatureFlagScope;
  scopeId: string;
  previousValue: Record<string, unknown> | null;
  nextValue: Record<string, unknown> | null;
  actor: string;
  createdAt: string;
}
/** A published tool-schema manifest: the exact set of `name@version` a session was created with. */
export interface CodeToolManifest {
  version: number;
  tools: Array<{ name: string; version: number; status: "active" | "deprecated"; deprecatedAt?: string | null }>;
  checksum: string;
  createdAt: string;
}

export type CodeSessionMode = "plan" | "edit" | "auto" | "full_auto";
export const CODE_SESSION_MODES: readonly CodeSessionMode[] = ["plan", "edit", "auto", "full_auto"] as const;
export type CodeSessionStatus = "active" | "paused" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "archived" | "suspended_by_flag";
export const CODE_SESSION_STATUSES: readonly CodeSessionStatus[] = ["active", "paused", "awaiting_approval", "completed", "failed", "cancelled", "archived", "suspended_by_flag"] as const;

/**
 * A code session is the unit the CodingAgentRunner will drive in C6. It deliberately links to the
 * existing company Run instead of duplicating run state, and carries the classification and
 * retention fields required by rule 18.
 */
export interface CodeSession {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  userId: string;
  agentId?: string | null;
  mode: CodeSessionMode;
  modelProfile?: string | null;
  status: CodeSessionStatus;
  parentSessionId?: string | null;
  /** Existing company run driving this session (C6); null until a run is attached. */
  runId?: string | null;
  summary?: string | null;
  /** Set when the session finishes and drives History (C7). */
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
  /** C1a fills this with the set of code.* tool versions the session was created with. */
  toolManifestVersion?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CodeSessionInput {
  mode?: CodeSessionMode;
  agentId?: string;
  modelProfile?: string;
  parentSessionId?: string;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  summary?: string;
}

export type CheckpointTrigger = "manual" | "pre_run" | "post_run" | "pre_restore";

export interface ProjectCheckpoint {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  userId: string;
  name: string;
  description?: string;
  commitHash?: string;
  trigger: CheckpointTrigger;
  runId?: string;
  fileCount: number;
  createdAt: string;
}

export interface CreateCheckpointInput {
  name: string;
  description?: string;
  commitHash?: string;
  trigger: CheckpointTrigger;
  runId?: string;
  fileCount?: number;
}

export type DeploymentStatus = "queued" | "building" | "deployed" | "failed";

export interface ProjectDeployment {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  userId: string;
  provider: string;
  environment: string;
  branch: string;
  commitHash?: string;
  status: DeploymentStatus;
  targetUrl?: string;
  externalDeploymentId?: string;
  preflightSummary?: Record<string, unknown>;
  errorMessage?: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDeploymentInput {
  provider: string;
  environment?: string;
  branch?: string;
  commitHash?: string;
  status?: DeploymentStatus;
  targetUrl?: string;
  externalDeploymentId?: string;
  preflightSummary?: Record<string, unknown>;
  errorMessage?: string;
  runId?: string;
}

export type BrowserQaStatus = "passed" | "warning" | "failed" | "error";

export interface BrowserQaIssue {
  id: string;
  type: "console_error" | "broken_link" | "a11y" | "performance";
  severity: "error" | "warning" | "info";
  message: string;
  selector?: string;
  context?: Record<string, unknown>;
  recommendation: string;
}

export interface BrowserQaMetrics {
  loadTimeMs: number;
  domContentLoadedMs: number;
  resourceCount: number;
  totalSizeBytes: number;
  brokenLinksCount: number;
  consoleErrorsCount: number;
  a11yViolationsCount: number;
  performanceIssuesCount: number;
}

export interface BrowserQaScreenshot {
  name: string;
  viewport: { width: number; height: number };
  mimeType: string;
  base64Data: string;
  sizeBytes: number;
}

export interface ProjectQaReport {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  userId: string;
  status: BrowserQaStatus;
  targetUrl: string;
  summary: string;
  issues: BrowserQaIssue[];
  metrics: BrowserQaMetrics;
  screenshots: BrowserQaScreenshot[];
  runId?: string;
  createdAt: string;
}

export interface CreateProjectQaReportInput {
  status: BrowserQaStatus;
  targetUrl: string;
  summary: string;
  issues: BrowserQaIssue[];
  metrics: BrowserQaMetrics;
  screenshots?: BrowserQaScreenshot[];
  runId?: string;
}

export interface BusinessToCompanyInput {
  companyName?: string;
  includeConfirmedMemory?: boolean;
  includeGoals?: boolean;
  includeResearchSummary?: boolean;
  includeInstructions?: boolean;
}

export interface CompanyAgent {
  id: string; workspaceId: string; companyId: string; name: string; role: string;
  description?: string; systemInstruction?: string; promptGuidelines?: string;
  recommendedPrompts: string[]; modelId?: string; fallbackModelId?: string;
  tools: string[]; isActive: boolean; positionX?: number; positionY?: number;
  sortOrder: number; revision: number; createdAt: string; updatedAt: string;
}
export type CompanyAgentInput = Partial<Omit<CompanyAgent, "id" | "workspaceId" | "companyId" | "revision" | "createdAt" | "updatedAt">> & { name: string; role: string };
export interface CompanyAgentPage { items: CompanyAgent[]; nextCursor: string | null; }

export interface CompanyAgentEdge {
  id: string; workspaceId: string; companyId: string; parentAgentId: string;
  childAgentId: string; relationType: string; createdAt: string;
}

export type CompanyRunMode = "auto" | "single" | "pipeline" | "fusion";
export type CompanyRunStatus = "queued" | "planning" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelling" | "cancelled";
export type ContextType = "none" | "business" | "company";

export interface ActiveContext {
  contextType: ContextType;
  businessId: string | null;
  companyId: string | null;
}

export interface RunContextSnapshot extends ActiveContext {
  workspaceId: string;
  userId: string;
  agentId?: string | null;
  companyRevision?: number | null;
  capturedAt: string;
}

export interface CompanyAgentRun {
  id: string; workspaceId: string; companyId: string; projectId?: string; userId: string; mainAgentId: string;
  idempotencyKey: string; task: string; requestedMode: CompanyRunMode;
  executionMode?: Exclude<CompanyRunMode, "auto">; status: CompanyRunStatus;
  selectedAgentIds: string[]; omnirouteTaskId?: string; omnirouteComboName?: string;
  result?: string; errorCode?: string; errorMessage?: string; cancelRequested: boolean;
  workerId?: string; leaseExpiresAt?: string; lastHeartbeatAt?: string;
  attemptCount: number; maxAttempts: number; nextAttemptAt: string;
  contextSnapshot?: RunContextSnapshot;
  agentConfigRevision?: number;
  capabilitySetRevision?: number;
  totalCost?: number;
  totalTokens?: number;
  totalDurationMs?: number;
  createdAt: string; startedAt?: string; completedAt?: string; updatedAt: string;
}
export interface CompanyAgentRunStep {
  id: string; workspaceId: string; companyId: string; runId: string; agentId: string;
  stepOrder: number; lane: number; role: "manager" | "worker" | "reviewer";
  status: "selected" | "delegated" | "completed" | "failed" | "cancelled";
  modelId: string; createdAt: string; updatedAt: string;
}
export interface CompanyAgentToolAudit {
  id: string; workspaceId: string; companyId: string; runId: string; agentId: string;
  toolName: string; decision: "allowed" | "denied";
  status: "requested" | "succeeded" | "failed" | "blocked";
  inputSummary: Record<string, unknown>; errorMessage?: string; createdAt: string; completedAt?: string;
  latencyMs?: number; cost?: number; tokens?: number; reasonCode?: string; sequenceNumber?: number;
}
export type CompanyAgentRunEventType = "queued" | "claimed" | "started" | "retry_scheduled" | "completed" | "failed" | "cancelled";
export interface CompanyAgentRunEvent {
  id: string; workspaceId: string; companyId: string; runId: string; eventKey: string;
  eventType: CompanyAgentRunEventType; runStatus: CompanyRunStatus; workerId?: string;
  attemptCount: number; message: string; details: Record<string, unknown>; createdAt: string;
}
export interface CompanyAgentCompletionReport {
  runId: string; companyId: string; status: "completed" | "failed" | "cancelled";
  result?: string; errorCode?: string; errorMessage?: string; workerId?: string;
  attemptCount: number; totalCost: number; totalTokens: number; totalDurationMs: number; completedAt: string;
}
export interface CompanyAgentRunDetails {
  run: CompanyAgentRun; steps: CompanyAgentRunStep[]; toolAudit: CompanyAgentToolAudit[];
  backgroundEvents: CompanyAgentRunEvent[]; completionReport?: CompanyAgentCompletionReport;
}

export type GoalStatus = "active" | "completed" | "paused" | "cancelled";
export interface Goal {
  id: string; workspaceId: string; businessId: string; createdByUserId: string; title: string; description?: string;
  status: GoalStatus; targetValue?: number; targetUnit?: string; currentValue?: number; targetDate?: string;
  priority: number; createdAt: string; updatedAt: string;
}
export type GoalInput = Partial<Omit<Goal, "id" | "workspaceId" | "businessId" | "createdByUserId" | "createdAt" | "updatedAt">> & { title: string };

export type MemoryType = "business_fact" | "audience" | "brand" | "preference" | "decision" | "product" | "channel" | "experiment" | "result" | "other";
export interface MemoryItem {
  id: string; workspaceId: string; businessId: string; userId: string; type: MemoryType; title: string;
  content: string; source: string; confidence?: number; createdAt: string; updatedAt: string;
}
export type MemoryInput = Pick<MemoryItem, "type" | "title" | "content"> & Partial<Pick<MemoryItem, "source" | "confidence">>;

export interface Conversation {
  id: string; workspaceId: string; businessId: string | null; userId: string; title: string; createdAt: string; updatedAt: string;
}
export interface ConversationMessage {
  id: string; conversationId: string; role: "user" | "assistant" | "system"; content: string; createdAt: string;
}
export interface WorkspaceOverview {
  user: { id: string; displayName: string };
  workspace: { id: string; name: string; role: string };
  businesses: Business[];
  currentBusiness: Business | null;
  onboarding: BusinessOnboardingSession | null;
  onboardings: BusinessOnboardingSession[];
}

export interface UserSetting {
  key: string;
  value: unknown;
  revision: number;
  updatedAt: string;
}

export type OnboardingScenario = "existing" | "starting" | "seller";
export type OnboardingStatus = "active" | "paused" | "awaiting_confirmation" | "completed";
export interface BusinessOnboardingSession {
  id: string; workspaceId: string; userId: string; businessId: string; conversationId: string;
  scenario: OnboardingScenario; status: OnboardingStatus; currentStep: number;
  completedFields: string[]; skippedFields: string[]; totalFields: number; currentField?: string;
  business: Business; createdAt: string; updatedAt: string;
}

export class WorkspaceAccessError extends Error {
  readonly status = 403;
  readonly code = "BUSINESS_ACCESS_DENIED";
}

export class WorkspaceNotFoundError extends Error {
  readonly status = 404;
  readonly code = "WORKSPACE_NOT_FOUND";
}

export interface WorkspaceStore {
  initialize(context?: AuthContext): Promise<void>;
  getUserSetting(context: AuthContext, key: string): Promise<UserSetting | null>;
  setUserSetting(context: AuthContext, key: string, value: unknown, expectedRevision: number): Promise<UserSetting | null>;
  health(): Promise<"ok" | "unavailable">;
  overview(context: AuthContext): Promise<WorkspaceOverview>;
  setCurrentBusiness(context: AuthContext, businessId: string): Promise<Business>;
  listBusinesses(context: AuthContext): Promise<Business[]>;
  listUserBusinesses(context: AuthContext): Promise<Business[]>;
  listBusinessesPage(context: AuthContext, limit?: number, cursor?: string): Promise<BusinessPage>;
  getBusiness(context: AuthContext, businessId: string): Promise<Business>;
  getUserBusiness(context: AuthContext, businessId: string): Promise<Business>;
  createBusiness(context: AuthContext, input: BusinessInput, idempotencyKey?: string): Promise<Business>;
  updateBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>): Promise<Business>;
  updateUserBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>): Promise<Business>;
  deleteBusiness(context: AuthContext, businessId: string): Promise<boolean>;
  listCompanies(context: AuthContext, limit?: number, cursor?: string): Promise<CompanyPage>;
  getCompany(context: AuthContext, companyId: string): Promise<Company>;
  createCompany(context: AuthContext, input: CompanyInput, idempotencyKey: string): Promise<Company>;
  convertBusinessToCompany(context: AuthContext, businessId: string, input: BusinessToCompanyInput, idempotencyKey: string): Promise<{ company: Company; created: boolean }>;
  updateCompany(context: AuthContext, companyId: string, input: Partial<CompanyInput>, expectedRevision: number): Promise<Company>;
  deleteCompany(context: AuthContext, companyId: string): Promise<boolean>;
  setCompanyMainAgent(context: AuthContext, companyId: string, agentId: string | null, expectedRevision: number): Promise<Company>;
  createProject(context: AuthContext, companyId: string, input: ProjectInput, idempotencyKey: string): Promise<{ project: Project; created: boolean }>;
  listProjects(context: AuthContext, companyId: string, includeArchived?: boolean): Promise<Project[]>;
  getProject(context: AuthContext, companyId: string, projectId: string): Promise<Project>;
  updateProject(context: AuthContext, companyId: string, projectId: string, input: { name?: string; expectedRevision: number; code?: ProjectCodeSettings }): Promise<Project>;
  archiveProject(context: AuthContext, companyId: string, projectId: string, expectedRevision: number): Promise<Project>;
  setProjectSandbox(context: AuthContext, companyId: string, projectId: string, sandboxId: string | null, expectedSandboxId: string | null): Promise<Project>;
  updateProjectRepository(context: AuthContext, companyId: string, projectId: string, input: { provider: string; url: string; branch: string }): Promise<Project>;
  updateProjectPreview(context: AuthContext, companyId: string, projectId: string, patch: { status?: ProjectStatus; previewUrl?: string | null; previewPort?: number | null; framework?: string | null; runtime?: string | null; lastBuildStatus?: string | null; deploymentUrl?: string | null; deploymentStatus?: string | null; lastDeploymentStatus?: string | null; lastDeployedAt?: string | null }): Promise<Project>;
  deleteProject(context: AuthContext, companyId: string, projectId: string): Promise<boolean>;

  /** C1a: feature flags (resolution is user -> company -> global) and their change history. */
  listFeatureFlags(context: AuthContext): Promise<FeatureFlag[]>;
  setFeatureFlag(context: AuthContext, input: FeatureFlagInput): Promise<FeatureFlag>;
  listFeatureFlagHistory(context: AuthContext, flagKey?: string, limit?: number): Promise<FeatureFlagHistoryEntry[]>;
  /** C1a: published tool-schema manifest, so an old session reads with the manifest it was created with. */
  publishCodeToolManifest(context: AuthContext, manifest: { version: number; tools: CodeToolManifest["tools"]; checksum: string }): Promise<CodeToolManifest>;
  latestCodeToolManifest(context: AuthContext): Promise<CodeToolManifest | null>;

  /** C1c: append-only audit journal. `appendAuditEntry` fails closed and is never idempotent-silent. */  appendAuditEntry(context: AuthContext, companyId: string, input: AuditEntryInput): Promise<AuditEntry>;
  listAuditEntries(context: AuthContext, companyId: string, filters?: { actor?: string; requestId?: string; correlationId?: string; action?: string; limit?: number; fromSequence?: number }): Promise<AuditEntry[]>;
  verifyAuditChain(context: AuthContext, companyId: string, range?: { fromSequence?: number; toSequence?: number }): Promise<AuditChainVerification>;
  auditChainState(context: AuthContext, companyId: string): Promise<AuditChainState>;
  recordAuditAnchor(context: AuthContext, companyId: string, anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null }): Promise<AuditAnchor>;
  listAuditAnchors(context: AuthContext, companyId: string, limit?: number): Promise<AuditAnchor[]>;
  latestAuditAnchor(context: AuthContext, companyId: string): Promise<AuditAnchor | null>;
  /** Company ids that have at least one audit entry, used by the background verifier/anchor job. */
  auditCompanies(context: AuthContext): Promise<string[]>;

  /**
   * System path for the background verifier and anchor job: it runs without a user context, so it is
   * scoped by workspace only and never exposes entry contents (states, counts and hashes only).
   */
  systemAuditChains(workspaceId: string): Promise<Array<{ companyId: string; state: AuditChainState; verification: AuditChainVerification }>>;
  systemRecordAuditAnchor(workspaceId: string, companyId: string, anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null }): Promise<AuditAnchor>;

  /** C1: code sessions. Scoped by workspace + company + project + owner. */  createCodeSession(context: AuthContext, companyId: string, projectId: string, input: CodeSessionInput): Promise<CodeSession>;
  getCodeSession(context: AuthContext, companyId: string, sessionId: string): Promise<CodeSession>;
  listCodeSessions(context: AuthContext, companyId: string, projectId?: string, options?: { includeArchived?: boolean; limit?: number }): Promise<CodeSession[]>;
  updateCodeSession(context: AuthContext, companyId: string, sessionId: string, patch: { status?: CodeSessionStatus; summary?: string; runId?: string | null; modelProfile?: string; dataClassification?: DataClassification; retentionClass?: RetentionClass; toolManifestVersion?: number | null }): Promise<CodeSession>;
  createProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, input: CreateCheckpointInput): Promise<ProjectCheckpoint>;
  listProjectCheckpoints(context: AuthContext, companyId: string, projectId: string, limit?: number): Promise<ProjectCheckpoint[]>;
  getProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<ProjectCheckpoint>;
  deleteProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<boolean>;
  createProjectDeployment(context: AuthContext, companyId: string, projectId: string, input: CreateDeploymentInput): Promise<ProjectDeployment>;
  listProjectDeployments(context: AuthContext, companyId: string, projectId: string, limit?: number): Promise<ProjectDeployment[]>;
  getProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string): Promise<ProjectDeployment | null>;
  updateProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string, patch: Partial<ProjectDeployment>): Promise<ProjectDeployment>;
  createProjectQaReport(context: AuthContext, companyId: string, projectId: string, input: CreateProjectQaReportInput): Promise<ProjectQaReport>;
  listProjectQaReports(context: AuthContext, companyId: string, projectId: string, limit?: number): Promise<ProjectQaReport[]>;
  getProjectQaReport(context: AuthContext, companyId: string, projectId: string, reportId: string): Promise<ProjectQaReport | null>;
  getLatestProjectQaReport(context: AuthContext, companyId: string, projectId: string): Promise<ProjectQaReport | null>;
  listCompanyAgents(context: AuthContext, companyId: string): Promise<CompanyAgent[]>;
  listCompanyAgentsPage(context: AuthContext, companyId: string, limit?: number, cursor?: string): Promise<CompanyAgentPage>;
  getCompanyAgent(context: AuthContext, companyId: string, agentId: string): Promise<CompanyAgent>;
  createCompanyAgent(context: AuthContext, companyId: string, input: CompanyAgentInput, idempotencyKey: string): Promise<CompanyAgent>;
  updateCompanyAgent(context: AuthContext, companyId: string, agentId: string, input: Partial<CompanyAgentInput>, expectedRevision: number): Promise<CompanyAgent>;
  deleteCompanyAgent(context: AuthContext, companyId: string, agentId: string, expectedRevision: number): Promise<boolean>;
  listCompanyAgentEdges(context: AuthContext, companyId: string, agentIds?: string[]): Promise<CompanyAgentEdge[]>;
  setCompanyAgentParent(context: AuthContext, companyId: string, childAgentId: string, parentAgentId: string | null): Promise<CompanyAgentEdge | null>;
  createCompanyAgentRun(context: AuthContext, companyId: string, input: { task: string; requestedMode: CompanyRunMode; projectId?: string }, idempotencyKey: string): Promise<{ run: CompanyAgentRun; created: boolean }>;
  listCompanyAgentRuns(context: AuthContext, companyId: string, limit?: number, filter?: { projectId?: string }): Promise<CompanyAgentRun[]>;
  listProjectRuns(context: AuthContext, companyId: string, projectId: string, limit?: number): Promise<CompanyAgentRun[]>;
  getCompanyAgentRun(context: AuthContext, companyId: string, runId: string): Promise<CompanyAgentRunDetails>;
  getCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string): Promise<unknown | null>;
  setCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string, plan: unknown | null): Promise<void>;
  updateCompanyAgentRun(context: AuthContext, companyId: string, runId: string, patch: Partial<Pick<CompanyAgentRun, "status" | "executionMode" | "selectedAgentIds" | "omnirouteTaskId" | "omnirouteComboName" | "result" | "errorCode" | "errorMessage" | "cancelRequested" | "totalCost" | "totalTokens" | "totalDurationMs">>): Promise<CompanyAgentRun>;
  replaceCompanyAgentRunSteps(context: AuthContext, companyId: string, runId: string, steps: Array<Pick<CompanyAgentRunStep, "agentId" | "stepOrder" | "lane" | "role" | "status" | "modelId">>): Promise<CompanyAgentRunStep[]>;
  appendCompanyAgentToolAudit(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentToolAudit, "agentId" | "toolName" | "decision" | "status" | "inputSummary" | "errorMessage"> & Partial<Pick<CompanyAgentToolAudit, "latencyMs" | "cost" | "tokens" | "reasonCode" | "sequenceNumber">>): Promise<CompanyAgentToolAudit>;
  appendCompanyAgentRunEvent(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentRunEvent, "eventKey" | "eventType" | "runStatus" | "message"> & Partial<Pick<CompanyAgentRunEvent, "workerId" | "attemptCount" | "details">>): Promise<CompanyAgentRunEvent>;
  claimCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number): Promise<boolean>;
  heartbeatCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number): Promise<boolean>;
  requeueCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, delayMs: number): Promise<boolean>;
  listRecoverableCompanyAgentRuns(limit?: number): Promise<Array<{ context: AuthContext; companyId: string; runId: string }>>;
  listGoals(context: AuthContext, businessId: string): Promise<Goal[]>;
  listUserGoals(context: AuthContext): Promise<Goal[]>;
  createGoal(context: AuthContext, businessId: string, input: GoalInput): Promise<Goal>;
  linkGoal(context: AuthContext, businessId: string, goalId: string): Promise<Goal>;
  updateGoal(context: AuthContext, businessId: string, goalId: string, input: Partial<GoalInput>): Promise<Goal>;
  deleteGoal(context: AuthContext, businessId: string, goalId: string): Promise<boolean>;
  listMemory(context: AuthContext, businessId: string, query?: string, limit?: number): Promise<MemoryItem[]>;
  listUserMemories(context: AuthContext, query?: string, limit?: number): Promise<MemoryItem[]>;
  createMemory(context: AuthContext, businessId: string, input: MemoryInput): Promise<MemoryItem>;
  linkMemory(context: AuthContext, businessId: string, memoryId: string): Promise<MemoryItem>;
  updateMemory(context: AuthContext, businessId: string, memoryId: string, input: Partial<MemoryInput>): Promise<MemoryItem>;
  deleteMemory(context: AuthContext, businessId: string, memoryId: string): Promise<boolean>;
  listConversations(context: AuthContext, businessId: string): Promise<Conversation[]>;
  createConversation(context: AuthContext, businessId: string, title: string): Promise<Conversation>;
  getConversation(context: AuthContext, businessId: string, conversationId: string): Promise<{ conversation: Conversation; messages: ConversationMessage[] }>;
  updateConversation(context: AuthContext, businessId: string, conversationId: string, title: string): Promise<Conversation>;
  deleteConversation(context: AuthContext, businessId: string, conversationId: string): Promise<boolean>;
  appendMessage(context: AuthContext, businessId: string, conversationId: string, role: ConversationMessage["role"], content: string): Promise<ConversationMessage>;
  listNeutralConversations(context: AuthContext): Promise<Conversation[]>;
  createNeutralConversation(context: AuthContext, title: string): Promise<Conversation>;
  getNeutralConversation(context: AuthContext, conversationId: string): Promise<{ conversation: Conversation; messages: ConversationMessage[] }>;
  updateNeutralConversation(context: AuthContext, conversationId: string, title: string): Promise<Conversation>;
  deleteNeutralConversation(context: AuthContext, conversationId: string): Promise<boolean>;
  appendNeutralMessage(context: AuthContext, conversationId: string, role: ConversationMessage["role"], content: string): Promise<ConversationMessage>;
  getOnboarding(context: AuthContext, businessId?: string): Promise<BusinessOnboardingSession | null>;
  listOnboardings(context: AuthContext): Promise<BusinessOnboardingSession[]>;
  startOnboarding(context: AuthContext, scenario: OnboardingScenario, options?: { forceNew?: boolean }): Promise<BusinessOnboardingSession>;
  advanceOnboarding(context: AuthContext, sessionId: string, input: { value?: string; skip?: boolean; businessPatch?: Partial<BusinessInput> }): Promise<BusinessOnboardingSession>;
  setOnboardingStatus(context: AuthContext, sessionId: string, status: "active" | "paused"): Promise<BusinessOnboardingSession>;
  completeOnboarding(context: AuthContext, sessionId: string): Promise<BusinessOnboardingSession>;
}
