import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import type { AIEngine } from "@npati/omniroute-adapter";
import type { AuditRepository } from "./audit-repository";
import { EmailAIProcessor, type EmailAutomationHooks } from "./email-ai-processor";
import type { EmailInboxRepository } from "./email-inbox-repository";
import type { CompanyEmailAccount, CompanyEmailJob } from "./email-inbox-types";
import { ImapEmailTransport, SmtpEmailTransport } from "./email-transport";
import { postOAuthTokenRequest } from "./email-destination-policy";
import type { EmailAttachmentStorage } from "./email-attachment-storage";

function workerContext(account: CompanyEmailAccount): AuthContext {
  return {
    workspaceId: account.workspaceId,
    userId: account.userId,
    permissions: ["workspace:read", "workspace:write", "business:manage", "browser:resume_email"],
  };
}

export class EmailInboxWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private activeTick?: Promise<void>;
  private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  private readonly processor: EmailAIProcessor;

  constructor(
    private readonly repo: EmailInboxRepository,
    aiEngine?: AIEngine,
    private readonly auditRepo?: AuditRepository,
    private readonly automationHooks: EmailAutomationHooks = {},
    private readonly pollIntervalMs = Math.max(10_000, Number(process.env.EMAIL_POLL_INTERVAL_MS || 15_000)),
    private readonly attachmentStorage?: EmailAttachmentStorage,
  ) {
    this.processor = new EmailAIProcessor(repo, auditRepo, aiEngine, automationHooks);
  }

  start(): void {
    if (this.timer) return;
    this.scheduleTick();
    this.timer = setInterval(() => this.scheduleTick(), this.pollIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }

  triggerTick(): void {
    this.scheduleTick();
  }

  setGatewayHook(hook: NonNullable<EmailAutomationHooks["routeThroughGateway"]>): void {
    this.processor.setGatewayHook(hook);
  }

  private scheduleTick(): void {
    if (this.activeTick) return;
    this.activeTick = this.tick().catch(() => undefined).finally(() => {
      this.activeTick = undefined;
    });
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
      else throw new Error(`Unsupported email job type: ${job.jobType}`);
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
          await this.repo.createNotification(ctx, job.companyId, {
            threadId: job.threadId, notificationType: "delivery_failed", title: "Email delivery failed",
            body: error instanceof Error ? error.message : String(error),
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
    const transportMessage = this.attachmentStorage && message.attachments.some((attachment) => attachment.url && !attachment.contentBase64)
      ? { ...message, attachments: await this.attachmentStorage.materialize(ctx, job.companyId, message.attachments) }
      : message;
    await SmtpEmailTransport.send(account, transportMessage);
    await this.repo.updateMessage(ctx, job.companyId, message.id, { deliveryStatus: "sent", deliveryError: null });
    if (job.threadId) await this.repo.updateThread(ctx, job.companyId, job.threadId, { status: "waiting_customer" });
    if (this.auditRepo && job.threadId) {
      await this.auditRepo.log(ctx, job.companyId, {
        action: "email.sent", category: "automation", resourceType: "company_email_thread", resourceId: job.threadId,
        details: { messageId: message.id, accountId: account.id, recipients: message.toAddresses, attempt: job.attemptCount },
      }).catch(() => undefined);
    }

    if (account.followupConfig.enabled && account.followupConfig.maxFollowups > 0 && job.threadId) {
      const completedFollowupNumber = Number(job.payload.followupNumber || 0);
      const nextFollowupNumber = completedFollowupNumber + 1;
      if (nextFollowupNumber > account.followupConfig.maxFollowups) return;
      const rootMessageId = String(job.payload.rootMessageId || message.id);
      const runAfter = new Date(Date.now() + Math.max(1, account.followupConfig.delayDays) * 86_400_000).toISOString();
      await this.repo.enqueueJob(ctx, job.companyId, {
        jobType: "followup", emailAccountId: account.id, threadId: job.threadId,
        payload: { originalMessageId: message.id, rootMessageId, followupNumber: nextFollowupNumber }, runAfter,
        maxAttempts: 3,
        idempotencyKey: `followup:${rootMessageId}:${nextFollowupNumber}`,
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

    if (account.followupConfig.action === "notify_user") {
      await this.repo.createNotification(ctx, job.companyId, {
        userId: thread.assignedUserId, threadId: thread.id, notificationType: "followup_due",
        title: `Follow-up due: ${thread.subject}`,
        body: `${thread.customerEmail} has not replied within ${account.followupConfig.delayDays} day(s).`,
      });
      await this.repo.updateThread(ctx, job.companyId, thread.id, { status: "waiting_human" });
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
    await this.repo.updateThread(ctx, job.companyId, thread.id, { status: isDraft ? "draft_ready" : "ai_processing" });
    if (!isDraft) {
      const quota = await this.repo.reserveSendQuota(job.companyId, account, thread.customerEmail);
      if (!quota.allowed) throw new Error(`Rate limit exceeded: ${quota.reason}`);
      await this.repo.enqueueJob(ctx, job.companyId, {
        jobType: "send", emailAccountId: account.id, threadId: thread.id, messageId: followup.id,
        payload: {
          isFollowup: true,
          followupNumber: Number(job.payload.followupNumber || 1),
          rootMessageId: String(job.payload.rootMessageId || original.id),
        },
        idempotencyKey: `send:${followup.id}`,
      });
    }
  }

  private async pollMailboxes(): Promise<void> {
    const accounts = await this.repo.listAccountsForWorker();
    for (let account of accounts) {
      const imapPollingAllowed = account.status === "connected" || account.status === "imap_error" ||
        account.status === "smtp_error" || account.status === "dns_error";
      if (account.testMode || !imapPollingAllowed || !account.imapConfig.host) continue;
      const ctx = workerContext(account);
      try {
        account = await this.refreshOAuth(account, ctx);
        const messages = await ImapEmailTransport.poll(account);
        let lastUid = account.imapConfig.lastUid || 0;
        for (const message of messages) {
          if (message.messageId && await this.repo.isExternalMessageDeleted(ctx, account.companyId, message.messageId)) {
            lastUid = Math.max(lastUid, message.uid);
            continue;
          }
          if (await this.handleDeliveryNotification(ctx, account, message)) {
            lastUid = Math.max(lastUid, message.uid);
            continue;
          }
          await this.processor.processInbound(ctx, account.companyId, {
            from: message.from, to: message.to, subject: message.subject, body: message.body,
            bodyHtml: message.bodyHtml, messageId: message.messageId || `imap:${account.id}:${message.uid}`,
            inReplyTo: message.inReplyTo, references: message.references, attachments: message.attachments,
            // A mailbox message is never owner input: without parsed headers it would have been trusted as authorized
            // and authenticated (V6 step 17), so it always goes through the sender checks.
            headers: message.headers ?? {}, authenticationResults: message.authenticationResults,
          });
          lastUid = Math.max(lastUid, message.uid);
        }
        await this.repo.updateAccount(ctx, account.companyId, account.id, {
          status: account.smtpConfig.lastError ? "smtp_error" : "connected",
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

  private async handleDeliveryNotification(
    ctx: AuthContext,
    account: CompanyEmailAccount,
    message: { uid: number; from: string; subject: string; body: string }
  ): Promise<boolean> {
    const text = `${message.subject}\n${message.body}`;
    if (!/mailer-daemon|postmaster/i.test(message.from) || !/undeliver|delivery[ -](?:status|failure)|returned mail|bounce|rejected/i.test(text)) {
      return false;
    }
    const idMatch = text.match(/(?:Original-Message-ID|X-Original-Message-ID|Message-ID):\s*<([^>]+)>/i);
    if (!idMatch?.[1]) return false;
    const fullId = idMatch[1].trim();
    const localId = fullId.split("@", 1)[0] || fullId;
    const outbound = await this.repo.findMessageByExternalId(ctx, account.companyId, fullId)
      || await this.repo.findMessageByExternalId(ctx, account.companyId, localId);
    if (!outbound || outbound.direction !== "outbound") return false;
    const diagnostic = text.match(/Diagnostic-Code:\s*([^\r\n]+)/i)?.[1]
      || text.match(/Status:\s*([^\r\n]+)/i)?.[1]
      || message.subject;
    const status = /5\.7\.|reject|policy/i.test(diagnostic) ? "rejected" as const : "bounced" as const;
    await this.repo.updateMessage(ctx, account.companyId, outbound.id, { deliveryStatus: status, deliveryError: diagnostic });
    await this.repo.updateThread(ctx, account.companyId, outbound.threadId, { status: "failed" });
    await this.repo.createNotification(ctx, account.companyId, {
      threadId: outbound.threadId, notificationType: "delivery_failed",
      title: `Email ${status}: ${outbound.subject}`, body: diagnostic,
    });
    if (this.auditRepo) {
      await this.auditRepo.log(ctx, account.companyId, {
        action: `email.delivery_${status}`, category: "automation", resourceType: "company_email_thread",
        resourceId: outbound.threadId, details: { messageId: outbound.id, diagnostic, source: "dsn" },
      }).catch(() => undefined);
    }
    return true;
  }

  private async refreshOAuth(account: CompanyEmailAccount, ctx: AuthContext): Promise<CompanyEmailAccount> {
    const config = account.imapConfig.authType === "oauth2" ? account.imapConfig : account.smtpConfig;
    if (config.authType !== "oauth2" || !config.refreshToken || !config.tokenUrl || !config.clientId) return account;
    const expiresAt = config.tokenExpiresAt ? new Date(config.tokenExpiresAt).getTime() : 0;
    if (config.accessToken && expiresAt > Date.now() + 60_000) return account;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: config.refreshToken, client_id: config.clientId });
    if (config.clientSecret) body.set("client_secret", config.clientSecret);
    // Audit M1: SSRF-safe (public HTTPS only, pinned address, redirects refused instead of followed).
    const response = await postOAuthTokenRequest(config.tokenUrl, body);
    if (!response.ok) throw new Error(`OAuth token refresh failed (${response.status})`);
    const token = response.json as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (typeof token.access_token !== "string" || !token.access_token) throw new Error("OAuth token refresh returned no access_token");
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
