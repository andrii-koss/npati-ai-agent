import { randomUUID } from "node:crypto";
import { assertNoSecrets } from "@npati/memory";
import { Pool } from "pg";
import migration001 from "./migration-001";
import migration002 from "./migration-002";
import migration003 from "./migration-003";
import type { AuthContext, Business, BusinessInput, BusinessOnboardingSession, BusinessToCompanyInput, Company, CompanyAgent, CompanyAgentEdge, CompanyAgentInput, CompanyAgentRun, CompanyAgentRunEvent, CompanyAgentRunStep, CompanyAgentToolAudit, CompanyInput, Project, ProjectCheckpoint, CreateCheckpointInput, ProjectInput, ProjectStatus, Conversation, ConversationMessage, Goal, GoalInput, MemoryInput, MemoryItem, OnboardingScenario, WorkspaceOverview, WorkspaceStore } from "./types";
import { WorkspaceAccessError, WorkspaceNotFoundError } from "./types";
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
  last_build_status AS "lastBuildStatus", revision, created_at AS "createdAt", updated_at AS "updatedAt"`;
const projectCheckpointColumns = `id, workspace_id AS "workspaceId", company_id AS "companyId",
  project_id AS "projectId", user_id AS "userId", name, description, commit_hash AS "commitHash",
  trigger, run_id AS "runId", file_count AS "fileCount", created_at AS "createdAt"`;
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
      (id,workspace_id,company_id,created_by,name,description,type,create_request_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (workspace_id,company_id,created_by,create_request_key) DO NOTHING
      RETURNING ${projectColumns}`,
      [randomUUID(),context.workspaceId,companyId,context.userId,input.name,input.description ?? null,input.type,idempotencyKey]);
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

  async updateProject(context: AuthContext, companyId: string, projectId: string, input: { name: string; expectedRevision: number }) {
    await this.getProject(context, companyId, projectId);
    const result = await this.pool.query<Project>(`UPDATE projects
      SET name=$5, revision=revision+1, updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4
        AND revision=$6 AND status<>'archived' RETURNING ${projectColumns}`,
      [projectId,context.workspaceId,companyId,context.userId,input.name,input.expectedRevision]);
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
  async updateProjectPreview(context: AuthContext, companyId: string, projectId: string, patch: { status?: ProjectStatus; previewUrl?: string | null; previewPort?: number | null; framework?: string | null; runtime?: string | null; lastBuildStatus?: string | null }) {
    const current = await this.getProject(context, companyId, projectId);
    const status = patch.status ?? current.status;
    const previewUrl = patch.previewUrl !== undefined ? patch.previewUrl : (current.previewUrl ?? null);
    const previewPort = patch.previewPort !== undefined ? patch.previewPort : (current.previewPort ?? null);
    const framework = patch.framework !== undefined ? patch.framework : (current.framework ?? null);
    const runtime = patch.runtime !== undefined ? patch.runtime : (current.runtime ?? null);
    const lastBuildStatus = patch.lastBuildStatus !== undefined ? patch.lastBuildStatus : (current.lastBuildStatus ?? null);
    const result = await this.pool.query<Project>(`UPDATE projects
      SET status=$5, preview_url=$6, preview_port=$7, framework=$8, runtime=$9, last_build_status=$10, revision=revision+1, updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4 AND status<>'archived'
      RETURNING ${projectColumns}`,
      [projectId, context.workspaceId, companyId, context.userId, status, previewUrl, previewPort, framework, runtime, lastBuildStatus]);
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
      completed_at=CASE WHEN ($5::jsonb->>'status') IN ('completed','failed','cancelled') THEN now() ELSE completed_at END,
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
