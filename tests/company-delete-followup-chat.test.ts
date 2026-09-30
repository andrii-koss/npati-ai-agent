import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { buildApp } from "../apps/agent-api/src/app";
import { pendingCompanyDelete } from "../apps/agent-api/src/pending-company-delete";
import { companyDeleteCopy } from "../apps/agent-api/src/company-delete-i18n";
import { CompanyChatActions } from "../apps/agent-api/src/company-chat-actions";

const auth: AuthContext = { userId: "delete-followup-user", workspaceId: "delete-followup-workspace", permissions: ["workspace:read", "workspace:write", "business:manage"] };
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;

function result(body: string): Record<string, any> {
  const block = body.split("\n\n").find((part) => part.includes("event: result"));
  const data = block?.split("\n").find((line) => line.startsWith("data: "));
  return data ? JSON.parse(data.slice(6)) : {};
}

describe("company deletion confirmation through production chat", () => {
  it("deletes the exact company after a short yes even if the next request has no selected company", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "NovaScale Labs" }, "confirmation-company");
    const conversation = await store.createNeutralConversation(auth, "Delete NovaScale Labs");
    let modelCalls = 0;
    const ai: AIEngine = {
      chat: async () => { modelCalls++; throw new Error("A confirmed delete must not call the model"); },
      async *stream() { modelCalls++; throw new Error("A confirmed delete must not stream the model"); },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "streaming"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const question = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "It's a good time now to delete the company you created.", conversationId: conversation.id, contextType: "company", companyId: company.id } });
      expect(question.statusCode).toBe(200);
      expect(result(question.body).message).toContain("Do you want to delete the selected company **NovaScale Labs**?");
      expect((await store.listCompanies(auth)).items).toHaveLength(1);
      const confirmed = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "yes", conversationId: conversation.id, contextType: "none" } });
      expect(confirmed.statusCode).toBe(200);
      expect(result(confirmed.body).companyAction).toMatchObject({ action: "delete", companyId: company.id });
      expect(result(confirmed.body).message).toContain("NovaScale Labs");
      expect((await store.listCompanies(auth)).items).toHaveLength(0);
      expect(modelCalls).toBe(0);
    } finally { await app.close(); }
  });

  it("updates only the requested company field through native chat tools", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "NovaScale Labs", industry: "AI Automation", website: "https://old.example" }, "update-company");
    let toolCalls = 0;
    const ai: AIEngine = {
      supportsNativeTools: () => true,
      async chat(request) {
        if (!request.tools?.length) return { content: "" };
        if (request.messages.at(-1)?.role === "tool") return { content: "The company website was updated." };
        toolCalls++;
        return { content: "", toolCalls: [{ id: "update-company-website", type: "function", function: { name: "npati_company_action", arguments: JSON.stringify({ action: "update", companyId: company.id, fields: { website: "https://new.example" } }) } }] };
      },
      async *stream() { throw new Error("Native company update must not use the legacy stream"); },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Change NovaScale Labs company website to https://new.example", contextType: "company", companyId: company.id } });
      expect(response.statusCode).toBe(200);
      expect(result(response.body).companyAction).toMatchObject({ action: "update", companyId: company.id });
      expect(toolCalls).toBe(1);
      expect(await store.getCompany(auth, company.id)).toMatchObject({ name: "NovaScale Labs", industry: "AI Automation", website: "https://new.example" });
      expect((await store.listCompanies(auth)).items).toHaveLength(1);
    } finally { await app.close(); }
  });
  it("executes a native delete tool call that identifies the company by name", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "NovaScale Labs" }, "native-delete-by-name");
    const ai: AIEngine = {
      supportsNativeTools: () => true,
      async chat(request) {
        if (request.messages.at(-1)?.role === "tool") return { content: "The company was deleted." };
        return { content: "", toolCalls: [{ id: "delete-company-by-name", type: "function", function: { name: "npati_company_action", arguments: JSON.stringify({ action: "delete", companyName: "NovaScale Labs" }) } }] };
      },
      async *stream() { throw new Error("Native delete must not stream a legacy answer"); },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "Yes, delete company NovaScale Labs", contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(result(response.body).companyAction).toMatchObject({ action: "delete", companyId: company.id });
      expect((await store.listCompanies(auth)).items).toHaveLength(0);
    } finally { await app.close(); }
  });
  it("deletes after yes when the prior confirmation was phrased by the model", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "NovaScale Labs" }, "model-confirmation-company");
    const conversation = await store.createNeutralConversation(auth, "Delete company");
    await store.appendNeutralMessage(auth, conversation.id, "assistant", "Do you want to delete NovaScale Labs? Reply yes to confirm.");
    const ai: AIEngine = {
      supportsNativeTools: () => true,
      async chat(request) {
        if (request.messages.at(-1)?.role === "tool") return { content: "The company was deleted." };
        return { content: "", toolCalls: [{ id: "confirmed-company-delete", type: "function", function: { name: "npati_company_action", arguments: JSON.stringify({ action: "delete", companyName: "NovaScale Labs" }) } }] };
      },
      async *stream() { throw new Error("Confirmed native delete must not use the legacy stream"); },
      listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
      searchMemory: async () => [], saveMemory: async () => undefined,
      getCapabilities: async () => ["chat", "native_tools"], healthCheck: async () => ({ status: "ok" }),
    };
    const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => auth }, aiEngine: ai, marketplace });
    try {
      const response = await app.inject({ method: "POST", url: "/chat/stream", payload: { message: "yes", conversationId: conversation.id, contextType: "none" } });
      expect(response.statusCode).toBe(200);
      expect(result(response.body).companyAction).toMatchObject({ action: "delete", companyId: company.id });
      expect((await store.listCompanies(auth)).items).toHaveLength(0);
    } finally { await app.close(); }
  });
  it("recognizes server-issued company deletion questions in all 16 languages", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "NovaScale Labs" }, "localized-company");
    const languages = ["en", "uk", "fr", "de", "es", "it", "pl", "pt", "nl", "tr", "ru", "zh", "ja", "ko", "ar", "hi"] as const;
    for (const language of languages) {
      const question = companyDeleteCopy(language, company.name).selected;
      expect((await pendingCompanyDelete(store, auth, question))?.id, language).toBe(company.id);
    }
  });
  it("deletes by companyName without treating the locator as an edit", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "NovaScale Labs" }, "delete-by-name");
    const directive = `\`\`\`company-action\n${JSON.stringify({ action: "delete", companyName: "NovaScale Labs" })}\n\`\`\``;
    const executed = await CompanyChatActions.extractAndExecute(auth, directive, store, "delete-by-name-chat", { requestMessage: "Yes, delete company NovaScale Labs" });
    expect(executed.companyAction).toMatchObject({ action: "delete", companyId: company.id });
    expect((await store.listCompanies(auth)).items).toHaveLength(0);
  });
  it("accepts common model delete target shapes without interpreting the name as an edit", async () => {
    for (const target of [{ name: "NovaScale Labs" }, { fields: { name: "NovaScale Labs" } }, { company: { name: "NovaScale Labs" } }]) {
      const store = new InMemoryWorkspaceStore();
      const company = await store.createCompany(auth, { name: "NovaScale Labs" }, "delete-target-shape-" + Object.keys(target)[0]);
      const directive = `\`\`\`company-action\n${JSON.stringify({ action: "delete", ...target })}\n\`\`\``;
      const executed = await CompanyChatActions.extractAndExecute(auth, directive, store, "delete-target-shape-chat", { requestMessage: "Yes, delete company NovaScale Labs" });
      expect(executed.companyAction, JSON.stringify(target)).toMatchObject({ action: "delete", companyId: company.id });
      expect((await store.listCompanies(auth)).items).toHaveLength(0);
    }
  });
  it("uses companyName as an update locator without changing the name", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "NovaScale Labs", website: "https://old.example" }, "update-by-name");
    const directive = `\`\`\`company-action\n${JSON.stringify({ action: "update", companyName: "NovaScale Labs", fields: { website: "https://new.example" } })}\n\`\`\``;
    const executed = await CompanyChatActions.extractAndExecute(auth, directive, store, "update-by-name-chat", { requestMessage: "Change the NovaScale Labs website" });
    expect(executed.companyAction).toMatchObject({ action: "update", companyId: company.id });
    expect(await store.getCompany(auth, company.id)).toMatchObject({ name: "NovaScale Labs", website: "https://new.example" });
  });
  it("does not infer deletion from an unrelated assistant message", async () => {
    const store = new InMemoryWorkspaceStore();
    await store.createCompany(auth, { name: "NovaScale Labs" }, "unrelated-company");
    expect(await pendingCompanyDelete(store, auth, "Sure, delete NovaScale Labs next time.")).toBeUndefined();
  });
});
