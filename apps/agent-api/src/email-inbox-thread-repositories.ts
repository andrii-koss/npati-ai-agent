import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";
import type { CompanyEmailMessage, CompanyEmailThread, EmailFolder, EmailPriority, EmailThreadStatus } from "./email-inbox-types";

export interface EmailInboxThreadHost {
  pool?: Pool
  memoryThreads: Map<string, CompanyEmailThread>
  memoryMessages: Map<string, CompanyEmailMessage>
  memoryDeletedMessageIds: Set<string>
  threadCols: string
  normalizeEmailSubject: (subject: string) => string
  findMessageByReferenceIds: (ctx: AuthContext, companyId: string, referenceHeaders: (string | null | undefined)[]) => Promise<CompanyEmailMessage | null>
}

export async function createThread(host: EmailInboxThreadHost, ctx: AuthContext, companyId: string, input: Partial<CompanyEmailThread> & { subject: string; customerEmail: string }): Promise<CompanyEmailThread> {
    const id = input.id || randomUUID();
    const now = new Date().toISOString();
    const cleanCustomerEmail = input.customerEmail.trim().toLowerCase();
    const cleanSubject = host.normalizeEmailSubject(input.subject);
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

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailThread>(
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
        ) RETURNING ${host.threadCols}`,
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

    host.memoryThreads.set(id, thread);
    return thread;
  }

export async function updateThread(host: EmailInboxThreadHost, ctx: AuthContext, companyId: string, threadId: string, patch: Partial<CompanyEmailThread>): Promise<CompanyEmailThread> {
    const existing = await getThread(host, ctx, companyId, threadId);
    if (!existing) throw new Error("Thread not found.");

    const now = new Date().toISOString();
    const updated: CompanyEmailThread = {
      ...existing,
      ...patch,
      updatedAt: now,
    };

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailThread>(
        `UPDATE company_email_threads SET
          status = $1, priority = $2, folder = $3, assigned_agent_id = $4,
          assigned_user_id = $5, is_vip = $6, is_blacklisted = $7,
          is_human_takeover = $8, locked_by_user_id = $9, locked_at = $10,
          last_message_at = $11, unread_count = $12, ai_confidence_score = $13,
          ai_classification_summary = $14, detected_language = $15, metadata = $16,
          updated_at = $17
        WHERE workspace_id = $18 AND company_id = $19 AND id = $20
        RETURNING ${host.threadCols}`,
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

    host.memoryThreads.set(threadId, updated);
    return updated;
  }

export async function deleteThread(host: EmailInboxThreadHost, ctx: AuthContext, companyId: string, threadId: string): Promise<void> {
    if (host.pool) {
      const client = await host.pool.connect();
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

    for (const message of host.memoryMessages.values()) {
      if (message.workspaceId === ctx.workspaceId && message.companyId === companyId && message.threadId === threadId && message.messageId) {
        host.memoryDeletedMessageIds.add(`${ctx.workspaceId}|${companyId}|${message.messageId}`);
      }
    }
    host.memoryThreads.delete(threadId);
    // Also remove associated messages
    for (const [msgId, msg] of host.memoryMessages.entries()) {
      if (msg.threadId === threadId) {
        host.memoryMessages.delete(msgId);
      }
    }
  }

export async function getThread(host: EmailInboxThreadHost, ctx: AuthContext, companyId: string, threadId: string): Promise<CompanyEmailThread | null> {
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailThread>(
        `SELECT ${host.threadCols} FROM company_email_threads
         WHERE workspace_id = $1 AND company_id = $2 AND id = $3`,
        [ctx.workspaceId, companyId, threadId]
      );
      return result.rows[0] ?? null;
    }

    const t = host.memoryThreads.get(threadId);
    return t && t.workspaceId === ctx.workspaceId && t.companyId === companyId ? t : null;
  }

export async function findThreadByKey(host: EmailInboxThreadHost, workspaceId: string, companyId: string, threadKey: string): Promise<CompanyEmailThread | null> {
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailThread>(
        `SELECT ${host.threadCols} FROM company_email_threads
         WHERE workspace_id = $1 AND company_id = $2 AND thread_key = $3
         LIMIT 1`,
        [workspaceId, companyId, threadKey]
      );
      return result.rows[0] ?? null;
    }

    for (const t of host.memoryThreads.values()) {
      if (t.workspaceId === workspaceId && t.companyId === companyId && t.threadKey === threadKey) {
        return t;
      }
    }
    return null;
  }

export async function findMatchingThread(host: EmailInboxThreadHost, ctx: AuthContext, companyId: string, params: {
      inReplyTo?: string | null;
      references?: string | null;
      customerEmail: string;
      subject: string;
      threadKey?: string | null;
    }): Promise<CompanyEmailThread | null> {
    // 1. Try In-Reply-To and References header lookup (Message-ID linkage)
    if (params.inReplyTo || params.references) {
      const parentMsg = await host.findMessageByReferenceIds(ctx, companyId, [params.inReplyTo, params.references]);
      if (parentMsg?.threadId) {
        const thread = await getThread(host, ctx, companyId, parentMsg.threadId);
        if (thread) return thread;
      }
    }

    // 2. Try explicit threadKey if provided
    if (params.threadKey) {
      const thread = await findThreadByKey(host, ctx.workspaceId, companyId, params.threadKey);
      if (thread) return thread;
    }

    const cleanEmail = params.customerEmail.trim().toLowerCase();
    const cleanSubject = host.normalizeEmailSubject(params.subject);

    // 3. Try normalized threadKey and legacy key formats
    if (cleanSubject) {
      const normalizedKey = `th_${cleanEmail.replace(/[^a-z0-9]/g, "_")}_${encodeURIComponent(cleanSubject.slice(0, 50).toLowerCase())}`;
      const thread = await findThreadByKey(host, ctx.workspaceId, companyId, normalizedKey);
      if (thread) return thread;

      // Legacy key with clean subject
      const legacyKeyClean = `thread_${cleanEmail}_${encodeURIComponent(cleanSubject.slice(0, 30))}`;
      const legacyThreadClean = await findThreadByKey(host, ctx.workspaceId, companyId, legacyKeyClean);
      if (legacyThreadClean) return legacyThreadClean;

      // Legacy key with raw subject
      const legacyKeyRaw1 = `th_${cleanEmail.replace(/[^a-z0-9]/g, "_")}_${encodeURIComponent(params.subject.slice(0, 30))}`;
      const legacyThreadRaw1 = await findThreadByKey(host, ctx.workspaceId, companyId, legacyKeyRaw1);
      if (legacyThreadRaw1) return legacyThreadRaw1;

      const legacyKeyRaw2 = `thread_${cleanEmail}_${encodeURIComponent(params.subject.slice(0, 30))}`;
      const legacyThreadRaw2 = await findThreadByKey(host, ctx.workspaceId, companyId, legacyKeyRaw2);
      if (legacyThreadRaw2) return legacyThreadRaw2;
    }

    // 4. Fallback: Search recent threads for this customer email with matching normalized subject
    const recentThreads = await listRecentThreadsForCustomer(host, ctx, companyId, cleanEmail, 15);
    for (const candidate of recentThreads) {
      const candidateNorm = host.normalizeEmailSubject(candidate.subject).toLowerCase();
      if (candidateNorm && cleanSubject.toLowerCase() === candidateNorm) {
        return candidate;
      }
    }

    return null;
  }

export async function listThreads(host: EmailInboxThreadHost, ctx: AuthContext, companyId: string | string[], filter: {
      folder?: EmailFolder;
      status?: EmailThreadStatus;
      priority?: EmailPriority;
      search?: string;
      accountId?: string;
      isVip?: boolean;
      limit?: number;
    } = {}): Promise<CompanyEmailThread[]> {
    const limit = Math.min(100, Math.max(1, filter.limit || 50));

    const companyIds = typeof companyId === "string" ? [companyId] : companyId;
    if (!companyIds.length) return [];

    if (host.pool) {
      const conditions: string[] = ["workspace_id = $1", "company_id = scope.company_scope"];
      const params: any[] = [ctx.workspaceId, companyIds];

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
        SELECT latest.* FROM unnest($2::text[]) AS scope(company_scope) CROSS JOIN LATERAL (
          SELECT ${host.threadCols},
            (SELECT COUNT(*)::int
               FROM company_email_messages count_message
              WHERE count_message.workspace_id = company_email_threads.workspace_id
                AND count_message.company_id = company_email_threads.company_id
                AND count_message.thread_id = company_email_threads.id
                AND count_message.is_draft = false) AS "messagesCount"
          FROM company_email_threads
          WHERE ${conditions.join(" AND ")}
          ORDER BY last_message_at DESC, company_email_threads.id
          LIMIT $${params.length}
        ) AS latest
        ORDER BY latest."lastMessageAt" DESC, latest.id
      `;
      const result = await host.pool.query<CompanyEmailThread>(query, params);
      return result.rows;
    }

    let items = Array.from(host.memoryThreads.values()).filter(
      (t) => t.workspaceId === ctx.workspaceId && companyIds.includes(t.companyId)
    );

    if (filter.folder === "sent") {
      items = items.filter((thread) => Array.from(host.memoryMessages.values()).some((message) =>
        message.workspaceId === ctx.workspaceId && message.companyId === thread.companyId &&
        message.threadId === thread.id && message.direction === "outbound" && !message.isDraft
      ));
    } else if (filter.folder === "drafts") {
      items = items.filter((thread) => Array.from(host.memoryMessages.values()).some((message) =>
        message.workspaceId === ctx.workspaceId && message.companyId === thread.companyId &&
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
        messagesCount: Array.from(host.memoryMessages.values()).filter((message) =>
          message.workspaceId === ctx.workspaceId && message.companyId === thread.companyId &&
          message.threadId === thread.id && !message.isDraft
        ).length,
      }));
  }

export async function getFolderCounts(host: EmailInboxThreadHost, ctx: AuthContext, companyId: string | string[], accountId?: string): Promise<Record<EmailFolder, number>> {
    const companyIds = typeof companyId === "string" ? [companyId] : companyId;
    if (host.pool) {
      const params: unknown[] = [ctx.workspaceId, companyIds];
      const accountCondition = accountId ? ` AND thread.email_account_id = $3` : "";
      if (accountId) params.push(accountId);
      const result = await host.pool.query<{
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
        WHERE thread.workspace_id = $1 AND thread.company_id = ANY($2::text[])${accountCondition}`,
        params
      );
      const row = result.rows[0];
      return {
        inbox: Number(row?.inbox || 0), sent: Number(row?.sent || 0), drafts: Number(row?.drafts || 0),
        archived: Number(row?.archived || 0), spam: Number(row?.spam || 0),
      };
    }

    const allThreads = Array.from(host.memoryThreads.values()).filter((thread) =>
      thread.workspaceId === ctx.workspaceId && companyIds.includes(thread.companyId) &&
      (!accountId || thread.emailAccountId === accountId)
    );
    return {
      inbox: allThreads.filter((thread) => thread.folder === "inbox").reduce((sum, thread) => sum + thread.unreadCount, 0),
      sent: allThreads.reduce((sum, thread) => sum + Array.from(host.memoryMessages.values()).filter((message) =>
        message.workspaceId === ctx.workspaceId && message.companyId === thread.companyId && message.threadId === thread.id &&
        message.direction === "outbound" && !message.isDraft
      ).length, 0),
      drafts: allThreads.reduce((sum, thread) => sum + Array.from(host.memoryMessages.values()).filter((message) =>
        message.workspaceId === ctx.workspaceId && message.companyId === thread.companyId && message.threadId === thread.id &&
        message.isDraft && !message.isAiGenerated
      ).length, 0),
      archived: allThreads.filter((thread) => thread.folder === "archived").length,
      spam: allThreads.filter((thread) => thread.folder === "spam").length,
    };
  }

export async function listRecentThreadsForCustomer(host: EmailInboxThreadHost, ctx: AuthContext, companyId: string, customerEmail: string, limit = 15): Promise<CompanyEmailThread[]> {
    const cleanEmail = customerEmail.trim().toLowerCase();
    if (host.pool) {
      const result = await host.pool.query<CompanyEmailThread>(
        `SELECT ${host.threadCols} FROM company_email_threads
         WHERE workspace_id = $1 AND company_id = $2
           AND LOWER(customer_email) = $3
         ORDER BY last_message_at DESC
         LIMIT $4`,
        [ctx.workspaceId, companyId, cleanEmail, limit]
      );
      return result.rows;
    }
    return Array.from(host.memoryThreads.values())
      .filter((t) => t.workspaceId === ctx.workspaceId && t.companyId === companyId && t.customerEmail.toLowerCase() === cleanEmail)
      .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
      .slice(0, limit);
  }

