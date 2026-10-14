import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthProvider } from "./auth";
import { AuthenticationError } from "./auth";
import { ChatDevelopmentService, DevelopmentError, type DevelopmentPorts } from "./chat-development-service";
function fail(reply: FastifyReply, error: unknown) {
  const shaped = error as { status?: number; httpStatus?: number; code?: string; message?: string };
  return reply.code(error instanceof AuthenticationError ? error.status : error instanceof DevelopmentError ? error.status : shaped.httpStatus ?? shaped.status ?? 500)
    .send({ error: { code: shaped.code ?? "development_error", message: shaped.message ?? "Development request failed", retryable: false } });
}
export function registerChatDevelopmentRoutes(app: FastifyInstance, deps: DevelopmentPorts & { auth: AuthProvider }) {
  const service = new ChatDevelopmentService(deps);
  const streams = new Set<() => void>();
  app.addHook("preClose", async () => { for (const close of streams) close(); await service.close(); });
  // Transport only: snapshots use the existing persisted runtime records.
  app.get("/chat/development/processes/stream", async (request, reply) => {
    try {
      const ctx = await deps.auth.authenticate(request);
      const initial = await service.list(ctx);
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
      let closed = false, signature = "", timer: ReturnType<typeof setTimeout>;
      const close = () => { if (closed) return; closed = true; clearTimeout(timer); streams.delete(close); reply.raw.end(); };
      streams.add(close); reply.raw.on("close", close);
      const publish = (processes: Awaited<ReturnType<typeof service.list>>) => {
        const next = JSON.stringify(processes);
        if (signature !== next) { signature = next; reply.raw.write("event: change\ndata: {}\n\n"); }
        else reply.raw.write(": heartbeat\n\n");
      };
      const poll = async () => {
        if (closed) return;
        try { const processes = await service.list(ctx); if (!closed) publish(processes); }
        catch { close(); return; }
        if (!closed) timer = setTimeout(poll, 1000);
      };
      publish(initial); timer = setTimeout(poll, 1000);
    } catch (error) { return fail(reply, error); }
  });
  app.get("/chat/development/processes", async (request, reply) => {
    try { return { processes: await service.list(await deps.auth.authenticate(request)) }; } catch (error) { return fail(reply, error); }
  });
  app.post<{ Body: { companyId: string; message: string; conversationId?: string; businessId?: string; requestId: string } }>("/chat/development/processes",
    { schema: { body: { type: "object", additionalProperties: false, required: ["companyId", "message", "requestId"], properties: {
      companyId: { type: "string", minLength: 1, maxLength: 200 }, message: { type: "string", minLength: 1, maxLength: 32000 }, requestId: { type: "string", minLength: 1, maxLength: 100 },
      conversationId: { type: "string", minLength: 1, maxLength: 200 }, businessId: { type: "string", minLength: 1, maxLength: 200 },
    } } } }, async (request, reply) => {
      try { return await service.start(await deps.auth.authenticate(request), request.body); } catch (error) { return fail(reply, error); }
    });
  app.post("/chat/development/restore", async (request, reply) => {
    try { const processes = await service.restore(await deps.auth.authenticate(request)); return { processes, conversationId: processes.find(p => !p.hidden)?.parentConversationId }; } catch (error) { return fail(reply, error); }
  });
  for (const action of ["hide", "stop", "open"] as const) {
    app.post<{ Params: { id: string } }>("/chat/development/processes/:id/" + action, async (request, reply) => {
      try { return await service[action](await deps.auth.authenticate(request), request.params.id) ?? { ok: true }; } catch (error) { return fail(reply, error); }
    });
  }
  app.post<{ Body: { companyId: string; projectId: string } }>("/chat/development/project",
    { schema: { body: { type: "object", additionalProperties: false, required: ["companyId", "projectId"], properties: {
      companyId: { type: "string", minLength: 1, maxLength: 200 }, projectId: { type: "string", minLength: 1, maxLength: 200 },
    } } } }, async (request, reply) => {
      try { return await service.openProject(await deps.auth.authenticate(request), request.body.companyId, request.body.projectId); } catch (error) { return fail(reply, error); }
    });
  return service;
}
