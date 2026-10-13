import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import { EmailDnsVerifier } from "./email-dns-verifier";
import { EmailConnectionTester } from "./email-connection-tester";
import {
  type EmailRoutesContext,
  presentEmailAccount,
  ctx,
  err,
  resolveEmailScope,
} from "./email-routes-context";

export function registerEmailManagementRoutes(
  app: FastifyInstance,
  context: EmailRoutesContext,
) {
  const { auth, store, repo, auditRepo, attachmentStorage, aiProcessor, agentTools } = context;

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
