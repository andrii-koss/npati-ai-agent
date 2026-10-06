import { randomUUID } from "node:crypto";
import { assertNoSecrets } from "@npati/memory";
import { Pool } from "pg";
import migration001 from "./migration-001";
import migration002 from "./migration-002";
import migration003 from "./migration-003";
import type { AuthContext, Business, BusinessInput, BusinessOnboardingSession, BusinessToCompanyInput, Company, CompanyAgent, CompanyAgentEdge, CompanyAgentInput, CompanyAgentRun, CompanyAgentRunEvent, CompanyAgentRunStep, CompanyAgentToolAudit, CompanyInput, Project, ProjectCheckpoint, CreateCheckpointInput, ProjectDeployment, CreateDeploymentInput, ProjectQaReport, CreateProjectQaReportInput, ProjectInput, ProjectStatus, Conversation, ConversationMessage, Goal, GoalInput, MemoryInput, MemoryItem, OnboardingScenario, WorkspaceOverview, WorkspaceStore, CodeSession, CodeSessionInput, CodeSessionMode, CodeSessionStatus, ProjectCodeSettings, ProjectCodeTrust, ProjectCodeTrustInput, DataClassification, RetentionClass, AuditEntry, AuditEntryInput, AuditAnchor, AuditChainState, AuditChainVerification, FeatureFlag, FeatureFlagInput, FeatureFlagHistoryEntry, CodeToolManifest, SandboxImage, SandboxImageInput, SandboxImageVariant, CodeApprovalRule, CodeApprovalRuleInput, CodeApprovalRuleScope,
  CompanyMember, CompanyInvite, CompanyInviteInput, AcceptCompanyInviteInput, UpdateCompanyMemberRoleInput, RemoveCompanyMemberInput, CompanyRole } from "./types";
import { DEFAULT_DATA_CLASSIFICATION, DEFAULT_RETENTION_CLASS, isClassificationAtLeast, isCompanyRole } from "./types";
import { auditEntryHash, verifyAuditEntries } from "./audit-chain";
import { CompanyMembershipError, WorkspaceAccessError, WorkspaceNotFoundError } from "./types";
import { ONBOARDING_FLOWS, onboardingBusinessPatch, onboardingPlaceholder } from "./onboarding";

const businessColumns = `id, workspace_id AS "workspaceId", owner_user_id AS "ownerUserId", name,
  business_type AS "businessType", industry, niche, country, market, website, business_stage AS "businessStage",
  legal_name AS "legalName", contact_email AS "contactEmail", contact_phone AS "contactPhone",
  postal_address AS "postalAddress", registration_details AS "registrationDetails", logo_file_id AS "logoFileId",
  team_type AS "teamType", business_model AS "businessModel", presence_type AS "presenceType", description,
  audience_summary AS "audienceSummary", products_services_summary AS "productsServicesSummary",
  activation_status AS "activationStatus", created_at AS "createdAt", updated_at AS "updatedAt"`;
const goalColumns = `id, workspace_id AS "workspaceId", business_id AS "businessId", created_by_user_id AS "createdByUserId",
  title, description, status, target_value::float AS "targetValue", target_unit AS "targetUnit",
  current_value::float AS "currentValue", target_date::text AS "targetDate", priority,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const memoryColumns = `id, workspace_id AS "workspaceId", business_id AS "businessId", user_id AS "userId",
  type, title, content, source, confidence::float, created_at AS "createdAt", updated_at AS "updatedAt"`;
const conversationColumns = `id, workspace_id AS "workspaceId", business_id AS "businessId", user_id AS "userId",
  title, created_at AS "createdAt", updated_at AS "updatedAt"`;
const onboardingColumns = 'id, workspace_id AS "workspaceId", user_id AS "userId", business_id AS "businessId", conversation_id AS "conversationId", scenario, status, current_step AS "currentStep", completed_fields AS "completedFields", skipped_fields AS "skippedFields", created_at AS "createdAt", updated_at AS "updatedAt"';
const companyColumns = `id, workspace_id AS "workspaceId", user_id AS "userId", business_id AS "businessId",
  name, website, industry, description, products_services AS "productsServices", languages, brand_tone AS "brandTone",
  company_instructions AS "companyInstructions", knowledge, memory, main_agent_id AS "mainAgentId", status, revision,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const projectColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", created_by AS "createdBy",
  name, description, type, status, framework, runtime, repository_provider AS "repositoryProvider",
  repository_url AS "repositoryUrl", repository_branch AS "repositoryBranch", sandbox_id AS "sandboxId",
  preview_url AS "previewUrl", preview_port AS "previewPort", last_run_id AS "lastRunId",
  last_build_status AS "lastBuildStatus", deployment_url AS "deploymentUrl", deployment_status AS "deploymentStatus",
  last_deployed_at AS "lastDeployedAt", data_backend_id AS "dataBackendId", app_scheme AS "appScheme",
  toolchain, default_branch AS "defaultBranch", data_classification AS "dataClassification",
  retention_class AS "retentionClass", revision, created_at AS "createdAt", updated_at AS "updatedAt"`;
  const codeSessionColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId",
  user_id AS "userId", agent_id AS "agentId", mode, model_profile AS "modelProfile", status,
  parent_session_id AS "parentSessionId", run_id AS "runId", summary,
  data_classification AS "dataClassification", retention_class AS "retentionClass",
  tool_manifest_version AS "toolManifestVersion", revision, created_at AS "createdAt", updated_at AS "updatedAt"`;
  const projectCodeTrustColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId",
  trusted, trusted_by AS "trustedBy", trusted_at AS "trustedAt", revoked_by AS "revokedBy", revoked_at AS "revokedAt",
  reason, revision, updated_at AS "updatedAt"`;
  const auditEntryColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", sequence,
  created_at AS "createdAt", actor, actor_role AS "actorRole", request_id AS "requestId",
  correlation_id AS "correlationId", snapshot_id AS "snapshotId", action, resource_type AS "resourceType",
  resource_id AS "resourceId", project_id AS "projectId", decision, payload_hash AS "payloadHash",
  prev_hash AS "prevHash", entry_hash AS "entryHash", metadata`;
  const auditAnchorColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", day::text AS day,
  sequence, entry_count AS "entryCount", head_hash AS "headHash", anchor_path AS "anchorPath",
  signature, created_at AS "createdAt"`;
  const featureFlagColumns = `id, workspace_id AS "workspaceId", scope, scope_id AS "scopeId", flag_key AS "flagKey",
  stage, enabled, rollout_percent AS "rolloutPercent", allowlist, revision, updated_by AS "updatedBy", updated_at AS "updatedAt"`;
  const sandboxImageColumns = `id, workspace_id AS "workspaceId", variant, reference, digest, status, signature,
  signature_issuer AS "signatureIssuer", sbom_path AS "sbomPath", scan_tool AS "scanTool", scan_at AS "scanAt",
  scan_critical AS "scanCritical", scan_high AS "scanHigh", waiver_owner AS "waiverOwner",
  waiver_expires_at AS "waiverExpiresAt", waiver_reason AS "waiverReason", previous_reference AS "previousReference",
  revoked_at AS "revokedAt", revoked_by AS "revokedBy", revoke_reason AS "revokeReason",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`;
const codeApprovalRuleColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId",
  project_id AS "projectId", session_id AS "sessionId", created_by AS "createdBy", scope, action, decision,
  reason, expires_at AS "expiresAt", revision, created_at AS "createdAt", updated_at AS "updatedAt"`;
const projectCheckpointColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId",
  project_id AS "projectId", user_id AS "userId", name, description, commit_hash AS "commitHash",
  trigger, run_id AS "runId", file_count AS "fileCount", created_at AS "createdAt"`;
const projectDeploymentColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId",
  user_id AS "userId", provider, environment, branch, commit_hash AS "commitHash", status, target_url AS "targetUrl",
  external_deployment_id AS "externalDeploymentId", preflight_summary AS "preflightSummary", error_message AS "errorMessage",
  run_id AS "runId", created_at::text AS "createdAt", updated_at::text AS "updatedAt"`;
const projectQaReportColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId",
  user_id AS "userId", status, target_url AS "targetUrl", summary, issues, metrics, screenshots,
  run_id AS "runId", created_at::text AS "createdAt"`;
const companyAgentColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", name, role, description,
  system_instruction AS "systemInstruction", prompt_guidelines AS "promptGuidelines",
  recommended_prompts AS "recommendedPrompts", model_id AS "modelId", fallback_model_id AS "fallbackModelId",
  tools_json AS tools, is_active AS "isActive", position_x AS "positionX", position_y AS "positionY",
  sort_order AS "sortOrder", revision, created_at AS "createdAt", updated_at AS "updatedAt"`;
const companyEdgeColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId",
  parent_agent_id AS "parentAgentId", child_agent_id AS "childAgentId", relation_type AS "relationType", created_at AS "createdAt"`;
const companyRunColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", project_id AS "projectId", user_id AS "userId",
  main_agent_id AS "mainAgentId", idempotency_key AS "idempotencyKey", task, requested_mode AS "requestedMode",
  execution_mode AS "executionMode", status, selected_agent_ids AS "selectedAgentIds",
  omniroute_task_id AS "omnirouteTaskId", omniroute_combo_name AS "omnirouteComboName",
  result, error_code AS "errorCode", error_message AS "errorMessage", cancel_requested AS "cancelRequested",
  worker_id AS "workerId", lease_expires_at AS "leaseExpiresAt", last_heartbeat_at AS "lastHeartbeatAt",
  attempt_count AS "attemptCount", max_attempts AS "maxAttempts", next_attempt_at AS "nextAttemptAt",
  context_snapshot AS "contextSnapshot", total_cost::float AS "totalCost", total_tokens::float AS "totalTokens",
  total_duration_ms AS "totalDurationMs",
  created_at AS "createdAt", started_at AS "startedAt", completed_at AS "completedAt", updated_at AS "updatedAt"`;
const companyRunStepColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", run_id AS "runId",
  agent_id AS "agentId", step_order AS "stepOrder", lane, role, status, model_id AS "modelId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const companyToolAuditColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", run_id AS "runId",
  agent_id AS "agentId", tool_name AS "toolName", decision, status, input_summary AS "inputSummary",
  error_message AS "errorMessage", latency_ms AS "latencyMs", cost::float, tokens::float,
  reason_code AS "reasonCode", sequence_number AS "sequenceNumber", created_at AS "createdAt", completed_at AS "completedAt"`;
const companyRunEventColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId", run_id AS "runId",
  event_key AS "eventKey", event_type AS "eventType", run_status AS "runStatus", worker_id AS "workerId",
  attempt_count AS "attemptCount", message, details, created_at AS "createdAt"`;
// C5a: timestamps stay `timestamptz` (pg returns Date), because the membership port compares them with
// `Date#getTime()` when it decides whether an invite is still valid.
const companyMemberColumns = `id, company_id AS "companyId", user_id AS "userId", role, status,
  invited_by AS "invitedBy", invited_at AS "invitedAt", accepted_at AS "acceptedAt",
  created_at AS "createdAt", updated_at AS "updatedAt", revision`;
const companyInviteColumns = `id, company_id AS "companyId", email, role, token_hash AS "tokenHash",
  expires_at AS "expiresAt", created_by AS "createdBy", accepted_at AS "acceptedAt", created_at AS "createdAt"`;
/**
 * The only-owner guard, shared by the demote, remove and invite-accept paths. It is part of the
 * *statement* rather than a separate read, so a concurrent request cannot slip between "count the owners"
 * and "write": a company may never be left without an active owner, even when a caller bypasses
 * `CodeMembershipService` (a suspended owner cannot administer anything, so it does not count).
 */
const lastActiveOwnerPredicate = (companyParameter: string) =>
  `(SELECT COUNT(*) FROM company_members m WHERE m.company_id=${companyParameter} AND m.role='owner' AND m.status='active') <= 1`;

import migration004 from './migration-004';
import migration005 from './migration-005';
import migration006 from './migration-006';
import migration007 from './migration-007';
import migration008 from './migration-008';
import migration009 from './migration-009';
import migration010 from './migration-010';
import migration011 from './migration-011';
import migration012 from './migration-012';
import migration013 from './migration-013';
import migration014 from './migration-014';
import migration015 from './migration-015';
import migration016 from './migration-016';
import migration017 from './migration-017';
import migration030 from './migration-030';
import { companyPageLimit, decodeBusinessCursor, encodeBusinessCursor } from './pagination';
type StoredUserSetting = import('./types').UserSetting;

export class PostgresWorkspaceStore implements WorkspaceStore {
  private readonly pool: Pool;
  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl, max: 10 }); }

  async initialize(context?: AuthContext) {
    await this.pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const [version, sql] of [["001_business_workspace", migration001], ["002_conversational_onboarding", migration002], ["003_conversation_titles", migration003]] as const) {
      const applied = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
      if (applied.rowCount) continue;
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const userSettingsMigration = await this.pool.query(`SELECT 1 FROM schema_migrations WHERE version='004_workspace_user_settings'`);
    if (!userSettingsMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration004);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('004_workspace_user_settings') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const companyMigration = await this.pool.query(`SELECT 1 FROM schema_migrations WHERE version='005_company_model'`);
    if (!companyMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration005);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('005_company_model') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const separateCompanyMigration = await this.pool.query(`SELECT 1 FROM schema_migrations WHERE version='006_separate_companies_agents'`);
    if (!separateCompanyMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration006);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('006_separate_companies_agents') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const companyRuntimeMigration = await this.pool.query(`SELECT 1 FROM schema_migrations WHERE version='007_company_agent_runtime'`);
    if (!companyRuntimeMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration007);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('007_company_agent_runtime') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const runtimeHistoryMigration = await this.pool.query(`SELECT 1 FROM schema_migrations WHERE version='008_company_runtime_history'`);
    if (!runtimeHistoryMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration008);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('008_company_runtime_history') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const backgroundRunsMigration = await this.pool.query(`SELECT 1 FROM schema_migrations WHERE version='009_company_background_runs'`);
    if (!backgroundRunsMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration009);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('009_company_background_runs') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const backgroundAuditMigration = await this.pool.query(`SELECT 1 FROM schema_migrations WHERE version='030_company_background_run_events'`);
    if (!backgroundAuditMigration.rowCount) {
      const client = await this.pool.connect();
      try { await client.query('BEGIN'); await client.query(migration030); await client.query(`INSERT INTO schema_migrations(version) VALUES ('030_company_background_run_events') ON CONFLICT DO NOTHING`); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    await this.pool.query("ALTER TABLE company_agent_runs ADD COLUMN IF NOT EXISTS context_snapshot jsonb").catch(() => undefined);
    const fileStorageMigration = await this.pool.query(`SELECT 1 FROM schema_migrations WHERE version='010_central_file_metadata'`);
    if (!fileStorageMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration010);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('010_central_file_metadata') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const fileLifecycleMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='011_chat_file_lifecycle'");
    if (!fileLifecycleMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration011);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('011_chat_file_lifecycle') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const fileBusinessLifecycleMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='012_file_business_lifecycle'");
    if (!fileBusinessLifecycleMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration012);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('012_file_business_lifecycle') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const storageProtectionMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='013_storage_protection'");
    if (!storageProtectionMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration013);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('013_storage_protection') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const companyKnowledgeMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='014_company_knowledge'");
    if (!companyKnowledgeMigration.rowCount) {
      const client = await this.pool.connect();
      try { await client.query('BEGIN'); await client.query(migration014); await client.query("INSERT INTO schema_migrations(version) VALUES ('014_company_knowledge') ON CONFLICT DO NOTHING"); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const companyAutomationsMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='015_company_automations'");
    if (!companyAutomationsMigration.rowCount) {
      const client = await this.pool.connect();
      try { await client.query('BEGIN'); await client.query(migration015); await client.query("INSERT INTO schema_migrations(version) VALUES ('015_company_automations') ON CONFLICT DO NOTHING"); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const companyApprovalsMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='016_company_approvals'");
    if (!companyApprovalsMigration.rowCount) {
      const client = await this.pool.connect();
      try { await client.query('BEGIN'); await client.query(migration016); await client.query("INSERT INTO schema_migrations(version) VALUES ('016_company_approvals') ON CONFLICT DO NOTHING"); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const companyWebhooksMcpMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='017_webhooks_and_mcp'");
    if (!companyWebhooksMcpMigration.rowCount) {
      const client = await this.pool.connect();
      try { await client.query('BEGIN'); await client.query(migration017); await client.query("INSERT INTO schema_migrations(version) VALUES ('017_webhooks_and_mcp') ON CONFLICT DO NOTHING"); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const auditUsageMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='018_audit_and_usage'");
    if (!auditUsageMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration018 } = await import("./migration-018");
        await runMigration018(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('018_audit_and_usage') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const apiKeysMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='019_api_keys_and_encryption'");
    if (!apiKeysMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration019 } = await import("./migration-019");
        await runMigration019(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('019_api_keys_and_encryption') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const groupSessionsMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='020_group_sessions'");
    if (!groupSessionsMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration020 } = await import("./migration-020");
        await runMigration020(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('020_group_sessions') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const oauthTokensMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='021_oauth_refresh_tokens'");
    if (!oauthTokensMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration021 } = await import("./migration-021");
        await runMigration021(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('021_oauth_refresh_tokens') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const channelPairingsMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='022_channel_pairings'");
    if (!channelPairingsMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration022 } = await import("./migration-022");
        await runMigration022(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('022_channel_pairings') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const scopedMemoriesMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='023_scoped_memories'");
    if (!scopedMemoriesMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration023 } = await import("./migration-023");
        await runMigration023(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('023_scoped_memories') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const webhooksMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='024_webhook_subscriptions'");
    if (!webhooksMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration024 } = await import("./migration-024");
        await runMigration024(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('024_webhook_subscriptions') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const hybridRetrievalMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='025_hybrid_retrieval_fts'");
    if (!hybridRetrievalMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration025 } = await import("./migration-025");
        await runMigration025(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('025_hybrid_retrieval_fts') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const productionScopedMemoryMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='026_production_scoped_memory'");
    if (!productionScopedMemoryMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration026 } = await import("./migration-026");
        await runMigration026(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('026_production_scoped_memory') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const guardrailPoliciesMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='027_company_guardrail_policies'");
    if (!guardrailPoliciesMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration027 } = await import("./migration-027");
        await runMigration027(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('027_company_guardrail_policies') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const durableApprovalsMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='028_durable_approvals'");
    if (!durableApprovalsMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration028 } = await import("./migration-028");
        await runMigration028(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('028_durable_approvals') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const unifiedTelemetryMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='029_unified_telemetry'");
    if (!unifiedTelemetryMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration029 } = await import("./migration-029");
        await runMigration029(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('029_unified_telemetry') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const apiKeyDevicesMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='031_api_key_devices'");
    if (!apiKeyDevicesMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration031 } = await import("./migration-031");
        await runMigration031(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('031_api_key_devices') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const apiKeyHardeningMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='032_api_key_auth_hardening'");
    if (!apiKeyHardeningMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration032 } = await import("./migration-032");
        await runMigration032(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('032_api_key_auth_hardening') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const durableMemoryFeaturesMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='033_durable_memory_features'");
    if (!durableMemoryFeaturesMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration033 } = await import("./migration-033");
        await runMigration033(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('033_durable_memory_features') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const advancedMemoryMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='034_advanced_memory_runtime'");
    if (!advancedMemoryMigration.rowCount) {
      const client = await this.pool.connect();
      try { await client.query('BEGIN'); const { runMigration034 } = await import("./migration-034"); await runMigration034(client); await client.query("INSERT INTO schema_migrations(version) VALUES ('034_advanced_memory_runtime') ON CONFLICT DO NOTHING"); await client.query('COMMIT'); }
      catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
    }
    const memoryImportMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='035_memory_engines_import'");
    if (!memoryImportMigration.rowCount) {
      const client = await this.pool.connect();
      try { await client.query('BEGIN'); const { runMigration035 } = await import("./migration-035"); await runMigration035(client); await client.query("INSERT INTO schema_migrations(version) VALUES ('035_memory_engines_import') ON CONFLICT DO NOTHING"); await client.query('COMMIT'); }
      catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
    }
    const neutralConversationMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='036_neutral_conversations'");
    if (!neutralConversationMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration036 } = await import("./migration-036");
        await runMigration036(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('036_neutral_conversations') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const emailInboxMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='037_email_ai_inbox'");
    if (!emailInboxMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration037 } = await import("./migration-037");
        await runMigration037(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('037_email_ai_inbox') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const emailInboxRuntimeMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='038_email_ai_inbox_runtime'");
    if (!emailInboxRuntimeMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration038 } = await import("./migration-038");
        await runMigration038(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('038_email_ai_inbox_runtime') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const emailOauthMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='039_email_oauth_states'");
    if (!emailOauthMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration039 } = await import("./migration-039");
        await runMigration039(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('039_email_oauth_states') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const personalEmailMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='040_personal_email_scope'");
    if (!personalEmailMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration040 } = await import("./migration-040");
        await runMigration040(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('040_personal_email_scope') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const deletedEmailMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='041_email_deleted_messages'");
    if (!deletedEmailMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration041 } = await import("./migration-041");
        await runMigration041(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('041_email_deleted_messages') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const deletedEmailTypeFix = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='042_email_deleted_messages_workspace_type'");
    if (!deletedEmailTypeFix.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration042 } = await import("./migration-042");
        await runMigration042(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('042_email_deleted_messages_workspace_type') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const browserCredentialVault = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='043_browser_credential_vault'");
    if (!browserCredentialVault.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration043 } = await import("./migration-043");
        await runMigration043(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('043_browser_credential_vault') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const browserCampaignTargets = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='044_browser_campaign_targets'");
    if (!browserCampaignTargets.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration044 } = await import("./migration-044");
        await runMigration044(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('044_browser_campaign_targets') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const messagingConnections = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='045_messaging_connections'");
    if (!messagingConnections.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration045 } = await import("./migration-045");
        await runMigration045(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('045_messaging_connections') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const messagingScopes = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='046_messaging_connection_scopes'");
    if (!messagingScopes.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration046 } = await import("./migration-046");
        await runMigration046(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('046_messaging_connection_scopes') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const messagingSessions = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='047_messaging_sessions_and_dedup'");
    if (!messagingSessions.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration047 } = await import("./migration-047");
        await runMigration047(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('047_messaging_sessions_and_dedup') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const messagingSettings = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='048_messaging_connection_settings'");
    if (!messagingSettings.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration048 } = await import("./migration-048");
        await runMigration048(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('048_messaging_connection_settings') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    if (context) await this.ensureIdentity(context);
    const whatsappProviders = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='049_whatsapp_providers'");
    if (!whatsappProviders.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration049 } = await import("./migration-049");
        await runMigration049(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('049_whatsapp_providers') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const whatsappSelfChat = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='050_whatsapp_self_chat'");
    if (!whatsappSelfChat.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration050 } = await import("./migration-050");
        await runMigration050(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('050_whatsapp_self_chat') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const discordSettings = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='051_discord_integration'");
    if (!discordSettings.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration051 } = await import("./migration-051");
        await runMigration051(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('051_discord_integration') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const slackSettings = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='052_slack_integration'");
    if (!slackSettings.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration052 } = await import("./migration-052");
        await runMigration052(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('052_slack_integration') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const emailGateway = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='053_email_gateway'");
    if (!emailGateway.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration053 } = await import("./migration-053");
        await runMigration053(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('053_email_gateway') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }



    const projectFoundation = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='054_project_foundation'");
    if (!projectFoundation.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration054 } = await import("./migration-054");
        await runMigration054(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('054_project_foundation')");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const projectTerminal = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='055_project_terminal'");
    if (!projectTerminal.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration055 } = await import("./migration-055");
        await runMigration055(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('055_project_terminal')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const projectCheckpoints = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='056_project_checkpoints'");
    if (!projectCheckpoints.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration056 } = await import("./migration-056");
        await runMigration056(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('056_project_checkpoints')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const projectDeployments = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='057_project_deployments'");
    if (!projectDeployments.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration057 } = await import("./migration-057");
        await runMigration057(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('057_project_deployments')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const projectQaReports = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='058_project_qa_reports'");
    if (!projectQaReports.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration058 } = await import("./migration-058");
        await runMigration058(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('058_project_qa_reports')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const approvalPause = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='059_company_approval_pause'");
    if (!approvalPause.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration059 } = await import("./migration-059");
        await runMigration059(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('059_company_approval_pause')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const dataStudioMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='060_data_backends'");
    if (!dataStudioMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration060 } = await import("./migration-060");
        await runMigration060(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('060_data_backends')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const dataStudioUiMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='061_data_studio_expected_schema'");
    if (!dataStudioUiMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration061 } = await import("./migration-061");
        await runMigration061(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('061_data_studio_expected_schema')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const projectApiGatewayMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='062_project_api_gateway'");
    if (!projectApiGatewayMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration062 } = await import("./migration-062");
        await runMigration062(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('062_project_api_gateway')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const mobileAppMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='063_mobile_app_projects'");
    if (!mobileAppMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration063 } = await import("./migration-063");
        await runMigration063(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('063_mobile_app_projects')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const promoteBackupsMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='064_promote_backups_quotas'");
    if (!promoteBackupsMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration064 } = await import("./migration-064");
        await runMigration064(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('064_promote_backups_quotas')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const codeSessionMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='065_code_projects_and_sessions'");    if (!codeSessionMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration065 } = await import("./migration-065");
        await runMigration065(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('065_code_projects_and_sessions')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const auditLogMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='066_tamper_evident_audit_log'");
    if (!auditLogMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration066 } = await import("./migration-066");
        await runMigration066(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('066_tamper_evident_audit_log')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const featureFlagsMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='067_feature_flags_and_versioning'");
    if (!featureFlagsMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration067 } = await import("./migration-067");
        await runMigration067(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('067_feature_flags_and_versioning')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const sandboxImagesMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='068_sandbox_image_supply_chain'");
    if (!sandboxImagesMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration068 } = await import("./migration-068");
        await runMigration068(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('068_sandbox_image_supply_chain')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const credentialEnvironmentMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='069_credential_environment'");
    if (!credentialEnvironmentMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration069 } = await import("./migration-069");
        await runMigration069(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('069_credential_environment')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const codeApprovalRulesMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='070_code_approval_rules'");
    if (!codeApprovalRulesMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration070 } = await import("./migration-070");
        await runMigration070(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('070_code_approval_rules')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const codeTrustMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='071_code_project_trust'");
    if (!codeTrustMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration071 } = await import("./migration-071");
        await runMigration071(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('071_code_project_trust')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C5a: company membership and invites. Additive: `workspace_members` keeps its meaning, and 072
    // touches no existing table, row or query.
    const companyMembershipMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='072_company_membership_and_invites'");
    if (!companyMembershipMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration072 } = await import("./migration-072");
        await runMigration072(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('072_company_membership_and_invites')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C5a: the company protected-branch policy read by the shell hard-deny phase
    // (`CodeProtectedBranchRepository`). Additive: 073 creates its own table and index and touches no
    // existing table, row or query.
    const protectedBranchesMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='073_company_protected_branches'");
    if (!protectedBranchesMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration073 } = await import("./migration-073");
        await runMigration073(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('073_company_protected_branches')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
  }

  // --- C1b: sandbox image supply chain ------------------------------------------------------

  async listSandboxImages(context: AuthContext): Promise<SandboxImage[]> {
    const result = await this.pool.query<SandboxImage>(`SELECT ${sandboxImageColumns} FROM sandbox_images
      WHERE workspace_id=$1 ORDER BY variant, created_at DESC`, [context.workspaceId]);
    return result.rows;
  }

  async getSandboxImage(context: AuthContext, reference: string): Promise<SandboxImage | null> {
    const result = await this.pool.query<SandboxImage>(`SELECT ${sandboxImageColumns} FROM sandbox_images
      WHERE workspace_id=$1 AND reference=$2`, [context.workspaceId, reference]);
    return result.rows[0] ?? null;
  }

  async upsertSandboxImage(context: AuthContext, input: SandboxImageInput): Promise<SandboxImage> {
    const result = await this.pool.query<SandboxImage>(`INSERT INTO sandbox_images
      (id, workspace_id, variant, reference, digest, status, signature, signature_issuer, sbom_path, scan_tool, scan_at,
       scan_critical, scan_high, waiver_owner, waiver_expires_at, waiver_reason, previous_reference, created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (workspace_id, reference) DO UPDATE SET
        variant=$3, digest=$5, status=$6, signature=$7, signature_issuer=$8, sbom_path=$9, scan_tool=$10, scan_at=$11,
        scan_critical=$12, scan_high=$13, waiver_owner=$14, waiver_expires_at=$15, waiver_reason=$16,
        previous_reference=COALESCE($17, sandbox_images.previous_reference), updated_at=now()
      RETURNING ${sandboxImageColumns}`,
      [randomUUID(), context.workspaceId, input.variant, input.reference, input.digest, input.status ?? "unverified",
        input.signature ?? null, input.signatureIssuer ?? null, input.sbomPath ?? null, input.scanTool ?? null, input.scanAt ?? null,
        input.scanCritical ?? 0, input.scanHigh ?? 0, input.waiverOwner ?? null, input.waiverExpiresAt ?? null, input.waiverReason ?? null,
        input.previousReference ?? null, context.userId]);
    return result.rows[0]!;
  }

  async revokeSandboxImage(context: AuthContext, reference: string, input: { actor: string; reason: string }): Promise<SandboxImage> {
    const result = await this.pool.query<SandboxImage>(`UPDATE sandbox_images
      SET status='revoked', revoked_at=now(), revoked_by=$3, revoke_reason=$4, updated_at=now()
      WHERE workspace_id=$1 AND reference=$2 RETURNING ${sandboxImageColumns}`,
      [context.workspaceId, reference, input.actor, input.reason]);
    if (!result.rows[0]) throw new WorkspaceNotFoundError("Sandbox image not found");
    return result.rows[0];
  }

  async latestVerifiedSandboxImage(context: AuthContext, variant: SandboxImageVariant): Promise<SandboxImage | null> {
    const result = await this.pool.query<SandboxImage>(`SELECT ${sandboxImageColumns} FROM sandbox_images
      WHERE workspace_id=$1 AND variant=$2 AND status='verified'
      ORDER BY scan_at DESC NULLS LAST, created_at DESC LIMIT 1`, [context.workspaceId, variant]);
    return result.rows[0] ?? null;
  }

  // --- C1a: feature flags and tool manifests ------------------------------------------------

  async listFeatureFlags(context: AuthContext): Promise<FeatureFlag[]> {
    const result = await this.pool.query<FeatureFlag>(`SELECT ${featureFlagColumns} FROM feature_flags
      WHERE workspace_id=$1 ORDER BY flag_key, scope, scope_id`, [context.workspaceId]);
    return result.rows;
  }

  async setFeatureFlag(context: AuthContext, input: FeatureFlagInput): Promise<FeatureFlag> {
    const scopeId = input.scope === "global" ? "" : (input.scopeId ?? "");
    if (input.scope !== "global" && !scopeId) throw new WorkspaceAccessError("scopeId is required for company and user scoped flags");
    const current = await this.pool.query<FeatureFlag>(`SELECT ${featureFlagColumns} FROM feature_flags
      WHERE workspace_id=$1 AND scope=$2 AND scope_id=$3 AND flag_key=$4`, [context.workspaceId, input.scope, scopeId, input.flagKey]);
    const previous = current.rows[0] ?? null;
    if (input.expectedRevision !== undefined && previous && previous.revision !== input.expectedRevision) {
      throw new WorkspaceAccessError("Feature flag changed by another request. Reload and try again.");
    }
    const stage = input.stage ?? previous?.stage ?? "off";
    const enabled = input.enabled ?? previous?.enabled ?? false;
    const rolloutPercent = input.rolloutPercent ?? previous?.rolloutPercent ?? 0;
    const allowlist = input.allowlist ?? previous?.allowlist ?? [];
    const result = await this.pool.query<FeatureFlag>(`INSERT INTO feature_flags
      (id, workspace_id, scope, scope_id, flag_key, stage, enabled, rollout_percent, allowlist, revision, updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10)
      ON CONFLICT (workspace_id, scope, scope_id, flag_key) DO UPDATE
        SET stage=$6, enabled=$7, rollout_percent=$8, allowlist=$9,
            revision=feature_flags.revision+1, updated_by=$10, updated_at=now()
      RETURNING ${featureFlagColumns}`,
      [randomUUID(), context.workspaceId, input.scope, scopeId, input.flagKey, stage, enabled, rolloutPercent, JSON.stringify(allowlist), context.userId]);
    await this.pool.query(`INSERT INTO feature_flag_history
      (id, workspace_id, flag_key, scope, scope_id, previous_value, next_value, actor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), context.workspaceId, input.flagKey, input.scope, scopeId,
        previous ? JSON.stringify(previous) : null, JSON.stringify(result.rows[0]!), context.userId]);
    return result.rows[0]!;
  }

  async listFeatureFlagHistory(context: AuthContext, flagKey?: string, limit = 100): Promise<FeatureFlagHistoryEntry[]> {
    const result = await this.pool.query<FeatureFlagHistoryEntry>(`SELECT id, workspace_id AS "workspaceId", flag_key AS "flagKey",
      scope, scope_id AS "scopeId", previous_value AS "previousValue", next_value AS "nextValue", actor, created_at AS "createdAt"
      FROM feature_flag_history WHERE workspace_id=$1 AND ($2::text IS NULL OR flag_key=$2)
      ORDER BY created_at DESC LIMIT $3`, [context.workspaceId, flagKey ?? null, Math.max(1, Math.min(limit, 500))]);
    return result.rows;
  }

  async publishCodeToolManifest(context: AuthContext, manifest: { version: number; tools: CodeToolManifest["tools"]; checksum: string }): Promise<CodeToolManifest> {
    const result = await this.pool.query<CodeToolManifest>(`INSERT INTO code_tool_manifest (version, tools, checksum)
      VALUES($1,$2,$3)
      ON CONFLICT (version) DO UPDATE SET tools=$2, checksum=$3
      RETURNING version, tools, checksum, created_at AS "createdAt"`, [manifest.version, JSON.stringify(manifest.tools), manifest.checksum]);
    return result.rows[0]!;
  }

  async latestCodeToolManifest(context: AuthContext): Promise<CodeToolManifest | null> {
    const result = await this.pool.query<CodeToolManifest>(`SELECT version, tools, checksum, created_at AS "createdAt"
      FROM code_tool_manifest ORDER BY version DESC LIMIT 1`);
    return result.rows[0] ?? null;
  }

  // --- C1c: append-only audit log ----------------------------------------------------------

  /**
   * Appends one audit entry. The chain is computed inside a transaction that holds a per-company
   * advisory lock, so concurrent privileged actions cannot fork or reorder the chain; the database
   * triggers (migration 066) independently reject out-of-order inserts and any UPDATE/DELETE.
   * Failures propagate: privileged actions must fail closed when the audit cannot be written.
   */
  async appendAuditEntry(context: AuthContext, companyId: string, input: AuditEntryInput): Promise<AuditEntry> {
    await this.assertCompany(context, companyId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`audit:${companyId}`]);
      const head = await client.query<{ sequence: string; entry_hash: string }>(
        "SELECT sequence, entry_hash FROM audit_log WHERE company_id=$1 ORDER BY sequence DESC LIMIT 1",
        [companyId],
      );
      const prevHash = head.rows[0]?.entry_hash ?? null;
      const sequence = head.rows[0] ? Number(head.rows[0].sequence) + 1 : 1;
      const createdAt = new Date().toISOString();
      const id = randomUUID();
      const metadata = input.metadata ?? {};
      const entryHash = auditEntryHash(prevHash, {
        id, companyId, sequence, createdAt, actor: input.actor, actorRole: input.actorRole,
        requestId: input.requestId ?? null, correlationId: input.correlationId ?? null, snapshotId: input.snapshotId ?? null,
        action: input.action, resourceType: input.resourceType, resourceId: input.resourceId ?? null,
        projectId: input.projectId ?? null, decision: input.decision, payloadHash: input.payloadHash, metadata,
      });
      const inserted = await client.query<AuditEntry>(`INSERT INTO audit_log
        (id, workspace_id, company_id, sequence, created_at, actor, actor_role, request_id, correlation_id, snapshot_id,
         action, resource_type, resource_id, project_id, decision, payload_hash, prev_hash, entry_hash, metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING ${auditEntryColumns}`,
        [id, context.workspaceId, companyId, sequence, createdAt, input.actor, input.actorRole,
          input.requestId ?? null, input.correlationId ?? null, input.snapshotId ?? null,
          input.action, input.resourceType, input.resourceId ?? null, input.projectId ?? null,
          input.decision, input.payloadHash, prevHash, entryHash, JSON.stringify(metadata)]);
      await client.query("COMMIT");
      return inserted.rows[0]!;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async listAuditEntries(context: AuthContext, companyId: string, filters: { actor?: string; requestId?: string; correlationId?: string; action?: string; limit?: number; fromSequence?: number } = {}): Promise<AuditEntry[]> {
    await this.assertCompany(context, companyId);
    const result = await this.pool.query<AuditEntry>(`SELECT ${auditEntryColumns} FROM audit_log
      WHERE workspace_id=$1 AND company_id=$2
        AND ($3::text IS NULL OR actor=$3)
        AND ($4::text IS NULL OR request_id=$4)
        AND ($5::text IS NULL OR correlation_id=$5)
        AND ($6::text IS NULL OR action=$6)
        AND ($7::bigint IS NULL OR sequence >= $7)
      ORDER BY sequence ASC LIMIT $8`,
      [context.workspaceId, companyId, filters.actor ?? null, filters.requestId ?? null, filters.correlationId ?? null,
        filters.action ?? null, filters.fromSequence ?? null, Math.max(1, Math.min(filters.limit ?? 200, 1000))]);
    return result.rows;
  }

  /**
   * C5: scoped approval rules. `once` approvals deliberately have no row here — they stay bound to a
   * single payload hash in `company_approvals`, which is why a rule can only ever *add* a bounded
   * allowance and can never widen a prohibition decided in an earlier policy phase.
   */
  async createCodeApprovalRule(context: AuthContext, companyId: string, input: CodeApprovalRuleInput): Promise<CodeApprovalRule> {
    await this.assertCompany(context, companyId);
    if (input.scope === "session" && !input.sessionId) {
      throw new WorkspaceAccessError("A session-scoped approval rule must name its session");
    }
    if (!input.projectId) {
      throw new WorkspaceAccessError("An approval rule must name its project");
    }
    const result = await this.pool.query<CodeApprovalRule>(
      `INSERT INTO code_approval_rules (
         id, workspace_id, company_id, project_id, session_id, created_by, scope, action, decision, reason, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'allow',$9,$10)
       ON CONFLICT (company_id, COALESCE(project_id,''), COALESCE(session_id,''), scope, action) DO UPDATE
         SET reason=EXCLUDED.reason, expires_at=EXCLUDED.expires_at, created_by=EXCLUDED.created_by,
             revision=code_approval_rules.revision+1, updated_at=now()
       RETURNING ${codeApprovalRuleColumns}`,
      [randomUUID(), context.workspaceId, companyId, input.projectId, input.sessionId ?? null, context.userId,
        input.scope, input.action, input.reason ?? null, input.expiresAt ?? null]);
    return result.rows[0]!;
  }

  async listCodeApprovalRules(context: AuthContext, companyId: string, filters: { projectId?: string; sessionId?: string; scope?: CodeApprovalRuleScope } = {}): Promise<CodeApprovalRule[]> {
    await this.assertCompany(context, companyId);
    const result = await this.pool.query<CodeApprovalRule>(
      `SELECT ${codeApprovalRuleColumns} FROM code_approval_rules
       WHERE workspace_id=$1 AND company_id=$2
         AND ($3::text IS NULL OR project_id=$3)
         AND ($4::text IS NULL OR session_id=$4)
         AND ($5::text IS NULL OR scope=$5)
       ORDER BY created_at DESC`,
      [context.workspaceId, companyId, filters.projectId ?? null, filters.sessionId ?? null, filters.scope ?? null]);
    return result.rows;
  }

  async deleteCodeApprovalRule(context: AuthContext, companyId: string, ruleId: string): Promise<void> {
    await this.assertCompany(context, companyId);
    await this.pool.query("DELETE FROM code_approval_rules WHERE workspace_id=$1 AND company_id=$2 AND id=$3",
      [context.workspaceId, companyId, ruleId]);
  }

  async findMatchingCodeApprovalRule(context: AuthContext, query: { companyId: string; projectId?: string | null; sessionId?: string | null; action: string }): Promise<CodeApprovalRule | null> {
    await this.assertCompany(context, query.companyId);
    // Most specific first: a session rule wins over a project rule. Expired rules never match.
    const result = await this.pool.query<CodeApprovalRule>(
      `SELECT ${codeApprovalRuleColumns} FROM code_approval_rules
       WHERE workspace_id=$1 AND company_id=$2 AND action=$3 AND decision='allow'
         AND (expires_at IS NULL OR expires_at > now())
         AND (
           (scope='session' AND session_id=$4 AND $4::text IS NOT NULL AND project_id=$5 AND $5::text IS NOT NULL)
           OR (scope='project' AND project_id=$5 AND $5::text IS NOT NULL)
         )
       ORDER BY CASE scope WHEN 'session' THEN 0 ELSE 1 END ASC, created_at DESC
       LIMIT 1`,
      [context.workspaceId, query.companyId, query.action, query.sessionId ?? null, query.projectId ?? null]);
    return result.rows[0] ?? null;
  }

  async verifyAuditChain(context: AuthContext, companyId: string, range: { fromSequence?: number; toSequence?: number } = {}): Promise<AuditChainVerification> {
    await this.assertCompany(context, companyId);
    const result = await this.pool.query<AuditEntry>(`SELECT ${auditEntryColumns} FROM audit_log
      WHERE workspace_id=$1 AND company_id=$2
        AND ($3::bigint IS NULL OR sequence >= $3)
        AND ($4::bigint IS NULL OR sequence <= $4)
      ORDER BY sequence ASC`,
      [context.workspaceId, companyId, range.fromSequence ?? null, range.toSequence ?? null]);
    return verifyAuditEntries(result.rows);
  }

  async auditChainState(context: AuthContext, companyId: string): Promise<AuditChainState> {
    await this.assertCompany(context, companyId);
    const result = await this.pool.query<{ entry_count: string; head_sequence: string | null; head_hash: string | null }>(
      "SELECT count(*)::text AS entry_count, max(sequence)::text AS head_sequence, (array_agg(entry_hash ORDER BY sequence DESC))[1] AS head_hash FROM audit_log WHERE company_id=$1",
      [companyId]);
    const row = result.rows[0];
    return {
      companyId,
      entryCount: Number(row?.entry_count ?? 0),
      headSequence: Number(row?.head_sequence ?? 0),
      headHash: row?.head_hash ?? null,
    };
  }

  async recordAuditAnchor(context: AuthContext, companyId: string, anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null }): Promise<AuditAnchor> {
    await this.assertCompany(context, companyId);
    const result = await this.pool.query<AuditAnchor>(`INSERT INTO audit_anchors
      (id, workspace_id, company_id, day, sequence, entry_count, head_hash, anchor_path, signature)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (company_id, day) DO UPDATE SET sequence=$5, entry_count=$6, head_hash=$7, anchor_path=$8, signature=$9, created_at=now()
      RETURNING ${auditAnchorColumns}`,
      [randomUUID(), context.workspaceId, companyId, anchor.day, anchor.sequence, anchor.entryCount, anchor.headHash, anchor.anchorPath ?? null, anchor.signature ?? null]);
    return result.rows[0]!;
  }

  async listAuditAnchors(context: AuthContext, companyId: string, limit = 90): Promise<AuditAnchor[]> {
    await this.assertCompany(context, companyId);
    const result = await this.pool.query<AuditAnchor>(`SELECT ${auditAnchorColumns} FROM audit_anchors
      WHERE workspace_id=$1 AND company_id=$2 ORDER BY day DESC LIMIT $3`,
      [context.workspaceId, companyId, Math.max(1, Math.min(limit, 365))]);
    return result.rows;
  }

  async latestAuditAnchor(context: AuthContext, companyId: string): Promise<AuditAnchor | null> {
    const anchors = await this.listAuditAnchors(context, companyId, 1);
    return anchors[0] ?? null;
  }

  async auditCompanies(context: AuthContext): Promise<string[]> {
    const result = await this.pool.query<{ company_id: string }>(
      "SELECT DISTINCT company_id FROM audit_log WHERE workspace_id=$1 ORDER BY company_id", [context.workspaceId]);
    return result.rows.map((row) => row.company_id);
  }

  /** Background verifier path: no user context, workspace-scoped, hashes and counts only. */
  async systemAuditChains(workspaceId: string) {
    const companies = await this.pool.query<{ company_id: string }>(
      "SELECT DISTINCT company_id FROM audit_log WHERE workspace_id=$1 ORDER BY company_id", [workspaceId]);
    const result: Array<{ companyId: string; state: AuditChainState; verification: AuditChainVerification }> = [];
    for (const row of companies.rows) {
      const entries = await this.pool.query<AuditEntry>(`SELECT ${auditEntryColumns} FROM audit_log
        WHERE workspace_id=$1 AND company_id=$2 ORDER BY sequence ASC`, [workspaceId, row.company_id]);
      const verification = verifyAuditEntries(entries.rows);
      const last = entries.rows[entries.rows.length - 1];
      result.push({
        companyId: row.company_id,
        state: { companyId: row.company_id, entryCount: entries.rows.length, headSequence: last?.sequence ?? 0, headHash: last?.entryHash ?? null },
        verification: { ...verification, companyId: row.company_id },
      });
    }
    return result;
  }

  async systemRecordAuditAnchor(workspaceId: string, companyId: string, anchor: { day: string; sequence: number; entryCount: number; headHash: string; anchorPath?: string | null; signature?: string | null }): Promise<AuditAnchor> {
    const result = await this.pool.query<AuditAnchor>(`INSERT INTO audit_anchors
      (id, workspace_id, company_id, day, sequence, entry_count, head_hash, anchor_path, signature)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (company_id, day) DO UPDATE SET sequence=$5, entry_count=$6, head_hash=$7, anchor_path=$8, signature=$9, created_at=now()
      RETURNING ${auditAnchorColumns}`,
      [randomUUID(), workspaceId, companyId, anchor.day, anchor.sequence, anchor.entryCount, anchor.headHash, anchor.anchorPath ?? null, anchor.signature ?? null]);
    return result.rows[0]!;
  }

  async health() {
    try { await this.pool.query("SELECT 1"); return "ok" as const; }
    catch { return "unavailable" as const; }
  }

  async getUserSetting(context: AuthContext, key: string): Promise<StoredUserSetting | null> {
    await this.ensureMemberIdentity(context);
    const result = await this.pool.query<StoredUserSetting & { updated_at: string }>(`SELECT setting_key AS key, value, revision,
      updated_at::text AS updated_at FROM workspace_user_settings
      WHERE workspace_id=$1 AND user_id=$2 AND setting_key=$3`, [context.workspaceId, context.userId, key]);
    const row = result.rows[0];
    return row ? { key: row.key, value: row.value, revision: row.revision, updatedAt: row.updated_at } : null;
  }

  async setUserSetting(context: AuthContext, key: string, value: unknown, expectedRevision: number): Promise<StoredUserSetting | null> {
    await this.ensureMemberIdentity(context);
    const parameters = [context.workspaceId, context.userId, key, JSON.stringify(value), expectedRevision];
    const sql = expectedRevision === 0
      ? `INSERT INTO workspace_user_settings(workspace_id,user_id,setting_key,value,revision)
          VALUES ($1,$2,$3,$4::jsonb,1) ON CONFLICT DO NOTHING
          RETURNING setting_key AS key,value,revision,updated_at::text AS updated_at`
      : `UPDATE workspace_user_settings SET value=$4::jsonb,revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND user_id=$2 AND setting_key=$3 AND revision=$5
          RETURNING setting_key AS key,value,revision,updated_at::text AS updated_at`;
    const queryParameters = expectedRevision === 0 ? parameters.slice(0, 4) : parameters;
    const result = await this.pool.query<StoredUserSetting & { updated_at: string }>(sql, queryParameters);
    const row = result.rows[0];
    return row ? { key: row.key, value: row.value, revision: row.revision, updatedAt: row.updated_at } : null;
  }

  private async ensureMemberIdentity(context: AuthContext) {
    const member = await this.pool.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [context.workspaceId, context.userId]);
    if (!member.rowCount) await this.ensureIdentity(context);
  }

  private async ensureIdentity(context: AuthContext) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO users(id, external_subject, display_name) VALUES ($1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET external_subject=COALESCE(EXCLUDED.external_subject,users.external_subject), updated_at=now()`, [context.userId, context.externalSubject ?? null, "Dev User"]);
      await client.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES ($1,$2,$3) ON CONFLICT(id) DO NOTHING`, [context.workspaceId, "My Workspace", context.userId]);
      await client.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'owner') ON CONFLICT(workspace_id,user_id) DO NOTHING`, [context.workspaceId, context.userId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async assertMember(context: AuthContext) {
    const result = await this.pool.query("SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Workspace access denied");
    return String(result.rows[0].role);
  }

  async getBusiness(context: AuthContext, businessId: string) {
    await this.assertMember(context);
    const result = await this.pool.query<Business>(`SELECT ${businessColumns} FROM businesses WHERE id=$1 AND workspace_id=$2`, [businessId, context.workspaceId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Business is not available in this workspace");
    return result.rows[0]!;
  }

  async getUserBusiness(context: AuthContext, businessId: string) {
    await this.assertMember(context);
    const result = await this.pool.query<Business>(`SELECT ${businessColumns} FROM businesses WHERE id=$1 AND workspace_id=$2 AND owner_user_id=$3`, [businessId, context.workspaceId, context.userId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Business is not available or not owned by this user");
    return result.rows[0]!;
  }

  async listBusinesses(context: AuthContext) {
    await this.assertMember(context);
    return (await this.pool.query<Business>(`SELECT ${businessColumns} FROM businesses WHERE workspace_id=$1 AND activation_status='active' ORDER BY created_at`, [context.workspaceId])).rows;
  }

  async listUserBusinesses(context: AuthContext) {
    await this.assertMember(context);
    return (await this.pool.query<Business>(`SELECT ${businessColumns} FROM businesses WHERE workspace_id=$1 AND owner_user_id=$2 AND activation_status='active' ORDER BY updated_at DESC`, [context.workspaceId, context.userId])).rows;
  }

  async listBusinessesPage(context: AuthContext, requestedLimit = 20, cursor?: string) {
    await this.assertMember(context);
    const limit = companyPageLimit(requestedLimit);
    const after = decodeBusinessCursor(cursor);
    const result = await this.pool.query<Business>(`SELECT ${businessColumns} FROM businesses
      WHERE workspace_id=$1 AND activation_status='active'
        AND ($2::timestamptz IS NULL OR (created_at,id) > ($2::timestamptz,$3::text))
      ORDER BY created_at,id LIMIT $4`, [context.workspaceId, after?.createdAt ?? null, after?.id ?? '', limit + 1]);
    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeBusinessCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }

  async overview(context: AuthContext): Promise<WorkspaceOverview> {
    await this.ensureIdentity(context);
    const role = await this.assertMember(context);
    const businesses = await this.listBusinesses(context);
    const identity = await this.pool.query(`SELECT u.display_name, w.name, wm.current_business_id
      FROM workspace_members wm JOIN users u ON u.id=wm.user_id JOIN workspaces w ON w.id=wm.workspace_id
      WHERE wm.workspace_id=$1 AND wm.user_id=$2`, [context.workspaceId, context.userId]);
    let currentId = identity.rows[0]?.current_business_id as string | null;
    if (!currentId && businesses.length > 0) {
      currentId = businesses[0]!.id;
      await this.pool.query("UPDATE workspace_members SET current_business_id=$3 WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId, currentId]);
    }
    return {
      user: { id: context.userId, displayName: String(identity.rows[0]?.display_name ?? "Dev User") },
      workspace: { id: context.workspaceId, name: String(identity.rows[0]?.name ?? "My Workspace"), role },
      businesses,
      currentBusiness: businesses.find((business) => business.id === currentId) ?? null,
      onboarding: (await this.listOnboardings(context))[0] ?? null,
      onboardings: await this.listOnboardings(context),
    };
  }

  async setCurrentBusiness(context: AuthContext, businessId: string) {
    const business = await this.getBusiness(context, businessId);
    if (business.activationStatus !== "active") throw new Error("Complete business onboarding before selecting this business");
    await this.pool.query("UPDATE workspace_members SET current_business_id=$3 WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId, businessId]);
    return business;
  }

  async createBusiness(context: AuthContext, input: BusinessInput, idempotencyKey?: string) {
    await this.assertMember(context);
    const id = randomUUID();
    const values = [id, context.workspaceId, context.userId, input.name.trim(), input.businessType ?? null, input.industry ?? null, input.niche ?? null, input.country ?? null, input.market ?? null, input.website ?? null, input.businessStage ?? "starting", input.teamType ?? null, input.businessModel ?? null, input.presenceType ?? null, input.description ?? null, input.audienceSummary ?? null, input.productsServicesSummary ?? null, input.legalName ?? null, input.contactEmail ?? null, input.contactPhone ?? null, input.postalAddress ?? null, input.registrationDetails ?? null, input.logoFileId || null, idempotencyKey ?? null];
    if (!values[3]) throw new Error("Business name is required");
    const result = await this.pool.query<Business>(`INSERT INTO businesses(id,workspace_id,owner_user_id,name,business_type,industry,niche,country,market,website,business_stage,team_type,business_model,presence_type,description,audience_summary,products_services_summary,legal_name,contact_email,contact_phone,postal_address,registration_details,logo_file_id,create_request_key)
      VALUES (${values.map((_, index) => `$${index + 1}`).join(",")})
      ON CONFLICT (workspace_id,owner_user_id,create_request_key) WHERE create_request_key IS NOT NULL DO NOTHING
      RETURNING ${businessColumns}`, values);
    const business = result.rows[0] ?? (idempotencyKey ? (await this.pool.query<Business>(`SELECT ${businessColumns} FROM businesses WHERE workspace_id=$1 AND owner_user_id=$2 AND create_request_key=$3`, [context.workspaceId, context.userId, idempotencyKey])).rows[0] : undefined);
    if (!business) throw new Error('Could not create company');
    await this.setCurrentBusiness(context, business.id);
    return business;
  }

  async updateBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>) {
    await this.getBusiness(context, businessId);
    const values = [businessId, context.workspaceId, input.name, input.businessType, input.industry, input.niche, input.country, input.market, input.website, input.businessStage, input.teamType, input.businessModel, input.presenceType, input.description, input.audienceSummary, input.productsServicesSummary, input.legalName, input.contactEmail, input.contactPhone, input.postalAddress, input.registrationDetails, input.logoFileId || undefined];
    const result = await this.pool.query<Business>(`UPDATE businesses SET
      name=COALESCE($3,name), business_type=COALESCE($4,business_type), industry=COALESCE($5,industry), niche=COALESCE($6,niche),
      country=COALESCE($7,country), market=COALESCE($8,market), website=COALESCE($9,website), business_stage=COALESCE($10,business_stage),
      team_type=COALESCE($11,team_type), business_model=COALESCE($12,business_model), presence_type=COALESCE($13,presence_type),
      description=COALESCE($14,description), audience_summary=COALESCE($15,audience_summary),
      products_services_summary=COALESCE($16,products_services_summary),legal_name=COALESCE($17,legal_name),
      contact_email=COALESCE($18,contact_email),contact_phone=COALESCE($19,contact_phone),postal_address=COALESCE($20,postal_address),
      registration_details=COALESCE($21,registration_details),logo_file_id=COALESCE($22,logo_file_id),updated_at=now()
      WHERE id=$1 AND workspace_id=$2 RETURNING ${businessColumns}`, values.map((value) => value === undefined ? null : value));
    return result.rows[0]!;
  }

  async updateUserBusiness(context: AuthContext, businessId: string, input: Partial<BusinessInput>) {
    await this.getUserBusiness(context, businessId);
    const values = [businessId, context.workspaceId, context.userId, input.name, input.businessType, input.industry, input.niche, input.country, input.market, input.website, input.businessStage, input.teamType, input.businessModel, input.presenceType, input.description, input.audienceSummary, input.productsServicesSummary, input.legalName, input.contactEmail, input.contactPhone, input.postalAddress, input.registrationDetails, input.logoFileId || undefined];
    const result = await this.pool.query<Business>(`UPDATE businesses SET
      name=COALESCE($4,name), business_type=COALESCE($5,business_type), industry=COALESCE($6,industry), niche=COALESCE($7,niche),
      country=COALESCE($8,country), market=COALESCE($9,market), website=COALESCE($10,website), business_stage=COALESCE($11,business_stage),
      team_type=COALESCE($12,team_type), business_model=COALESCE($13,business_model), presence_type=COALESCE($14,presence_type),
      description=COALESCE($15,description), audience_summary=COALESCE($16,audience_summary),
      products_services_summary=COALESCE($17,products_services_summary),legal_name=COALESCE($18,legal_name),
      contact_email=COALESCE($19,contact_email),contact_phone=COALESCE($20,contact_phone),postal_address=COALESCE($21,postal_address),
      registration_details=COALESCE($22,registration_details),logo_file_id=COALESCE($23,logo_file_id),updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND owner_user_id=$3 RETURNING ${businessColumns}`, values.map((value) => value === undefined ? null : value));
    return result.rows[0]!;
  }

  async deleteBusiness(context: AuthContext, businessId: string) {
    await this.getBusiness(context, businessId);
    return Boolean((await this.pool.query("DELETE FROM businesses WHERE id=$1 AND workspace_id=$2 RETURNING id", [businessId, context.workspaceId])).rowCount);
  }


  private async assertCompany(context: AuthContext, companyId: string) {
    if (context.companyId && context.companyId !== companyId) throw new WorkspaceAccessError("API key is not valid for this company");
    await this.assertMember(context);
    const result = await this.pool.query<Company>(`SELECT ${companyColumns} FROM companies WHERE id=$1 AND workspace_id=$2 AND user_id=$3`, [companyId, context.workspaceId, context.userId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Company is not available to this user");
    return result.rows[0]!;
  }

  async listCompanies(context: AuthContext, requestedLimit = 20, cursor?: string) {
    await this.assertMember(context);
    const limit = companyPageLimit(requestedLimit), after = decodeBusinessCursor(cursor);
    const result = await this.pool.query<Company>(`SELECT ${companyColumns} FROM companies
      WHERE workspace_id=$1 AND user_id=$2 AND ($3::text IS NULL OR id=$3)
        AND ($4::timestamptz IS NULL OR (created_at,id) > ($4::timestamptz,$5::text))
      ORDER BY created_at,id LIMIT $6`, [context.workspaceId, context.userId, context.companyId ?? null, after?.createdAt ?? null, after?.id ?? "", limit + 1]);
    const items = result.rows.slice(0, limit), last = items.at(-1);
    return { items, nextCursor: result.rows.length > limit && last ? encodeBusinessCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }

  async getCompany(context: AuthContext, companyId: string) { return this.assertCompany(context, companyId); }

  async createCompany(context: AuthContext, input: CompanyInput, idempotencyKey: string) {
    if (context.companyId) throw new WorkspaceAccessError("Company-scoped API keys cannot create companies");
    await this.assertMember(context);
    const name = input.name?.trim();
    if (!name) throw new Error("Company name is required");
    if (input.businessId) await this.getBusiness(context, input.businessId);
    const values = [randomUUID(), context.workspaceId, context.userId, input.businessId ?? null, name, input.website ?? null,
      input.industry ?? null, input.description ?? null, input.productsServices ?? null, JSON.stringify(input.languages ?? []),
      input.brandTone ?? null, input.companyInstructions ?? null, JSON.stringify(input.knowledge ?? []),
      JSON.stringify(input.memory ?? {}), input.status ?? "active", idempotencyKey];
    const result = await this.pool.query<Company>(`INSERT INTO companies(
      id,workspace_id,user_id,business_id,name,website,industry,description,products_services,languages,
      brand_tone,company_instructions,knowledge,memory,status,create_request_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14::jsonb,$15,$16)
      ON CONFLICT (workspace_id,user_id,create_request_key) WHERE create_request_key IS NOT NULL DO NOTHING
      RETURNING ${companyColumns}`, values);
    const company = result.rows[0] ?? (await this.pool.query<Company>(`SELECT ${companyColumns} FROM companies
      WHERE workspace_id=$1 AND user_id=$2 AND create_request_key=$3`, [context.workspaceId, context.userId, idempotencyKey])).rows[0];
    if (!company) throw new Error("Could not create company");
    return company;
  }

  async convertBusinessToCompany(context: AuthContext, businessId: string, input: BusinessToCompanyInput, idempotencyKey: string): Promise<{ company: Company; created: boolean }> {
    const business = await this.getBusiness(context, businessId);
    const existing = (await this.pool.query<Company>(`SELECT ${companyColumns} FROM companies
      WHERE workspace_id=$1 AND user_id=$2 AND create_request_key=$3`, [context.workspaceId, context.userId, idempotencyKey])).rows[0];
    if (existing) {
      return { company: existing, created: false };
    }

    const memory: Record<string, unknown> = {};
    if (input.includeConfirmedMemory) {
      const memories = await this.listMemory(context, businessId);
      memory["confirmed_business_facts"] = memories.map((m) => m.content);
    }
    if (input.includeGoals) {
      const goals = await this.listGoals(context, businessId);
      memory["transferred_goals"] = goals.map((g) => ({ title: g.title, description: g.description, status: g.status }));
    }

    const instructionParts: string[] = [];
    if (input.includeInstructions) {
      if (business.description) instructionParts.push(`Business Description: ${business.description}`);
      if (business.businessModel) instructionParts.push(`Business Model: ${business.businessModel}`);
    }
    if (input.includeResearchSummary) {
      if (business.audienceSummary) instructionParts.push(`Target Audience: ${business.audienceSummary}`);
      if (business.market) instructionParts.push(`Market & Niche: ${business.market} / ${business.niche ?? ""}`);
    }

    const companyInput: CompanyInput = {
      name: input.companyName?.trim() || business.name,
      businessId: business.id,
      website: business.website,
      industry: business.industry,
      description: business.description,
      productsServices: business.productsServicesSummary,
      knowledge: business.logoFileId ? [{ attachmentId: business.logoFileId, kind: "image", name: "Company logo", source: "linked_business" }] : [],
      companyInstructions: instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined,
      memory,
      languages: ["Ukrainian", "English"],
      status: "active",
    };

    const company = await this.createCompany(context, companyInput, idempotencyKey);

    const mainAgent = await this.createCompanyAgent(context, company.id, {
      name: "Main Agent",
      role: "Coordinator",
      description: `Primary executive agent for ${company.name}`,
      tools: ["web.search", "files", "knowledge"],
      isActive: true,
    }, `${idempotencyKey}:main-agent`);

    await this.setCompanyMainAgent(context, company.id, mainAgent.id, company.revision);
    const updatedCompany = await this.getCompany(context, company.id);

    return { company: updatedCompany, created: true };
  }

  async updateCompany(context: AuthContext, companyId: string, input: Partial<CompanyInput>, expectedRevision: number) {
    await this.assertCompany(context, companyId);
    if (input.businessId) await this.getBusiness(context, input.businessId);
    if (input.name !== undefined && !input.name.trim()) throw new Error("Company name is required");
    const patch = JSON.stringify(input);
    const result = await this.pool.query<Company>(`UPDATE companies SET
      business_id=CASE WHEN $4::jsonb ? 'businessId' THEN NULLIF($4::jsonb->>'businessId','') ELSE business_id END,
      name=CASE WHEN $4::jsonb ? 'name' THEN trim($4::jsonb->>'name') ELSE name END,
      website=CASE WHEN $4::jsonb ? 'website' THEN NULLIF($4::jsonb->>'website','') ELSE website END,
      industry=CASE WHEN $4::jsonb ? 'industry' THEN NULLIF($4::jsonb->>'industry','') ELSE industry END,
      description=CASE WHEN $4::jsonb ? 'description' THEN NULLIF($4::jsonb->>'description','') ELSE description END,
      products_services=CASE WHEN $4::jsonb ? 'productsServices' THEN NULLIF($4::jsonb->>'productsServices','') ELSE products_services END,
      languages=CASE WHEN $4::jsonb ? 'languages' THEN $4::jsonb->'languages' ELSE languages END,
      brand_tone=CASE WHEN $4::jsonb ? 'brandTone' THEN NULLIF($4::jsonb->>'brandTone','') ELSE brand_tone END,
      company_instructions=CASE WHEN $4::jsonb ? 'companyInstructions' THEN NULLIF($4::jsonb->>'companyInstructions','') ELSE company_instructions END,
      memory=CASE WHEN $4::jsonb ? 'memory' THEN $4::jsonb->'memory' ELSE memory END,
      status=CASE WHEN $4::jsonb ? 'status' THEN $4::jsonb->>'status' ELSE status END,
      revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND revision=$5 RETURNING ${companyColumns}`,
      [companyId, context.workspaceId, context.userId, patch, expectedRevision]);
    if (!result.rowCount) throw new Error("Company was changed by another request. Reload and try again.");
    return result.rows[0]!;
  }

  async deleteCompany(context: AuthContext, companyId: string) {
    await this.assertCompany(context, companyId);
    return Boolean((await this.pool.query("DELETE FROM companies WHERE id=$1 AND workspace_id=$2 AND user_id=$3 RETURNING id", [companyId, context.workspaceId, context.userId])).rowCount);
  }


  async setCompanyMainAgent(context: AuthContext, companyId: string, agentId: string | null, expectedRevision: number) {
    await this.assertCompany(context, companyId);
    if (agentId) await this.getCompanyAgent(context, companyId, agentId);
    const result = await this.pool.query<Company>(`UPDATE companies SET main_agent_id=$4,revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND revision=$5 RETURNING ${companyColumns}`,
      [companyId, context.workspaceId, context.userId, agentId, expectedRevision]);
    if (!result.rowCount) throw new Error("Company was changed by another request. Reload and try again.");
    return result.rows[0]!;
  }

  async listCompanyAgents(context: AuthContext, companyId: string) {
    await this.assertCompany(context, companyId);
    return (await this.pool.query<CompanyAgent>(`SELECT ${companyAgentColumns} FROM company_agents
      WHERE workspace_id=$1 AND company_id=$2 ORDER BY sort_order,created_at,id`, [context.workspaceId, companyId])).rows;
  }

  async listCompanyAgentsPage(context: AuthContext, companyId: string, requestedLimit = 50, cursor?: string) {
    await this.assertCompany(context, companyId);
    const limit = companyPageLimit(requestedLimit), after = decodeBusinessCursor(cursor);
    const result = await this.pool.query<CompanyAgent>(`SELECT ${companyAgentColumns} FROM company_agents
      WHERE workspace_id=$1 AND company_id=$2
        AND ($3::timestamptz IS NULL OR (created_at,id) > ($3::timestamptz,$4::text))
      ORDER BY created_at,id LIMIT $5`, [context.workspaceId, companyId, after?.createdAt ?? null, after?.id ?? "", limit + 1]);
    const items = result.rows.slice(0, limit), last = items.at(-1);
    return { items, nextCursor: result.rows.length > limit && last ? encodeBusinessCursor({ createdAt: last.createdAt, id: last.id }) : null };
  }


  async createProject(context: AuthContext, companyId: string, input: ProjectInput, idempotencyKey: string) {
    await this.assertCompany(context, companyId);
    const created = await this.pool.query<Project>(`INSERT INTO projects
      (id,workspace_id,company_id,created_by,name,description,type,create_request_key,data_backend_id,app_scheme,
       data_classification,retention_class,default_branch,toolchain)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (workspace_id,company_id,created_by,create_request_key) DO NOTHING
      RETURNING ${projectColumns}`,
      [randomUUID(), context.workspaceId, companyId, context.userId, input.name, input.description ?? null, input.type, idempotencyKey,
        input.dataBackendId ?? null, input.appScheme ?? null,
        input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION, input.retentionClass ?? DEFAULT_RETENTION_CLASS,
        input.defaultBranch ?? null, input.toolchain ? JSON.stringify(input.toolchain) : null]);
    if (created.rows[0]) return { project: created.rows[0], created: true };
    const existing = await this.pool.query<Project>(`SELECT ${projectColumns} FROM projects
      WHERE workspace_id=$1 AND company_id=$2 AND created_by=$3 AND create_request_key=$4`,
      [context.workspaceId,companyId,context.userId,idempotencyKey]);
    if (!existing.rows[0]) throw new WorkspaceNotFoundError("Project not found");
    return { project: existing.rows[0], created: false };
  }

  async listProjects(context: AuthContext, companyId: string, includeArchived = false) {
    await this.assertCompany(context, companyId);
    const result = await this.pool.query<Project>(`SELECT ${projectColumns} FROM projects
      WHERE workspace_id=$1 AND company_id=$2 AND created_by=$3 AND ($4 OR status<>'archived')
      ORDER BY updated_at DESC,id`, [context.workspaceId,companyId,context.userId,includeArchived]);
    return result.rows;
  }

  async getProject(context: AuthContext, companyId: string, projectId: string) {
    await this.assertCompany(context, companyId);
    const result = await this.pool.query<Project>(`SELECT ${projectColumns} FROM projects
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4`,
      [projectId,context.workspaceId,companyId,context.userId]);
    if (!result.rows[0]) throw new WorkspaceNotFoundError("Project not found");
    return result.rows[0];
  }

  async updateProject(context: AuthContext, companyId: string, projectId: string, input: { name?: string; expectedRevision: number; code?: ProjectCodeSettings }) {
    const current = await this.getProject(context, companyId, projectId);
    const name = input.name === undefined ? current.name : input.name;
    const code = input.code ?? {};
    const result = await this.pool.query<Project>(`UPDATE projects
      SET name=$5,
          toolchain=COALESCE($7, toolchain),
          default_branch=COALESCE($8, default_branch),
          data_classification=COALESCE($9, data_classification),
          retention_class=COALESCE($10, retention_class),
          revision=revision+1, updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4
        AND revision=$6 AND status<>'archived' RETURNING ${projectColumns}`,
      [projectId, context.workspaceId, companyId, context.userId, name, input.expectedRevision,
        code.toolchain ? JSON.stringify(code.toolchain) : null, code.defaultBranch ?? null,
        code.dataClassification ?? null, code.retentionClass ?? null]);
    if (!result.rows[0]) throw new Error("Project changed by another request or is archived");
    return result.rows[0];
  }

  async setProjectSandbox(context: AuthContext, companyId: string, projectId: string, sandboxId: string | null, expectedSandboxId: string | null) {
    await this.getProject(context, companyId, projectId);
    const result = await this.pool.query<Project>(`UPDATE projects
      SET sandbox_id=$5,revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4
        AND sandbox_id IS NOT DISTINCT FROM $6 AND status<>'archived' RETURNING ${projectColumns}`,
      [projectId,context.workspaceId,companyId,context.userId,sandboxId,expectedSandboxId]);
    if (!result.rows[0]) throw new Error("Project sandbox changed by another request or is archived");
    return result.rows[0];
  }
  async updateProjectRepository(context: AuthContext, companyId: string, projectId: string, input: { provider: string; url: string; branch: string }): Promise<Project> {
    await this.getProject(context, companyId, projectId);
    const result = await this.pool.query<Project>(`UPDATE projects
      SET repository_provider=$5, repository_url=$6, repository_branch=$7, revision=revision+1, updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4 AND status<>'archived'
      RETURNING ${projectColumns}`,
      [projectId, context.workspaceId, companyId, context.userId, input.provider, input.url, input.branch]);
    if (!result.rows[0]) throw new Error("Project repository update failed or project is archived");
    return result.rows[0];
  }
  async updateProjectPreview(context: AuthContext, companyId: string, projectId: string, patch: { status?: ProjectStatus; previewUrl?: string | null; previewPort?: number | null; framework?: string | null; runtime?: string | null; lastBuildStatus?: string | null; deploymentUrl?: string | null; deploymentStatus?: string | null; lastDeploymentStatus?: string | null; lastDeployedAt?: string | null }) {
    const current = await this.getProject(context, companyId, projectId);
    const status = patch.status ?? current.status;
    const previewUrl = patch.previewUrl !== undefined ? patch.previewUrl : (current.previewUrl ?? null);
    const previewPort = patch.previewPort !== undefined ? patch.previewPort : (current.previewPort ?? null);
    const framework = patch.framework !== undefined ? patch.framework : (current.framework ?? null);
    const runtime = patch.runtime !== undefined ? patch.runtime : (current.runtime ?? null);
    const lastBuildStatus = patch.lastBuildStatus !== undefined ? patch.lastBuildStatus : (current.lastBuildStatus ?? null);
    const deploymentUrl = patch.deploymentUrl !== undefined ? patch.deploymentUrl : (current.deploymentUrl ?? null);
    const deploymentStatus = patch.deploymentStatus !== undefined ? patch.deploymentStatus : (patch.lastDeploymentStatus !== undefined ? patch.lastDeploymentStatus : (current.deploymentStatus ?? null));
    const lastDeployedAt = patch.lastDeployedAt !== undefined ? patch.lastDeployedAt : (patch.deploymentUrl ? new Date().toISOString() : (current.lastDeployedAt ?? null));
    const result = await this.pool.query<Project>(`UPDATE projects
      SET status=$5, preview_url=$6, preview_port=$7, framework=$8, runtime=$9, last_build_status=$10, deployment_url=$11, deployment_status=$12, last_deployed_at=$13, revision=revision+1, updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4 AND status<>'archived'
      RETURNING ${projectColumns}`,
      [projectId, context.workspaceId, companyId, context.userId, status, previewUrl, previewPort, framework, runtime, lastBuildStatus, deploymentUrl, deploymentStatus, lastDeployedAt]);
    if (!result.rows[0]) throw new Error("Project preview update failed or project is archived");
    return result.rows[0];
  }
  async archiveProject(context: AuthContext, companyId: string, projectId: string, expectedRevision: number) {
    await this.getProject(context, companyId, projectId);
    const result = await this.pool.query<Project>(`UPDATE projects
      SET status='archived',revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4
        AND revision=$5 AND status<>'archived' RETURNING ${projectColumns}`,
      [projectId,context.workspaceId,companyId,context.userId,expectedRevision]);
    if (!result.rows[0]) throw new Error("Project changed by another request or is archived");
    return result.rows[0];
  }

  async deleteProject(context: AuthContext, companyId: string, projectId: string) {
    await this.getProject(context, companyId, projectId);
    const result = await this.pool.query(`DELETE FROM projects
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4`,
      [projectId,context.workspaceId,companyId,context.userId]);
    return Boolean(result.rowCount);
  }

  // --- C1: code sessions -------------------------------------------------------------------

  async createCodeSession(context: AuthContext, companyId: string, projectId: string, input: CodeSessionInput): Promise<CodeSession> {
    const project = await this.getProject(context, companyId, projectId);
    await this.assertProjectAgent(context, companyId, input.agentId);
    if (input.parentSessionId) {
      const parent = await this.getCodeSession(context, companyId, input.parentSessionId);
      if (parent.projectId !== projectId) throw new WorkspaceAccessError("Parent session belongs to another project");
    }
    // A session can never be classified below its project; raising is always allowed here (C5a adds roles).
    const requested = input.dataClassification ?? project.dataClassification;
    if (!isClassificationAtLeast(requested, project.dataClassification)) {
      throw new WorkspaceAccessError("Session data classification cannot be lower than the project classification");
    }
    const session = await this.pool.query<CodeSession>(`INSERT INTO code_sessions
      (id, workspace_id, company_id, project_id, user_id, agent_id, mode, model_profile, status, parent_session_id,
       summary, data_classification, retention_class)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11,$12)
      RETURNING ${codeSessionColumns}`,
      [randomUUID(), context.workspaceId, companyId, projectId, context.userId, input.agentId ?? null,
        input.mode ?? "edit", input.modelProfile ?? null, input.parentSessionId ?? null, input.summary ?? null,
        requested, input.retentionClass ?? project.retentionClass]);
    return session.rows[0]!;
  }

  async getCodeSession(context: AuthContext, companyId: string, sessionId: string): Promise<CodeSession> {
    const result = await this.pool.query<CodeSession>(`SELECT ${codeSessionColumns} FROM code_sessions
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4`,
      [sessionId, context.workspaceId, companyId, context.userId]);
    if (!result.rows[0]) throw new WorkspaceNotFoundError("Code session not found");
    return result.rows[0];
  }

  async listCodeSessions(context: AuthContext, companyId: string, projectId?: string, options: { includeArchived?: boolean; limit?: number } = {}): Promise<CodeSession[]> {
    await this.assertCompany(context, companyId);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const result = await this.pool.query<CodeSession>(`SELECT ${codeSessionColumns} FROM code_sessions
      WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3
        AND ($4::text IS NULL OR project_id=$4)
        AND ($5::boolean OR status<>'archived')
      ORDER BY updated_at DESC, id LIMIT $6`,
      [context.workspaceId, companyId, context.userId, projectId ?? null, options.includeArchived === true, limit]);
    return result.rows;
  }

  async updateCodeSession(context: AuthContext, companyId: string, sessionId: string, patch: { status?: CodeSessionStatus; summary?: string; runId?: string | null; modelProfile?: string; dataClassification?: DataClassification; retentionClass?: RetentionClass; toolManifestVersion?: number | null; mode?: CodeSessionMode; expectedRevision?: number }): Promise<CodeSession> {
    const current = await this.getCodeSession(context, companyId, sessionId);
    if (patch.dataClassification && !isClassificationAtLeast(patch.dataClassification, current.dataClassification)) {
      throw new WorkspaceAccessError("Session data classification cannot be lowered through this endpoint");
    }
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) {
      throw new WorkspaceAccessError("Code session changed by another request. Reload and try again.");
    }
    const result = await this.pool.query<CodeSession>(`UPDATE code_sessions
      SET status=COALESCE($5,status),
          summary=COALESCE($6,summary),
          run_id=COALESCE($7,run_id),
          model_profile=COALESCE($8,model_profile),
          data_classification=COALESCE($9,data_classification),
          retention_class=COALESCE($10,retention_class),
          tool_manifest_version=COALESCE($11,tool_manifest_version),
          mode=COALESCE($12,mode),
          revision=revision+1,
          updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4
      RETURNING ${codeSessionColumns}`,
      [sessionId, context.workspaceId, companyId, context.userId, patch.status ?? null, patch.summary ?? null,
        patch.runId === undefined ? null : patch.runId, patch.modelProfile ?? null,
        patch.dataClassification ?? null, patch.retentionClass ?? null,
        patch.toolManifestVersion === undefined ? null : patch.toolManifestVersion, patch.mode ?? null]);
    if (!result.rows[0]) throw new WorkspaceNotFoundError("Code session not found");
    return result.rows[0];
  }

  // --- C5: project trust ---------------------------------------------------------------------

  async getProjectCodeTrust(context: AuthContext, companyId: string, projectId: string): Promise<ProjectCodeTrust | null> {
    const result = await this.pool.query<ProjectCodeTrust>(`SELECT ${projectCodeTrustColumns} FROM project_code_trust
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3`,
      [context.workspaceId, companyId, projectId]);
    return result.rows[0] ?? null;
  }

  /**
   * Trust is a state change and therefore revision-checked. A missing row means "revision 0, not
   * trusted", so the first write must pass `expectedRevision: 0`.
   */
  async setProjectCodeTrust(context: AuthContext, companyId: string, projectId: string, input: ProjectCodeTrustInput): Promise<ProjectCodeTrust> {
    const existing = await this.getProjectCodeTrust(context, companyId, projectId);
    const currentRevision = existing?.revision ?? 0;
    if (input.expectedRevision !== currentRevision) {
      throw new WorkspaceAccessError("Project trust changed by another request. Reload and try again.");
    }
    const result = await this.pool.query<ProjectCodeTrust>(`INSERT INTO project_code_trust
      (id, workspace_id, company_id, project_id, trusted, trusted_by, trusted_at, revoked_by, revoked_at, reason, revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)
      ON CONFLICT (company_id, project_id) DO UPDATE SET
        trusted=$5,
        trusted_by=CASE WHEN $5 THEN $6 ELSE project_code_trust.trusted_by END,
        trusted_at=CASE WHEN $5 THEN now() ELSE project_code_trust.trusted_at END,
        revoked_by=CASE WHEN $5 THEN project_code_trust.revoked_by ELSE $6 END,
        revoked_at=CASE WHEN $5 THEN project_code_trust.revoked_at ELSE now() END,
        reason=$10,
        revision=project_code_trust.revision+1,
        updated_at=now()
      RETURNING ${projectCodeTrustColumns}`,
      [randomUUID(), context.workspaceId, companyId, projectId, input.trusted, input.actor,
        input.trusted ? new Date().toISOString() : null, input.trusted ? null : input.actor,
        input.trusted ? null : new Date().toISOString(), input.reason ?? null]);
    return result.rows[0]!;
  }

  /** Rejects an agent id that does not belong to the company (tenant isolation for sessions). */
  private async assertProjectAgent(context: AuthContext, companyId: string, agentId?: string) {
    if (!agentId) return;
    const result = await this.pool.query("SELECT 1 FROM company_agents WHERE id=$1 AND workspace_id=$2 AND company_id=$3", [agentId, context.workspaceId, companyId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Agent does not belong to this company");
  }

  async createProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, input: CreateCheckpointInput): Promise<ProjectCheckpoint> {
    await this.getProject(context, companyId, projectId);
    const id = `chk_${randomUUID()}`;
    const result = await this.pool.query<ProjectCheckpoint>(`INSERT INTO project_checkpoints
      (id, workspace_id, company_id, project_id, user_id, name, description, commit_hash, trigger, run_id, file_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING ${projectCheckpointColumns}`,
      [id, context.workspaceId, companyId, projectId, context.userId, input.name.trim(), input.description ?? null, input.commitHash ?? null, input.trigger, input.runId ?? null, input.fileCount ?? 0]);
    return result.rows[0]!;
  }

  async listProjectCheckpoints(context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectCheckpoint[]> {
    await this.getProject(context, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const result = await this.pool.query<ProjectCheckpoint>(`SELECT ${projectCheckpointColumns} FROM project_checkpoints
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3
      ORDER BY created_at DESC, id DESC LIMIT $4`,
      [context.workspaceId, companyId, projectId, safeLimit]);
    return result.rows;
  }

  async getProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<ProjectCheckpoint> {
    await this.getProject(context, companyId, projectId);
    const result = await this.pool.query<ProjectCheckpoint>(`SELECT ${projectCheckpointColumns} FROM project_checkpoints
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4`,
      [checkpointId, context.workspaceId, companyId, projectId]);
    if (!result.rowCount) throw new WorkspaceNotFoundError("Project checkpoint not found");
    return result.rows[0]!;
  }

  async deleteProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<boolean> {
    await this.getProject(context, companyId, projectId);
    const result = await this.pool.query(`DELETE FROM project_checkpoints
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4`,
      [checkpointId, context.workspaceId, companyId, projectId]);
    return Boolean(result.rowCount);
  }

  async createProjectDeployment(context: AuthContext, companyId: string, projectId: string, input: CreateDeploymentInput): Promise<ProjectDeployment> {
    await this.getProject(context, companyId, projectId);
    const id = `dep_${randomUUID()}`;
    const result = await this.pool.query<ProjectDeployment>(`INSERT INTO project_deployments
      (id, workspace_id, company_id, project_id, user_id, provider, environment, branch, commit_hash, status, target_url, external_deployment_id, preflight_summary, error_message, run_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING ${projectDeploymentColumns}`,
      [id, context.workspaceId, companyId, projectId, context.userId, input.provider, input.environment ?? "production", input.branch ?? "project/main", input.commitHash ?? null, input.status ?? "queued", input.targetUrl ?? null, input.externalDeploymentId ?? null, input.preflightSummary ? JSON.stringify(input.preflightSummary) : null, input.errorMessage ?? null, input.runId ?? null]);
    return result.rows[0]!;
  }

  async listProjectDeployments(context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectDeployment[]> {
    await this.getProject(context, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const result = await this.pool.query<ProjectDeployment>(`SELECT ${projectDeploymentColumns} FROM project_deployments
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3
      ORDER BY created_at DESC, id DESC LIMIT $4`,
      [context.workspaceId, companyId, projectId, safeLimit]);
    return result.rows;
  }

  async getProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string): Promise<ProjectDeployment | null> {
    await this.getProject(context, companyId, projectId);
    const result = await this.pool.query<ProjectDeployment>(`SELECT ${projectDeploymentColumns} FROM project_deployments
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4`,
      [deploymentId, context.workspaceId, companyId, projectId]);
    if (!result.rowCount) return null;
    return result.rows[0]!;
  }

  async updateProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string, patch: Partial<ProjectDeployment>): Promise<ProjectDeployment> {
    await this.getProject(context, companyId, projectId);
    const current = await this.getProjectDeployment(context, companyId, projectId, deploymentId);
    if (!current) throw new WorkspaceNotFoundError("Project deployment not found");
    const status = patch.status ?? current.status;
    const targetUrl = patch.targetUrl !== undefined ? patch.targetUrl : (current.targetUrl ?? null);
    const externalDeploymentId = patch.externalDeploymentId !== undefined ? patch.externalDeploymentId : (current.externalDeploymentId ?? null);
    const preflightSummary = patch.preflightSummary !== undefined ? JSON.stringify(patch.preflightSummary) : (current.preflightSummary ? JSON.stringify(current.preflightSummary) : null);
    const errorMessage = patch.errorMessage !== undefined ? patch.errorMessage : (current.errorMessage ?? null);
    const result = await this.pool.query<ProjectDeployment>(`UPDATE project_deployments
      SET status=$5, target_url=$6, external_deployment_id=$7, preflight_summary=$8, error_message=$9, updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4
      RETURNING ${projectDeploymentColumns}`,
      [deploymentId, context.workspaceId, companyId, projectId, status, targetUrl, externalDeploymentId, preflightSummary, errorMessage]);
    if (!result.rows[0]) throw new WorkspaceNotFoundError("Project deployment not found");
    return result.rows[0];
  }

  async createProjectQaReport(context: AuthContext, companyId: string, projectId: string, input: CreateProjectQaReportInput): Promise<ProjectQaReport> {
    await this.getProject(context, companyId, projectId);
    const id = `qa_${randomUUID()}`;
    const result = await this.pool.query<ProjectQaReport>(`INSERT INTO project_qa_reports
      (id, workspace_id, company_id, project_id, user_id, status, target_url, summary, issues, metrics, screenshots, run_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING ${projectQaReportColumns}`,
      [id, context.workspaceId, companyId, projectId, context.userId, input.status, input.targetUrl, input.summary, JSON.stringify(input.issues ?? []), JSON.stringify(input.metrics ?? {}), JSON.stringify(input.screenshots ?? []), input.runId ?? null]);
    return result.rows[0]!;
  }

  async listProjectQaReports(context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectQaReport[]> {
    await this.getProject(context, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const result = await this.pool.query<ProjectQaReport>(`SELECT ${projectQaReportColumns} FROM project_qa_reports
      WHERE workspace_id=$1 AND company_id=$2 AND project_id=$3
      ORDER BY created_at DESC, id DESC LIMIT $4`,
      [context.workspaceId, companyId, projectId, safeLimit]);
    return result.rows;
  }

  async getProjectQaReport(context: AuthContext, companyId: string, projectId: string, reportId: string): Promise<ProjectQaReport | null> {
    await this.getProject(context, companyId, projectId);
    const result = await this.pool.query<ProjectQaReport>(`SELECT ${projectQaReportColumns} FROM project_qa_reports
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND project_id=$4`,
      [reportId, context.workspaceId, companyId, projectId]);
    if (!result.rowCount) return null;
    return result.rows[0]!;
  }

  async getLatestProjectQaReport(context: AuthContext, companyId: string, projectId: string): Promise<ProjectQaReport | null> {
    const list = await this.listProjectQaReports(context, companyId, projectId, 1);
    return list[0] ?? null;
  }

  async getCompanyAgent(context: AuthContext, companyId: string, agentId: string) {
    await this.assertCompany(context, companyId);
    const result = await this.pool.query<CompanyAgent>(`SELECT ${companyAgentColumns} FROM company_agents
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3`, [agentId, context.workspaceId, companyId]);
    if (!result.rowCount) throw new WorkspaceNotFoundError("Agent was not found in this company");
    return result.rows[0]!;
  }

  async createCompanyAgent(context: AuthContext, companyId: string, input: CompanyAgentInput, idempotencyKey: string) {
    await this.assertCompany(context, companyId);
    const name = input.name?.trim(), role = input.role?.trim();
    if (!name || !role) throw new Error("Agent name and role are required");
    const values = [randomUUID(), context.workspaceId, companyId, name, role, input.description ?? null,
      input.systemInstruction ?? null, input.promptGuidelines ?? null, JSON.stringify(input.recommendedPrompts ?? []),
      input.modelId ?? null, input.fallbackModelId ?? null, JSON.stringify(input.tools ?? []), input.isActive ?? true,
      input.positionX ?? null, input.positionY ?? null, input.sortOrder ?? 0, idempotencyKey];
    const result = await this.pool.query<CompanyAgent>(`INSERT INTO company_agents(
      id,workspace_id,company_id,name,role,description,system_instruction,prompt_guidelines,recommended_prompts,
      model_id,fallback_model_id,tools_json,is_active,position_x,position_y,sort_order,create_request_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13,$14,$15,$16,$17)
      ON CONFLICT (workspace_id,company_id,create_request_key) WHERE create_request_key IS NOT NULL DO NOTHING
      RETURNING ${companyAgentColumns}`, values);
    const agent = result.rows[0] ?? (await this.pool.query<CompanyAgent>(`SELECT ${companyAgentColumns} FROM company_agents
      WHERE workspace_id=$1 AND company_id=$2 AND create_request_key=$3`, [context.workspaceId, companyId, idempotencyKey])).rows[0];
    if (!agent) throw new Error("Could not create company agent");
    return agent;
  }


  async updateCompanyAgent(context: AuthContext, companyId: string, agentId: string, input: Partial<CompanyAgentInput>, expectedRevision: number) {
    await this.getCompanyAgent(context, companyId, agentId);
    if (input.name !== undefined && !input.name.trim()) throw new Error("Agent name is required");
    if (input.role !== undefined && !input.role.trim()) throw new Error("Agent role is required");
    const patch = JSON.stringify(input);
    const result = await this.pool.query<CompanyAgent>(`UPDATE company_agents SET
      name=CASE WHEN $4::jsonb ? 'name' THEN trim($4::jsonb->>'name') ELSE name END,
      role=CASE WHEN $4::jsonb ? 'role' THEN trim($4::jsonb->>'role') ELSE role END,
      description=CASE WHEN $4::jsonb ? 'description' THEN NULLIF($4::jsonb->>'description','') ELSE description END,
      system_instruction=CASE WHEN $4::jsonb ? 'systemInstruction' THEN NULLIF($4::jsonb->>'systemInstruction','') ELSE system_instruction END,
      prompt_guidelines=CASE WHEN $4::jsonb ? 'promptGuidelines' THEN NULLIF($4::jsonb->>'promptGuidelines','') ELSE prompt_guidelines END,
      recommended_prompts=CASE WHEN $4::jsonb ? 'recommendedPrompts' THEN $4::jsonb->'recommendedPrompts' ELSE recommended_prompts END,
      model_id=CASE WHEN $4::jsonb ? 'modelId' THEN NULLIF($4::jsonb->>'modelId','') ELSE model_id END,
      fallback_model_id=CASE WHEN $4::jsonb ? 'fallbackModelId' THEN NULLIF($4::jsonb->>'fallbackModelId','') ELSE fallback_model_id END,
      tools_json=CASE WHEN $4::jsonb ? 'tools' THEN $4::jsonb->'tools' ELSE tools_json END,
      is_active=CASE WHEN $4::jsonb ? 'isActive' THEN ($4::jsonb->>'isActive')::boolean ELSE is_active END,
      position_x=CASE WHEN $4::jsonb ? 'positionX' THEN ($4::jsonb->>'positionX')::double precision ELSE position_x END,
      position_y=CASE WHEN $4::jsonb ? 'positionY' THEN ($4::jsonb->>'positionY')::double precision ELSE position_y END,
      sort_order=CASE WHEN $4::jsonb ? 'sortOrder' THEN ($4::jsonb->>'sortOrder')::integer ELSE sort_order END,
      revision=revision+1,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND revision=$5 RETURNING ${companyAgentColumns}`,
      [agentId, context.workspaceId, companyId, patch, expectedRevision]);
    if (!result.rowCount) throw new Error("Agent was changed by another request. Reload and try again.");
    return result.rows[0]!;
  }

  async deleteCompanyAgent(context: AuthContext, companyId: string, agentId: string, expectedRevision: number) {
    await this.assertCompany(context, companyId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [companyId]);
      const current = await client.query<{ revision: number }>(`SELECT revision FROM company_agents
        WHERE id=$1 AND workspace_id=$2 AND company_id=$3 FOR UPDATE`, [agentId, context.workspaceId, companyId]);
      if (!current.rowCount) { await client.query("COMMIT"); return false; }
      if (current.rows[0]!.revision !== expectedRevision) throw new Error("Agent was changed by another request. Reload and try again.");
      await client.query(`DELETE FROM company_agent_edges
        WHERE workspace_id=$1 AND company_id=$2 AND (parent_agent_id=$3 OR child_agent_id=$3)`, [context.workspaceId, companyId, agentId]);
      await client.query(`UPDATE companies SET main_agent_id=NULL,revision=revision+1,updated_at=now()
        WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND main_agent_id=$4`, [companyId, context.workspaceId, context.userId, agentId]);
      await client.query("DELETE FROM company_agents WHERE id=$1 AND workspace_id=$2 AND company_id=$3", [agentId, context.workspaceId, companyId]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async listCompanyAgentEdges(context: AuthContext, companyId: string, agentIds?: string[]) {
    await this.assertCompany(context, companyId);
    const filter = agentIds?.length ? [...new Set(agentIds)] : null;
    return (await this.pool.query<CompanyAgentEdge>(`SELECT ${companyEdgeColumns} FROM company_agent_edges
      WHERE workspace_id=$1 AND company_id=$2
        AND ($3::text[] IS NULL OR parent_agent_id=ANY($3::text[]) OR child_agent_id=ANY($3::text[]))
      ORDER BY created_at,id`, [context.workspaceId, companyId, filter])).rows;
  }


  async setCompanyAgentParent(context: AuthContext, companyId: string, childAgentId: string, parentAgentId: string | null) {
    await this.assertCompany(context, companyId);
    await this.getCompanyAgent(context, companyId, childAgentId);
    if (parentAgentId === childAgentId) throw new Error("An agent cannot be its own parent");
    if (parentAgentId) await this.getCompanyAgent(context, companyId, parentAgentId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [companyId]);
      await client.query("DELETE FROM company_agent_edges WHERE workspace_id=$1 AND company_id=$2 AND child_agent_id=$3",
        [context.workspaceId, companyId, childAgentId]);
      if (!parentAgentId) { await client.query("COMMIT"); return null; }
      const cycle = await client.query(`WITH RECURSIVE descendants(id) AS (
        SELECT child_agent_id FROM company_agent_edges WHERE workspace_id=$1 AND company_id=$2 AND parent_agent_id=$3
        UNION
        SELECT edge.child_agent_id FROM company_agent_edges edge JOIN descendants d ON edge.parent_agent_id=d.id
        WHERE edge.workspace_id=$1 AND edge.company_id=$2
      ) SELECT 1 FROM descendants WHERE id=$4 LIMIT 1`, [context.workspaceId, companyId, childAgentId, parentAgentId]);
      if (cycle.rowCount) throw new Error("Circular agent relationships are not allowed");
      const result = await client.query<CompanyAgentEdge>(`INSERT INTO company_agent_edges(
        id,workspace_id,company_id,parent_agent_id,child_agent_id,relation_type)
        VALUES ($1,$2,$3,$4,$5,'reports_to') RETURNING ${companyEdgeColumns}`,
        [randomUUID(), context.workspaceId, companyId, parentAgentId, childAgentId]);
      await client.query("COMMIT");
      return result.rows[0]!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async createCompanyAgentRun(context: AuthContext, companyId: string, input: { task: string; requestedMode: "auto" | "single" | "pipeline" | "fusion"; projectId?: string }, idempotencyKey: string) {
    const company = await this.assertCompany(context, companyId);
    if (!company.mainAgentId) throw new Error("Select an active Main Agent before running the company");
    const mainAgent = await this.getCompanyAgent(context, companyId, company.mainAgentId);
    if (!mainAgent.isActive) throw new Error("The Main Agent is inactive");
    const task = input.task?.trim();
    if (!task) throw new Error("Company task is required");
    const timestamp = new Date().toISOString();
    const snapshot = {
      contextType: "company",
      workspaceId: context.workspaceId,
      userId: context.userId,
      companyId,
      businessId: null,
      agentId: mainAgent.id,
      companyRevision: company.revision,
      capturedAt: timestamp,
    };
    const result = await this.pool.query<CompanyAgentRun>(`INSERT INTO company_agent_runs(
      id,workspace_id,company_id,project_id,user_id,main_agent_id,idempotency_key,task,requested_mode,context_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (workspace_id,company_id,user_id,idempotency_key) DO NOTHING
      RETURNING ${companyRunColumns}`,
      [randomUUID(), context.workspaceId, companyId, input.projectId ?? null, context.userId, mainAgent.id, idempotencyKey, task, input.requestedMode, JSON.stringify(snapshot)]);
    if (result.rows[0]) return { run: result.rows[0], created: true };
    const existing = await this.pool.query<CompanyAgentRun>(`SELECT ${companyRunColumns} FROM company_agent_runs
      WHERE workspace_id=$1 AND company_id=$2 AND user_id=$3 AND idempotency_key=$4`,
      [context.workspaceId, companyId, context.userId, idempotencyKey]);
    if (!existing.rows[0]) throw new Error("Could not create company agent run");
    return { run: existing.rows[0], created: false };
  }

  async listCompanyAgentRuns(context: AuthContext, companyId: string, limit = 50, filter?: { projectId?: string }) {
    await this.assertCompany(context, companyId);
    const result = await this.pool.query<CompanyAgentRun>(
      `SELECT ${companyRunColumns} FROM company_agent_runs
       WHERE workspace_id=$1 AND company_id=$2 AND ($4::text IS NULL OR project_id=$4)
       ORDER BY created_at DESC LIMIT $3`,
      [context.workspaceId, companyId, Math.max(1, Math.min(100, limit)), filter?.projectId ?? null]
    );
    return result.rows;
  }

  async listProjectRuns(context: AuthContext, companyId: string, projectId: string, limit = 50) {
    return this.listCompanyAgentRuns(context, companyId, limit, { projectId });
  }

  async getCompanyAgentRun(context: AuthContext, companyId: string, runId: string) {
    await this.assertCompany(context, companyId);
    const result = await this.pool.query<CompanyAgentRun>(`SELECT ${companyRunColumns} FROM company_agent_runs
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4`, [runId, context.workspaceId, companyId, context.userId]);
    if (!result.rows[0]) throw new WorkspaceAccessError("Agent run is not available in this company");
    const [steps, toolAudit, backgroundEvents] = await Promise.all([
      this.pool.query<CompanyAgentRunStep>(`SELECT ${companyRunStepColumns} FROM company_agent_run_steps
        WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3 ORDER BY step_order,lane,id`, [context.workspaceId, companyId, runId]),
      this.pool.query<CompanyAgentToolAudit>(`SELECT ${companyToolAuditColumns} FROM company_agent_tool_audit
        WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3 ORDER BY created_at,id`, [context.workspaceId, companyId, runId]),
      this.pool.query<CompanyAgentRunEvent>(`SELECT ${companyRunEventColumns} FROM company_agent_run_events
        WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3 ORDER BY created_at,id`, [context.workspaceId, companyId, runId]),
    ]);
    const run = result.rows[0];
    const completionStatus = run.status === "completed" || run.status === "failed" || run.status === "cancelled" ? run.status : undefined;
    return { run, steps: steps.rows, toolAudit: toolAudit.rows, backgroundEvents: backgroundEvents.rows,
      completionReport: completionStatus && run.completedAt ? { runId: run.id, companyId: run.companyId, status: completionStatus,
        result: run.result, errorCode: run.errorCode, errorMessage: run.errorMessage, workerId: run.workerId,
        attemptCount: run.attemptCount, totalCost: run.totalCost ?? 0, totalTokens: run.totalTokens ?? 0,
        totalDurationMs: run.totalDurationMs ?? 0, completedAt: run.completedAt } : undefined };
  }

  async getCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string): Promise<unknown | null> {
    await this.getCompanyAgentRun(context, companyId, runId);
    const result = await this.pool.query<{ pending_plan: unknown }>("SELECT pending_plan FROM company_agent_runs WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4", [runId, context.workspaceId, companyId, context.userId]);
    return result.rows[0]?.pending_plan ?? null;
  }
  async setCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string, plan: unknown | null): Promise<void> {
    await this.getCompanyAgentRun(context, companyId, runId);
    await this.pool.query("UPDATE company_agent_runs SET pending_plan=$5::jsonb,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4", [runId, context.workspaceId, companyId, context.userId, plan === null ? null : JSON.stringify(plan)]);
  }
  async updateCompanyAgentRun(context: AuthContext, companyId: string, runId: string, patch: Partial<CompanyAgentRun>) {
    await this.getCompanyAgentRun(context, companyId, runId);
    const value = JSON.stringify(patch);
    const result = await this.pool.query<CompanyAgentRun>(`UPDATE company_agent_runs SET
      status=CASE WHEN $5::jsonb ? 'status' THEN $5::jsonb->>'status' ELSE status END,
      execution_mode=CASE WHEN $5::jsonb ? 'executionMode' THEN NULLIF($5::jsonb->>'executionMode','') ELSE execution_mode END,
      selected_agent_ids=CASE WHEN $5::jsonb ? 'selectedAgentIds' THEN $5::jsonb->'selectedAgentIds' ELSE selected_agent_ids END,
      omniroute_task_id=CASE WHEN $5::jsonb ? 'omnirouteTaskId' THEN NULLIF($5::jsonb->>'omnirouteTaskId','') ELSE omniroute_task_id END,
      omniroute_combo_name=CASE WHEN $5::jsonb ? 'omnirouteComboName' THEN NULLIF($5::jsonb->>'omnirouteComboName','') ELSE omniroute_combo_name END,
      result=CASE WHEN $5::jsonb ? 'result' THEN $5::jsonb->>'result' ELSE result END,
      error_code=CASE WHEN $5::jsonb ? 'errorCode' THEN NULLIF($5::jsonb->>'errorCode','') ELSE error_code END,
      error_message=CASE WHEN $5::jsonb ? 'errorMessage' THEN NULLIF($5::jsonb->>'errorMessage','') ELSE error_message END,
      cancel_requested=CASE WHEN $5::jsonb ? 'cancelRequested' THEN ($5::jsonb->>'cancelRequested')::boolean ELSE cancel_requested END,
      total_cost=CASE WHEN $5::jsonb ? 'totalCost' THEN ($5::jsonb->>'totalCost')::numeric ELSE total_cost END,
      total_tokens=CASE WHEN $5::jsonb ? 'totalTokens' THEN ($5::jsonb->>'totalTokens')::bigint ELSE total_tokens END,
      total_duration_ms=CASE WHEN $5::jsonb ? 'totalDurationMs' THEN ($5::jsonb->>'totalDurationMs')::int ELSE total_duration_ms END,
      started_at=CASE WHEN ($5::jsonb->>'status') IN ('planning','running') THEN COALESCE(started_at,now()) ELSE started_at END,
      completed_at=CASE WHEN ($5::jsonb->>'status') IN ('completed','failed','cancelled') THEN now() WHEN ($5::jsonb->>'status') IN ('planning','running','awaiting_approval') THEN NULL ELSE completed_at END,
      updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4
      RETURNING ${companyRunColumns}`, [runId, context.workspaceId, companyId, context.userId, value]);
    if (!result.rows[0]) throw new WorkspaceAccessError("Agent run is not available in this company");
    return result.rows[0];
  }

  async replaceCompanyAgentRunSteps(context: AuthContext, companyId: string, runId: string, steps: Array<Pick<CompanyAgentRunStep, "agentId" | "stepOrder" | "lane" | "role" | "status" | "modelId">>) {
    await this.getCompanyAgentRun(context, companyId, runId);
    const uniqueAgentIds = [...new Set(steps.map((step) => step.agentId))];
    if (uniqueAgentIds.length !== steps.length) throw new Error("A run cannot contain the same agent twice");
    for (const agentId of uniqueAgentIds) await this.getCompanyAgent(context, companyId, agentId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [runId]);
      await client.query("DELETE FROM company_agent_run_steps WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3",
        [context.workspaceId, companyId, runId]);
      const rows: CompanyAgentRunStep[] = [];
      for (const step of steps) {
        const result = await client.query<CompanyAgentRunStep>(`INSERT INTO company_agent_run_steps(
          id,workspace_id,company_id,run_id,agent_id,step_order,lane,role,status,model_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${companyRunStepColumns}`,
          [randomUUID(), context.workspaceId, companyId, runId, step.agentId, step.stepOrder, step.lane, step.role, step.status, step.modelId]);
        rows.push(result.rows[0]!);
      }
      await client.query("COMMIT");
      return rows;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async appendCompanyAgentToolAudit(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentToolAudit, "agentId" | "toolName" | "decision" | "status" | "inputSummary" | "errorMessage"> & Partial<Pick<CompanyAgentToolAudit, "latencyMs" | "cost" | "tokens" | "reasonCode" | "sequenceNumber">>) {
    await this.getCompanyAgentRun(context, companyId, runId);
    await this.getCompanyAgent(context, companyId, entry.agentId);
    const result = await this.pool.query<CompanyAgentToolAudit>(`INSERT INTO company_agent_tool_audit(
      id,workspace_id,company_id,run_id,agent_id,tool_name,decision,status,input_summary,error_message,
      latency_ms,cost,tokens,reason_code,sequence_number,completed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,CASE WHEN $8 IN ('succeeded','failed','blocked') THEN now() END)
      RETURNING ${companyToolAuditColumns}`,
      [randomUUID(), context.workspaceId, companyId, runId, entry.agentId, entry.toolName, entry.decision,
        entry.status, JSON.stringify(entry.inputSummary ?? {}), entry.errorMessage ?? null, entry.latencyMs ?? null,
        entry.cost ?? null, entry.tokens ?? null, entry.reasonCode ?? null, entry.sequenceNumber ?? null]);
    return result.rows[0]!;
  }

  async appendCompanyAgentRunEvent(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentRunEvent, "eventKey" | "eventType" | "runStatus" | "message"> & Partial<Pick<CompanyAgentRunEvent, "workerId" | "attemptCount" | "details">>) {
    const { run } = await this.getCompanyAgentRun(context, companyId, runId);
    const values = [randomUUID(), context.workspaceId, companyId, runId, entry.eventKey, entry.eventType, entry.runStatus,
      entry.workerId ?? null, entry.attemptCount ?? run.attemptCount, entry.message.slice(0, 1000), JSON.stringify(entry.details ?? {})];
    const inserted = await this.pool.query<CompanyAgentRunEvent>(`INSERT INTO company_agent_run_events(
      id,workspace_id,company_id,run_id,event_key,event_type,run_status,worker_id,attempt_count,message,details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      ON CONFLICT (run_id,event_key) DO NOTHING RETURNING ${companyRunEventColumns}`, values);
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await this.pool.query<CompanyAgentRunEvent>(`SELECT ${companyRunEventColumns} FROM company_agent_run_events
      WHERE workspace_id=$1 AND company_id=$2 AND run_id=$3 AND event_key=$4`, [context.workspaceId, companyId, runId, entry.eventKey]);
    if (!existing.rows[0]) throw new Error("Could not append Company background run event");
    return existing.rows[0];
  }


  async claimCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) {
    await this.assertCompany(context, companyId);
    const result = await this.pool.query(`UPDATE company_agent_runs SET worker_id=$5,
      lease_expires_at=now()+($6::text||' milliseconds')::interval,last_heartbeat_at=now(),attempt_count=attempt_count+1,
      status='planning',error_code=NULL,error_message=NULL,completed_at=NULL,started_at=COALESCE(started_at,now()),updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND cancel_requested=false
        AND attempt_count < max_attempts AND next_attempt_at <= now()
        AND (status='queued' OR (status IN ('planning','running') AND lease_expires_at < now()))`,
      [runId, context.workspaceId, companyId, context.userId, workerId, leaseMs]);
    return Boolean(result.rowCount);
  }

  async heartbeatCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) {
    const result = await this.pool.query(`UPDATE company_agent_runs SET
      lease_expires_at=now()+($6::text||' milliseconds')::interval,last_heartbeat_at=now(),updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND worker_id=$5
        AND status IN ('planning','running') AND cancel_requested=false`,
      [runId, context.workspaceId, companyId, context.userId, workerId, leaseMs]);
    return Boolean(result.rowCount);
  }

  async requeueCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, delayMs: number) {
    const result = await this.pool.query(`UPDATE company_agent_runs SET status='queued',worker_id=NULL,lease_expires_at=NULL,
      next_attempt_at=now()+($6::text||' milliseconds')::interval,updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND user_id=$4 AND worker_id=$5
        AND cancel_requested=false AND attempt_count < max_attempts`,
      [runId, context.workspaceId, companyId, context.userId, workerId, delayMs]);
    return Boolean(result.rowCount);
  }

  async listRecoverableCompanyAgentRuns(limit = 200) {
    const safeLimit = Math.max(1, Math.min(1000, limit));
    const result = await this.pool.query<{ workspaceId: string; userId: string; companyId: string; runId: string }>(`SELECT
      workspace_id AS "workspaceId",user_id AS "userId",company_id AS "companyId",id AS "runId"
      FROM company_agent_runs WHERE cancel_requested=false AND attempt_count < max_attempts AND next_attempt_at <= now()
        AND (status='queued' OR (status IN ('planning','running') AND lease_expires_at < now()))
      ORDER BY created_at LIMIT $1`, [safeLimit]);
    return result.rows.map((row) => ({ context: { workspaceId: row.workspaceId, userId: row.userId,
      permissions: ['workspace:read','business:manage'] }, companyId: row.companyId, runId: row.runId }));
  }

  async listGoals(context: AuthContext, businessId: string) {
    await this.getBusiness(context, businessId);
    return (await this.pool.query<Goal>(`SELECT ${goalColumns} FROM goals WHERE workspace_id=$1 AND business_id=$2 ORDER BY priority, updated_at DESC`, [context.workspaceId, businessId])).rows;
  }

  async listUserGoals(context: AuthContext) {
    await this.assertMember(context);
    return (await this.pool.query<Goal>(
      `SELECT ${goalColumns} FROM goals
       WHERE workspace_id=$1 AND (created_by_user_id=$2 OR business_id IN (
         SELECT id FROM businesses WHERE workspace_id=$1 AND owner_user_id=$2
       ))
       ORDER BY priority, updated_at DESC`,
      [context.workspaceId, context.userId]
    )).rows;
  }

  async createGoal(context: AuthContext, businessId: string, input: GoalInput) {
    await this.getBusiness(context, businessId);
    const values = [randomUUID(), context.workspaceId, businessId, context.userId, input.title.trim(), input.description ?? null, input.status ?? "active", input.targetValue ?? null, input.targetUnit ?? null, input.currentValue ?? null, input.targetDate ?? null, input.priority ?? 3];
    const result = await this.pool.query<Goal>(`INSERT INTO goals(id,workspace_id,business_id,created_by_user_id,title,description,status,target_value,target_unit,current_value,target_date,priority)
      VALUES (${values.map((_, index) => `$${index + 1}`).join(",")}) RETURNING ${goalColumns}`, values);
    return result.rows[0]!;
  }

  async linkGoal(context: AuthContext, businessId: string, goalId: string) {
    await this.getBusiness(context, businessId);
    const result = await this.pool.query<Goal>(
      `UPDATE goals SET business_id=$1, updated_at=now()
       WHERE id=$2 AND workspace_id=$3 AND (created_by_user_id=$4 OR business_id IN (
         SELECT id FROM businesses WHERE workspace_id=$3 AND owner_user_id=$4
       ))
       RETURNING ${goalColumns}`,
      [businessId, goalId, context.workspaceId, context.userId]
    );
    if (!result.rowCount) throw new WorkspaceAccessError("Goal not found or not owned by user");
    return result.rows[0]!;
  }

  async updateGoal(context: AuthContext, businessId: string, goalId: string, input: Partial<GoalInput>) {
    await this.getBusiness(context, businessId);
    const values = [goalId, context.workspaceId, businessId, input.title, input.description, input.status, input.targetValue, input.targetUnit, input.currentValue, input.targetDate, input.priority];
    const result = await this.pool.query<Goal>(`UPDATE goals SET title=COALESCE($4,title),description=COALESCE($5,description),status=COALESCE($6,status),target_value=COALESCE($7,target_value),target_unit=COALESCE($8,target_unit),current_value=COALESCE($9,current_value),target_date=COALESCE($10,target_date),priority=COALESCE($11,priority),updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING ${goalColumns}`, values.map((value) => value === undefined ? null : value));
    if (!result.rowCount) throw new WorkspaceAccessError("Goal is not available for this business");
    return result.rows[0]!;
  }

  async deleteGoal(context: AuthContext, businessId: string, goalId: string) {
    await this.getBusiness(context, businessId);
    return Boolean((await this.pool.query("DELETE FROM goals WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING id", [goalId, context.workspaceId, businessId])).rowCount);
  }

  async listMemory(context: AuthContext, businessId: string, query = "", limit = 100) {
    await this.getBusiness(context, businessId);
    const needle = `%${query.trim()}%`;
    return (await this.pool.query<MemoryItem>(`SELECT ${memoryColumns} FROM memory_items WHERE workspace_id=$1 AND business_id=$2 AND ($3='' OR type ILIKE $4 OR title ILIKE $4 OR content ILIKE $4) ORDER BY updated_at DESC LIMIT $5`, [context.workspaceId, businessId, query.trim(), needle, Math.min(limit, 100)])).rows;
  }

  async listUserMemories(context: AuthContext, query = "", limit = 100) {
    await this.assertMember(context);
    const needle = `%${query.trim()}%`;
    return (await this.pool.query<MemoryItem>(
      `SELECT ${memoryColumns} FROM memory_items
       WHERE workspace_id=$1 AND (user_id=$2 OR business_id IN (
         SELECT id FROM businesses WHERE workspace_id=$1 AND owner_user_id=$2
       )) AND ($3='' OR type ILIKE $4 OR title ILIKE $4 OR content ILIKE $4)
       ORDER BY updated_at DESC LIMIT $5`,
      [context.workspaceId, context.userId, query.trim(), needle, Math.min(limit, 100)]
    )).rows;
  }

  async createMemory(context: AuthContext, businessId: string, input: MemoryInput) {
    await this.getBusiness(context, businessId); assertNoSecrets(input);
    const values = [randomUUID(), context.workspaceId, businessId, context.userId, input.type, input.title.trim(), input.content.trim(), input.source ?? "user", input.confidence ?? null];
    const result = await this.pool.query<MemoryItem>(`INSERT INTO memory_items(id,workspace_id,business_id,user_id,type,title,content,source,confidence) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")}) RETURNING ${memoryColumns}`, values);
    return result.rows[0]!;
  }

  async linkMemory(context: AuthContext, businessId: string, memoryId: string) {
    await this.getBusiness(context, businessId);
    const result = await this.pool.query<MemoryItem>(
      `UPDATE memory_items SET business_id=$1, updated_at=now()
       WHERE id=$2 AND workspace_id=$3 AND (user_id=$4 OR business_id IN (
         SELECT id FROM businesses WHERE workspace_id=$3 AND owner_user_id=$4
       ))
       RETURNING ${memoryColumns}`,
      [businessId, memoryId, context.workspaceId, context.userId]
    );
    if (!result.rowCount) throw new WorkspaceAccessError("Memory item not found or not owned by user");
    return result.rows[0]!;
  }

  async updateMemory(context: AuthContext, businessId: string, memoryId: string, input: Partial<MemoryInput>) {
    await this.getBusiness(context, businessId); assertNoSecrets(input);
    const values = [memoryId, context.workspaceId, businessId, input.type, input.title, input.content, input.source, input.confidence];
    const result = await this.pool.query<MemoryItem>(`UPDATE memory_items SET type=COALESCE($4,type),title=COALESCE($5,title),content=COALESCE($6,content),source=COALESCE($7,source),confidence=COALESCE($8,confidence),updated_at=now() WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING ${memoryColumns}`, values.map((value) => value === undefined ? null : value));
    if (!result.rowCount) throw new WorkspaceAccessError("Memory is not available for this business");
    return result.rows[0]!;
  }

  async deleteMemory(context: AuthContext, businessId: string, memoryId: string) {
    await this.getBusiness(context, businessId);
    return Boolean((await this.pool.query("DELETE FROM memory_items WHERE id=$1 AND workspace_id=$2 AND business_id=$3 RETURNING id", [memoryId, context.workspaceId, businessId])).rowCount);
  }

  async listConversations(context: AuthContext, businessId: string) {
    await this.getBusiness(context, businessId);
    return (await this.pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE workspace_id=$1 AND business_id=$2 AND user_id=$3 ORDER BY updated_at DESC`, [context.workspaceId, businessId, context.userId])).rows;
  }

  async createConversation(context: AuthContext, businessId: string, title: string) {
    await this.getBusiness(context, businessId);
    const result = await this.pool.query<Conversation>(`INSERT INTO conversations(id,workspace_id,business_id,user_id,title) VALUES ($1,$2,$3,$4,$5) RETURNING ${conversationColumns}`, [randomUUID(), context.workspaceId, businessId, context.userId, title.trim().slice(0, 120) || "New conversation"]);
    return result.rows[0]!;
  }

  async getConversation(context: AuthContext, businessId: string, conversationId: string) {
    await this.getBusiness(context, businessId);
    const result = await this.pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE id=$1 AND workspace_id=$2 AND business_id=$3 AND user_id=$4`, [conversationId, context.workspaceId, businessId, context.userId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Conversation is not available for this business");
    const messages = (await this.pool.query<ConversationMessage>(`SELECT id, conversation_id AS "conversationId", role, content, created_at AS "createdAt" FROM messages WHERE conversation_id=$1 ORDER BY created_at`, [conversationId])).rows;
    return { conversation: result.rows[0]!, messages };
  }

  async updateConversation(context: AuthContext, businessId: string, conversationId: string, title: string) {
    await this.getConversation(context, businessId, conversationId);
    const result = await this.pool.query<Conversation>(
      `UPDATE conversations SET title=$1,updated_at=now() WHERE id=$2 RETURNING ${conversationColumns}`,
      [title.trim().slice(0, 120) || "New conversation", conversationId],
    );
    return result.rows[0]!;
  }

  async deleteConversation(context: AuthContext, businessId: string, conversationId: string) {
    await this.getConversation(context, businessId, conversationId);
    return Boolean((await this.pool.query("DELETE FROM conversations WHERE id=$1", [conversationId])).rowCount);
  }

  async appendMessage(context: AuthContext, businessId: string, conversationId: string, role: ConversationMessage["role"], content: string) {
    await this.getConversation(context, businessId, conversationId);
    const result = await this.pool.query<ConversationMessage>(`INSERT INTO messages(id,conversation_id,role,content) VALUES ($1,$2,$3,$4) RETURNING id,conversation_id AS "conversationId",role,content,created_at AS "createdAt"`, [randomUUID(), conversationId, role, content]);
    await this.pool.query("UPDATE conversations SET updated_at=now() WHERE id=$1", [conversationId]);
    return result.rows[0]!;
  }

  async listNeutralConversations(context: AuthContext) {
    await this.ensureIdentity(context);
    return (await this.pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE workspace_id=$1 AND business_id IS NULL AND user_id=$2 ORDER BY updated_at DESC`, [context.workspaceId, context.userId])).rows;
  }

  async createNeutralConversation(context: AuthContext, title: string) {
    await this.ensureIdentity(context);
    const result = await this.pool.query<Conversation>(`INSERT INTO conversations(id,workspace_id,business_id,user_id,title) VALUES ($1,$2,NULL,$3,$4) RETURNING ${conversationColumns}`, [randomUUID(), context.workspaceId, context.userId, title.trim().slice(0, 120) || "New conversation"]);
    return result.rows[0]!;
  }

  async getNeutralConversation(context: AuthContext, conversationId: string) {
    await this.ensureIdentity(context);
    const result = await this.pool.query<Conversation>(`SELECT ${conversationColumns} FROM conversations WHERE id=$1 AND workspace_id=$2 AND business_id IS NULL AND user_id=$3`, [conversationId, context.workspaceId, context.userId]);
    if (!result.rowCount) throw new WorkspaceAccessError("Conversation is not available to this user");
    const messages = (await this.pool.query<ConversationMessage>(`SELECT id, conversation_id AS "conversationId", role, content, created_at AS "createdAt" FROM messages WHERE conversation_id=$1 ORDER BY created_at`, [conversationId])).rows;
    return { conversation: result.rows[0]!, messages };
  }

  async updateNeutralConversation(context: AuthContext, conversationId: string, title: string) {
    await this.getNeutralConversation(context, conversationId);
    const result = await this.pool.query<Conversation>(`UPDATE conversations SET title=$1,updated_at=now() WHERE id=$2 RETURNING ${conversationColumns}`, [title.trim().slice(0, 120) || "New conversation", conversationId]);
    return result.rows[0]!;
  }

  async deleteNeutralConversation(context: AuthContext, conversationId: string) {
    await this.getNeutralConversation(context, conversationId);
    return Boolean((await this.pool.query("DELETE FROM conversations WHERE id=$1", [conversationId])).rowCount);
  }

  async appendNeutralMessage(context: AuthContext, conversationId: string, role: ConversationMessage["role"], content: string) {
    await this.getNeutralConversation(context, conversationId);
    const result = await this.pool.query<ConversationMessage>(`INSERT INTO messages(id,conversation_id,role,content) VALUES ($1,$2,$3,$4) RETURNING id,conversation_id AS "conversationId",role,content,created_at AS "createdAt"`, [randomUUID(), conversationId, role, content]);
    await this.pool.query("UPDATE conversations SET updated_at=now() WHERE id=$1", [conversationId]);
    return result.rows[0]!;
  }

  // --- C5a: company membership and invites ---------------------------------------------------
  // Signatures mirror the `CodeMembershipStore` port (apps/agent-api/src/code-membership.ts) exactly:
  // company-scoped, no `AuthContext`, because membership *is* the authorisation anchor.

  /** No row is `null`: there is no "owner by default" fallback anywhere in the membership path. */
  async getCompanyMembership(companyId: string, userId: string): Promise<CompanyMember | null> {
    const result = await this.pool.query<CompanyMember>(`SELECT ${companyMemberColumns} FROM company_members
      WHERE company_id=$1 AND user_id=$2`, [companyId, userId]);
    return result.rows[0] ?? null;
  }

  async listCompanyMembers(companyId: string): Promise<CompanyMember[]> {
    const result = await this.pool.query<CompanyMember>(`SELECT ${companyMemberColumns} FROM company_members
      WHERE company_id=$1 ORDER BY created_at, id`, [companyId]);
    return result.rows;
  }

  /**
   * Owners that could actually administer the company. A `suspended`/`invited` owner has no role
   * (`CodeMembershipService.resolveRoleForUser` returns null for it), so counting it here would let the
   * only *usable* owner be demoted or removed and leave the company without an administrator.
   */
  async countCompanyOwners(companyId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM company_members
      WHERE company_id=$1 AND role='owner' AND status='active'`, [companyId]);
    return Number(result.rows[0]?.count ?? 0);
  }

  async createCompanyInvite(input: CompanyInviteInput): Promise<CompanyInvite> {
    if (!isCompanyRole(input.role)) {
      throw new CompanyMembershipError("invalid_company_role", `Unknown company role: ${String(input.role)}`, { httpStatus: 400 });
    }
    // A token hash is unique (company_invites_token_hash_key): a duplicate must be refused loudly rather
    // than silently reused, because two live invites would share one secret.
    const duplicate = await this.pool.query("SELECT 1 FROM company_invites WHERE token_hash=$1", [input.tokenHash]);
    if (duplicate.rowCount) {
      throw new CompanyMembershipError("invite_token_conflict", "An invite with this token hash already exists", { httpStatus: 409 });
    }
    const result = await this.pool.query<CompanyInvite>(`INSERT INTO company_invites
      (id, company_id, email, role, token_hash, expires_at, created_by, accepted_at, created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (token_hash) DO NOTHING
      RETURNING ${companyInviteColumns}`,
      [input.id, input.companyId, input.email, input.role, input.tokenHash, input.expiresAt, input.createdBy,
        input.acceptedAt ?? null, input.createdAt ?? new Date()]);
    if (!result.rows[0]) {
      // The unique index won a race with the check above.
      throw new CompanyMembershipError("invite_token_conflict", "An invite with this token hash already exists", { httpStatus: 409 });
    }
    return result.rows[0];
  }

  /**
   * Returns the invite whatever its state (including expired and already accepted), so the caller can
   * tell "not a valid token" apart from "valid but expired / already used".
   */
  async findCompanyInviteByTokenHash(tokenHash: string): Promise<CompanyInvite | null> {
    const result = await this.pool.query<CompanyInvite>(`SELECT ${companyInviteColumns} FROM company_invites
      WHERE token_hash=$1`, [tokenHash]);
    return result.rows[0] ?? null;
  }

  /**
   * Accepting an invite creates or reactivates the membership row with the **invited** role.
   *
   * The invite is re-read and claimed inside one transaction: `accepted_at IS NULL AND expires_at > $2`
   * means a token is single-use and dead after its TTL even if the caller still holds a copy of the row.
   * If the membership write is refused, the transaction rolls back, so the token is not burned.
   */
  async acceptCompanyInvite(input: AcceptCompanyInviteInput): Promise<CompanyMember> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<Pick<CompanyInvite, "companyId" | "role" | "createdBy" | "createdAt">>(
        `UPDATE company_invites SET accepted_at=$2
         WHERE id=$1 AND accepted_at IS NULL AND expires_at > $2
         RETURNING company_id AS "companyId", role, created_by AS "createdBy", created_at AS "createdAt"`,
        [input.invite.id, input.acceptedAt]);
      const invite = claimed.rows[0];
      if (!invite) {
        const state = await client.query<{ acceptedAt: Date | null; expiresAt: Date }>(
          `SELECT accepted_at AS "acceptedAt", expires_at AS "expiresAt" FROM company_invites WHERE id=$1`,
          [input.invite.id]);
        const row = state.rows[0];
        if (!row) throw new CompanyMembershipError("invite_not_found", "Invite does not exist", { httpStatus: 404 });
        if (row.acceptedAt) {
          throw new CompanyMembershipError("invite_already_accepted", "Invite token was already used", { httpStatus: 409 });
        }
        throw new CompanyMembershipError("invite_expired", "Invite token has expired", { httpStatus: 410 });
      }
      // Accepting an invite must not demote the only active owner: the guard is part of the upsert, so
      // even a direct store call (bypassing the service) cannot remove the company's administrator.
      const result = await client.query<CompanyMember>(`INSERT INTO company_members
        (id, company_id, user_id, role, status, invited_by, invited_at, accepted_at, created_at)
        VALUES($1,$2,$3,$4,'active',$5,$6,$7,$7)
        ON CONFLICT (company_id, user_id) DO UPDATE SET
          role=$4,
          status='active',
          accepted_at=$7,
          invited_by=COALESCE(company_members.invited_by, $5),
          invited_at=COALESCE(company_members.invited_at, $6),
          revision=company_members.revision+1,
          updated_at=$7
        WHERE NOT (company_members.status='active' AND company_members.role='owner' AND $4<>'owner'
          AND ${lastActiveOwnerPredicate("$2")})
        RETURNING ${companyMemberColumns}`,
        [`cm_${randomUUID()}`, invite.companyId, input.userId, invite.role, invite.createdBy, invite.createdAt, input.acceptedAt]);
      if (!result.rows[0]) {
        throw new CompanyMembershipError(
          "last_owner_protected",
          "Cannot demote the only owner of the company by accepting an invite",
          { httpStatus: 409, details: { operation: "demote", userId: input.userId } },
        );
      }
      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  /**
   * Revision-checked role change. `revision` is the optimistic token: a mismatch is refused with the
   * port's `membership_revision_conflict` (and the tree-wide "changed by another request" message, which
   * existing route mappers already translate to 409) instead of silently overwriting a concurrent write.
   * The only-owner guard lives in the same statement, so `CodeMembershipService`'s earlier check cannot
   * be raced.
   */
  async updateCompanyMemberRole(input: UpdateCompanyMemberRoleInput): Promise<CompanyMember> {
    if (!isCompanyRole(input.role)) {
      throw new CompanyMembershipError("invalid_company_role", `Unknown company role: ${String(input.role)}`, { httpStatus: 400 });
    }
    const result = await this.pool.query<CompanyMember>(`UPDATE company_members
      SET role=$3, revision=revision+1, updated_at=$5
      WHERE company_id=$1 AND user_id=$2 AND revision=$4
        AND NOT (status='active' AND role='owner' AND $3<>'owner'
          AND ${lastActiveOwnerPredicate("$1")})
      RETURNING ${companyMemberColumns}`,
      [input.companyId, input.userId, input.role, input.expectedRevision, input.updatedAt]);
    if (result.rows[0]) return result.rows[0];
    // The guarded write matched nothing: find out why, in the same order the in-memory store reports.
    const current = await this.getCompanyMembership(input.companyId, input.userId);
    if (!current) {
      throw new CompanyMembershipError("membership_not_found", "User is not a member of this company", { httpStatus: 404 });
    }
    if (current.revision !== input.expectedRevision) {
      throw new CompanyMembershipError(
        "membership_revision_conflict",
        "Company member changed by another request. Reload and try again.",
        {
          httpStatus: 409,
          details: { expectedRevision: input.expectedRevision, actualRevision: current.revision },
        },
      );
    }
    const owners = await this.countCompanyOwners(input.companyId);
    throw new CompanyMembershipError(
      "last_owner_protected",
      "Cannot demote the only owner of the company",
      { httpStatus: 409, details: { operation: "demote", owners } },
    );
  }

  /**
   * Removing the last active owner is refused for the same reason as demoting it. Like the port's own
   * implementation this is otherwise a delete: a user who is not a member is already refused with
   * `membership_not_found` (404) by `CodeMembershipService` before the store is called.
   */
  async removeCompanyMember(input: RemoveCompanyMemberInput): Promise<void> {
    const result = await this.pool.query(`DELETE FROM company_members
      WHERE company_id=$1 AND user_id=$2
        AND NOT (status='active' AND role='owner' AND ${lastActiveOwnerPredicate("$1")})`,
      [input.companyId, input.userId]);
    if (result.rowCount) return;
    // Nothing was deleted: either there was no row, or the only-owner guard refused the delete.
    const current = await this.getCompanyMembership(input.companyId, input.userId);
    if (!current) return;
    const owners = await this.countCompanyOwners(input.companyId);
    throw new CompanyMembershipError(
      "last_owner_protected",
      "Cannot remove the only owner of the company",
      { httpStatus: 409, details: { operation: "remove", owners } },
    );
  }

  private async hydrateOnboarding(context: AuthContext, row: Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField">): Promise<BusinessOnboardingSession> {
    const flow = ONBOARDING_FLOWS[row.scenario];
    const legacy = row.currentStep > 0 && !row.completedFields.some((field) => field === "businessSnapshot" || field === "businessGoal");
    const currentStep = legacy && row.status === "active" ? 1 : row.currentStep;
    const completedFields = legacy && row.status === "active" ? ["businessSnapshot"] : row.completedFields;
    return { ...row, currentStep, completedFields, business: await this.getBusiness(context, row.businessId), totalFields: flow.length, currentField: flow[currentStep]?.field };
  }

  async listOnboardings(context: AuthContext) {
    await this.ensureIdentity(context);
    const result = await this.pool.query<Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField">>(
      "SELECT " + onboardingColumns + " FROM business_onboarding_sessions WHERE workspace_id=$1 AND user_id=$2 AND status<>$3 ORDER BY updated_at DESC,id DESC",
      [context.workspaceId, context.userId, "completed"],
    );
    return Promise.all(result.rows.map((row) => this.hydrateOnboarding(context, row)));
  }

  async getOnboarding(context: AuthContext, businessId?: string) {
    const rows = await this.listOnboardings(context);
    return rows.find((row) => !businessId || row.businessId === businessId) ?? null;
  }

  private async getOnboardingSession(context: AuthContext, sessionId: string) {
    await this.ensureIdentity(context);
    const result = await this.pool.query<Omit<BusinessOnboardingSession, "business" | "totalFields" | "currentField">>(
      "SELECT " + onboardingColumns + " FROM business_onboarding_sessions WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND status<>$4",
      [sessionId, context.workspaceId, context.userId, "completed"],
    );
    return result.rowCount ? this.hydrateOnboarding(context, result.rows[0]!) : null;
  }

  async startOnboarding(context: AuthContext, scenario: OnboardingScenario, options?: { forceNew?: boolean }) {
    const existing = options?.forceNew ? null : await this.getOnboarding(context);
    if (existing) return this.setOnboardingStatus(context, existing.id, "active");
    const placeholder = onboardingPlaceholder(scenario);
    const businessId = randomUUID();
    const conversationId = randomUUID();
    const sessionId = randomUUID();
    await this.pool.query(
      "INSERT INTO businesses(id,workspace_id,owner_user_id,name,business_type,business_stage,activation_status) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [businessId, context.workspaceId, context.userId, placeholder.name, placeholder.businessType, placeholder.businessStage, "draft"],
    );
    await this.pool.query(
      "INSERT INTO conversations(id,workspace_id,business_id,user_id,title) VALUES ($1,$2,$3,$4,$5)",
      [conversationId, context.workspaceId, businessId, context.userId, "Business setup"],
    );
    await this.pool.query(
      "INSERT INTO business_onboarding_sessions(id,workspace_id,user_id,business_id,conversation_id,scenario) VALUES ($1,$2,$3,$4,$5,$6)",
      [sessionId, context.workspaceId, context.userId, businessId, conversationId, scenario],
    );
    return (await this.getOnboarding(context, businessId))!;
  }

  async advanceOnboarding(context: AuthContext, sessionId: string, input: { value?: string; skip?: boolean; businessPatch?: Partial<BusinessInput> }) {
    const current = await this.getOnboardingSession(context, sessionId);
    if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
    const step = ONBOARDING_FLOWS[current.scenario][current.currentStep];
    if (!step) return current;
    if (!input.skip) {
      const value = input.value?.trim();
      if (!value) throw new Error("An answer is required or this step can be skipped");
      const stepPatch = step.field === "businessSnapshot" ? input.businessPatch ?? {} : step.field === "businessGoal" ? {} : onboardingBusinessPatch(step.field, value);
      if (Object.keys(stepPatch).length > 0) await this.updateBusiness(context, current.businessId, stepPatch);
    }
    const nextStep = current.currentStep + 1;
    const completedFields = input.skip ? current.completedFields : [...current.completedFields, step.field];
    const skippedFields = input.skip ? [...current.skippedFields, step.field] : current.skippedFields;
    const status = nextStep >= ONBOARDING_FLOWS[current.scenario].length ? "awaiting_confirmation" : "active";
    await this.pool.query(
      "UPDATE business_onboarding_sessions SET current_step=$4,completed_fields=$5::jsonb,skipped_fields=$6::jsonb,status=$7,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND user_id=$3",
      [sessionId, context.workspaceId, context.userId, nextStep, JSON.stringify(completedFields), JSON.stringify(skippedFields), status],
    );
    return (await this.getOnboarding(context, current.businessId))!;
  }

  async setOnboardingStatus(context: AuthContext, sessionId: string, status: "active" | "paused") {
    const current = await this.getOnboardingSession(context, sessionId);
    if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
    await this.pool.query(
      "UPDATE business_onboarding_sessions SET status=$4,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND user_id=$3",
      [sessionId, context.workspaceId, context.userId, status],
    );
    return (await this.getOnboarding(context, current.businessId))!;
  }

  async completeOnboarding(context: AuthContext, sessionId: string): Promise<BusinessOnboardingSession> {
    const current = await this.getOnboardingSession(context, sessionId);
    if (!current || current.id !== sessionId) throw new WorkspaceAccessError("Onboarding session is not available");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE businesses SET activation_status='active',updated_at=now() WHERE id=$1 AND workspace_id=$2", [current.businessId, context.workspaceId]);
      await client.query("UPDATE workspace_members SET current_business_id=$3 WHERE workspace_id=$1 AND user_id=$2", [context.workspaceId, context.userId, current.businessId]);
      await client.query("UPDATE business_onboarding_sessions SET status='completed',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND user_id=$3", [sessionId, context.workspaceId, context.userId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    return { ...current, business: { ...current.business, activationStatus: "active" as const }, status: "completed" as const, updatedAt: new Date().toISOString() };
  }
}
