import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { AIEngine } from "@npati/omniroute-adapter";
import type { AuthProvider } from "./auth";
import type { AuditRepository } from "./audit-repository";
import { EmailInboxRepository } from "./email-inbox-repository";
import { EmailAIProcessor, type EmailAutomationHooks } from "./email-ai-processor";
import { EmailDnsVerifier } from "./email-dns-verifier";
import { EmailConnectionTester } from "./email-connection-tester";
import { EmailAgentTools } from "./email-agent-tools";
import type { EmailAttachmentStorage } from "./email-attachment-storage";
import type { EmailInboxWorker } from "./email-worker";
import type {
  CompanyEmailAccount,
  EmailAttachment,
  EmailFolder,
  EmailPriority,
  EmailThreadStatus,
} from "./email-inbox-types";

function presentEmailAccount(account: CompanyEmailAccount): CompanyEmailAccount {
  const { password: _imapPassword, accessToken: _imapAccess, refreshToken: _imapRefresh, clientSecret: _imapSecret, ...imapConfig } = account.imapConfig;
  const { password: _smtpPassword, accessToken: _smtpAccess, refreshToken: _smtpRefresh, clientSecret: _smtpSecret, ...smtpConfig } = account.smtpConfig;
  return { ...account, imapConfig, smtpConfig };
}

function err(reply: FastifyReply, error: unknown) {
  const duplicateMailbox = (error as any)?.code === "23505"
    && (error as any)?.constraint === "company_email_accounts_user_address_unique";
  const message = duplicateMailbox
    ? "This email address is already connected. Edit the existing account instead of adding it again."
    : error instanceof Error ? error.message : String(error);
  const status = duplicateMailbox ? 409 : (error as any)?.status || 400;
  return reply.code(status).send({ error: { message } });
}

type EmailPermission =
  | "workspace:read" | "business:manage" | "email:view" | "email:manage_accounts"
  | "email:read_messages" | "email:send_messages" | "email:delete_messages"
  | "email:approve_drafts" | "email:configure_autopilot" | "email:configure_agents"
  | "email:view_analytics";

async function ctx(auth: AuthProvider, r: FastifyRequest, permission: EmailPermission) {
  const scope = await auth.authenticate(r);
  const emailReadPermission = ["email:view", "email:read_messages", "email:view_analytics"].includes(permission);
  const hasAccess = scope.permissions.includes(permission) ||
    (permission === "workspace:read" || emailReadPermission
      ? scope.permissions.includes("workspace:read") ||
      scope.permissions.includes("workspace:write") ||
      scope.permissions.includes("business:manage") ||
      scope.permissions.includes("admin:all") ||
      scope.permissions.includes("*")
      : scope.permissions.includes("business:manage") ||
      scope.permissions.includes("workspace:write") ||
      scope.permissions.includes("admin:all") ||
      scope.permissions.includes("*"));

  if (!hasAccess) {
    throw Object.assign(new Error(`Missing required permission: ${permission}`), { status: 403 });
  }
  return scope;
}

const PERSONAL_EMAIL_SCOPE = "personal";

function personalEmailScopeId(context: AuthContext): string {
  return `personal:${createHash("sha256").update(`${context.workspaceId}:${context.userId}`).digest("hex").slice(0, 32)}`;
}

async function resolveEmailScope(store: WorkspaceStore, context: AuthContext, requestedScope: string): Promise<string> {
  const personalScope = personalEmailScopeId(context);
  if (requestedScope === PERSONAL_EMAIL_SCOPE || requestedScope === personalScope) return personalScope;
  if (requestedScope.startsWith(`${PERSONAL_EMAIL_SCOPE}:`)) {
    throw Object.assign(new Error("This personal email scope belongs to another user."), { status: 403 });
  }
  await store.getCompany(context, requestedScope);
  return requestedScope;
}

export function registerEmailInboxRoutes(
  app: FastifyInstance,
  options: {
    auth: AuthProvider;
    store: WorkspaceStore;
    repo: EmailInboxRepository;
    auditRepo?: AuditRepository;
    aiEngine?: AIEngine;
    automationHooks?: EmailAutomationHooks;
    attachmentStorage?: EmailAttachmentStorage;
    worker?: EmailInboxWorker;
  }
) {
  const { auth, store, repo, auditRepo, aiEngine, automationHooks, attachmentStorage, worker } = options;
  const aiProcessor = new EmailAIProcessor(repo, auditRepo, aiEngine, automationHooks);
  const agentTools = new EmailAgentTools(repo);

  // =========================================================================
  // 1. Email Accounts (Settings -> Email)
  // =========================================================================

  app.get<{ Params: { companyId: string } }>("/companies/:companyId/email-accounts", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:view");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const accounts = await repo.listAccounts(c, r.params.companyId);
      return reply.code(200).send({ accounts: accounts.map(presentEmailAccount) });
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
      const c = await ctx(auth, r, "email:manage_accounts");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);

      if (!r.body?.emailAddress || !r.body.emailAddress.includes("@")) {
        throw new Error("Valid emailAddress is required.");
      }

      const duplicate = await repo.findUserAccountByEmail(c, r.body.emailAddress);
      if (duplicate) {
        throw Object.assign(new Error("This email address is already connected. Edit the existing account instead of adding it again with another authentication method."), { status: 409 });
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
      return reply.code(201).send({ account: presentEmailAccount(account) });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get<{ Params: { companyId: string; accountId: string } }>(
    "/companies/:companyId/email-accounts/:accountId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:view");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
        const account = await repo.getAccount(c, r.params.companyId, r.params.accountId);
        if (!account) throw Object.assign(new Error("Email account not found"), { status: 404 });
        return reply.code(200).send({ account: presentEmailAccount(account) });
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
      const c = await ctx(auth, r, "email:manage_accounts");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const account = await repo.updateAccount(c, r.params.companyId, r.params.accountId, r.body || {});
      return reply.code(200).send({ account: presentEmailAccount(account) });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.delete<{ Params: { companyId: string; accountId: string } }>(
    "/companies/:companyId/email-accounts/:accountId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:manage_accounts");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
        await repo.deleteAccount(c, r.params.companyId, r.params.accountId);
        return reply.code(200).send({ deleted: true });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  app.post<{
    Params: { companyId: string; accountId: string };
    Body: { authorizationUrl: string; tokenUrl: string; clientId: string; clientSecret?: string; scopes?: string[]; redirectUri: string };
  }>("/companies/:companyId/email-accounts/:accountId/oauth/authorize", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:manage_accounts");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const account = await repo.getAccount(c, r.params.companyId, r.params.accountId);
      if (!account) throw Object.assign(new Error("Email account not found"), { status: 404 });
      const authorizationUrl = new URL(r.body.authorizationUrl);
      const tokenUrl = new URL(r.body.tokenUrl);
      const redirectUri = new URL(r.body.redirectUri);
      const safeProtocol = (url: URL) => {
        const host = url.hostname.toLowerCase();
        const localDevelopment = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(host);
        const privateHost = host === "0.0.0.0" || /^10\./.test(host) || /^192\.168\./.test(host)
          || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1";
        return (!privateHost || localDevelopment) && (url.protocol === "https:" || (url.protocol === "http:" && localDevelopment));
      };
      if (!safeProtocol(authorizationUrl) || !safeProtocol(tokenUrl) || !safeProtocol(redirectUri)) {
        throw new Error("OAuth endpoints and redirect URI must use HTTPS (localhost HTTP is allowed for development)");
      }
      if (!r.body.clientId?.trim()) throw new Error("OAuth clientId is required");
      const state = randomBytes(32).toString("base64url");
      const stateHash = createHash("sha256").update(state).digest("hex");
      const verifier = randomBytes(48).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      await repo.createOAuthState(c, r.params.companyId, account.id, {
        stateHash, verifier, tokenUrl: tokenUrl.toString(), clientId: r.body.clientId.trim(),
        clientSecret: r.body.clientSecret, redirectUri: redirectUri.toString(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      await repo.updateAccount(c, r.params.companyId, account.id, {
        imapConfig: {
          authType: "oauth2", tokenUrl: tokenUrl.toString(), clientId: r.body.clientId.trim(),
          ...(r.body.clientSecret ? { clientSecret: r.body.clientSecret } : {})
        },
        smtpConfig: {
          authType: "oauth2", tokenUrl: tokenUrl.toString(), clientId: r.body.clientId.trim(),
          ...(r.body.clientSecret ? { clientSecret: r.body.clientSecret } : {})
        },
        status: "pending",
      });
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("client_id", r.body.clientId.trim());
      authorizationUrl.searchParams.set("redirect_uri", redirectUri.toString());
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("code_challenge", challenge);
      authorizationUrl.searchParams.set("code_challenge_method", "S256");
      if (r.body.scopes?.length) authorizationUrl.searchParams.set("scope", r.body.scopes.join(" "));
      return reply.code(200).send({ authorizationUrl: authorizationUrl.toString(), expiresInSeconds: 600 });
    } catch (e) { return err(reply, e); }
  });

  app.get<{ Querystring: { state?: string; code?: string; error?: string; error_description?: string } }>(
    "/email/oauth/callback",
    async (r, reply) => {
      try {
        if (!r.query.state) throw new Error("OAuth state is required");
        const stateHash = createHash("sha256").update(r.query.state).digest("hex");
        const state = await repo.consumeOAuthState(stateHash);
        if (!state) throw Object.assign(new Error("OAuth state is invalid, expired, or already used"), { status: 400 });
        if (r.query.error) throw new Error(`OAuth authorization failed: ${r.query.error_description || r.query.error}`);
        if (!r.query.code) throw new Error("OAuth authorization code is required");
        const body = new URLSearchParams({
          grant_type: "authorization_code", code: r.query.code,
          client_id: state.clientId, redirect_uri: state.redirectUri, code_verifier: state.verifier
        });
        if (state.clientSecret) body.set("client_secret", state.clientSecret);
        const tokenResponse = await fetch(state.tokenUrl, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body, redirect: "error", signal: AbortSignal.timeout(15_000)
        });
        const token = await tokenResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
        if (!tokenResponse.ok || !token.access_token) throw new Error(`OAuth token exchange failed: ${token.error || tokenResponse.status}`);
        const internalCtx: AuthContext = { userId: state.userId, workspaceId: state.workspaceId, permissions: ["admin:all"] };
        const account = await repo.getAccount(internalCtx, state.companyId, state.accountId);
        if (!account) throw Object.assign(new Error("Email account no longer exists"), { status: 404 });
        const credentials = {
          authType: "oauth2" as const, accessToken: token.access_token,
          refreshToken: token.refresh_token || account.imapConfig.refreshToken || account.smtpConfig.refreshToken,
          tokenExpiresAt: new Date(Date.now() + Math.max(60, token.expires_in || 3600) * 1000).toISOString()
        };
        await repo.updateAccount(internalCtx, state.companyId, state.accountId, {
          imapConfig: credentials, smtpConfig: credentials, status: "pending",
        });
        return reply.code(200).send({ connected: true, accountId: state.accountId, message: "OAuth authorization completed. Run Test Connection to verify IMAP and SMTP." });
      } catch (e) { return err(reply, e); }
    }
  );

  // Connection Test
  app.post<{
    Params: { companyId: string; accountId: string };
    Body: { imapConfig?: any; smtpConfig?: any };
  }>("/companies/:companyId/email-accounts/:accountId/test-connection", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:manage_accounts");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const account = await repo.getAccount(c, r.params.companyId, r.params.accountId);
      if (!account) throw Object.assign(new Error("Email account not found"), { status: 404 });

      const imap = r.body?.imapConfig || account.imapConfig;
      const smtp = r.body?.smtpConfig || account.smtpConfig;

      const result = await EmailConnectionTester.testAll(imap, smtp, account.testMode);

      // Update account status based on test result
      const newStatus = result.success
        ? "connected"
        : !result.smtpStatus?.ok
          ? "smtp_error"
          : "imap_error";
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
      const c = await ctx(auth, r, "email:view");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
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

  app.get<{ Params: { companyId: string; threadId: string } }>(
    "/companies/:companyId/email-inbox/threads/:threadId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:read_messages");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);

        const thread = await repo.getThread(c, r.params.companyId, r.params.threadId);
        if (!thread) throw Object.assign(new Error("Thread not found"), { status: 404 });
        const messages = await repo.listMessages(c, r.params.companyId, thread.id);
        const contact = await repo.getContact(c, r.params.companyId, thread.customerEmail);
        const previousThreads = (await repo.listThreads(c, r.params.companyId, { search: thread.customerEmail, limit: 50 }))
          .filter((item) => item.id !== thread.id && item.customerEmail === thread.customerEmail)
          .map((item) => ({ id: item.id, subject: item.subject, status: item.status, priority: item.priority, lastMessageAt: item.lastMessageAt }));
        const companyRuns = r.params.companyId.startsWith(`${PERSONAL_EMAIL_SCOPE}:`)
          ? []
          : await store.listCompanyAgentRuns(c, r.params.companyId, 100);
        const relatedTasks = companyRuns
          .filter((run) => run.task.includes(thread.customerEmail) || run.task.includes(thread.id))
          .slice(0, 20)
          .map((run) => ({ id: run.id, task: run.task, status: run.status, createdAt: run.createdAt }));

        return reply.header("Cache-Control", "no-store").code(200).send({
          thread, messages, contact,
          customerContext: { previousThreads, tasks: relatedTasks },
        });
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

  // Send message / reply or save draft
  app.get<{ Params: { companyId: string; threadId: string } }>(
    "/companies/:companyId/email-inbox/threads/:threadId/audit",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:read_messages");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
        const logs = auditRepo
          ? await auditRepo.listResourceLogs(c, r.params.companyId, "company_email_thread", r.params.threadId)
          : [];
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
      messageId?: string;
      inReplyTo?: string;
      references?: string;
    };
  }>("/companies/:companyId/email-inbox/inbound", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:manage_accounts");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);

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
      const c = await ctx(auth, r, "email:configure_autopilot");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);

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

  app.get<{ Params: { companyId: string } }>(
    "/companies/:companyId/email-inbox/contacts",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:view");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
        const contacts = await repo.listContacts(c, r.params.companyId);
        return reply.code(200).send({ contacts });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  app.get<{ Params: { companyId: string; email: string } }>(
    "/companies/:companyId/email-inbox/contacts/:email",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:view");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
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
      const c = await ctx(auth, r, "email:manage_accounts");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
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
      const c = await ctx(auth, r, "email:view");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
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
      const c = await ctx(auth, r, "email:configure_autopilot");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const template = await repo.createTemplate(c, r.params.companyId, r.body);
      return reply.code(201).send({ template });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.patch<{
    Params: { companyId: string; templateId: string };
    Body: { title?: string; category?: string; subjectTemplate?: string | null; bodyTemplate?: string };
  }>("/companies/:companyId/email-inbox/templates/:templateId", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:configure_autopilot");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const template = await repo.updateTemplate(c, r.params.companyId, r.params.templateId, r.body || {});
      return reply.code(200).send({ template });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.delete<{ Params: { companyId: string; templateId: string } }>(
    "/companies/:companyId/email-inbox/templates/:templateId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:configure_autopilot");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
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
      const c = await ctx(auth, r, "email:view");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
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
      const c = await ctx(auth, r, "email:configure_autopilot");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const rule = await repo.createRule(c, r.params.companyId, r.body);
      return reply.code(201).send({ rule });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.patch<{
    Params: { companyId: string; ruleId: string };
    Body: { name?: string; conditions?: any; actions?: any; isActive?: boolean; priorityOrder?: number };
  }>("/companies/:companyId/email-inbox/rules/:ruleId", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:configure_autopilot");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const rule = await repo.updateRule(c, r.params.companyId, r.params.ruleId, r.body || {});
      return reply.code(200).send({ rule });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.delete<{ Params: { companyId: string; ruleId: string } }>(
    "/companies/:companyId/email-inbox/rules/:ruleId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:configure_autopilot");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
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
      const c = await ctx(auth, r, "email:view_analytics");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const analytics = await repo.getAnalytics(c, r.params.companyId);
      return reply.code(200).send({ analytics });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get<{ Params: { companyId: string }; Querystring: { limit?: string } }>(
    "/companies/:companyId/email-inbox/notifications",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:read_messages");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
        const notifications = await repo.listNotifications(c, r.params.companyId, Number(r.query.limit || 50));
        return reply.code(200).send({ notifications });
      } catch (e) { return err(reply, e); }
    }
  );

  app.patch<{ Params: { companyId: string; notificationId: string } }>(
    "/companies/:companyId/email-inbox/notifications/:notificationId/read",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:read_messages");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
        await repo.markNotificationRead(c, r.params.companyId, r.params.notificationId);
        return reply.code(200).send({ read: true });
      } catch (e) { return err(reply, e); }
    }
  );

  app.get<{ Params: { companyId: string; attachmentId: string } }>(
    "/companies/:companyId/email-inbox/attachments/:attachmentId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "email:read_messages");
        r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
        if (!attachmentStorage || !/^[0-9a-f-]{36}$/i.test(r.params.attachmentId)) return reply.code(404).send();
        const opened = await attachmentStorage.open(c, r.params.companyId, r.params.attachmentId);
        if (!opened) return reply.code(404).send();
        const safeName = opened.file.originalFilename.replace(/[\r\n"\\]/g, "_").slice(0, 240) || "attachment";
        return reply
          .header("content-type", opened.file.mimeType || "application/octet-stream")
          .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`)
          .header("cache-control", "private, no-store")
          .header("x-content-type-options", "nosniff")
          .send(opened.stream);
      } catch (e) { return err(reply, e); }
    }
  );

  // =========================================================================
  // 8. Agent Email Tooling & Verification Link Security (Items 18 & 19)
  // =========================================================================

  app.post<{
    Params: { companyId: string };
    Body: { url: string; senderEmail?: string };
  }>("/companies/:companyId/email-inbox/inspect-link", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "email:read_messages");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const sender = r.body.senderEmail?.trim();
      const contact = sender ? await repo.getContact(c, r.params.companyId, sender) : null;
      const result = agentTools.inspectLinkSecurity(r.body.url, sender, contact?.isBlacklisted === true);
      if (auditRepo) {
        await auditRepo.log(c, r.params.companyId, {
          action: "email.link_open_requested", category: "security", resourceType: "company_email_link",
          details: { domain: result.domain, threatLevel: result.threatLevel, requiresHumanApproval: result.requiresHumanApproval },
        }).catch(() => undefined);
      }
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
      const c = await ctx(auth, r, "email:read_messages");
      r.params.companyId = await resolveEmailScope(store, c, r.params.companyId);
      const result = agentTools.extractVerification(r.body.text || "");
      return reply.code(200).send(result);
    } catch (e) {
      return err(reply, e);
    }
  });
}
