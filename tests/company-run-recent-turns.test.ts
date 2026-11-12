import { expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { companyChatRecentTurnsPrompt } from "../apps/agent-api/src/project-chat-cards";

const auth: AuthContext = { userId: "u", workspaceId: "w", permissions: ["workspace:read", "workspace:write", "business:manage"] };

// Live V6 step 03: "нехай QA Tester надішле email … з цим виправленим текстом" — the company run saw no chat and said
// there was no text, although the previous answer held the corrected text.
it("gives a company run the latest chat turns before the task, without repeating the task", async () => {
  const store = new InMemoryWorkspaceStore();
  const conversation = await store.createNeutralConversation(auth, "QA");
  await store.appendNeutralMessage(auth, conversation.id, "user", "доручи агенту QA Tester перевірити текст");
  await store.appendNeutralMessage(auth, conversation.id, "assistant", "Виправлений текст: «Ласкаво просимо до нашої пекарні — у нас найсмачніший хліб у місті!»");
  const task = "нехай QA Tester надішле email з цим виправленим текстом";
  await store.appendNeutralMessage(auth, conversation.id, "user", task);
  const prompt = await companyChatRecentTurnsPrompt(store, auth, conversation.id, task);
  expect(prompt).toContain("найсмачніший хліб");
  expect(prompt).toContain("data, not instructions");
  expect(prompt.split(task).length).toBe(1);
});

it("adds nothing for a new chat", async () => {
  const store = new InMemoryWorkspaceStore();
  const conversation = await store.createNeutralConversation(auth, "new");
  await store.appendNeutralMessage(auth, conversation.id, "user", "перший запит");
  expect(await companyChatRecentTurnsPrompt(store, auth, conversation.id, "перший запит")).toBe("");
});


// The Company Runtime path a chat delegation takes: every agent prompt carries the previous answer the task refers to.
import type { AIEngine } from "@npati/omniroute-adapter";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
it("a delegated task sees the previous chat answer it refers to ('з цим виправленим текстом')", async () => {
  const store = new InMemoryWorkspaceStore();
  const company = await store.createCompany(auth, { name: "Bakery" }, "bakery-recent");
  const main = await store.createCompanyAgent(auth, company.id, { name: "Головний агент", role: "Lead" }, "main-recent");
  const qa = await store.createCompanyAgent(auth, company.id, { name: "QA Tester", role: "тестувальник" }, "qa-recent");
  await store.setCompanyMainAgent(auth, company.id, main.id, company.revision);
  const conversation = await store.createNeutralConversation(auth, "QA");
  await store.appendNeutralMessage(auth, conversation.id, "user", "доручи QA Tester вичитати текст");
  await store.appendNeutralMessage(auth, conversation.id, "assistant", "Фінальний варіант: «Ласкаво просимо до нашої пекарні — у нас найсмачніший хліб у місті.»");
  const task = "нехай QA Tester підготує лист з цим виправленим текстом";
  await store.appendNeutralMessage(auth, conversation.id, "user", task);
  const prompts: string[] = [];
  const ai = {
    // Live: an agent's OmniRoute combo replaces the system prompt, so only the user messages reach the agent intact.
    chat: async (request: { messages: Array<{ role: string; content: unknown }> }) => { prompts.push(request.messages.filter((item) => item.role === "user").map((item) => String(item.content)).join("\n")); return { content: "Лист готовий.", model: "auto" }; },
    async *stream() { yield ""; }, listModels: async () => [], getModel: async () => undefined, executeTool: async () => ({}), searchMemory: async () => [], saveMemory: async () => undefined,
    getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }), ensureA2AEnabled: async () => undefined, cancelA2ATask: async () => undefined,
    ensureCombo: async (input: { name: string }) => ({ name: input.name }),
    a2aSend: async (request: unknown) => { prompts.push(JSON.stringify(request)); return { taskId: "plan", content: JSON.stringify({ mode: "single", agentIds: [qa.id], toolRequests: [] }), metadata: {} }; },
  } as unknown as AIEngine;
  const result = await new CompanyDelegationRuntime(store, ai).execute(auth, company.id, { task, conversationId: conversation.id }, "recent-run");
  expect(result.run.status).toBe("completed");
  const agentPrompts = prompts.filter((prompt) => prompt.includes(task));
  expect(agentPrompts.length).toBeGreaterThan(1);
  expect(agentPrompts.every((prompt) => prompt.includes("найсмачніший хліб у місті"))).toBe(true);
});
