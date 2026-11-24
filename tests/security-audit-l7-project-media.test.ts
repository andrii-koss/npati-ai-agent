import { Readable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { createC3ProofFixture } from "./support/c3-workspace-proof";
import { registerProjectFileRoutes } from "../apps/agent-api/src/project-file-routes";
import type { ProjectMediaService } from "../apps/agent-api/src/project-media-service";
import type { ProjectService } from "../apps/agent-api/src/project-service";
import { AuthenticationError, type AuthProvider } from "../apps/agent-api/src/auth";
import { StreamTicketService } from "../apps/agent-api/src/stream-tickets";

/**
 * Security audit 2026-11-24, L7: /api/projects/:id/media/* answered anyone who knew a project id, drafts included.
 * It now requires a signed-in caller (header or stream ticket) who may read that project.
 */
async function serve(caller: (request: { headers: Record<string, string | undefined>; query: Record<string, string>; url: string; method: string }) => AuthContext | null, path = "assets/logo.png") {
  const f = await createC3ProofFixture();
  const app = Fastify();
  const getMedia = vi.fn(async () => ({ stream: Readable.from(Buffer.from([1, 2, 3])), mimeType: "image/png" }));
  const auth: AuthProvider = {
    authenticate: async (request) => {
      const context = caller(request as never);
      if (!context) throw new AuthenticationError("Bearer token is required");
      return context;
    },
  };
  const projects = { store: f.store, get: (ctx: AuthContext, companyId: string, projectId: string) => f.store.getProject(ctx, companyId, projectId) } as unknown as ProjectService;
  registerProjectFileRoutes(app, f.workspace, auth, { getMedia } as unknown as ProjectMediaService, projects);
  return { f, app, getMedia, url: `/api/projects/${f.project.id}/media/${path}` };
}

describe("L7: project media requires a caller who may read the project", () => {
  it("an anonymous request gets 401 and no media is read", async () => {
    const { f, app, getMedia, url } = await serve(() => null);
    try {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(401);
      expect(getMedia).not.toHaveBeenCalled();
    } finally { await app.close(); await f.cleanup(); }
  });

  it("a signed-in user of another workspace gets 404", async () => {
    const { f, app, getMedia, url } = await serve(() => ({ userId: "stranger", workspaceId: "workspace:stranger", externalSubject: "s", permissions: ["workspace:read"] }));
    try {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
      expect(getMedia).not.toHaveBeenCalled();
    } finally { await app.close(); await f.cleanup(); }
  });

  it("the owner gets the file, also through a stream ticket", async () => {
    const tickets = new StreamTicketService("media-ticket-secret-0123456789abcdef0123");
    let fixtureCtx: AuthContext | undefined;
    const { f, app, getMedia, url } = await serve((request) => {
      if (request.query.ticket) return tickets.verify(request.query.ticket, request.url, request.method);
      return request.headers.authorization ? fixtureCtx! : null;
    });
    fixtureCtx = f.ctx;
    try {
      expect((await app.inject({ method: "GET", url, headers: { authorization: "Bearer owner" } })).statusCode).toBe(200);
      const { ticket } = tickets.mint(f.ctx, url);
      expect((await app.inject({ method: "GET", url: `${url}?ticket=${encodeURIComponent(ticket)}` })).statusCode).toBe(200);
      expect(getMedia).toHaveBeenCalledTimes(2);
    } finally { await app.close(); await f.cleanup(); }
  });

  it("a project id that is not id-shaped never reaches the filesystem lookup", async () => {
    const { f, app, getMedia } = await serve(() => ({ userId: "u", workspaceId: "w", externalSubject: "s", permissions: ["workspace:read"] }));
    try {
      expect((await app.inject({ method: "GET", url: "/api/projects/..%2F..%2Fetc/media/x.png" })).statusCode).toBe(404);
      expect(getMedia).not.toHaveBeenCalled();
    } finally { await app.close(); await f.cleanup(); }
  });
});
