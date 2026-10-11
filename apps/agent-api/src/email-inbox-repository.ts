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
import { close, claimBrowserEmailWait, encryptAccountSecrets, decryptAccountSecrets, encryptLegacyAccountCredentials, withInboundMessageLock, createOAuthState, consumeOAuthState, listAccounts, listUserAccounts, getAccount, getAccountInternal, findAccountByEmail, findUserAccountByEmail, listAccountsForWorker, createAccount, updateAccount, deleteAccount, isCollisionLocked, type EmailInboxAccountHost } from "./email-inbox-account-repositories";
import { createThread, updateThread, deleteThread, getThread, findThreadByKey, findMatchingThread, listThreads, getFolderCounts, listRecentThreadsForCustomer, type EmailInboxThreadHost } from "./email-inbox-thread-repositories";

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

  private threadHost(): EmailInboxThreadHost {
    return {
      pool: this.pool,
      memoryThreads: this.memoryThreads,
      memoryMessages: this.memoryMessages,
      memoryDeletedMessageIds: this.memoryDeletedMessageIds,
      threadCols: threadCols,
      normalizeEmailSubject: normalizeEmailSubject,
      findMessageByReferenceIds: this.findMessageByReferenceIds.bind(this),
    };
  }

  private accountHost(): EmailInboxAccountHost {
    return {
      pool: this.pool,
      vault: this.vault,
      memoryAccounts: this.memoryAccounts,
      memoryOAuthStates: this.memoryOAuthStates,
      inboundLocks: this.inboundLocks,
      accountCols: accountCols,
      getThread: this.getThread.bind(this),
    };
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
    return encryptAccountSecrets(this.accountHost(), account);
  }

    private decryptAccountSecrets(account: CompanyEmailAccount): CompanyEmailAccount {
    return decryptAccountSecrets(this.accountHost(), account);
  }

    async close(): Promise<void> {
    return close(this.accountHost());
  }

    async claimBrowserEmailWait(ctx: AuthContext, companyId: string, sender: string, emailAccountId?: string): Promise<{ browserJobId: string; runId: string; profileId: string; campaignTargetId?: string | null } | null> {
    return claimBrowserEmailWait(this.accountHost(), ctx, companyId, sender, emailAccountId);
  }

    async encryptLegacyAccountCredentials(): Promise<number> {
    return encryptLegacyAccountCredentials(this.accountHost());
  }

    async withInboundMessageLock<T>(
    workspaceId: string,
    companyId: string,
    externalMessageId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return withInboundMessageLock(this.accountHost(), workspaceId, companyId, externalMessageId, operation);
  }

    async createOAuthState(ctx: AuthContext, companyId: string, accountId: string, input: {
    stateHash: string; verifier: string; tokenUrl: string; clientId: string; clientSecret?: string;
    redirectUri: string; expiresAt: string;
  }): Promise<void> {
    return createOAuthState(this.accountHost(), ctx, companyId, accountId, input);
  }

    async consumeOAuthState(stateHash: string): Promise<{
    workspaceId: string; companyId: string; accountId: string; userId: string; verifier: string;
    tokenUrl: string; clientId: string; clientSecret?: string; redirectUri: string;
  } | null> {
    return consumeOAuthState(this.accountHost(), stateHash);
  }

  // =========================================================================
  // 1. Email Accounts
  // =========================================================================

    async listAccounts(ctx: AuthContext, companyId: string): Promise<CompanyEmailAccount[]> {
    return listAccounts(this.accountHost(), ctx, companyId);
  }

    async listUserAccounts(ctx: AuthContext): Promise<CompanyEmailAccount[]> {
    return listUserAccounts(this.accountHost(), ctx);
  }

    async getAccount(ctx: AuthContext, companyId: string, accountId: string): Promise<CompanyEmailAccount | null> {
    return getAccount(this.accountHost(), ctx, companyId, accountId);
  }

    async getAccountInternal(accountId: string): Promise<CompanyEmailAccount | null> {
    return getAccountInternal(this.accountHost(), accountId);
  }
    async findAccountByEmail(companyId: string, emailAddress: string): Promise<CompanyEmailAccount | null> {
    return findAccountByEmail(this.accountHost(), companyId, emailAddress);
  }

    async findUserAccountByEmail(ctx: AuthContext, emailAddress: string): Promise<CompanyEmailAccount | null> {
    return findUserAccountByEmail(this.accountHost(), ctx, emailAddress);
  }

    async listAccountsForWorker(): Promise<CompanyEmailAccount[]> {
    return listAccountsForWorker(this.accountHost());
  }

    async createAccount(
    ctx: AuthContext,
    companyId: string,
    input: Partial<CompanyEmailAccount> & { emailAddress: string }
  ): Promise<CompanyEmailAccount> {
    return createAccount(this.accountHost(), ctx, companyId, input);
  }

    async updateAccount(
    ctx: AuthContext,
    companyId: string,
    accountId: string,
    patch: Partial<CompanyEmailAccount>
  ): Promise<CompanyEmailAccount> {
    return updateAccount(this.accountHost(), ctx, companyId, accountId, patch);
  }

    async deleteAccount(ctx: AuthContext, companyId: string, accountId: string): Promise<void> {
    return deleteAccount(this.accountHost(), ctx, companyId, accountId);
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
    return listThreads(this.threadHost(), ctx, companyId, filter);
  }

    async getFolderCounts(
    ctx: AuthContext,
    companyId: string,
    accountId?: string
  ): Promise<Record<EmailFolder, number>> {
    return getFolderCounts(this.threadHost(), ctx, companyId, accountId);
  }

    async getThread(ctx: AuthContext, companyId: string, threadId: string): Promise<CompanyEmailThread | null> {
    return getThread(this.threadHost(), ctx, companyId, threadId);
  }

    async findThreadByKey(
    workspaceId: string,
    companyId: string,
    threadKey: string
  ): Promise<CompanyEmailThread | null> {
    return findThreadByKey(this.threadHost(), workspaceId, companyId, threadKey);
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
    return listRecentThreadsForCustomer(this.threadHost(), ctx, companyId, customerEmail, limit);
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
    return findMatchingThread(this.threadHost(), ctx, companyId, params);
  }

    async createThread(
    ctx: AuthContext,
    companyId: string,
    input: Partial<CompanyEmailThread> & { subject: string; customerEmail: string }
  ): Promise<CompanyEmailThread> {
    return createThread(this.threadHost(), ctx, companyId, input);
  }

    async updateThread(
    ctx: AuthContext,
    companyId: string,
    threadId: string,
    patch: Partial<CompanyEmailThread>
  ): Promise<CompanyEmailThread> {
    return updateThread(this.threadHost(), ctx, companyId, threadId, patch);
  }

    async deleteThread(ctx: AuthContext, companyId: string, threadId: string): Promise<void> {
    return deleteThread(this.threadHost(), ctx, companyId, threadId);
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
    return isCollisionLocked(this.accountHost(), ctx, companyId, threadId);
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
