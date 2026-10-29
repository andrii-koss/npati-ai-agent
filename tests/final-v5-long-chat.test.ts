import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AIEngine, ChatRequest, ChatResult, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { EmailInboxRepository } from "../apps/agent-api/src/email-inbox-repository";
import { EmailChatActions } from "../apps/agent-api/src/email-chat-actions";
import { takesRowCapabilityPath } from "../apps/agent-api/src/chat-project-data-capabilities";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
import { buildApp } from "../apps/agent-api/src/app";
import { randomUUID } from "node:crypto";
import { PostgresWorkspaceStore } from "@npati/workspace";
import { databaseDescribe } from "./support/database-describe";

/** Final V5 stage 14 regressions from the A001–B005/P001–P040 long-chat matrix. */
const auth = { workspaceId: "ws-s14", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage", "email:manage_accounts"] } as AuthContext;

describe("A018: email planner scope follows the company the request names", () => {
  it("plans in the named company although another company is active, across more than one page of companies", async () => {
    const store = new InMemoryWorkspaceStore();
    const repo = new EmailInboxRepository();
    for (let i = 0; i < 105; i++) await store.createCompany(auth, { name: `Filler ${String(i).padStart(3, "0")}` }, `filler-${i}`);
    const studio = await store.createCompany(auth, { name: "Stress S14A Studio" }, "studio");
    const bakery = await store.createCompany(auth, { name: "Stress S14A Bakery" }, "bakery");
    await repo.createAccount(auth, bakery.id, { emailAddress: "stress-s14a@npati.test", testMode: true } as never);
    const prompt = await EmailChatActions.buildSystemPrompt(auth, store, repo,
      'In company "Stress S14A Bakery", save an email DRAFT from EMAIL_REF_x_1 to EMAIL_REF_x_2, subject STRESS_ORDER_731. Do not send yet.',
      studio.id, undefined, { EMAIL_REF_x_1: "stress-s14a@npati.test", EMAIL_REF_x_2: "receiver@npati.test" });
    expect(prompt).toContain(`"id":"${bakery.id}"`);
    expect(prompt).not.toContain(`"id":"${studio.id}"`);
    expect(prompt).toContain("stress-s14a@npati.test");
  });

  it("keeps the active company when the request names no other company", async () => {
    const store = new InMemoryWorkspaceStore();
    const repo = new EmailInboxRepository();
    const studio = await store.createCompany(auth, { name: "Stress S14A Studio" }, "studio");
    await store.createCompany(auth, { name: "Stress S14A Bakery" }, "bakery");
    const prompt = await EmailChatActions.buildSystemPrompt(auth, store, repo, "List the email routing rules.", studio.id);
    expect(prompt).toContain(`"id":"${studio.id}"`);
  });
});

describe("A015: row reads and inserts without a granted Company agent use the coding executor", () => {
  it("only update and delete stay Company-capability-only", async () => {
    const denied = vi.fn(async () => false);
    expect(await takesRowCapabilityPath("project.data.rows.create", denied)).toBe(false);
    expect(await takesRowCapabilityPath("project.data.rows.list", denied)).toBe(false);
    expect(await takesRowCapabilityPath("project.data.rows.update", denied)).toBe(true);
    expect(await takesRowCapabilityPath("project.data.rows.delete", denied)).toBe(true);
    expect(await takesRowCapabilityPath("project.data.rows.create", async () => true)).toBe(true);
  });

  it.each(["/chat/stream", "/chat"])("does not dead-end an insert with the capability refusal over %s", async url => {
    const store = new InMemoryWorkspaceStore();
    let company = await store.createCompany(auth, { name: "Capability Company" }, "cap-company");
    const agent = await store.createCompanyAgent(auth, company.id, { name: "Lead", role: "Coordinator", tools: [], isActive: true }, "cap-agent");
    company = await store.setCompanyMainAgent(auth, company.id, agent.id, company.revision);
    const { project } = await store.createProject(auth, company.id, { name: "Dev project", type: "code_project", dataBackendId: "cap-dev-backend" }, "cap-project");
    const ai = { supportsNativeTools: () => true,
      chat: async (r: ChatRequest): Promise<ChatResult> => String(r.messages[0]?.content).startsWith("Classify")
        ? { content: JSON.stringify({ intent: "EDIT_DATA_MODEL", confidence: .99, targets: [], rowCapability: "project.data.rows.create" }) } : { content: "Handled by the coding route." },
      async *stream() { yield "Handled by the coding route."; }, listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }) } as unknown as AIEngine;
    const execute = vi.spyOn(CompanyDelegationRuntime.prototype, "executeChatProjectTool");
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace: { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace });
    try {
      const r = await app.inject({ method: "POST", url, payload: { message: 'Insert product "STRESS_PRODUCT_731" priced 73.10 into the dev database.', contextType: "project", companyId: company.id, projectId: project.id } });
      expect(r.body).not.toContain("project.data.rows.create");
      expect(execute).not.toHaveBeenCalled();
      expect((await store.getCompanyAgent(auth, company.id, agent.id)).tools).toEqual([]);
    } finally { execute.mockRestore(); await app.close(); }
  });
});

const url = process.env.DATABASE_URL;
const database = databaseDescribe(Boolean(url) && process.env.NPATI_SECURITY_GATE_DB === "1", describe, describe.skip);
database("A022/A024: keyset pages never repeat a row (PostgreSQL keeps microseconds, the cursor milliseconds)", () => {
  it("pages companies, company agents and businesses one row at a time without duplicates", async () => {
    const ctx: AuthContext = { workspaceId: "s14-" + randomUUID(), userId: "s14-" + randomUUID(), permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"] };
    const store = new PostgresWorkspaceStore(String(url));
    // A cursor that repeats its own last row would loop; the bound turns that into a visible duplicate.
    const walk = async (page: (cursor?: string) => Promise<{ items: Array<{ id: string }>; nextCursor: string | null }>) => {
      const ids: string[] = []; let cursor: string | undefined;
      for (let i = 0; i < 8; i++) { const r = await page(cursor); ids.push(...r.items.map(item => item.id)); cursor = r.nextCursor ?? undefined; if (!cursor) break; }
      return ids;
    };
    try {
      await store.initialize(ctx);
      const companies = [];
      for (const name of ["Page A", "Page B", "Page C"]) companies.push(await store.createCompany(ctx, { name }, randomUUID()));
      for (const name of ["Lead", "Reviewer", "Writer"]) await store.createCompanyAgent(ctx, companies[0]!.id, { name, role: name, isActive: true }, randomUUID());
      for (const name of ["Biz A", "Biz B", "Biz C"]) await store.createBusiness(ctx, { name } as never, randomUUID());
      const companyIds = await walk(cursor => store.listCompanies(ctx, 1, cursor));
      expect(companyIds).toEqual(companies.map(company => company.id));
      const agentIds = await walk(cursor => store.listCompanyAgentsPage(ctx, companies[0]!.id, 1, cursor));
      expect(agentIds).toHaveLength(3); expect(new Set(agentIds).size).toBe(3);
      const businessIds = await walk(cursor => store.listBusinessesPage(ctx, 1, cursor));
      expect(businessIds).toHaveLength(3); expect(new Set(businessIds).size).toBe(3);
    } finally { await store.close?.(); }
  });
});

describe("A041: a project run whose agents read no source does not present a source review", () => {
  const engine = (chat: AIEngine["chat"], plan: unknown): AIEngine => ({ chat, async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined,
    executeTool: async () => undefined, searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
    ensureA2AEnabled: async () => undefined, a2aSend: async () => ({ taskId: "plan", content: JSON.stringify(plan), metadata: {} }), cancelA2ATask: async () => undefined,
    ensureCombo: async (input: { name: string }) => ({ name: input.name }) } as unknown as AIEngine);
  it.each([[[], true], [["project.files.read"], false]] as const)("agent tools %j → limitation note %s", async (tools, noted) => {
    const store = new InMemoryWorkspaceStore();
    let company = await store.createCompany(auth, { name: "Stress S14A Studio" }, "a041-company");
    const designer = await store.createCompanyAgent(auth, company.id, { name: "Designer", role: "Lead", tools: [...tools] }, "a041-designer");
    const reviewer = await store.createCompanyAgent(auth, company.id, { name: "Reviewer", role: "QA", tools: [...tools] }, "a041-reviewer");
    company = await store.setCompanyMainAgent(auth, company.id, designer.id, company.revision);
    const reads = tools.length ? [{ agentId: reviewer.id, tool: "project.files.read", input: { projectId: "vite-1", path: "src/App.jsx" } }] : [];
    const chat = vi.fn(async () => ({ content: "Review", model: "auto" }));
    const execute = vi.fn(async () => ({ path: "src/App.jsx", content: "<h1>STRESS_VITE_UPDATED</h1>" }));
    const runtime = new CompanyDelegationRuntime(store, engine(chat, { mode: "pipeline", agentIds: [designer.id, reviewer.id], toolRequests: reads }), 5_000,
      { execute } as unknown as import("../apps/agent-api/src/company-tool-runtime").CompanyToolExecutor);
    const result = await runtime.execute(auth, company.id, { task: "Two-point accessibility review of STRESS_VITE_UPDATED", mode: "pipeline", projectId: "vite-1" }, "a041-run-" + tools.length);
    expect(result.run.status).toBe("completed");
    expect(JSON.stringify(chat.mock.calls).includes("no project source or data was read in this run")).toBe(noted);
    expect((await store.getCompanyAgent(auth, company.id, designer.id)).tools).toEqual([...tools]);
  });
});

describe("A086: a memory change reaches the record the request names, not a copied sibling ID", () => {
  const setup = async () => {
    const { WorkspaceChatActions } = await import("../apps/agent-api/src/workspace-chat-actions");
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(auth, { name: "Stress S14A Business" } as never, "a086-business");
    const recipe = await store.createMemory(auth, business.id, { type: "fact", title: "Stress S14A Recipe", content: "RECIPE_LIME_731" } as never);
    const delivery = await store.createMemory(auth, business.id, { type: "fact", title: "Stress S14A Delivery", content: "PICKUP_ORANGE_734" } as never);
    const run = (memoryId: string, requestMessage: string) => WorkspaceChatActions.extractAndExecute(auth,
      "```workspace-action\n" + JSON.stringify({ action: "memory.delete", businessId: business.id, memoryId }) + "\n```", { store } as never, "a086-" + memoryId, { requestMessage });
    return { store, business, recipe, delivery, run };
  };
  it("refuses to delete the sibling the model picked and keeps both records", async () => {
    const f = await setup();
    const result = await f.run(f.recipe.id, "Видали лише пам'ять «Stress S14A Delivery» бізнесу «Stress S14A Business». Залиш запис рецепта.");
    expect(result.workspaceAction).toBeUndefined();
    expect((await f.store.listMemory(auth, f.business.id)).map(item => item.title).sort()).toEqual(["Stress S14A Delivery", "Stress S14A Recipe"]);
  });
  it("deletes exactly the named record", async () => {
    const f = await setup();
    const result = await f.run(f.delivery.id, "Видали лише пам'ять «Stress S14A Delivery» бізнесу «Stress S14A Business». Залиш запис рецепта.");
    expect(result.workspaceAction).toMatchObject({ action: "memory.delete", resourceId: f.delivery.id });
    expect((await f.store.listMemory(auth, f.business.id)).map(item => item.title)).toEqual(["Stress S14A Recipe"]);
  });
});

describe("A095: the company-action context includes a named company beyond the first page", () => {
  it("lists the named 40th company among the owned records", async () => {
    const { CompanyChatActions } = await import("../apps/agent-api/src/company-chat-actions");
    const store = new InMemoryWorkspaceStore();
    for (let i = 0; i < 40; i++) await store.createCompany(auth, { name: `Filler ${String(i).padStart(3, "0")}` }, `a095-filler-${i}`);
    const boundary = Date.now(); while (Date.now() <= boundary) await new Promise(resolve => setTimeout(resolve, 1)); // strictly newer than every filler
    const studio = await store.createCompany(auth, { name: "Stress S14A Studio" }, "a095-studio");
    const prompt = await CompanyChatActions.buildSystemPrompt(auth, store, 'Delete only test company "Stress S14A Studio" through the normal approval flow.');
    expect(prompt).toContain(studio.id);
    const unrelated = await CompanyChatActions.buildSystemPrompt(auth, store, "List my companies.");
    expect(unrelated).not.toContain(studio.id);
  });
});

describe("A077: the router sees every owned company the message names", () => {
  it("passes a company past the first 100 to the classifier as mentionedCompanies", async () => {
    const store = new InMemoryWorkspaceStore();
    for (let i = 0; i < 105; i++) await store.createCompany(auth, { name: `Filler ${String(i).padStart(3, "0")}` }, `a077-filler-${i}`);
    await new Promise(resolve => setTimeout(resolve, 5)); // strictly newer than every filler, so it is past the first page
    await store.createCompany(auth, { name: "Stress S14A Bakery" }, "a077-bakery");
    const classified: string[] = [];
    const ai = { supportsNativeTools: () => true,
      chat: async (r: ChatRequest): Promise<ChatResult> => { const text = JSON.stringify(r.messages); if (String(r.messages[0]?.content).startsWith("Classify")) { classified.push(text); return { content: JSON.stringify({ intent: "CHAT", confidence: .99, targets: [], coreCapability: null }) }; } return { content: "ok" }; },
      async *stream() { yield "ok"; }, listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }) } as unknown as AIEngine;
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace: { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace });
    try {
      await app.inject({ method: "POST", url: "/chat", payload: { message: 'Run "Stress S14A Weekly Revised" manually once for "Stress S14A Bakery" and inspect its execution history.', contextType: "none" } });
      expect(classified.join("\n")).toMatch(/mentionedCompanies[^\]]*Stress S14A Bakery/);
    } finally { await app.close(); }
  });
});

describe("P025: a passing model-run verification in a no-change run is the run's verification summary", () => {
  it("states the executed checks instead of leaving the run without verification", async () => {
    const { CodingAgentReviewCoordinator } = await import("../apps/agent-api/src/coding-agent-review-coordinator");
    const summary: Record<string, unknown> = {};
    const coordinator = new CodingAgentReviewCoordinator({ input: { verificationTools: ["typecheck", "test"] }, ports: { toolRuntime: { verificationRevision: async () => "rev-1" } },
      summary, ctx: auth, companyId: "c", projectId: "p", sessionId: "s" } as never);
    await coordinator.onVerifyToolExecuted(await coordinator.readVerificationRevision(),
      { ok: true, tool: "code.verify.run", result: { kind: "code_tool_result", data: { checks: [{ tool: "typecheck", ok: true }, { tool: "test", ok: true }] } } } as never);
    expect(summary.verification).toMatchObject({ status: "passed", executedTools: ["typecheck", "test"] });
  });
  it("records nothing for a failing check", async () => {
    const { CodingAgentReviewCoordinator } = await import("../apps/agent-api/src/coding-agent-review-coordinator");
    const summary: Record<string, unknown> = {};
    const coordinator = new CodingAgentReviewCoordinator({ input: { verificationTools: ["typecheck", "test"] }, ports: { toolRuntime: { verificationRevision: async () => "rev-1" } },
      summary, ctx: auth, companyId: "c", projectId: "p", sessionId: "s" } as never);
    await coordinator.onVerifyToolExecuted("rev-1", { ok: true, tool: "code.verify.run", result: { kind: "code_tool_result", data: { checks: [{ tool: "typecheck", ok: true }, { tool: "test", ok: false }] } } } as never);
    expect(summary.verification).toBeUndefined();
  });
});

describe("P035: one chat request creating a site, a game and a mobile app keeps its semantic decision", () => {
  const message = "У тестовій компанії «Stress S14A Universal» в цьому чаті створи три окремі Projects: HTML сайт «V3 Switch Site» з V3_SWITCH_SITE, JavaScript Snake «V3 Switch Game», Expo список «V3 Switch Mobile». Збережи три різні Project IDs і правильні типи.";
  const target = (name: string, kind: string, framework: string) => ({ name, kind, framework, reason: "Requested by the user", criteria: ["explicit_request"] });
  const resolver = async (targets: unknown[]) => {
    const { createChatProjectIntentResolver } = await import("../apps/agent-api/src/chat-project-intent");
    const log = { warn: vi.fn() };
    const chat = vi.fn(async () => ({ content: JSON.stringify({ intent: "CREATE_PROJECT", confidence: 0.97, targets, coreCapability: null }) } as ChatResult));
    return { log, resolve: createChatProjectIntentResolver({ engine: { chat }, getAIContext: async () => ({ model: "selected-model" }), log } as never) };
  };
  it("accepts three targets with their own frameworks instead of falling back into the active project", async () => {
    const f = await resolver([target("V3 Switch Site", "website", "HTML/CSS"), target("V3 Switch Game", "game", "HTML/CSS"), target("V3 Switch Mobile", "mobile_app", "Expo")]);
    const result = await f.resolve(auth, { message, activeCompanyId: "owned-company", activeProjectId: "fastapi-project" } as never);
    expect(result).toMatchObject({ source: "semantic", targets: [{ name: "V3 Switch Site" }, { name: "V3 Switch Game" }, { name: "V3 Switch Mobile" }] });
    expect(f.log.warn).not.toHaveBeenCalled();
  });
  it("still binds a single target to the one framework the message names", async () => {
    const f = await resolver([target("Mobile", "website", "HTML/CSS")]);
    const result = await f.resolve(auth, { message: "Створи Expo застосунок «Mobile».", activeCompanyId: "owned-company" } as never);
    expect(result.source).not.toBe("semantic");
  });
});

describe("A018: a draft without an explicit sender uses the company's only mailbox", () => {
  const compose = (companyId: string, extra: Record<string, unknown> = {}) => "```email-action\n" + JSON.stringify({ action: "inbox.compose", companyId, ...extra,
    fields: { toAddresses: ["receiver@npati.test"], subject: "STRESS_ORDER_731", bodyText: "Please reserve one loaf. TEST ONLY.", isDraft: true } }) + "\n```";
  it("saves the draft from the single account and never from another company's mailbox", async () => {
    const store = new InMemoryWorkspaceStore();
    const repo = new EmailInboxRepository();
    const bakery = await store.createCompany(auth, { name: "Stress S14A Bakery" }, "a018-bakery");
    const other = await store.createCompany(auth, { name: "Stress S14A Studio" }, "a018-studio");
    await repo.createAccount(auth, bakery.id, { emailAddress: "stress-s14a@npati.test", testMode: true } as never);
    await repo.createAccount(auth, other.id, { emailAddress: "studio@npati.test", testMode: true } as never);
    const result = await EmailChatActions.extractAndExecute(auth, compose(bakery.id), store, repo, { requestMessage: 'In company "Stress S14A Bakery", save an email DRAFT, subject STRESS_ORDER_731. Do not send yet.' });
    expect(result.emailAction).toMatchObject({ action: "inbox.compose", companyId: bakery.id });
    expect((await repo.listThreads(auth, bakery.id, { limit: 10 })).map(thread => thread.subject)).toEqual(["STRESS_ORDER_731"]);
    expect(await repo.listThreads(auth, other.id, { limit: 10 })).toEqual([]);
  });
  it("still requires a named sender when the company has several mailboxes", async () => {
    const store = new InMemoryWorkspaceStore();
    const repo = new EmailInboxRepository();
    const bakery = await store.createCompany(auth, { name: "Stress S14A Bakery" }, "a018-bakery-2");
    await repo.createAccount(auth, bakery.id, { emailAddress: "one@npati.test", testMode: true } as never);
    await repo.createAccount(auth, bakery.id, { emailAddress: "two@npati.test", testMode: true } as never);
    const result = await EmailChatActions.extractAndExecute(auth, compose(bakery.id), store, repo, { requestMessage: "Save a draft STRESS_ORDER_731." });
    expect(result.emailAction).toBeUndefined();
    expect(await repo.listThreads(auth, bakery.id, { limit: 10 })).toEqual([]);
  });
});

describe("A038: the native email tool's contactEmail reaches the contact executor", () => {
  it("blacklists the referenced contact named in contactEmail, unmasking the EMAIL_REF", async () => {
    const store = new InMemoryWorkspaceStore();
    const repo = new EmailInboxRepository();
    const bakery = await store.createCompany(auth, { name: "Stress S14A Bakery" }, "a038-bakery");
    const directive = "```email-action\n" + JSON.stringify({ action: "contact.upsert", companyId: bakery.id, contactEmail: "EMAIL_REF_x_1", fields: { name: "Stress Spammer", isBlacklisted: true } }) + "\n```";
    const result = await EmailChatActions.extractAndExecute(auth, directive, store, repo, { requestMessage: 'In company "Stress S14A Bakery", mark test contact EMAIL_REF_x_1 as blacklisted.', addressReferences: { EMAIL_REF_x_1: "spammer@npati.test" } });
    expect(result.emailAction).toMatchObject({ action: "contact.upsert" });
    expect((await repo.listContacts(auth, bakery.id)).map(c => ({ email: c.email, blacklisted: c.isBlacklisted }))).toEqual([{ email: "spammer@npati.test", blacklisted: true }]);
  });
});

describe("P037: a project named only to be preserved is not the edit target", () => {
  const setup = async () => {
    const { ActiveContextResolver } = await import("../apps/agent-api/src/active-context-resolver");
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "Stress S14A Universal" }, "p037-company");
    const ids: Record<string, string> = {};
    for (const name of ["V3 Switch Site", "V3 Switch Game", "V3 Switch Mobile"]) ids[name] = (await store.createProject(auth, company.id, { name, type: "code_project" }, "p037-" + name)).project.id;
    const resolver = new ActiveContextResolver(store);
    const current = await resolver.resolve(auth, { contextType: "company", companyId: company.id });
    return { resolver, current, ids };
  };
  it("switches to the game the request edits while it preserves the site", async () => {
    const f = await setup();
    const resolved = await f.resolver.resolveNamedCompany(auth, f.current, "Тепер до «V3 Switch Game» додай бонусну їжу з 5 очками. Перевір гру; сайт «V3 Switch Site» та mobile не змінюй.", { intent: "EDIT_WEBSITE" } as never);
    expect(resolved?.context.projectId).toBe(f.ids["V3 Switch Game"]);
  });
  it("still refuses a request that edits two named projects", async () => {
    const f = await setup();
    await expect(f.resolver.resolveNamedCompany(auth, f.current, "Додай футер до «V3 Switch Game» і до «V3 Switch Site».", { intent: "EDIT_WEBSITE" } as never)).rejects.toThrow(/More than one owned project/);
  });
});

describe("P040: deleting an exactly named Project while preserving others takes the confirmed deletion flow", () => {
  const message = "Видали лише спеціальний тестовий «V3 Switch Game» через штатне підтвердження. Перед видаленням попроси точне підтвердження; збережи «V3 Switch Site», «V3 Switch Mobile», їхні файли й БД.";
  const names = ["V3 Switch Site", "V3 Switch Game", "V3 Switch Mobile"];
  it("recognizes the request by the owned name and ignores parts named in the preserve clause", async () => {
    const { isProjectDeleteRequest, projectDeleteTarget } = await import("../apps/agent-api/src/chat-project-delete");
    expect(isProjectDeleteRequest(message, names)).toBe(true);
    expect(projectDeleteTarget(names.map((name, i) => ({ id: "p" + i, name })), message)?.name).toBe("V3 Switch Game");
    expect(isProjectDeleteRequest(message)).toBe(false);
    expect(isProjectDeleteRequest("Видали файл index.html з «V3 Switch Game».", names)).toBe(false);
  });
});
