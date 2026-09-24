import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import type { AIEngine } from "@npati/omniroute-adapter";
import type { AuditRepository } from "./audit-repository";
import { EmailAIProcessor, type EmailAutomationHooks } from "./email-ai-processor";
import type { EmailInboxRepository } from "./email-inbox-repository";
import type { CompanyEmailAccount, CompanyEmailJob } from "./email-inbox-types";
import { ImapEmailTransport, SmtpEmailTransport } from "./email-transport";

function workerContext(account: CompanyEmailAccount): AuthContext {
  return {
    workspaceId: account.workspaceId,
    userId: account.userId,
    permissions: ["workspace:read", "workspace:write", "business:manage"],
  };
}

export class EmailInboxWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  private readonly processor: EmailAIProcessor;

  constructor(
    private readonly repo: EmailInboxRepository,
    aiEngine?: AIEngine,
    private readonly auditRepo?: AuditRepository,
    private readonly automationHooks: EmailAutomationHooks = {},
    private readonly pollIntervalMs = Math.max(10_000, Number(process.env.EMAIL_POLL_INTERVAL_MS || 30_000))
  ) {
    this.processor = new EmailAIProcessor(repo, auditRepo, aiEngine, automationHooks);
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = await this.repo.claimJobs(this.workerId, 20);
      for (const job of jobs) await this.processJob(job);
      await this.pollMailboxes();
    } finally {
      this.running = false;
    }
  }

  private async processJob(job: CompanyEmailJob): Promise<void> {
    try {
      if (job.jobType === "send") await this.processSend(job);
      else if (job.jobType === "followup") await this.processFollowup(job);
      await this.repo.completeJob(job.id);
    } catch (error) {
      await this.repo.failJob(job, error);
      if (job.messageId && job.attemptCount >= job.maxAttempts) {
        const account = (await this.repo.listAccountsForWorker()).find((item) => item.id === job.emailAccountId);
        if (account) {
          const ctx = workerContext(account);
          await this.repo.updateMessage(ctx, job.companyId, job.messageId, {
            deliveryStatus: "failed",
            deliveryError: error instanceof Error ? error.message : String(error),
          }).catch(() => undefined);
        }
      }
    }
  }

  private async processSend(job: CompanyEmailJob): Promise<void> {
    if (!job.emailAccountId || !job.messageId) throw new Error("Send job is missing account or message reference");
    let account = (await this.repo.listAccountsForWorker()).find((item) => item.id === job.emailAccountId);
    if (!account) throw new Error("Email account no longer exists");
    const ctx = workerContext(account);
    account = await this.refreshOAuth(account, ctx);
    const message = await this.repo.getMessage(ctx, job.companyId, job.messageId);
    if (!message) throw new Error("Email message no longer exists");
    if (account.testMode) {
      await this.repo.updateMessage(ctx, job.companyId, message.id, { deliveryStatus: "delivered", deliveryError: null });
      return;
    }
    await SmtpEmailTransport.send(account, message);
    await this.repo.updateMessage(ctx, job.companyId, message.id, { deliveryStatus: "sent", deliveryError: null });
    if (job.threadId) await this.repo.updateThread(ctx, job.companyId, job.threadId, { status: "waiting_customer" });
    if (this.auditRepo && job.threadId) {
      await this.auditRepo.log(ctx, job.companyId, {
        action: "email.sent", category: "automation", resourceType: "company_email_thread", resourceId: job.threadId,
        details: { messageId: message.id, accountId: account.id, recipients: message.toAddresses, attempt: job.attemptCount },
      }).catch(() => undefined);
    }

    if (account.followupConfig.enabled && job.threadId) {
      const runAfter = new Date(Date.now() + Math.max(1, account.followupConfig.delayDays) * 86_400_000).toISOString();
      await this.repo.enqueueJob(ctx, job.companyId, {
        jobType: "followup", emailAccountId: account.id, threadId: job.threadId,
        payload: { originalMessageId: message.id }, runAfter,
        maxAttempts: Math.max(1, account.followupConfig.maxFollowups),
        idempotencyKey: `followup:${message.id}:1`,
      });
    }
  }

  private async processFollowup(job: CompanyEmailJob): Promise<void> {
    if (!job.emailAccountId || !job.threadId) return;
    const account = (await this.repo.listAccountsForWorker()).find((item) => item.id === job.emailAccountId);
    if (!account || !account.followupConfig.enabled) return;
    const ctx = workerContext(account);
    const thread = await this.repo.getThread(ctx, job.companyId, job.threadId);
    if (!thread || thread.status === "closed") return;
    const messages = await this.repo.listMessages(ctx, job.companyId, thread.id);
    const originalId = String(job.payload.originalMessageId || "");
    const original = messages.find((message) => message.id === originalId);
    if (!original) return;
    const customerReplied = messages.some((message) => message.direction === "inbound" && new Date(message.createdAt) > new Date(original.createdAt));
    if (customerReplied) return;

    if (account.followupConfig.action === "create_task") {
      const latestInbound = [...messages].reverse().find((message) => message.direction === "inbound");
      if (latestInbound && this.automationHooks.createTask) {
        await this.automationHooks.createTask({ ctx, companyId: job.companyId, thread, inboundMessage: latestInbound,
          assignedAgentId: thread.assignedAgentId });
      }
      return;
    }

    const isDraft = account.followupConfig.action !== "auto_send";
    const followup = await this.repo.createMessage(ctx, job.companyId, {
      threadId: thread.id, emailAccountId: account.id, direction: "outbound",
      fromAddress: account.emailAddress, toAddresses: [thread.customerEmail],
      subject: `Re: ${thread.subject}`,
      bodyText: `Hello,\n\nI am following up on our previous email. Please let us know if you need any additional information.\n\n${account.signatureConfig.signature || "Best regards"}`,
      isDraft, isAiGenerated: true, deliveryStatus: isDraft ? "sending" : "sending",
    });
    await this.repo.updateThread(ctx, job.companyId, thread.id, { status: isDraft ? "draft_ready" : "waiting_customer" });
    if (!isDraft) {
      const quota = await this.repo.reserveSendQuota(job.companyId, account, thread.customerEmail);
      if (!quota.allowed) throw new Error(`Rate limit exceeded: ${quota.reason}`);
      await this.repo.enqueueJob(ctx, job.companyId, {
        jobType: "send", emailAccountId: account.id, threadId: thread.id, messageId: followup.id,
        idempotencyKey: `send:${followup.id}`,
      });
    }
  }

  private async pollMailboxes(): Promise<void> {
    const accounts = await this.repo.listAccountsForWorker();
    for (let account of accounts) {
      if (account.testMode || account.status !== "connected" || !account.imapConfig.host) continue;
      const ctx = workerContext(account);
      try {
        account = await this.refreshOAuth(account, ctx);
        const messages = await ImapEmailTransport.poll(account);
        let lastUid = account.imapConfig.lastUid || 0;
        for (const message of messages) {
          await this.processor.processInbound(ctx, account.companyId, {
            from: message.from, to: message.to, subject: message.subject, body: message.body,
            bodyHtml: message.bodyHtml, messageId: message.messageId || `imap:${account.id}:${message.uid}`,
            inReplyTo: message.inReplyTo, attachments: message.attachments,
          });
          lastUid = Math.max(lastUid, message.uid);
        }
        await this.repo.updateAccount(ctx, account.companyId, account.id, {
          status: "connected",
          imapConfig: { lastUid, lastSyncAt: new Date().toISOString(), lastError: null },
        });
      } catch (error) {
        await this.repo.updateAccount(ctx, account.companyId, account.id, {
          status: "imap_error",
          imapConfig: { lastError: error instanceof Error ? error.message : String(error) },
        }).catch(() => undefined);
      }
    }
  }

  private async refreshOAuth(account: CompanyEmailAccount, ctx: AuthContext): Promise<CompanyEmailAccount> {
    const config = account.imapConfig.authType === "oauth2" ? account.imapConfig : account.smtpConfig;
    if (config.authType !== "oauth2" || !config.refreshToken || !config.tokenUrl || !config.clientId) return account;
    const expiresAt = config.tokenExpiresAt ? new Date(config.tokenExpiresAt).getTime() : 0;
    if (config.accessToken && expiresAt > Date.now() + 60_000) return account;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: config.refreshToken, client_id: config.clientId });
    if (config.clientSecret) body.set("client_secret", config.clientSecret);
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`OAuth token refresh failed (${response.status})`);
    const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!token.access_token) throw new Error("OAuth token refresh returned no access_token");
    const patch = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || config.refreshToken,
      tokenExpiresAt: new Date(Date.now() + Math.max(60, token.expires_in || 3600) * 1000).toISOString(),
    };
    return this.repo.updateAccount(ctx, account.companyId, account.id, {
      imapConfig: account.imapConfig.authType === "oauth2" ? patch : {},
      smtpConfig: account.smtpConfig.authType === "oauth2" ? patch : {},
    });
  }
}
