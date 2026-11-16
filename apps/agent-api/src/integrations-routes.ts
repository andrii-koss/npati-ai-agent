import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { CompanyWebhook, IntegrationsRepository } from "./integrations-repository";
import { PromptInjectionGuard, CredentialMasker } from "./security-guardrails";
import { parseDestination, resolveAndValidate, SsrfPolicyError, type ResolverPort } from "./ssrf-policy";

function hasPermission(scope: any, permission: string): boolean {
  if (!scope || !Array.isArray(scope.permissions)) return false;
  if (scope.permissions.includes("*") || scope.permissions.includes("admin:all") || scope.permissions.includes("owner")) return true;
  if (scope.permissions.includes(permission)) return true;
  if (permission === "workspace:read") {
    return scope.permissions.includes("workspace:read") || scope.permissions.includes("workspace:write") || scope.permissions.includes("business:manage");
  }
  if (permission === "business:manage") {
    return scope.permissions.includes("business:manage") || scope.permissions.includes("workspace:write");
  }
  return false;
}

async function ctx(auth: AuthProvider, r: FastifyRequest, permission: "workspace:read" | "business:manage") {
  const c = await auth.authenticate(r);
  if (!hasPermission(c, permission)) throw new WorkspaceAccessError("Missing permission: " + permission);
  return c;
}

/**
 * An MCP server as the API returns it: the stored auth token never leaves the server. Listing used to return it in
 * plain text, so even a read-only company key could read every MCP token (V6 step 17). The runtime reads the token
 * from the repository directly.
 */
export function publicMcpServer<T extends { authToken?: string | null }>(server: T): Omit<T, "authToken"> & { hasAuthToken: boolean } {
  const { authToken, ...rest } = server;
  return { ...rest, hasAuthToken: Boolean(authToken) };
}

/**
 * An MCP endpoint is checked with the SSRF policy when it is saved, not only when it is dialled: loopback, metadata,
 * private and internal-service addresses (in any encoding, or by a name that resolves to them) were saved without a
 * word and could only fail later (V6 step 17). Any port is allowed for a public host; an unresolvable public name is
 * kept, because it is checked again before every connection.
 */
export async function assertPublicMcpEndpoint(endpoint: string, resolve?: ResolverPort) {
  try {
    const port = (() => { try { const url = new URL(endpoint); return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80; } catch { return 443; } })();
    const destination = parseDestination(endpoint, { allowlist: ["*"], allowedPorts: [port] });
    // Names under internal-only zones are never public, even when they do not resolve here (metadata.google.internal).
    if (!destination.isIpLiteral && /(?:^|\.)(?:internal|local|localhost|localdomain|lan|intranet|corp|home\.arpa)$/i.test(destination.host.replace(/\.$/, ""))) {
      throw new SsrfPolicyError("host_not_allowed", "Internal-only host names are not allowed");
    }
    await resolveAndValidate(destination, resolve ?? (async (host) => (await (await import("node:dns/promises")).lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)));
  } catch (error) {
    if (error instanceof SsrfPolicyError && error.code === "dns_resolution_failed") return;
    if (error instanceof SsrfPolicyError) throw Object.assign(new Error("The MCP endpoint must be a public http(s) address: " + error.message), { status: 400, code: "MCP_ENDPOINT_NOT_PUBLIC" });
    throw error;
  }
}

function err(reply: any, e: unknown) {
  const status = Number((e as any)?.status ?? (e instanceof WorkspaceAccessError ? 403 : 400));
  return reply.code(status).send({
    error: {
      code: (e as any)?.code || (status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : "INTEGRATION_ERROR"),
      message: e instanceof Error ? e.message : String(e),
    },
  });
}

/** A webhook as listed: the secret is replaced by a short hint. */
function maskWebhook<T extends { secret: string }>(webhook: T): Omit<T, "secret"> & { secretHint: string } {
  const { secret, ...rest } = webhook;
  return { ...rest, secretHint: secret.slice(0, 6) + "…" + secret.slice(-4) };
}

export function registerIntegrationsRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthProvider;
    store: WorkspaceStore;
    repo: IntegrationsRepository;
    /** Runs the webhook's Company Agent; `deliveryKey` makes a redelivered event reuse the same run. */
    triggerRun?: (webhook: CompanyWebhook, prompt: string, deliveryKey: string) => Promise<unknown>;
  }
) {
  const { auth, store, repo, triggerRun } = deps;

  // --- Webhooks Management ---
  app.get<{ Params: { companyId: string } }>("/companies/:companyId/webhooks", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "workspace:read");
      await store.getCompany(c, r.params.companyId);
      const webhooks = await repo.listWebhooks(c, r.params.companyId);
      return { webhooks: webhooks.map(maskWebhook) };
    } catch (e) {
      return err(reply, e);
    }
  });

  app.get<{ Params: { companyId: string; webhookId: string } }>(
    "/companies/:companyId/webhooks/:webhookId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "workspace:read");
        await store.getCompany(c, r.params.companyId);
        const webhook = await repo.getWebhook(c, r.params.companyId, r.params.webhookId);
        if (!webhook) {
          return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Webhook not found." } });
        }
        return reply.code(200).send({ webhook: maskWebhook(webhook) });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // The delivery URL carries the secret: it is shown only on an explicit request by a user who may manage the company
  // (Settings > Integrations, "Show URL"), never in lists or in chat (V6 step 12, owner decision).
  app.post<{ Params: { companyId: string; webhookId: string } }>(
    "/companies/:companyId/webhooks/:webhookId/reveal",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await store.getCompany(c, r.params.companyId);
        const webhook = await repo.getWebhook(c, r.params.companyId, r.params.webhookId);
        if (!webhook) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Webhook not found." } });
        return reply.code(200).send({ secret: webhook.secret, path: "/api/v1/webhooks/" + webhook.secret });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  app.post<{
    Params: { companyId: string };
    Body: { name: string; promptTemplate: string; agentId?: string; isActive?: boolean };
  }>("/companies/:companyId/webhooks", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const { name, promptTemplate, agentId, isActive } = r.body || {};
      if (isActive !== undefined && typeof isActive !== "boolean") throw Object.assign(new Error("isActive must be a boolean."), { status: 400, code: "MISSING_PARAMETERS" });

      if (!name || typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
        throw Object.assign(new Error("name is required and must be a string up to 200 characters."), {
          status: 400,
          code: "MISSING_PARAMETERS",
        });
      }
      if (!promptTemplate || typeof promptTemplate !== "string" || promptTemplate.trim().length === 0) {
        throw Object.assign(new Error("promptTemplate is required."), {
          status: 400,
          code: "MISSING_PARAMETERS",
        });
      }

      PromptInjectionGuard.assertSafe(promptTemplate);
      const created = await repo.createWebhook(c, r.params.companyId, {
        name: name.trim(),
        promptTemplate: promptTemplate.trim(),
        agentId: agentId || undefined,
        isActive,
      });
      return reply.code(201).send({ webhook: created, ...created });
    } catch (e) {
      return err(reply, e);
    }
  });

  app.patch<{ Params: { companyId: string; webhookId: string }; Body: { isActive?: boolean } }>(
    "/companies/:companyId/webhooks/:webhookId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await store.getCompany(c, r.params.companyId);
        if (typeof r.body?.isActive !== "boolean") {
          throw Object.assign(new Error("isActive must be a boolean."), { status: 400, code: "MISSING_PARAMETERS" });
        }
        const webhook = await repo.setWebhookActive(c, r.params.companyId, r.params.webhookId, r.body.isActive);
        if (!webhook) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Webhook not found." } });
        return reply.code(200).send({ webhook: maskWebhook(webhook) });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  app.delete<{ Params: { companyId: string; webhookId: string } }>(
    "/companies/:companyId/webhooks/:webhookId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        const deleted = await repo.deleteWebhook(c, r.params.companyId, r.params.webhookId);
        if (!deleted) {
          return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Webhook not found." } });
        }
        return reply.code(204).send();
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // --- Public Webhook Ingress (OpenClaw Item 223 / P1) ---
  const webhookHandler = async (r: any, reply: any) => {
    try {
      const webhook = await repo.getWebhookBySecret(r.params.secret);
      if (!webhook) {
        return reply.code(404).send({ error: { code: "INVALID_WEBHOOK_SECRET", message: "Webhook not found or inactive." } });
      }

      const rawPayload = JSON.stringify(r.body || {});
      const sanitizedPayload = CredentialMasker.mask(rawPayload);
      PromptInjectionGuard.assertSafe(sanitizedPayload);

      // Render prompt template with incoming payload
      const renderedPrompt = webhook.promptTemplate.replace(/\{\{payload\}\}/g, sanitizedPayload) +
        (webhook.promptTemplate.includes("{{payload}}") ? "" : `\n\nIncoming Webhook Event Payload:\n${sanitizedPayload}`);

      await repo.recordWebhookTrigger(webhook.id);

      if (!triggerRun) throw Object.assign(new Error("Webhook agent runs are unavailable on this server."), { status: 503 });
      const delivery = String(r.headers["idempotency-key"] ?? r.headers["x-delivery-id"] ?? "").trim().slice(0, 200) || randomUUID();
      void triggerRun(webhook, renderedPrompt, delivery).catch((error: unknown) => r.log.warn({ err: error, webhookId: webhook.id }, "Webhook agent run failed"));

      return reply.code(202).send({
        status: "accepted",
        webhookId: webhook.id,
        companyId: webhook.companyId,
        message: "Webhook event received and dispatched to agent",
      });
    } catch (e) {
      return err(reply, e);
    }
  };

  app.post<{
    Params: { secret: string };
    Body: Record<string, unknown>;
  }>("/api/v1/webhooks/:secret", webhookHandler);

  app.post<{
    Params: { secret: string };
    Body: Record<string, unknown>;
  }>("/v1/webhooks/:secret", webhookHandler);

  // --- MCP Client Registry (OpenClaw Item 214 / P1) ---
  app.get<{ Params: { companyId: string } }>("/companies/:companyId/mcp/servers", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "workspace:read");
      await store.getCompany(c, r.params.companyId);
      const servers = await repo.listMcpServers(c, r.params.companyId);
      return { servers: servers.map(publicMcpServer) };
    } catch (e) {
      return err(reply, e);
    }
  });

  app.post<{
    Params: { companyId: string };
    Body: { name: string; transport: "http" | "sse" | "stdio"; endpoint: string; authToken?: string; scopes?: string[] };
  }>("/companies/:companyId/mcp/servers", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      if (r.body?.transport !== "stdio") await assertPublicMcpEndpoint(String(r.body?.endpoint ?? ""));
      const created = await repo.createMcpServer(c, r.params.companyId, r.body);
      return reply.code(201).send(publicMcpServer(created));
    } catch (e) {
      return err(reply, e);
    }
  });

  app.delete<{ Params: { companyId: string; serverId: string } }>(
    "/companies/:companyId/mcp/servers/:serverId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await repo.deleteMcpServer(c, r.params.companyId, r.params.serverId);
        return reply.code(204).send();
      } catch (e) {
        return err(reply, e);
      }
    }
  );
}
