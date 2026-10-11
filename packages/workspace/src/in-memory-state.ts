import type { StoredUserSetting } from "./in-memory-store";
import type { Business, BusinessOnboardingSession, Company, CompanyAgent, CompanyAgentEdge, CompanyAgentRun, CompanyAgentRunEvent, CompanyAgentRunStep, CompanyAgentToolAudit, Project, ProjectCheckpoint, ProjectDeployment, ProjectQaReport, Conversation, ConversationMessage, Goal, MemoryItem, CodeSession, AuditEntry, AuditAnchor, FeatureFlag, FeatureFlagHistoryEntry, CodeToolManifest, SandboxImage, ProjectCodeTrust, ProjectMountedFolder, CodeApprovalRule, CompanyMember, CompanyInvite, ProviderDataPolicyRecord, ProviderDataPolicyVersionRecord, ProjectDataPolicyRecord, ProviderHostedConsentRecord, CodeRunStateRecord, CodeRunTurnRecord, ExecutionSnapshotRecord, SnapshotConfigVersionRecord, CodeActivityEventRecord, ReplayBundleRecord, ReplayBundleStepRecord, CodeContextSummaryRecord, CodeRunRequestRecord } from "./types";

/**
 * The shared state of the in-memory workspace store: every map, set and record the store holds.
 * The per-domain modules take this one shape, so a module can call another module's helper without
 * the two hosts having to be structurally identical by accident.
 */
export interface InMemoryStoreState {
  codeProcesses: any;
  codeInbox: any;
  identities: Map<string, { displayName: string; workspaceName: string; role: string }>;
  businesses: Map<string, Business>;
  companies: Map<string, Company>;
  companyAgents: Map<string, CompanyAgent>;
  projects: Map<string, Project>;
  codeSessions: Map<string, CodeSession>;
  projectCodeTrust: Map<string, ProjectCodeTrust>;
  projectMountedFolders: Map<string, ProjectMountedFolder>;
  auditLog: Map<string, AuditEntry[]>;
  auditAnchors: Map<string, AuditAnchor[]>;
  featureFlags: Map<string, FeatureFlag>;
  featureFlagHistory: FeatureFlagHistoryEntry[];
  codeToolManifests: Map<number, CodeToolManifest>;
  sandboxImages: Map<string, SandboxImage>;
  platformOps: any;
  codeApprovalRules: Map<string, CodeApprovalRule>;
  providerDataPolicies: Map<string, ProviderDataPolicyRecord>;
  providerDataPolicyVersions: ProviderDataPolicyVersionRecord[];
  projectDataPolicies: Map<string, ProjectDataPolicyRecord>;
  hostedProviderConsent: Map<string, ProviderHostedConsentRecord>;
  dataPolicyOps: any;
  projectCreateRequests: Map<string, string>;
  projectCheckpoints: Map<string, ProjectCheckpoint>;
  projectDeployments: Map<string, ProjectDeployment>;
  projectQaReports: Map<string, ProjectQaReport>;
  companyEdges: Map<string, CompanyAgentEdge>;
  companyRuns: Map<string, CompanyAgentRun>;
  companyRunPendingPlans: Map<string, unknown>;
  companyRunSteps: Map<string, CompanyAgentRunStep>;
  companyToolAudit: Map<string, CompanyAgentToolAudit>;
  companyRunEvents: Map<string, CompanyAgentRunEvent>;
  companyRunRequests: Map<string, string>;
  companyCreateRequests: Map<string, string>;
  companyAgentCreateRequests: Map<string, string>;
  current: Map<string, string>;
  goals: Map<string, Goal>;
  memories: Map<string, MemoryItem>;
  conversations: Map<string, Conversation>;
  messages: Map<string, ConversationMessage>;
  userSettings: Map<string, StoredUserSetting>;
  businessCreateRequests: Map<string, string>;
  onboardings: Map<string, Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField">>;
  companyMembers: Map<string, CompanyMember>;
  companyInvites: Map<string, CompanyInvite>;
  companyMembershipOps: any;
  codeRunStates: Map<string, CodeRunStateRecord>;
  codeRunTurns: Map<string, CodeRunTurnRecord>;
  codeRunRequests: Map<string, CodeRunRequestRecord>;
  executionSnapshots: Map<string, ExecutionSnapshotRecord>;
  snapshotConfigVersions: Map<string, SnapshotConfigVersionRecord>;
  codeActivityEvents: Map<string, CodeActivityEventRecord>;
  codeContextSummaries: Map<string, CodeContextSummaryRecord>;
  replayBundles: Map<string, ReplayBundleRecord>;
  replayBundleSteps: Map<string, ReplayBundleStepRecord[]>;
  codeRunOps: any;
  codeGoalState: any;
  codeUserQuestionState: any;
  codeSessionDurabilityState: any;
}
