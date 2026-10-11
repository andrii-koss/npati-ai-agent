import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { defaultVault, type AuthContext, type CryptoVault } from "@npati/workspace";
import type {
  CompanyEmailAccount,
  CompanyEmailContact,
  CompanyEmailJob,
  CompanyEmailMessage,
  CompanyEmailNotification,
  CompanyEmailRule,
  CompanyEmailTemplate,
  CompanyEmailThread,
  EmailAnalytics,
  EmailFolder,
  EmailPriority,
  EmailThreadStatus,
} from "./email-inbox-types";
import { listContacts, getContact, upsertContact, listTemplates, createTemplate, deleteTemplate, updateTemplate, listRules, createRule, deleteRule, updateRule, type EmailInboxContactsHost } from "./email-inbox-contacts-repositories";
import { checkRateLimit, recordSentEmail, reserveSendQuota, enqueueJob, claimJobs, completeJob, failJob, cancelPendingFollowups, createNotification, listNotifications, markNotificationRead, type EmailInboxJobsHost } from "./email-inbox-jobs-and-limits-repositories";
import { messageCols, extractCandidateMessageIds } from "./email-inbox-repository-support";
import { isExternalMessageDeleted, acquireLock, releaseLock, setHumanTakeover, listMessages, deletePendingAiDrafts, getMessage, findMessageByExternalId, createMessage, updateMessage, type EmailInboxMessageHost } from "./email-inbox-message-repositories";

const accountCols = `
  id, workspace_id AS "workspaceId", company_id AS "companyId", user_id AS "userId",
  email_address AS "emailAddress", display_name AS "displayName", agent_id AS "agentId",
  provider, connection_scope AS "connectionScope", sender_policy AS "senderPolicy",
  allowed_senders AS "allowedSenders", allowed_domains AS "allowedDomains",
  require_authenticated_sender AS "requireAuthenticatedSender",
  outbound_policy AS "outboundPolicy",
  mode, status, test_mode AS "testMode", confidence_threshold AS "confidenceThreshold",
  language_mode AS "languageMode", fallback_language AS "fallbackLanguage",
  imap_config AS "imapConfig", smtp_config AS "smtpConfig", rate_limits AS "rateLimits",
  signature_config AS "signatureConfig", followup_config AS "followupConfig",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const threadCols = `
  id, workspace_id AS "workspaceId", company_id AS "companyId",
  email_account_id AS "emailAccountId", thread_key AS "threadKey", subject,
  customer_email AS "customerEmail", customer_name AS "customerName",
  customer_company AS "customerCompany", customer_phone AS "customerPhone",
  status, priority, folder, assigned_agent_id AS "assignedAgentId",
  assigned_user_id AS "assignedUserId", is_vip AS "isVip", is_blacklisted AS "isBlacklisted",
  is_human_takeover AS "isHumanTakeover", locked_by_user_id AS "lockedByUserId",
  locked_at AS "lockedAt", last_message_at AS "lastMessageAt", unread_count AS "unreadCount",
  ai_confidence_score AS "aiConfidenceScore", ai_classification_summary AS "aiClassificationSummary",
  detected_language AS "detectedLanguage", metadata, created_at AS "createdAt", updated_at AS "updatedAt"
`;


export function normalizeEmailSubject(subject?: string | null): string {
  if (!subject) return "";
  let clean = subject.trim();
  const prefixRegex = /^(?:\[[a-z0-9_\-\s.]+\]\s*)*(?:(?:re|fwd|fw|aw|antw|wg|odp|vs|回复|回覆|sv)\s*(?:\[\d+\]|\(\d+\))?\s*[:\-]\s*)+/i;
  let prev = "";
  while (clean !== prev) {
    prev = clean;
    clean = clean.replace(prefixRegex, "").trim();
  }
  clean = clean.replace(/^\[[^\]]+\]\s*/, "").trim();
  return clean.replace(/\s+/g, " ").trim();
}


export class EmailInboxRepository {
  private pool?: Pool;
  private readonly vault: CryptoVault;

  // In-memory fallback maps
  private memoryAccounts = new Map<string, CompanyEmailAccount>();
  private memoryThreads = new Map<string, CompanyEmailThread>();
  private memoryMessages = new Map<string, CompanyEmailMessage>();
  private memoryContacts = new Map<string, CompanyEmailContact>();
  private memoryTemplates = new Map<string, CompanyEmailTemplate>();
  private memoryRules = new Map<string, CompanyEmailRule>();
  private memoryJobs = new Map<string, CompanyEmailJob>();
  private sentTimestamps = new Map<string, number[]>(); // key: `${companyId}:${accountId}:${recipient}` -> array of epoch ms
  private inboundLocks = new Map<string, Promise<void>>();
  private memoryOAuthStates = new Map<string, {
    workspaceId: string; companyId: string; accountId: string; userId: string; verifier: string;
    tokenUrl: string; clientId: string; clientSecret?: string; redirectUri: string; expiresAt: string;
  }>();
  private memoryNotifications = new Map<string, CompanyEmailNotification>();
  private memoryDeletedMessageIds = new Set<string>();

  constructor(databaseUrl?: string, pool?: Pool, vault: CryptoVault = defaultVault) {
    this.vault = vault;
    if (pool) {
      this.pool = pool;
    } else if (databaseUrl && databaseUrl.trim().length > 0) {
      this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
    }
  }

  private messageHost(): EmailInboxMessageHost {
    return {
      pool: this.pool,
      memoryThreads: this.memoryThreads,
      memoryMessages: this.memoryMessages,
      memoryDeletedMessageIds: this.memoryDeletedMessageIds,
      inboundLocks: this.inboundLocks,
      getThread: this.getThread.bind(this),
      updateThread: this.updateThread.bind(this),
    };
  }

  private jobsHost(): EmailInboxJobsHost {
    return {
      pool: this.pool,
      memoryJobs: this.memoryJobs,
      sentTimestamps: this.sentTimestamps,
      memoryNotifications: this.memoryNotifications,
    };
  }

  private contactsHost(): EmailInboxContactsHost {
    return {
      pool: this.pool,
      memoryThreads: this.memoryThreads,
      memoryContacts: this.memoryContacts,
      memoryTemplates: this.memoryTemplates,
      memoryRules: this.memoryRules,
    };
  }

  private encryptAccountSecrets(account: CompanyEmailAccount): CompanyEmailAccount {
    const encrypt = (value?: string) => {
      if (!value || value.startsWith("v1$")) return value;
      return this.vault.encrypt(value);
    };
    return {
      ...account,
      imapConfig: {
        ...account.imapConfig, password: encrypt(account.imapConfig.password),
        accessToken: encrypt(account.imapConfig.accessToken), refreshToken: encrypt(account.imapConfig.refreshToken),
        clientSecret: encrypt(account.imapConfig.clientSecret)
      },
      smtpConfig: {
        ...account.smtpConfig, password: encrypt(account.smtpConfig.password),
        accessToken: encrypt(account.smtpConfig.accessToken), refreshToken: encrypt(account.smtpConfig.refreshToken),
        clientSecret: encrypt(account.smtpConfig.clientSecret)
      },
    };
  }

  private decryptAccountSecrets(account: CompanyEmailAccount): CompanyEmailAccount {
    const decrypt = (value?: string) => {
      if (!value || !value.startsWith("v1$")) return value;
      return this.vault.decrypt(value);
    };
    return {
      ...account,
      imapConfig: {
        ...account.imapConfig, password: decrypt(account.imapConfig.password),
        accessToken: decrypt(account.imapConfig.accessToken), refreshToken: decrypt(account.imapConfig.refreshToken),
        clientSecret: decrypt(account.imapConfig.clientSecret)
      },
      smtpConfig: {
        ...account.smtpConfig, password: decrypt(account.smtpConfig.password),
        accessToken: decrypt(account.smtpConfig.accessToken), refreshToken: decrypt(account.smtpConfig.refreshToken),
        clientSecret: decrypt(account.smtpConfig.clientSecret)
      },
    };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => undefined);
    }
  }

  async claimBrowserEmailWait(ctx: AuthContext, companyId: string, sender: string, emailAccountId?: string): Promise<{ browserJobId: string; runId: string; profileId: string; campaignTargetId?: string | null } | null> {
    if (!this.pool) return null;
    const normalizedSender = sender.trim().toLowerCase();
    const senderDomain = normalizedSender.split("@")[1] || normalizedSender;
    const result = await this.pool.query<{ browserJobId: string; runId: string; profileId: string; campaignTargetId?: string | null }>(`
      WITH candidate AS (
        SELECT w.id FROM company_browser_email_waits w
        LEFT JOIN company_browser_campaign_targets t ON t.id=w.campaign_target_id
        WHERE w.workspace_id=$1 AND w.company_id=$2 AND w.user_id=$3 AND w.status='waiting_email'
          AND (w.sender_hint IS NULL OR w.sender_hint='' OR w.sender_hint=$4 OR w.sender_hint=$5 OR $4 LIKE ('%@' || w.sender_hint))
          AND (w.campaign_target_id IS NULL OR t.email_account_id=$6)
        ORDER BY w.created_at DESC LIMIT 1 FOR UPDATE OF w SKIP LOCKED
      )
      UPDATE company_browser_email_waits w SET status='consumed',consumed_at=now()
      FROM candidate c WHERE w.id=c.id
      RETURNING w.browser_job_id AS "browserJobId",w.run_id::text AS "runId",w.profile_id AS "profileId",
        w.campaign_target_id::text AS "campaignTargetId"`,
      [ctx.workspaceId,companyId,ctx.userId,normalizedSender,senderDomain,emailAccountId || null]);
    return result.rows[0] ?? null;
  }

  async encryptLegacyAccountCredentials(): Promise<number> {
    if (!this.pool) {
      let changed = 0;
      for (const [id, account] of this.memoryAccounts) {
        const protectedAccount = this.encryptAccountSecrets(account);
        if (JSON.stringify(protectedAccount) !== JSON.stringify(account)) {
          this.memoryAccounts.set(id, protectedAccount);
          changed++;
        }
      }
      return changed;
    }
    const result = await this.pool.query<CompanyEmailAccount>(
      `SELECT ${accountCols} FROM company_email_accounts WHERE deleted_at IS NULL`
    );
    let changed = 0;
    for (const account of result.rows) {
      const protectedAccount = this.encryptAccountSecrets(account);
      if (JSON.stringify(protectedAccount.imapConfig) === JSON.stringify(account.imapConfig)
        && JSON.stringify(protectedAccount.smtpConfig) === JSON.stringify(account.smtpConfig)) continue;
      await this.pool.query(
        "UPDATE company_email_accounts SET imap_config=$1, smtp_config=$2, updated_at=now() WHERE id=$3",
        [JSON.stringify(protectedAccount.imapConfig), JSON.stringify(protectedAccount.smtpConfig), account.id]
      );
      changed++;
    }
    return changed;
  }

  async withInboundMessageLock<T>(
    workspaceId: string,
    companyId: string,
    externalMessageId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const lockKey = `${workspaceId}:${companyId}:${externalMessageId.trim()}`;
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
        return await operation();
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => undefined);
        client.release();
      }
    }

    const previous = this.inboundLocks.get(lockKey) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.inboundLocks.set(lockKey, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.inboundLocks.get(lockKey) === tail) this.inboundLocks.delete(lockKey);
    }
  }

  async createOAuthState(ctx: AuthContext, companyId: string, accountId: string, input: {
    stateHash: string; verifier: string; tokenUrl: string; clientId: string; clientSecret?: string;
    redirectUri: string; expiresAt: string;
  }): Promise<void> {
    if (this.pool) {
      await this.pool.query("DELETE FROM company_email_oauth_states WHERE expires_at <= now()");
      await this.pool.query(
        `INSERT INTO company_email_oauth_states
          (state_hash, workspace_id, company_id, account_id, user_id, encrypted_verifier, token_url,
           client_id, encrypted_client_secret, redirect_uri, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [input.stateHash, ctx.workspaceId, companyId, accountId, ctx.userId, this.vault.encrypt(input.verifier),
        input.tokenUrl, input.clientId, input.clientSecret ? this.vault.encrypt(input.clientSecret) : null,
        input.redirectUri, input.expiresAt]
      );
      return;
    }
    this.memoryOAuthStates.set(input.stateHash, {
      workspaceId: ctx.workspaceId, companyId, accountId, userId: ctx.userId,
      verifier: input.verifier, tokenUrl: input.tokenUrl, clientId: input.clientId, clientSecret: input.clientSecret,
      redirectUri: input.redirectUri, expiresAt: input.expiresAt
    });
  }

  async consumeOAuthState(stateHash: string): Promise<{
    workspaceId: string; companyId: string; accountId: string; userId: string; verifier: string;
    tokenUrl: string; clientId: string; clientSecret?: string; redirectUri: string;
  } | null> {
    if (this.pool) {
      const result = await this.pool.query<any>(
        `DELETE FROM company_email_oauth_states WHERE state_hash=$1 AND expires_at > now()
         RETURNING workspace_id AS "workspaceId", company_id AS "companyId", account_id AS "accountId",
           user_id AS "userId", encrypted_verifier AS "encryptedVerifier", token_url AS "tokenUrl",
           client_id AS "clientId", encrypted_client_secret AS "encryptedClientSecret", redirect_uri AS "redirectUri"`,
        [stateHash]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        ...row, verifier: this.vault.decrypt(row.encryptedVerifier),
        clientSecret: row.encryptedClientSecret ? this.vault.decrypt(row.encryptedClientSecret) : undefined
      };
    }
    const item = this.memoryOAuthStates.get(stateHash);
    this.memoryOAuthStates.delete(stateHash);
    if (!item || new Date(item.expiresAt).getTime() <= Date.now()) return null;
    const { expiresAt: _expiresAt, ...state } = item;
    return state;
  }

  // =========================================================================
  // 1. Email Accounts
  // =========================================================================

  async listAccounts(ctx: AuthContext, companyId: string): Promise<CompanyEmailAccount[]> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailAccount>(
        `SELECT ${accountCols} FROM company_email_accounts
         WHERE workspace_id = $1 AND company_id = $2 AND deleted_at IS NULL
         ORDER BY created_at ASC`,
        [ctx.workspaceId, companyId]
      );
      return result.rows.map((account) => this.decryptAccountSecrets(account));
    }

    return Array.from(this.memoryAccounts.values())
      .filter((a) => a.workspaceId === ctx.workspaceId && a.companyId === companyId)
      .map((account) => this.decryptAccountSecrets(account));
  }

  async listUserAccounts(ctx: AuthContext): Promise<CompanyEmailAccount[]> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailAccount>(
        `SELECT ${accountCols} FROM company_email_accounts
         WHERE workspace_id = $1 AND user_id = $2 AND deleted_at IS NULL ORDER BY created_at ASC`,
        [ctx.workspaceId, ctx.userId]
      );
      return result.rows.map((account) => this.decryptAccountSecrets(account));
    }
    return [...this.memoryAccounts.values()]
      .filter((account) => account.workspaceId === ctx.workspaceId && account.userId === ctx.userId)
      .map((account) => this.decryptAccountSecrets(account));
  }

  async getAccount(ctx: AuthContext, companyId: string, accountId: string): Promise<CompanyEmailAccount | null> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailAccount>(
        `SELECT ${accountCols} FROM company_email_accounts
         WHERE workspace_id = $1 AND company_id = $2 AND id = $3 AND deleted_at IS NULL`,
        [ctx.workspaceId, companyId, accountId]
      );
      return result.rows[0] ? this.decryptAccountSecrets(result.rows[0]) : null;
    }

    const item = this.memoryAccounts.get(accountId);
    return item && item.workspaceId === ctx.workspaceId && item.companyId === companyId
      ? this.decryptAccountSecrets(item)
      : null;
  }

  async getAccountInternal(accountId: string): Promise<CompanyEmailAccount | null> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailAccount>(
        `SELECT ${accountCols} FROM company_email_accounts WHERE id = $1 AND deleted_at IS NULL`,
        [accountId]
      );
      return result.rows[0] ? this.decryptAccountSecrets(result.rows[0]) : null;
    }
    const account = this.memoryAccounts.get(accountId);
    return account ? this.decryptAccountSecrets(account) : null;

  }
  async findAccountByEmail(companyId: string, emailAddress: string): Promise<CompanyEmailAccount | null> {
    const normalized = emailAddress.trim().toLowerCase();
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailAccount>(
        `SELECT ${accountCols} FROM company_email_accounts
         WHERE company_id = $1 AND LOWER(email_address) = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [companyId, normalized]
      );
      return result.rows[0] ? this.decryptAccountSecrets(result.rows[0]) : null;
    }

    for (const a of this.memoryAccounts.values()) {
      if (a.companyId === companyId && a.emailAddress.toLowerCase() === normalized) {
        return this.decryptAccountSecrets(a);
      }
    }
    return null;
  }

  async findUserAccountByEmail(ctx: AuthContext, emailAddress: string): Promise<CompanyEmailAccount | null> {
    const normalized = emailAddress.trim().toLowerCase();
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailAccount>(
        `SELECT ${accountCols} FROM company_email_accounts
         WHERE workspace_id = $1 AND user_id = $2 AND LOWER(email_address) = $3 AND deleted_at IS NULL
         LIMIT 1`,
        [ctx.workspaceId, ctx.userId, normalized]
      );
      return result.rows[0] ? this.decryptAccountSecrets(result.rows[0]) : null;
    }
    for (const account of this.memoryAccounts.values()) {
      if (account.workspaceId === ctx.workspaceId && account.userId === ctx.userId
        && account.emailAddress.toLowerCase() === normalized) return this.decryptAccountSecrets(account);
    }
    return null;
  }

  async listAccountsForWorker(): Promise<CompanyEmailAccount[]> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailAccount>(
        `SELECT ${accountCols} FROM company_email_accounts
         WHERE deleted_at IS NULL AND status <> 'disabled'
         ORDER BY created_at ASC`
      );
      return result.rows.map((account) => this.decryptAccountSecrets(account));
    }
    return Array.from(this.memoryAccounts.values())
      .filter((account) => account.status !== "disabled")
      .map((account) => this.decryptAccountSecrets(account));
  }

  async createAccount(
    ctx: AuthContext,
    companyId: string,
    input: Partial<CompanyEmailAccount> & { emailAddress: string }
  ): Promise<CompanyEmailAccount> {
    const id = input.id || randomUUID();
    const now = new Date().toISOString();
    const account: CompanyEmailAccount = {
      id,
      workspaceId: ctx.workspaceId,
      companyId,
      userId: ctx.userId,
      emailAddress: input.emailAddress.trim().toLowerCase(),
      displayName: input.displayName || null,
      agentId: input.agentId || null,
      provider: input.provider || "imap_smtp",
      connectionScope: input.connectionScope || (input.agentId ? "agent" : companyId.startsWith("personal:") ? "account" : "company"),
      senderPolicy: input.senderPolicy || "allowlist",
      allowedSenders: [...new Set((input.allowedSenders || []).map((value) => value.trim().toLowerCase()).filter(Boolean))],
      allowedDomains: [...new Set((input.allowedDomains || []).map((value) => value.trim().toLowerCase().replace(/^\*?@/, "")).filter(Boolean))],
      requireAuthenticatedSender: input.requireAuthenticatedSender ?? true,
      outboundPolicy: input.outboundPolicy || "approval_required",
      mode: input.mode || "approval",
      status: input.status || "pending",
      testMode: input.testMode ?? false,
      confidenceThreshold: input.confidenceThreshold ?? 0.8,
      languageMode: input.languageMode || "auto",
      fallbackLanguage: input.fallbackLanguage || "en",
      imapConfig: input.imapConfig || {},
      smtpConfig: input.smtpConfig || {},
      rateLimits: input.rateLimits || {
        maxPerHour: 50,
        maxPerDay: 500,
        maxPerRecipientDaily: 100,
        maxFollowups: 3,
        maxCompanyPerHour: 500,
        maxCompanyPerDay: 5000,
      },
      signatureConfig: input.signatureConfig || {},
      followupConfig: input.followupConfig || {
        enabled: false,
        delayDays: 2,
        maxFollowups: 2,
        action: "draft",
      },
      createdAt: now,
      updatedAt: now,
    };

    const storedAccount = this.encryptAccountSecrets(account);
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailAccount>(
        `INSERT INTO company_email_accounts (
          id, workspace_id, company_id, user_id, email_address, display_name,
          agent_id, provider, connection_scope, sender_policy, allowed_senders,
          allowed_domains, require_authenticated_sender, outbound_policy,
          mode, status, test_mode, confidence_threshold, language_mode,
          fallback_language, imap_config, smtp_config, rate_limits,
          signature_config, followup_config, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
        ) RETURNING ${accountCols}`,
        [
          account.id,
          account.workspaceId,
          account.companyId,
          account.userId,
          account.emailAddress,
          account.displayName,
          account.agentId,
          account.provider,
          account.connectionScope,
          account.senderPolicy,
          account.allowedSenders,
          account.allowedDomains,
          account.requireAuthenticatedSender,
          account.outboundPolicy,
          account.mode,
          account.status,
          account.testMode,
          account.confidenceThreshold,
          account.languageMode,
          account.fallbackLanguage,
          JSON.stringify(storedAccount.imapConfig),
          JSON.stringify(storedAccount.smtpConfig),
          JSON.stringify(account.rateLimits),
          JSON.stringify(account.signatureConfig),
          JSON.stringify(account.followupConfig),
          account.createdAt,
          account.updatedAt,
        ]
      );
      return this.decryptAccountSecrets(result.rows[0]!);
    }

    this.memoryAccounts.set(id, storedAccount);
    return account;
  }

  async updateAccount(
    ctx: AuthContext,
    companyId: string,
    accountId: string,
    patch: Partial<CompanyEmailAccount>
  ): Promise<CompanyEmailAccount> {
    const existing = await this.getAccount(ctx, companyId, accountId);
    if (!existing) throw new Error("Email account not found.");

    const now = new Date().toISOString();
    const updated: CompanyEmailAccount = {
      ...existing,
      ...patch,
      imapConfig: { ...existing.imapConfig, ...(patch.imapConfig || {}) },
      smtpConfig: { ...existing.smtpConfig, ...(patch.smtpConfig || {}) },
      rateLimits: { ...existing.rateLimits, ...(patch.rateLimits || {}) },
      signatureConfig: { ...existing.signatureConfig, ...(patch.signatureConfig || {}) },
      followupConfig: { ...existing.followupConfig, ...(patch.followupConfig || {}) },
      updatedAt: now,
    };

    const storedAccount = this.encryptAccountSecrets(updated);
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailAccount>(
        `UPDATE company_email_accounts SET
          display_name = $1, agent_id = $2, provider = $3, connection_scope = $4,
          sender_policy = $5, allowed_senders = $6, allowed_domains = $7,
          require_authenticated_sender = $8, outbound_policy = $9,
          mode = $10, status = $11, test_mode = $12, confidence_threshold = $13,
          language_mode = $14, fallback_language = $15, imap_config = $16, smtp_config = $17,
          rate_limits = $18, signature_config = $19, followup_config = $20,
          updated_at = $21
        WHERE workspace_id = $22 AND company_id = $23 AND id = $24
        RETURNING ${accountCols}`,
        [
          updated.displayName,
          updated.agentId,
          updated.provider,
          updated.connectionScope,
          updated.senderPolicy,
          updated.allowedSenders,
          updated.allowedDomains,
          updated.requireAuthenticatedSender,
          updated.outboundPolicy,
          updated.mode,
          updated.status,
          updated.testMode,
          updated.confidenceThreshold,
          updated.languageMode,
          updated.fallbackLanguage,
          JSON.stringify(storedAccount.imapConfig),
          JSON.stringify(storedAccount.smtpConfig),
          JSON.stringify(updated.rateLimits),
          JSON.stringify(updated.signatureConfig),
          JSON.stringify(updated.followupConfig),
          now,
          ctx.workspaceId,
          companyId,
          accountId,
        ]
      );
      return this.decryptAccountSecrets(result.rows[0]!);
    }

    this.memoryAccounts.set(accountId, storedAccount);
    return updated;
  }

  async deleteAccount(ctx: AuthContext, companyId: string, accountId: string): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        `UPDATE company_email_accounts SET deleted_at = now()
         WHERE workspace_id = $1 AND company_id = $2 AND id = $3`,
        [ctx.workspaceId, companyId, accountId]
      );
      return;
    }

    this.memoryAccounts.delete(accountId);
  }

  // =========================================================================
  // 2. Email Threads
  // =========================================================================

  async listThreads(
    ctx: AuthContext,
    companyId: string,
    filter: {
      folder?: EmailFolder;
      status?: EmailThreadStatus;
      priority?: EmailPriority;
      search?: string;
      accountId?: string;
      isVip?: boolean;
      limit?: number;
    } = {}
  ): Promise<CompanyEmailThread[]> {
    const limit = Math.min(100, Math.max(1, filter.limit || 50));

    if (this.pool) {
      const conditions: string[] = ["workspace_id = $1", "company_id = $2"];
      const params: any[] = [ctx.workspaceId, companyId];

      if (filter.folder) {
        if (filter.folder === "sent") {
          conditions.push(`EXISTS (
            SELECT 1 FROM company_email_messages folder_message
            WHERE folder_message.workspace_id = company_email_threads.workspace_id
              AND folder_message.company_id = company_email_threads.company_id
              AND folder_message.thread_id = company_email_threads.id
              AND folder_message.direction = 'outbound'
              AND folder_message.is_draft = false
          )`);
        } else if (filter.folder === "drafts") {
          conditions.push(`EXISTS (
            SELECT 1 FROM company_email_messages folder_message
            WHERE folder_message.workspace_id = company_email_threads.workspace_id
              AND folder_message.company_id = company_email_threads.company_id
              AND folder_message.thread_id = company_email_threads.id
              AND folder_message.is_draft = true
              AND folder_message.is_ai_generated = false
          )`);
        } else {
          params.push(filter.folder);
          conditions.push(`folder = $${params.length}`);
        }
      }
      if (filter.status) {
        params.push(filter.status);
        conditions.push(`status = $${params.length}`);
      }
      if (filter.priority) {
        params.push(filter.priority);
        conditions.push(`priority = $${params.length}`);
      }
      if (filter.accountId) {
        params.push(filter.accountId);
        conditions.push(`email_account_id = $${params.length}`);
      }
      if (filter.isVip !== undefined) {
        params.push(filter.isVip);
        conditions.push(`is_vip = $${params.length}`);
      }
      if (filter.search && filter.search.trim().length > 0) {
        params.push(`%${filter.search.trim().toLowerCase()}%`);
        conditions.push(
          `(LOWER(subject) LIKE $${params.length} OR LOWER(customer_email) LIKE $${params.length} OR LOWER(customer_name) LIKE $${params.length})`
        );
      }

      params.push(limit);
      const query = `
        SELECT ${threadCols},
          (SELECT COUNT(*)::int
             FROM company_email_messages count_message
            WHERE count_message.workspace_id = company_email_threads.workspace_id
              AND count_message.company_id = company_email_threads.company_id
              AND count_message.thread_id = company_email_threads.id
              AND count_message.is_draft = false) AS "messagesCount"
        FROM company_email_threads
        WHERE ${conditions.join(" AND ")}
        ORDER BY last_message_at DESC
        LIMIT $${params.length}
      `;
      const result = await this.pool.query<CompanyEmailThread>(query, params);
      return result.rows;
    }

    let items = Array.from(this.memoryThreads.values()).filter(
      (t) => t.workspaceId === ctx.workspaceId && t.companyId === companyId
    );

    if (filter.folder === "sent") {
      items = items.filter((thread) => Array.from(this.memoryMessages.values()).some((message) =>
        message.workspaceId === ctx.workspaceId && message.companyId === companyId &&
        message.threadId === thread.id && message.direction === "outbound" && !message.isDraft
      ));
    } else if (filter.folder === "drafts") {
      items = items.filter((thread) => Array.from(this.memoryMessages.values()).some((message) =>
        message.workspaceId === ctx.workspaceId && message.companyId === companyId &&
        message.threadId === thread.id && message.isDraft && !message.isAiGenerated
      ));
    } else if (filter.folder) items = items.filter((t) => t.folder === filter.folder);
    if (filter.status) items = items.filter((t) => t.status === filter.status);
    if (filter.priority) items = items.filter((t) => t.priority === filter.priority);
    if (filter.accountId) items = items.filter((t) => t.emailAccountId === filter.accountId);
    if (filter.isVip !== undefined) items = items.filter((t) => t.isVip === filter.isVip);
    if (filter.search && filter.search.trim()) {
      const q = filter.search.toLowerCase();
      items = items.filter(
        (t) =>
          t.subject.toLowerCase().includes(q) ||
          t.customerEmail.toLowerCase().includes(q) ||
          (t.customerName && t.customerName.toLowerCase().includes(q))
      );
    }

    return items
      .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
      .slice(0, limit)
      .map((thread) => ({
        ...thread,
        messagesCount: Array.from(this.memoryMessages.values()).filter((message) =>
          message.workspaceId === ctx.workspaceId && message.companyId === companyId &&
          message.threadId === thread.id && !message.isDraft
        ).length,
      }));
  }

  async getFolderCounts(
    ctx: AuthContext,
    companyId: string,
    accountId?: string
  ): Promise<Record<EmailFolder, number>> {
    if (this.pool) {
      const params: unknown[] = [ctx.workspaceId, companyId];
      const accountCondition = accountId ? ` AND thread.email_account_id = $3` : "";
      if (accountId) params.push(accountId);
      const result = await this.pool.query<{
        inbox: string; sent: string; drafts: string; archived: string; spam: string;
      }>(
        `SELECT
          COALESCE(SUM(thread.unread_count) FILTER (WHERE thread.folder = 'inbox'), 0) AS inbox,
          COALESCE(SUM((SELECT COUNT(*) FROM company_email_messages message
            WHERE message.workspace_id = thread.workspace_id
              AND message.company_id = thread.company_id
              AND message.thread_id = thread.id
              AND message.direction = 'outbound'
              AND message.is_draft = false
          )), 0) AS sent,
          COALESCE(SUM((SELECT COUNT(*) FROM company_email_messages message
            WHERE message.workspace_id = thread.workspace_id
              AND message.company_id = thread.company_id
              AND message.thread_id = thread.id
              AND message.is_draft = true
              AND message.is_ai_generated = false
          )), 0) AS drafts,
          COUNT(*) FILTER (WHERE thread.folder = 'archived') AS archived,
          COUNT(*) FILTER (WHERE thread.folder = 'spam') AS spam
        FROM company_email_threads thread
        WHERE thread.workspace_id = $1 AND thread.company_id = $2${accountCondition}`,
        params
      );
      const row = result.rows[0];
      return {
        inbox: Number(row?.inbox || 0), sent: Number(row?.sent || 0), drafts: Number(row?.drafts || 0),
        archived: Number(row?.archived || 0), spam: Number(row?.spam || 0),
      };
    }

    const allThreads = Array.from(this.memoryThreads.values()).filter((thread) =>
      thread.workspaceId === ctx.workspaceId && thread.companyId === companyId &&
      (!accountId || thread.emailAccountId === accountId)
    );
    return {
      inbox: allThreads.filter((thread) => thread.folder === "inbox").reduce((sum, thread) => sum + thread.unreadCount, 0),
      sent: allThreads.reduce((sum, thread) => sum + Array.from(this.memoryMessages.values()).filter((message) =>
        message.workspaceId === ctx.workspaceId && message.companyId === companyId && message.threadId === thread.id &&
        message.direction === "outbound" && !message.isDraft
      ).length, 0),
      drafts: allThreads.reduce((sum, thread) => sum + Array.from(this.memoryMessages.values()).filter((message) =>
        message.workspaceId === ctx.workspaceId && message.companyId === companyId && message.threadId === thread.id &&
        message.isDraft && !message.isAiGenerated
      ).length, 0),
      archived: allThreads.filter((thread) => thread.folder === "archived").length,
      spam: allThreads.filter((thread) => thread.folder === "spam").length,
    };
  }

  async getThread(ctx: AuthContext, companyId: string, threadId: string): Promise<CompanyEmailThread | null> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailThread>(
        `SELECT ${threadCols} FROM company_email_threads
         WHERE workspace_id = $1 AND company_id = $2 AND id = $3`,
        [ctx.workspaceId, companyId, threadId]
      );
      return result.rows[0] ?? null;
    }

    const t = this.memoryThreads.get(threadId);
    return t && t.workspaceId === ctx.workspaceId && t.companyId === companyId ? t : null;
  }

  async findThreadByKey(
    workspaceId: string,
    companyId: string,
    threadKey: string
  ): Promise<CompanyEmailThread | null> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailThread>(
        `SELECT ${threadCols} FROM company_email_threads
         WHERE workspace_id = $1 AND company_id = $2 AND thread_key = $3
         LIMIT 1`,
        [workspaceId, companyId, threadKey]
      );
      return result.rows[0] ?? null;
    }

    for (const t of this.memoryThreads.values()) {
      if (t.workspaceId === workspaceId && t.companyId === companyId && t.threadKey === threadKey) {
        return t;
      }
    }
    return null;
  }

  async findMessageByReferenceIds(
    ctx: AuthContext,
    companyId: string,
    referenceHeaders: (string | undefined | null)[]
  ): Promise<CompanyEmailMessage | null> {
    const allCandidates = new Set<string>();
    for (const header of referenceHeaders) {
      for (const id of extractCandidateMessageIds(header)) {
        allCandidates.add(id);
      }
    }
    const idList = Array.from(allCandidates);
    if (!idList.length) return null;

    if (this.pool) {
      const result = await this.pool.query<CompanyEmailMessage>(
        `SELECT ${messageCols} FROM company_email_messages
         WHERE workspace_id = $1 AND company_id = $2
           AND (message_id = ANY($3::text[]) OR id::text = ANY($3::text[]))
         ORDER BY created_at DESC
         LIMIT 1`,
        [ctx.workspaceId, companyId, idList]
      );
      return result.rows[0] ?? null;
    }

    for (const m of this.memoryMessages.values()) {
      if (m.workspaceId === ctx.workspaceId && m.companyId === companyId) {
        if ((m.messageId && idList.includes(m.messageId)) || idList.includes(m.id)) {
          return m;
        }
      }
    }
    return null;
  }

  async listRecentThreadsForCustomer(
    ctx: AuthContext,
    companyId: string,
    customerEmail: string,
    limit = 15
  ): Promise<CompanyEmailThread[]> {
    const cleanEmail = customerEmail.trim().toLowerCase();
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailThread>(
        `SELECT ${threadCols} FROM company_email_threads
         WHERE workspace_id = $1 AND company_id = $2
           AND LOWER(customer_email) = $3
         ORDER BY last_message_at DESC
         LIMIT $4`,
        [ctx.workspaceId, companyId, cleanEmail, limit]
      );
      return result.rows;
    }
    return Array.from(this.memoryThreads.values())
      .filter((t) => t.workspaceId === ctx.workspaceId && t.companyId === companyId && t.customerEmail.toLowerCase() === cleanEmail)
      .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
      .slice(0, limit);
  }

  async findMatchingThread(
    ctx: AuthContext,
    companyId: string,
    params: {
      inReplyTo?: string | null;
      references?: string | null;
      customerEmail: string;
      subject: string;
      threadKey?: string | null;
    }
  ): Promise<CompanyEmailThread | null> {
    // 1. Try In-Reply-To and References header lookup (Message-ID linkage)
    if (params.inReplyTo || params.references) {
      const parentMsg = await this.findMessageByReferenceIds(ctx, companyId, [params.inReplyTo, params.references]);
      if (parentMsg?.threadId) {
        const thread = await this.getThread(ctx, companyId, parentMsg.threadId);
        if (thread) return thread;
      }
    }

    // 2. Try explicit threadKey if provided
    if (params.threadKey) {
      const thread = await this.findThreadByKey(ctx.workspaceId, companyId, params.threadKey);
      if (thread) return thread;
    }

    const cleanEmail = params.customerEmail.trim().toLowerCase();
    const cleanSubject = normalizeEmailSubject(params.subject);

    // 3. Try normalized threadKey and legacy key formats
    if (cleanSubject) {
      const normalizedKey = `th_${cleanEmail.replace(/[^a-z0-9]/g, "_")}_${encodeURIComponent(cleanSubject.slice(0, 50).toLowerCase())}`;
      const thread = await this.findThreadByKey(ctx.workspaceId, companyId, normalizedKey);
      if (thread) return thread;

      // Legacy key with clean subject
      const legacyKeyClean = `thread_${cleanEmail}_${encodeURIComponent(cleanSubject.slice(0, 30))}`;
      const legacyThreadClean = await this.findThreadByKey(ctx.workspaceId, companyId, legacyKeyClean);
      if (legacyThreadClean) return legacyThreadClean;

      // Legacy key with raw subject
      const legacyKeyRaw1 = `th_${cleanEmail.replace(/[^a-z0-9]/g, "_")}_${encodeURIComponent(params.subject.slice(0, 30))}`;
      const legacyThreadRaw1 = await this.findThreadByKey(ctx.workspaceId, companyId, legacyKeyRaw1);
      if (legacyThreadRaw1) return legacyThreadRaw1;

      const legacyKeyRaw2 = `thread_${cleanEmail}_${encodeURIComponent(params.subject.slice(0, 30))}`;
      const legacyThreadRaw2 = await this.findThreadByKey(ctx.workspaceId, companyId, legacyKeyRaw2);
      if (legacyThreadRaw2) return legacyThreadRaw2;
    }

    // 4. Fallback: Search recent threads for this customer email with matching normalized subject
    const recentThreads = await this.listRecentThreadsForCustomer(ctx, companyId, cleanEmail, 15);
    for (const candidate of recentThreads) {
      const candidateNorm = normalizeEmailSubject(candidate.subject).toLowerCase();
      if (candidateNorm && cleanSubject.toLowerCase() === candidateNorm) {
        return candidate;
      }
    }

    return null;
  }

  async createThread(
    ctx: AuthContext,
    companyId: string,
    input: Partial<CompanyEmailThread> & { subject: string; customerEmail: string }
  ): Promise<CompanyEmailThread> {
    const id = input.id || randomUUID();
    const now = new Date().toISOString();
    const cleanCustomerEmail = input.customerEmail.trim().toLowerCase();
    const cleanSubject = normalizeEmailSubject(input.subject);
    const threadKey = input.threadKey || `th_${cleanCustomerEmail.replace(/[^a-z0-9]/g, "_")}_${encodeURIComponent((cleanSubject || input.subject).slice(0, 50).toLowerCase())}`;

    const thread: CompanyEmailThread = {
      id,
      workspaceId: ctx.workspaceId,
      companyId,
      emailAccountId: input.emailAccountId || null,
      threadKey,
      subject: input.subject.trim(),
      customerEmail: cleanCustomerEmail,
      customerName: input.customerName || null,
      customerCompany: input.customerCompany || null,
      customerPhone: input.customerPhone || null,
      status: input.status || "new",
      priority: input.priority || "normal",
      folder: input.folder || "inbox",
      assignedAgentId: input.assignedAgentId || null,
      assignedUserId: input.assignedUserId || null,
      isVip: input.isVip ?? false,
      isBlacklisted: input.isBlacklisted ?? false,
      isHumanTakeover: input.isHumanTakeover ?? false,
      lockedByUserId: null,
      lockedAt: null,
      lastMessageAt: input.lastMessageAt || now,
      unreadCount: input.unreadCount ?? 1,
      aiConfidenceScore: input.aiConfidenceScore ?? null,
      aiClassificationSummary: input.aiClassificationSummary || null,
      detectedLanguage: input.detectedLanguage || null,
      metadata: input.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    if (this.pool) {
      const result = await this.pool.query<CompanyEmailThread>(
        `INSERT INTO company_email_threads (
          id, workspace_id, company_id, email_account_id, thread_key, subject,
          customer_email, customer_name, customer_company, customer_phone,
          status, priority, folder, assigned_agent_id, assigned_user_id,
          is_vip, is_blacklisted, is_human_takeover, locked_by_user_id, locked_at,
          last_message_at, unread_count, ai_confidence_score, ai_classification_summary,
          detected_language, metadata, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
          $25, $26, $27, $28
        ) RETURNING ${threadCols}`,
        [
          thread.id,
          thread.workspaceId,
          thread.companyId,
          thread.emailAccountId,
          thread.threadKey,
          thread.subject,
          thread.customerEmail,
          thread.customerName,
          thread.customerCompany,
          thread.customerPhone,
          thread.status,
          thread.priority,
          thread.folder,
          thread.assignedAgentId,
          thread.assignedUserId,
          thread.isVip,
          thread.isBlacklisted,
          thread.isHumanTakeover,
          thread.lockedByUserId,
          thread.lockedAt,
          thread.lastMessageAt,
          thread.unreadCount,
          thread.aiConfidenceScore,
          thread.aiClassificationSummary,
          thread.detectedLanguage,
          JSON.stringify(thread.metadata),
          thread.createdAt,
          thread.updatedAt,
        ]
      );
      return result.rows[0]!;
    }

    this.memoryThreads.set(id, thread);
    return thread;
  }

  async updateThread(
    ctx: AuthContext,
    companyId: string,
    threadId: string,
    patch: Partial<CompanyEmailThread>
  ): Promise<CompanyEmailThread> {
    const existing = await this.getThread(ctx, companyId, threadId);
    if (!existing) throw new Error("Thread not found.");

    const now = new Date().toISOString();
    const updated: CompanyEmailThread = {
      ...existing,
      ...patch,
      updatedAt: now,
    };

    if (this.pool) {
      const result = await this.pool.query<CompanyEmailThread>(
        `UPDATE company_email_threads SET
          status = $1, priority = $2, folder = $3, assigned_agent_id = $4,
          assigned_user_id = $5, is_vip = $6, is_blacklisted = $7,
          is_human_takeover = $8, locked_by_user_id = $9, locked_at = $10,
          last_message_at = $11, unread_count = $12, ai_confidence_score = $13,
          ai_classification_summary = $14, detected_language = $15, metadata = $16,
          updated_at = $17
        WHERE workspace_id = $18 AND company_id = $19 AND id = $20
        RETURNING ${threadCols}`,
        [
          updated.status,
          updated.priority,
          updated.folder,
          updated.assignedAgentId,
          updated.assignedUserId,
          updated.isVip,
          updated.isBlacklisted,
          updated.isHumanTakeover,
          updated.lockedByUserId,
          updated.lockedAt,
          updated.lastMessageAt,
          updated.unreadCount,
          updated.aiConfidenceScore,
          updated.aiClassificationSummary,
          updated.detectedLanguage,
          JSON.stringify(updated.metadata),
          now,
          ctx.workspaceId,
          companyId,
          threadId,
        ]
      );
      return result.rows[0]!;
    }

    this.memoryThreads.set(threadId, updated);
    return updated;
  }

  async deleteThread(ctx: AuthContext, companyId: string, threadId: string): Promise<void> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO company_email_deleted_messages
             (workspace_id, company_id, email_account_id, external_message_id)
           SELECT workspace_id, company_id, email_account_id, message_id
             FROM company_email_messages
            WHERE workspace_id = $1 AND company_id = $2 AND thread_id = $3
              AND message_id IS NOT NULL AND message_id <> ''
           ON CONFLICT (workspace_id, company_id, external_message_id)
           DO UPDATE SET deleted_at = now()`,
          [ctx.workspaceId, companyId, threadId]
        );
        await client.query(
          `DELETE FROM company_email_threads WHERE workspace_id = $1 AND company_id = $2 AND id = $3`,
          [ctx.workspaceId, companyId, threadId]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return;
    }

    for (const message of this.memoryMessages.values()) {
      if (message.workspaceId === ctx.workspaceId && message.companyId === companyId && message.threadId === threadId && message.messageId) {
        this.memoryDeletedMessageIds.add(`${ctx.workspaceId}|${companyId}|${message.messageId}`);
      }
    }
    this.memoryThreads.delete(threadId);
    // Also remove associated messages
    for (const [msgId, msg] of this.memoryMessages.entries()) {
      if (msg.threadId === threadId) {
        this.memoryMessages.delete(msgId);
      }
    }
  }

  async isExternalMessageDeleted(ctx: AuthContext, companyId: string, externalMessageId: string): Promise<boolean> {
    return isExternalMessageDeleted(this.messageHost(), ctx, companyId, externalMessageId);
  }

  async acquireLock(ctx: AuthContext, companyId: string, threadId: string): Promise<boolean> {
    return acquireLock(this.messageHost(), ctx, companyId, threadId);
  }

  async releaseLock(ctx: AuthContext, companyId: string, threadId: string): Promise<void> {
    return releaseLock(this.messageHost(), ctx, companyId, threadId);
  }

  async setHumanTakeover(ctx: AuthContext, companyId: string, threadId: string, takeover: boolean): Promise<CompanyEmailThread> {
    return setHumanTakeover(this.messageHost(), ctx, companyId, threadId, takeover);
  }

  async isCollisionLocked(ctx: AuthContext, companyId: string, threadId: string): Promise<{ locked: boolean; reason?: string }> {
    const thread = await this.getThread(ctx, companyId, threadId);
    if (!thread) return { locked: false };

    if (thread.isHumanTakeover) {
      return { locked: true, reason: "Human takeover is currently active on this thread." };
    }

    if (thread.lockedByUserId && thread.lockedAt) {
      const lockAgeMs = Date.now() - new Date(thread.lockedAt).getTime();
      if (lockAgeMs < 300_000) {
        return { locked: true, reason: `Thread is locked by user (${Math.round(lockAgeMs / 1000)}s ago).` };
      }
    }

    return { locked: false };
  }

  // =========================================================================
  // 4. Email Messages
  // =========================================================================

  async listMessages(ctx: AuthContext, companyId: string, threadId: string): Promise<CompanyEmailMessage[]> {
    return listMessages(this.messageHost(), ctx, companyId, threadId);
  }

  async deletePendingAiDrafts(ctx: AuthContext, companyId: string, threadId: string): Promise<number> {
    return deletePendingAiDrafts(this.messageHost(), ctx, companyId, threadId);
  }

  async getMessage(ctx: AuthContext, companyId: string, messageId: string): Promise<CompanyEmailMessage | null> {
    return getMessage(this.messageHost(), ctx, companyId, messageId);
  }

  async findMessageByExternalId(
    ctx: AuthContext,
    companyId: string,
    externalMessageId: string
  ): Promise<CompanyEmailMessage | null> {
    return findMessageByExternalId(this.messageHost(), ctx, companyId, externalMessageId);
  }

  async createMessage(
    ctx: AuthContext,
    companyId: string,
    input: Partial<CompanyEmailMessage> & {
      threadId: string;
      direction: "inbound" | "outbound";
      fromAddress: string;
      toAddresses: string[];
      subject: string;
      bodyText: string;
    }
  ): Promise<CompanyEmailMessage> {
    return createMessage(this.messageHost(), ctx, companyId, input);
  }

  async updateMessage(
    ctx: AuthContext,
    companyId: string,
    messageId: string,
    patch: Partial<CompanyEmailMessage>
  ): Promise<CompanyEmailMessage> {
    return updateMessage(this.messageHost(), ctx, companyId, messageId, patch);
  }

  async listContacts(ctx: AuthContext, companyId: string): Promise<CompanyEmailContact[]> {
    return listContacts(this.contactsHost(), ctx, companyId);
  }

  async getContact(ctx: AuthContext, companyId: string, email: string): Promise<CompanyEmailContact | null> {
    return getContact(this.contactsHost(), ctx, companyId, email);
  }

  async upsertContact(
    ctx: AuthContext,
    companyId: string,
    contactData: {
      email: string;
      name?: string | null;
      companyName?: string | null;
      phone?: string | null;
      isVip?: boolean;
      isBlacklisted?: boolean;
      notes?: string | null;
    }
  ): Promise<CompanyEmailContact> {
    return upsertContact(this.contactsHost(), ctx, companyId, contactData);
  }

  async listTemplates(ctx: AuthContext, companyId: string): Promise<CompanyEmailTemplate[]> {
    return listTemplates(this.contactsHost(), ctx, companyId);
  }

  async createTemplate(
    ctx: AuthContext,
    companyId: string,
    input: { title: string; category?: string; subjectTemplate?: string; bodyTemplate: string; emailAccountId?: string }
  ): Promise<CompanyEmailTemplate> {
    return createTemplate(this.contactsHost(), ctx, companyId, input);
  }

  async deleteTemplate(ctx: AuthContext, companyId: string, templateId: string): Promise<void> {
    return deleteTemplate(this.contactsHost(), ctx, companyId, templateId);
  }

  async updateTemplate(
    ctx: AuthContext,
    companyId: string,
    templateId: string,
    patch: { title?: string; category?: string; subjectTemplate?: string | null; bodyTemplate?: string }
  ): Promise<CompanyEmailTemplate> {
    return updateTemplate(this.contactsHost(), ctx, companyId, templateId, patch);
  }

  async listRules(ctx: AuthContext, companyId: string): Promise<CompanyEmailRule[]> {
    return listRules(this.contactsHost(), ctx, companyId);
  }

  async createRule(
    ctx: AuthContext,
    companyId: string,
    input: { name: string; emailAccountId?: string; conditions?: any; actions?: any; priorityOrder?: number }
  ): Promise<CompanyEmailRule> {
    return createRule(this.contactsHost(), ctx, companyId, input);
  }

  async deleteRule(ctx: AuthContext, companyId: string, ruleId: string): Promise<void> {
    return deleteRule(this.contactsHost(), ctx, companyId, ruleId);
  }

  async updateRule(
    ctx: AuthContext,
    companyId: string,
    ruleId: string,
    patch: { name?: string; conditions?: any; actions?: any; isActive?: boolean; priorityOrder?: number }
  ): Promise<CompanyEmailRule> {
    return updateRule(this.contactsHost(), ctx, companyId, ruleId, patch);
  }

  async checkRateLimit(
    companyId: string,
    account: CompanyEmailAccount,
    recipientEmail: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    return checkRateLimit(this.jobsHost(), companyId, account, recipientEmail);
  }

  async recordSentEmail(companyId: string, accountId: string, recipientEmail: string): Promise<void> {
    return recordSentEmail(this.jobsHost(), companyId, accountId, recipientEmail);
  }

  async reserveSendQuota(
    companyId: string,
    account: CompanyEmailAccount,
    recipientEmail: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    return reserveSendQuota(this.jobsHost(), companyId, account, recipientEmail);
  }

  async enqueueJob(
    ctx: AuthContext,
    companyId: string,
    input: {
      jobType: CompanyEmailJob["jobType"];
      emailAccountId?: string | null;
      threadId?: string | null;
      messageId?: string | null;
      payload?: Record<string, unknown>;
      runAfter?: string;
      maxAttempts?: number;
      idempotencyKey?: string | null;
    }
  ): Promise<CompanyEmailJob> {
    return enqueueJob(this.jobsHost(), ctx, companyId, input);
  }

  async claimJobs(workerId: string, limit = 10): Promise<CompanyEmailJob[]> {
    return claimJobs(this.jobsHost(), workerId, limit);
  }

  async completeJob(jobId: string): Promise<void> {
    return completeJob(this.jobsHost(), jobId);
  }

  async failJob(job: CompanyEmailJob, error: unknown): Promise<void> {
    return failJob(this.jobsHost(), job, error);
  }

  async cancelPendingFollowups(threadId: string): Promise<void> {
    return cancelPendingFollowups(this.jobsHost(), threadId);
  }

  async createNotification(ctx: AuthContext, companyId: string, input: {
    userId?: string | null; threadId?: string | null;
    notificationType: CompanyEmailNotification["notificationType"]; title: string; body: string;
  }): Promise<CompanyEmailNotification> {
    return createNotification(this.jobsHost(), ctx, companyId, input);
  }

  async listNotifications(ctx: AuthContext, companyId: string, limit = 50): Promise<CompanyEmailNotification[]> {
    return listNotifications(this.jobsHost(), ctx, companyId, limit);
  }

  async markNotificationRead(ctx: AuthContext, companyId: string, notificationId: string): Promise<void> {
    return markNotificationRead(this.jobsHost(), ctx, companyId, notificationId);
  }

  async getAnalytics(ctx: AuthContext, companyId: string): Promise<EmailAnalytics> {
    const threads = await this.listThreads(ctx, companyId, { limit: 1000 });
    const accounts = await this.listAccounts(ctx, companyId);
    const messages: CompanyEmailMessage[] = this.pool
      ? (await this.pool.query<CompanyEmailMessage>(
        `SELECT ${messageCols} FROM company_email_messages
           WHERE workspace_id = $1 AND company_id = $2 ORDER BY created_at ASC`,
        [ctx.workspaceId, companyId]
      )).rows
      : Array.from(this.memoryMessages.values())
        .filter((message) => message.workspaceId === ctx.workspaceId && message.companyId === companyId)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const receivedEmails = messages.filter((message) => message.direction === "inbound").length;
    const completedOutbound = messages.filter((message) =>
      message.direction === "outbound"
      && !message.isDraft
      && (message.deliveryStatus === "sent" || message.deliveryStatus === "delivered"));
    const sentEmails = completedOutbound.length;
    const aiAnswered = completedOutbound.filter((message) => message.isAiGenerated).length;
    const humanAnswered = completedOutbound.filter((message) => !message.isAiGenerated).length;
    const draftedByAi = messages.filter((message) => message.direction === "outbound" && message.isAiGenerated && message.isDraft).length;
    const approvedByHuman = completedOutbound.filter((message) => Boolean(message.aiDraftApprovedBy)).length;
    const failedEmails = messages.filter((message) => message.deliveryStatus === "failed" || message.deliveryStatus === "rejected").length;
    const bouncedEmails = messages.filter((message) => message.deliveryStatus === "bounced").length;
    const escalatedToHuman = threads.filter((thread) => thread.status === "waiting_human" || thread.isHumanTakeover).length;
    const editedAiResponsesCount = this.pool
      ? Number((await this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM company_audit_logs
           WHERE workspace_id = $1 AND company_id = $2 AND action = 'email.ai_draft_edited'`,
        [ctx.workspaceId, companyId]
      )).rows[0]?.count || 0)
      : 0;
    let highConf = 0;
    let medConf = 0;
    let lowConf = 0;

    for (const t of threads) {
      if (t.aiConfidenceScore !== null && t.aiConfidenceScore !== undefined) {
        if (t.aiConfidenceScore >= 0.85) highConf++;
        else if (t.aiConfidenceScore >= 0.6) medConf++;
        else lowConf++;
      }
    }

    const responseTimes: number[] = [];
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    for (const thread of threads) {
      const threadMessages = messages.filter((message) => message.threadId === thread.id);
      const firstInbound = threadMessages.find((message) => message.direction === "inbound");
      const firstResponse = firstInbound && threadMessages.find((message) =>
        message.direction === "outbound"
        && !message.isDraft
        && (message.deliveryStatus === "sent" || message.deliveryStatus === "delivered")
        && new Date(message.createdAt) >= new Date(firstInbound.createdAt));
      if (firstInbound && firstResponse) {
        responseTimes.push((new Date(firstResponse.createdAt).getTime() - new Date(firstInbound.createdAt).getTime()) / 60_000);
      }
    }
    const averageResponse = responseTimes.length
      ? Math.round((responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length) * 10) / 10
      : 0;
    const automationRate = sentEmails > 0 ? Math.round((aiAnswered / sentEmails) * 100) : 0;
    const dayMap = new Map<string, { received: number; sent: number }>();
    const accountMap = new Map<string, number>();
    const agentMap = new Map<string, number>();
    for (const message of messages) {
      const day = new Date(message.createdAt).toISOString().slice(0, 10);
      const entry = dayMap.get(day) || { received: 0, sent: 0 };
      if (message.direction === "inbound") entry.received++;
      else if (!message.isDraft && (message.deliveryStatus === "sent" || message.deliveryStatus === "delivered")) entry.sent++;
      dayMap.set(day, entry);
      if (message.emailAccountId) accountMap.set(message.emailAccountId, (accountMap.get(message.emailAccountId) || 0) + 1);
      const creditedAgentId = message.sentByAgentId || (message.isAiGenerated ? threadById.get(message.threadId)?.assignedAgentId : undefined);
      if (creditedAgentId && completedOutbound.some((outbound) => outbound.id === message.id)) {
        agentMap.set(creditedAgentId, (agentMap.get(creditedAgentId) || 0) + 1);
      }
    }

    return {
      receivedEmails,
      sentEmails,
      aiAnswered,
      humanAnswered,
      draftedByAi,
      approvedByHuman,
      escalatedToHuman,
      failedEmails,
      bouncedEmails,
      averageResponseTimeMinutes: averageResponse,
      averageFirstResponseTimeMinutes: averageResponse,
      editedAiResponsesCount,
      automationRate,
      confidenceDistribution: {
        high: highConf,
        medium: medConf,
        low: lowConf,
      },
      volumeByDay: Array.from(dayMap.entries()).sort(([a], [b]) => a.localeCompare(b))
        .map(([date, volume]) => ({ date, ...volume })),
      volumeByAgent: Array.from(agentMap.entries()).map(([agentId, count]) => ({
        agentId,
        agentName: accounts.find((account) => account.agentId === agentId)?.displayName || agentId,
        count,
      })),
      volumeByAccount: accounts.map((a) => ({
        accountId: a.id,
        email: a.emailAddress,
        count: accountMap.get(a.id) || 0,
      })),
    };
  }
}
