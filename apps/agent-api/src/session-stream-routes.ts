import type { FastifyInstance } from "fastify";
import type { AuthProvider } from "./auth";
import type { ActiveSessionRegistry } from "./distributed-session-registry";

const SESSION_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const LEASE_SECONDS = 45;
const HEARTBEAT_MS = 15_000;

export function registerSessionStreamRoutes(app: FastifyInstance, authProvider: AuthProvider, registry: ActiveSessionRegistry) {
  app.get<{ Params: { sessionId: string } }>("/sessions/:sessionId/stream", async (request, reply) => {
    const auth = await authProvider.authenticate(request);
    const sessionId = request.params.sessionId.trim();
    if (!SESSION_ID.test(sessionId)) return reply.code(400).send({ error: { code: "INVALID_SESSION_ID", message: "Invalid session identifier." } });
    const lease = await registry.acquire(auth.workspaceId, auth.userId, sessionId, LEASE_SECONDS);
    if (!lease) return reply.code(409).send({ error: { code: "SESSION_ALREADY_ACTIVE", message: "This session already has an active connection." } });

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ sessionId, connectionId: lease.connectionId, expiresAt: lease.expiresAt })}\n\n`);
    let closed = false;
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      await registry.release(auth.workspaceId, auth.userId, lease).catch(() => false);
    };
    const heartbeat = setInterval(async () => {
      const renewed = await registry.renew(auth.workspaceId, auth.userId, lease, LEASE_SECONDS).catch(() => false);
      if (!renewed) { reply.raw.end(); await cleanup(); return; }
      if (!reply.raw.destroyed) reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);
    heartbeat.unref();
    request.raw.once("aborted", () => void cleanup());
    reply.raw.once("close", () => void cleanup());
  });

  app.get("/sessions/active", async (request) => {
    const auth = await authProvider.authenticate(request);
    return { activeSessions: await registry.count(auth.workspaceId, auth.userId) };
  });
}
