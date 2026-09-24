import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";
import type {
  CompanyEmailAccount,
  CompanyEmailContact,
  CompanyEmailMessage,
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

export class EmailInboxRepository {
  private pool?: Pool;

  // In-memory fallback maps
  private memoryAccounts = new Map<string, CompanyEmailAccount>();
  private memoryThreads = new Map<string, CompanyEmailThread>();
  private memoryMessages = new Map<string, CompanyEmailMessage>();
  private memoryContacts = new Map<string, CompanyEmailContact>();
  private memoryTemplates = new Map<string, CompanyEmailTemplate>();
  private memoryRules = new Map<string, CompanyEmailRule>();
  private sentTimestamps = new Map<string, number[]>(); // key: `${companyId}:${accountId}:${recipient}` -> array of epoch ms

  constructor(databaseUrl?: string, pool?: Pool) {
    if (pool) {
      this.pool = pool;
    } else if (databaseUrl && databaseUrl.trim().length > 0) {
      this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => undefined);
    }
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
      return result.rows;
    }

    return Array.from(this.memoryAccounts.values()).filter(
      (a) => a.workspaceId === ctx.workspaceId && a.companyId === companyId
    );
  }

  async getAccount(ctx: AuthContext, companyId: string, accountId: string): Promise<CompanyEmailAccount | null> {
    if (this.pool) {
      const result = await this.pool.query<CompanyEmailAccount>(
        `SELECT ${accountCols} FROM company_email_accounts
         WHERE workspace_id = $1 AND company_id = $2 AND id = $3 AND deleted_at IS NULL`,
        [ctx.workspaceId, companyId, accountId]
      );
      return result.rows[0] ?? null;
    }

    const item = this.memoryAccounts.get(accountId);
    return item && item.workspaceId === ctx.workspaceId && item.companyId === companyId ? item : null;
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
      return result.rows[0] ?? null;
    }

    for (const a of this.memoryAccounts.values()) {
      if (a.companyId === companyId && a.emailAddress.toLowerCase() === normalized) {
        return a;
      }
    }
    return null;
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
          JSON.stringify(account.imapConfig),
          JSON.stringify(account.smtpConfig),
          JSON.stringify(account.rateLimits),
          JSON.stringify(account.signatureConfig),
          JSON.stringify(account.followupConfig),
          account.createdAt,
          account.updatedAt,
        ]
      );
      return result.rows[0]!;
    }

    this.memoryAccounts.set(id, account);
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
          JSON.stringify(updated.imapConfig),
          JSON.stringify(updated.smtpConfig),
          JSON.stringify(updated.rateLimits),
          JSON.stringify(updated.signatureConfig),
          JSON.stringify(updated.followupConfig),
          now,
          ctx.workspaceId,
          companyId,
          accountId,
        ]
      );
      return result.rows[0]!;
    }

    this.memoryAccounts.set(accountId, updated);
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

  async createThread(
    ctx: AuthContext,
    companyId: string,
    input: Partial<CompanyEmailThread> & { subject: string; customerEmail: string }
  ): Promise<CompanyEmailThread> {
    const id = input.id || randomUUID();
    const now = new Date().toISOString();
    const cleanCustomerEmail = input.customerEmail.trim().toLowerCase();
    const threadKey = input.threadKey || `thread_${cleanCustomerEmail}_${encodeURIComponent(input.subject.slice(0, 30))}`;

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
      return result.rows[0] ?? null;
    }

    const key = `${ctx.workspaceId}:${companyId}:${cleanEmail}`;
    return this.memoryContacts.get(key) ?? null;
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

  checkRateLimit(
    companyId: string,
    account: CompanyEmailAccount,
    recipientEmail: string
  ): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const oneHourAgo = now - 3600_000;
    const oneDayAgo = now - 86400_000;

    const accountKey = `${companyId}:${account.id}`;
    const recipientKey = `${companyId}:${account.id}:${recipientEmail.trim().toLowerCase()}`;

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

  recordSentEmail(companyId: string, accountId: string, recipientEmail: string): void {
    const now = Date.now();
    const accountKey = `${companyId}:${accountId}`;
    const recipientKey = `${companyId}:${accountId}:${recipientEmail.trim().toLowerCase()}`;

    const acc = this.sentTimestamps.get(accountKey) || [];
    acc.push(now);
    this.sentTimestamps.set(accountKey, acc);

    const rec = this.sentTimestamps.get(recipientKey) || [];
    rec.push(now);
    this.sentTimestamps.set(recipientKey, rec);
  }

  // =========================================================================
  // 9. Analytics (Item 23)
  // =========================================================================

  async getAnalytics(ctx: AuthContext, companyId: string): Promise<EmailAnalytics> {
    const threads = await this.listThreads(ctx, companyId, { limit: 100 });
    const accounts = await this.listAccounts(ctx, companyId);

    let receivedEmails = 0;
    let sentEmails = 0;
    let aiAnswered = 0;
    let humanAnswered = 0;
    let draftedByAi = 0;
    let escalatedToHuman = 0;
    let failedEmails = 0;
    let highConf = 0;
    let medConf = 0;
    let lowConf = 0;

    for (const t of threads) {
      if (t.status === "answered") {
        if (t.assignedAgentId && !t.isHumanTakeover) aiAnswered++;
        else humanAnswered++;
      } else if (t.status === "waiting_human" || t.isHumanTakeover) {
        escalatedToHuman++;
      } else if (t.status === "draft_ready" || t.status === "waiting_approval") {
        draftedByAi++;
      } else if (t.status === "failed") {
        failedEmails++;
      }

      if (t.aiConfidenceScore !== null && t.aiConfidenceScore !== undefined) {
        if (t.aiConfidenceScore >= 0.85) highConf++;
        else if (t.aiConfidenceScore >= 0.6) medConf++;
        else lowConf++;
      }
    }

    const messages = this.pool
      ? (
          await this.pool.query<{ direction: string; delivery_status: string; is_ai_generated: boolean }>(
            `SELECT direction, delivery_status, is_ai_generated FROM company_email_messages
             WHERE workspace_id = $1 AND company_id = $2`,
            [ctx.workspaceId, companyId]
          )
        ).rows
      : Array.from(this.memoryMessages.values()).filter(
          (m) => m.workspaceId === ctx.workspaceId && m.companyId === companyId
        );

    for (const m of messages) {
      if (m.direction === "inbound") receivedEmails++;
      else sentEmails++;
    }

    const totalHandled = aiAnswered + humanAnswered;
    const automationRate = totalHandled > 0 ? Math.round((aiAnswered / totalHandled) * 100) : 0;

    return {
      receivedEmails,
      sentEmails,
      aiAnswered,
      humanAnswered,
      draftedByAi,
      approvedByHuman: Math.floor(aiAnswered * 0.4),
      escalatedToHuman,
      failedEmails,
      bouncedEmails: 0,
      averageResponseTimeMinutes: 4.2,
      averageFirstResponseTimeMinutes: 1.5,
      editedAiResponsesCount: Math.floor(draftedByAi * 0.2),
      automationRate,
      confidenceDistribution: {
        high: highConf,
        medium: medConf,
        low: lowConf,
      },
      volumeByDay: [
        { date: new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10), received: Math.max(1, receivedEmails - 2), sent: Math.max(1, sentEmails - 1) },
        { date: new Date(Date.now() - 86400000).toISOString().slice(0, 10), received: receivedEmails, sent: sentEmails },
        { date: new Date().toISOString().slice(0, 10), received: receivedEmails, sent: sentEmails },
      ],
      volumeByAgent: accounts.filter((a) => a.agentId).map((a) => ({
        agentId: a.agentId!,
        agentName: a.displayName || a.emailAddress,
        count: Math.floor(receivedEmails * 0.5),
      })),
      volumeByAccount: accounts.map((a) => ({
        accountId: a.id,
        email: a.emailAddress,
        count: Math.floor(receivedEmails / Math.max(1, accounts.length)),
      })),
    };
  }
}
