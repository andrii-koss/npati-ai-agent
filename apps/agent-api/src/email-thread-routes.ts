import type { FastifyInstance } from "fastify";
import type { AuthContext } from "@npati/workspace";
import type {
  CompanyEmailThread,
  EmailAttachment,
  EmailFolder,
  EmailPriority,
  EmailThreadStatus,
} from "./email-inbox-types";
import {
  type EmailRoutesContext,
  ctx,
  err,
  resolveEmailScope,
  PERSONAL_EMAIL_SCOPE,
  hasEmailPermission,
  type EmailPermission,
} from "./email-routes-context";

export function registerEmailThreadRoutes(
  app: FastifyInstance,
  context: EmailRoutesContext,
) {
  const { auth, store, repo, auditRepo, attachmentStorage, worker } = context;

  // =========================================================================
  // 2. Email Inbox Threads & Messages (Items 6, 7, 8)
  // =========================================================================

  async function readThreadDetail(c: AuthContext, companyId: string, thread: CompanyEmailThread) {
    const [messages, contact, matchingThreads, runs] = await Promise.all([
      repo.listMessages(c, companyId, thread.id),
      repo.getContact(c, companyId, thread.customerEmail),
      repo.listThreads(c, companyId, { search: thread.customerEmail, limit: 50 }),
      companyId.startsWith(`${PERSONAL_EMAIL_SCOPE}:`) ? [] : store.listCompanyAgentRuns(c, companyId, 100),
    ]);
    const previousThreads = matchingThreads
      .filter(item => item.id !== thread.id && item.customerEmail === thread.customerEmail)
      .map(({ id, subject, status, priority, lastMessageAt }) => ({ id, subject, status, priority, lastMessageAt }));
    const tasks = runs
      .filter(run => run.task.includes(thread.customerEmail) || run.task.includes(thread.id))
      .slice(0, 20)
      .map(({ id, task, status, createdAt }) => ({ id, task, status, createdAt }));
    return { thread, messages, contact, customerContext: { previousThreads, tasks } };
  }

  async function readThreadAudit(c: AuthContext, companyId: string, threadId: string) {
    return auditRepo ? auditRepo.listResourceLogs(c, companyId, "company_email_thread", threadId) : [];
  }

  app.get<{ Querystring: {
    company?: string; accountId?: string; folder?: EmailFolder; status?: EmailThreadStatus;
    priority?: EmailPriority; search?: string; threadId?: string;
  } }>("/email/inbox/open", {
    schema: { querystring: { type: "object", properties: {
      company: { type: "string", maxLength: 128 },
      accountId: { type: "string", maxLength: 128 },
      folder: { type: "string", enum: ["inbox", "sent", "drafts", "archived", "spam"] },
      status: { type: "string", maxLength: 64 },
      priority: { type: "string", maxLength: 64 },
      search: { type: "string" },
      threadId: { type: "string", maxLength: 128 },
    } } },
  }, async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:read_messages");
      const company = r.query.company || "all";
      const companies: Array<{ id: string; name: string }> = [];
      if (c.permissions.includes("workspace:read")) {
        let cursor: string | undefined;
        do {
          const page = await store.listCompanies(c, 100, cursor);
          companies.push(...page.items.map(({ id, name }) => ({ id, name })));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      }

      const companyIds = company === "all" ? companies.map(({ id }) => id)
        : [companies.some(({ id }) => id === company) ? company : await resolveEmailScope(store, c, company)];
      const presentScope = (companyId: string) => company === PERSONAL_EMAIL_SCOPE ? PERSONAL_EMAIL_SCOPE : companyId;
      const { accountId, folder = "inbox", status, priority, search, threadId } = r.query;
      const canReadAccounts = hasEmailPermission(c, "email:view");
      const accountRead = canReadAccounts ? repo.readSettingsData(c, companyIds, false) : { accounts: [] };
      const threadCompanyIds = accountId && canReadAccounts
        ? (await accountRead).accounts.filter(account => account.id === accountId).map(account => account.companyId)
        : accountId ? [] : companyIds;
      const threadsAndDetail = async () => {
        const threads = await repo.listThreads(c, threadCompanyIds, { accountId, folder, status, priority, search });
        const selected = threads.find(thread => thread.id === threadId) ?? threads[0];
        if (!selected) return { threads: [], detail: null };
        const [detail, logs] = await Promise.all([
          readThreadDetail(c, selected.companyId, selected),
          readThreadAudit(c, selected.companyId, selected.id).catch(() => []),
        ]);
        return {
          threads: threads.map(thread => ({ ...thread, companyId: presentScope(thread.companyId) })),
          detail: { ...detail, thread: { ...selected, companyId: presentScope(selected.companyId) }, logs },
        };
      };
      const [{ accounts }, counts, notifications, mailbox] = await Promise.all([
        accountRead,
        repo.getFolderCounts(c, threadCompanyIds, accountId),
        repo.listNotifications(c, companyIds),
        threadsAndDetail(),
      ]);
      return reply.header("Cache-Control", "private, no-store").send({
        companies,
        accounts: accounts.map(account => ({
          id: account.id, companyId: presentScope(account.companyId), emailAddress: account.emailAddress,
          displayName: account.displayName, mode: account.mode, status: account.status, testMode: account.testMode,
        })),
        counts,
        notifications: notifications.map(item => ({ ...item, companyId: presentScope(item.companyId) })),
        ...mailbox,
      });
    } catch (e) { return err(reply, e); }
  });

  app.post<{
    Params: { companyId: string };
    Body: {
      accountId: string; toAddresses: string[]; ccAddresses?: string[]; bccAddresses?: string[];
      subject: string; bodyText: string; isDraft?: boolean; attachments?: EmailAttachment[];
    };
  }>("/companies/:companyId/email-inbox/compose", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:send_messages");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const accounts = await repo.listAccounts(c, r.params.companyId);
      const account = accounts.find((item) => item.id === r.body?.accountId);
      if (!account) throw Object.assign(new Error("Select a valid email account."), { status: 400 });

      const normalizeRecipients = (values: unknown) => Array.isArray(values)
        ? [...new Set(values.map(String).map((value) => value.trim().toLowerCase()).filter(Boolean))]
        : [];
      const toAddresses = normalizeRecipients(r.body?.toAddresses);
      const ccAddresses = normalizeRecipients(r.body?.ccAddresses);
      const bccAddresses = normalizeRecipients(r.body?.bccAddresses);
      const allRecipients = [...toAddresses, ...ccAddresses, ...bccAddresses];
      const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!toAddresses.length) throw Object.assign(new Error("At least one To recipient is required."), { status: 400 });
      if (allRecipients.some((address) => !validEmail.test(address))) {
        throw Object.assign(new Error("One or more recipient email addresses are invalid."), { status: 400 });
      }
      const subject = String(r.body?.subject || "").trim();
      const bodyText = String(r.body?.bodyText || "").trim();
      if (!subject) throw Object.assign(new Error("Subject is required."), { status: 400 });
      if (!bodyText) throw Object.assign(new Error("Message body is required."), { status: 400 });
      const isDraft = r.body?.isDraft === true;

      if (!isDraft) {
        const smtpBlocked = account.status === "pending" || account.status === "disabled" ||
          Boolean(account.smtpConfig.lastError);
        if (!account.testMode && smtpBlocked) {
          throw Object.assign(new Error(`SMTP sending is unavailable (${account.status}). Open Email Settings and test the SMTP connection.`), { status: 409 });
        }
        const quota = await repo.reserveSendQuota(r.params.companyId, account, toAddresses[0]!);
        if (!quota.allowed) throw Object.assign(new Error(`Rate limit exceeded: ${quota.reason}`), { status: 429 });
      }

      const rawAttachments = Array.isArray(r.body?.attachments) ? r.body.attachments : [];
      if (rawAttachments.length > 20 || rawAttachments.some((item) => Number(item.sizeBytes || 0) > 10 * 1024 * 1024)
        || rawAttachments.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0) > 25 * 1024 * 1024) {
        throw Object.assign(new Error("Attachments exceed the 20-file, 10 MB per file, or 25 MB total limit."), { status: 413 });
      }
      const thread = await repo.createThread(c, r.params.companyId, {
        emailAccountId: account.id, subject, customerEmail: toAddresses[0]!,
        status: isDraft ? "draft_ready" : account.testMode ? "answered" : "ai_processing",
        folder: isDraft ? "drafts" : "sent", assignedAgentId: account.agentId, unreadCount: 0,
      });
      const attachments = rawAttachments.length && attachmentStorage
        ? await attachmentStorage.persist(c, r.params.companyId, thread.id, rawAttachments)
        : rawAttachments;
      const message = await repo.createMessage(c, r.params.companyId, {
        threadId: thread.id, emailAccountId: account.id, direction: "outbound",
        fromAddress: account.emailAddress, toAddresses, ccAddresses, bccAddresses, subject, bodyText,
        attachments, isDraft, isAiGenerated: false, sentByUserId: c.userId,
        deliveryStatus: isDraft ? "sending" : account.testMode ? "delivered" : "sending",
      });

      if (!isDraft && !account.testMode) {
        await repo.enqueueJob(c, r.params.companyId, {
          jobType: "send", emailAccountId: account.id, threadId: thread.id,
          messageId: message.id, idempotencyKey: `send:${message.id}`,
        });
        worker?.triggerTick();
      }
      if (auditRepo) {
        await auditRepo.log(c, r.params.companyId, {
          action: isDraft ? "email.draft_created" : "email.outbound_queued",
          category: "general", resourceType: "company_email_thread", resourceId: thread.id,
          details: { messageId: message.id, accountId: account.id, toAddresses, ccAddresses, bccCount: bccAddresses.length, attachmentCount: attachments.length },
        }).catch(() => undefined);
      }
      return reply.code(isDraft || account.testMode ? 201 : 202).send({
        thread, message, status: isDraft ? "draft" : account.testMode ? "simulated_send" : "queued",
      });
    } catch (e) { return err(reply, e); }
  });

  app.get<{
    Params: { companyId: string };
    Querystring: {
      folder?: EmailFolder;
      status?: EmailThreadStatus;
      priority?: EmailPriority;
      search?: string;
      accountId?: string;
      isVip?: string;
      limit?: string;
    };
  }>("/companies/:companyId/email-inbox/threads", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:read_messages");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);

      const threads = await repo.listThreads(c, r.params.companyId, {
        folder: r.query.folder,
        status: r.query.status,
        priority: r.query.priority,
        search: r.query.search,
        accountId: r.query.accountId,
        isVip: r.query.isVip ? r.query.isVip === "true" : undefined,
        limit: r.query.limit ? Number(r.query.limit) : 50,
      });

      return reply.header("Cache-Control", "no-store").code(200).send({ threads });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get<{
    Params: { companyId: string };
    Querystring: { accountId?: string };
  }>("/companies/:companyId/email-inbox/folder-counts", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:read_messages");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const counts = await repo.getFolderCounts(c, r.params.companyId, r.query.accountId);
      return reply.header("Cache-Control", "no-store").code(200).send({ counts });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get<{ Params: { companyId: string; threadId: string }; Querystring: { includeAudit?: string } }>(
    "/companies/:companyId/email-inbox/threads/:threadId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:read_messages");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);

        const thread = await repo.getThread(c, r.params.companyId, r.params.threadId);
        if (!thread) throw Object.assign(new Error("Thread not found"), { status: 404 });
        const [detail, logs] = await Promise.all([
          readThreadDetail(c, r.params.companyId, thread),
          r.query.includeAudit === "true" ? readThreadAudit(c, r.params.companyId, thread.id).catch(() => []) : undefined,
        ]);
        return reply.header("Cache-Control", "no-store").send({ ...detail, logs });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  app.patch<{
    Params: { companyId: string; threadId: string };
    Body: {
      status?: EmailThreadStatus;
      priority?: EmailPriority;
      folder?: EmailFolder;
      assignedAgentId?: string;
      assignedUserId?: string;
      unreadCount?: number;
    };
  }>("/companies/:companyId/email-inbox/threads/:threadId", async (r, reply) => {
    try {
      const changedKeys = Object.keys(r.body || {});
      const requiredPermission: EmailPermission = r.body?.folder === "archived"
        ? "email:delete_messages"
        : changedKeys.every((key) => key === "unreadCount")
          ? "email:read_messages"
          : "email:send_messages";
      const c = await ctx(auth, r, requiredPermission);
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const before = await repo.getThread(c, r.params.companyId, r.params.threadId);
      if (!before) throw Object.assign(new Error("Thread not found"), { status: 404 });
      const thread = await repo.updateThread(c, r.params.companyId, r.params.threadId, r.body || {});
      if (auditRepo) {
        const changed = Object.fromEntries(Object.keys(r.body || {}).map((key) => [key, {
          from: (before as unknown as Record<string, unknown>)[key],
          to: (thread as unknown as Record<string, unknown>)[key],
        }]));
        await auditRepo.log(c, r.params.companyId, {
          action: r.body?.folder === "archived" ? "email.archived" : "email.thread_updated",
          category: "general", resourceType: "company_email_thread", resourceId: thread.id, details: { changed },
        }).catch(() => undefined);
      }
      return reply.code(200).send({ thread });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.delete<{ Params: { companyId: string; threadId: string } }>(
    "/companies/:companyId/email-inbox/threads/:threadId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:delete_messages");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
        const thread = await repo.getThread(c, r.params.companyId, r.params.threadId);
        if (!thread) throw Object.assign(new Error("Thread not found"), { status: 404 });
        const threadMessages = attachmentStorage ? await repo.listMessages(c, r.params.companyId, thread.id) : [];
        if (auditRepo) {
          await auditRepo.log(c, r.params.companyId, {
            action: "email.deleted", category: "general", resourceType: "company_email_thread", resourceId: thread.id,
            details: { subject: thread.subject, customerEmail: thread.customerEmail },
          }).catch(() => undefined);
        }
        await repo.deleteThread(c, r.params.companyId, r.params.threadId);
        if (attachmentStorage) {
          await Promise.all(threadMessages.flatMap((message) => message.attachments.map((attachment) =>
            attachmentStorage.remove(c, r.params.companyId, attachment).catch(() => false)
          )));
        }
        return reply.code(200).send({ deleted: true });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  app.get<{ Params: { companyId: string; threadId: string } }>(
    "/companies/:companyId/email-inbox/threads/:threadId/audit",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:read_messages");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
        const logs = await readThreadAudit(c, r.params.companyId, r.params.threadId);
        return reply.code(200).send({ logs });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Send message / reply or save draft
  app.post<{
    Params: { companyId: string; threadId: string };
    Body: {
      bodyText: string;
      bodyHtml?: string;
      subject?: string;
      toAddresses?: string[];
      ccAddresses?: string[];
      bccAddresses?: string[];
      isDraft?: boolean;
      approvedDraftMessageId?: string;
      attachments?: EmailAttachment[];
    };
  }>("/companies/:companyId/email-inbox/threads/:threadId/messages", async (r, reply) => {
    try {
      const c = await ctx(auth, r, r.body?.approvedDraftMessageId ? "email:approve_drafts" : "email:send_messages");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);

      const thread = await repo.getThread(c, r.params.companyId, r.params.threadId);
      if (!thread) throw Object.assign(new Error("Thread not found"), { status: 404 });

      const accounts = await repo.listAccounts(c, r.params.companyId);
      const account = thread.emailAccountId
        ? accounts.find((a) => a.id === thread.emailAccountId) || accounts[0]
        : accounts[0];

      const fromAddress = account?.emailAddress || `support@${r.params.companyId}.company.com`;
      const toAddresses = r.body.toAddresses && r.body.toAddresses.length > 0 ? r.body.toAddresses : [thread.customerEmail];
      const isDraft = r.body.isDraft ?? false;

      // Rate limit check if sending live
      if (!isDraft && account) {
        const rateLimit = await repo.reserveSendQuota(r.params.companyId, account, toAddresses[0] || thread.customerEmail);
        if (!rateLimit.allowed) {
          throw Object.assign(new Error(`Rate limit exceeded: ${rateLimit.reason}`), { status: 429 });
        }
      }

      // If approving an existing draft message
      if (r.body.approvedDraftMessageId) {
        const draft = (await repo.listMessages(c, r.params.companyId, thread.id))
          .find((message) => message.id === r.body.approvedDraftMessageId);
        if (!draft || !draft.isDraft || draft.direction !== "outbound") {
          throw Object.assign(new Error("Approved draft was not found in this thread"), { status: 404 });
        }
        const updatedDraft = await repo.updateMessage(c, r.params.companyId, r.body.approvedDraftMessageId, {
          isDraft: false,
          aiDraftApprovedBy: c.userId,
          sentByUserId: c.userId,
          deliveryStatus: account?.testMode ? "delivered" : "sending",
        });

        if (account && !account.testMode) {
          await repo.enqueueJob(c, r.params.companyId, {
            jobType: "send", emailAccountId: account.id, threadId: thread.id,
            messageId: updatedDraft.id, idempotencyKey: `send:${updatedDraft.id}`,
          });
          worker?.triggerTick();
        }

        await repo.updateThread(c, r.params.companyId, thread.id, {
          status: account?.testMode ? "answered" : "ai_processing",
          ...(draft.isAiGenerated ? {} : { folder: "sent" as const }),
        });

        if (auditRepo) {
          await auditRepo
            .log(c, r.params.companyId, {
              action: "email.draft_approved",
              category: "automation",
              resourceType: "company_email_message",
              resourceId: updatedDraft.id,
              details: { threadId: thread.id, approvedBy: c.userId },
            })
            .catch(() => undefined);
        }

        return reply.code(account?.testMode ? 200 : 202).send({ message: updatedDraft, status: account?.testMode ? "sent" : "queued" });
      }

      const messageAttachments = r.body.attachments?.length && attachmentStorage
        ? await attachmentStorage.persist(c, r.params.companyId, thread.id, r.body.attachments)
        : r.body.attachments;
      const existingThreadMessages = await repo.listMessages(c, r.params.companyId, thread.id);
      const latestInbound = [...existingThreadMessages].reverse().find((m) => m.direction === "inbound");
      const msg = await repo.createMessage(c, r.params.companyId, {
        threadId: thread.id,
        emailAccountId: account?.id,
        direction: "outbound",
        fromAddress,
        toAddresses,
        ccAddresses: r.body.ccAddresses,
        bccAddresses: r.body.bccAddresses,
        subject: r.body.subject || `Re: ${thread.subject}`,
        bodyText: r.body.bodyText,
        bodyHtml: r.body.bodyHtml,
        attachments: messageAttachments,
        inReplyTo: latestInbound?.messageId || undefined,
        isDraft,
        sentByUserId: c.userId,
        deliveryStatus: isDraft ? "sending" : account?.testMode ? "delivered" : "sending",
      });

      if (!isDraft) {
        if (account && !account.testMode) {
          await repo.enqueueJob(c, r.params.companyId, {
            jobType: "send", emailAccountId: account.id, threadId: thread.id,
            messageId: msg.id, idempotencyKey: `send:${msg.id}`,
          });
          worker?.triggerTick();
        }
        await repo.updateThread(c, r.params.companyId, thread.id, {
          status: account?.testMode ? "answered" : "ai_processing",
        });
      }

      if (auditRepo) {
        await auditRepo.log(c, r.params.companyId, {
          action: isDraft ? "email.draft_saved" : account?.testMode ? "email.test_send_simulated" : "email.send_queued",
          category: "general", resourceType: "company_email_thread", resourceId: thread.id,
          details: { messageId: msg.id, toAddresses, attachmentCount: r.body.attachments?.length || 0 },
        }).catch(() => undefined);
      }

      return reply.code(!isDraft && account && !account.testMode ? 202 : 201).send({ message: msg });
    } catch (e) {
      return err(reply, e);
    }
  });

  // Edit draft message
  app.patch<{
    Params: { companyId: string; threadId: string; messageId: string };
    Body: { bodyText?: string; bodyHtml?: string };
  }>("/companies/:companyId/email-inbox/threads/:threadId/messages/:messageId", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:send_messages");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const existing = (await repo.listMessages(c, r.params.companyId, r.params.threadId))
        .find((message) => message.id === r.params.messageId);
      if (!existing) throw Object.assign(new Error("Message not found"), { status: 404 });
      if (!existing.isDraft || existing.direction !== "outbound") {
        throw Object.assign(new Error("Only outbound drafts can be edited"), { status: 409 });
      }
      const patch: { bodyText?: string; bodyHtml?: string } = {};
      if (r.body?.bodyText !== undefined) patch.bodyText = r.body.bodyText;
      if (r.body?.bodyHtml !== undefined) patch.bodyHtml = r.body.bodyHtml;
      const msg = await repo.updateMessage(c, r.params.companyId, r.params.messageId, patch);
      if (auditRepo) {
        await auditRepo.log(c, r.params.companyId, {
          action: existing.isAiGenerated ? "email.ai_draft_edited" : "email.draft_edited",
          category: "general", resourceType: "company_email_thread", resourceId: r.params.threadId,
          details: { messageId: msg.id, editedFields: Object.keys(r.body || {}) },
        }).catch(() => undefined);
      }
      return reply.code(200).send({ message: msg });
    } catch (e) {
      return err(reply, e);
    }
  });

  // Collision Protection Lock (Item 11)
  app.post<{
    Params: { companyId: string; threadId: string; messageId: string };
    Body: { status: "delivered" | "bounced" | "rejected" | "failed"; error?: string };
  }>("/companies/:companyId/email-inbox/threads/:threadId/messages/:messageId/delivery-event", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:manage_accounts");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const allowed = new Set(["delivered", "bounced", "rejected", "failed"]);
      if (!allowed.has(r.body?.status)) throw new Error("Unsupported delivery status");
      const message = await repo.updateMessage(c, r.params.companyId, r.params.messageId, {
        deliveryStatus: r.body.status,
        deliveryError: r.body.error || null,
      });
      if (r.body.status !== "delivered") {
        await repo.updateThread(c, r.params.companyId, r.params.threadId, { status: "failed" });
      }
      if (auditRepo) {
        await auditRepo.log(c, r.params.companyId, {
          action: `email.delivery_${r.body.status}`,
          category: "automation",
          resourceType: "company_email_message",
          resourceId: message.id,
          details: { threadId: r.params.threadId, error: r.body.error },
        }).catch(() => undefined);
      }
      return reply.code(200).send({ message });
    } catch (e) {
      return err(reply, e);
    }
  });

  // Collision Protection Lock (Item 11)
  app.post<{
    Params: { companyId: string; threadId: string };
    Body: { action: "acquire" | "release" };
  }>("/companies/:companyId/email-inbox/threads/:threadId/lock", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:read_messages");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);

      if (r.body?.action === "acquire") {
        const acquired = await repo.acquireLock(c, r.params.companyId, r.params.threadId);
        return reply.code(200).send({ acquired });
      } else {
        await repo.releaseLock(c, r.params.companyId, r.params.threadId);
        return reply.code(200).send({ released: true });
      }
    } catch (e) {
      return err(reply, e);
    }
  });

  // Human Takeover (Item 26)
  app.post<{
    Params: { companyId: string; threadId: string };
    Body: { takeover: boolean };
  }>("/companies/:companyId/email-inbox/threads/:threadId/takeover", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:configure_autopilot");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const thread = await repo.setHumanTakeover(c, r.params.companyId, r.params.threadId, r.body?.takeover ?? true);

      if (auditRepo) {
        await auditRepo
          .log(c, r.params.companyId, {
            action: r.body?.takeover ? "email.human_takeover" : "email.return_to_ai",
            category: "automation",
            resourceType: "company_email_thread",
            resourceId: thread.id,
            details: { isHumanTakeover: thread.isHumanTakeover, actor: c.userId },
          })
          .catch(() => undefined);
      }

      return reply.code(200).send({ thread });
    } catch (e) {
      return err(reply, e);
    }
  });
}
