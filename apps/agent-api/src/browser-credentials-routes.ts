import type { FastifyInstance } from "fastify";
import type { AuthProvider } from "./auth";
import type { WorkspaceStore } from "@npati/workspace";
import type { BrowserCredentialsRepository } from "./browser-credentials-repository";
import type { BrowserUseClient } from "./browser-tool";
import type { EmailInboxRepository } from "./email-inbox-repository";
import type { CompanyAutomationsRepository } from "./automations-repository";

export function registerBrowserCredentialsRoutes(app: FastifyInstance, deps: { auth: AuthProvider; store: WorkspaceStore; repo: BrowserCredentialsRepository; browser?: BrowserUseClient; email: EmailInboxRepository; automations: CompanyAutomationsRepository }) {
  const context = async (request: any, companyId: string, write = false) => {
    const ctx = await deps.auth.authenticate(request);
    await deps.store.getCompany(ctx, companyId);
    if (write && !ctx.permissions.some((p) => ["*", "owner", "business:manage", "workspace:write"].includes(p)))
      throw Object.assign(new Error("Company management permission is required"), { status: 403 });
    return ctx;
  };
  app.get<{ Params: { companyId: string } }>("/companies/:companyId/browser-credentials", async (request) => ({
    credentials: await deps.repo.list(await context(request, request.params.companyId), request.params.companyId),
  }));
  app.post<{ Params: { companyId: string }; Body: { id?: string; label: string; fields: Record<string, string> } }>("/companies/:companyId/browser-credentials", async (request, reply) => {
    const credential = await deps.repo.put(await context(request, request.params.companyId, true), request.params.companyId, request.body);
    return reply.code(request.body.id ? 200 : 201).send({ credential });
  });
  app.delete<{ Params: { companyId: string; credentialId: string } }>("/companies/:companyId/browser-credentials/:credentialId", async (request) => ({
    deleted: await deps.repo.delete(await context(request, request.params.companyId, true), request.params.companyId, request.params.credentialId),
  }));
  app.post<{ Params: { companyId: string; credentialId: string } }>("/companies/:companyId/browser-credentials/:credentialId/reveal", async (request, reply) => {
    const ctx = await context(request, request.params.companyId, true);
    const fields = await deps.repo.resolve(ctx, request.params.companyId, request.params.credentialId);
    return reply.header("cache-control", "no-store, max-age=0").header("pragma", "no-cache").send({ fields });
  });
  app.get<{ Params: { companyId: string } }>("/companies/:companyId/browser-targets", async (request) => {
    const ctx = await context(request, request.params.companyId);
    const [targets, accounts] = await Promise.all([
      deps.repo.listTargets(ctx, request.params.companyId),
      deps.email.listAccounts(ctx, request.params.companyId),
    ]);
    return {
      targets,
      emailAccounts: accounts.map((account) => ({
        id: account.id, emailAddress: account.emailAddress, displayName: account.displayName, status: account.status,
      })),
    };
  });
  app.post<{ Params: { companyId: string }; Body: {
    automationId?: string | null; emailAccountId?: string | null; siteName: string; registrationUrl: string;
    publishUrl?: string | null; articleTitle?: string | null; articleBody?: string | null; priority?: number;
  } }>("/companies/:companyId/browser-targets", async (request, reply) => {
    const ctx = await context(request, request.params.companyId, true);
    if (!request.body.emailAccountId || !request.body.automationId) throw Object.assign(new Error("Automation and Company email are required"), { status: 400 });
    const account = await deps.email.getAccount(ctx, request.params.companyId, request.body.emailAccountId);
    if (!account) throw Object.assign(new Error("Selected Company email account was not found"), { status: 400 });
    await deps.automations.get(ctx, request.params.companyId, request.body.automationId);
    const target = await deps.repo.createTarget(ctx, request.params.companyId, request.body);
    return reply.code(201).send({ target });
  });
  app.patch<{ Params: { companyId: string; targetId: string }; Body: {
    automationId?: string | null; emailAccountId?: string | null; siteName?: string; registrationUrl?: string;
    publishUrl?: string | null; articleTitle?: string | null; articleBody?: string | null; priority?: number;
    status?: "pending" | "paused";
  } }>("/companies/:companyId/browser-targets/:targetId", async (request) => {
    const ctx = await context(request, request.params.companyId, true);
    if (request.body.emailAccountId) {
      const account = await deps.email.getAccount(ctx, request.params.companyId, request.body.emailAccountId);
      if (!account) throw Object.assign(new Error("Selected Company email account was not found"), { status: 400 });
    }
    if (request.body.automationId) await deps.automations.get(ctx, request.params.companyId, request.body.automationId);
    return { target: await deps.repo.updateTarget(ctx, request.params.companyId, request.params.targetId, request.body) };
  });
  app.delete<{ Params: { companyId: string; targetId: string } }>("/companies/:companyId/browser-targets/:targetId", async (request) => ({
    deleted: await deps.repo.deleteTarget(await context(request, request.params.companyId, true), request.params.companyId, request.params.targetId),
  }));
  app.post<{ Params: { companyId: string }; Body: { automationId?: string | null; emailAccountId?: string | null } }>(
    "/companies/:companyId/browser-targets/seed-demo", async (request, reply) => {
      const ctx = await context(request, request.params.companyId, true);
      if (!request.body?.automationId || !request.body?.emailAccountId) throw Object.assign(new Error("Select an automation and Company email before adding demo sites"), { status: 400 });
      await deps.automations.get(ctx, request.params.companyId, request.body.automationId);
      const account = await deps.email.getAccount(ctx, request.params.companyId, request.body.emailAccountId);
      if (!account) throw Object.assign(new Error("Selected Company email account was not found"), { status: 400 });
      const common = { automationId: request.body?.automationId || null, emailAccountId: request.body?.emailAccountId || null, status: "paused" as const };
      const targets = await Promise.all([
        deps.repo.createTarget(ctx, request.params.companyId, {
          ...common,
          siteName: "WordPress Playground (isolated demo)",
          registrationUrl: "https://playground.wordpress.net/?storage=browser&url=/wp-admin/post-new.php",
          publishUrl: "https://playground.wordpress.net/?storage=browser&url=/wp-admin/post-new.php",
          articleTitle: "NPATI browser automation test",
          articleBody: "This draft verifies that the browser agent can create and publish an article in an isolated WordPress Playground session.",
          priority: 10,
        }),
        deps.repo.createTarget(ctx, request.params.companyId, {
          ...common,
          siteName: "RealWorld Conduit (public demo)",
          registrationUrl: "https://realworld.svelte.dev/register",
          publishUrl: "https://realworld.svelte.dev/editor",
          articleTitle: "NPATI browser automation test",
          articleBody: "A test article created by the NPATI browser automation in the public RealWorld demo application.",
          priority: 20,
        }),
      ]);
      return reply.code(201).send({ targets });
    },
  );
  app.get<{ Params: { companyId: string; artifactId: string } }>("/companies/:companyId/browser-artifacts/:artifactId", async (request, reply) => {
    if (!deps.browser) return reply.code(503).send({ error: { code: "BROWSER_WORKER_UNAVAILABLE", message: "Browser Use Worker is not configured" } });
    const ctx = await context(request, request.params.companyId);
    const company = await deps.store.getCompany(ctx, request.params.companyId);
    const artifact = await deps.browser.downloadArtifact(ctx, company, request.params.artifactId);
    return reply.type(artifact.contentType).header("content-disposition", `inline; filename="browser-${request.params.artifactId}.png"`).send(artifact.data);
  });
}
