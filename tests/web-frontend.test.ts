import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../apps/agent-api/src/app";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { registerWebFrontend, rewriteBrowserApiUrl } from "../apps/agent-api/src/web-frontend";

let app: FastifyInstance;
let root: string;
// Like the real build (apps/web/index.html), the page has a head: the server adds its meta tags there.
const html = "<!doctype html><html><head></head><body>NPATI frontend</body></html>";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "npati-web-test-"));
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "index.html"), html);
  await writeFile(path.join(root, "assets", "app-Ab12.js"), "console.log('asset')");
  await writeFile(path.join(root, ".env"), "SECRET=private");
  app = Fastify({ rewriteUrl: rewriteBrowserApiUrl });
  registerWebFrontend(app, root);
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/automations", async () => ({ items: [] }));
  app.get("/private", { preHandler: async (_req, reply) => { reply.code(401).send({ error: "unauthorized" }); } }, async () => ({ secret: true }));
  app.post("/upload", async (req) => ({ body: req.body, query: req.query }));
  app.get("/events", async (_req, reply) => reply.type("text/event-stream").send(Readable.from(["data: first\n\n", "data: second\n\n"])));
  app.get("/companies/:company/projects/:project/preview/proxy/*", async (_req, reply) => reply.type("text/html").send("project preview"));
});
afterEach(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

// V6 step 17: the app page had no framing protection, so another site could frame it and steer a click onto "Allow".
it("forbids framing the app page by another site and keeps the project preview frameable", async () => {
  const page = await app.inject({ url: "/c/active-chat", headers: { accept: "text/html" } });
  expect(page.headers["x-frame-options"]).toBe("SAMEORIGIN");
  expect(page.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
  const preview = await app.inject({ url: "/companies/c/projects/p/preview/proxy/index.html" });
  expect(preview.headers["x-frame-options"]).toBeUndefined();
});

describe("frontend and API in one HTTP server", () => {
  it.each(["/", "/activity?runId=running-agent", "/c/active-chat", "/settings/code/company/project", "/projects/company/project", "/companies/company/projects/project/data", "/unknown-page"])("serves browser navigation at %s", async (url) => {
    const response = await app.inject({ url, headers: { accept: "text/html" } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(html);
    expect(response.headers["cache-control"]).toBe("no-cache");
    const head = await app.inject({ method: "HEAD", url, headers: { accept: "text/html" } });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
  });
  it("serves JS with its MIME type, immutable cache and conditional requests", async () => {
    const response = await app.inject("/assets/app-Ab12.js");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("javascript");
    expect(response.headers["cache-control"]).toContain("immutable");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    const cached = await app.inject({ url: "/assets/app-Ab12.js", headers: { "if-none-match": String(response.headers.etag) } });
    expect(cached.statusCode).toBe(304);
  });
  it.each(["/api/missing", "/api/assets/app-Ab12.js", "/api/index.html", "/api/", "/api", "/assets/missing.js", "/assets/missing", "/.env", "/%2eenv", "/%2e%2e/package.json"])("never returns the SPA or private files for %s", async (url) => {
    const response = await app.inject({ url, headers: { accept: "text/html" } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain("NPATI frontend");
    expect(response.body).not.toContain("SECRET=private");
  });
  it("keeps legacy endpoints, prefixed endpoints and colliding React pages distinct", async () => {
    expect((await app.inject("/health/live")).json()).toEqual({ status: "ok" });
    expect((await app.inject("/api/health/live")).json()).toEqual({ status: "ok" });
    expect((await app.inject("/automations")).json()).toEqual({ items: [] });
    expect((await app.inject({ url: "/automations", headers: { accept: "text/html" } })).body).toBe(html);
    expect((await app.inject({ url: "/api/automations", headers: { accept: "text/html" } })).json()).toEqual({ items: [] });
    expect((await app.inject({ url: "/api/private", headers: { accept: "text/html" } })).statusCode).toBe(401);
  });
  it("preserves request bodies, query strings and event streams", async () => {
    const upload = await app.inject({ method: "POST", url: "/api/upload?name=a%20b", payload: { content: "file body" } });
    expect(upload.json()).toEqual({ body: { content: "file body" }, query: { name: "a b" } });
    const events = await app.inject("/api/events");
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(events.body).toBe("data: first\n\ndata: second\n\n");
  });
  it("keeps project preview HTML outside the SPA", async () => {
    for (const prefix of ["", "/api"]) {
      const response = await app.inject({ url: prefix + "/companies/c/projects/p/preview/proxy/index.html", headers: { accept: "text/html" } });
      expect(response.body).toBe("project preview");
    }
  });
  it("serves the frontend inside the real API app without bypassing API authentication", async () => {
    await app.close();
    let authCalls = 0;
    app = buildApp({
      webDistDirectory: root,
      dataDirectory: root,
      projectWorkspaceRoot: path.join(root, "projects"),
      workspaceStore: new InMemoryWorkspaceStore(),
      authProvider: { authenticate: async () => {
        authCalls++;
        return { userId: "user", workspaceId: "workspace", permissions: ["workspace:read"] };
      } },
    });
    expect((await app.inject("/")).body).toBe(html);
    expect((await app.inject("/assets/app-Ab12.js")).statusCode).toBe(200);
    expect(authCalls).toBe(0);
    expect((await app.inject("/api/health/live")).json()).toMatchObject({ status: "ok" });
    const companies = await app.inject("/api/companies");
    expect(companies.statusCode).toBe(200);
    expect(authCalls).toBeGreaterThan(0);
    expect((await app.inject({ url: "/api/no-such-endpoint", headers: { accept: "text/html" } })).statusCode).toBe(404);
  });
  it("fails startup when the configured frontend build is missing", async () => {
    await rm(path.join(root, "index.html"));
    await expect(app.ready()).rejects.toThrow();
  });
});

describe("public landing page", () => {
  const landing = "<!doctype html><html><body>NPATI landing</body></html>";
  beforeEach(async () => {
    await mkdir(path.join(root, "landing"));
    await writeFile(path.join(root, "landing", "index.html"), landing);
  });

  it("serves the landing page at / and keeps the app on its own pages", async () => {
    const home = await app.inject({ url: "/", headers: { accept: "text/html" } });
    expect(home.statusCode).toBe(200);
    expect(home.body).toBe(landing);
    expect(home.headers["x-frame-options"]).toBe("SAMEORIGIN");
    for (const url of ["/login", "/signup", "/chat"]) {
      const page = await app.inject({ url, headers: { accept: "text/html" } });
      expect(page.body).toContain("NPATI frontend");
      expect(page.body).toContain('<meta name="npati-landing" content="/" />');
    }
  });
});

it("does not mark the app page when there is no landing page", async () => {
  await writeFile(path.join(root, "index.html"), "<!doctype html><html><head></head><body>NPATI frontend</body></html>");
  const page = await app.inject({ url: "/login", headers: { accept: "text/html" } });
  expect(page.body).toContain("NPATI frontend");
  expect(page.body).not.toContain("npati-landing");
});
