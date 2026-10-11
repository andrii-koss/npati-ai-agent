
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { safeAttachmentName } from "./chat-attachments";
import { createCoreServices } from "./core-services";
import { AdmissionError } from "./resilience-admission-queue";
import { StorageRateLimitError } from "./storage-protection";
import { defaultHybridRouter } from "@npati/shared";
import { WorkspaceAccessError } from "@npati/workspace";

export interface MiscRouteDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  activeContextResolver: ReturnType<typeof createCoreServices>["activeContextResolver"];
  authProvider: ReturnType<typeof createCoreServices>["authProvider"];
  chatFiles: ReturnType<typeof createCoreServices>["chatFiles"];
  researchBundle: ReturnType<typeof createCoreServices>["researchBundle"];
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
}

export function registerMiscRoutes(app: FastifyInstance, deps: MiscRouteDeps): void {
  const { activeContextResolver, authProvider, chatFiles, researchBundle, workspaceStore } = deps;
  app.post<{ Body: { message: string; contextType?: string; companyId?: string; businessId?: string; projectId?: string } }>("/router/evaluate", async (request) => {
    const auth = await authProvider.authenticate(request);
    const resolved = await activeContextResolver.resolve(auth, {
      contextType: request.body?.contextType,
      companyId: request.body?.companyId,
      businessId: request.body?.businessId,
      projectId: request.body?.projectId,
    });
    return defaultHybridRouter.route({
      message: request.body?.message ?? "",
      activeProjectId: request.body?.projectId ?? (resolved.context as any).projectId,
      resolutionContext: {
        auth,
        activeContext: resolved.context,
        company: resolved.company ? { id: resolved.company.id, revision: resolved.company.revision } : undefined,
      },
    });
  });

  app.get<{ Params: { attachmentId: string } }>("/attachments/:attachmentId", async (request, reply) => {
    try {
      if (!chatFiles || !/^[0-9a-f-]{36}$/i.test(request.params.attachmentId)) return reply.code(404).send();
      const opened = await chatFiles.open(await authProvider.authenticate(request),request.params.attachmentId);
      if (!opened) return reply.code(404).send();
      return reply.header("content-type",opened.file.mimeType)
        .header("content-disposition","inline; filename*=UTF-8''"+encodeURIComponent(safeAttachmentName(opened.file.originalFilename)))
        .header("cache-control","private, no-store").header("x-content-type-options","nosniff").send(opened.stream);
    } catch (error) {
      if (error instanceof StorageRateLimitError) return reply.header("retry-after",String(Math.ceil(error.retryAfterMs/1000))).code(429).send({error:{code:error.code,message:error.message}});
      if (error instanceof AdmissionError) return reply.header("retry-after", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)))).code(429).send({ error: { code: error.code, message: error.message } });
      if (error instanceof WorkspaceAccessError) return reply.code(403).send({ error: { code: error.code, message: error.message } });
      return reply.code(404).send();
    }
  });

  app.delete<{ Params: { attachmentId: string } }>("/attachments/:attachmentId", async (request,reply) => {
    try {
      if (!chatFiles || !/^[0-9a-f-]{36}$/i.test(request.params.attachmentId)) return reply.code(204).send();
      await chatFiles.delete(await authProvider.authenticate(request),request.params.attachmentId);
      return reply.code(204).send();
    } catch(error) {
      if(error instanceof StorageRateLimitError)return reply.header("retry-after",String(Math.ceil(error.retryAfterMs/1000))).code(429).send({error:{code:error.code,message:error.message}});
      if(error instanceof WorkspaceAccessError)return reply.code(403).send({error:{code:error.code,message:error.message}});
      throw error;
    }
  });

  app.get<{ Params: { businessId: string; jobId: string } }>("/businesses/:businessId/research-jobs/:jobId", async (request, reply) => {
    try {
      const auth = await authProvider.authenticate(request);
      await workspaceStore.getBusiness(auth, request.params.businessId);
      if (!researchBundle?.jobs) {
        return reply.code(503).send({ error: { code: "WEB_RESEARCH_UNAVAILABLE", message: "Web research jobs are not configured." } });
      }
      const job = await researchBundle.jobs.get({
        workspaceId: auth.workspaceId,
        businessId: request.params.businessId,
        userId: auth.userId,
      }, request.params.jobId);
      if (!job) return reply.code(404).send({ error: { code: "RESEARCH_JOB_NOT_FOUND", message: "Research job not found." } });
      return job;
    } catch (error) {
      if (error instanceof WorkspaceAccessError) {
        return reply.code(403).send({ error: { code: error.code, message: error.message } });
      }
      request.log.error(error);
      return reply.code(500).send({ error: { code: "RESEARCH_JOB_ERROR", message: "Could not load research job." } });
    }
  });
}
