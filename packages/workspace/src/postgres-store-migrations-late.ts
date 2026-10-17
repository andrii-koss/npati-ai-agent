import { Pool } from "pg";
import type { AuthContext } from "./types";
import { ensureIdentity } from "./postgres-store-support";

export async function runPostgresMigrationsLatePart1(pool: Pool, context?: AuthContext): Promise<void> {
    const deletedEmailMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='041_email_deleted_messages'");
    if (!deletedEmailMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration041 } = await import("./migration-041");
        await runMigration041(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('041_email_deleted_messages') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const deletedEmailTypeFix = await pool.query("SELECT 1 FROM schema_migrations WHERE version='042_email_deleted_messages_workspace_type'");
    if (!deletedEmailTypeFix.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration042 } = await import("./migration-042");
        await runMigration042(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('042_email_deleted_messages_workspace_type') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const browserCredentialVault = await pool.query("SELECT 1 FROM schema_migrations WHERE version='043_browser_credential_vault'");
    if (!browserCredentialVault.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration043 } = await import("./migration-043");
        await runMigration043(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('043_browser_credential_vault') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const browserCampaignTargets = await pool.query("SELECT 1 FROM schema_migrations WHERE version='044_browser_campaign_targets'");
    if (!browserCampaignTargets.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration044 } = await import("./migration-044");
        await runMigration044(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('044_browser_campaign_targets') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const messagingConnections = await pool.query("SELECT 1 FROM schema_migrations WHERE version='045_messaging_connections'");
    if (!messagingConnections.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration045 } = await import("./migration-045");
        await runMigration045(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('045_messaging_connections') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const messagingScopes = await pool.query("SELECT 1 FROM schema_migrations WHERE version='046_messaging_connection_scopes'");
    if (!messagingScopes.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration046 } = await import("./migration-046");
        await runMigration046(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('046_messaging_connection_scopes') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const messagingSessions = await pool.query("SELECT 1 FROM schema_migrations WHERE version='047_messaging_sessions_and_dedup'");
    if (!messagingSessions.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration047 } = await import("./migration-047");
        await runMigration047(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('047_messaging_sessions_and_dedup') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const messagingSettings = await pool.query("SELECT 1 FROM schema_migrations WHERE version='048_messaging_connection_settings'");
    if (!messagingSettings.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration048 } = await import("./migration-048");
        await runMigration048(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('048_messaging_connection_settings') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    if (context) await ensureIdentity(pool, context);
    const whatsappProviders = await pool.query("SELECT 1 FROM schema_migrations WHERE version='049_whatsapp_providers'");
    if (!whatsappProviders.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration049 } = await import("./migration-049");
        await runMigration049(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('049_whatsapp_providers') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const whatsappSelfChat = await pool.query("SELECT 1 FROM schema_migrations WHERE version='050_whatsapp_self_chat'");
    if (!whatsappSelfChat.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration050 } = await import("./migration-050");
        await runMigration050(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('050_whatsapp_self_chat') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const discordSettings = await pool.query("SELECT 1 FROM schema_migrations WHERE version='051_discord_integration'");
    if (!discordSettings.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration051 } = await import("./migration-051");
        await runMigration051(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('051_discord_integration') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const slackSettings = await pool.query("SELECT 1 FROM schema_migrations WHERE version='052_slack_integration'");
    if (!slackSettings.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration052 } = await import("./migration-052");
        await runMigration052(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('052_slack_integration') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const emailGateway = await pool.query("SELECT 1 FROM schema_migrations WHERE version='053_email_gateway'");
    if (!emailGateway.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration053 } = await import("./migration-053");
        await runMigration053(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('053_email_gateway') ON CONFLICT DO NOTHING");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }

    const projectFoundation = await pool.query("SELECT 1 FROM schema_migrations WHERE version='054_project_foundation'");
    if (!projectFoundation.rowCount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { runMigration054 } = await import("./migration-054");
        await runMigration054(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('054_project_foundation')");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const projectTerminal = await pool.query("SELECT 1 FROM schema_migrations WHERE version='055_project_terminal'");
    if (!projectTerminal.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration055 } = await import("./migration-055");
        await runMigration055(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('055_project_terminal')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const projectCheckpoints = await pool.query("SELECT 1 FROM schema_migrations WHERE version='056_project_checkpoints'");
    if (!projectCheckpoints.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration056 } = await import("./migration-056");
        await runMigration056(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('056_project_checkpoints')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const projectDeployments = await pool.query("SELECT 1 FROM schema_migrations WHERE version='057_project_deployments'");
    if (!projectDeployments.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration057 } = await import("./migration-057");
        await runMigration057(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('057_project_deployments')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const projectQaReports = await pool.query("SELECT 1 FROM schema_migrations WHERE version='058_project_qa_reports'");
    if (!projectQaReports.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration058 } = await import("./migration-058");
        await runMigration058(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('058_project_qa_reports')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const approvalPause = await pool.query("SELECT 1 FROM schema_migrations WHERE version='059_company_approval_pause'");
    if (!approvalPause.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration059 } = await import("./migration-059");
        await runMigration059(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('059_company_approval_pause')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const dataStudioMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='060_data_backends'");
    if (!dataStudioMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration060 } = await import("./migration-060");
        await runMigration060(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('060_data_backends')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const dataStudioUiMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='061_data_studio_expected_schema'");
    if (!dataStudioUiMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration061 } = await import("./migration-061");
        await runMigration061(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('061_data_studio_expected_schema')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const projectApiGatewayMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='062_project_api_gateway'");
    if (!projectApiGatewayMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration062 } = await import("./migration-062");
        await runMigration062(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('062_project_api_gateway')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const mobileAppMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='063_mobile_app_projects'");
    if (!mobileAppMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration063 } = await import("./migration-063");
        await runMigration063(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('063_mobile_app_projects')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const promoteBackupsMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='064_promote_backups_quotas'");
    if (!promoteBackupsMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration064 } = await import("./migration-064");
        await runMigration064(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('064_promote_backups_quotas')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const codeSessionMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='065_code_projects_and_sessions'");    if (!codeSessionMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration065 } = await import("./migration-065");
        await runMigration065(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('065_code_projects_and_sessions')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const auditLogMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='066_tamper_evident_audit_log'");
    if (!auditLogMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration066 } = await import("./migration-066");
        await runMigration066(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('066_tamper_evident_audit_log')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const featureFlagsMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='067_feature_flags_and_versioning'");
    if (!featureFlagsMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration067 } = await import("./migration-067");
        await runMigration067(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('067_feature_flags_and_versioning')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const sandboxImagesMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='068_sandbox_image_supply_chain'");
    if (!sandboxImagesMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration068 } = await import("./migration-068");
        await runMigration068(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('068_sandbox_image_supply_chain')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const credentialEnvironmentMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='069_credential_environment'");
    if (!credentialEnvironmentMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration069 } = await import("./migration-069");
        await runMigration069(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('069_credential_environment')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const codeApprovalRulesMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='070_code_approval_rules'");
    if (!codeApprovalRulesMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration070 } = await import("./migration-070");
        await runMigration070(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('070_code_approval_rules')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const codeTrustMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='071_code_project_trust'");
    if (!codeTrustMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration071 } = await import("./migration-071");
        await runMigration071(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('071_code_project_trust')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

    const companyMembershipMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='072_company_membership_and_invites'");
    if (!companyMembershipMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration072 } = await import("./migration-072");
        await runMigration072(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('072_company_membership_and_invites')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

    const protectedBranchesMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='073_company_protected_branches'");
    if (!protectedBranchesMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration073 } = await import("./migration-073");
        await runMigration073(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('073_company_protected_branches')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

    const providerDataPoliciesMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='074_provider_data_policies'");
    if (!providerDataPoliciesMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration074 } = await import("./migration-074");
        await runMigration074(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('074_provider_data_policies')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

    const codeRunStateMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='075_code_run_state'");
    if (!codeRunStateMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration075 } = await import("./migration-075");
        await runMigration075(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('075_code_run_state')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

    const executionSnapshotMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='076_execution_snapshots'");
    if (!executionSnapshotMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration076 } = await import("./migration-076");
        await runMigration076(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('076_execution_snapshots')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

    const codeActivityEventsMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='077_code_activity_events'");
    if (!codeActivityEventsMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration077 } = await import("./migration-077");
        await runMigration077(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('077_code_activity_events')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

    const replayBundlesMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='078_replay_bundles'");
    if (!replayBundlesMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration078 } = await import("./migration-078");
        await runMigration078(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('078_replay_bundles')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

    const contextSummariesMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='079_code_context_summaries'");
    if (!contextSummariesMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration079 } = await import("./migration-079");
        await runMigration079(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('079_code_context_summaries')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

    const goalsAndPlansMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='080_code_goals_and_plans'");
    if (!goalsAndPlansMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration080 } = await import("./migration-080");
        await runMigration080(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('080_code_goals_and_plans')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

    const userQuestionsMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='081_code_user_questions'");
    if (!userQuestionsMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration081 } = await import("./migration-081");
        await runMigration081(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('081_code_user_questions')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

}

export async function runPostgresMigration083(pool: Pool): Promise<void> {
    const runRequestMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='083_code_run_request'");
    if (!runRequestMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration083 } = await import("./migration-083");
        await runMigration083(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('083_code_run_request')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

}

export async function runPostgresMigration085(pool: Pool): Promise<void> {
    const mcpToolPolicyMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='085_mcp_tool_policies'");
    if (!mcpToolPolicyMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration085 } = await import("./migration-085");
        await runMigration085(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('085_mcp_tool_policies')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }

}

export async function runPostgresMigrationsPost086(pool: Pool): Promise<void> {
    const dataRetentionMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='087_code_data_retention'");
    if (!dataRetentionMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration087 } = await import("./migration-087");
        await runMigration087(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('087_code_data_retention')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const inboxMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='088_code_session_inbox'");
    if (!inboxMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { runMigration088 } = await import("./migration-088");
        await runMigration088(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('088_code_session_inbox')");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    const processMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='089_code_process_projects'");
    if (!processMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('089_code_process_projects'))");
        const { runMigration089 } = await import("./migration-089");
        await runMigration089(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('089_code_process_projects') ON CONFLICT DO NOTHING");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    const creatorMembershipMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='090_company_creator_membership'");
    if (!creatorMembershipMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('090_company_creator_membership'))");
        const { runMigration090 } = await import("./migration-090");
        await runMigration090(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('090_company_creator_membership') ON CONFLICT DO NOTHING");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    const flagSuspensionMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='091_code_flag_suspension'");
    if (!flagSuspensionMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('091_code_flag_suspension'))");
        const { runMigration091 } = await import("./migration-091");
        await runMigration091(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('091_code_flag_suspension') ON CONFLICT DO NOTHING");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    const projectLifecycleMigration = await pool.query("SELECT 1 FROM schema_migrations WHERE version='092_project_lifecycle_soft_delete'");
    if (!projectLifecycleMigration.rowCount) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('092_project_lifecycle_soft_delete'))");
        const { runMigration092 } = await import("./migration-092");
        await runMigration092(client);
        await client.query("INSERT INTO schema_migrations(version) VALUES ('092_project_lifecycle_soft_delete') ON CONFLICT DO NOTHING");
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }

}
