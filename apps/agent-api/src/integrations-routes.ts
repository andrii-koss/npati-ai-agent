import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { IntegrationsRepository } from "./integrations-repository";
import { PromptInjectionGuard, CredentialMasker } from "./security-guardrails";

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

function err(reply: any, e: unknown) {
  const status = Number((e as any)?.status ?? (e instanceof WorkspaceAccessError ? 403 : 400));
  return reply.code(status).send({
    error: {
      code: (e as any)?.code || (status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : "INTEGRATION_ERROR"),
      message: e instanceof Error ? e.message : String(e),
    },
  });
}

export function registerIntegrationsRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthProvider;
    store: WorkspaceStore;
    repo: IntegrationsRepository;
    triggerRun?: (companyId: string, prompt: string, agentId?: string) => Promise<unknown>;
  }
) {
  const { auth, store, repo, triggerRun } = deps;

  // --- Webhooks Management ---
  app.get<{ Params: { companyId: string } }>("/companies/:companyId/webhooks", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "workspace:read");
      await store.getCompany(c, r.params.companyId);
      const webhooks = await repo.listWebhooks(c, r.params.companyId);
      return { webhooks };
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
        return reply.code(200).send({ webhook });
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  app.post<{
    Params: { companyId: string };
    Body: { name: string; promptTemplate: string; agentId?: string };
  }>("/companies/:companyId/webhooks", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      const { name, promptTemplate, agentId } = r.body || {};

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
        return reply.code(200).send({ webhook });
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

      if (triggerRun) {
        void triggerRun(webhook.companyId, renderedPrompt, webhook.agentId || undefined).catch(() => undefined);
      }

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
      return { servers };
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
      const created = await repo.createMcpServer(c, r.params.companyId, r.body);
      return reply.code(201).send(created);
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
