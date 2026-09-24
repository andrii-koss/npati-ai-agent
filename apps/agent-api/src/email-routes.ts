import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { AuditRepository } from "./audit-repository";
import { EmailInboxRepository } from "./email-inbox-repository";
import { EmailAIProcessor } from "./email-ai-processor";
import { EmailDnsVerifier } from "./email-dns-verifier";
import { EmailConnectionTester } from "./email-connection-tester";
import { EmailAgentTools } from "./email-agent-tools";
import type {
  EmailFolder,
  EmailPriority,
  EmailThreadStatus,
} from "./email-inbox-types";

function err(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as any)?.status || 400;
  return reply.code(status).send({ error: { message } });
}

async function ctx(auth: AuthProvider, r: FastifyRequest, permission: "workspace:read" | "business:manage") {
  const scope = await auth.authenticate(r);
  const hasAccess =
    permission === "workspace:read"
      ? scope.permissions.includes("workspace:read") ||
        scope.permissions.includes("workspace:write") ||
        scope.permissions.includes("business:manage") ||
        scope.permissions.includes("admin:all") ||
        scope.permissions.includes("*")
      : scope.permissions.includes("business:manage") ||
        scope.permissions.includes("workspace:write") ||
        scope.permissions.includes("admin:all") ||
        scope.permissions.includes("*");

  if (!hasAccess) {
    throw Object.assign(new Error(`Missing required permission: ${permission}`), { status: 403 });
  }
  return scope;
}

export function registerEmailInboxRoutes(
  app: FastifyInstance,
  options: {
    auth: AuthProvider;
    store: WorkspaceStore;
    repo: EmailInboxRepository;
    auditRepo?: AuditRepository;
  }
) {
  const { auth, store, repo, auditRepo } = options;
  const aiProcessor = new EmailAIProcessor(repo, auditRepo);
  const agentTools = new EmailAgentTools(repo);

  // =========================================================================
  // 1. Email Accounts (Settings -> Email)
  // =========================================================================

  app.get<{ Params: { companyId: string } }>("/companies/:companyId/email-accounts", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "workspace:read");
      await store.getCompany(c, r.params.companyId);
      const accounts = await repo.listAccounts(c, r.params.companyId);
      return reply.code(200).send({ accounts });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.post<{
    Params: { companyId: string };
    Body: {
      emailAddress: string;
      displayName?: string;
      agentId?: string;
      mode?: "manual" | "approval" | "autopilot";
      testMode?: boolean;
      confidenceThreshold?: number;
      languageMode?: string;
      fallbackLanguage?: string;
      imapConfig?: any;
      smtpConfig?: any;
      rateLimits?: any;
      signatureConfig?: any;
      followupConfig?: any;
    };
  }>("/companies/:companyId/email-accounts", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);

      if (!r.body?.emailAddress || !r.body.emailAddress.includes("@")) {
        throw new Error("Valid emailAddress is required.");
      }

      const account = await repo.createAccount(c, r.params.companyId, r.body);
      if (auditRepo) {
        await auditRepo
          .log(c, r.params.companyId, {
            action: "email_account.created",
            category: "general",
            resourceType: "company_email_account",
            resourceId: account.id,
            details: { emailAddress: account.emailAddress, mode: account.mode },
          })
          .catch(() => undefined);
      }
      return reply.code(201).send({ account });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get<{ Params: { companyId: string; accountId: string } }>(
    "/companies/:companyId/email-accounts/:accountId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "workspace:read");
        await store.getCompany(c, r.params.companyId);
        const account = await repo.getAccount(c, r.params.companyId, r.params.accountId);
        if (!account) throw Object.assign(new Error("Email account not found"), { status: 404 });
        return reply.code(200).send({ account });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  app.patch<{
    Params: { companyId: string; accountId: string };
    Body: Record<string, any>;
  }>("/companies/:companyId/email-accounts/:accountId", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const account = await repo.updateAccount(c, r.params.companyId, r.params.accountId, r.body || {});
      return reply.code(200).send({ account });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.delete<{ Params: { companyId: string; accountId: string } }>(
    "/companies/:companyId/email-accounts/:accountId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await store.getCompany(c, r.params.companyId);
        await repo.deleteAccount(c, r.params.companyId, r.params.accountId);
        return reply.code(200).send({ deleted: true });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // Connection Test
  app.post<{
    Params: { companyId: string; accountId: string };
    Body: { imapConfig?: any; smtpConfig?: any };
  }>("/companies/:companyId/email-accounts/:accountId/test-connection", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const account = await repo.getAccount(c, r.params.companyId, r.params.accountId);
      if (!account) throw Object.assign(new Error("Email account not found"), { status: 404 });

      const imap = r.body?.imapConfig || account.imapConfig;
      const smtp = r.body?.smtpConfig || account.smtpConfig;

      const result = await EmailConnectionTester.testAll(imap, smtp, account.testMode);

      // Update account status based on test result
      const newStatus = result.success ? "connected" : !result.imapStatus?.ok ? "imap_error" : "smtp_error";
      await repo.updateAccount(c, r.params.companyId, account.id, {
        status: newStatus,
        imapConfig: { ...account.imapConfig, lastError: result.imapStatus?.ok ? null : result.imapStatus?.message },
        smtpConfig: { ...account.smtpConfig, lastError: result.smtpStatus?.ok ? null : result.smtpStatus?.message },
      });

      return reply.code(200).send({ result, status: newStatus });
    } catch (e) {
      return err(reply, e);
    }
  });

  // DNS Verification
  app.post<{
    Params: { companyId: string; accountId: string };
    Body: { domain?: string; selector?: string };
  }>("/companies/:companyId/email-accounts/:accountId/dns-check", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "workspace:read");
      await store.getCompany(c, r.params.companyId);
      const account = await repo.getAccount(c, r.params.companyId, r.params.accountId);
      if (!account) throw Object.assign(new Error("Email account not found"), { status: 404 });

      const domain = r.body?.domain || account.emailAddress.split("@")[1];
      if (!domain) throw new Error("Could not extract domain from email account.");

      const result = await EmailDnsVerifier.verifyDomain(domain, r.body?.selector || "default");
      return reply.code(200).send({ result });
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 2. Email Inbox Threads & Messages (Items 6, 7, 8)
  // =========================================================================

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
      const c = await ctx(auth, r, "workspace:read");
      await store.getCompany(c, r.params.companyId);

      const threads = await repo.listThreads(c, r.params.companyId, {
        folder: r.query.folder,
        status: r.query.status,
        priority: r.query.priority,
        search: r.query.search,
        accountId: r.query.accountId,
        isVip: r.query.isVip ? r.query.isVip === "true" : undefined,
        limit: r.query.limit ? Number(r.query.limit) : 50,
      });

      return reply.code(200).send({ threads });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get<{ Params: { companyId: string; threadId: string } }>(
    "/companies/:companyId/email-inbox/threads/:threadId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "workspace:read");
        await store.getCompany(c, r.params.companyId);

        const thread = await repo.getThread(c, r.params.companyId, r.params.threadId);
        if (!thread) throw Object.assign(new Error("Thread not found"), { status: 404 });

        const messages = await repo.listMessages(c, r.params.companyId, thread.id);
        const contact = await repo.getContact(c, r.params.companyId, thread.customerEmail);

        return reply.code(200).send({ thread, messages, contact });
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
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const thread = await repo.updateThread(c, r.params.companyId, r.params.threadId, r.body || {});
      return reply.code(200).send({ thread });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.delete<{ Params: { companyId: string; threadId: string } }>(
    "/companies/:companyId/email-inbox/threads/:threadId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await store.getCompany(c, r.params.companyId);
        await repo.deleteThread(c, r.params.companyId, r.params.threadId);
        return reply.code(200).send({ deleted: true });
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
    };
  }>("/companies/:companyId/email-inbox/threads/:threadId/messages", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);

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
        const rateLimit = repo.checkRateLimit(r.params.companyId, account, toAddresses[0] || thread.customerEmail);
        if (!rateLimit.allowed) {
          throw new Error(`Rate limit exceeded: ${rateLimit.reason}`);
        }
        repo.recordSentEmail(r.params.companyId, account.id, toAddresses[0] || thread.customerEmail);
      }

      // If approving an existing draft message
      if (r.body.approvedDraftMessageId) {
        const updatedDraft = await repo.updateMessage(c, r.params.companyId, r.body.approvedDraftMessageId, {
          isDraft: false,
          aiDraftApprovedBy: c.userId,
          sentByUserId: c.userId,
          deliveryStatus: account?.testMode ? "delivered" : "sent",
        });

        await repo.updateThread(c, r.params.companyId, thread.id, {
          status: "answered",
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

        return reply.code(200).send({ message: updatedDraft, status: "sent" });
      }

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
        isDraft,
        sentByUserId: c.userId,
        deliveryStatus: isDraft ? "sending" : account?.testMode ? "delivered" : "sent",
      });

      if (!isDraft) {
        await repo.updateThread(c, r.params.companyId, thread.id, {
          status: "answered",
        });
      }

      return reply.code(201).send({ message: msg });
    } catch (e) {
      return err(reply, e);
    }
  });

  // Edit draft message
  app.patch<{
    Params: { companyId: string; threadId: string; messageId: string };
    Body: { bodyText?: string; bodyHtml?: string; isDraft?: boolean };
  }>("/companies/:companyId/email-inbox/threads/:threadId/messages/:messageId", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const msg = await repo.updateMessage(c, r.params.companyId, r.params.messageId, r.body || {});
      return reply.code(200).send({ message: msg });
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
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);

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
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
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

  // =========================================================================
  // 3. Inbound Processing & Simulation (Items 5, 6, 22)
  // =========================================================================

  app.post<{
    Params: { companyId: string };
    Body: {
      from: string;
      to?: string;
      subject: string;
      body: string;
      bodyHtml?: string;
      attachments?: any[];
      threadKey?: string;
    };
  }>("/companies/:companyId/email-inbox/inbound", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);

      const result = await aiProcessor.processInbound(c, r.params.companyId, r.body);
      return reply.code(200).send(result);
    } catch (e) {
      return err(reply, e);
    }
  });

  app.post<{
    Params: { companyId: string };
    Body: {
      from?: string;
      to?: string;
      subject?: string;
      body?: string;
      attachments?: any[];
    };
  }>("/companies/:companyId/email-inbox/simulate", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);

      const accounts = await repo.listAccounts(c, r.params.companyId);
      const targetAccount = accounts[0];

      const simPayload = {
        from: r.body?.from || "partner@example.com",
        to: r.body?.to || targetAccount?.emailAddress || `support@${r.params.companyId}.company.com`,
        subject: r.body?.subject || "Urgent: System access confirmation requested",
        body: r.body?.body || "Hello, we need urgent confirmation for system activation. Please review the attached document.",
        attachments: r.body?.attachments || [],
      };

      const result = await aiProcessor.processInbound(c, r.params.companyId, simPayload);
      return reply.code(200).send({ simulation: true, ...result });
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 4. Contacts & VIP / Blacklist (Items 10, 20)
  // =========================================================================

  app.get<{ Params: { companyId: string; email: string } }>(
    "/companies/:companyId/email-inbox/contacts/:email",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "workspace:read");
        await store.getCompany(c, r.params.companyId);
        const contact = await repo.getContact(c, r.params.companyId, r.params.email);
        return reply.code(200).send({ contact });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  app.patch<{
    Params: { companyId: string; email: string };
    Body: {
      name?: string;
      companyName?: string;
      phone?: string;
      isVip?: boolean;
      isBlacklisted?: boolean;
      notes?: string;
    };
  }>("/companies/:companyId/email-inbox/contacts/:email", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const contact = await repo.upsertContact(c, r.params.companyId, {
        email: r.params.email,
        ...r.body,
      });
      return reply.code(200).send({ contact });
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 5. Templates & Signatures (Item 13)
  // =========================================================================

  app.get<{ Params: { companyId: string } }>("/companies/:companyId/email-inbox/templates", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "workspace:read");
      await store.getCompany(c, r.params.companyId);
      const templates = await repo.listTemplates(c, r.params.companyId);
      return reply.code(200).send({ templates });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.post<{
    Params: { companyId: string };
    Body: { title: string; category?: string; subjectTemplate?: string; bodyTemplate: string; emailAccountId?: string };
  }>("/companies/:companyId/email-inbox/templates", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const template = await repo.createTemplate(c, r.params.companyId, r.body);
      return reply.code(201).send({ template });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.delete<{ Params: { companyId: string; templateId: string } }>(
    "/companies/:companyId/email-inbox/templates/:templateId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await store.getCompany(c, r.params.companyId);
        await repo.deleteTemplate(c, r.params.companyId, r.params.templateId);
        return reply.code(200).send({ deleted: true });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // =========================================================================
  // 6. Email Rules (Item 25)
  // =========================================================================

  app.get<{ Params: { companyId: string } }>("/companies/:companyId/email-inbox/rules", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "workspace:read");
      await store.getCompany(c, r.params.companyId);
      const rules = await repo.listRules(c, r.params.companyId);
      return reply.code(200).send({ rules });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.post<{
    Params: { companyId: string };
    Body: { name: string; emailAccountId?: string; conditions?: any; actions?: any; priorityOrder?: number };
  }>("/companies/:companyId/email-inbox/rules", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const rule = await repo.createRule(c, r.params.companyId, r.body);
      return reply.code(201).send({ rule });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.delete<{ Params: { companyId: string; ruleId: string } }>(
    "/companies/:companyId/email-inbox/rules/:ruleId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await store.getCompany(c, r.params.companyId);
        await repo.deleteRule(c, r.params.companyId, r.params.ruleId);
        return reply.code(200).send({ deleted: true });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // =========================================================================
  // 7. Email Analytics (Item 23)
  // =========================================================================

  app.get<{ Params: { companyId: string } }>("/companies/:companyId/email-inbox/analytics", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "workspace:read");
      await store.getCompany(c, r.params.companyId);
      const analytics = await repo.getAnalytics(c, r.params.companyId);
      return reply.code(200).send({ analytics });
    } catch (e) {
      return err(reply, e);
    }
  });

  // =========================================================================
  // 8. Agent Email Tooling & Verification Link Security (Items 18 & 19)
  // =========================================================================

  app.post<{
    Params: { companyId: string };
    Body: { url: string; senderEmail?: string };
  }>("/companies/:companyId/email-inbox/inspect-link", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "workspace:read");
      await store.getCompany(c, r.params.companyId);
      const result = agentTools.inspectLinkSecurity(r.body.url, r.body.senderEmail);
      return reply.code(200).send({ check: result });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.post<{
    Params: { companyId: string };
    Body: { text: string };
  }>("/companies/:companyId/email-inbox/extract-code", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "workspace:read");
      await store.getCompany(c, r.params.companyId);
      const result = agentTools.extractVerification(r.body.text || "");
      return reply.code(200).send(result);
    } catch (e) {
      return err(reply, e);
    }
  });
}
