import Fastify from "fastify";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { ActiveContextResolver } from "../apps/agent-api/src/active-context-resolver";
import { ProjectNameAmbiguityError } from "../apps/agent-api/src/same-name-project-i18n";
import { createMockNpatiJwt, NpatiBackendAuthProvider, redactUrlSecrets, redactedRequestSerializer } from "../apps/agent-api/src/auth";

const auth: AuthContext = { userId: "owner", workspaceId: "workspace", permissions: ["workspace:read", "workspace:write", "business:manage"] };
const edit = { intent: "EDIT_PROJECT" } as never;

async function sameNamedProjects() {
  const store = new InMemoryWorkspaceStore();
  const company = await store.createCompany(auth, { name: "QA Labs" }, "qa");
  const make = async (name: string, key: string) => (await store.createProject(auth, company.id, { name, type: "code_project" } as never, key)).project;
  const first = await make("My Tasks", "first"), second = await make("My Tasks", "second"), other = await make("Snake Arena", "other");
  return { store, company, first, second, other, resolver: new ActiveContextResolver(store) };
}

// Found in step 4b: "Зміни колір заголовка My Tasks" in the chat of one "My Tasks" failed with INVALID_CONTEXT because
// the user owns several projects with that name.
describe("a request naming a project several projects share", () => {
  it("stays in the chat's own project when it is one of them", async () => {
    const f = await sameNamedProjects();
    const current = await f.resolver.resolve(auth, { contextType: "project", companyId: f.company.id, projectId: f.second.id });
    expect(await f.resolver.resolveNamedCompany(auth, current, "Зміни колір заголовка My Tasks на #16a34a.", edit)).toBeUndefined();
  });

  it("uses the one same-named project this conversation worked in", async () => {
    const f = await sameNamedProjects();
    const current = await f.resolver.resolve(auth, { contextType: "project", companyId: f.company.id, projectId: f.other.id });
    const ids = vi.fn(async () => [f.other.id, f.first.id]);
    const resolved = await f.resolver.resolveNamedCompany(auth, current, "У My Tasks додай фільтр", edit, "", { conversationProjectIds: ids });
    expect(resolved?.context).toMatchObject({ contextType: "project", projectId: f.first.id });
  });

  it("asks which one, in the user's language, when nothing in the chat decides", async () => {
    const f = await sameNamedProjects();
    const current = await f.resolver.resolve(auth, { contextType: "project", companyId: f.company.id, projectId: f.other.id });
    const ask = f.resolver.resolveNamedCompany(auth, current, "У My Tasks додай фільтр", edit, "", { conversationProjectIds: async () => [] });
    await expect(ask).rejects.toThrow(/Знайдено кілька проєктів із назвою «My Tasks»:\n- My Tasks — QA Labs, .*\n- My Tasks — QA Labs/u);
    await expect(ask).rejects.toBeInstanceOf(ProjectNameAmbiguityError);
    await expect(f.resolver.resolveNamedCompany(auth, current, "Add a filter in My Tasks", edit)).rejects.toThrow(/More than one owned project is named “My Tasks”:\n- My Tasks — QA Labs/u);
    // V6 D08-04: the two entries must differ (the date was "Fri Nov 13" for both); each names its id and creation minute.
    const message = await ask.catch((error: Error) => error.message);
    const entries = message.split("\n").filter((line) => line.startsWith("- "));
    expect(entries).toHaveLength(2);
    expect(entries[0]).not.toBe(entries[1]);
    const ids = entries.map(entry => /id ([0-9a-f]{8})$/.exec(entry)?.[1]);
    expect(ids.every(Boolean) && ids[0] !== ids[1]).toBe(true);
    expect(message).toMatch(/створено \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  });

  it("still refuses to guess between differently named projects", async () => {
    const f = await sameNamedProjects();
    await f.store.createProject(auth, f.company.id, { name: "Snake Arena Pro", type: "code_project" } as never, "pro");
    const current = await f.resolver.resolve(auth, { contextType: "project", companyId: f.company.id, projectId: f.first.id });
    await expect(f.resolver.resolveNamedCompany(auth, current, "Fix the score in Snake Arena Pro", edit)).rejects.toThrow(/More than one owned project is named/u);
  });
});

describe("credentials in request URLs", () => {
  it("accepts a session token in no URL parameter (audit L6: media and event streams use stream tickets)", async () => {
    const secret = "url-credential-secret-at-least-thirty-two-chars";
    const provider = new NpatiBackendAuthProvider({ jwtSecret: secret, workspaceStore: { initialize: async () => undefined } as never });
    const token = createMockNpatiJwt({ userId: "url-user" }, secret);
    await expect(provider.authenticate({ headers: {}, query: { authToken: token } } as never)).rejects.toThrow();
    await expect(provider.authenticate({ headers: {}, query: { token }, url: "/attachments/x", method: "GET" } as never))
      .rejects.toMatchObject({ code: "TOKEN_IN_URL_REFUSED" });
    await expect(provider.authenticate({ headers: { authorization: `Bearer ${token}` }, query: {} } as never)).resolves.toMatchObject({ workspaceId: "workspace:url-user" });
  });

  it("writes request URLs to the log without their credentials", async () => {
    expect(redactUrlSecrets("/api/attachments/a?token=eyJ.secret&download=1")).toBe("/api/attachments/a?token=[REDACTED]&download=1");
    expect(redactUrlSecrets("/x?authToken=s&access_token=t&apiKey=k")).toBe("/x?authToken=[REDACTED]&access_token=[REDACTED]&apiKey=[REDACTED]");
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
    const app = Fastify({ logger: { level: "info", stream, serializers: { req: redactedRequestSerializer } } });
    app.get("/api/attachments/:id", async () => ({ ok: true }));
    try {
      expect((await app.inject({ method: "GET", url: "/api/attachments/a?token=session-secret-value" })).statusCode).toBe(200);
    } finally { await app.close(); }
    const log = lines.join("\n");
    expect(log).toContain("/api/attachments/a?token=[REDACTED]");
    expect(log).not.toContain("session-secret-value");
  });
});

describe("the catalog Preview launch route", () => {
  it("is gone, so no route turns a session token in the URL into a Preview redirect", async () => {
    const { buildApp } = await import("../apps/agent-api/src/app");
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "Launch Labs" }, "launch");
    const { project } = await store.createProject(auth, company.id, { name: "Site", type: "website" } as never, "site");
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, marketplace: { marketplace: async () => ({ overview: {} }) } as never });
    try {
      const launch = await app.inject({ method: "GET", url: `/companies/${company.id}/projects/${project.id}/preview/launch?authToken=x` });
      expect(launch.statusCode).toBe(404);
      const status = await app.inject({ method: "GET", url: `/companies/${company.id}/projects/${project.id}/preview/status` });
      expect(status.statusCode).not.toBe(404);
    } finally { await app.close(); }
  }, 60_000);
});
