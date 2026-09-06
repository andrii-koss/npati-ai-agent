import type { FastifyInstance, FastifyRequest } from "fastify";
import { WorkspaceAccessError, type WorkspaceStore } from "@npati/workspace";
import type { AuthProvider } from "./auth";
import type { IntegrationsRepository } from "./integrations-repository";
import { PromptInjectionGuard, CredentialMasker } from "./security-guardrails";

async function ctx(auth: AuthProvider, r: FastifyRequest, permission: "workspace:read" | "business:manage") {
  const c = await auth.authenticate(r);
  if (!c.permissions.includes(permission)) throw new WorkspaceAccessError("Missing permission: " + permission);
  return c;
}

function err(reply: any, e: unknown) {
  const status = Number((e as any)?.status ?? (e instanceof WorkspaceAccessError ? 403 : 400));
  return reply.code(status).send({
    error: {
      code: status === 404 ? "NOT_FOUND" : "INTEGRATION_ERROR",
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

  app.post<{
    Params: { companyId: string };
    Body: { name: string; promptTemplate: string; agentId?: string };
  }>("/companies/:companyId/webhooks", async (r, reply) => {
    try {
      const c = await ctx(auth, r, "business:manage");
      await store.getCompany(c, r.params.companyId);
      PromptInjectionGuard.assertSafe(r.body.promptTemplate);
      const created = await repo.createWebhook(c, r.params.companyId, r.body);
      return reply.code(201).send(created);
    } catch (e) {
      return err(reply, e);
    }
  });

  app.delete<{ Params: { companyId: string; webhookId: string } }>(
    "/companies/:companyId/webhooks/:webhookId",
    async (r, reply) => {
      try {
        const c = await ctx(auth, r, "business:manage");
        await repo.deleteWebhook(c, r.params.companyId, r.params.webhookId);
        return reply.code(204).send();
      } catch (e) {
        return err(reply, e);
      }
    }
  );

  // --- Public Webhook Ingress (OpenClaw Item 223 / P1) ---
  app.post<{
    Params: { secret: string };
    Body: Record<string, unknown>;
  }>("/api/v1/webhooks/:secret", async (r, reply) => {
    try {
      const webhook = await repo.getWebhookBySecret(r.params.secret);
      if (!webhook) {
        return reply.code(404).send({ error: { code: "INVALID_WEBHOOK_SECRET", message: "Webhook not found or inactive" } });
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
  });

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
