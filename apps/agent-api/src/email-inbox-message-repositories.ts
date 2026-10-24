import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";
import type { CompanyEmailMessage, CompanyEmailThread } from "./email-inbox-types";
import { messageCols, extractCandidateMessageIds } from "./email-inbox-repository-support";

export interface EmailInboxMessageHost {
  pool?: Pool
  memoryThreads: Map<string, CompanyEmailThread>
  memoryMessages: Map<string, CompanyEmailMessage>
  memoryDeletedMessageIds: Set<string>
  inboundLocks: Map<string, Promise<void>>
  getThread: (ctx: AuthContext, companyId: string, threadId: string) => Promise<CompanyEmailThread | null>
  updateThread: (ctx: AuthContext, companyId: string, threadId: string, patch: Partial<CompanyEmailThread>) => Promise<CompanyEmailThread>
}

export async function isExternalMessageDeleted(host: EmailInboxMessageHost, ctx: AuthContext, companyId: string, externalMessageId: string): Promise<boolean> {

    const candidates = extractCandidateMessageIds(externalMessageId);
    if (!candidates.length) return false;
    if (host.pool) {
      const result = await host.pool.query(
        `SELECT 1 FROM company_email_deleted_messages
          WHERE workspace_id = $1 AND company_id = $2
            AND external_message_id = ANY($3::text[])
          LIMIT 1`,
        [ctx.workspaceId, companyId, candidates]
      );
      return Boolean(result.rowCount);
    }
    return candidates.some((candidate) => host.memoryDeletedMessageIds.has(`${ctx.workspaceId}|${companyId}|${candidate}`));
  }

  // =========================================================================
  // 3. Collision Protection, Locks & Takeover (Items 11 & 26)
  // =========================================================================

export async function acquireLock(host: EmailInboxMessageHost, ctx: AuthContext, companyId: string, threadId: string): Promise<boolean> {

    const thread = await host.getThread(ctx, companyId, threadId);
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

    await host.updateThread(ctx, companyId, threadId, {
      lockedByUserId: ctx.userId,
      lockedAt: now.toISOString(),
    });
    return true;
  }

export async function releaseLock(host: EmailInboxMessageHost, ctx: AuthContext, companyId: string, threadId: string): Promise<void> {

    const thread = await host.getThread(ctx, companyId, threadId);
    if (thread && thread.lockedByUserId === ctx.userId) {
      await host.updateThread(ctx, companyId, threadId, {
        lockedByUserId: null,
        lockedAt: null,
      });
    }
  }

export async function setHumanTakeover(host: EmailInboxMessageHost, ctx: AuthContext, companyId: string, threadId: string, takeover: boolean): Promise<CompanyEmailThread> {

    return host.updateThread(ctx, companyId, threadId, {
      isHumanTakeover: takeover,
      status: takeover ? "waiting_human" : "new",
      lockedByUserId: takeover ? ctx.userId : null,
      lockedAt: takeover ? new Date().toISOString() : null,
    });
  }

export async function listMessages(host: EmailInboxMessageHost, ctx: AuthContext, companyId: string, threadId: string): Promise<CompanyEmailMessage[]> {

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailMessage>(
        `SELECT ${messageCols} FROM company_email_messages
         WHERE workspace_id = $1 AND company_id = $2 AND thread_id = $3
         ORDER BY created_at ASC`,
        [ctx.workspaceId, companyId, threadId]
      );
      return result.rows;
    }

    return Array.from(host.memoryMessages.values())
      .filter((m) => m.workspaceId === ctx.workspaceId && m.companyId === companyId && m.threadId === threadId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

export async function deletePendingAiDrafts(host: EmailInboxMessageHost, ctx: AuthContext, companyId: string, threadId: string): Promise<number> {

    if (host.pool) {
      const result = await host.pool.query(
        `DELETE FROM company_email_messages
         WHERE workspace_id = $1 AND company_id = $2 AND thread_id = $3
           AND direction = 'outbound' AND is_draft = true AND is_ai_generated = true`,
        [ctx.workspaceId, companyId, threadId]
      );
      return result.rowCount || 0;
    }

    let deleted = 0;
    for (const [id, message] of host.memoryMessages) {
      if (message.workspaceId === ctx.workspaceId && message.companyId === companyId &&
          message.threadId === threadId && message.direction === "outbound" &&
          message.isDraft && message.isAiGenerated) {
        host.memoryMessages.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

export async function getMessage(host: EmailInboxMessageHost, ctx: AuthContext, companyId: string, messageId: string): Promise<CompanyEmailMessage | null> {

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailMessage>(
        `SELECT ${messageCols} FROM company_email_messages
         WHERE workspace_id=$1 AND company_id=$2 AND id=$3`,
        [ctx.workspaceId, companyId, messageId]
      );
      return result.rows[0] ?? null;
    }
    const message = host.memoryMessages.get(messageId);
    return message && message.workspaceId === ctx.workspaceId && message.companyId === companyId ? message : null;
  }

export async function findMessageByExternalId(host: EmailInboxMessageHost, 
    ctx: AuthContext,
    companyId: string,
    externalMessageId: string
  ): Promise<CompanyEmailMessage | null> {

    const normalizedMessageId = externalMessageId.trim();
    if (!normalizedMessageId) return null;

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailMessage>(
        `SELECT ${messageCols} FROM company_email_messages
         WHERE workspace_id = $1 AND company_id = $2 AND message_id = $3
         ORDER BY created_at ASC
         LIMIT 1`,
        [ctx.workspaceId, companyId, normalizedMessageId]
      );
      return result.rows[0] ?? null;
    }

    return (
      Array.from(host.memoryMessages.values()).find(
        (message) =>
          message.workspaceId === ctx.workspaceId &&
          message.companyId === companyId &&
          message.messageId === normalizedMessageId
      ) ?? null
    );
  }

export async function createMessage(host: EmailInboxMessageHost, 
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

    if (host.pool) {
      const result = await host.pool.query<CompanyEmailMessage>(
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
      await host.pool.query(
        `UPDATE company_email_threads SET last_message_at = $1, updated_at = $1 WHERE id = $2`,
        [now, message.threadId]
      );

      return result.rows[0]!;
    }

    host.memoryMessages.set(id, message);
    const th = host.memoryThreads.get(message.threadId);
    if (th) {
      th.lastMessageAt = now;
      th.updatedAt = now;
    }
    return message;
  }

export async function updateMessage(host: EmailInboxMessageHost, 
    ctx: AuthContext,
    companyId: string,
    messageId: string,
    patch: Partial<CompanyEmailMessage>
  ): Promise<CompanyEmailMessage> {
    // An omitted field (undefined) keeps the stored value instead of clearing a NOT NULL column.
    patch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<CompanyEmailMessage>;

    if (host.pool) {
      const existing = (
        await host.pool.query<CompanyEmailMessage>(
          `SELECT ${messageCols} FROM company_email_messages WHERE workspace_id = $1 AND company_id = $2 AND id = $3`,
          [ctx.workspaceId, companyId, messageId]
        )
      ).rows[0];
      if (!existing) throw new Error("Message not found.");

      const updated = { ...existing, ...patch };
      const result = await host.pool.query<CompanyEmailMessage>(
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

    const item = host.memoryMessages.get(messageId);
    if (!item) throw new Error("Message not found.");
    const updated = { ...item, ...patch };
    host.memoryMessages.set(messageId, updated);
    return updated;
  }

  // =========================================================================
  // 5. Contacts & Customer Cards (Items 10 & 20)
  // =========================================================================

