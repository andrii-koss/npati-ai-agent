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

const accountCols = `
  id, workspace_id AS "workspaceId", company_id AS "companyId", user_id AS "userId",
  email_address AS "emailAddress", display_name AS "displayName", agent_id AS "agentId",
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

const messageCols = `
  id, workspace_id AS "workspaceId", company_id AS "companyId",
  thread_id AS "threadId", email_account_id AS "emailAccountId", message_id AS "messageId",
  in_reply_to AS "inReplyTo", direction, from_address AS "fromAddress",
  from_name AS "fromName", to_addresses AS "toAddresses", cc_addresses AS "ccAddresses",
  bcc_addresses AS "bccAddresses", subject, body_text AS "bodyText", body_html AS "bodyHtml",
  attachments, delivery_status AS "deliveryStatus", delivery_error AS "deliveryError",
  is_draft AS "isDraft", is_ai_generated AS "isAiGenerated",
  ai_draft_approved_by AS "aiDraftApprovedBy", sent_by_user_id AS "sentByUserId",
  sent_by_agent_id AS "sentByAgentId", created_at AS "createdAt"
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

export function subjectCompareKey(subject?: string | null): string {
  const norm = normalizeEmailSubject(subject);
  return norm.toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function extractCandidateMessageIds(headerValue?: string | null): string[] {
  if (!headerValue || typeof headerValue !== "string") return [];
  const candidates = new Set<string>();
  const trimmed = headerValue.trim();
  if (!trimmed) return [];

  const bracketMatches = trimmed.match(/<([^>]+)>/g);
  if (bracketMatches) {
    for (const match of bracketMatches) {
      candidates.add(match);
      const inside = match.replace(/[<>]/g, "").trim();
      if (inside) {
        candidates.add(inside);
        const localPart = inside.split("@")[0]?.trim();
        if (localPart) candidates.add(localPart);
      }
    }
  }

  for (const part of trimmed.split(/[\s,]+/)) {
    const clean = part.replace(/[<>]/g, "").trim();
    if (clean) {
      candidates.add(clean);
      candidates.add(`<${clean}>`);
      const localPart = clean.split("@")[0]?.trim();
      if (localPart) candidates.add(localPart);
    }
  }

  return Array.from(candidates);
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

  constructor(databaseUrl?: string, pool?: Pool, vault: CryptoVault = defaultVault) {
    this.vault = vault;
    if (pool) {
      this.pool = pool;
    } else if (databaseUrl && databaseUrl.trim().length > 0) {
      this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
    }
  }

  private encryptAccountSecrets(account: CompanyEmailAccount): CompanyEmailAccount {
    const encrypt = (value?: string) => {
      if (!value || value.startsWith("v1$")) return value;
      return this.vault.encrypt(value);
    };
    return {
      ...account,
      imapConfig: { ...account.imapConfig, password: encrypt(account.imapConfig.password),
        accessToken: encrypt(account.imapConfig.accessToken), refreshToken: encrypt(account.imapConfig.refreshToken),
        clientSecret: encrypt(account.imapConfig.clientSecret) },
      smtpConfig: { ...account.smtpConfig, password: encrypt(account.smtpConfig.password),
        accessToken: encrypt(account.smtpConfig.accessToken), refreshToken: encrypt(account.smtpConfig.refreshToken),
        clientSecret: encrypt(account.smtpConfig.clientSecret) },
    };
  }

  private decryptAccountSecrets(account: CompanyEmailAccount): CompanyEmailAccount {
    const decrypt = (value?: string) => {
      if (!value || !value.startsWith("v1$")) return value;
      return this.vault.decrypt(value);
    };
    return {
      ...account,
      imapConfig: { ...account.imapConfig, password: decrypt(account.imapConfig.password),
        accessToken: decrypt(account.imapConfig.accessToken), refreshToken: decrypt(account.imapConfig.refreshToken),
        clientSecret: decrypt(account.imapConfig.clientSecret) },
      smtpConfig: { ...account.smtpConfig, password: decrypt(account.smtpConfig.password),
        accessToken: decrypt(account.smtpConfig.accessToken), refreshToken: decrypt(account.smtpConfig.refreshToken),
        clientSecret: decrypt(account.smtpConfig.clientSecret) },
    };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => undefined);
    }
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
    this.memoryOAuthStates.set(input.stateHash, { workspaceId: ctx.workspaceId, companyId, accountId, userId: ctx.userId,
      verifier: input.verifier, tokenUrl: input.tokenUrl, clientId: input.clientId, clientSecret: input.clientSecret,
      redirectUri: input.redirectUri, expiresAt: input.expiresAt });
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
      return { ...row, verifier: this.vault.decrypt(row.encryptedVerifier),
        clientSecret: row.encryptedClientSecret ? this.vault.decrypt(row.encryptedClientSecret) : undefined };
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
        maxPerRecipientDaily: 5,
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
          agent_id, mode, status, test_mode, confidence_threshold, language_mode,
          fallback_language, imap_config, smtp_config, rate_limits,
          signature_config, followup_config, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20
        ) RETURNING ${accountCols}`,
        [
          account.id,
          account.workspaceId,
          account.companyId,
          account.userId,
          account.emailAddress,
          account.displayName,
          account.agentId,
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
          display_name = $1, agent_id = $2, mode = $3, status = $4,
          test_mode = $5, confidence_threshold = $6, language_mode = $7,
          fallback_language = $8, imap_config = $9, smtp_config = $10,
          rate_limits = $11, signature_config = $12, followup_config = $13,
          updated_at = $14
        WHERE workspace_id = $15 AND company_id = $16 AND id = $17
        RETURNING ${accountCols}`,
        [
          updated.displayName,
          updated.agentId,
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
    await this.consolidateCustomerDuplicates(ctx, companyId).catch(() => undefined);

    if (this.pool) {
      const conditions: string[] = ["workspace_id = $1", "company_id = $2"];
      const params: any[] = [ctx.workspaceId, companyId];

      if (filter.folder) {
        params.push(filter.folder);
        conditions.push(`folder = $${params.length}`);
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
        SELECT ${threadCols} FROM company_email_threads
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

    if (filter.folder) items = items.filter((t) => t.folder === filter.folder);
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

    return items.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()).slice(0, limit);
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

  async mergeThreads(
    ctx: AuthContext,
    companyId: string,
    targetThreadId: string,
    sourceThreadId: string
  ): Promise<void> {
    if (!targetThreadId || !sourceThreadId || targetThreadId === sourceThreadId) return;
    if (this.pool) {
      await this.pool.query(
        `UPDATE company_email_messages SET thread_id = $1 WHERE workspace_id = $2 AND thread_id = $3`,
        [targetThreadId, ctx.workspaceId, sourceThreadId]
      );
      await this.pool.query(
        `DELETE FROM company_email_threads WHERE workspace_id = $1 AND id = $2`,
        [ctx.workspaceId, sourceThreadId]
      );
      return;
    }
    for (const m of this.memoryMessages.values()) {
      if (m.threadId === sourceThreadId) {
        m.threadId = targetThreadId;
      }
    }
    this.memoryThreads.delete(sourceThreadId);
  }

  async consolidateCustomerDuplicates(ctx: AuthContext, companyId: string): Promise<void> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailThread>(
        `SELECT ${threadCols} FROM company_email_threads
         WHERE workspace_id = $1
         ORDER BY last_message_at DESC
         LIMIT 100`,
        [ctx.workspaceId]
      );
      const threads = result.rows;
      const seen = new Map<string, CompanyEmailThread>();
      for (const t of threads) {
        const compare = subjectCompareKey(t.subject);
        if (!compare) continue;
        const key = `${t.customerEmail.toLowerCase()}:${compare}`;
        const existing = seen.get(key);
        if (existing) {
          const target = existing.folder === "inbox" ? existing : t;
          const source = target === existing ? t : existing;
          await this.mergeThreads(ctx, companyId, target.id, source.id);
          seen.set(key, target);
        } else {
          seen.set(key, t);
        }
      }
    }
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
         WHERE workspace_id = $1
           AND (message_id = ANY($2::text[]) OR id::text = ANY($2::text[]))
         ORDER BY created_at DESC
         LIMIT 1`,
        [ctx.workspaceId, idList]
      );
      return result.rows[0] ?? null;
    }

    for (const m of this.memoryMessages.values()) {
      if (m.workspaceId === ctx.workspaceId) {
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
    limit = 25
  ): Promise<CompanyEmailThread[]> {
    const cleanEmail = customerEmail.trim().toLowerCase();
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailThread>(
        `SELECT ${threadCols} FROM company_email_threads
         WHERE workspace_id = $1
           AND LOWER(customer_email) = $2
         ORDER BY last_message_at DESC
         LIMIT $3`,
        [ctx.workspaceId, cleanEmail, limit]
      );
      return result.rows;
    }
    return Array.from(this.memoryThreads.values())
      .filter((t) => t.workspaceId === ctx.workspaceId && t.customerEmail.toLowerCase() === cleanEmail)
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
    // 1. Try In-Reply-To and References header lookup (Message-ID linkage across workspace)
    if (params.inReplyTo || params.references) {
      const parentMsg = await this.findMessageByReferenceIds(ctx, companyId, [params.inReplyTo, params.references]);
      if (parentMsg?.threadId) {
        const thread = (await this.getThread(ctx, parentMsg.companyId, parentMsg.threadId))
          || (await this.getThread(ctx, companyId, parentMsg.threadId));
        if (thread) return thread;
      }
    }

    const cleanEmail = params.customerEmail.trim().toLowerCase();
    const targetCompare = subjectCompareKey(params.subject);
    const recentThreads = await this.listRecentThreadsForCustomer(ctx, companyId, cleanEmail, 25);

    // 2. Search recent threads for this customer email by normalized subject words
    if (targetCompare) {
      for (const candidate of recentThreads) {
        const candidateCompare = subjectCompareKey(candidate.subject);
        if (candidateCompare && candidateCompare === targetCompare) {
          // Auto-merge any duplicate threads with this customer that share the topic
          for (const other of recentThreads) {
            if (other.id !== candidate.id && subjectCompareKey(other.subject) === targetCompare) {
              await this.mergeThreads(ctx, companyId, candidate.id, other.id);
            }
          }
          return candidate;
        }
      }
    }

    // 3. Try explicit threadKey if provided
    if (params.threadKey) {
      const thread = await this.findThreadByKey(ctx.workspaceId, companyId, params.threadKey);
      if (thread) return thread;
    }

    // 4. Try normalized threadKey and legacy key formats
    const cleanSubject = normalizeEmailSubject(params.subject);
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

    // 5. If this is a reply (subject starts with Re:, Fwd:, etc.) and there is an active ongoing thread
    // with this customer, match the active thread!
    const isReply = /^(re|fwd|fw|aw|antw|wg|odp)\s*[:\-]/i.test(params.subject.trim());
    if (isReply) {
      const activeRecent = recentThreads.find((t) => t.status !== "closed" && t.folder !== "spam");
      if (activeRecent) {
        return activeRecent;
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
      await this.pool.query(
        `DELETE FROM company_email_threads WHERE workspace_id = $1 AND company_id = $2 AND id = $3`,
        [ctx.workspaceId, companyId, threadId]
      );
      return;
    }

    this.memoryThreads.delete(threadId);
    // Also remove associated messages
    for (const [msgId, msg] of this.memoryMessages.entries()) {
      if (msg.threadId === threadId) {
        this.memoryMessages.delete(msgId);
      }
    }
  }

  // =========================================================================
  // 3. Collision Protection, Locks & Takeover (Items 11 & 26)
  // =========================================================================

  async acquireLock(ctx: AuthContext, companyId: string, threadId: string): Promise<boolean> {
    const thread = await this.getThread(ctx, companyId, threadId);
    if (!thread) return false;

    const now = new Date();
    // If locked by someone else within the last 5 minutes, cannot acquire
    if (
      thread.lockedByUserId &&
      thread.lockedByUserId !== ctx.userId &&
      thread.lockedAt &&
      now.getTime() - new Date(thread.lockedAt).getTime() < 300_000
    ) {
      return false;
    }

    await this.updateThread(ctx, companyId, threadId, {
      lockedByUserId: ctx.userId,
      lockedAt: now.toISOString(),
    });
    return true;
  }

  async releaseLock(ctx: AuthContext, companyId: string, threadId: string): Promise<void> {
    const thread = await this.getThread(ctx, companyId, threadId);
    if (thread && thread.lockedByUserId === ctx.userId) {
      await this.updateThread(ctx, companyId, threadId, {
        lockedByUserId: null,
        lockedAt: null,
      });
    }
  }

  async setHumanTakeover(ctx: AuthContext, companyId: string, threadId: string, takeover: boolean): Promise<CompanyEmailThread> {
    return this.updateThread(ctx, companyId, threadId, {
      isHumanTakeover: takeover,
      status: takeover ? "waiting_human" : "new",
      lockedByUserId: takeover ? ctx.userId : null,
      lockedAt: takeover ? new Date().toISOString() : null,
    });
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
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailMessage>(
        `SELECT ${messageCols} FROM company_email_messages
         WHERE workspace_id = $1 AND company_id = $2 AND thread_id = $3
         ORDER BY created_at ASC`,
        [ctx.workspaceId, companyId, threadId]
      );
      return result.rows;
    }

    return Array.from(this.memoryMessages.values())
      .filter((m) => m.workspaceId === ctx.workspaceId && m.companyId === companyId && m.threadId === threadId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  async getMessage(ctx: AuthContext, companyId: string, messageId: string): Promise<CompanyEmailMessage | null> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailMessage>(
        `SELECT ${messageCols} FROM company_email_messages
         WHERE workspace_id=$1 AND company_id=$2 AND id=$3`,
        [ctx.workspaceId, companyId, messageId]
      );
      return result.rows[0] ?? null;
    }
    const message = this.memoryMessages.get(messageId);
    return message && message.workspaceId === ctx.workspaceId && message.companyId === companyId ? message : null;
  }

  async findMessageByExternalId(
    ctx: AuthContext,
    companyId: string,
    externalMessageId: string
  ): Promise<CompanyEmailMessage | null> {
    const normalizedMessageId = externalMessageId.trim();
    if (!normalizedMessageId) return null;

    if (this.pool) {
      const result = await this.pool.query<CompanyEmailMessage>(
        `SELECT ${messageCols} FROM company_email_messages
         WHERE workspace_id = $1 AND company_id = $2 AND message_id = $3
         ORDER BY created_at ASC
         LIMIT 1`,
        [ctx.workspaceId, companyId, normalizedMessageId]
      );
      return result.rows[0] ?? null;
    }

    return (
      Array.from(this.memoryMessages.values()).find(
        (message) =>
          message.workspaceId === ctx.workspaceId &&
          message.companyId === companyId &&
          message.messageId === normalizedMessageId
      ) ?? null
    );
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
    const id = input.id || randomUUID();
    const now = new Date().toISOString();

    const message: CompanyEmailMessage = {
      id,
      workspaceId: ctx.workspaceId,
      companyId,
      threadId: input.threadId,
      emailAccountId: input.emailAccountId || null,
      messageId: input.messageId || `msg_${randomUUID()}`,
      inReplyTo: input.inReplyTo || null,
      direction: input.direction,
      fromAddress: input.fromAddress.trim().toLowerCase(),
      fromName: input.fromName || null,
      toAddresses: input.toAddresses.map((a) => a.trim().toLowerCase()),
      ccAddresses: input.ccAddresses || [],
      bccAddresses: input.bccAddresses || [],
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml || null,
      attachments: input.attachments || [],
      deliveryStatus: input.deliveryStatus || (input.direction === "outbound" ? "sent" : "delivered"),
      deliveryError: input.deliveryError || null,
      isDraft: input.isDraft ?? false,
      isAiGenerated: input.isAiGenerated ?? false,
      aiDraftApprovedBy: input.aiDraftApprovedBy || null,
      sentByUserId: input.sentByUserId || null,
      sentByAgentId: input.sentByAgentId || null,
      createdAt: now,
    };

    if (this.pool) {
      const result = await this.pool.query<CompanyEmailMessage>(
        `INSERT INTO company_email_messages (
          id, workspace_id, company_id, thread_id, email_account_id, message_id,
          in_reply_to, direction, from_address, from_name, to_addresses,
          cc_addresses, bcc_addresses, subject, body_text, body_html,
          attachments, delivery_status, delivery_error, is_draft,
          is_ai_generated, ai_draft_approved_by, sent_by_user_id, sent_by_agent_id, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
        ) RETURNING ${messageCols}`,
        [
          message.id,
          message.workspaceId,
          message.companyId,
          message.threadId,
          message.emailAccountId,
          message.messageId,
          message.inReplyTo,
          message.direction,
          message.fromAddress,
          message.fromName,
          message.toAddresses,
          message.ccAddresses,
          message.bccAddresses,
          message.subject,
          message.bodyText,
          message.bodyHtml,
          JSON.stringify(message.attachments),
          message.deliveryStatus,
          message.deliveryError,
          message.isDraft,
          message.isAiGenerated,
          message.aiDraftApprovedBy,
          message.sentByUserId,
          message.sentByAgentId,
          message.createdAt,
        ]
      );

      // Update thread lastMessageAt
      await this.pool.query(
        `UPDATE company_email_threads SET last_message_at = $1, updated_at = $1 WHERE id = $2`,
        [now, message.threadId]
      );

      return result.rows[0]!;
    }

    this.memoryMessages.set(id, message);
    const th = this.memoryThreads.get(message.threadId);
    if (th) {
      th.lastMessageAt = now;
      th.updatedAt = now;
    }
    return message;
  }

  async updateMessage(
    ctx: AuthContext,
    companyId: string,
    messageId: string,
    patch: Partial<CompanyEmailMessage>
  ): Promise<CompanyEmailMessage> {
    if (this.pool) {
      const existing = (
        await this.pool.query<CompanyEmailMessage>(
          `SELECT ${messageCols} FROM company_email_messages WHERE workspace_id = $1 AND company_id = $2 AND id = $3`,
          [ctx.workspaceId, companyId, messageId]
        )
      ).rows[0];
      if (!existing) throw new Error("Message not found.");

      const updated = { ...existing, ...patch };
      const result = await this.pool.query<CompanyEmailMessage>(
        `UPDATE company_email_messages SET
          body_text = $1, body_html = $2, is_draft = $3, delivery_status = $4,
          delivery_error = $5, ai_draft_approved_by = $6, sent_by_user_id = $7
        WHERE workspace_id = $8 AND company_id = $9 AND id = $10
        RETURNING ${messageCols}`,
        [
          updated.bodyText,
          updated.bodyHtml,
          updated.isDraft,
          updated.deliveryStatus,
          updated.deliveryError,
          updated.aiDraftApprovedBy,
          updated.sentByUserId,
          ctx.workspaceId,
          companyId,
          messageId,
        ]
      );
      return result.rows[0]!;
    }

    const item = this.memoryMessages.get(messageId);
    if (!item) throw new Error("Message not found.");
    const updated = { ...item, ...patch };
    this.memoryMessages.set(messageId, updated);
    return updated;
  }

  // =========================================================================
  // 5. Contacts & Customer Cards (Items 10 & 20)
  // =========================================================================

  async listContacts(ctx: AuthContext, companyId: string): Promise<CompanyEmailContact[]> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailContact>(
        `SELECT id, workspace_id AS "workspaceId", company_id AS "companyId", email,
                name, company_name AS "companyName", phone, is_vip AS "isVip",
                is_blacklisted AS "isBlacklisted", notes, last_activity_at AS "lastActivityAt",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM company_email_contacts
         WHERE workspace_id = $1 AND company_id = $2
         ORDER BY is_vip DESC, last_activity_at DESC NULLS LAST, email ASC`,
        [ctx.workspaceId, companyId]
      );
      return result.rows;
    }

    return Array.from(this.memoryContacts.values())
      .filter((contact) => contact.workspaceId === ctx.workspaceId && contact.companyId === companyId)
      .sort((a, b) => {
        if (a.isVip !== b.isVip) return a.isVip ? -1 : 1;
        const activityDelta = new Date(b.lastActivityAt || 0).getTime() - new Date(a.lastActivityAt || 0).getTime();
        return activityDelta || a.email.localeCompare(b.email);
      });
  }

  async getContact(ctx: AuthContext, companyId: string, email: string): Promise<CompanyEmailContact | null> {
    const cleanEmail = email.trim().toLowerCase();
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailContact>(
        `SELECT id, workspace_id AS "workspaceId", company_id AS "companyId", email,
                name, company_name AS "companyName", phone, is_vip AS "isVip",
                is_blacklisted AS "isBlacklisted", notes, last_activity_at AS "lastActivityAt",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM company_email_contacts
         WHERE workspace_id = $1 AND company_id = $2 AND email = $3`,
        [ctx.workspaceId, companyId, cleanEmail]
      );
      const contact = result.rows[0];
      if (!contact) return null;
      const countResult = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM company_email_threads
         WHERE workspace_id = $1 AND company_id = $2 AND customer_email = $3`,
        [ctx.workspaceId, companyId, cleanEmail]
      );
      return { ...contact, previousThreadsCount: Number(countResult.rows[0]?.count || 0) };
    }

    const key = `${ctx.workspaceId}:${companyId}:${cleanEmail}`;
    const contact = this.memoryContacts.get(key);
    if (!contact) return null;
    const previousThreadsCount = Array.from(this.memoryThreads.values()).filter((thread) =>
      thread.workspaceId === ctx.workspaceId && thread.companyId === companyId && thread.customerEmail === cleanEmail).length;
    return { ...contact, previousThreadsCount };
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
    const cleanEmail = contactData.email.trim().toLowerCase();
    const existing = await this.getContact(ctx, companyId, cleanEmail);
    const now = new Date().toISOString();
    const id = existing?.id || randomUUID();

    const contact: CompanyEmailContact = {
      id,
      workspaceId: ctx.workspaceId,
      companyId,
      email: cleanEmail,
      name: contactData.name ?? existing?.name ?? null,
      companyName: contactData.companyName ?? existing?.companyName ?? null,
      phone: contactData.phone ?? existing?.phone ?? null,
      isVip: contactData.isVip ?? existing?.isVip ?? false,
      isBlacklisted: contactData.isBlacklisted ?? existing?.isBlacklisted ?? false,
      notes: contactData.notes ?? existing?.notes ?? null,
      lastActivityAt: now,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    if (this.pool) {
      const result = await this.pool.query<CompanyEmailContact>(
        `INSERT INTO company_email_contacts (
          id, workspace_id, company_id, email, name, company_name, phone,
          is_vip, is_blacklisted, notes, last_activity_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (workspace_id, company_id, email) DO UPDATE SET
          name = EXCLUDED.name, company_name = EXCLUDED.company_name, phone = EXCLUDED.phone,
          is_vip = EXCLUDED.is_vip, is_blacklisted = EXCLUDED.is_blacklisted,
          notes = EXCLUDED.notes, last_activity_at = EXCLUDED.last_activity_at, updated_at = EXCLUDED.updated_at
        RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId", email,
                  name, company_name AS "companyName", phone, is_vip AS "isVip",
                  is_blacklisted AS "isBlacklisted", notes, last_activity_at AS "lastActivityAt",
                  created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          contact.id,
          contact.workspaceId,
          contact.companyId,
          contact.email,
          contact.name,
          contact.companyName,
          contact.phone,
          contact.isVip,
          contact.isBlacklisted,
          contact.notes,
          contact.lastActivityAt,
          contact.createdAt,
          contact.updatedAt,
        ]
      );
      return result.rows[0]!;
    }

    const key = `${ctx.workspaceId}:${companyId}:${cleanEmail}`;
    this.memoryContacts.set(key, contact);
    return contact;
  }

  // =========================================================================
  // 6. Templates & Signatures (Item 13)
  // =========================================================================

  async listTemplates(ctx: AuthContext, companyId: string): Promise<CompanyEmailTemplate[]> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailTemplate>(
        `SELECT id, workspace_id AS "workspaceId", company_id AS "companyId",
                email_account_id AS "emailAccountId", title, category,
                subject_template AS "subjectTemplate", body_template AS "bodyTemplate",
                created_at AS "createdAt"
         FROM company_email_templates
         WHERE workspace_id = $1 AND company_id = $2
         ORDER BY title ASC`,
        [ctx.workspaceId, companyId]
      );
      return result.rows;
    }

    return Array.from(this.memoryTemplates.values()).filter(
      (t) => t.workspaceId === ctx.workspaceId && t.companyId === companyId
    );
  }

  async createTemplate(
    ctx: AuthContext,
    companyId: string,
    input: { title: string; category?: string; subjectTemplate?: string; bodyTemplate: string; emailAccountId?: string }
  ): Promise<CompanyEmailTemplate> {
    const id = randomUUID();
    const template: CompanyEmailTemplate = {
      id,
      workspaceId: ctx.workspaceId,
      companyId,
      emailAccountId: input.emailAccountId || null,
      title: input.title.trim(),
      category: (input.category as any) || "general",
      subjectTemplate: input.subjectTemplate || null,
      bodyTemplate: input.bodyTemplate,
      createdAt: new Date().toISOString(),
    };

    if (this.pool) {
      const result = await this.pool.query<CompanyEmailTemplate>(
        `INSERT INTO company_email_templates (
          id, workspace_id, company_id, email_account_id, title, category, subject_template, body_template
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId",
                  email_account_id AS "emailAccountId", title, category,
                  subject_template AS "subjectTemplate", body_template AS "bodyTemplate",
                  created_at AS "createdAt"`,
        [
          template.id,
          template.workspaceId,
          template.companyId,
          template.emailAccountId,
          template.title,
          template.category,
          template.subjectTemplate,
          template.bodyTemplate,
        ]
      );
      return result.rows[0]!;
    }

    this.memoryTemplates.set(id, template);
    return template;
  }

  async deleteTemplate(ctx: AuthContext, companyId: string, templateId: string): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        `DELETE FROM company_email_templates WHERE workspace_id = $1 AND company_id = $2 AND id = $3`,
        [ctx.workspaceId, companyId, templateId]
      );
      return;
    }
    this.memoryTemplates.delete(templateId);
  }

  async updateTemplate(
    ctx: AuthContext,
    companyId: string,
    templateId: string,
    patch: { title?: string; category?: string; subjectTemplate?: string | null; bodyTemplate?: string }
  ): Promise<CompanyEmailTemplate> {
    const templates = await this.listTemplates(ctx, companyId);
    const existing = templates.find((t) => t.id === templateId);
    if (!existing) throw new Error("Template not found.");

    const updated: CompanyEmailTemplate = {
      ...existing,
      title: patch.title !== undefined ? patch.title.trim() : existing.title,
      category: (patch.category as any) ?? existing.category,
      subjectTemplate: patch.subjectTemplate !== undefined ? patch.subjectTemplate : existing.subjectTemplate,
      bodyTemplate: patch.bodyTemplate !== undefined ? patch.bodyTemplate : existing.bodyTemplate,
    };

    if (this.pool) {
      const result = await this.pool.query<CompanyEmailTemplate>(
        `UPDATE company_email_templates SET
          title = $1, category = $2, subject_template = $3, body_template = $4
         WHERE workspace_id = $5 AND company_id = $6 AND id = $7
         RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId",
                   email_account_id AS "emailAccountId", title, category,
                   subject_template AS "subjectTemplate", body_template AS "bodyTemplate",
                   created_at AS "createdAt"`,
        [
          updated.title,
          updated.category,
          updated.subjectTemplate,
          updated.bodyTemplate,
          ctx.workspaceId,
          companyId,
          templateId,
        ]
      );
      return result.rows[0]!;
    }

    this.memoryTemplates.set(templateId, updated);
    return updated;
  }

  // =========================================================================
  // 7. Email Rules (Item 25)
  // =========================================================================

  async listRules(ctx: AuthContext, companyId: string): Promise<CompanyEmailRule[]> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailRule>(
        `SELECT id, workspace_id AS "workspaceId", company_id AS "companyId",
                email_account_id AS "emailAccountId", name, priority_order AS "priorityOrder",
                is_active AS "isActive", conditions, actions, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM company_email_rules
         WHERE workspace_id = $1 AND company_id = $2
         ORDER BY priority_order ASC`,
        [ctx.workspaceId, companyId]
      );
      return result.rows;
    }

    return Array.from(this.memoryRules.values())
      .filter((r) => r.workspaceId === ctx.workspaceId && r.companyId === companyId)
      .sort((a, b) => a.priorityOrder - b.priorityOrder);
  }

  async createRule(
    ctx: AuthContext,
    companyId: string,
    input: { name: string; emailAccountId?: string; conditions?: any; actions?: any; priorityOrder?: number }
  ): Promise<CompanyEmailRule> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const rule: CompanyEmailRule = {
      id,
      workspaceId: ctx.workspaceId,
      companyId,
      emailAccountId: input.emailAccountId || null,
      name: input.name.trim(),
      priorityOrder: input.priorityOrder ?? 0,
      isActive: true,
      conditions: input.conditions || {},
      actions: input.actions || {},
      createdAt: now,
      updatedAt: now,
    };

    if (this.pool) {
      const result = await this.pool.query<CompanyEmailRule>(
        `INSERT INTO company_email_rules (
          id, workspace_id, company_id, email_account_id, name, priority_order, is_active, conditions, actions, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId",
                  email_account_id AS "emailAccountId", name, priority_order AS "priorityOrder",
                  is_active AS "isActive", conditions, actions, created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          rule.id,
          rule.workspaceId,
          rule.companyId,
          rule.emailAccountId,
          rule.name,
          rule.priorityOrder,
          rule.isActive,
          JSON.stringify(rule.conditions),
          JSON.stringify(rule.actions),
          rule.createdAt,
          rule.updatedAt,
        ]
      );
      return result.rows[0]!;
    }

    this.memoryRules.set(id, rule);
    return rule;
  }

  async deleteRule(ctx: AuthContext, companyId: string, ruleId: string): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        `DELETE FROM company_email_rules WHERE workspace_id = $1 AND company_id = $2 AND id = $3`,
        [ctx.workspaceId, companyId, ruleId]
      );
      return;
    }
    this.memoryRules.delete(ruleId);
  }

  async updateRule(
    ctx: AuthContext,
    companyId: string,
    ruleId: string,
    patch: { name?: string; conditions?: any; actions?: any; isActive?: boolean; priorityOrder?: number }
  ): Promise<CompanyEmailRule> {
    const rules = await this.listRules(ctx, companyId);
    const existing = rules.find((r) => r.id === ruleId);
    if (!existing) throw new Error("Rule not found.");

    const now = new Date().toISOString();
    const updated: CompanyEmailRule = {
      ...existing,
      name: patch.name !== undefined ? patch.name.trim() : existing.name,
      conditions: patch.conditions !== undefined ? patch.conditions : existing.conditions,
      actions: patch.actions !== undefined ? patch.actions : existing.actions,
      isActive: patch.isActive !== undefined ? patch.isActive : existing.isActive,
      priorityOrder: patch.priorityOrder !== undefined ? patch.priorityOrder : existing.priorityOrder,
      updatedAt: now,
    };

    if (this.pool) {
      const result = await this.pool.query<CompanyEmailRule>(
        `UPDATE company_email_rules SET
          name = $1, conditions = $2, actions = $3, is_active = $4, priority_order = $5, updated_at = $6
         WHERE workspace_id = $7 AND company_id = $8 AND id = $9
         RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId",
                   email_account_id AS "emailAccountId", name, priority_order AS "priorityOrder",
                   is_active AS "isActive", conditions, actions, created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          updated.name,
          JSON.stringify(updated.conditions),
          JSON.stringify(updated.actions),
          updated.isActive,
          updated.priorityOrder,
          now,
          ctx.workspaceId,
          companyId,
          ruleId,
        ]
      );
      return result.rows[0]!;
    }

    this.memoryRules.set(ruleId, updated);
    return updated;
  }

  // =========================================================================
  // 8. Rate Limits (Item 21)
  // =========================================================================

  async checkRateLimit(
    companyId: string,
    account: CompanyEmailAccount,
    recipientEmail: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    const normalizedRecipient = recipientEmail.trim().toLowerCase();
    if (this.pool) {
      const result = await this.pool.query<{ hour_count: string; day_count: string; recipient_count: string; company_hour_count: string; company_day_count: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 hour' AND email_account_id = $3)::text AS hour_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 day' AND email_account_id = $3)::text AS day_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 day' AND recipient_email = $4)::text AS recipient_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 hour')::text AS company_hour_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 day')::text AS company_day_count
         FROM company_email_send_events
         WHERE workspace_id = $1 AND company_id = $2`,
        [account.workspaceId, companyId, account.id, normalizedRecipient]
      );
      const sentLastHour = Number(result.rows[0]?.hour_count || 0);
      const sentLastDay = Number(result.rows[0]?.day_count || 0);
      const sentToRecipient = Number(result.rows[0]?.recipient_count || 0);
      const companyLastHour = Number(result.rows[0]?.company_hour_count || 0);
      const companyLastDay = Number(result.rows[0]?.company_day_count || 0);
      if (companyLastHour >= (account.rateLimits.maxCompanyPerHour || 500)) {
        return { allowed: false, reason: `Company hourly limit reached (${companyLastHour}/${account.rateLimits.maxCompanyPerHour || 500} emails).` };
      }
      if (companyLastDay >= (account.rateLimits.maxCompanyPerDay || 5000)) {
        return { allowed: false, reason: `Company daily limit reached (${companyLastDay}/${account.rateLimits.maxCompanyPerDay || 5000} emails).` };
      }
      if (sentLastHour >= (account.rateLimits.maxPerHour || 50)) {
        return { allowed: false, reason: `Hourly limit reached (${sentLastHour}/${account.rateLimits.maxPerHour} emails).` };
      }
      if (sentLastDay >= (account.rateLimits.maxPerDay || 500)) {
        return { allowed: false, reason: `Daily limit reached (${sentLastDay}/${account.rateLimits.maxPerDay} emails).` };
      }
      if (sentToRecipient >= (account.rateLimits.maxPerRecipientDaily || 5)) {
        return {
          allowed: false,
          reason: `Daily limit for recipient ${recipientEmail} reached (${sentToRecipient}/${account.rateLimits.maxPerRecipientDaily}).`,
        };
      }
      return { allowed: true };
    }

    const now = Date.now();
    const oneHourAgo = now - 3600_000;
    const oneDayAgo = now - 86400_000;

    const accountKey = `${companyId}:${account.id}`;
    const companyKey = `${companyId}:company`;
    const recipientKey = `${companyId}:recipient:${recipientEmail.trim().toLowerCase()}`;
    const companySent = (this.sentTimestamps.get(companyKey) || []).filter((t) => t > oneDayAgo);
    this.sentTimestamps.set(companyKey, companySent);
    const companyLastHour = companySent.filter((t) => t > oneHourAgo).length;
    if (companyLastHour >= (account.rateLimits.maxCompanyPerHour || 500)) {
      return { allowed: false, reason: `Company hourly limit reached (${companyLastHour}/${account.rateLimits.maxCompanyPerHour || 500} emails).` };
    }
    if (companySent.length >= (account.rateLimits.maxCompanyPerDay || 5000)) {
      return { allowed: false, reason: `Company daily limit reached (${companySent.length}/${account.rateLimits.maxCompanyPerDay || 5000} emails).` };
    }

    const accountSent = (this.sentTimestamps.get(accountKey) || []).filter((t) => t > oneDayAgo);
    this.sentTimestamps.set(accountKey, accountSent);

    const sentLastHour = accountSent.filter((t) => t > oneHourAgo).length;
    if (sentLastHour >= (account.rateLimits.maxPerHour || 50)) {
      return { allowed: false, reason: `Hourly limit reached (${sentLastHour}/${account.rateLimits.maxPerHour} emails).` };
    }

    if (accountSent.length >= (account.rateLimits.maxPerDay || 500)) {
      return { allowed: false, reason: `Daily limit reached (${accountSent.length}/${account.rateLimits.maxPerDay} emails).` };
    }

    const recipientSent = (this.sentTimestamps.get(recipientKey) || []).filter((t) => t > oneDayAgo);
    this.sentTimestamps.set(recipientKey, recipientSent);

    if (recipientSent.length >= (account.rateLimits.maxPerRecipientDaily || 5)) {
      return {
        allowed: false,
        reason: `Daily limit for recipient ${recipientEmail} reached (${recipientSent.length}/${account.rateLimits.maxPerRecipientDaily}).`,
      };
    }

    return { allowed: true };
  }

  async recordSentEmail(companyId: string, accountId: string, recipientEmail: string): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO company_email_send_events (
           id, workspace_id, company_id, email_account_id, recipient_email, sent_at
         )
         SELECT $1, workspace_id, company_id, id, $3, now()
         FROM company_email_accounts
         WHERE id = $2 AND company_id = $4 AND deleted_at IS NULL`,
        [randomUUID(), accountId, recipientEmail.trim().toLowerCase(), companyId]
      );
      return;
    }

    const now = Date.now();
    const accountKey = `${companyId}:${accountId}`;
    const companyKey = `${companyId}:company`;
    const recipientKey = `${companyId}:recipient:${recipientEmail.trim().toLowerCase()}`;

    const companyEvents = this.sentTimestamps.get(companyKey) || [];
    companyEvents.push(now);
    this.sentTimestamps.set(companyKey, companyEvents);

    const acc = this.sentTimestamps.get(accountKey) || [];
    acc.push(now);
    this.sentTimestamps.set(accountKey, acc);

    const rec = this.sentTimestamps.get(recipientKey) || [];
    rec.push(now);
    this.sentTimestamps.set(recipientKey, rec);
  }

  async reserveSendQuota(
    companyId: string,
    account: CompanyEmailAccount,
    recipientEmail: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.pool) {
      const result = await this.checkRateLimit(companyId, account, recipientEmail);
      if (result.allowed) await this.recordSentEmail(companyId, account.id, recipientEmail);
      return result;
    }

    const client = await this.pool.connect();
    const recipient = recipientEmail.trim().toLowerCase();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `email-rate:${account.workspaceId}:${companyId}`,
      ]);
      const counts = await client.query<{ hour_count: string; day_count: string; recipient_count: string; company_hour_count: string; company_day_count: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 hour' AND email_account_id = $3)::text AS hour_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 day' AND email_account_id = $3)::text AS day_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 day' AND recipient_email = $4)::text AS recipient_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 hour')::text AS company_hour_count,
           COUNT(*) FILTER (WHERE sent_at > now() - interval '1 day')::text AS company_day_count
         FROM company_email_send_events
         WHERE workspace_id = $1 AND company_id = $2`,
        [account.workspaceId, companyId, account.id, recipient]
      );
      const hourCount = Number(counts.rows[0]?.hour_count || 0);
      const dayCount = Number(counts.rows[0]?.day_count || 0);
      const recipientCount = Number(counts.rows[0]?.recipient_count || 0);
      const companyHourCount = Number(counts.rows[0]?.company_hour_count || 0);
      const companyDayCount = Number(counts.rows[0]?.company_day_count || 0);
      let deniedReason: string | undefined;
      if (companyHourCount >= (account.rateLimits.maxCompanyPerHour || 500)) {
        deniedReason = `Company hourly limit reached (${companyHourCount}/${account.rateLimits.maxCompanyPerHour || 500} emails).`;
      } else if (companyDayCount >= (account.rateLimits.maxCompanyPerDay || 5000)) {
        deniedReason = `Company daily limit reached (${companyDayCount}/${account.rateLimits.maxCompanyPerDay || 5000} emails).`;
      } else if (hourCount >= (account.rateLimits.maxPerHour || 50)) {
        deniedReason = `Hourly limit reached (${hourCount}/${account.rateLimits.maxPerHour} emails).`;
      } else if (dayCount >= (account.rateLimits.maxPerDay || 500)) {
        deniedReason = `Daily limit reached (${dayCount}/${account.rateLimits.maxPerDay} emails).`;
      } else if (recipientCount >= (account.rateLimits.maxPerRecipientDaily || 5)) {
        deniedReason = `Daily limit for recipient ${recipientEmail} reached (${recipientCount}/${account.rateLimits.maxPerRecipientDaily}).`;
      }
      if (deniedReason) {
        await client.query("COMMIT");
        return { allowed: false, reason: deniedReason };
      }

      await client.query(
        `INSERT INTO company_email_send_events
          (id, workspace_id, company_id, email_account_id, recipient_email, sent_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [randomUUID(), account.workspaceId, companyId, account.id, recipient]
      );
      await client.query("COMMIT");
      return { allowed: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
    const now = new Date().toISOString();
    const job: CompanyEmailJob = {
      id: randomUUID(), workspaceId: ctx.workspaceId, companyId,
      emailAccountId: input.emailAccountId || null, threadId: input.threadId || null,
      messageId: input.messageId || null, jobType: input.jobType, status: "queued",
      payload: input.payload || {}, attemptCount: 0, maxAttempts: input.maxAttempts ?? 5,
      runAfter: input.runAfter || now, lockedAt: null, lockedBy: null, lastError: null,
      idempotencyKey: input.idempotencyKey || null, createdAt: now, updatedAt: now,
    };
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailJob>(
        `INSERT INTO company_email_jobs (
           id, workspace_id, company_id, email_account_id, thread_id, message_id,
           job_type, status, payload, attempt_count, max_attempts, run_after,
           idempotency_key, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,0,$9,$10,$11,$12,$12)
         ON CONFLICT (workspace_id, company_id, idempotency_key) DO UPDATE
           SET updated_at = company_email_jobs.updated_at
         RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId",
           email_account_id AS "emailAccountId", thread_id AS "threadId", message_id AS "messageId",
           job_type AS "jobType", status, payload, attempt_count AS "attemptCount",
           max_attempts AS "maxAttempts", run_after AS "runAfter", locked_at AS "lockedAt",
           locked_by AS "lockedBy", last_error AS "lastError", idempotency_key AS "idempotencyKey",
           created_at AS "createdAt", updated_at AS "updatedAt"`,
        [job.id, job.workspaceId, job.companyId, job.emailAccountId, job.threadId, job.messageId,
          job.jobType, JSON.stringify(job.payload), job.maxAttempts, job.runAfter,
          job.idempotencyKey, now]
      );
      return result.rows[0]!;
    }
    if (job.idempotencyKey) {
      const existing = Array.from(this.memoryJobs.values()).find((item) =>
        item.workspaceId === ctx.workspaceId && item.companyId === companyId && item.idempotencyKey === job.idempotencyKey);
      if (existing) return existing;
    }
    this.memoryJobs.set(job.id, job);
    return job;
  }

  async claimJobs(workerId: string, limit = 10): Promise<CompanyEmailJob[]> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailJob>(
        `WITH candidates AS (
           SELECT id FROM company_email_jobs
           WHERE ((status = 'queued' AND run_after <= now())
              OR (status = 'processing' AND locked_at < now() - interval '5 minutes'))
           ORDER BY run_after ASC, created_at ASC
           FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE company_email_jobs j SET status='processing', locked_at=now(), locked_by=$1,
           attempt_count=j.attempt_count+1, updated_at=now()
         FROM candidates c WHERE j.id=c.id
         RETURNING j.id, j.workspace_id AS "workspaceId", j.company_id AS "companyId",
           j.email_account_id AS "emailAccountId", j.thread_id AS "threadId", j.message_id AS "messageId",
           j.job_type AS "jobType", j.status, j.payload, j.attempt_count AS "attemptCount",
           j.max_attempts AS "maxAttempts", j.run_after AS "runAfter", j.locked_at AS "lockedAt",
           j.locked_by AS "lockedBy", j.last_error AS "lastError", j.idempotency_key AS "idempotencyKey",
           j.created_at AS "createdAt", j.updated_at AS "updatedAt"`,
        [workerId, Math.max(1, Math.min(limit, 100))]
      );
      return result.rows;
    }
    const now = Date.now();
    const jobs = Array.from(this.memoryJobs.values())
      .filter((job) => job.status === "queued" && new Date(job.runAfter).getTime() <= now)
      .sort((a, b) => new Date(a.runAfter).getTime() - new Date(b.runAfter).getTime())
      .slice(0, limit);
    return jobs.map((job) => {
      const claimed = { ...job, status: "processing" as const, lockedAt: new Date().toISOString(), lockedBy: workerId,
        attemptCount: job.attemptCount + 1, updatedAt: new Date().toISOString() };
      this.memoryJobs.set(job.id, claimed);
      return claimed;
    });
  }

  async completeJob(jobId: string): Promise<void> {
    if (this.pool) {
      await this.pool.query("UPDATE company_email_jobs SET status='completed', locked_at=NULL, locked_by=NULL, updated_at=now() WHERE id=$1", [jobId]);
      return;
    }
    const job = this.memoryJobs.get(jobId);
    if (job) this.memoryJobs.set(jobId, { ...job, status: "completed", lockedAt: null, lockedBy: null, updatedAt: new Date().toISOString() });
  }

  async failJob(job: CompanyEmailJob, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const terminal = job.attemptCount >= job.maxAttempts;
    const delaySeconds = Math.min(300, 2 ** Math.max(0, job.attemptCount - 1));
    if (this.pool) {
      await this.pool.query(
        `UPDATE company_email_jobs SET status=$2, last_error=$3, locked_at=NULL, locked_by=NULL,
           run_after=CASE WHEN $2='queued' THEN now() + ($4 * interval '1 second') ELSE run_after END,
           updated_at=now() WHERE id=$1`,
        [job.id, terminal ? "failed" : "queued", message.slice(0, 2000), delaySeconds]
      );
      return;
    }
    this.memoryJobs.set(job.id, { ...job, status: terminal ? "failed" : "queued",
      lastError: message.slice(0, 2000), lockedAt: null, lockedBy: null,
      runAfter: new Date(Date.now() + delaySeconds * 1000).toISOString(), updatedAt: new Date().toISOString() });
  }

  async cancelPendingFollowups(threadId: string): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        "UPDATE company_email_jobs SET status='cancelled', updated_at=now() WHERE thread_id=$1 AND job_type='followup' AND status IN ('queued','processing')",
        [threadId]
      );
      return;
    }
    for (const [id, job] of this.memoryJobs) {
      if (job.threadId === threadId && job.jobType === "followup" && (job.status === "queued" || job.status === "processing")) {
        this.memoryJobs.set(id, { ...job, status: "cancelled", updatedAt: new Date().toISOString() });
      }
    }
  }

  async createNotification(ctx: AuthContext, companyId: string, input: {
    userId?: string | null; threadId?: string | null;
    notificationType: CompanyEmailNotification["notificationType"]; title: string; body: string;
  }): Promise<CompanyEmailNotification> {
    const notification: CompanyEmailNotification = {
      id: randomUUID(), workspaceId: ctx.workspaceId, companyId, userId: input.userId || null,
      threadId: input.threadId || null, notificationType: input.notificationType,
      title: input.title.trim().slice(0, 300), body: input.body.trim().slice(0, 4000),
      isRead: false, createdAt: new Date().toISOString(),
    };
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailNotification>(
        `INSERT INTO company_email_notifications
          (id, workspace_id, company_id, user_id, thread_id, notification_type, title, body)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, workspace_id AS "workspaceId", company_id AS "companyId", user_id AS "userId",
           thread_id AS "threadId", notification_type AS "notificationType", title, body,
           is_read AS "isRead", created_at AS "createdAt"`,
        [notification.id, notification.workspaceId, companyId, notification.userId, notification.threadId,
          notification.notificationType, notification.title, notification.body]
      );
      return result.rows[0]!;
    }
    this.memoryNotifications.set(notification.id, notification);
    return notification;
  }

  async listNotifications(ctx: AuthContext, companyId: string, limit = 50): Promise<CompanyEmailNotification[]> {
    if (this.pool) {
      return (await this.pool.query<CompanyEmailNotification>(
        `SELECT id, workspace_id AS "workspaceId", company_id AS "companyId", user_id AS "userId",
           thread_id AS "threadId", notification_type AS "notificationType", title, body,
           is_read AS "isRead", created_at AS "createdAt"
         FROM company_email_notifications
         WHERE workspace_id=$1 AND company_id=$2 AND (user_id IS NULL OR user_id=$3)
         ORDER BY created_at DESC LIMIT $4`,
        [ctx.workspaceId, companyId, ctx.userId, Math.max(1, Math.min(limit, 100))]
      )).rows;
    }
    return Array.from(this.memoryNotifications.values()).filter((item) => item.workspaceId === ctx.workspaceId
      && item.companyId === companyId && (!item.userId || item.userId === ctx.userId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async markNotificationRead(ctx: AuthContext, companyId: string, notificationId: string): Promise<void> {
    if (this.pool) {
      await this.pool.query(
        `UPDATE company_email_notifications SET is_read=true
         WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND (user_id IS NULL OR user_id=$4)`,
        [notificationId, ctx.workspaceId, companyId, ctx.userId]
      );
      return;
    }
    const item = this.memoryNotifications.get(notificationId);
    if (item && item.workspaceId === ctx.workspaceId && item.companyId === companyId && (!item.userId || item.userId === ctx.userId)) {
      this.memoryNotifications.set(notificationId, { ...item, isRead: true });
    }
  }

  // =========================================================================
  // 9. Analytics (Item 23)
  // =========================================================================

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
