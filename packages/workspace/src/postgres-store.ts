import * as support from "./postgres-store-support";
import * as company from "./postgres-company-repositories";
import * as project from "./postgres-project-repositories";
import { randomUUID } from "node:crypto";
import { codeChildSessionId } from "./code-child-session-id";
import { PostgresCodeInboxStore } from "./code-session-inbox-postgres";
import { PostgresCodeProcessStore } from "./code-process-store-postgres";
import { assertNoSecrets } from "@npati/memory";
import { Pool } from "pg";
import migration001 from "./migration-001";
import migration002 from "./migration-002";
import migration003 from "./migration-003";
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
import { diffSnapshotPayloads, snapshotPayloadHash } from "./execution-snapshot-hash";
import { auditEntryHash, verifyAuditEntries } from "./audit-chain";
import { mountedFolderPathKey } from "./mounted-folder";
import { CompanyMembershipError, ProviderDataPolicyStoreError, CodeRunStateStoreError, WorkspaceAccessError, WorkspaceNotFoundError } from "./types";
import { PostgresCodeGoalStore } from "./code-goal-store";
import {
  PostgresCodeSessionDurabilityStore,
  type CodeRunRecoveryNoticeRecord,
  type CodeSessionForkRecord,
  type CodeSessionHeadRecord,
  type CodeSessionRewindRecord,
  type CompleteCodeSessionForkInput,
  type CompleteCodeSessionRewindInput,
  type CreateCodeRunRecoveryNoticeInput,
  type CreateCodeSessionForkInput,
  type CreateCodeSessionRewindInput,
  type SetCodeSessionHeadInput,
} from "./code-session-durability-store";
import {
  PostgresCodeUserQuestionStore,
  type AnswerCodeUserQuestionInput,
  type CodeUserQuestionRecord,
  type CreateCodeUserQuestionInput,
} from "./code-question-store";
import type {
  CodeGoalRecord, CodeGoalWithCriteria, CodeSessionPlanRecord, CodeSessionTodoRecord,
  CreateCodeGoalInput, CreateCodeSessionPlanInput, DecideCodeSessionPlanInput,
  ReplaceCodeSessionTodosInput, SetCodeGoalCriterionStatusInput, UpdateCodeGoalInput,
} from "./types";
import { ONBOARDING_FLOWS, onboardingBusinessPatch, onboardingPlaceholder } from "./onboarding";
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
import { RETENTION_FROM, CODE_PROJECT_CHECKPOINT_PREDICATE, CODE_PROJECT_GUARD_FOR, RETENTION_AGE_COLUMN, RETENTION_EXTRA_PREDICATE, SQL_FRAGMENT_SHAPE, assertSqlFragment, RETENTION_WINDOW_EXPR, ERASE_FROM, ERASE_SCOPE_PREDICATE, ERASE_PROJECT_SCOPE_PREDICATE, ERASE_CLEAR_SESSION_REFERENCE, PROJECT_SCOPED_ERASE_TABLES, APPEND_ONLY_COUNTABLE, APPEND_ONLY_AGE_COLUMN, businessColumns, goalColumns, memoryColumns, conversationColumns, onboardingColumns, companyColumns, projectColumns, codeSessionColumns, projectCodeTrustColumns, projectMountedFolderColumns, auditEntryColumns, codeActivityEventColumns, codeContextSummaryColumns, replayBundleColumns, replayBundleStepColumns, auditAnchorColumns, featureFlagColumns, sandboxImageColumns, codeApprovalRuleColumns, projectCheckpointColumns, projectDeploymentColumns, projectQaReportColumns, companyAgentColumns, companyEdgeColumns, companyRunColumns, companyRunStepColumns, companyToolAuditColumns, companyRunEventColumns, companyMemberColumns, companyInviteColumns, lastActiveOwnerPredicate, providerDataPolicyColumns, providerDataPolicyVersionColumns, projectDataPolicyColumns, hostedProviderConsentColumns, codeRunStateColumns, codeRunTurnColumns, StoredUserSetting } from "./postgres-store-schema";

export class PostgresWorkspaceStore implements WorkspaceStore {
  private codeProcessesInstance?: PostgresCodeProcessStore;
  get codeProcesses(): PostgresCodeProcessStore { return this.codeProcessesInstance ??= new PostgresCodeProcessStore(this.pool); }
  private codeInboxInstance?: PostgresCodeInboxStore;
  get codeInbox(): PostgresCodeInboxStore { return this.codeInboxInstance ??= new PostgresCodeInboxStore(this.pool); }
  private readonly pool: Pool;
  constructor(databaseUrl: string) { this.pool = new Pool({ connectionString: databaseUrl, max: 10 }); }

  /**
   * G1 (item 2): the store owns this pool, so it is the component that must release it.
   *
   * Before this method existed the pool outlived every consumer: `apps/agent-api/src/app.ts` closed fifteen
   * other repositories in its `onClose` hook and never this one, and the only place that tried to close it was
   * a test that called a `close()` which did not exist anywhere in the repository — so the attempt threw
   * *inside* a `finally` block and replaced the real assertion failure with `store.close is not a function`.
   *
   * Three repositories are built **on this same pool** (`ApiKeysRepository`, `ScopedMemoryEngine`,
   * `GuardrailPolicyRepository` — they are handed `workspaceStore`'s pool by the composition), which is why the
   * caller closes it last and why this method must not be reachable from those repositories: none of them owns it.
   */
  async close(): Promise<void> { await this.pool.end(); }

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
    // C5b: ProviderDataPolicy, project classification, policy history and hosted-provider consent.
    // Additive: 074 creates its own four tables and indexes and touches no existing table, row or query.
    const providerDataPoliciesMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='074_provider_data_policies'");
    if (!providerDataPoliciesMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration074 } = await import("./migration-074");
        await runMigration074(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('074_provider_data_policies')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C6a: durable Coding Agent run state (turn boundaries, monotonic event sequence, lease/heartbeat).
    // Additive: 075 creates its own two tables and indexes and touches no existing table, row or query.
    const codeRunStateMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='075_code_run_state'");
    if (!codeRunStateMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration075 } = await import("./migration-075");
        await runMigration075(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('075_code_run_state')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C6b: immutable execution snapshots and the versioned system prompt / model profiles they reference.
    // Additive: 076 creates its own two tables, indexes and append-only triggers; no existing table is touched.
    const executionSnapshotMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='076_execution_snapshots'");
    if (!executionSnapshotMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration076 } = await import("./migration-076");
        await runMigration076(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('076_execution_snapshots')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C6b: durable Activity events with their `snapshot_id` (requirement 19).
    // Additive: 077 creates its own table and four indexes and touches no existing table, row or query.
    const codeActivityEventsMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='077_code_activity_events'");
    if (!codeActivityEventsMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration077 } = await import("./migration-077");
        await runMigration077(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('077_code_activity_events')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C6b: versioned replay bundles (header + ordered steps) for deterministic replay.
    // Additive: 078 creates its own two tables, indexes and append-only triggers; no existing table is touched.
    const replayBundlesMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='078_replay_bundles'");
    if (!replayBundlesMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration078 } = await import("./migration-078");
        await runMigration078(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('078_replay_bundles')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C8: durable context summaries (append-only session artifacts produced by conversation compaction).
    // Additive: 079 creates its own table, four indexes and its append-only trigger; no existing table is touched.
    const contextSummariesMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='079_code_context_summaries'");
    if (!contextSummariesMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration079 } = await import("./migration-079");
        await runMigration079(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('079_code_context_summaries')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C9: goals, plan revisions and session todos.
    // Additive: 080 creates its own four tables, indexes and two acceptance triggers; no existing table is
    // touched, and it deliberately adds no foreign key to `company_agent_runs` (a code run has no row there).
    const goalsAndPlansMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='080_code_goals_and_plans'");
    if (!goalsAndPlansMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration080 } = await import("./migration-080");
        await runMigration080(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('080_code_goals_and_plans')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C9: `code.ask_user` — the question a run waits on.
    // Additive: 081 creates one new table and widens the `code_run_states.status` CHECK with
    // `waiting_for_user`. Widening an allowed set is expand-only: an older application never writes the new
    // value and keeps working against the new schema.
    const userQuestionsMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='081_code_user_questions'");
    if (!userQuestionsMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration081 } = await import("./migration-081");
        await runMigration081(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('081_code_user_questions')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C10: session durability — the conversation cursor, the reconciler's notice and the rewind/fork ledgers.
    // Additive: 082 creates four new tables, their indexes and one append-only trigger; no existing table is
    // altered, and the only foreign key points at `code_sessions` (which exists since 065) rather than at a
    // C12 structure. The cursor is what makes a conversation rewind possible without deleting the append-only
    // replay bundle and the context summaries.
    const sessionDurabilityMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='082_code_session_durability'");
    if (!sessionDurabilityMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration082 } = await import("./migration-082");
        await runMigration082(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('082_code_session_durability')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C10: the run's original request. Additive: 083 adds seven columns and their CHECK constraints to the
    // existing `code_run_states` table, so a previous application version keeps working against the new schema
    // (it simply never writes the new columns, and their defaults read as "this run has no recorded request").
    const runRequestMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='083_code_run_request'");
    if (!runRequestMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration083 } = await import("./migration-083");
        await runMigration083(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('083_code_run_request')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C12: the delegation tree of Activity events. Additive: 084 adds three nullable columns and one partial
    // index to `code_activity_events`, so a previous application version keeps working against the new schema —
    // it simply never writes the parent columns, and their `NULL` reads as "this event has no parent", which is
    // the honest reading of every row written before the delegation tree existed.
    const activityParentMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='084_code_activity_parents'");
    if (!activityParentMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration084 } = await import("./migration-084");
        await runMigration084(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('084_code_activity_parents')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C13 (owner decision 5): the durable owner/admin risk decisions for runtime MCP tools. Additive: 085
    // creates one new table with its unique key, so a previous application version keeps working — it never
    // reads the table, and every runtime MCP tool keeps the fail-closed `high` + approval-required default.
    const mcpToolPolicyMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='085_mcp_tool_policies'");
    if (!mcpToolPolicyMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration085 } = await import("./migration-085");
        await runMigration085(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('085_mcp_tool_policies')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // C15: the mounted local folder allowlist. Additive: 086 creates one new table with its per-project unique
    // key and two reader indexes, so a previous application version keeps working — it never reads the table,
    // and a project without a row keeps the managed workspace root (no mount is implied by its absence).
    const mountedFolderMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='086_project_mounted_folders'");
    if (!mountedFolderMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration086 } = await import("./migration-086");
        await runMigration086(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('086_project_mounted_folders')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    // R1-C (item 13): classification and retention on the three families that had neither. Additive: 087 adds
    // two NOT NULL columns **with defaults** (so an existing row, and an insert from a previous application
    // version, keeps working), the established CHECK vocabulary, and one retention index per table. No
    // previous version reads any of it, and no row changes meaning — which is what "expand only" has to mean
    // for `project_checkpoints`, a table the Website Builder also writes.
    const dataRetentionMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='087_code_data_retention'");
    if (!dataRetentionMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration087 } = await import("./migration-087");
        await runMigration087(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('087_code_data_retention')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const inboxMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='088_code_session_inbox'");
    if (!inboxMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration088 } = await import("./migration-088");
        await runMigration088(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('088_code_session_inbox')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const processMigration = await this.pool.query("SELECT 1 FROM schema_migrations WHERE version='089_code_process_projects'");
    if (!processMigration.rowCount) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('089_code_process_projects'))");
        const { runMigration089 } = await import("./migration-089");
        await runMigration089(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('089_code_process_projects') ON CONFLICT DO NOTHING");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
  }

  // --- C9: `code.ask_user` — the persistent question --------------------------------------------------
  // The rules (only an offered choice is accepted, an answered question is never re-answered, an unanswered one
  // never carries an answer) live in `code-question-store.ts` and are shared with the in-memory backend. The
  // database repeats the two structural ones as CHECK constraints in migration 081.

  private codeUserQuestionStoreInstance?: PostgresCodeUserQuestionStore;

  private questions(): PostgresCodeUserQuestionStore {
    if (!this.codeUserQuestionStoreInstance) {
      this.codeUserQuestionStoreInstance = new PostgresCodeUserQuestionStore(this.pool);
    }
    return this.codeUserQuestionStoreInstance;
  }

  async createCodeUserQuestion(input: CreateCodeUserQuestionInput): Promise<CodeUserQuestionRecord> {
    return this.questions().createQuestion(input);
  }

  async getCodeUserQuestion(companyId: string, questionId: string): Promise<CodeUserQuestionRecord | null> {
    return this.questions().getQuestion(companyId, questionId);
  }

  async getPendingCodeUserQuestionForRun(companyId: string, runId: string): Promise<CodeUserQuestionRecord | null> {
    return this.questions().getPendingQuestionForRun(companyId, runId);
  }

  async answerCodeUserQuestion(input: AnswerCodeUserQuestionInput): Promise<CodeUserQuestionRecord> {
    return this.questions().answerQuestion(input);
  }

  async expireCodeUserQuestions(input: { now?: Date; companyId?: string; runId?: string } = {}): Promise<number> {
    return this.questions().expireQuestions(input);
  }

  async listExpiredCodeUserQuestions(input: { now?: Date; limit?: number } = {}): Promise<CodeUserQuestionRecord[]> {
    return this.questions().listExpiredQuestions(input);
  }

  async cancelPendingCodeUserQuestions(input: { companyId: string; runId: string; now?: Date }): Promise<number> {
    return this.questions().cancelPendingQuestions(input);
  }

  // --- C10: session durability ----------------------------------------------------------------------
  // The cursor of a conversation, the reconciler's notice and the two operation ledgers. The rules (one head
  // per session, claim-before-perform, revision-checked updates) live in `code-session-durability-store.ts`
  // and are shared with the in-memory backend; migration 082 repeats the structural ones as constraints.

  private codeSessionDurabilityInstance?: PostgresCodeSessionDurabilityStore;

  private durability(): PostgresCodeSessionDurabilityStore {
    if (!this.codeSessionDurabilityInstance) {
      this.codeSessionDurabilityInstance = new PostgresCodeSessionDurabilityStore(this.pool);
    }
    return this.codeSessionDurabilityInstance;
  }

  async getCodeSessionHead(companyId: string, sessionId: string): Promise<CodeSessionHeadRecord | null> {
    return this.durability().getHead(companyId, sessionId);
  }

  async setCodeSessionHead(input: SetCodeSessionHeadInput): Promise<CodeSessionHeadRecord> {
    return this.durability().setHead(input);
  }

  async createCodeRunRecoveryNotice(input: CreateCodeRunRecoveryNoticeInput): Promise<CodeRunRecoveryNoticeRecord> {
    return this.durability().createNotice(input);
  }

  async getLatestCodeRunRecoveryNotice(companyId: string, runId: string): Promise<CodeRunRecoveryNoticeRecord | null> {
    return this.durability().getLatestNotice(companyId, runId);
  }

  async listCodeRunRecoveryNotices(input: { companyId: string; runId: string; limit?: number }): Promise<CodeRunRecoveryNoticeRecord[]> {
    return this.durability().listNotices(input);
  }

  async createCodeSessionRewind(input: CreateCodeSessionRewindInput): Promise<{ record: CodeSessionRewindRecord; replayed: boolean }> {
    return this.durability().createRewind(input);
  }

  async getCodeSessionRewind(companyId: string, operationId: string): Promise<CodeSessionRewindRecord | null> {
    return this.durability().getRewind(companyId, operationId);
  }

  async reopenCodeSessionRewind(input: { companyId: string; operationId: string; staleMs?: number; now?: Date }): Promise<{ record: CodeSessionRewindRecord | null; reopened: boolean }> {
    return this.durability().reopenRewind(input);
  }

  async completeCodeSessionRewind(input: CompleteCodeSessionRewindInput): Promise<CodeSessionRewindRecord> {
    return this.durability().completeRewind(input);
  }

  async listCodeSessionRewinds(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionRewindRecord[]> {
    return this.durability().listRewinds(input);
  }

  async createCodeSessionFork(input: CreateCodeSessionForkInput): Promise<{ record: CodeSessionForkRecord; replayed: boolean }> {
    return this.durability().createFork(input);
  }

  async getCodeSessionFork(companyId: string, operationId: string): Promise<CodeSessionForkRecord | null> {
    return this.durability().getFork(companyId, operationId);
  }

  async completeCodeSessionFork(input: CompleteCodeSessionForkInput): Promise<CodeSessionForkRecord> {
    return this.durability().completeFork(input);
  }

  async listCodeSessionForks(input: { companyId: string; parentSessionId: string; limit?: number }): Promise<CodeSessionForkRecord[]> {
    return this.durability().listForks(input);
  }

  async reopenCodeSessionFork(input: { companyId: string; operationId: string; staleMs?: number; now?: Date }): Promise<{ record: CodeSessionForkRecord | null; reopened: boolean }> {
    return this.durability().reopenFork(input);
  }

  // --- C9: goals, plan revisions and session todos --------------------------------------------------
  // The rules (goal completion needs verified criteria, plans are revisioned, at most one todo in progress)
  // live in `code-goal-store.ts` and are shared with the in-memory backend, so the two cannot drift. The
  // database additionally enforces them with the triggers and partial unique indexes of migration 080.

  private codeGoalStoreInstance?: PostgresCodeGoalStore;

  private goals(): PostgresCodeGoalStore {
    if (!this.codeGoalStoreInstance) this.codeGoalStoreInstance = new PostgresCodeGoalStore(this.pool);
    return this.codeGoalStoreInstance;
  }

  async createCodeGoal(input: CreateCodeGoalInput): Promise<CodeGoalWithCriteria> {
    return this.goals().createGoal(input);
  }

  async getCodeGoal(companyId: string, goalId: string): Promise<CodeGoalWithCriteria | null> {
    return this.goals().getGoal(companyId, goalId);
  }

  async listCodeGoals(input: { companyId: string; sessionId?: string; projectId?: string; limit?: number }): Promise<CodeGoalRecord[]> {
    return this.goals().listGoals(input);
  }

  async updateCodeGoal(input: UpdateCodeGoalInput): Promise<CodeGoalWithCriteria> {
    return this.goals().updateGoal(input);
  }

  async setCodeGoalCriterionStatus(input: SetCodeGoalCriterionStatusInput): Promise<CodeGoalWithCriteria> {
    return this.goals().setCriterionStatus(input);
  }

  async createCodeSessionPlan(input: CreateCodeSessionPlanInput): Promise<CodeSessionPlanRecord> {
    return this.goals().createPlan(input);
  }

  async getLatestCodeSessionPlan(companyId: string, sessionId: string): Promise<CodeSessionPlanRecord | null> {
    return this.goals().getLatestPlan(companyId, sessionId);
  }

  async listCodeSessionPlans(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionPlanRecord[]> {
    return this.goals().listPlans(input);
  }

  async decideCodeSessionPlan(input: DecideCodeSessionPlanInput): Promise<CodeSessionPlanRecord> {
    return this.goals().decidePlan(input);
  }

  async replaceCodeSessionTodos(input: ReplaceCodeSessionTodosInput): Promise<CodeSessionTodoRecord[]> {
    return this.goals().replaceTodos(input);
  }

  async listCodeSessionTodos(input: { companyId: string; sessionId: string }): Promise<CodeSessionTodoRecord[]> {
    return this.goals().listTodos(input.companyId, input.sessionId);
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
    return company.appendAuditEntry(this.pool, context, companyId, input);
  }

  async listAuditEntries(context: AuthContext, companyId: string, filters: { actor?: string; requestId?: string; correlationId?: string; action?: string; limit?: number; fromSequence?: number } = {}): Promise<AuditEntry[]> {
    return company.listAuditEntries(this.pool, context, companyId, filters);
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
    return company.verifyAuditChain(this.pool, context, companyId, range);
  }

  async auditChainState(context: AuthContext, companyId: string): Promise<AuditChainState> {
    return company.auditChainState(this.pool, context, companyId);
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
    return company.listAuditAnchors(this.pool, context, companyId, limit);
  }

  async latestAuditAnchor(context: AuthContext, companyId: string): Promise<AuditAnchor | null> {
    const anchors = await this.listAuditAnchors(context, companyId, 1);
    return anchors[0] ?? null;
  }

  async auditCompanies(context: AuthContext): Promise<string[]> {
    return company.auditCompanies(this.pool, context);
  }

  /** Background verifier path: no user context, workspace-scoped, hashes and counts only. */
  async systemAuditChains(workspaceId: string) {
    return company.systemAuditChains(this.pool, workspaceId);
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
    await support.ensureIdentity(this.pool, context);
  }

  private async assertMember(context: AuthContext) {
    return support.assertMember(this.pool, context);
  }

  async getBusiness(context: AuthContext, businessId: string) {
    return support.getBusiness(this.pool, context, businessId);
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
    return support.assertCompany(this.pool, context, companyId);
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
    return company.listCompanyAgents(this.pool, context, companyId);
  }

  async listCompanyAgentsPage(context: AuthContext, companyId: string, requestedLimit = 50, cursor?: string) {
    return company.listCompanyAgentsPage(this.pool, context, companyId, requestedLimit, cursor);
  }


  async createProject(context: AuthContext, companyId: string, input: ProjectInput, idempotencyKey: string) {
    return project.createProject(this.pool, context, companyId, input, idempotencyKey);
  }

  async listProjects(context: AuthContext, companyId: string, includeArchived = false) {
    return project.listProjects(this.pool, context, companyId, includeArchived);
  }

  async getProject(context: AuthContext, companyId: string, projectId: string) {
    return support.getProject(this.pool, context, companyId, projectId);
  }

  async updateProject(context: AuthContext, companyId: string, projectId: string, input: { name?: string; expectedRevision: number; code?: ProjectCodeSettings }) {
    return project.updateProject(this.pool, context, companyId, projectId, input);
  }

  async setProjectSandbox(context: AuthContext, companyId: string, projectId: string, sandboxId: string | null, expectedSandboxId: string | null) {
    return project.setProjectSandbox(this.pool, context, companyId, projectId, sandboxId, expectedSandboxId);
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
    return project.archiveProject(this.pool, context, companyId, projectId, expectedRevision);
  }

  async deleteProject(context: AuthContext, companyId: string, projectId: string) {
    return project.deleteProject(this.pool, context, companyId, projectId);
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
    const id = input.childKey && input.parentSessionId
      ? codeChildSessionId(context, companyId, projectId, input.parentSessionId, input.childKey) : randomUUID();
    const session = await this.pool.query<CodeSession>(`INSERT INTO code_sessions
      (id, workspace_id, company_id, project_id, user_id, agent_id, mode, model_profile, status, parent_session_id,
       summary, data_classification, retention_class)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11,$12)
      ON CONFLICT (id) DO NOTHING
      RETURNING ${codeSessionColumns}`,
      [id, context.workspaceId, companyId, projectId, context.userId, input.agentId ?? null,
        input.mode ?? "edit", input.modelProfile ?? null, input.parentSessionId ?? null, input.summary ?? null,
        requested, input.retentionClass ?? project.retentionClass]);
    return session.rows[0] ?? this.getCodeSession(context, companyId, id);
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
    return project.getProjectCodeTrust(this.pool, context, companyId, projectId);
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

  // --- C15: the mounted local folder allowlist ------------------------------------------------

  async getProjectMountedFolder(context: AuthContext, companyId: string, projectId: string): Promise<ProjectMountedFolder | null> {
    return project.getProjectMountedFolder(this.pool, context, companyId, projectId);
  }

  /**
   * The runner-side read: the same row, addressed by ids alone, because the sandbox runner has no user
   * session. It is a point lookup on the per-project unique key, and `null` (unknown ids, no database) is the
   * fail-closed answer — a runner that cannot read the allowlist mounts nothing.
   */
  async getProjectMountedFolderForSystem(companyId: string, projectId: string): Promise<ProjectMountedFolder | null> {
    return project.getProjectMountedFolderForSystem(this.pool, companyId, projectId);
  }

  /**
   * The single writer of the allowlist. Revision-checked exactly like project trust: a missing row means
   * "revision 0, no mount", so the first write must pass `expectedRevision: 0`, and a later confirmation
   * cannot overwrite a decision another request made in the meantime.
   */
  async setProjectMountedFolder(context: AuthContext, companyId: string, projectId: string, input: ProjectMountedFolderInput): Promise<ProjectMountedFolder> {
    const existing = await this.getProjectMountedFolder(context, companyId, projectId);
    if (input.expectedRevision !== (existing?.revision ?? 0)) {
      throw new WorkspaceAccessError("Mounted folder changed by another request. Reload and try again.");
    }
    const result = await this.pool.query<ProjectMountedFolder>(`INSERT INTO project_mounted_folders
      (id, workspace_id, company_id, project_id, path, path_key, mode, confirmed_by, confirmed_at, revoked_by, revoked_at, reason, revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1)
      ON CONFLICT (company_id, project_id) DO UPDATE SET
        path=$5,
        path_key=$6,
        mode=$7,
        confirmed_by=CASE WHEN $13 THEN $8 ELSE project_mounted_folders.confirmed_by END,
        confirmed_at=CASE WHEN $13 THEN $9 ELSE project_mounted_folders.confirmed_at END,
        revoked_by=CASE WHEN $13 THEN project_mounted_folders.revoked_by ELSE $10 END,
        revoked_at=CASE WHEN $13 THEN project_mounted_folders.revoked_at ELSE $11 END,
        reason=$12,
        revision=project_mounted_folders.revision+1,
        updated_at=now()
      RETURNING ${projectMountedFolderColumns}`,
      [randomUUID(), context.workspaceId, companyId, projectId, input.path, mountedFolderPathKey(input.path), input.mode,
        input.confirmed ? input.actor : null,
        input.confirmed ? new Date().toISOString() : null,
        input.confirmed ? null : input.actor,
        input.confirmed ? null : new Date().toISOString(),
        input.reason ?? null,
        input.confirmed]);
    return result.rows[0]!;
  }

  /** Rejects an agent id that does not belong to the company (tenant isolation for sessions). */
  private async assertProjectAgent(context: AuthContext, companyId: string, agentId?: string) {
    return company.assertProjectAgent(this.pool, context, companyId, agentId);
  }

  async createProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, input: CreateCheckpointInput): Promise<ProjectCheckpoint> {
    return project.createProjectCheckpoint(this.pool, context, companyId, projectId, input);
  }

  async listProjectCheckpoints(context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectCheckpoint[]> {
    return project.listProjectCheckpoints(this.pool, context, companyId, projectId, limit);
  }

  async getProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<ProjectCheckpoint> {
    return project.getProjectCheckpoint(this.pool, context, companyId, projectId, checkpointId);
  }

  async deleteProjectCheckpoint(context: AuthContext, companyId: string, projectId: string, checkpointId: string): Promise<boolean> {
    return project.deleteProjectCheckpoint(this.pool, context, companyId, projectId, checkpointId);
  }

  async createProjectDeployment(context: AuthContext, companyId: string, projectId: string, input: CreateDeploymentInput): Promise<ProjectDeployment> {
    return project.createProjectDeployment(this.pool, context, companyId, projectId, input);
  }

  async listProjectDeployments(context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectDeployment[]> {
    return project.listProjectDeployments(this.pool, context, companyId, projectId, limit);
  }

  async getProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string): Promise<ProjectDeployment | null> {
    return project.getProjectDeployment(this.pool, context, companyId, projectId, deploymentId);
  }

  async updateProjectDeployment(context: AuthContext, companyId: string, projectId: string, deploymentId: string, patch: Partial<ProjectDeployment>): Promise<ProjectDeployment> {
    return project.updateProjectDeployment(this.pool, context, companyId, projectId, deploymentId, patch);
  }

  async createProjectQaReport(context: AuthContext, companyId: string, projectId: string, input: CreateProjectQaReportInput): Promise<ProjectQaReport> {
    return project.createProjectQaReport(this.pool, context, companyId, projectId, input);
  }

  async listProjectQaReports(context: AuthContext, companyId: string, projectId: string, limit = 50): Promise<ProjectQaReport[]> {
    return project.listProjectQaReports(this.pool, context, companyId, projectId, limit);
  }

  async getProjectQaReport(context: AuthContext, companyId: string, projectId: string, reportId: string): Promise<ProjectQaReport | null> {
    return project.getProjectQaReport(this.pool, context, companyId, projectId, reportId);
  }

  async getLatestProjectQaReport(context: AuthContext, companyId: string, projectId: string): Promise<ProjectQaReport | null> {
    const list = await this.listProjectQaReports(context, companyId, projectId, 1);
    return list[0] ?? null;
  }

  async getCompanyAgent(context: AuthContext, companyId: string, agentId: string) {
    return company.getCompanyAgent(this.pool, context, companyId, agentId);
  }

  async createCompanyAgent(context: AuthContext, companyId: string, input: CompanyAgentInput, idempotencyKey: string) {
    return company.createCompanyAgent(this.pool, context, companyId, input, idempotencyKey);
  }


  async updateCompanyAgent(context: AuthContext, companyId: string, agentId: string, input: Partial<CompanyAgentInput>, expectedRevision: number) {
    return company.updateCompanyAgent(this.pool, context, companyId, agentId, input, expectedRevision);
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
    return company.listCompanyAgentEdges(this.pool, context, companyId, agentIds);
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
    return company.createCompanyAgentRun(this.pool, context, companyId, input, idempotencyKey);
  }

  async listCompanyAgentRuns(context: AuthContext, companyId: string, limit = 50, filter?: { projectId?: string }) {
    return company.listCompanyAgentRuns(this.pool, context, companyId, limit, filter);
  }

  async listProjectRuns(context: AuthContext, companyId: string, projectId: string, limit = 50) {
    return this.listCompanyAgentRuns(context, companyId, limit, { projectId });
  }

  async getCompanyAgentRun(context: AuthContext, companyId: string, runId: string) {
    return company.getCompanyAgentRun(this.pool, context, companyId, runId);
  }

  async getCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string): Promise<unknown | null> {
    return company.getCompanyRunPendingPlan(this.pool, context, companyId, runId);
  }
  async setCompanyRunPendingPlan(context: AuthContext, companyId: string, runId: string, plan: unknown | null): Promise<void> {
    return company.setCompanyRunPendingPlan(this.pool, context, companyId, runId, plan);
  }
  async updateCompanyAgentRun(context: AuthContext, companyId: string, runId: string, patch: Partial<CompanyAgentRun>) {
    return company.updateCompanyAgentRun(this.pool, context, companyId, runId, patch);
  }

  async replaceCompanyAgentRunSteps(context: AuthContext, companyId: string, runId: string, steps: Array<Pick<CompanyAgentRunStep, "agentId" | "stepOrder" | "lane" | "role" | "status" | "modelId">>) {
    return company.replaceCompanyAgentRunSteps(this.pool, context, companyId, runId, steps);
  }

  async appendCompanyAgentToolAudit(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentToolAudit, "agentId" | "toolName" | "decision" | "status" | "inputSummary" | "errorMessage"> & Partial<Pick<CompanyAgentToolAudit, "latencyMs" | "cost" | "tokens" | "reasonCode" | "sequenceNumber">>) {
    return company.appendCompanyAgentToolAudit(this.pool, context, companyId, runId, entry);
  }

  async appendCompanyAgentRunEvent(context: AuthContext, companyId: string, runId: string, entry: Pick<CompanyAgentRunEvent, "eventKey" | "eventType" | "runStatus" | "message"> & Partial<Pick<CompanyAgentRunEvent, "workerId" | "attemptCount" | "details">>) {
    return company.appendCompanyAgentRunEvent(this.pool, context, companyId, runId, entry);
  }


  async claimCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) {
    return company.claimCompanyAgentRun(this.pool, context, companyId, runId, workerId, leaseMs);
  }

  async heartbeatCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, leaseMs: number) {
    return company.heartbeatCompanyAgentRun(this.pool, context, companyId, runId, workerId, leaseMs);
  }

  async requeueCompanyAgentRun(context: AuthContext, companyId: string, runId: string, workerId: string, delayMs: number) {
    return company.requeueCompanyAgentRun(this.pool, context, companyId, runId, workerId, delayMs);
  }

  async listRecoverableCompanyAgentRuns(limit = 200) {
    return company.listRecoverableCompanyAgentRuns(this.pool, limit);
  }

  async listGoals(context: AuthContext, businessId: string) {
    return company.listGoals(this.pool, context, businessId);
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
    return company.createGoal(this.pool, context, businessId, input);
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
    return company.updateGoal(this.pool, context, businessId, goalId, input);
  }

  async deleteGoal(context: AuthContext, businessId: string, goalId: string) {
    return company.deleteGoal(this.pool, context, businessId, goalId);
  }

  async listMemory(context: AuthContext, businessId: string, query = "", limit = 100) {
    return company.listMemory(this.pool, context, businessId, query, limit);
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
    return company.createMemory(this.pool, context, businessId, input);
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
    return company.updateMemory(this.pool, context, businessId, memoryId, input);
  }

  async deleteMemory(context: AuthContext, businessId: string, memoryId: string) {
    return company.deleteMemory(this.pool, context, businessId, memoryId);
  }

  async listConversations(context: AuthContext, businessId: string) {
    return company.listConversations(this.pool, context, businessId);
  }

  async createConversation(context: AuthContext, businessId: string, title: string) {
    return company.createConversation(this.pool, context, businessId, title);
  }

  async getConversation(context: AuthContext, businessId: string, conversationId: string) {
    return company.getConversation(this.pool, context, businessId, conversationId);
  }

  async updateConversation(context: AuthContext, businessId: string, conversationId: string, title: string) {
    return company.updateConversation(this.pool, context, businessId, conversationId, title);
  }

  async deleteConversation(context: AuthContext, businessId: string, conversationId: string) {
    return company.deleteConversation(this.pool, context, businessId, conversationId);
  }

  async appendMessage(context: AuthContext, businessId: string, conversationId: string, role: ConversationMessage["role"], content: string) {
    return company.appendMessage(this.pool, context, businessId, conversationId, role, content);
  }

  async listNeutralConversations(context: AuthContext) {
    return company.listNeutralConversations(this.pool, context);
  }

  async createNeutralConversation(context: AuthContext, title: string) {
    return company.createNeutralConversation(this.pool, context, title);
  }

  async getNeutralConversation(context: AuthContext, conversationId: string) {
    return company.getNeutralConversation(this.pool, context, conversationId);
  }

  async updateNeutralConversation(context: AuthContext, conversationId: string, title: string) {
    return company.updateNeutralConversation(this.pool, context, conversationId, title);
  }

  async deleteNeutralConversation(context: AuthContext, conversationId: string) {
    return company.deleteNeutralConversation(this.pool, context, conversationId);
  }

  async appendNeutralMessage(context: AuthContext, conversationId: string, role: ConversationMessage["role"], content: string) {
    return company.appendNeutralMessage(this.pool, context, conversationId, role, content);
  }

  // --- C5a: company membership and invites ---------------------------------------------------
  // Signatures mirror the `CodeMembershipStore` port (apps/agent-api/src/code-membership.ts) exactly:
  // company-scoped, no `AuthContext`, because membership *is* the authorisation anchor.

  /** No row is `null`: there is no "owner by default" fallback anywhere in the membership path. */
  async getCompanyMembership(companyId: string, userId: string): Promise<CompanyMember | null> {
    return company.getCompanyMembership(this.pool, companyId, userId);
  }

  async listCompanyMembers(companyId: string): Promise<CompanyMember[]> {
    return company.listCompanyMembers(this.pool, companyId);
  }

  /**
   * Owners that could actually administer the company. A `suspended`/`invited` owner has no role
   * (`CodeMembershipService.resolveRoleForUser` returns null for it), so counting it here would let the
   * only *usable* owner be demoted or removed and leave the company without an administrator.
   */
  async countCompanyOwners(companyId: string): Promise<number> {
    return company.countCompanyOwners(this.pool, companyId);
  }

  async createCompanyInvite(input: CompanyInviteInput): Promise<CompanyInvite> {
    return company.createCompanyInvite(this.pool, input);
  }

  /**
   * Returns the invite whatever its state (including expired and already accepted), so the caller can
   * tell "not a valid token" apart from "valid but expired / already used".
   */
  async findCompanyInviteByTokenHash(tokenHash: string): Promise<CompanyInvite | null> {
    return company.findCompanyInviteByTokenHash(this.pool, tokenHash);
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
    return company.updateCompanyMemberRole(this.pool, input);
  }

  /**
   * Removing the last active owner is refused for the same reason as demoting it. Like the port's own
   * implementation this is otherwise a delete: a user who is not a member is already refused with
   * `membership_not_found` (404) by `CodeMembershipService` before the store is called.
   */
  async removeCompanyMember(input: RemoveCompanyMemberInput): Promise<void> {
    return company.removeCompanyMember(this.pool, input);
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

  // --- C5b: ProviderDataPolicy ------------------------------------------------------------------
  // Company-scoped and deliberately without `AuthContext`, mirroring the C5a membership convention: the
  // policy is the *subject* of authorisation, and the app-side service has already resolved the principal.
  // Every statement is scoped by `company_id` (with `NULL` meaning the platform default row), so one tenant
  // can never read or write another's policy.

  /**
   * Validation duplicated from `provider-data-policy.ts` on purpose: a direct store call must be as safe as
   * one that went through the service. The codes match the app-side error class so a single route mapper
   * handles both.
   */
  private assertValidProviderPolicy(input: UpsertProviderDataPolicyStoreInput): void {
    if (!isProviderDataPolicyKind(input.kind)) {
      throw new ProviderDataPolicyStoreError("invalid_policy_field", `Unsupported provider kind: ${String(input.kind)}`, {
        httpStatus: 400, details: { field: "kind" },
      });
    }
    if (!isClassificationAtLeast(input.maxDataClassification, "public")) {
      throw new ProviderDataPolicyStoreError(
        "invalid_classification",
        `Unsupported classification: ${String(input.maxDataClassification)}`,
        { httpStatus: 400, details: { field: "maxDataClassification" } },
      );
    }
    if (!isProviderTrainingPolicy(input.trainingPolicy)) {
      throw new ProviderDataPolicyStoreError(
        "invalid_policy_field",
        `Unsupported training policy: ${String(input.trainingPolicy)}`,
        { httpStatus: 400, details: { field: "trainingPolicy" } },
      );
    }
    if (!isExternalRetention(input.externalRetention)) {
      throw new ProviderDataPolicyStoreError(
        "invalid_retention",
        `Unsupported external retention: ${String(input.externalRetention)}`,
        { httpStatus: 400, details: { field: "externalRetention" } },
      );
    }
    const redactions = input.requiredRedactions ?? MANDATORY_PROVIDER_REDACTIONS;
    for (const kind of redactions) {
      if (!isProviderRedactionKind(kind)) {
        throw new ProviderDataPolicyStoreError("invalid_policy_field", `Unsupported redaction kind: ${String(kind)}`, {
          httpStatus: 400, details: { field: "requiredRedactions" },
        });
      }
    }
    const missing = MANDATORY_PROVIDER_REDACTIONS.filter((kind) => !redactions.includes(kind));
    if (missing.length > 0) {
      throw new ProviderDataPolicyStoreError(
        "invalid_policy_field",
        `Required redactions must include: ${missing.join(", ")}`,
        { httpStatus: 400, details: { field: "requiredRedactions", missing } },
      );
    }
    for (const contentType of input.allowedContentTypes ?? ["metadata"]) {
      if (!isProviderContentType(contentType)) {
        throw new ProviderDataPolicyStoreError(
          "invalid_policy_field",
          `Unsupported content type: ${String(contentType)}`,
          { httpStatus: 400, details: { field: "allowedContentTypes" } },
        );
      }
    }
  }

  async getProviderDataPolicy(input: {
    companyId: string | null;
    providerId: string;
    modelPattern: string | null;
  }): Promise<ProviderDataPolicyRecord | null> {
    const result = await this.pool.query<ProviderDataPolicyRecord>(
      `SELECT ${providerDataPolicyColumns} FROM provider_data_policies
       WHERE COALESCE(company_id,'')=COALESCE($1,'') AND provider_id=$2 AND COALESCE(model_pattern,'')=COALESCE($3,'')`,
      [input.companyId, input.providerId, input.modelPattern],
    );
    return result.rows[0] ?? null;
  }

  async listProviderDataPolicies(companyId: string | null): Promise<ProviderDataPolicyRecord[]> {
    const result = await this.pool.query<ProviderDataPolicyRecord>(
      `SELECT ${providerDataPolicyColumns} FROM provider_data_policies
       WHERE COALESCE(company_id,'')=COALESCE($1,'')
       ORDER BY provider_id, model_pattern`,
      [companyId],
    );
    return result.rows;
  }

  /**
   * One transaction: check the expected version, bump `policy_version` (previous + 1), then append the
   * accepted snapshot to the history with the acting `actor`. A mismatch rolls back, so a concurrent writer
   * can never be silently overwritten and the history always matches the live row.
   */
  async upsertProviderDataPolicy(input: UpsertProviderDataPolicyStoreInput): Promise<ProviderDataPolicyRecord> {
    this.assertValidProviderPolicy(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<ProviderDataPolicyRecord>(
        `SELECT ${providerDataPolicyColumns} FROM provider_data_policies
         WHERE COALESCE(company_id,'')=COALESCE($1,'') AND provider_id=$2 AND COALESCE(model_pattern,'')=COALESCE($3,'')
         FOR UPDATE`,
        [input.companyId, input.providerId, input.modelPattern],
      );
      const existing = current.rows[0] ?? null;
      if (input.expectedPolicyVersion === null && existing) {
        throw new ProviderDataPolicyStoreError("data_policy_revision_conflict", "A policy for this provider already exists", {
          httpStatus: 409, details: { expectedPolicyVersion: null, actualPolicyVersion: existing.policyVersion },
        });
      }
      if (typeof input.expectedPolicyVersion === "number") {
        if (!existing) {
          throw new ProviderDataPolicyStoreError("data_policy_not_found", "No policy to update for this provider", {
            httpStatus: 404, details: { expectedPolicyVersion: input.expectedPolicyVersion },
          });
        }
        if (existing.policyVersion !== input.expectedPolicyVersion) {
          throw new ProviderDataPolicyStoreError(
            "data_policy_revision_conflict",
            "Provider data policy changed by another request. Reload and try again.",
            {
              httpStatus: 409,
              details: { expectedPolicyVersion: input.expectedPolicyVersion, actualPolicyVersion: existing.policyVersion },
            },
          );
        }
      }

      // The mandatory redactions are unioned in, so a row written through this path can never omit them.
      const redactions = [...new Set([...MANDATORY_PROVIDER_REDACTIONS, ...(input.requiredRedactions ?? [])])];
      const contentTypes = [...new Set(input.allowedContentTypes ?? ["metadata"])];
      const result = await client.query<ProviderDataPolicyRecord>(
        `INSERT INTO provider_data_policies
           (id, company_id, provider_id, model_pattern, policy_version, kind, allow_private_repo_code,
            max_data_classification, allow_prompt_caching, external_retention, training_policy, region,
            jurisdiction, required_redactions, allowed_content_types, terms_url, last_reviewed_at, reviewed_by,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),now())
         ON CONFLICT (COALESCE(company_id,''), provider_id, COALESCE(model_pattern,'')) DO UPDATE SET
           kind=EXCLUDED.kind,
           allow_private_repo_code=EXCLUDED.allow_private_repo_code,
           max_data_classification=EXCLUDED.max_data_classification,
           allow_prompt_caching=EXCLUDED.allow_prompt_caching,
           external_retention=EXCLUDED.external_retention,
           training_policy=EXCLUDED.training_policy,
           region=EXCLUDED.region,
           jurisdiction=EXCLUDED.jurisdiction,
           required_redactions=EXCLUDED.required_redactions,
           allowed_content_types=EXCLUDED.allowed_content_types,
           terms_url=EXCLUDED.terms_url,
           last_reviewed_at=EXCLUDED.last_reviewed_at,
           reviewed_by=EXCLUDED.reviewed_by,
           policy_version=provider_data_policies.policy_version+1,
           updated_at=now()
         RETURNING ${providerDataPolicyColumns}`,
        [existing?.id ?? `pdp_${randomUUID()}`, input.companyId, input.providerId, input.modelPattern, input.kind,
          input.allowPrivateRepoCode, input.maxDataClassification, input.allowPromptCaching, input.externalRetention,
          input.trainingPolicy, input.region ?? null, input.jurisdiction ?? null, redactions, contentTypes,
          input.termsUrl ?? null, input.lastReviewedAt ?? null, input.reviewedBy ?? null],
      );
      const record = result.rows[0]!;

      await client.query(
        `INSERT INTO provider_data_policy_versions
           (id, company_id, provider_id, model_pattern, policy_version, payload, actor, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (COALESCE(company_id,''), provider_id, COALESCE(model_pattern,''), policy_version) DO NOTHING`,
        [randomUUID(), record.companyId, record.providerId, record.modelPattern, record.policyVersion,
          JSON.stringify(record), input.actor],
      );

      await client.query("COMMIT");
      return record;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listProviderDataPolicyVersions(
    companyId: string | null,
    providerId?: string,
  ): Promise<ProviderDataPolicyVersionRecord[]> {
    const result = await this.pool.query<ProviderDataPolicyVersionRecord>(
      `SELECT ${providerDataPolicyVersionColumns} FROM provider_data_policy_versions
       WHERE COALESCE(company_id,'')=COALESCE($1,'') AND ($2::text IS NULL OR provider_id=$2)
       ORDER BY policy_version, created_at`,
      [companyId, providerId ?? null],
    );
    return result.rows;
  }

  async getProjectDataPolicy(companyId: string, projectId: string): Promise<ProjectDataPolicyRecord | null> {
    const result = await this.pool.query<ProjectDataPolicyRecord>(
      `SELECT ${projectDataPolicyColumns} FROM code_project_data_policies
       WHERE company_id=$1 AND project_id=$2`,
      [companyId, projectId],
    );
    return result.rows[0] ?? null;
  }

  /** An unconfigured project is `confidential` (never `public`): the default is applied here, on read. */
  async upsertProjectDataPolicy(input: UpsertProjectDataPolicyStoreInput): Promise<ProjectDataPolicyRecord> {
    const current = await this.getProjectDataPolicy(input.companyId, input.projectId);
    if (input.expectedPolicyVersion === null && current) {
      throw new ProviderDataPolicyStoreError("data_policy_revision_conflict", "A project data policy already exists", {
        httpStatus: 409, details: { expectedPolicyVersion: null, actualPolicyVersion: current.policyVersion },
      });
    }
    if (typeof input.expectedPolicyVersion === "number" && current
      && current.policyVersion !== input.expectedPolicyVersion) {
      throw new ProviderDataPolicyStoreError(
        "data_policy_revision_conflict",
        "Project data policy changed by another request. Reload and try again.",
        {
          httpStatus: 409,
          details: { expectedPolicyVersion: input.expectedPolicyVersion, actualPolicyVersion: current.policyVersion },
        },
      );
    }
    const classification = input.dataClassification ?? current?.dataClassification ?? DEFAULT_DATA_CLASSIFICATION;
    if (!isClassificationAtLeast(classification, "public")) {
      throw new ProviderDataPolicyStoreError("invalid_classification", `Unsupported classification: ${String(classification)}`, {
        httpStatus: 400, details: { field: "dataClassification" },
      });
    }
    const pathRules = (input.pathRules ?? current?.pathRules ?? []).map((rule) => this.assertValidPathRule(rule));
    const result = await this.pool.query<ProjectDataPolicyRecord>(
      `INSERT INTO code_project_data_policies
         (company_id, project_id, data_classification, path_rules, policy_version, updated_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,1,$5,now(),now())
       ON CONFLICT (company_id, project_id) DO UPDATE SET
         data_classification=EXCLUDED.data_classification,
         path_rules=EXCLUDED.path_rules,
         updated_by=EXCLUDED.updated_by,
         policy_version=code_project_data_policies.policy_version+1,
         updated_at=now()
       RETURNING ${projectDataPolicyColumns}`,
      [input.companyId, input.projectId, classification, JSON.stringify(pathRules), input.actor],
    );
    return result.rows[0]!;
  }

  /** A rule that could escape the project is refused, never normalised: a normalised escape is still one. */
  private assertValidPathRule(rule: ProjectDataPolicyPathRule): ProjectDataPolicyPathRule {
    const pattern = rule && typeof rule.pattern === "string" ? rule.pattern.trim() : "";
    const escapes = pattern.length === 0 || pattern.startsWith("/") || pattern.startsWith("~")
      || pattern.includes("\\") || pattern.split("/").some((segment) => segment === "..");
    if (escapes) {
      throw new ProviderDataPolicyStoreError(
        "invalid_policy_path_rule",
        `Path rule must stay inside the project: ${String(rule?.pattern)}`,
        { httpStatus: 400, details: { field: "pathRules", pattern: rule?.pattern } },
      );
    }
    if (!isClassificationAtLeast(rule.classification, "public")) {
      throw new ProviderDataPolicyStoreError(
        "invalid_classification",
        `Unsupported classification in path rule: ${String(rule.classification)}`,
        { httpStatus: 400, details: { field: "classification", pattern } },
      );
    }
    return { pattern, classification: rule.classification };
  }

  async grantHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
    grantedBy: string;
    grantedAt: Date;
  }): Promise<ProviderHostedConsentRecord> {
    // A fresh grant clears a previous revocation: consent is explicit, and re-granting is the only way back.
    const result = await this.pool.query<ProviderHostedConsentRecord>(
      `INSERT INTO provider_hosted_consent
         (company_id, project_id, provider_id, granted_by, granted_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,NULL)
       ON CONFLICT (company_id, project_id, provider_id) DO UPDATE SET
         granted_by=EXCLUDED.granted_by, granted_at=EXCLUDED.granted_at, revoked_at=NULL
       RETURNING ${hostedProviderConsentColumns}`,
      [input.companyId, input.projectId, input.providerId, input.grantedBy, input.grantedAt],
    );
    return result.rows[0]!;
  }

  async revokeHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
    revokedAt: Date;
  }): Promise<ProviderHostedConsentRecord> {
    const result = await this.pool.query<ProviderHostedConsentRecord>(
      `UPDATE provider_hosted_consent SET revoked_at=$4
       WHERE company_id=$1 AND project_id=$2 AND provider_id=$3
       RETURNING ${hostedProviderConsentColumns}`,
      [input.companyId, input.projectId, input.providerId, input.revokedAt],
    );
    if (!result.rows[0]) {
      throw new ProviderDataPolicyStoreError("data_policy_not_found", "No hosted provider consent to revoke", {
        httpStatus: 404, details: { providerId: input.providerId },
      });
    }
    return result.rows[0];
  }

  /** The row whatever its state; a caller must treat `revokedAt !== null` as no consent at all. */
  async getHostedProviderConsent(input: {
    companyId: string;
    projectId: string;
    providerId: string;
  }): Promise<ProviderHostedConsentRecord | null> {
    const result = await this.pool.query<ProviderHostedConsentRecord>(
      `SELECT ${hostedProviderConsentColumns} FROM provider_hosted_consent
       WHERE company_id=$1 AND project_id=$2 AND provider_id=$3`,
      [input.companyId, input.projectId, input.providerId],
    );
    return result.rows[0] ?? null;
  }

  // --- C6a: durable Coding Agent run state --------------------------------------------------

  /**
   * Creates the run row already leased by `owner`. `ON CONFLICT DO NOTHING` makes a retried create
   * idempotent: the second call returns the existing row with its cursor and lease untouched, so a
   * duplicated start can never rewind a run or steal its own lease.
   */
  async createCodeRunState(input: CreateCodeRunStateInput): Promise<CodeRunStateRecord> {
    return project.createCodeRunState(this.pool, input);
  }

  /**
   * C10: the run's original request. One extra read for one extra column set — the request text is deliberately
   * kept out of `codeRunStateColumns` so the reaper's and the reconciler's scans (which run every interval over
   * every stale run) never pull prompt content into memory.
   */
  async getCodeRunRequest(companyId: string, runId: string): Promise<CodeRunRequestRecord | null> {
    return project.getCodeRunRequest(this.pool, companyId, runId);
  }

  /**
   * One statement applies the whole patch, including the lease transition:
   *
   * - the `seq` guard (`last_event_seq < $seq`) makes a retried write a no-op, which is what lets the caller
   *   write after every turn without worrying about duplicates;
   * - the lease condition is expressed inside the same `WHERE`, so the check and the write cannot be split by
   *   a concurrent writer. A refused lease transition still lets the non-lease part of the patch land (the
   *   status/cursor of a run we no longer own is still true information), which is why the lease predicate is
   *   written per-mode rather than as an early return.
   */
  async applyCodeRunStateEvent(input: ApplyCodeRunStateEventInput): Promise<CodeRunStateRecord> {
    return project.applyCodeRunStateEvent(this.pool, input);
  }

  async getCodeRunState(companyId: string, runId: string): Promise<CodeRunStateRecord | null> {
    return project.getCodeRunState(this.pool, companyId, runId);
  }

  /**
   * The reconciler's only system-wide read. It returns runs that *claim* to be running with a lease that has
   * expired (or was never taken), which is exactly the set a crashed process leaves behind.
   */
  async listStaleCodeRunStates(input: { now: Date; limit: number }): Promise<CodeRunStateRecord[]> {
    return project.listStaleCodeRunStates(this.pool, input);
  }

  /**
   * C14 (owner decision 3): the tenant-scoped read of run rows the metrics aggregation is built from.
   *
   * Three details are deliberate:
   *
   *   1. **`company_id=$1` is unconditional.** Unlike `listCodeRunStatesForScan` (whose `$1::text IS NULL` is the
   *      reaper's documented system scope) there is no null branch here, so this read cannot be turned into a
   *      cross-tenant scan by passing `null`.
   *   2. **Every other filter is an optional parameter**, so one prepared statement serves "the finished runs of
   *      this tenant", "the runs started since yesterday" and the unbounded first page without a second query
   *      shape that could drift from this one.
   *   3. **It selects existing columns only.** The success rate, the turn counts and the cost come from `status`
   *      and the `details` bag the terminal state already carries; nothing here is a second record of a run.
   */
  async listCodeRunStates(input: ListCodeRunStatesInput): Promise<CodeRunStateRecord[]> {
    return project.listCodeRunStates(this.pool, input);
  }

  /**
   * Records a turn boundary. Tool calls merge by `toolCallId` (the same call re-recorded with a terminal
   * outcome replaces its pending entry), and a stored terminal outcome is never downgraded to
   * `unknown_outcome` — a repeated late write must not turn a known result back into a doubt.
   */
  async upsertCodeRunTurn(input: UpsertCodeRunTurnInput): Promise<CodeRunTurnRecord> {
    const existing = await this.getCodeRunTurn(input.companyId, input.runId, input.turnIndex);
    const merged = mergeCodeRunToolCalls(existing?.toolCalls ?? [], input.toolCalls ?? []);
    const outcome = mergeCodeRunTurnOutcome(existing?.outcome ?? null, input.outcome ?? null);
    const status: CodeRunTurnStatus = input.status === "running" && existing && existing.status !== "running"
      ? existing.status
      : input.status;
    const result = await this.pool.query<CodeRunTurnRecord>(
      `INSERT INTO code_run_turns(
         run_id, company_id, turn_index, status, outcome, tool_calls, messages, results, checkpoint_id,
         started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11)
       ON CONFLICT (run_id, turn_index) DO UPDATE SET
         status = EXCLUDED.status,
         outcome = EXCLUDED.outcome,
         tool_calls = EXCLUDED.tool_calls,
         messages = EXCLUDED.messages,
         results = EXCLUDED.results,
         checkpoint_id = COALESCE(EXCLUDED.checkpoint_id, code_run_turns.checkpoint_id),
         finished_at = COALESCE(EXCLUDED.finished_at, code_run_turns.finished_at)
       RETURNING ${codeRunTurnColumns}`,
      [
        input.runId, input.companyId, input.turnIndex, status, outcome,
        JSON.stringify(merged),
        JSON.stringify(input.messages ?? existing?.messages ?? []),
        JSON.stringify(input.results ?? existing?.results ?? []),
        input.checkpointId ?? existing?.checkpointId ?? null,
        input.startedAt ?? existing?.startedAt ?? new Date(),
        input.finishedAt ?? existing?.finishedAt ?? null,
      ],
    );
    return result.rows[0]!;
  }

  async getCodeRunTurn(companyId: string, runId: string, turnIndex: number): Promise<CodeRunTurnRecord | null> {
    return project.getCodeRunTurn(this.pool, companyId, runId, turnIndex);
  }

  async listCodeRunTurns(companyId: string, runId: string): Promise<CodeRunTurnRecord[]> {
    return project.listCodeRunTurns(this.pool, companyId, runId);
  }

  /**
   * Keyset scan over the run rows, used by the reaper. One row beyond the limit is requested on purpose: it is
   * the only reliable way to know whether a next page exists without a second query, and the extra row is
   * dropped before returning.
   */
  async listCodeRunStatesForScan(input: CodeRunStateScanInput): Promise<CodeRunScanPage<CodeRunStateRecord>> {
    return project.listCodeRunStatesForScan(this.pool, input);
  }

  /**
   * C10 (ТЗ item 7): the projects that own a code session, newest session first. Drives the sandbox-retention
   * sweep, which must be able to find a sandbox that exists on disk while the process remembers nothing about it.
   * The system scope (`companyId: null`) is the same one the run scans use and is only for the reaper. Two ids and
   * a timestamp are selected — never a name, a path or any content.
   */
  async listCodeProjectRefs(input: CodeProjectRefScanInput): Promise<CodeProjectRefScanPage> {
    const limit = clampScanLimit(input.limit);
    const cursor = decodeCodeRunScanCursor(input.cursor);
    const result = await this.pool.query<{ companyId: string; projectId: string; lastSessionAt: Date }>(
      `SELECT company_id AS "companyId", project_id AS "projectId", max(created_at) AS "lastSessionAt"
         FROM code_sessions
        WHERE ($1::text IS NULL OR company_id=$1)
        GROUP BY company_id, project_id
       HAVING ($2::timestamptz IS NULL OR (max(created_at), project_id) < ($2::timestamptz, $3))
        ORDER BY max(created_at) DESC, project_id ASC
        LIMIT $4`,
      [input.companyId, cursor?.startedAt ?? null, cursor?.runId ?? "", limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      items: rows.map((row) => ({
        companyId: row.companyId,
        projectId: row.projectId,
        lastSessionAt: new Date(row.lastSessionAt).toISOString(),
      })),
      nextCursor: result.rows.length > limit && last
        ? encodeCodeRunScanCursor({ startedAt: new Date(last.lastSessionAt).toISOString(), runId: last.projectId, turnIndex: 0 })
        : null,
    };
  }

  /**
   * C10 (ТЗ item 7): one project by ids, without a user context, for the sandbox-retention sweep — which runs as the
   * deployment's system identity and therefore cannot use the `createdBy`-scoped `getProject`. `null` for an unknown
   * or foreign id.
   */
  async getProjectForSystem(companyId: string, projectId: string): Promise<Project | null> {
    return project.getProjectForSystem(this.pool, companyId, projectId);
  }

  /** Keyset scan over the open turns, used by the reaper to find tool calls with no progress. */
  async listCodeRunTurnsForScan(input: CodeRunTurnScanInput): Promise<CodeRunScanPage<CodeRunTurnRecord>> {
    return project.listCodeRunTurnsForScan(this.pool, input);
  }

  // --- C6b: immutable execution snapshots and versioned configuration -------------------------------

  private async insertExecutionSnapshot(record: ExecutionSnapshotRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO execution_snapshots(id, workspace_id, company_id, project_id, session_id, run_id,
         snapshot_version, payload, payload_hash, prev_snapshot_id, prev_payload_hash, "trigger", legacy,
         created_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,
      [record.id, record.workspaceId, record.companyId, record.projectId, record.sessionId, record.runId,
        record.snapshotVersion, JSON.stringify(record.payload), record.payloadHash, record.prevSnapshotId,
        record.prevPayloadHash, record.trigger, record.legacy, record.createdAt, record.createdBy],
    );
  }

  async createExecutionSnapshot(input: CreateExecutionSnapshotInput): Promise<ExecutionSnapshotRecord> {
    const id = input.id ?? randomUUID();
    const attempted = await this.pool.query("SELECT 1 FROM execution_snapshots WHERE id=$1", [id]);
    // A snapshot is evidence: reusing an id would overwrite history, so this is a refusal, not an upsert.
    if (attempted.rowCount) throw new ExecutionSnapshotImmutableError(`create with existing id ${id}`);

    const head = await this.pool.query<{ id: string; payload_hash: string; snapshot_version: number }>(
      `SELECT id, payload_hash, snapshot_version FROM execution_snapshots
        WHERE company_id=$1 AND session_id=$2 ORDER BY snapshot_version DESC LIMIT 1`,
      [input.companyId, input.sessionId],
    );
    const previous = head.rows[0] ?? null;
    const record: ExecutionSnapshotRecord = {
      id,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      snapshotVersion: (previous?.snapshot_version ?? 0) + 1,
      payload: input.payload,
      payloadHash: snapshotPayloadHash(input.payload),
      prevSnapshotId: previous?.id ?? null,
      prevPayloadHash: previous?.payload_hash ?? null,
      trigger: input.trigger,
      legacy: input.legacy === true,
      createdAt: input.now ?? new Date(),
      createdBy: input.createdBy,
    };
    await this.insertExecutionSnapshot(record);
    return record;
  }

  async getExecutionSnapshot(companyId: string, snapshotId: string): Promise<ExecutionSnapshotRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM execution_snapshots WHERE company_id=$1 AND id=$2", [companyId, snapshotId],
    );
    const row = result.rows[0];
    return row ? support.mapExecutionSnapshotRow(row) : null;
  }

  async getLatestSnapshotForSession(companyId: string, sessionId: string): Promise<ExecutionSnapshotRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM execution_snapshots WHERE company_id=$1 AND session_id=$2
        ORDER BY snapshot_version DESC LIMIT 1`, [companyId, sessionId],
    );
    const row = result.rows[0];
    return row ? support.mapExecutionSnapshotRow(row) : null;
  }

  async getSnapshotForRun(companyId: string, runId: string): Promise<ExecutionSnapshotRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM execution_snapshots WHERE company_id=$1 AND run_id=$2
        ORDER BY snapshot_version DESC LIMIT 1`, [companyId, runId],
    );
    const row = result.rows[0];
    return row ? support.mapExecutionSnapshotRow(row) : null;
  }

  async listExecutionSnapshots(input: ListExecutionSnapshotsInput): Promise<ExecutionSnapshotRecord[]> {
    const limit = Math.min(Math.max(input.limit, 1), 500);
    const result = await this.pool.query(
      `SELECT * FROM execution_snapshots
        WHERE company_id=$1 AND ($2::text IS NULL OR session_id=$2) AND ($3::text IS NULL OR project_id=$3)
        ORDER BY created_at DESC LIMIT $4`,
      [input.companyId, input.sessionId ?? null, input.projectId ?? null, limit],
    );
    return result.rows.map((row) => support.mapExecutionSnapshotRow(row));
  }

  diffExecutionSnapshots(a: ExecutionSnapshotRecord, b: ExecutionSnapshotRecord): ExecutionSnapshotDiff {
    const { changes, unchanged } = diffSnapshotPayloads(a.payload, b.payload);
    return {
      fromSnapshotId: a.id, toSnapshotId: b.id,
      fromVersion: a.snapshotVersion, toVersion: b.snapshotVersion,
      changes, unchanged,
    };
  }

  async createSnapshotConfigVersion(input: CreateSnapshotConfigVersionInput): Promise<SnapshotConfigVersionRecord> {
    const existing = await this.findSnapshotConfigVersionByHash(input.companyId, input.kind, input.contentHash);
    // Identical content must reuse its version: a new row per call would make every snapshot point at a
    // different "version" of the same text and destroy the meaning of the number.
    if (existing) return existing;
    const head = await this.pool.query<{ next: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM code_snapshot_config_versions
        WHERE company_id=$1 AND kind=$2`, [input.companyId, input.kind],
    );
    const record: SnapshotConfigVersionRecord = {
      id: input.id ?? `scv_${randomUUID()}`,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      kind: input.kind,
      version: head.rows[0]?.next ?? 1,
      contentHash: input.contentHash,
      content: input.content,
      createdAt: input.now ?? new Date(),
      createdBy: input.createdBy,
    };
    await this.pool.query(
      `INSERT INTO code_snapshot_config_versions(id, workspace_id, company_id, kind, version, content_hash,
         content, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [record.id, record.workspaceId, record.companyId, record.kind, record.version, record.contentHash,
        JSON.stringify(record.content), record.createdAt, record.createdBy],
    );
    return record;
  }

  async getSnapshotConfigVersion(
    companyId: string, kind: SnapshotConfigKind, version: number,
  ): Promise<SnapshotConfigVersionRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM code_snapshot_config_versions WHERE company_id=$1 AND kind=$2 AND version=$3",
      [companyId, kind, version],
    );
    const row = result.rows[0];
    return row ? support.mapSnapshotConfigVersionRow(row) : null;
  }

  async findSnapshotConfigVersionByHash(
    companyId: string, kind: SnapshotConfigKind, contentHash: string,
  ): Promise<SnapshotConfigVersionRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM code_snapshot_config_versions WHERE company_id=$1 AND kind=$2 AND content_hash=$3",
      [companyId, kind, contentHash],
    );
    const row = result.rows[0];
    return row ? support.mapSnapshotConfigVersionRow(row) : null;
  }

  async listSnapshotConfigVersions(companyId: string, kind: SnapshotConfigKind): Promise<SnapshotConfigVersionRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM code_snapshot_config_versions WHERE company_id=$1 AND kind=$2 ORDER BY version DESC",
      [companyId, kind],
    );
    return result.rows.map((row) => support.mapSnapshotConfigVersionRow(row));
  }

  /**
   * C6b: durable Activity events. Append-only — there is deliberately no update or delete method, and the
   * service layer rejects content-like payload keys before calling this (`code-run-activity-sink.ts`).
   */
  async createCodeActivityEvent(input: CreateCodeActivityEventInput): Promise<CodeActivityEventRecord> {
    return project.createCodeActivityEvent(this.pool, input);
  }

  async listCodeActivityEvents(input: ListCodeActivityEventsInput): Promise<CodeActivityEventRecord[]> {
    return project.listCodeActivityEvents(this.pool, input);
  }

  /**
   * C8: a context summary is a derived session artifact, stored append-only (migration 079 refuses UPDATE and
   * DELETE at the database level). `content_hash` is the hash of the exact compacted message list, so the
   * stored row can be tied to reproducible replay input. Defaults are conservative: `confidential` data with a
   * `short` retention, because a summary is derived and outliving its transcript buys nothing.
   */
  async createCodeContextSummary(input: CreateCodeContextSummaryInput): Promise<CodeContextSummaryRecord> {
    return project.createCodeContextSummary(this.pool, input);
  }

  async listCodeContextSummaries(input: ListCodeContextSummariesInput): Promise<CodeContextSummaryRecord[]> {
    return project.listCodeContextSummaries(this.pool, input);
  }

  /**
   * C6b: the bundle header and its ordered steps are written in **one transaction**, so a run never leaves a
   * header claiming steps that are not there. Idempotent by `(run_id, bundle_version)`: a second recording of
   * the same run returns the stored bundle (the unique index is the arbiter, not a pre-read, which would race).
   * Append-only: there is deliberately no update or delete method.
   */
  async createReplayBundle(input: CreateReplayBundleInput): Promise<ReplayBundleRecord> {
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO code_replay_bundles
          (id, workspace_id, company_id, project_id, session_id, run_id, execution_snapshot_id, bundle_version,
           runner_version, system_prompt_version, system_prompt_content_hash, model_profile_version, provider,
           model, replay_mode, source_run_id, source_snapshot_id, terminal_status, terminal_reason, payload,
           payload_hash, replay_input_hash, data_classification, retention_class, created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
         ON CONFLICT (run_id, bundle_version) DO NOTHING
         RETURNING ${replayBundleColumns}`,
        [input.id ?? randomUUID(), input.workspaceId, input.companyId, input.projectId, input.sessionId,
          input.runId, input.executionSnapshotId ?? null, input.bundleVersion, input.runnerVersion ?? null,
          input.systemPromptVersion ?? null, input.systemPromptContentHash ?? null,
          input.modelProfileVersion ?? null, input.provider ?? null, input.model ?? null, input.replayMode,
          input.sourceRunId ?? null, input.sourceSnapshotId ?? null, input.terminalStatus ?? null,
          input.terminalReason ?? null, JSON.stringify(input.payload), input.payloadHash,
          input.replayInputHash, input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
          input.retentionClass ?? DEFAULT_RETENTION_CLASS, now],
      );
      if (!inserted.rowCount) {
        // The bundle already exists: return it instead of appending a second one (idempotency contract).
        await client.query("COMMIT");
        const existing = await this.getReplayBundle(input.companyId, input.runId, input.bundleVersion);
        if (existing) return existing;
        throw new WorkspaceAccessError("Replay bundle conflict");
      }
      const bundle = support.mapReplayBundleRow(inserted.rows[0]!);
      let seq = 0;
      for (const step of input.steps) {
        seq += 1;
        await client.query(
          `INSERT INTO code_replay_bundle_steps
            (id, bundle_id, company_id, seq, kind, turn_index, tool_call_id, payload, payload_hash, created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT DO NOTHING`,
          [step.id ?? randomUUID(), bundle.id, input.companyId, seq, step.kind, step.turnIndex,
            step.toolCallId ?? null, JSON.stringify(step.payload), step.payloadHash, step.createdAt ?? now],
        );
      }
      await client.query("COMMIT");
      return bundle;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getReplayBundle(companyId: string, runId: string, bundleVersion?: number): Promise<ReplayBundleRecord | null> {
    const result = await this.pool.query(
      `SELECT ${replayBundleColumns} FROM code_replay_bundles
        WHERE company_id=$1 AND run_id=$2 AND ($3::integer IS NULL OR bundle_version=$3)
        ORDER BY bundle_version DESC LIMIT 1`,
      [companyId, runId, bundleVersion ?? null],
    );
    const row = result.rows[0];
    return row ? support.mapReplayBundleRow(row) : null;
  }

  /**
   * C6b: by-id read, tenant-scoped. A replay status endpoint and the UI address a replay by its own id, so the
   * store answers that directly instead of forcing each caller to query `code_replay_bundles` itself.
   */
  async getReplayBundleById(companyId: string, bundleId: string): Promise<ReplayBundleRecord | null> {
    const result = await this.pool.query(
      `SELECT ${replayBundleColumns} FROM code_replay_bundles WHERE company_id=$1 AND id=$2 LIMIT 1`,
      [companyId, bundleId],
    );
    const row = result.rows[0];
    return row ? support.mapReplayBundleRow(row) : null;
  }

  async listReplayBundles(input: ListReplayBundlesInput): Promise<ReplayBundleRecord[]> {    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const result = await this.pool.query(
      `SELECT ${replayBundleColumns} FROM code_replay_bundles
        WHERE company_id=$1
          AND ($2::text IS NULL OR run_id=$2)
          AND ($3::text IS NULL OR session_id=$3)
          AND ($4::text IS NULL OR execution_snapshot_id=$4)
        ORDER BY created_at DESC, id DESC LIMIT $5`,
      [input.companyId, input.runId ?? null, input.sessionId ?? null, input.executionSnapshotId ?? null, limit],
    );
    return result.rows.map((row) => support.mapReplayBundleRow(row));
  }

  async listReplayBundleSteps(companyId: string, bundleId: string): Promise<ReplayBundleStepRecord[]> {
    const result = await this.pool.query(
      `SELECT ${replayBundleStepColumns} FROM code_replay_bundle_steps
        WHERE company_id=$1 AND bundle_id=$2 ORDER BY seq ASC`,
      [companyId, bundleId],
    );
    return result.rows.map((row) => support.mapReplayBundleStepRow(row));
  }

  // --- R1-C (items 11–13): retention and erasure ------------------------------------------------------

  /**
   * The data-lifecycle port. It is a getter rather than a set of methods on the store so that the port's
   * surface is exactly what the reaper and the erasure service are allowed to call: a caller cannot reach
   * `this.pool` through it, and a future backend without the capability simply has no member here.
   */
  private readonly codeDataLifecyclePort: CodeDataLifecycleStore = {
    planCodeDataRetention: (input) => this.planCodeDataRetention(input),
    eraseCodeData: (input) => this.eraseCodeData(input),
  };

  /**
   * Counts — and, unless this is a dry run, deletes — the code rows of one Company whose **own**
   * `retention_class` names a window they have outlived.
   *
   * Two properties are load-bearing:
   *
   *  1. **Nothing is inferred.** The eligible tables are `CODE_RETENTION_FAMILIES`; a table that is missing
   *     from the frozen identifier maps throws (`code_data_lifecycle_table_unmapped`) instead of silently
   *     contributing nothing, so adding a family to the vocabulary cannot half-work.
   *  2. **The append-only evidence is counted, never deleted, and reported as retained.** A retention pass
   *     that reported zero for `execution_snapshots` would be indistinguishable from one that had purged it;
   *     the `retained` count plus its reason is what makes the difference visible in the reaper's metrics.
   *
   * The count and the delete happen in one transaction, so an insert between them cannot make `purged`
   * disagree with what was measured.
   */
  private async planCodeDataRetention(input: {
    companyId?: string;
    windows: CodeRetentionWindows;
    now: Date;
    dryRun: boolean;
  }): Promise<CodeDataRetentionReport> {
    const client = await this.pool.connect();
    const families: CodeDataFamilyOutcome[] = [];
    /**
     * The tenant filter is part of every statement, not of a suffix a caller may forget: `$1` is either a
     * Company id or `NULL` (the reaper's cross-tenant sweep), and `($1::text IS NULL OR …)` makes the two
     * spellings one statement. Retention never runs without a tenant predicate, so a sweep cannot be widened
     * into "every tenant's rows are one tenant's".
     */
    const tenant = input.companyId ?? null;
    const windowParams = () => [
      tenant,
      input.windows.ephemeralDays,
      input.windows.toolResultDays,
      input.windows.transcriptDays,
      input.windows.extendedDays,
      input.now,
      [...EXPIRABLE_RETENTION_CLASSES],
    ];
    try {
      await client.query("BEGIN");
      for (const family of CODE_RETENTION_FAMILIES) {
        const mappedFrom = RETENTION_FROM[family.table];
        const mappedAge = RETENTION_AGE_COLUMN[family.table];
        if (!mappedFrom || !mappedAge) {
          throw new CodeRunStateStoreError("code_data_lifecycle_table_unmapped", `No retention SQL is mapped for ${family.table}`);
        }
        const from = assertSqlFragment(mappedFrom, `FROM clause for ${family.table}`);
        const ageColumn = assertSqlFragment(mappedAge, `age column for ${family.table}`);
        const extra = RETENTION_EXTRA_PREDICATE[family.table];
        const where =
          `($1::text IS NULL OR t.company_id=$1) AND ${ageColumn} < ${RETENTION_WINDOW_EXPR}` +
          ` AND t.retention_class = ANY($7::text[])` +
          // The shared-table guard is part of the same statement as the delete, never a separate lookup: a
          // checkpoint is only ever expired together with the proof that its project is a code project.
          (extra ? ` AND ${extra}` : "");
        const params = windowParams();
        const counted = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${from} WHERE ${where}`, params);
        const expired = Number(counted.rows[0]?.n ?? 0);
        let purged = 0;
        if (!input.dryRun && expired > 0) {
          const removed = await client.query(`DELETE FROM ${from} WHERE ${where}`, params);
          purged = removed.rowCount ?? 0;
        }
        families.push({ table: family.table, scope: family.scope, expired, purged, retained: 0 });
      }
      const retainedFamilies: CodeDataFamilyOutcome[] = [];
      for (const family of CODE_APPEND_ONLY_EVIDENCE_FAMILIES) {
        // The row's own age rule, exactly as for the erasable families — the only difference is that the
        // matching rows are **counted and kept**, and the count is reported as `retained` with its reason so a
        // pass can never look like a clean sweep of evidence it is forbidden to delete.
        const mappedFrom = APPEND_ONLY_COUNTABLE[family.table];
        const mappedAge = APPEND_ONLY_AGE_COLUMN[family.table];
        if (!mappedFrom || !mappedAge) {
          // A recording whose steps have no timestamp of their own is counted through its header, and its own
          // entry says so with the same reason instead of inventing a number.
          retainedFamilies.push({
            table: family.table,
            scope: family.scope,
            expired: 0,
            purged: 0,
            retained: 0,
            ...(family.retentionRefusal ? { retainedReason: family.retentionRefusal } : {}),
          });
          continue;
        }
        const from = assertSqlFragment(mappedFrom, `FROM clause for ${family.table}`);
        const ageColumn = assertSqlFragment(mappedAge, `age column for ${family.table}`);
        const where =
          `($1::text IS NULL OR t.company_id=$1) AND ${ageColumn} < ${RETENTION_WINDOW_EXPR}` +
          ` AND t.retention_class = ANY($7::text[])`;
        const counted = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${from} WHERE ${where}`, windowParams());
        const matched = Number(counted.rows[0]?.n ?? 0);
        retainedFamilies.push({
          table: family.table,
          scope: family.scope,
          expired: matched,
          purged: 0,
          retained: matched,
          ...(family.retentionRefusal ? { retainedReason: family.retentionRefusal } : {}),
        });
      }
      await client.query("COMMIT");
      const all = [...families, ...retainedFamilies];
      return {
        companyId: input.companyId ?? "*",
        windows: input.windows,
        families: all,
        expired: all.reduce((sum, entry) => sum + entry.expired, 0),
        purged: all.reduce((sum, entry) => sum + entry.purged, 0),
        retained: all.reduce((sum, entry) => sum + entry.retained, 0),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The data-lifecycle port, or `undefined` when this backend cannot delete code data. */
  get codeDataLifecycle(): CodeDataLifecycleStore | undefined {
    return this.codeDataLifecyclePort;
  }

  /**
   * Forgets one session's — or one whole code project's — data, then reads back what remains.
   *
   * The sequence is deliberate: **delete, then verify, in the same transaction**, so the `remaining` numbers
   * are a measurement of the state the erasure left behind rather than of a later one. `verified` is
   * `outstanding.length === 0`, and `outstanding` is computed from those measurements, so a caller cannot
   * report success over a family that still holds rows.
   *
   * Scope: only the code tables and only the caller's Company. The shared `projects` table is read (to answer
   * "was this a code project, and is it still there?") and, for `kind: "project"`, deleted — which is the
   * existing `deleteProject` semantics the lifecycle route already uses, including its cascade. No NPATI table
   * outside the code surface is touched.
   */
  private async eraseCodeData(input: {
    companyId: string;
    target: CodeDataErasureTarget;
  }): Promise<CodeDataErasureReport> {
    const target = input.target;
    const key = target.kind === "session" ? target.sessionId : target.projectId;
    const client = await this.pool.connect();
    const families: CodeDataErasureOutcome[] = [];
    const preserved: Array<{ table: string; reason: string }> = [];
    try {
      await client.query("BEGIN");
      /**
       * The project the project-scoped families are keyed by. For a session it is the session's own project —
       * a checkpoint belongs to the project, so "everything of this session" includes the checkpoints taken
       * while it ran. When the session row is already gone (a repeated erasure, which must stay idempotent) the
       * project-scoped families are skipped rather than guessed.
       */
      let projectId: string | undefined = target.kind === "project" ? target.projectId : target.projectId;
      if (target.kind === "session") {
        const session = await client.query<{ project_id: string }>(
          "SELECT project_id FROM code_sessions WHERE company_id=$1 AND id=$2",
          [input.companyId, target.sessionId],
        );
        if ((session.rowCount ?? 0) > 0) projectId = session.rows[0]!.project_id;
      }
      const projectScoped = target.kind === "project";
      /**
       * The statement shape this erasure uses: a session names a session id, a project names a project id.
       * `projectId` is undefined only when the named session could not be resolved, which the loop below turns
       * into "skip the project-scoped families" rather than "delete from every project".
       */
      const scopeKey = projectScoped ? projectId : key;
      const predicateSet = projectScoped ? ERASE_PROJECT_SCOPE_PREDICATE : ERASE_SCOPE_PREDICATE;
      // Serialize against process admission before deleting either session or project content.
      const processRows = await client.query("SELECT project_id,state FROM code_process_projects WHERE company_id=$1 AND ($2::text IS NULL OR project_id=$2) FOR UPDATE", [input.companyId, projectId ?? null]);
      for (const row of processRows.rows) {
        const targeted = row.state.operations.filter((op: { sessionId: string; child?: { sessionId?: string } }) => projectScoped || op.sessionId === key || op.child?.sessionId === key);
        if (row.state.cleanupToken || targeted.some((op: { state: string }) => ["accepted","preparing","dispatching","running","interrupted","unknown_outcome"].includes(op.state))) throw new CodeRunStateStoreError("process_cleanup_blocked", "Settle tracked producers before erasing their workspace");
      }
      for (const family of CODE_RETENTION_FAMILIES) {
        if (family.table === "code_process_projects" && !projectScoped) {
          let purged = 0;
          for (const row of processRows.rows) {
            const kept = row.state.operations.filter((op: { sessionId: string }) => op.sessionId !== key);
            purged += row.state.operations.length - kept.length;
            await client.query("UPDATE code_process_projects SET state=$3 WHERE company_id=$1 AND project_id=$2", [input.companyId, row.project_id, { ...row.state, operations: kept }]);
          }
          families.push({ table: family.table, scope: family.scope, expired: purged, purged, retained: 0, remaining: 0 });
          continue;
        }
        const boundKey = family.scope === "project" && !projectScoped ? projectId : scopeKey;
        // A project-scoped family with no known project is not this erasure's business: skipping it is what
        // keeps a repeated session erasure from deleting every checkpoint of a project it cannot identify.
        if (boundKey === undefined) continue;
        const mappedTable = ERASE_FROM[family.table];
        const mappedPredicate = predicateSet[family.table];
        if (!mappedTable || !mappedPredicate) {
          throw new CodeRunStateStoreError("code_data_lifecycle_table_unmapped", `No erasure SQL is mapped for ${family.table}`);
        }
        const table = assertSqlFragment(mappedTable, `table for ${family.table}`);
        const predicate = assertSqlFragment(mappedPredicate, `scope predicate for ${family.table}`);
        const removed = await client.query(`DELETE FROM ${table} WHERE ${predicate}`, [input.companyId, boundKey]);
        // Read back in the same transaction: this is the measurement the report's `verified` is computed from.
        const left = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${table} WHERE ${predicate}`, [input.companyId, boundKey]);
        families.push({
          table: family.table,
          scope: family.scope,
          expired: removed.rowCount ?? 0,
          purged: removed.rowCount ?? 0,
          retained: 0,
          remaining: Number(left.rows[0]?.n ?? 0),
        });
      }
      // The session rows themselves. For a session erasure the targeted session is deleted **after** the
      // families above, because several of their predicates reach the run rows through `code_run_states` —
      // deleting it first would leave those rows unreachable and therefore unverified. For a project erasure
      // every session of the project goes: a project whose sessions survived would still answer a session list,
      // and "the project's data is gone" would be false in the one place a caller looks first. The cascade from
      // `code_sessions` removes the heads and goals that have a foreign key to it; the rest were erased above.
      const sessionsRemoved = target.kind === "session"
        ? await client.query("DELETE FROM code_sessions WHERE company_id=$1 AND id=$2 RETURNING id", [input.companyId, key])
        : await client.query("DELETE FROM code_sessions WHERE company_id=$1 AND project_id=$2 RETURNING id", [input.companyId, target.projectId]);
      // A session-scoped approval rule is a reference, not content: the binding is cleared so the rule stops
      // pointing at a session that no longer exists, and the project's policy survives.
      if (target.kind === "session") {
        for (const reference of Object.values(ERASE_CLEAR_SESSION_REFERENCE)) {
          await client.query(
            `UPDATE ${assertSqlFragment(reference.table, "reference table")} SET ${assertSqlFragment(reference.column, "reference column")}=NULL` +
            " WHERE company_id=$1 AND " + `${assertSqlFragment(reference.column, "reference column")}=$2`,
            [input.companyId, key],
          );
        }
      }
      /**
       * The rest of a whole project's code-owned rows. They are erased **after** the families, because their
       * predicates are independent of the run/turn subqueries, and each one is read back so the answer's
       * `outstanding` covers them: a project erasure that left its approval rules or its mount confirmation
       * behind would be a partial erasure reported as a complete one.
       */
      if (projectScoped) {
        for (const name of PROJECT_SCOPED_ERASE_TABLES) {
          const table = assertSqlFragment(name, "project-scoped table");
          const predicate = assertSqlFragment("company_id=$1 AND project_id=$2", "project-scoped predicate");
          const removed = await client.query(`DELETE FROM ${table} WHERE ${predicate}`, [input.companyId, key]);
          const left = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${table} WHERE ${predicate}`, [input.companyId, key]);
          families.push({
            table,
            scope: "project",
            expired: removed.rowCount ?? 0,
            purged: removed.rowCount ?? 0,
            retained: 0,
            remaining: Number(left.rows[0]?.n ?? 0),
          });
        }
      }
      // The append-only evidence is named in the report on purpose: a caller must be able to see that the
      // erasure was complete for the erasable data **and** that this evidence was deliberately not part of it.
      for (const family of CODE_APPEND_ONLY_EVIDENCE_FAMILIES) {
        preserved.push({ table: family.table, reason: family.retentionRefusal ?? "append_only_evidence" });
      }
      await client.query("COMMIT");
      /**
       * The session rows are part of the measurement too. A session erasure names one session and a project
       * erasure names all of its sessions, and a project whose session rows survived would still answer a
       * session list — so "nothing left" has to include them or the verification would be narrower than the
       * erasure it is supposed to prove.
       */
      const sessionsLeft = await client.query<{ n: string }>(
        "SELECT count(*)::bigint AS n FROM code_sessions WHERE company_id=$1 AND " +
          (target.kind === "session" ? "id=$2" : "project_id=$2"),
        [input.companyId, key],
      );
      const outstanding = families.filter((entry) => entry.remaining > 0).map((entry) => entry.table);
      if (Number(sessionsLeft.rows[0]?.n ?? 0) > 0) outstanding.push("code_sessions");
      return {
        companyId: input.companyId,
        target,
        families,
        erased: families.reduce((sum, entry) => sum + entry.purged, 0) + (sessionsRemoved.rowCount ?? 0),
        outstanding,
        preserved,
        verified: outstanding.length === 0,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
