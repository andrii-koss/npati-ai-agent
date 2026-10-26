
import type { AuthContext, Business, BusinessInput, BusinessOnboardingSession, BusinessToCompanyInput, Company, CompanyAgent, CompanyAgentEdge, CompanyAgentInput, CompanyAgentRun, CompanyAgentRunEvent, CompanyAgentRunStep, CompanyAgentToolAudit, CompanyInput, Project, ProjectCheckpoint, CreateCheckpointInput, ProjectDeployment, CreateDeploymentInput, ProjectQaReport, CreateProjectQaReportInput, ProjectInput, ProjectStatus, Conversation, ConversationMessage, Goal, GoalInput, MemoryInput, MemoryItem, OnboardingScenario, WorkspaceOverview, WorkspaceStore, CodeSession, CodeSessionInput, CodeSessionMode, CodeSessionStatus, ProjectCodeSettings, ProjectCodeTrust, ProjectCodeTrustInput, ProjectMountedFolder, ProjectMountedFolderInput, DataClassification, RetentionClass, AuditEntry, AuditEntryInput, AuditAnchor, AuditChainState, AuditChainVerification, FeatureFlag, FeatureFlagInput, FeatureFlagHistoryEntry, CodeToolManifest, SandboxImage, SandboxImageInput, SandboxImageVariant, CodeApprovalRule, CodeApprovalRuleInput, CodeApprovalRuleScope,
  CompanyMember, CompanyInvite, CompanyInviteInput, AcceptCompanyInviteInput, UpdateCompanyMemberRoleInput, RemoveCompanyMemberInput, CompanyRole,
  ProviderDataPolicyRecord, UpsertProviderDataPolicyStoreInput, ProviderDataPolicyVersionRecord, ProjectDataPolicyRecord,
  UpsertProjectDataPolicyStoreInput, ProjectDataPolicyPathRule, ProviderHostedConsentRecord,
  CodeRunStateRecord, CodeRunTurnRecord, CodeRunTurnStatus, CreateCodeRunStateInput, ApplyCodeRunStateEventInput,
  UpsertCodeRunTurnInput, CodeRunStateScanInput, CodeRunTurnScanInput, CodeRunScanPage,
  ListCodeRunStatesInput,
  CodeRunRequestRecord,
  CodeProjectRefScanInput, CodeProjectRefScanPage,
  CreateExecutionSnapshotInput, ExecutionSnapshotRecord, ExecutionSnapshotTrigger, ExecutionSnapshotDiff,
  ListExecutionSnapshotsInput, SnapshotConfigKind, SnapshotConfigVersionRecord,
  CreateSnapshotConfigVersionInput, CodeActivityEventKind, CodeActivityEventRecord,
  CreateCodeActivityEventInput, ListCodeActivityEventsInput, ReplayBundleRecord, ReplayBundleStepRecord,
  ReplayMode, ReplayStepKind, CreateReplayBundleInput, ListReplayBundlesInput,
  CodeContextSummaryRecord, CreateCodeContextSummaryInput, ListCodeContextSummariesInput,
  CodeRetentionWindows, CodeDataRetentionReport, CodeDataErasureReport, CodeDataErasureTarget,
  CodeDataErasureOutcome, CodeDataFamilyOutcome, CodeDataLifecycleStore } from "./types";
import { DEFAULT_DATA_CLASSIFICATION, DEFAULT_RETENTION_CLASS, isClassificationAtLeast, isCompanyRole, isProviderDataPolicyKind, isProviderTrainingPolicy, isProviderContentType, isProviderRedactionKind, isExternalRetention, MANDATORY_PROVIDER_REDACTIONS, mergeCodeRunToolCalls, mergeCodeRunTurnOutcome, clampScanLimit, decodeCodeRunScanCursor, encodeCodeRunScanCursor, decodeCodeActivityCursor, ExecutionSnapshotImmutableError, codeRunRequestStatus, CODE_RETENTION_FAMILIES, CODE_APPEND_ONLY_EVIDENCE_FAMILIES, EXPIRABLE_RETENTION_CLASSES } from "./types";
import { auditEntryHash, verifyAuditEntries } from "./audit-chain";
import { CompanyMembershipError, ProviderDataPolicyStoreError, CodeRunStateStoreError, WorkspaceAccessError, WorkspaceNotFoundError } from "./types";

export const RETENTION_FROM: Readonly<Record<string, string>> = Object.freeze({
  code_process_projects: "code_process_projects t",
  code_session_inboxes: "code_session_inboxes t",
  code_run_turns: "code_run_turns t",
  project_checkpoints: "project_checkpoints t",
  code_run_states: "code_run_states t",
  code_session_plans: "code_session_plans t",
  code_goals: "code_goals t",
  code_session_todos: "code_session_todos t",
  code_session_rewinds: "code_session_rewinds t",
  code_session_forks: "code_session_forks t",
  code_user_questions: "code_user_questions t",
  code_session_heads: "code_session_heads t",
});

export const CODE_PROJECT_CHECKPOINT_PREDICATE =
  "company_id=$1 AND project_id=$2 AND EXISTS (SELECT 1 FROM projects p WHERE p.id=project_checkpoints.project_id AND p.company_id=$1 AND p.type='code_project')";

export const CODE_PROJECT_GUARD_FOR = (alias: string): string =>
  `EXISTS (SELECT 1 FROM projects p WHERE p.id=${alias}.project_id AND p.company_id=${alias}.company_id AND p.type='code_project')`;

export const RETENTION_AGE_COLUMN: Readonly<Record<string, string>> = Object.freeze({
  code_process_projects: "t.updated_at",
  code_session_inboxes: "t.updated_at",
  code_run_turns: "t.started_at",
  project_checkpoints: "t.created_at",
  code_run_states: "t.started_at",
  code_session_plans: "t.created_at",
  code_goals: "t.updated_at",
  code_session_todos: "t.updated_at",
  code_session_rewinds: "t.created_at",
  code_session_forks: "t.created_at",
  code_user_questions: "t.created_at",
  code_session_heads: "t.updated_at",
});

export const RETENTION_EXTRA_PREDICATE: Readonly<Record<string, string>> = Object.freeze({
  code_process_projects: CODE_PROJECT_GUARD_FOR("t") + " AND t.state->>'cleanupToken' IS NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.state->'operations') op WHERE (op->>'state' IN ('accepted','preparing','dispatching','running','interrupted','unknown_outcome') OR (op->'completion' IS NOT NULL AND op->'completion'->'admission' IS NULL)))",
  code_session_inboxes: CODE_PROJECT_GUARD_FOR("t") + " AND NOT EXISTS (SELECT 1 FROM code_run_states r WHERE r.company_id=t.company_id AND r.session_id=t.session_id AND r.status IN ('running','waiting_for_user')) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.state->'messages') m WHERE m->>'status' IN ('pending','claimed'))",
  project_checkpoints: CODE_PROJECT_GUARD_FOR("t"),
  code_run_states: CODE_PROJECT_GUARD_FOR("t") + " AND NOT EXISTS (SELECT 1 FROM code_process_projects p, jsonb_array_elements(p.state->'operations') op WHERE p.company_id=t.company_id AND (op->>'runId'=t.run_id OR op->'child'->>'runId'=t.run_id) AND (op->>'state' IN ('accepted','preparing','dispatching','running','interrupted','unknown_outcome') OR (op->'completion' IS NOT NULL AND op->'completion'->'admission' IS NULL)))",
  code_session_plans: CODE_PROJECT_GUARD_FOR("t"),
  code_goals: CODE_PROJECT_GUARD_FOR("t"),
  code_session_todos: CODE_PROJECT_GUARD_FOR("t"),
  code_session_rewinds: CODE_PROJECT_GUARD_FOR("t"),
  code_session_forks: CODE_PROJECT_GUARD_FOR("t"),
});

export const SQL_FRAGMENT_SHAPE = /^[A-Za-z0-9_$.(),*=<>!:'\- ]+$/;

export function assertSqlFragment(fragment: string, what: string): string {
  if (!SQL_FRAGMENT_SHAPE.test(fragment)) {
    throw new CodeRunStateStoreError("code_data_lifecycle_sql_fragment_invalid", `The mapped ${what} is not a plain SQL fragment`);
  }
  return fragment;
}

/**
 * The retention rule, as one SQL expression over the row's **own** class. `$2`–`$5` are the four windows
 * (ephemeral, tool-result, transcript, extended) and `$6` is "now"; `$1` is the Company id (or `NULL` for the
 * reaper's cross-tenant sweep) and `$7` the list of expirable classes. A class that is not in that list fails
 * the `= ANY` test and is therefore never expired — which is how `until_deleted` means "until the user deletes
 * it" rather than "the clock decides".
 */
export const RETENTION_WINDOW_EXPR =
  "($6::timestamptz - make_interval(days => CASE t.retention_class" +
  " WHEN 'ephemeral' THEN $2::int WHEN 'short' THEN $3::int WHEN 'standard' THEN $4::int WHEN 'extended' THEN $5::int" +
  " ELSE 2147483647 END))";

/** The families an erasure deletes, keyed by table. Keys are exactly `CODE_RETENTION_FAMILIES`. */
export const ERASE_FROM: Readonly<Record<string, string>> = Object.freeze({
  code_process_projects: "code_process_projects",
  code_session_inboxes: "code_session_inboxes",
  code_run_turns: "code_run_turns",
  project_checkpoints: "project_checkpoints",
  code_run_states: "code_run_states",
  code_session_plans: "code_session_plans",
  code_goals: "code_goals",
  code_session_todos: "code_session_todos",
  code_session_rewinds: "code_session_rewinds",
  code_session_forks: "code_session_forks",
  code_user_questions: "code_user_questions",
  code_session_heads: "code_session_heads",
});

/** `table → the scope predicate for a delete` with `$1` the Company id and `$2` the session id. */
export const ERASE_SCOPE_PREDICATE: Readonly<Record<string, string>> = Object.freeze({
  code_process_projects: "company_id=$1 AND project_id=$2",
  code_session_inboxes: "company_id=$1 AND session_id=$2",
  // A turn is reached through its run: the turn row carries no session column, and reaching it by
  // `company_id` alone would erase another session's turns in the same tenant.
  code_run_turns: "company_id=$1 AND run_id IN (SELECT run_id FROM code_run_states WHERE company_id=$1 AND session_id=$2)",

  project_checkpoints: CODE_PROJECT_CHECKPOINT_PREDICATE,
  code_run_states: "company_id=$1 AND session_id=$2",
  code_session_plans: "company_id=$1 AND session_id=$2",
  code_goals: "company_id=$1 AND session_id=$2",
  code_session_todos: "company_id=$1 AND session_id=$2",
  code_session_rewinds: "company_id=$1 AND session_id=$2",
  code_session_forks: "company_id=$1 AND session_id=$2",
  code_user_questions: "company_id=$1 AND session_id=$2",
  code_session_heads: "company_id=$1 AND session_id=$2",
});

export const ERASE_PROJECT_SCOPE_PREDICATE: Readonly<Record<string, string>> = Object.freeze({
  code_process_projects: "company_id=$1 AND project_id=$2",
  code_session_inboxes: "company_id=$1 AND project_id=$2",
  code_run_turns: "company_id=$1 AND run_id IN (SELECT run_id FROM code_run_states WHERE company_id=$1 AND project_id=$2)",
  project_checkpoints: CODE_PROJECT_CHECKPOINT_PREDICATE,
  code_run_states: "company_id=$1 AND project_id=$2",
  code_session_plans: "company_id=$1 AND project_id=$2",
  code_goals: "company_id=$1 AND project_id=$2",
  code_session_todos: "company_id=$1 AND project_id=$2",
  code_session_rewinds: "company_id=$1 AND project_id=$2",
  code_session_forks: "company_id=$1 AND project_id=$2",
  code_user_questions: "company_id=$1 AND project_id=$2",
  code_session_heads: "company_id=$1 AND project_id=$2",
});

export const ERASE_CLEAR_SESSION_REFERENCE: Readonly<Record<string, { table: string; column: string }>> = Object.freeze({
  code_approval_rules: { table: "code_approval_rules", column: "session_id" },
});

export const PROJECT_SCOPED_ERASE_TABLES: readonly string[] = [
  "code_project_data_policies",
  "project_code_trust",
  "project_mounted_folders",
  "project_deployments",
  "project_qa_reports",
];

export const APPEND_ONLY_COUNTABLE: Readonly<Record<string, string>> = Object.freeze({
  execution_snapshots: "execution_snapshots t",
  code_replay_bundles: "code_replay_bundles t",
  code_context_summaries: "code_context_summaries t",
  code_run_recovery_notices: "code_run_recovery_notices t",
  code_activity_events: "code_activity_events t",
});

export const APPEND_ONLY_AGE_COLUMN: Readonly<Record<string, string>> = Object.freeze({
  execution_snapshots: "t.created_at",
  code_replay_bundles: "t.created_at",
  code_context_summaries: "t.created_at",
  code_run_recovery_notices: "t.created_at",
  code_activity_events: "t.created_at",
});

export const businessColumns = `id, workspace_id AS "workspaceId", owner_user_id AS "ownerUserId", name,
  business_type AS "businessType", industry, niche, country, market, website, business_stage AS "businessStage",
  legal_name AS "legalName", contact_email AS "contactEmail", contact_phone AS "contactPhone",
  postal_address AS "postalAddress", registration_details AS "registrationDetails", logo_file_id AS "logoFileId",
  team_type AS "teamType", business_model AS "businessModel", presence_type AS "presenceType", description,
  audience_summary AS "audienceSummary", products_services_summary AS "productsServicesSummary",
  activation_status AS "activationStatus", created_at AS "createdAt", updated_at AS "updatedAt"`;
export const goalColumns = `id, workspace_id AS "workspaceId", business_id AS "businessId", created_by_user_id AS "createdByUserId",
  title, description, status, target_value::float AS "targetValue", target_unit AS "targetUnit",
  current_value::float AS "currentValue", target_date::text AS "targetDate", priority,
  assigned_agent_id AS "assignedAgentId", created_at AS "createdAt", updated_at AS "updatedAt"`;
export const memoryColumns = `id, workspace_id AS "workspaceId", business_id AS "businessId", user_id AS "userId",
  type, title, content, source, confidence::float, created_at AS "createdAt", updated_at AS "updatedAt"`;
export const conversationColumns = `id, workspace_id AS "workspaceId", business_id AS "businessId", user_id AS "userId",
  title, created_at AS "createdAt", updated_at AS "updatedAt"`;
export const onboardingColumns = 'id, workspace_id AS "workspaceId", user_id AS "userId", business_id AS "businessId", conversation_id AS "conversationId", scenario, status, current_step AS "currentStep", completed_fields AS "completedFields", skipped_fields AS "skippedFields", created_at AS "createdAt", updated_at AS "updatedAt"';
export const companyColumns = `id, workspace_id AS "workspaceId", user_id AS "userId", business_id AS "businessId",
  name, website, industry, description, products_services AS "productsServices", languages, brand_tone AS "brandTone",
  company_instructions AS "companyInstructions", knowledge, memory, main_agent_id AS "mainAgentId", status, revision,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
export const projectColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", created_by AS "createdBy",
  name, description, type, kind, status, framework, runtime, repository_provider AS "repositoryProvider",
  repository_url AS "repositoryUrl", repository_branch AS "repositoryBranch", sandbox_id AS "sandboxId",
  preview_url AS "previewUrl", preview_port AS "previewPort", last_run_id AS "lastRunId",
  last_build_status AS "lastBuildStatus", deployment_url AS "deploymentUrl", deployment_status AS "deploymentStatus",
  last_deployed_at AS "lastDeployedAt", data_backend_id AS "dataBackendId", app_scheme AS "appScheme",
  toolchain, default_branch AS "defaultBranch", data_classification AS "dataClassification",
  retention_class AS "retentionClass", deleted_at AS "deletedAt", purge_after AS "purgeAfter",
  deletion_reason AS "deletionReason", restored_at AS "restoredAt", revision, created_at AS "createdAt", updated_at AS "updatedAt"`;
export const codeSessionColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId",
  user_id AS "userId", agent_id AS "agentId", mode, model_profile AS "modelProfile", status,
  parent_session_id AS "parentSessionId", run_id AS "runId", summary,
  data_classification AS "dataClassification", retention_class AS "retentionClass",
  tool_manifest_version AS "toolManifestVersion", revision, created_at AS "createdAt", updated_at AS "updatedAt"`;
export const projectCodeTrustColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId",
  trusted, trusted_by AS "trustedBy", trusted_at AS "trustedAt", revoked_by AS "revokedBy", revoked_at AS "revokedAt",
  reason, revision, updated_at AS "updatedAt"`;

export const projectMountedFolderColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId",
  path, mode, confirmed_by AS "confirmedBy", confirmed_at AS "confirmedAt", revoked_by AS "revokedBy", revoked_at AS "revokedAt",
  reason, revision, updated_at AS "updatedAt"`;

export const auditEntryColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId",
  sequence::int AS "sequence",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  actor, actor_role AS "actorRole", request_id AS "requestId",
  correlation_id AS "correlationId", snapshot_id AS "snapshotId", action, resource_type AS "resourceType",
  resource_id AS "resourceId", project_id AS "projectId", decision, payload_hash AS "payloadHash",
  prev_hash AS "prevHash", entry_hash AS "entryHash", metadata`;
export const codeActivityEventColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId",
  project_id AS "projectId", session_id AS "sessionId", run_id AS "runId", snapshot_id AS "snapshotId",
  parent_run_id AS "parentRunId", parent_tool_call_id AS "parentToolCallId", parent_event_id AS "parentEventId",
  kind, payload, data_classification AS "dataClassification", retention_class AS "retentionClass",
  created_at AS "createdAt"`;

export const codeContextSummaryColumns = `id, company_id AS "companyId", project_id AS "projectId",
  session_id AS "sessionId", run_id AS "runId", snapshot_id AS "snapshotId", turn_index AS "turnIndex",
  schema_version AS "schemaVersion", summary, summary_text AS "summaryText", content_hash AS "contentHash",
  data_classification AS "dataClassification", retention_class AS "retentionClass", created_at AS "createdAt"`;
export const replayBundleColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId",
  project_id AS "projectId", session_id AS "sessionId", run_id AS "runId",
  execution_snapshot_id AS "executionSnapshotId", bundle_version AS "bundleVersion",
  runner_version AS "runnerVersion", system_prompt_version AS "systemPromptVersion",
  system_prompt_content_hash AS "systemPromptContentHash",
  model_profile_version AS "modelProfileVersion", provider, model, replay_mode AS "replayMode",
  source_run_id AS "sourceRunId", source_snapshot_id AS "sourceSnapshotId",
  terminal_status AS "terminalStatus", terminal_reason AS "terminalReason", payload,
  payload_hash AS "payloadHash", replay_input_hash AS "replayInputHash",
  data_classification AS "dataClassification", retention_class AS "retentionClass",
  created_at AS "createdAt"`;
export const replayBundleStepColumns = `id, bundle_id AS "bundleId", company_id AS "companyId", seq, kind,
  turn_index AS "turnIndex", tool_call_id AS "toolCallId", payload, payload_hash AS "payloadHash",
  created_at AS "createdAt"`;
export const auditAnchorColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", day::text AS day,
  sequence::float8 AS "sequence", entry_count::float8 AS "entryCount", head_hash AS "headHash", anchor_path AS "anchorPath",
  signature, created_at AS "createdAt"`;
export const featureFlagColumns = `id, workspace_id AS "workspaceId", scope, scope_id AS "scopeId", flag_key AS "flagKey",
  stage, enabled, rollout_percent AS "rolloutPercent", allowlist, revision, updated_by AS "updatedBy", updated_at AS "updatedAt"`;
export const sandboxImageColumns = `id, workspace_id AS "workspaceId", variant, reference, digest, status, signature,
  signature_issuer AS "signatureIssuer", sbom_path AS "sbomPath", scan_tool AS "scanTool", scan_at AS "scanAt",
  scan_critical AS "scanCritical", scan_high AS "scanHigh", waiver_owner AS "waiverOwner",
  waiver_expires_at AS "waiverExpiresAt", waiver_reason AS "waiverReason", previous_reference AS "previousReference",
  revoked_at AS "revokedAt", revoked_by AS "revokedBy", revoke_reason AS "revokeReason",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`;
export const codeApprovalRuleColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId",
  project_id AS "projectId", session_id AS "sessionId", created_by AS "createdBy", scope, action, decision,
  reason, expires_at AS "expiresAt", revision, created_at AS "createdAt", updated_at AS "updatedAt"`;
export const projectCheckpointColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId",
  project_id AS "projectId", user_id AS "userId", name, description, commit_hash AS "commitHash",
  trigger, run_id AS "runId", file_count AS "fileCount", created_at AS "createdAt"`;
export const projectDeploymentColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId",
  user_id AS "userId", provider, environment, branch, commit_hash AS "commitHash", status, target_url AS "targetUrl",
  external_deployment_id AS "externalDeploymentId", preflight_summary AS "preflightSummary", error_message AS "errorMessage",
  run_id AS "runId", created_at::text AS "createdAt", updated_at::text AS "updatedAt"`;
export const projectQaReportColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId",
  user_id AS "userId", status, target_url AS "targetUrl", summary, issues, metrics, screenshots,
  run_id AS "runId", created_at::text AS "createdAt"`;
export const companyAgentColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", name, role, description,
  system_instruction AS "systemInstruction", prompt_guidelines AS "promptGuidelines",
  recommended_prompts AS "recommendedPrompts", model_id AS "modelId", fallback_model_id AS "fallbackModelId",
  tools_json AS tools, is_active AS "isActive", position_x AS "positionX", position_y AS "positionY",
  sort_order AS "sortOrder", revision, created_at AS "createdAt", updated_at AS "updatedAt"`;
export const companyEdgeColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId",
  parent_agent_id AS "parentAgentId", child_agent_id AS "childAgentId", relation_type AS "relationType", created_at AS "createdAt"`;
export const companyRunColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId", user_id AS "userId",
  main_agent_id AS "mainAgentId", idempotency_key AS "idempotencyKey", task, requested_mode AS "requestedMode",
  execution_mode AS "executionMode", status, selected_agent_ids AS "selectedAgentIds",
  omniroute_task_id AS "omnirouteTaskId", omniroute_combo_name AS "omnirouteComboName",
  result, error_code AS "errorCode", error_message AS "errorMessage", cancel_requested AS "cancelRequested",
  worker_id AS "workerId", lease_expires_at AS "leaseExpiresAt", last_heartbeat_at AS "lastHeartbeatAt",
  attempt_count AS "attemptCount", max_attempts AS "maxAttempts", next_attempt_at AS "nextAttemptAt",
  context_snapshot AS "contextSnapshot", total_cost::float AS "totalCost", total_tokens::float AS "totalTokens",
  total_duration_ms AS "totalDurationMs",
  created_at AS "createdAt", started_at AS "startedAt", completed_at AS "completedAt", updated_at AS "updatedAt"`;
export const companyRunStepColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", run_id AS "runId",
  agent_id AS "agentId", step_order AS "stepOrder", lane, role, status, model_id AS "modelId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
export const companyToolAuditColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", run_id AS "runId",
  agent_id AS "agentId", tool_name AS "toolName", decision, status, input_summary AS "inputSummary",
  error_message AS "errorMessage", latency_ms AS "latencyMs", cost::float, tokens::float,
  reason_code AS "reasonCode", sequence_number AS "sequenceNumber", created_at AS "createdAt", completed_at AS "completedAt"`;
export const companyRunEventColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", run_id AS "runId",
  event_key AS "eventKey", event_type AS "eventType", run_status AS "runStatus", worker_id AS "workerId",
  attempt_count AS "attemptCount", message, details, created_at AS "createdAt"`;

export const companyMemberColumns = `id, company_id AS "companyId", user_id AS "userId", role, status,
  invited_by AS "invitedBy", invited_at AS "invitedAt", accepted_at AS "acceptedAt",
  created_at AS "createdAt", updated_at AS "updatedAt", revision`;
export const companyInviteColumns = `id, company_id AS "companyId", email, role, token_hash AS "tokenHash",
  expires_at AS "expiresAt", created_by AS "createdBy", accepted_at AS "acceptedAt", created_at AS "createdAt"`;

export const lastActiveOwnerPredicate = (companyParameter: string) =>
  `(SELECT COUNT(*) FROM company_members m WHERE m.company_id=${companyParameter} AND m.role='owner' AND m.status='active') <= 1`;

export const providerDataPolicyColumns = `id, company_id AS "companyId", provider_id AS "providerId",
  model_pattern AS "modelPattern", policy_version AS "policyVersion", kind,
  allow_private_repo_code AS "allowPrivateRepoCode", max_data_classification AS "maxDataClassification",
  allow_prompt_caching AS "allowPromptCaching", external_retention AS "externalRetention",
  training_policy AS "trainingPolicy", region, jurisdiction, required_redactions AS "requiredRedactions",
  allowed_content_types AS "allowedContentTypes", terms_url AS "termsUrl",
  last_reviewed_at AS "lastReviewedAt", reviewed_by AS "reviewedBy",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
export const providerDataPolicyVersionColumns = `id, company_id AS "companyId", provider_id AS "providerId",
  model_pattern AS "modelPattern", policy_version AS "policyVersion", payload, actor,
  created_at AS "createdAt"`;
export const projectDataPolicyColumns = `company_id AS "companyId", project_id AS "projectId",
  data_classification AS "dataClassification", path_rules AS "pathRules",
  policy_version AS "policyVersion", updated_by AS "updatedBy",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
export const hostedProviderConsentColumns = `company_id AS "companyId", project_id AS "projectId",
  provider_id AS "providerId", granted_by AS "grantedBy", granted_at AS "grantedAt",
  revoked_at AS "revokedAt"`;

export const codeRunStateColumns = `run_id AS "runId", workspace_id AS "workspaceId", company_id AS "companyId",
  project_id AS "projectId", session_id AS "sessionId", status, turn_index AS "turnIndex",
  last_event_seq::int AS "lastEventSeq", lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
  heartbeat_at AS "heartbeatAt", started_at AS "startedAt", updated_at AS "updatedAt",
  finished_at AS "finishedAt", details, revision`;
export const codeRunTurnColumns = `run_id AS "runId", company_id AS "companyId", turn_index AS "turnIndex",
  status, outcome, tool_calls AS "toolCalls", messages, results, checkpoint_id AS "checkpointId",
  started_at AS "startedAt", finished_at AS "finishedAt"`;

export type StoredUserSetting = import('./types').UserSetting;
