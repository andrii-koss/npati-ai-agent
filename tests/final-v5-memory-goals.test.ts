import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CompanyChatActions } from "../apps/agent-api/src/company-chat-actions";
import { WorkspaceChatActions } from "../apps/agent-api/src/workspace-chat-actions";
import { goalContextBusinesses, goalScopeNote } from "../apps/agent-api/src/business-action-handler";

const alice: AuthContext = { userId: "alice", workspaceId: "shared", permissions: ["workspace:read", "business:manage"] };
const directive = (value: object) => `Done.\n\n\`\`\`company-action\n${JSON.stringify(value)}\n\`\`\``;
const resources = { automations: { list: async () => [] }, content: { list: async () => ({}) } } as never;

describe("Final V5 stage 11: goals, memory and company scope", () => {
  it("V5-D62: a replayed create of another existing company does not rewrite its agents", async () => {
    const store = new InMemoryWorkspaceStore();
    const beta = await store.createCompany(alice, { name: "Beta Service" }, "beta");
    const manager = await store.createCompanyAgent(alice, beta.id, { name: "Beta Manager", role: "Main agent", description: "Answers customers" }, "manager");
    const result = await CompanyChatActions.extractAndExecute(alice, directive({ action: "create", fields: { name: "Beta Service" },
      agents: [{ action: "create", fields: { name: "Beta Manager", role: "Головний агент", description: "Invented description" }, main: true }] }),
    store, "goal-turn", { requestMessage: "Assign the goal «Sales» to the agent «Alpha Analyst»." });
    expect(result.companyAction).toBeUndefined();
    const agent = (await store.listCompanyAgents(alice, beta.id)).find((item) => item.id === manager.id)!;
    expect([agent.role, agent.description]).toEqual(["Main agent", "Answers customers"]);
    // Naming the existing company keeps the earlier "create means update" behaviour.
    const named = await CompanyChatActions.extractAndExecute(alice, directive({ action: "create", fields: { name: "Beta Service", industry: "IT" } }),
      store, "named-turn", { requestMessage: "Create the company «Beta Service» in IT" });
    expect(named.companyAction?.companyId).toBe(beta.id);
  });

  it("V5-D61: a semantically routed Memory recall without the word memory receives the Business Memory", async () => {
    const store = new InMemoryWorkspaceStore();
    const bakery = await store.createBusiness(alice, { name: "Alpha Bakery" });
    await store.createMemory(alice, bakery.id, { type: "business_fact", title: "Flour supplier", content: "Supplier code MLN2_TEST", confidence: 1, source: "user" });
    const message = "Який код постачальника борошна ми зберегли для «Alpha Bakery»?";
    expect(await WorkspaceChatActions.buildSystemPrompt(alice, store, message, undefined, undefined, resources)).toBe("");
    expect(await WorkspaceChatActions.buildSystemPrompt(alice, store, message, undefined, undefined, { ...(resources as object), routed: true } as never)).toContain("MLN2_TEST");
  });

  it("V5-D64: goals in the prompt follow the named, then the selected company's Business", () => {
    const businesses = [{ id: "a", name: "Alpha Bakery" }, { id: "b", name: "Beta Repair" }];
    expect(goalContextBusinesses(businesses, "Which goals does our business have?", "b").map((b) => b.id)).toEqual(["b"]);
    expect(goalContextBusinesses(businesses, "Which goals does «Alpha Bakery» have?", "b").map((b) => b.id)).toEqual(["a"]);
    expect(goalContextBusinesses(businesses, "List all goals", undefined).map((b) => b.id)).toEqual(["a", "b"]);
    // Hidden goals are counted, so the model does not claim that they were never saved.
    expect(goalScopeNote(0)).toBe("");
    expect(goalScopeNote(2)).toContain("2 goal(s) of other Businesses exist");
  });
});

describe("Final V5 stage 11: language of short Cyrillic questions", () => {
  it("V5-D66: Ukrainian questions without і/ї/є/ґ are not answered in Russian", async () => {
    const { detectCompanyChatLanguage } = await import("../apps/agent-api/src/company-chat-i18n");
    expect(detectCompanyChatLanguage("Який код постачальника борошна ми зберегли для «R118366 Пекарня»?")).toBe("uk");
    expect(detectCompanyChatLanguage("Какой код поставщика муки мы сохранили для «Пекарня»?")).toBe("ru");
    expect(detectCompanyChatLanguage("Какой код поставщика муки сохранили для пекарни?")).toBe("ru");
  });
});

describe("Final V5 stage 11: company ↔ business link", () => {
  it("V5-D65: a company is not linked to a similarly named Business the request did not name", async () => {
    const store = new InMemoryWorkspaceStore();
    const old = await store.createBusiness(alice, { name: "R1 Repair" });
    const wanted = await store.createBusiness(alice, { name: "R2 Repair" });
    const beta = await store.createCompany(alice, { name: "R2 Beta" }, "beta");
    const guess = await CompanyChatActions.extractAndExecute(alice, directive({ action: "update", companyId: beta.id, fields: { businessId: old.id } }),
      store, "link-turn", { requestMessage: "Create the Business Profile «R2 Repair» and link it to «R2 Beta»." });
    expect(guess.companyAction).toBeUndefined();
    expect((await store.getCompany(alice, beta.id)).businessId ?? null).toBeNull();
    const named = await CompanyChatActions.extractAndExecute(alice, directive({ action: "update", companyId: beta.id, fields: { businessId: wanted.id } }),
      store, "link-turn-2", { requestMessage: "Create the Business Profile «R2 Repair» and link it to «R2 Beta»." });
    expect(named.companyAction?.companyId).toBe(beta.id);
    expect((await store.getCompany(alice, beta.id)).businessId).toBe(wanted.id);
  });
});
