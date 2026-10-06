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

/** C5: scoped approval rules. `once` is the default and deliberately has no rule representation. */
export type CodeApprovalRuleScope = "session" | "project";
export const CODE_APPROVAL_RULE_SCOPES: readonly CodeApprovalRuleScope[] = ["session", "project"] as const;
export type CodeApprovalScope = "once" | CodeApprovalRuleScope;
export const CODE_APPROVAL_SCOPES: readonly CodeApprovalScope[] = ["once", "session", "project"] as const;

export interface CodeApprovalRule {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string | null;
  sessionId: string | null;
  createdBy: string;
  scope: CodeApprovalRuleScope;
  action: string;
  decision: "allow";
  reason?: string | null;
  expiresAt?: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface CodeApprovalRuleInput {
  scope: CodeApprovalRuleScope;
  action: string;
  projectId?: string | null;
  sessionId?: string | null;
  reason?: string | null;
  expiresAt?: string | null;
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

/** C1b: sandbox images addressed by digest, with the evidence an admission decision needs. */
export type SandboxImageVariant = "base" | "node" | "python" | "go" | "rust" | "java" | "php";
export const SANDBOX_IMAGE_VARIANTS: readonly SandboxImageVariant[] = ["base", "node", "python", "go", "rust", "java", "php"] as const;
export type SandboxImageStatus = "unverified" | "verified" | "deprecated" | "revoked";
export const SANDBOX_IMAGE_STATUSES: readonly SandboxImageStatus[] = ["unverified", "verified", "deprecated", "revoked"] as const;
export interface SandboxImage {
  id: string;
  workspaceId: string;
  variant: SandboxImageVariant;
  /** Always `repo@sha256:<64 hex>`; a tag is never a valid identity. */
  reference: string;
  digest: string;
  status: SandboxImageStatus;
  signature?: string | null;
  signatureIssuer?: string | null;
  sbomPath?: string | null;
  scanTool?: string | null;
  scanAt?: string | null;
  scanCritical: number;
  scanHigh: number;
  waiverOwner?: string | null;
  waiverExpiresAt?: string | null;
  waiverReason?: string | null;
  previousReference?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
  revokeReason?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface SandboxImageInput {
  variant: SandboxImageVariant;
  reference: string;
  digest: string;
  status?: SandboxImageStatus;
  signature?: string | null;
  signatureIssuer?: string | null;
  sbomPath?: string | null;
  scanTool?: string | null;
  scanAt?: string | null;
  scanCritical?: number;
  scanHigh?: number;
  waiverOwner?: string | null;
  waiverExpiresAt?: string | null;
  waiverReason?: string | null;
  previousReference?: string | null;
}
/** The exact shape of `repo@sha256:<64 hex>`; used by both the store and the admission policy. */
export const SANDBOX_IMAGE_REFERENCE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[0-9]+)?@sha256:[0-9a-f]{64}$/;

export type CodeSessionMode = "plan" | "edit" | "auto" | "full_auto";export const CODE_SESSION_MODES: readonly CodeSessionMode[] = ["plan", "edit", "auto", "full_auto"] as const;
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
  /** C5: bumped on every update; the optimistic token for user-driven mode changes. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * C5: explicit trust for a project's own instructions (README/NPATI.md/AGENTS.md and any workspace
 * file). Trust is granted only by an owner/admin, is audited, and never widens policy: it only allows
 * the repository's own instructions to guide the *content* of the work. Hard deny, session mode,
 * approvals, the tool list and the network allowlist stay outside its reach.
 */
export interface ProjectCodeTrust {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  trusted: boolean;
  trustedBy?: string | null;
  trustedAt?: string | null;
  revokedBy?: string | null;
  revokedAt?: string | null;
  reason?: string | null;
  revision: number;
  updatedAt: string;
}

export interface ProjectCodeTrustInput {
  trusted: boolean;
  actor: string;
  reason?: string;
  /** Optimistic concurrency token: must match the current record revision (0 for a first write). */
  expectedRevision: number;
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
  // Declared as `number`/`string` rather than as literals so a more specific refusal can extend this
  // class (see `CompanyMembershipError`) and still be caught by every existing route mapper that tests
  // `instanceof WorkspaceAccessError`, while reporting its own code and status. The runtime defaults are
  // unchanged.
  readonly status: number = 403;
  readonly code: string = "BUSINESS_ACCESS_DENIED";
}

export class WorkspaceNotFoundError extends Error {
  readonly status = 404;
  readonly code = "WORKSPACE_NOT_FOUND";
}

/**
 * C5a: company membership. Membership is the authorisation anchor of the coding agent
 * (user -> company -> project -> workspace -> session -> sandbox), so a row is the **only** source of a
 * role: no row means no role, and nothing may assume "owner by default".
 *
 * These record types are **structurally identical** to `CompanyMember` / `CompanyInvite` in
 * `apps/agent-api/src/code-membership.ts`, whose `CodeMembershipStore` port is the contract other agents
 * are written against. Field names, optionality and types must stay in sync with that port; timestamps
 * are `Date` because the port compares them with `Date#getTime()` for invite expiry. `WorkspaceStore`
 * implements the port directly, so `CodeMembershipService` needs no adapter.
 */
export type CompanyRole = "owner" | "admin" | "developer" | "reviewer";
export const COMPANY_ROLES: readonly CompanyRole[] = ["owner", "admin", "developer", "reviewer"] as const;
/** Mirrors the `company_members.status` CHECK constraint in migration 072. */
export type CompanyMemberStatus = "active" | "invited" | "suspended";
export const COMPANY_MEMBER_STATUSES: readonly CompanyMemberStatus[] = ["active", "invited", "suspended"] as const;

/** Runtime guard for data that did not come from TypeScript (a raw column, a request body). */
export function isCompanyRole(value: unknown): value is CompanyRole {
  return typeof value === "string" && (COMPANY_ROLES as readonly string[]).includes(value);
}

export interface CompanyMember {
  id: string;
  companyId: string;
  userId: string;
  /** The role actually recorded for this (company, user); never inferred, never defaulted. */
  role: CompanyRole;
  status: CompanyMemberStatus;
  invitedBy?: string | null;
  invitedAt?: Date | null;
  acceptedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Optimistic concurrency token, bumped on every accepted write. */
  revision: number;
}

export interface CompanyInvite {
  id: string;
  companyId: string;
  email: string;
  role: CompanyRole;
  /** SHA-256 of the invite token; the token itself is never stored. */
  tokenHash: string;
  expiresAt: Date;
  createdBy: string;
  acceptedAt?: Date | null;
  createdAt: Date;
}

/** The port's `createCompanyInvite` argument: the caller may stamp `createdAt`, otherwise the store does. */
export type CompanyInviteInput = Omit<CompanyInvite, "createdAt"> & { createdAt?: Date };

/** The port's `acceptCompanyInvite` argument (arguments are named records so the port stays readable). */
export interface AcceptCompanyInviteInput {
  invite: CompanyInvite;
  userId: string;
  acceptedAt: Date;
}

/** The port's `updateCompanyMemberRole` argument. `expectedRevision` is mandatory: no blind writes. */
export interface UpdateCompanyMemberRoleInput {
  companyId: string;
  userId: string;
  role: CompanyRole;
  expectedRevision: number;
  updatedAt: Date;
}

/** The port's `removeCompanyMember` argument. */
export interface RemoveCompanyMemberInput {
  companyId: string;
  userId: string;
}

/**
 * Membership refusal raised by a **store** (the service raises `CodeMembershipError` instead).
 *
 * The shape mirrors `CodeMembershipError` in `apps/agent-api/src/code-membership.ts`
 * (`code`, `httpStatus`, `retryable`, `details`) so a route layer can map both through one switch, and it
 * carries the codes the port contract names: `membership_not_found` (404) and
 * `membership_revision_conflict` (409, `details: { expectedRevision, actualRevision }`) — the same values
 * `CodeMembershipService` sees from an injected store.
 *
 * It extends `WorkspaceAccessError` on purpose: the tree-wide route mappers already recognise that class
 * (and map a "changed by another request" message to 409), so the precise refusal is never reported as an
 * unexpected 500. It is used for the store-side safety refusals as well: an expired or already-used invite
 * reaching the store, the only owner being demoted or removed, a duplicate invite token hash and an
 * unknown role.
 */
export class CompanyMembershipError extends WorkspaceAccessError {
  override readonly code: string;
  override readonly status: number;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { httpStatus?: number; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "CompanyMembershipError";
    this.code = code;
    // Same default as `CodeMembershipError`: a refusal denies access unless it says otherwise.
    this.httpStatus = options.httpStatus ?? 403;
    this.status = this.httpStatus;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/**
 * C5b: ProviderDataPolicy records.
 *
 * These mirror `ProviderDataPolicyRecord`, `ProjectDataPolicyRecord`, `ProviderDataPolicyVersionRecord`
 * and `ProviderHostedConsentRecord` in `apps/agent-api/src/provider-data-policy.ts` **structurally** —
 * the workspace package cannot import the app, exactly like the C5a membership port. The app-side module
 * is the contract other agents are written against, so field names, optionality and types must stay in
 * sync; `DataClassification` is reused verbatim so there is one classification vocabulary in the tree.
 *
 * Semantics the store must not soften:
 * - `companyId === null` on a policy means "platform default, applies to every company"; a non-null value
 *   means that tenant only. Tenant isolation is by `companyId`, never by the caller's convenience.
 * - `modelPattern === null` means "the whole provider"; a value scopes the policy to matching models.
 * - `policyVersion` is monotonic and must be bumped by the store, which also appends the snapshot that the
 *   version refers to. A write whose `expectedPolicyVersion` does not match is refused, never merged.
 * - A project policy with no row is `confidential` — the record type has no "unspecified" state, because
 *   the default must be a value, not an absence.
 * - A hosted-provider consent with `revokedAt !== null` counts as **no** consent.
 */
export type ProviderDataPolicyKind = "hosted_third_party" | "self_hosted" | "local";
export const PROVIDER_DATA_POLICY_KINDS: readonly ProviderDataPolicyKind[] =
  ["hosted_third_party", "self_hosted", "local"] as const;
export type ProviderTrainingPolicy = "no_training" | "may_train" | "unknown";
export const PROVIDER_TRAINING_POLICIES: readonly ProviderTrainingPolicy[] =
  ["no_training", "may_train", "unknown"] as const;
export type ProviderRedactionKind = "secrets" | "tokens" | "keys" | "pii" | "email" | "internal_hostnames";
export const PROVIDER_REDACTION_KINDS: readonly ProviderRedactionKind[] =
  ["secrets", "tokens", "keys", "pii", "email", "internal_hostnames"] as const;
/** Redaction no policy may switch off (mirrored in the app-side validator). */
export const MANDATORY_PROVIDER_REDACTIONS: readonly ProviderRedactionKind[] =
  ["secrets", "tokens", "keys"] as const;
export type ProviderContentType =
  | "metadata" | "prompt" | "code" | "diff" | "files" | "logs" | "terminal" | "web" | "embeddings";
export const PROVIDER_CONTENT_TYPES: readonly ProviderContentType[] =
  ["metadata", "prompt", "code", "diff", "files", "logs", "terminal", "web", "embeddings"] as const;
export type ExternalRetention = "none" | "unknown" | `N_days:${number}`;

export function isProviderDataPolicyKind(value: unknown): value is ProviderDataPolicyKind {
  return typeof value === "string" && (PROVIDER_DATA_POLICY_KINDS as readonly string[]).includes(value);
}
export function isProviderTrainingPolicy(value: unknown): value is ProviderTrainingPolicy {
  return typeof value === "string" && (PROVIDER_TRAINING_POLICIES as readonly string[]).includes(value);
}
export function isProviderContentType(value: unknown): value is ProviderContentType {
  return typeof value === "string" && (PROVIDER_CONTENT_TYPES as readonly string[]).includes(value);
}
export function isProviderRedactionKind(value: unknown): value is ProviderRedactionKind {
  return typeof value === "string" && (PROVIDER_REDACTION_KINDS as readonly string[]).includes(value);
}
/** `none` | `unknown` | `N_days:<days>`; anything else is refused rather than stored as-is. */
export function isExternalRetention(value: unknown): value is ExternalRetention {
  return value === "none" || value === "unknown"
    || (typeof value === "string" && /^N_days:\d{1,5}$/.test(value));
}

export interface ProviderDataPolicyRecord {
  id: string;
  /** `null` = platform default for every company. */
  companyId: string | null;
  providerId: string;
  /** `null` = the whole provider. */
  modelPattern: string | null;
  policyVersion: number;
  kind: ProviderDataPolicyKind;
  allowPrivateRepoCode: boolean;
  maxDataClassification: DataClassification;
  allowPromptCaching: boolean;
  externalRetention: ExternalRetention;
  trainingPolicy: ProviderTrainingPolicy;
  /**
   * Always present in a stored row (the column is nullable, so the value is `null` rather than absent).
   * They are required-but-nullable on purpose: that is what makes `WorkspaceStore` structurally assignable
   * to the app-side `ProviderDataPolicyStorePort`, whose record mirrors this one.
   */
  region: string | null;
  jurisdiction: string | null;
  requiredRedactions: ProviderRedactionKind[];
  allowedContentTypes: ProviderContentType[];
  termsUrl: string | null;
  lastReviewedAt: Date | null;
  reviewedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** `expectedPolicyVersion: null` means "this must not exist yet"; a number means "replace exactly this". */
export interface UpsertProviderDataPolicyStoreInput {
  companyId: string | null;
  providerId: string;
  modelPattern: string | null;
  actor: string;
  kind: ProviderDataPolicyKind;
  allowPrivateRepoCode: boolean;
  maxDataClassification: DataClassification;
  allowPromptCaching: boolean;
  externalRetention: ExternalRetention;
  trainingPolicy: ProviderTrainingPolicy;
  region?: string | null;
  jurisdiction?: string | null;
  requiredRedactions?: readonly ProviderRedactionKind[];
  allowedContentTypes?: readonly ProviderContentType[];
  termsUrl?: string | null;
  lastReviewedAt?: Date | null;
  reviewedBy?: string | null;
  expectedPolicyVersion: number | null;
}

export interface ProviderDataPolicyVersionRecord {
  id: string;
  companyId: string | null;
  providerId: string;
  modelPattern: string | null;
  policyVersion: number;
  payload: unknown;
  actor: string;
  createdAt: Date;
}

export interface ProjectDataPolicyPathRule {
  pattern: string;
  classification: DataClassification;
}

export interface ProjectDataPolicyRecord {
  companyId: string;
  projectId: string;
  /** Never absent: an unconfigured project is `confidential`, not "unspecified". */
  dataClassification: DataClassification;
  pathRules: ProjectDataPolicyPathRule[];
  policyVersion: number;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertProjectDataPolicyStoreInput {
  companyId: string;
  projectId: string;
  actor: string;
  dataClassification?: DataClassification;
  pathRules?: readonly ProjectDataPolicyPathRule[];
  /** `null` = must not exist yet; a number = replace exactly that version; `undefined` = no check. */
  expectedPolicyVersion?: number | null;
  /** Path rules are validated app-side as well; the store refuses an escape rather than normalising it. */
}

export interface ProviderHostedConsentRecord {
  companyId: string;
  projectId: string;
  providerId: string;
  grantedBy: string;
  grantedAt: Date;
  /** Non-null means withdrawn, and therefore "no consent". */
  revokedAt: Date | null;
}

// --- C6a: durable Coding Agent run state ---------------------------------------------------------

/** Coarse state of one code run. `interrupted` means "the process that owned it stopped answering". */
export type CodeRunStateStatus = "running" | "interrupted" | "completed" | "failed" | "cancelled";

/**
 * Turn status. A turn that was mid-flight when its process died stays `running` in storage — the reconciler
 * is what turns it into `failed` with an `unknown_outcome`, because only it knows the lease is gone.
 */
export type CodeRunTurnStatus = "running" | "finished" | "failed";

/** `unknown_outcome` is a first-class result: "this call may or may not have landed". */
export type CodeRunToolCallOutcome = "ok" | "failed" | "unknown_outcome";

export interface CodeRunStateRecord {
  runId: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  status: CodeRunStateStatus;
  /** The turn the run reached; 0 until the first turn is recorded. */
  turnIndex: number;
  /** Monotonic per run. Every state write carries the next value, which is what makes a write idempotent. */
  lastEventSeq: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  details: Record<string, unknown>;
  revision: number;
}

/**
 * One tool call inside a turn. `readOnly` is recorded **by the caller** (the runner's explicit list) rather
 * than inferred later: it is the single fact that decides whether a recovery may replay the call, so it has to
 * be the same judgement the live run made.
 */
export interface CodeRunToolCallRecord {
  toolCallId: string;
  tool: string;
  readOnly: boolean;
  outcome: CodeRunToolCallOutcome;
  startedAt: Date;
  finishedAt: Date | null;
  errorCode?: string;
}

export interface CodeRunTurnRecord {
  runId: string;
  companyId: string;
  turnIndex: number;
  status: CodeRunTurnStatus;
  outcome: CodeRunToolCallOutcome | null;
  toolCalls: CodeRunToolCallRecord[];
  /** Bounded, metadata-only snapshot of the turn (paths, ids and counts — never file contents). */
  messages: unknown[];
  results: unknown[];
  checkpointId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface CreateCodeRunStateInput {
  runId: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  /** This process's lease identity. */
  owner: string;
  /** Lease TTL in milliseconds; the row is created already leased by `owner`. */
  leaseMs: number;
  now: Date;
  details?: Record<string, unknown>;
}

export interface ApplyCodeRunStateEventInput {
  companyId: string;
  runId: string;
  /**
   * Monotonic per-run sequence. A write whose sequence is not greater than the stored one is **ignored**
   * (returned state unchanged), which is what makes a retried write harmless.
   */
  seq: number;
  status?: CodeRunStateStatus;
  turnIndex?: number;
  heartbeatAt?: Date;
  finishedAt?: Date | null;
  details?: Record<string, unknown>;
  /**
   * Lease transition applied atomically with the rest of the patch:
   * - `acquire` succeeds only when the lease is free, expired or already ours;
   * - `renew` succeeds only for the current owner;
   * - `release` clears the lease only for the current owner.
   * A refused transition leaves the row untouched (it is not an error: the caller learns from `leaseOwner`).
   */
  lease?: { mode: "acquire" | "renew" | "release"; owner: string; now: Date; leaseMs?: number };
}

export interface UpsertCodeRunTurnInput {
  runId: string;
  companyId: string;
  turnIndex: number;
  status: CodeRunTurnStatus;
  outcome?: CodeRunToolCallOutcome | null;
  toolCalls?: readonly CodeRunToolCallRecord[];
  messages?: readonly unknown[];
  results?: readonly unknown[];
  checkpointId?: string | null;
  startedAt?: Date;
  finishedAt?: Date | null;
}

/**
 * A bounded, keyset-paginated scan. `nextCursor === null` means the scan reached the end of the matching set;
 * a non-null cursor means "there may be more", which is why the caller must page rather than assume it saw
 * everything.
 */
export interface CodeRunScanPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CodeRunStateScanInput {
  /** `null` is the system scope and is only for the reaper/reconciler; every other caller passes a company. */
  companyId: string | null;
  /** Only rows started strictly before this instant are considered. */
  startedBefore: Date;
  limit: number;
  cursor?: string | null;
}

export interface CodeRunTurnScanInput extends CodeRunStateScanInput {
  /** Turn statuses to include; a stuck tool call only ever lives in a turn that has not closed. */
  statuses?: readonly CodeRunTurnStatus[];
}

/**
 * Merges tool calls by `toolCallId`: a call that is recorded again (for example "started, then finished")
 * replaces its previous entry instead of adding a second one. The order is the order of first appearance,
 * which is the order the model asked for them in.
 */
export function mergeCodeRunToolCalls(
  existing: readonly CodeRunToolCallRecord[],
  incoming: readonly CodeRunToolCallRecord[],
): CodeRunToolCallRecord[] {
  const merged = new Map<string, CodeRunToolCallRecord>();
  for (const call of existing) merged.set(call.toolCallId, call);
  for (const call of incoming) {
    const previous = merged.get(call.toolCallId);
    if (!previous) {
      merged.set(call.toolCallId, call);
      continue;
    }
    // `readOnly` is a fact about the tool, never something a later write may flip — it is what decides whether
    // a recovery is allowed to replay the call, so the live run's judgement wins.
    // A terminal outcome is likewise never downgraded to `unknown_outcome`: the write-ahead record exists to
    // say "we do not know yet", not to erase a result that was already observed.
    const outcome = previous.outcome !== "unknown_outcome" && call.outcome === "unknown_outcome"
      ? previous.outcome
      : call.outcome;
    merged.set(call.toolCallId, { ...call, readOnly: previous.readOnly, outcome });
  }
  return [...merged.values()];
}

/**
 * A terminal outcome wins over a later `unknown_outcome`: recording "we no longer know" must never erase a
 * result that was already observed, and `unknown_outcome` may only be set when nothing better exists.
 */
export function mergeCodeRunTurnOutcome(
  existing: CodeRunToolCallOutcome | null,
  incoming: CodeRunToolCallOutcome | null,
): CodeRunToolCallOutcome | null {
  if (incoming === null) return existing;
  if (existing === null) return incoming;
  if (existing === "unknown_outcome") return incoming;
  return existing;
}

/** True when the outcome means "this call may or may not have landed". */
export function isUnknownOutcome(outcome: CodeRunToolCallOutcome | null): boolean {
  return outcome === "unknown_outcome";
}

/**
 * Keyset cursor for the run scans: the position of the last row of a page. It is deliberately opaque to
 * callers so the ordering can change without breaking a reaper that kept a cursor across a restart. It is
 * URI-encoded JSON rather than base64 on purpose: `types.ts` is shared with the web app, and reaching for a
 * Node-only global here would make the module unusable in a browser bundle.
 */
export interface CodeRunScanCursor {
  startedAt: string;
  runId: string;
  turnIndex: number;
}

export function encodeCodeRunScanCursor(cursor: CodeRunScanCursor): string {
  return encodeURIComponent(JSON.stringify(cursor));
}

export function decodeCodeRunScanCursor(value: string | null | undefined): CodeRunScanCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<CodeRunScanCursor>;
    if (typeof parsed.startedAt !== "string" || typeof parsed.runId !== "string" || typeof parsed.turnIndex !== "number") {
      return null;
    }
    return { startedAt: parsed.startedAt, runId: parsed.runId, turnIndex: parsed.turnIndex };
  } catch {
    // An unreadable cursor is treated as "start from the beginning" rather than as an error: a reaper that
    // kept a cursor across a deployment must still make progress.
    return null;
  }
}

/** Hard upper bound on one scan page. A caller asking for more is clamped, never obeyed. */
export const MAX_CODE_RUN_SCAN_LIMIT = 500;

export function clampScanLimit(limit: number | undefined, fallback = 100): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(MAX_CODE_RUN_SCAN_LIMIT, Math.floor(limit)));
}

/**
 * Storage refusal for the run-state tables. It extends `WorkspaceAccessError` so the existing route mappers
 * report a precise code instead of a 500.
 */
export class CodeRunStateStoreError extends WorkspaceAccessError {
  override readonly code: string;
  override readonly status: number;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { httpStatus?: number; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "CodeRunStateStoreError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? 403;
    this.status = this.httpStatus;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/**
 * Storage refusal for the policy tables. It extends `WorkspaceAccessError` for the same reason the C5a
 * membership errors do: the tree-wide route mappers already recognise that class, so a precise refusal is
 * never reported as an unexpected 500. Codes mirror the app-side `ProviderDataPolicyError`
 * (`data_policy_not_found` 404, `data_policy_revision_conflict` 409, and the validation codes 400).
 */
export class ProviderDataPolicyStoreError extends WorkspaceAccessError {
  override readonly code: string;
  override readonly status: number;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { httpStatus?: number; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ProviderDataPolicyStoreError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? 403;
    this.status = this.httpStatus;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
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

  /** C1b: sandbox image catalogue. Admission reads it; allow/revoke/waiver write it (audited first). */
  listSandboxImages(context: AuthContext): Promise<SandboxImage[]>;
  getSandboxImage(context: AuthContext, reference: string): Promise<SandboxImage | null>;
  upsertSandboxImage(context: AuthContext, input: SandboxImageInput): Promise<SandboxImage>;
  revokeSandboxImage(context: AuthContext, reference: string, input: { actor: string; reason: string }): Promise<SandboxImage>;
  latestVerifiedSandboxImage(context: AuthContext, variant: SandboxImageVariant): Promise<SandboxImage | null>;

  /**
   * C5: scoped approval rules (`session` | `project`). A rule widens an approval inside a bounded
   * scope; it can never widen a prohibition, because hard deny, the network gate and the session-mode
   * denial are decided in earlier policy phases than the approval phase that consults these rules.
   */
  createCodeApprovalRule(context: AuthContext, companyId: string, input: CodeApprovalRuleInput): Promise<CodeApprovalRule>;
  listCodeApprovalRules(context: AuthContext, companyId: string, filters?: { projectId?: string; sessionId?: string; scope?: CodeApprovalRuleScope }): Promise<CodeApprovalRule[]>;
  deleteCodeApprovalRule(context: AuthContext, companyId: string, ruleId: string): Promise<void>;
  findMatchingCodeApprovalRule(context: AuthContext, query: { companyId: string; projectId?: string | null; sessionId?: string | null; action: string }): Promise<CodeApprovalRule | null>;


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
  updateCodeSession(context: AuthContext, companyId: string, sessionId: string, patch: { status?: CodeSessionStatus; summary?: string; runId?: string | null; modelProfile?: string; dataClassification?: DataClassification; retentionClass?: RetentionClass; toolManifestVersion?: number | null; mode?: CodeSessionMode; expectedRevision?: number }): Promise<CodeSession>;

  /** C5: project trust. Owner/admin only at the API layer; the store is the single writer. */
  getProjectCodeTrust(context: AuthContext, companyId: string, projectId: string): Promise<ProjectCodeTrust | null>;
  setProjectCodeTrust(context: AuthContext, companyId: string, projectId: string, input: ProjectCodeTrustInput): Promise<ProjectCodeTrust>;
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

  /**
   * C5a: company membership and invites — the `CodeMembershipStore` port from
   * `apps/agent-api/src/code-membership.ts`, mirrored verbatim so a `WorkspaceStore` can be injected into
   * `CodeMembershipService` without an adapter. These methods are company-scoped (not workspace/user
   * scoped) and deliberately take no `AuthContext`: membership **is** the authorisation anchor, and the
   * service has already resolved the acting principal and the company.
   *
   * Invariants every implementation must keep:
   * - No row means `null` — never a default role and never "owner by default".
   * - `getCompanyMembership` / `listCompanyMembers` return the **actual** stored role and status.
   * - `acceptCompanyInvite` re-reads the invite and refuses one that is expired or already accepted.
   * - `updateCompanyMemberRole` refuses a stale `expectedRevision` and any change that would leave the
   *   company without an active owner; `removeCompanyMember` refuses the same for the last active owner.
   */
  getCompanyMembership(companyId: string, userId: string): Promise<CompanyMember | null>;
  listCompanyMembers(companyId: string): Promise<CompanyMember[]>;
  /** Active owners only: a suspended owner cannot administer anything, so it cannot be the protection. */
  countCompanyOwners(companyId: string): Promise<number>;
  createCompanyInvite(input: CompanyInviteInput): Promise<CompanyInvite>;
  findCompanyInviteByTokenHash(tokenHash: string): Promise<CompanyInvite | null>;
  acceptCompanyInvite(input: AcceptCompanyInviteInput): Promise<CompanyMember>;
  updateCompanyMemberRole(input: UpdateCompanyMemberRoleInput): Promise<CompanyMember>;
  removeCompanyMember(input: RemoveCompanyMemberInput): Promise<void>;

  /**
   * C5b: ProviderDataPolicy storage — company-scoped, no `AuthContext`, mirroring the C5a convention:
   * the caller (an app-side service) has already resolved the principal and the company, and the policy
   * tables are the authorisation *subject*, not the authorisation check.
   *
   * Invariants every implementation must keep:
   * - a read with no row returns `null`: absence is never a permissive policy;
   * - `upsertProviderDataPolicy` bumps `policyVersion` (previous + 1, starting at 1), appends the full
   *   snapshot to the history table with the given `actor`, and refuses a mismatch against
   *   `expectedPolicyVersion` (`data_policy_revision_conflict`, 409) instead of merging;
   * - `upsertProviderDataPolicy` refuses a `requiredRedactions` list that omits secrets/tokens/keys, and an
   *   unknown kind/classification/training policy/retention/content type (`invalid_*`, 400);
   * - every method is scoped by `companyId`; a row of another company is never read, listed or written;
   * - `getHostedProviderConsent` returns the row whatever its state, and a row with `revokedAt` set counts
   *   as no consent for callers.
   */
  getProviderDataPolicy(input: {
    companyId: string | null;
    providerId: string;
    modelPattern: string | null;
  }): Promise<ProviderDataPolicyRecord | null>;
  listProviderDataPolicies(companyId: string | null): Promise<ProviderDataPolicyRecord[]>;
  upsertProviderDataPolicy(input: UpsertProviderDataPolicyStoreInput): Promise<ProviderDataPolicyRecord>;
  listProviderDataPolicyVersions(
    companyId: string | null,
    providerId?: string,
  ): Promise<ProviderDataPolicyVersionRecord[]>;
  getProjectDataPolicy(companyId: string, projectId: string): Promise<ProjectDataPolicyRecord | null>;
  upsertProjectDataPolicy(input: UpsertProjectDataPolicyStoreInput): Promise<ProjectDataPolicyRecord>;
  grantHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
    grantedBy: string;
    grantedAt: Date;
  }): Promise<ProviderHostedConsentRecord>;
  revokeHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
    revokedAt: Date;
  }): Promise<ProviderHostedConsentRecord>;
  getHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
  }): Promise<ProviderHostedConsentRecord | null>;

  /**
   * C6a: durable Coding Agent run state. Company-scoped like the C5a/C5b tables (the app-side
   * `CodeRunStateLog` has already resolved the principal), with one deliberate system-wide exception noted
   * below.
   *
   * Invariants every implementation must keep:
   * - `createCodeRunState` is idempotent by `runId`: a retried create returns the existing row rather than
   *   resetting its cursor or stealing its lease;
   * - `applyCodeRunStateEvent` is idempotent by `seq`: a write whose sequence is not greater than the stored
   *   `lastEventSeq` changes nothing and returns the stored row;
   * - a lease transition (`acquire`/`renew`/`release`) is applied in the same statement as the rest of the
   *   patch and is refused (row untouched) when another owner holds a live lease;
   * - `upsertCodeRunTurn` is idempotent by (`runId`, `turnIndex`): re-recording the same turn merges the
   *   given tool calls by `toolCallId` instead of duplicating them, and never downgrades a terminal outcome
   *   back to `unknown_outcome`;
   * - reads are scoped by `companyId`: a run of another company is never returned;
   * - `listStaleCodeRunStates` is the **only** system-wide read (the reconciler is a system process); every
   *   subsequent write in that flow is scoped by the `companyId` of the row it just read.
   */
  createCodeRunState(input: CreateCodeRunStateInput): Promise<CodeRunStateRecord>;
  applyCodeRunStateEvent(input: ApplyCodeRunStateEventInput): Promise<CodeRunStateRecord>;
  getCodeRunState(companyId: string, runId: string): Promise<CodeRunStateRecord | null>;
  listStaleCodeRunStates(input: { now: Date; limit: number }): Promise<CodeRunStateRecord[]>;
  upsertCodeRunTurn(input: UpsertCodeRunTurnInput): Promise<CodeRunTurnRecord>;
  getCodeRunTurn(companyId: string, runId: string, turnIndex: number): Promise<CodeRunTurnRecord | null>;
  listCodeRunTurns(companyId: string, runId: string): Promise<CodeRunTurnRecord[]>;
  /**
   * Read-only keyset scans for the run reaper. Both are tenant-scoped (`companyId: null` is the documented
   * system scope) and bounded: they never return more than `limit` rows and hand back a cursor when more may
   * follow, so a reaper cannot pull an unbounded result set into memory on a busy deployment.
   */
  listCodeRunStatesForScan(input: CodeRunStateScanInput): Promise<CodeRunScanPage<CodeRunStateRecord>>;
  listCodeRunTurnsForScan(input: CodeRunTurnScanInput): Promise<CodeRunScanPage<CodeRunTurnRecord>>;

  // --- C6b: immutable execution snapshots and versioned configuration -------------------------------
  /**
   * Snapshots are append-only: `create` refuses to touch an existing row and there is no update or delete
   * method at all, so the only way to change what the system looked like is to record a new snapshot.
   */
  createExecutionSnapshot(input: CreateExecutionSnapshotInput): Promise<ExecutionSnapshotRecord>;
  getExecutionSnapshot(companyId: string, snapshotId: string): Promise<ExecutionSnapshotRecord | null>;
  /** The newest snapshot of a session, or `null` when the session predates C6b (`legacy_no_snapshot`). */
  getLatestSnapshotForSession(companyId: string, sessionId: string): Promise<ExecutionSnapshotRecord | null>;
  getSnapshotForRun(companyId: string, runId: string): Promise<ExecutionSnapshotRecord | null>;
  listExecutionSnapshots(input: ListExecutionSnapshotsInput): Promise<ExecutionSnapshotRecord[]>;
  /** Structural diff of two snapshots, metadata only. Never returns values from the payload verbatim. */
  diffExecutionSnapshots(a: ExecutionSnapshotRecord, b: ExecutionSnapshotRecord): ExecutionSnapshotDiff;
  /** Config versions are immutable: identical content returns the existing version instead of a new one. */
  createSnapshotConfigVersion(input: CreateSnapshotConfigVersionInput): Promise<SnapshotConfigVersionRecord>;
  getSnapshotConfigVersion(companyId: string, kind: SnapshotConfigKind, version: number): Promise<SnapshotConfigVersionRecord | null>;
  findSnapshotConfigVersionByHash(companyId: string, kind: SnapshotConfigKind, contentHash: string): Promise<SnapshotConfigVersionRecord | null>;
  listSnapshotConfigVersions(companyId: string, kind: SnapshotConfigKind): Promise<SnapshotConfigVersionRecord[]>;

  // --- C6b: durable Activity events referencing their snapshot ---------------------------------------
  /**
   * Append-only: there is no update or delete method for activity events. `snapshotId` is optional because
   * events from before C6b (or from a path outside any run) have no snapshot, and storing a fabricated id
   * would be worse than storing none.
   */
  createCodeActivityEvent(input: CreateCodeActivityEventInput): Promise<CodeActivityEventRecord>;
  /** Newest first. Tenant-scoped; filters by session, run or snapshot when given. */
  listCodeActivityEvents(input: ListCodeActivityEventsInput): Promise<CodeActivityEventRecord[]>;

  // --- C8: durable context summaries --------------------------------------------------------------------
  /**
   * Append-only: there is no update or delete method, and migration 079 refuses both at the database level.
   * A summary that could be rewritten would misrepresent what the model was actually given during the run it
   * describes. `contentHash` is the hash of the exact compacted message list, which is what ties the stored
   * artifact to reproducible replay input (C6b).
   */
  createCodeContextSummary(input: CreateCodeContextSummaryInput): Promise<CodeContextSummaryRecord>;
  /** Newest first, tenant-scoped; filters by session or run when given. */
  listCodeContextSummaries(input: ListCodeContextSummariesInput): Promise<CodeContextSummaryRecord[]>;

  // --- C6b: versioned replay bundles -------------------------------------------------------------------
  /**
   * Writes a bundle header together with its ordered steps. Both tables are append-only, so there is no
   * update or delete method. Idempotent by `(runId, bundleVersion)`: recording the same run twice returns the
   * stored bundle instead of appending a second one.
   */
  createReplayBundle(input: CreateReplayBundleInput): Promise<ReplayBundleRecord>;
  /** The bundle of a run; without `bundleVersion` the newest one is returned. */
  getReplayBundle(companyId: string, runId: string, bundleVersion?: number): Promise<ReplayBundleRecord | null>;
  /**
   * The same bundle addressed by its own id, which is what a replay status endpoint and the UI hold.
   * Tenant-scoped: a bundle of another company is simply not found.
   */
  getReplayBundleById(companyId: string, bundleId: string): Promise<ReplayBundleRecord | null>;
  /** Newest first, tenant-scoped. */
  listReplayBundles(input: ListReplayBundlesInput): Promise<ReplayBundleRecord[]>;
  /** Steps in the recorded (executed) order. */
  listReplayBundleSteps(companyId: string, bundleId: string): Promise<ReplayBundleStepRecord[]>;
}

// --- C6b snapshot DTOs (declared after the interface on purpose: TypeScript hoists them) --------------

export type ExecutionSnapshotTrigger =
  | "session_start"
  | "run_start"
  | "config_change"
  | "resume"
  | "recovery";

export type SnapshotConfigKind = "system_prompt" | "model_profiles";

export interface ExecutionSnapshotRecord {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string | null;
  snapshotVersion: number;
  payload: Record<string, unknown>;
  payloadHash: string;
  prevSnapshotId: string | null;
  prevPayloadHash: string | null;
  trigger: ExecutionSnapshotTrigger;
  legacy: boolean;
  createdAt: Date;
  createdBy: string;
}

export interface CreateExecutionSnapshotInput {
  companyId: string;
  workspaceId: string;
  projectId: string;
  sessionId: string;
  runId?: string | null;
  payload: Record<string, unknown>;
  trigger: ExecutionSnapshotTrigger;
  createdBy: string;
  legacy?: boolean;
  /** Injectable clock so tests never depend on wall time. */
  now?: Date;
  /** Injectable id generator; production uses a random id, tests use a deterministic one. */
  id?: string;
}

export interface ListExecutionSnapshotsInput {
  companyId: string;
  sessionId?: string;
  projectId?: string;
  limit: number;
}

export interface SnapshotFieldChange {
  field: string;
  /** Rendered as a short, secret-free string ("v1 -> v2", "false -> true", "changed", "added", "removed"). */
  from: string;
  to: string;
}

export interface ExecutionSnapshotDiff {
  fromSnapshotId: string;
  toSnapshotId: string;
  fromVersion: number;
  toVersion: number;
  changes: SnapshotFieldChange[];
  unchanged: string[];
}

export interface SnapshotConfigVersionRecord {
  id: string;
  workspaceId: string;
  companyId: string;
  kind: SnapshotConfigKind;
  version: number;
  contentHash: string;
  content: Record<string, unknown>;
  createdAt: Date;
  createdBy: string;
}

export interface CreateSnapshotConfigVersionInput {
  companyId: string;
  workspaceId: string;
  kind: SnapshotConfigKind;
  content: Record<string, unknown>;
  contentHash: string;
  createdBy: string;
  now?: Date;
  id?: string;
}

/** Raised when a caller tries to mutate an append-only snapshot or config version. */
export class ExecutionSnapshotImmutableError extends Error {
  readonly code = "snapshot_immutable";
  readonly httpStatus = 409;
  constructor(operation: string) {
    super(`Execution snapshots are append-only: ${operation} is not permitted`);
    this.name = "ExecutionSnapshotImmutableError";
  }
}

// --- C6b Activity event persistence -------------------------------------------------------------------

/**
 * The Activity event families the Coding Agent produces. The database CHECK states the same vocabulary in
 * migration 077, so an unknown kind cannot be persisted even by a direct SQL write.
 */
export type CodeActivityEventKind =
  | "code_tool_activity"
  | "policy_decision"
  | "network_decision"
  | "run_activity"
  | "run_reconcile";

export interface CodeActivityEventRecord {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string | null;
  sessionId: string | null;
  runId: string | null;
  /** Snapshot this event belongs to; `null` for events produced before C6b or outside a run. */
  snapshotId: string | null;
  kind: CodeActivityEventKind;
  /** Metadata only. Content-like keys are rejected before the insert (see `code-run-activity-sink.ts`). */
  payload: Record<string, unknown>;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
  createdAt: Date;
}

export interface CreateCodeActivityEventInput {
  companyId: string;
  workspaceId: string;
  projectId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  snapshotId?: string | null;
  kind: CodeActivityEventKind;
  payload: Record<string, unknown>;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
  id?: string;
}

export interface ListCodeActivityEventsInput {
  companyId: string;
  sessionId?: string;
  runId?: string;
  snapshotId?: string;
  limit?: number;
  cursor?: string;
}

/** C8: the structured summary produced by conversation compaction (see `code-conversation-compaction.ts`). */
export interface CodeContextSummaryRecord {
  id: string;
  companyId: string;
  projectId: string;
  sessionId: string | null;
  runId: string | null;
  snapshotId: string | null;
  turnIndex: number;
  schemaVersion: number;
  summary: Record<string, unknown>;
  summaryText: string;
  contentHash: string;
  dataClassification: DataClassification;
  /** Deliberately shorter than the transcript: a summary is derived, so outliving its source buys nothing. */
  retentionClass: RetentionClass;
  createdAt: Date;
}

export interface CreateCodeContextSummaryInput {
  companyId: string;
  projectId: string;
  sessionId?: string | null;
  runId?: string | null;
  snapshotId?: string | null;
  turnIndex?: number;
  schemaVersion: number;
  summary: Record<string, unknown>;
  summaryText: string;
  contentHash: string;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
  id?: string;
}

export interface ListCodeContextSummariesInput {
  companyId: string;
  sessionId?: string;
  runId?: string;
  limit?: number;
}

/**
 * Keyset cursor for activity reads: `(created_at, id)`, so paging never depends on an offset that shifts
 * while new events are appended. Malformed input is rejected instead of silently restarting from page one.
 */
export function encodeCodeActivityCursor(input: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: input.createdAt.toISOString(), i: input.id }), "utf8").toString("base64url");
}

// --- C6b replay bundle DTOs ---------------------------------------------------------------------------

/**
 * How a bundle may be replayed. `recorded` is the deterministic one: every model answer and every settled
 * tool result is present, so the same sequence is reproducible. `live_best_effort` means the run is re-issued
 * against a live model: the model, package registries, GitHub and third-party services can all have changed
 * since, so an identical outcome is **not** guaranteed and callers must say so.
 */
export type ReplayMode = "recorded" | "live_best_effort";

/** What a recorded step is. A tool-result step is the canonical, model-visible, settled result. */
export type ReplayStepKind = "model_step" | "tool_call";

export interface ReplayBundleStepRecord {
  id: string;
  bundleId: string;
  companyId: string;
  /** Monotonic per bundle; the recorded order is the executed order. */
  seq: number;
  kind: ReplayStepKind;
  turnIndex: number;
  /** Present for `tool_call` steps; `null` for model steps. */
  toolCallId: string | null;
  payload: Record<string, unknown>;
  /** Integrity of this step's payload; a rewritten step no longer matches. */
  payloadHash: string;
  createdAt: Date;
}

export interface ReplayBundleRecord {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  /** The ExecutionSnapshot this bundle belongs to, when the run had one. */
  executionSnapshotId: string | null;
  /** Version of the **bundle format** (rule 13), not of the run. */
  bundleVersion: number;
  runnerVersion: string | null;
  systemPromptVersion: number | null;
  systemPromptContentHash: string | null;
  modelProfileVersion: number | null;
  provider: string | null;
  model: string | null;
  replayMode: ReplayMode;
  /** Set for `live_best_effort` bundles: the recorded run they were re-issued from. */
  sourceRunId: string | null;
  sourceSnapshotId: string | null;
  terminalStatus: string | null;
  terminalReason: string | null;
  /** Summary: step counts, the replay-input hash and the environment the replay must match. No content. */
  payload: Record<string, unknown>;
  payloadHash: string;
  /** Hash of the replay **input** (steps, excluding non-input artifacts such as raw output references). */
  replayInputHash: string;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
  createdAt: Date;
}

export interface CreateReplayBundleStepInput {
  id?: string;
  kind: ReplayStepKind;
  turnIndex: number;
  toolCallId?: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  createdAt?: Date;
}

export interface CreateReplayBundleInput {
  id?: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  executionSnapshotId?: string | null;
  bundleVersion: number;
  runnerVersion?: string | null;
  systemPromptVersion?: number | null;
  systemPromptContentHash?: string | null;
  modelProfileVersion?: number | null;
  provider?: string | null;
  model?: string | null;
  replayMode: ReplayMode;
  sourceRunId?: string | null;
  sourceSnapshotId?: string | null;
  terminalStatus?: string | null;
  terminalReason?: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  replayInputHash: string;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  /** Written with the header in one transaction, in this order. */
  steps: CreateReplayBundleStepInput[];
  now?: Date;
}

export interface ListReplayBundlesInput {
  companyId: string;
  runId?: string;
  sessionId?: string;
  executionSnapshotId?: string;
  limit?: number;
}

export function decodeCodeActivityCursor(cursor: string): { createdAt: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new WorkspaceAccessError("Invalid activity cursor");
  }
  const value = parsed as { t?: unknown; i?: unknown };
  if (typeof value?.t !== "string" || typeof value?.i !== "string" || Number.isNaN(Date.parse(value.t))) {
    throw new WorkspaceAccessError("Invalid activity cursor");
  }
  return { createdAt: value.t, id: value.i };
}
