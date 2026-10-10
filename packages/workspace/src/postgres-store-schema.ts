/* The schema mapping of the Postgres workspace store - the retention and erase SQL fragments, the
 * column maps and the fragment guard - split out of postgres-store.ts in step 3f of
 * docs/refactoring/PLAN.md.
 *
 * Moved verbatim except for the `export` keyword each declaration needs; the store imports them all.
 */
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

/**
 * `table → FROM clause with the alias `t``, for every family retention measures. Keys are exactly
 * `CODE_RETENTION_FAMILIES`: a table added to that vocabulary without a clause here throws rather than
 * silently contributing zero to a sweep.
 */
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

/**
 * The `project_checkpoints` predicate for an **erasure**, and the reason it is written as its own constant:
 * this table is **shared**. `packages/workspace/src/migration-056.ts` created it before `code_project`
 * existed, and `project.git.checkpoint` / `project.git.restore_checkpoint`
 * (`packages/shared/src/project-git-capabilities.ts`) let any project type write a checkpoint — the Website
 * Builder and Data Studio included. An erasure must therefore never delete a checkpoint without proving the
 * project it belongs to is a `code_project`, and it does that in the **same statement** as the delete rather
 * than by a separate lookup a concurrent reclassification could invalidate.
 *
 * This is the negative control the erasure's contract names: a checkpoint of a Website Builder project is not
 * deleted "for any reason", and `tests/coding-agent-r1c-data-lifecycle-postgres.test.ts` measures it.
 * `$1` is the Company id and `$2` the project id.
 */
export const CODE_PROJECT_CHECKPOINT_PREDICATE =
  "company_id=$1 AND project_id=$2 AND EXISTS (SELECT 1 FROM projects p WHERE p.id=project_checkpoints.project_id AND p.company_id=$1 AND p.type='code_project')";

/**
 * The shared-table guard for a **retention sweep**, expressed as a statement fragment with **no parameter of
 * its own**.
 *
 * That is not a stylistic choice: the sweep's `$1`–`$7` are already taken (Company id, the four windows, "now"
 * and the expirable classes), and a fragment that reused `$2` would ask PostgreSQL to compare a project id
 * with the ephemeral window's integer — `operator does not exist: text = integer`. A guard that binds nothing
 * cannot collide with the parameters of the statement it is appended to, whatever they become.
 *
 * It is applied to **every** family that carries a `project_id`, not only to `project_checkpoints`. Retention
 * is a code feature, and the table that carries a project reference is the only place a non-code project could
 * be reached through one: proving `type = 'code_project'` in the same statement as the delete is what makes
 * "a Website Builder project is never expired" a structural fact rather than an assumption about which ids are
 * passed. `EXISTS` on `projects.id` is a primary-key lookup, so the guard costs an index probe per candidate
 * row and never a scan.
 */
export const CODE_PROJECT_GUARD_FOR = (alias: string): string =>
  `EXISTS (SELECT 1 FROM projects p WHERE p.id=${alias}.project_id AND p.company_id=${alias}.company_id AND p.type='code_project')`;

/** `table → the age column`, used for the bound. `code_session_heads` ages by `updated_at` (it is a cursor). */
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

/**
 * Per-family extra predicate a **retention** sweep must satisfy before it deletes: the code-project guard for
 * every family that carries a `project_id`. A family without an entry has no project reference to prove (a
 * question points at a session, a turn at a run that belongs to a code session), so there is nothing to guard.
 */
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

/**
 * The shape every interpolated SQL fragment must have. It is a **guard against a future edit**, not against a
 * caller: no identifier reaches these statements from outside this module (a caller supplies a Company id, a
 * session id or a project id, all bound parameters), and the maps above are closed literals. Asserting the
 * shape anyway means a fragment that somehow acquired a semicolon, a comment marker or a quote it should not
 * have throws here instead of being concatenated into a statement, so the safety argument stays true as the
 * maps grow.
 */
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
  // The shared-table predicate (see above): an erasure only removes a checkpoint whose project is a code
  // project, so `DELETE …/code/projects/:id/data` on a Website Builder id removes nothing at all.
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

/**
 * The same families for a **project-scoped** erasure, where the caller names a project rather than a session.
 * Every row of the project is in scope — including the session-scoped ones, reached through `code_sessions` —
 * but the two shared/derived shapes need their own statement:
 *
 *  - `code_run_turns` has no session column, so it is reached through `code_run_states` **joined to the
 *    project** rather than through a session id that a project-scoped call does not have;
 *  - `project_checkpoints` is the shared table, so the predicate still proves `code_project` in the same
 *    statement as the delete (see `CODE_PROJECT_CHECKPOINT_PREDICATE`).
 *
 * `$1` is the Company id and `$2` the project id.
 */
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

/**
 * A project whose sessions are gone keeps its approval rules: the rules are policy, not session content.
 * Only the `session_id` binding of a session-scoped rule is cleared, so a rule that was scoped to the erased
 * session stops pointing at a session that no longer exists while the project's policy survives.
 */
export const ERASE_CLEAR_SESSION_REFERENCE: Readonly<Record<string, { table: string; column: string }>> = Object.freeze({
  code_approval_rules: { table: "code_approval_rules", column: "session_id" },
});

/**
 * The **code-owned, project-scoped** rows a whole-project erasure must not leave behind.
 *
 * They carry a `project_id` but not a session, so no family in `CODE_RETENTION_FAMILIES` reaches them, and
 * relying on the `projects` foreign keys to cascade would be relying on an assumption: `deleteProject`'s
 * cascades were written for the record's own lifecycle, not for this contract, and "the project's data is
 * gone" has to be true for the policy, the trust decision, the mount confirmation, the approval rules, the
 * deployments and the QA reports too. Each is deleted **and read back** so the report's `verified` covers it.
 *
 * They are deliberately absent from the retention families: policy and trust are not content that ages, and
 * expiring a mount confirmation or an approval rule on a clock would change what the project is allowed to do.
 *
 * `code_approval_rules` is deliberately **not** in this list even though it carries a `project_id`: a
 * session-scoped rule has a `session_id` and a `project_id`, so `project_id = $2` would delete a rule that
 * belongs to another session of the same project. The rule rows follow the project record's own cascade when
 * the project itself is removed, which is the mechanism the existing lifecycle already relies on.
 */
export const PROJECT_SCOPED_ERASE_TABLES: readonly string[] = [
  "code_project_data_policies",
  "project_code_trust",
  "project_mounted_folders",
  "project_deployments",
  "project_qa_reports",
];

/**
 * The append-only families that carry their **own** age, so the rows retention *would* have expired can be
 * counted honestly. `code_replay_bundle_steps` is deliberately absent: it has no timestamp and no retention
 * class of its own, so it is counted through its header (`code_replay_bundles`, which carries both), and its
 * own entry reports zero with the same reason rather than an invented number.
 */
export const APPEND_ONLY_COUNTABLE: Readonly<Record<string, string>> = Object.freeze({
  execution_snapshots: "execution_snapshots t",
  code_replay_bundles: "code_replay_bundles t",
  code_context_summaries: "code_context_summaries t",
  code_run_recovery_notices: "code_run_recovery_notices t",
  code_activity_events: "code_activity_events t",
});

/** `table → its retention age column`, for the append-only families that carry one. */
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
  created_at AS "createdAt", updated_at AS "updatedAt"`;
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
  name, description, type, status, framework, runtime, repository_provider AS "repositoryProvider",
  repository_url AS "repositoryUrl", repository_branch AS "repositoryBranch", sandbox_id AS "sandboxId",
  preview_url AS "previewUrl", preview_port AS "previewPort", last_run_id AS "lastRunId",
  last_build_status AS "lastBuildStatus", deployment_url AS "deploymentUrl", deployment_status AS "deploymentStatus",
  last_deployed_at AS "lastDeployedAt", data_backend_id AS "dataBackendId", app_scheme AS "appScheme",
  toolchain, default_branch AS "defaultBranch", data_classification AS "dataClassification",
  retention_class AS "retentionClass", revision, created_at AS "createdAt", updated_at AS "updatedAt"`;
export const codeSessionColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId",
  user_id AS "userId", agent_id AS "agentId", mode, model_profile AS "modelProfile", status,
  parent_session_id AS "parentSessionId", run_id AS "runId", summary,
  data_classification AS "dataClassification", retention_class AS "retentionClass",
  tool_manifest_version AS "toolManifestVersion", revision, created_at AS "createdAt", updated_at AS "updatedAt"`;
export const projectCodeTrustColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId",
  trusted, trusted_by AS "trustedBy", trusted_at AS "trustedAt", revoked_by AS "revokedBy", revoked_at AS "revokedAt",
  reason, revision, updated_at AS "updatedAt"`;
  // C15: `path_key` is deliberately not selected — it is a comparison key, not a fact a caller acts on, and
  // exposing it would invite a second spelling of the canonical path.
export const projectMountedFolderColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId",
  path, mode, confirmed_by AS "confirmedBy", confirmed_at AS "confirmedAt", revoked_by AS "revokedBy", revoked_at AS "revokedAt",
  reason, revision, updated_at AS "updatedAt"`;
  /**
   * G1 (D1): the **read** form of an audit entry has to reproduce, byte for byte, the value that
   * `appendAuditEntry` hashed — `audit-chain.ts` hashes the material with `canonicalJson`, which renders
   * anything that is not a primitive through `Object.entries`. Two columns did not survive that round trip
   * and made `verifyAuditEntries` answer `entry_hash does not match the entry content` for **every** real
   * entry — a false CRITICAL that `AuditLogService` then blocked privileged writes on:
   *
   *  - `created_at` came back as a JavaScript `Date`, and `canonicalJson` renders a `Date` as `{}`, so an
   *    entry could never match its own hash. The writer hashes `new Date().toISOString()`, so the reader
   *    formats exactly that string: `AT TIME ZONE 'UTC'` removes the session time zone (the hash is UTC)
   *    and the template is the shape `Date.prototype.toISOString()` produces — four-digit year, literal
   *    `T`, `HH24:MI:SS`, three-digit milliseconds, literal `Z`, no spaces. `created_at::text` is **not**
   *    that string (`2026-10-08 13:51:09.288+00`), which is why the format is spelled out instead.
   *  - `sequence` came back as a JavaScript **string** (`pg` parses `int8` as text, which is why the writer
   *    itself reads the head with `Number(head.rows[0].sequence)`), while the writer hashed a number: the
   *    hash saw `"sequence":"1"` where `1` had been hashed. `::int` is the same coercion the writer already
   *    performs; a sequence above 2^31-1 raises `integer out of range` (a loud failure) rather than hashing
   *    a silently different number.
   *
   * The **write** path is deliberately untouched, so a chain written before this fix keeps its hashes: it
   * was hashed over the ISO string and the number, which is what the reader returns again.
   */
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
  // C8: no workspace_id column on purpose — a context summary is addressed by company/project/session/run,
  // which is what every reader and the UI hold; adding a fourth scope would only create a value to get wrong.
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
  sequence, entry_count AS "entryCount", head_hash AS "headHash", anchor_path AS "anchorPath",
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
// C5a: timestamps stay `timestamptz` (pg returns Date), because the membership port compares them with
// `Date#getTime()` when it decides whether an invite is still valid.
export const companyMemberColumns = `id, company_id AS "companyId", user_id AS "userId", role, status,
  invited_by AS "invitedBy", invited_at AS "invitedAt", accepted_at AS "acceptedAt",
  created_at AS "createdAt", updated_at AS "updatedAt", revision`;
export const companyInviteColumns = `id, company_id AS "companyId", email, role, token_hash AS "tokenHash",
  expires_at AS "expiresAt", created_by AS "createdBy", accepted_at AS "acceptedAt", created_at AS "createdAt"`;
/**
 * The only-owner guard, shared by the demote, remove and invite-accept paths. It is part of the
 * *statement* rather than a separate read, so a concurrent request cannot slip between "count the owners"
 * and "write": a company may never be left without an active owner, even when a caller bypasses
 * `CodeMembershipService` (a suspended owner cannot administer anything, so it does not count).
 */
export const lastActiveOwnerPredicate = (companyParameter: string) =>
  `(SELECT COUNT(*) FROM company_members m WHERE m.company_id=${companyParameter} AND m.role='owner' AND m.status='active') <= 1`;

// C5b: ProviderDataPolicy. Timestamps stay `timestamptz` (pg returns Date) because the policy staleness
// rule compares `last_reviewed_at` against a 180-day window, and the history rows are read back as-is.
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
// C6a: durable run state. `last_event_seq` is a `bigint`, and `pg` returns those as strings, so it is cast
// back to a number here — the app-side log compares sequence numbers, not decimal strings.
export const codeRunStateColumns = `run_id AS "runId", workspace_id AS "workspaceId", company_id AS "companyId",
  project_id AS "projectId", session_id AS "sessionId", status, turn_index AS "turnIndex",
  last_event_seq::int AS "lastEventSeq", lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
  heartbeat_at AS "heartbeatAt", started_at AS "startedAt", updated_at AS "updatedAt",
  finished_at AS "finishedAt", details, revision`;
export const codeRunTurnColumns = `run_id AS "runId", company_id AS "companyId", turn_index AS "turnIndex",
  status, outcome, tool_calls AS "toolCalls", messages, results, checkpoint_id AS "checkpointId",
  started_at AS "startedAt", finished_at AS "finishedAt"`;

export type StoredUserSetting = import('./types').UserSetting;
