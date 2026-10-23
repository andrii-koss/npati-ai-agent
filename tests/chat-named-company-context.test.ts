import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { ActiveContextResolver, companyNamedInMessage } from "../apps/agent-api/src/active-context-resolver";

const companies = [
  { id: "bakery", name: "Пекарня Сонях" },
  { id: "fit", name: "Nordic Fit Studio" },
  { id: "new", name: "New" },
  { id: "m1", name: "Measure baseline 2026-10-22" },
  { id: "m2", name: "Measure after 2026-10-22" },
];

describe("company named in a chat message", () => {
  it("switches to the one other company the message names, inflected names included", () => {
    expect(companyNamedInMessage(companies, "Build a React + Vite landing page for Nordic Fit", "bakery")?.id).toBe("fit");
    expect(companyNamedInMessage(companies, "Повернімося до сайту пекарні: додай сторінку /about", "fit")?.id).toBe("bakery");
  });

  it("keeps the active company when it is named, nothing is named, or the name is ambiguous", () => {
    expect(companyNamedInMessage(companies, "Додай на сайт пекарні сторінку /about", "bakery")).toBeUndefined();
    expect(companyNamedInMessage(companies, "Add a new page with a contact form", "bakery")).toBeUndefined();
    expect(companyNamedInMessage(companies, "Show the measure results", "bakery")).toBeUndefined();
    expect(companyNamedInMessage(companies, "Compare Пекарня Сонях and Nordic Fit", "bakery")).toBeUndefined();
  });

  it("resolves the named company's latest project, or the company itself for a new project", async () => {
    const store = new InMemoryWorkspaceStore();
    const auth: AuthContext = { userId: "owner", workspaceId: "workspace", permissions: ["workspace:read", "workspace:write", "business:manage"] };
    const bakery = await store.createCompany(auth, { name: "Пекарня Сонях" }, "bakery");
    const fit = await store.createCompany(auth, { name: "Nordic Fit" }, "fit");
    await store.createProject(auth, fit.id, { name: "Nordic Fit landing", type: "website" } as never, "fit-site");
    const site = (await store.listProjects(auth, fit.id))[0]!;
    const resolver = new ActiveContextResolver(store);
    const current = await resolver.resolve(auth, { contextType: "company", companyId: bakery.id });
    const edit = await resolver.resolveNamedCompany(auth, current, "Add a pricing section to the Nordic Fit landing page");
    expect(edit?.context).toMatchObject({ contextType: "project", companyId: fit.id, projectId: site.id });
    const create = await resolver.resolveNamedCompany(auth, current, "Create a website for Nordic Fit", { intent: "CREATE_WEBSITE" } as never);
    expect(create?.context).toMatchObject({ contextType: "company", companyId: fit.id });
    expect(await resolver.resolveNamedCompany(auth, current, "Додай сторінку на сайт пекарні")).toBeUndefined();
  });

  it("switches to the company whose agent the message addresses when no company is named", async () => {
    const store = new InMemoryWorkspaceStore();
    const auth: AuthContext = { userId: "owner", workspaceId: "workspace", permissions: ["workspace:read", "workspace:write", "business:manage"] };
    const bakery = await store.createCompany(auth, { name: "Пекарня Сонях" }, "bakery");
    await store.createCompanyAgent(auth, bakery.id, { name: "Олена", role: "Операційна директорка" }, "olena");
    const fit = await store.createCompany(auth, { name: "Nordic Fit" }, "fit");
    await store.createCompanyAgent(auth, fit.id, { name: "Coach Ana", role: "Lead trainer" }, "ana");
    const resolver = new ActiveContextResolver(store);
    const current = await resolver.resolve(auth, { contextType: "company", companyId: bakery.id });
    expect((await resolver.resolveNamedCompany(auth, current, "Have Coach Ana write three captions"))?.context).toMatchObject({ contextType: "company", companyId: fit.id });
    expect(await resolver.resolveNamedCompany(auth, current, "Нехай Олена підготує план")).toBeUndefined();
  });
});

describe("a creation request naming an existing company", () => {
  it("does not switch the context to that company", async () => {
    const store = new InMemoryWorkspaceStore();
    const auth: AuthContext = { userId: "owner", workspaceId: "workspace", permissions: ["workspace:read", "workspace:write", "business:manage"] };
    const bakery = await store.createCompany(auth, { name: "Пекарня Сонях" }, "bakery");
    await store.createCompany(auth, { name: "NovaScale Labs" }, "nova");
    const resolver = new ActiveContextResolver(store);
    const current = await resolver.resolve(auth, { contextType: "company", companyId: bakery.id });
    expect(await resolver.resolveNamedCompany(auth, current, "Create NovaScale Labs")).toBeUndefined();
    expect((await resolver.resolveNamedCompany(auth, current, "Create a website for NovaScale Labs", { intent: "CREATE_WEBSITE" } as never))?.context.companyId).not.toBe(bakery.id);
  });
});
