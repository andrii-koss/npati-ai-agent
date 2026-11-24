import type { FastifyInstance } from "fastify";
import { AuthenticationError, type AuthProvider } from "./auth";
import { StreamTicketError } from "./stream-tickets";

/**
 * Audit L6: `POST /stream-tickets {"path": "/api/attachments/<id>"}` → `{ ticket, expiresAt, url }`.
 * Requires the Authorization header (a ticket cannot mint another: tickets only authenticate GET/HEAD). The resource
 * route still performs its own authorization with the ticket's context, so a ticket never widens access.
 */
export function registerStreamTicketRoutes(app: FastifyInstance, auth: AuthProvider) {
  app.post<{ Body: { path?: unknown } }>("/stream-tickets", {
    schema: { body: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", minLength: 1, maxLength: 512 } } } },
  }, async (request, reply) => {
    try {
      if (!auth.mintStreamTicket) return reply.code(501).send({ error: { code: "TICKETS_UNAVAILABLE", message: "Stream tickets are not available" } });
      const context = await auth.authenticate(request);
      const minted = auth.mintStreamTicket(context, String(request.body.path));
      return reply.header("cache-control", "no-store").send({ ...minted, url: `/api${minted.path}?ticket=${encodeURIComponent(minted.ticket)}` });
    } catch (error) {
      if (error instanceof AuthenticationError || error instanceof StreamTicketError) {
        return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
}
