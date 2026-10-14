import { Pool } from "pg";
import migration001 from "./migration-001";
import migration002 from "./migration-002";
import migration003 from "./migration-003";
import migration004 from "./migration-004";
import migration005 from "./migration-005";
import migration006 from "./migration-006";
import migration007 from "./migration-007";
import migration008 from "./migration-008";
import migration009 from "./migration-009";
import migration010 from "./migration-010";
import migration011 from "./migration-011";
import migration012 from "./migration-012";
import migration013 from "./migration-013";
import migration014 from "./migration-014";
import migration015 from "./migration-015";
import migration016 from "./migration-016";
import migration017 from "./migration-017";
import migration030 from "./migration-030";

export async function runPostgresMigrationsEarly(pool: Pool): Promise<void> {
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const [version, sql] of [["001_business_workspace", migration001], ["002_conversational_onboarding", migration002], ["003_conversation_titles", migration003]] as const) {
      const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
      if (applied.rowCount) continue;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const userSettingsMigration = await pool.query(`SELECT 1 FROM schema_migrations WHERE version='004_workspace_user_settings'`);
    if (!userSettingsMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration004);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('004_workspace_user_settings') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const companyMigration = await pool.query(`SELECT 1 FROM schema_migrations WHERE version='005_company_model'`);
    if (!companyMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration005);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('005_company_model') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const separateCompanyMigration = await pool.query(`SELECT 1 FROM schema_migrations WHERE version='006_separate_companies_agents'`);
    if (!separateCompanyMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration006);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('006_separate_companies_agents') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const companyRuntimeMigration = await pool.query(`SELECT 1 FROM schema_migrations WHERE version='007_company_agent_runtime'`);
    if (!companyRuntimeMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration007);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('007_company_agent_runtime') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const runtimeHistoryMigration = await pool.query(`SELECT 1 FROM schema_migrations WHERE version='008_company_runtime_history'`);
    if (!runtimeHistoryMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration008);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('008_company_runtime_history') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const backgroundRunsMigration = await pool.query(`SELECT 1 FROM schema_migrations WHERE version='009_company_background_runs'`);
    if (!backgroundRunsMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration009);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('009_company_background_runs') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const backgroundAuditMigration = await pool.query(`SELECT 1 FROM schema_migrations WHERE version='030_company_background_run_events'`);
    if (!backgroundAuditMigration.rowCount) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query(migration030); await client.query(`INSERT INTO schema_migrations(version) VALUES ('030_company_background_run_events') ON CONFLICT DO NOTHING`); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    await pool.query("ALTER TABLE company_agent_runs ADD COLUMN IF NOT EXISTS context_snapshot jsonb").catch(() => undefined);
    const fileStorageMigration = await pool.query(`SELECT 1 FROM schema_migrations WHERE version='010_central_file_metadata'`);
    if (!fileStorageMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration010);
        await client.query(`INSERT INTO schema_migrations(version) VALUES ('010_central_file_metadata') ON CONFLICT DO NOTHING`);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const fileLifecycleMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='011_chat_file_lifecycle'");
    if (!fileLifecycleMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration011);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('011_chat_file_lifecycle') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const fileBusinessLifecycleMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='012_file_business_lifecycle'");
    if (!fileBusinessLifecycleMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration012);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('012_file_business_lifecycle') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const storageProtectionMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='013_storage_protection'");
    if (!storageProtectionMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(migration013);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('013_storage_protection') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const companyKnowledgeMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='014_company_knowledge'");
    if (!companyKnowledgeMigration.rowCount) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query(migration014); await client.query("INSERT INTO schema_migrations(version) VALUES ('014_company_knowledge') ON CONFLICT DO NOTHING"); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const companyAutomationsMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='015_company_automations'");
    if (!companyAutomationsMigration.rowCount) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query(migration015); await client.query("INSERT INTO schema_migrations(version) VALUES ('015_company_automations') ON CONFLICT DO NOTHING"); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const companyApprovalsMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='016_company_approvals'");
    if (!companyApprovalsMigration.rowCount) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query(migration016); await client.query("INSERT INTO schema_migrations(version) VALUES ('016_company_approvals') ON CONFLICT DO NOTHING"); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const companyWebhooksMcpMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='017_webhooks_and_mcp'");
    if (!companyWebhooksMcpMigration.rowCount) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query(migration017); await client.query("INSERT INTO schema_migrations(version) VALUES ('017_webhooks_and_mcp') ON CONFLICT DO NOTHING"); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const auditUsageMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='018_audit_and_usage'");
    if (!auditUsageMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration018 } = await import("./migration-018");
        await runMigration018(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('018_audit_and_usage') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const apiKeysMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='019_api_keys_and_encryption'");
    if (!apiKeysMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration019 } = await import("./migration-019");
        await runMigration019(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('019_api_keys_and_encryption') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const groupSessionsMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='020_group_sessions'");
    if (!groupSessionsMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration020 } = await import("./migration-020");
        await runMigration020(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('020_group_sessions') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const oauthTokensMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='021_oauth_refresh_tokens'");
    if (!oauthTokensMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration021 } = await import("./migration-021");
        await runMigration021(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('021_oauth_refresh_tokens') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const channelPairingsMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='022_channel_pairings'");
    if (!channelPairingsMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration022 } = await import("./migration-022");
        await runMigration022(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('022_channel_pairings') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const scopedMemoriesMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='023_scoped_memories'");
    if (!scopedMemoriesMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration023 } = await import("./migration-023");
        await runMigration023(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('023_scoped_memories') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const webhooksMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='024_webhook_subscriptions'");
    if (!webhooksMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration024 } = await import("./migration-024");
        await runMigration024(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('024_webhook_subscriptions') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const hybridRetrievalMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='025_hybrid_retrieval_fts'");
    if (!hybridRetrievalMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration025 } = await import("./migration-025");
        await runMigration025(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('025_hybrid_retrieval_fts') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const productionScopedMemoryMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='026_production_scoped_memory'");
    if (!productionScopedMemoryMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration026 } = await import("./migration-026");
        await runMigration026(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('026_production_scoped_memory') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const guardrailPoliciesMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='027_company_guardrail_policies'");
    if (!guardrailPoliciesMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration027 } = await import("./migration-027");
        await runMigration027(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('027_company_guardrail_policies') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const durableApprovalsMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='028_durable_approvals'");
    if (!durableApprovalsMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration028 } = await import("./migration-028");
        await runMigration028(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('028_durable_approvals') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const unifiedTelemetryMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='029_unified_telemetry'");
    if (!unifiedTelemetryMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration029 } = await import("./migration-029");
        await runMigration029(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('029_unified_telemetry') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const apiKeyDevicesMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='031_api_key_devices'");
    if (!apiKeyDevicesMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration031 } = await import("./migration-031");
        await runMigration031(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('031_api_key_devices') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const apiKeyHardeningMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='032_api_key_auth_hardening'");
    if (!apiKeyHardeningMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration032 } = await import("./migration-032");
        await runMigration032(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('032_api_key_auth_hardening') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const durableMemoryFeaturesMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='033_durable_memory_features'");
    if (!durableMemoryFeaturesMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration033 } = await import("./migration-033");
        await runMigration033(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('033_durable_memory_features') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const advancedMemoryMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='034_advanced_memory_runtime'");
    if (!advancedMemoryMigration.rowCount) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const { runMigration034 } = await import("./migration-034"); await runMigration034(client); await client.query("INSERT INTO schema_migrations(version) VALUES ('034_advanced_memory_runtime') ON CONFLICT DO NOTHING"); await client.query('COMMIT'); }
      catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
    }
    const memoryImportMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='035_memory_engines_import'");
    if (!memoryImportMigration.rowCount) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const { runMigration035 } = await import("./migration-035"); await runMigration035(client); await client.query("INSERT INTO schema_migrations(version) VALUES ('035_memory_engines_import') ON CONFLICT DO NOTHING"); await client.query('COMMIT'); }
      catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
    }
    const neutralConversationMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='036_neutral_conversations'");
    if (!neutralConversationMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration036 } = await import("./migration-036");
        await runMigration036(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('036_neutral_conversations') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const emailInboxMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='037_email_ai_inbox'");
    if (!emailInboxMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration037 } = await import("./migration-037");
        await runMigration037(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('037_email_ai_inbox') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const emailInboxRuntimeMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='038_email_ai_inbox_runtime'");
    if (!emailInboxRuntimeMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration038 } = await import("./migration-038");
        await runMigration038(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('038_email_ai_inbox_runtime') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const emailOauthMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='039_email_oauth_states'");
    if (!emailOauthMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration039 } = await import("./migration-039");
        await runMigration039(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('039_email_oauth_states') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const personalEmailMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='040_personal_email_scope'");
    if (!personalEmailMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration040 } = await import("./migration-040");
        await runMigration040(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('040_personal_email_scope') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
}
