import type { FastifyInstance } from "fastify";
import type { AuthProvider } from "./auth";
import type { WorkspaceStore } from "@npati/workspace";
import type { BrowserCredentialsRepository } from "./browser-credentials-repository";
import type { BrowserUseClient } from "./browser-tool";

export function registerBrowserCredentialsRoutes(app: FastifyInstance, deps: { auth: AuthProvider; store: WorkspaceStore; repo: BrowserCredentialsRepository; browser?: BrowserUseClient }) {
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
  app.get<{ Params: { companyId: string; artifactId: string } }>("/companies/:companyId/browser-artifacts/:artifactId", async (request, reply) => {
    if (!deps.browser) return reply.code(503).send({ error: { code: "BROWSER_WORKER_UNAVAILABLE", message: "Browser Use Worker is not configured" } });
    const ctx = await context(request, request.params.companyId);
    const company = await deps.store.getCompany(ctx, request.params.companyId);
    const artifact = await deps.browser.downloadArtifact(ctx, company, request.params.artifactId);
    return reply.type(artifact.contentType).header("content-disposition", `inline; filename="browser-${request.params.artifactId}.png"`).send(artifact.data);
  });
}
