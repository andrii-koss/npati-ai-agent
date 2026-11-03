import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthProvider } from "./auth";
import { chatProcess, registerChatOpenRoutes } from "./chat-open-routes";
import { AuthenticationError } from "./auth";
import { ChatDevelopmentService, DevelopmentError, type DevelopmentPorts } from "./chat-development-service";
import { registerCodeMonitorRoutes } from "./code-monitor-routes";
function fail(reply: FastifyReply, error: unknown) {
  const shaped = error as { status?: number; httpStatus?: number; code?: string; message?: string };
  return reply.code(error instanceof AuthenticationError ? error.status : error instanceof DevelopmentError ? error.status : shaped.httpStatus ?? shaped.status ?? 500)
    .send({ error: { code: shaped.code ?? "development_error", message: shaped.message ?? "Development request failed", retryable: false } });
}
export function registerChatDevelopmentRoutes(app: FastifyInstance, deps: DevelopmentPorts & { auth: AuthProvider }) {
  registerCodeMonitorRoutes(app, deps);
  const service = new ChatDevelopmentService(deps);
  registerChatOpenRoutes(app, { auth: deps.auth, store: deps.store, listProcesses: (context, conversationId) => service.listForChat(context, conversationId) });
  const streams = new Set<() => void>();
  app.post<{ Body: { message: string; companyId?: string; projectId?: string; conversationId?: string; businessId?: string } }>("/chat/development/plan",
    { schema: { body: { type: "object", additionalProperties: false, required: ["message"], properties: {
      message: { type: "string", minLength: 1, maxLength: 32000 }, companyId: { type: "string", minLength: 1, maxLength: 200 },
      projectId: { type: "string", minLength: 1, maxLength: 200 }, conversationId: { type: "string", minLength: 1, maxLength: 200 },
      businessId: { type: "string", minLength: 1, maxLength: 200 },
    } } } }, async (request, reply) => {
      try { return { targets: await service.plan(await deps.auth.authenticate(request), request.body) }; } catch (error) { return fail(reply, error); }
    });
  app.addHook("preClose", async () => { for (const close of streams) close(); await service.close(); });
  // Transport only: snapshots use the existing persisted runtime records.
  app.get<{ Querystring: { conversationId?: string; projectId?: string } }>("/chat/development/processes/stream", async (request, reply) => {
    try {
      const ctx = await deps.auth.authenticate(request);
      // A chat's live stream carries only its own and running processes; without the parameter the full list is kept.
      const conversationId = request.query.conversationId;
      const list = async () => conversationId !== undefined
        ? (await service.listForChat(ctx, conversationId || undefined)).filter((process) => chatProcess(process, conversationId || undefined))
        : service.list(ctx, request.query.projectId);
      const initial = await list();
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
      let closed = false, polling = false, pending = false, signature = "", timer: ReturnType<typeof setTimeout>;
      const publish = (processes: Awaited<ReturnType<typeof service.list>>) => {
        const next = JSON.stringify(processes);
        if (signature !== next) { signature = next; reply.raw.write('event: change\ndata: {"processes":' + next + "}\n\n"); }
        else reply.raw.write(": heartbeat\n\n");
      };
      const poll = async () => {
        if (closed) return;
        if (polling) { pending = true; return; }
        clearTimeout(timer); polling = true;
        let delayed = false;
        try {
          if (reply.raw.writableNeedDrain) delayed = true;
          else { const processes = await list(); if (!closed) publish(processes); }
        } catch { close(); }
        finally {
          polling = false;
          if (!closed) { const delay = pending && !delayed ? 0 : 3000; pending = false; timer = setTimeout(poll, delay); }
        }
      };
      // A run reports many steps a second; a screen needs at most one fresh list a second.
      let lastUpdate = 0, updateTimer: ReturnType<typeof setTimeout> | undefined;
      const unsub = service.onUpdate(() => {
        if (closed || updateTimer) return;
        updateTimer = setTimeout(() => {
          updateTimer = undefined;
          lastUpdate = Date.now();
          if (!closed) { clearTimeout(timer); void poll(); }
        }, Math.max(0, lastUpdate + 1_000 - Date.now()));
      });
      const close = () => { if (closed) return; closed = true; unsub(); clearTimeout(timer); if (updateTimer) clearTimeout(updateTimer); streams.delete(close); reply.raw.end(); };
      streams.add(close); reply.raw.on("close", close);
      publish(initial); timer = setTimeout(poll, 3000);
    } catch (error) { return fail(reply, error); }
  });
  app.get<{ Querystring: { conversationId?: string; projectId?: string } }>("/chat/development/processes", async (request, reply) => {
    try {
      const context = await deps.auth.authenticate(request);
      // A chat asks only for its own processes and running ones; without the parameter the full list is kept.
      const conversationId = request.query.conversationId;
      return { processes: conversationId !== undefined
        ? (await service.listForChat(context, conversationId || undefined)).filter((process) => chatProcess(process, conversationId || undefined))
        : await service.list(context, request.query.projectId) };
    } catch (error) { return fail(reply, error); }
  });
  app.post<{ Body: { companyId: string; message: string; targets?: import("@npati/shared").DevelopmentTarget[]; conversationId?: string; businessId?: string; requestId: string } }>("/chat/development/processes",
    { schema: { body: { type: "object", additionalProperties: false, required: ["companyId", "message", "requestId"], properties: {
      companyId: { type: "string", minLength: 1, maxLength: 200 }, message: { type: "string", minLength: 1, maxLength: 32000 }, requestId: { type: "string", minLength: 1, maxLength: 100 },
      targets: { type: "array", items: { type: "object" } },
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
