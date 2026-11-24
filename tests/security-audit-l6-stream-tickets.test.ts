import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { NpatiBackendAuthProvider, createMockNpatiJwt, redactUrlSecrets } from "../apps/agent-api/src/auth";
import { StreamTicketService, STREAM_TICKET_TTL_MS, normalizeTicketPath } from "../apps/agent-api/src/stream-tickets";
import { registerStreamTicketRoutes } from "../apps/agent-api/src/stream-ticket-routes";

/**
 * Security audit 2026-11-24, L6: the session token no longer travels in URLs. Elements that cannot send headers get a
 * 60-second ticket bound to one GET path, minted by a request that did send the Authorization header.
 */
const secret = "stream-ticket-test-jwt-secret-0123456789abcdef";
const attachment = "/attachments/0f8fad5b-d9cb-469f-a165-70867728950e";
const other = "/attachments/7c9e6679-7425-40de-944b-e07fc1f90ae7";
function setup(now = () => Date.now()) {
  const tickets = new StreamTicketService("ticket-secret-for-tests-0123456789abcdef", now);
  const provider = new NpatiBackendAuthProvider({ jwtSecret: secret, streamTickets: tickets, workspaceStore: { initialize: async () => undefined } as never });
  const session = createMockNpatiJwt({ userId: "ticket-user" }, secret);
  return { tickets, provider, session };
}
const request = (url: string, query: Record<string, string>, method = "GET", headers: Record<string, string> = {}) =>
  ({ url, method, headers, query }) as never;

describe("L6: stream tickets", () => {
  it("a ticket opens exactly the path it was minted for, with the minting user's context", async () => {
    const { provider, session } = setup();
    const ctx = await provider.authenticate(request("/attachments/x", {}, "GET", { authorization: `Bearer ${session}` }));
    const { ticket } = provider.mintStreamTicket(ctx, `/api${attachment}`);
    await expect(provider.authenticate(request(`${attachment}?ticket=${ticket}`, { ticket }))).resolves.toMatchObject({ userId: "ticket-user", workspaceId: "workspace:ticket-user" });
    await expect(provider.authenticate(request(`/api${attachment}?ticket=${ticket}`, { ticket }))).resolves.toMatchObject({ userId: "ticket-user" });
    await expect(provider.authenticate(request(`${other}?ticket=${ticket}`, { ticket }))).rejects.toMatchObject({ code: "TICKET_PATH_MISMATCH" });
  });

  it("is read-only, expires after 60 seconds and cannot be forged", async () => {
    let now = 1_000_000;
    const { provider, tickets } = setup(() => now);
    const ctx = { userId: "u", workspaceId: "w", externalSubject: "s", permissions: ["workspace:read"] };
    const { ticket } = tickets.mint(ctx, attachment);
    await expect(provider.authenticate(request(attachment, { ticket }, "DELETE"))).rejects.toMatchObject({ code: "TICKET_METHOD_NOT_ALLOWED" });
    const tampered = ticket.slice(0, -3) + "AAA";
    await expect(provider.authenticate(request(attachment, { ticket: tampered }))).rejects.toMatchObject({ code: "INVALID_TICKET" });
    const foreign = new StreamTicketService("another-installation-secret-0123456789abcdef").mint(ctx, attachment).ticket;
    await expect(provider.authenticate(request(attachment, { ticket: foreign }))).rejects.toMatchObject({ code: "INVALID_TICKET" });
    now += STREAM_TICKET_TTL_MS + 1;
    await expect(provider.authenticate(request(attachment, { ticket }))).rejects.toMatchObject({ code: "TICKET_EXPIRED" });
  });

  it("only allow-listed resources can be ticketed", () => {
    const { tickets } = setup();
    const ctx = { userId: "u", workspaceId: "w", externalSubject: "s", permissions: [] };
    for (const path of ["/companies", "/auth/me", "/attachments/../companies", "/companies/c/browser-credentials/x/reveal"]) {
      expect(() => tickets.mint(ctx, path)).toThrow(/cannot be opened with a ticket/);
    }
    expect(normalizeTicketPath("/api/attachments/a/?x=1")).toBe("/attachments/a");
  });

  it("POST /stream-tickets requires the Authorization header; a ticket cannot mint another", async () => {
    const { provider, session } = setup();
    const app = Fastify();
    registerStreamTicketRoutes(app, provider);
    try {
      const minted = await app.inject({ method: "POST", url: "/stream-tickets", headers: { authorization: `Bearer ${session}` }, payload: { path: `/api${attachment}` } });
      expect(minted.statusCode).toBe(200);
      const body = minted.json() as { ticket: string; url: string };
      expect(body.url).toBe(`/api${attachment}?ticket=${encodeURIComponent(body.ticket)}`);
      expect(minted.headers["cache-control"]).toBe("no-store");
      const chained = await app.inject({ method: "POST", url: `/stream-tickets?ticket=${encodeURIComponent(body.ticket)}`, payload: { path: `/api${attachment}` } });
      expect(chained.statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/stream-tickets", headers: { authorization: `Bearer ${session}` }, payload: { path: "/companies" } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it("tickets are redacted from request logs", () => {
    expect(redactUrlSecrets("/api/attachments/a?ticket=st1.abc.def&x=1")).toBe("/api/attachments/a?ticket=[REDACTED]&x=1");
  });
});
