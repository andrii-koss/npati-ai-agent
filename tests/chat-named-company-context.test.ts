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
    expect((await resolver.resolveNamedCompany(auth, current, "Have Coach Ana write three captions", undefined, "We created Nordic Fit with Coach Ana."))?.context).toMatchObject({ contextType: "company", companyId: fit.id });
    // Without that company in the conversation, an agent name alone does not switch to it.
    expect(await resolver.resolveNamedCompany(auth, current, "Have Coach Ana write three captions")).toBeUndefined();
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
    expect(await resolver.resolveNamedCompany(auth, current, "Видали компанію «NovaScale Labs»")).toBeUndefined();
    expect((await resolver.resolveNamedCompany(auth, current, "Create a website for NovaScale Labs", { intent: "CREATE_WEBSITE" } as never))?.context.companyId).not.toBe(bakery.id);
  });
});

describe("a loose company match", () => {
  it("never selects a company this conversation has not dealt with", async () => {
    const store = new InMemoryWorkspaceStore();
    const auth: AuthContext = { userId: "owner", workspaceId: "workspace", permissions: ["workspace:read", "workspace:write", "business:manage"] };
    const bakery = await store.createCompany(auth, { name: "Пекарня Сонях" }, "bakery");
    const fit = await store.createCompany(auth, { name: "Nordic Fit" }, "fit");
    await store.createCompany(auth, { name: "Stress DS1023 Bakery" }, "other-session");
    const resolver = new ActiveContextResolver(store);
    const current = await resolver.resolve(auth, { contextType: "company", companyId: fit.id });
    const history = "Створи компанію «Пекарня Сонях» ... Create a second company «Nordic Fit»";
    expect(await resolver.resolveNamedCompany(auth, current, "Delete the bakery webhook for new orders", undefined, history)).toBeUndefined();
    expect((await resolver.resolveNamedCompany(auth, current, "Повернімося до сайту пекарні", undefined, history))?.context.companyId).toBe(bakery.id);
    expect((await resolver.resolveNamedCompany(auth, current, "Show the Stress DS1023 Bakery site", undefined, history))?.context.companyId).not.toBe(fit.id);
  });
});


describe("an exact project target overrides the previous project context", () => {
  it("selects the named Vite project across owned companies and refuses ambiguous duplicates", async () => {
    const store = new InMemoryWorkspaceStore();
    const auth: AuthContext = { userId: "project-target-owner", workspaceId: "project-target-workspace", permissions: ["workspace:read", "business:manage"] };
    const bakery = await store.createCompany(auth, { name: "Stress Bakery" }, "target-bakery");
    const studio = await store.createCompany(auth, { name: "Stress Studio" }, "target-studio");
    const { project: next } = await store.createProject(auth, bakery.id, { name: "Stress Next Shop", type: "website" } as never, "target-next");
    const { project: vite } = await store.createProject(auth, studio.id, { name: "Stress Vite", type: "website" } as never, "target-vite");
    const resolver = new ActiveContextResolver(store);
    const current = await resolver.resolve(auth, { contextType: "project", companyId: bakery.id, projectId: next.id });
    const decision = { intent: "EDIT_WEBSITE" } as never;
    const message = 'Im Projekt "Stress Vite" aendere die Ueberschrift.';
    const history = "We created Stress Studio and Stress Vite.";
    expect((await resolver.resolveNamedCompany(auth, current, message, decision, history))?.context).toMatchObject({ companyId: studio.id, projectId: vite.id });
    // The selected company's own older project must also beat its most recently updated one.
    const sameCompany = await resolver.resolve(auth, { contextType: "company", companyId: studio.id });
    expect((await resolver.resolveNamedCompany(auth, sameCompany, message, decision, history))?.context.projectId).toBe(vite.id);
    await store.createProject(auth, bakery.id, { name: "Stress Vite", type: "website" } as never, "duplicate-target-vite");
    await expect(resolver.resolveNamedCompany(auth, current, message, decision, history)).rejects.toThrow("More than one owned project");
  });
  it("does not search a different company from a loose project reference outside this conversation", async () => {
    const store = new InMemoryWorkspaceStore();
    const auth: AuthContext = { userId: "scoped-project-owner", workspaceId: "scoped-project-workspace", permissions: ["workspace:read", "business:manage"] };
    const selected = await store.createCompany(auth, { name: "Selected Company" }, "selected-project-company");
    const other = await store.createCompany(auth, { name: "Unmentioned Company" }, "other-project-company");
    await store.createProject(auth, other.id, { name: "Other Vite", type: "website" } as never, "other-project");
    const resolver = new ActiveContextResolver(store);
    const current = await resolver.resolve(auth, { contextType: "company", companyId: selected.id });
    expect(await resolver.resolveNamedCompany(auth, current, 'Edit "Other Vite"', { intent: "EDIT_WEBSITE" } as never)).toBeUndefined();
  });
});


it("keeps an explicitly named current company when a verb coincides with another company's agent name", async () => {
  const store = new InMemoryWorkspaceStore();
  const auth: AuthContext = { userId: "agent-name-owner", workspaceId: "agent-name-workspace", permissions: ["workspace:read", "business:manage"] };
  const bakery = await store.createCompany(auth, { name: "Stress Bakery" }, "agent-name-bakery");
  const other = await store.createCompany(auth, { name: "Other Company" }, "agent-name-other");
  await store.createCompanyAgent(auth, other.id, { name: "Mark", role: "Lead" }, "agent-mark");
  const resolver = new ActiveContextResolver(store);
  const current = await resolver.resolve(auth, { contextType: "company", companyId: bakery.id });
  expect(await resolver.resolveNamedCompany(auth, current, 'In company "Stress Bakery", mark test contact as blacklisted.', { intent: "CHAT" } as never, "We previously worked in Other Company.")).toBeUndefined();
});

it("does not switch to a company whose name or agent name is an ordinary word in the message or history", async () => {
  const store = new InMemoryWorkspaceStore();
  const auth: AuthContext = { userId: "common-word-owner", workspaceId: "common-word-workspace", permissions: ["workspace:read", "business:manage"] };
  const bakery = await store.createCompany(auth, { name: "Stress Bakery" }, "common-word-bakery");
  const other = await store.createCompany(auth, { name: "New" }, "common-word-new");
  await store.createCompanyAgent(auth, other.id, { name: "Add", role: "Helper" }, "common-word-add");
  const resolver = new ActiveContextResolver(store);
  const current = await resolver.resolve(auth, { contextType: "company", companyId: bakery.id });
  const message = 'Update goal "Stress Launch" priority to 1 and add an acceptance condition: database updates must appear on the website.';
  expect(await resolver.resolveNamedCompany(auth, current, message, { intent: "CHAT" } as never, "We added a new acceptance check and a new page.")).toBeUndefined();
});
