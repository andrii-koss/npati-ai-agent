import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { registerConversationImportRoute } from "../apps/agent-api/src/conversation-import-route";

const context: AuthContext = { userId: "importer", workspaceId: "workspace", permissions: ["workspace:read", "workspace:write", "business:manage"] };
const payload = { title: "Український чат", messages: [{ role: "user", content: "Привіт" }, { role: "assistant", content: "Вітаю" }] };

it("imports an independent chat with the current owner and ordered messages", async () => {
  const store = new InMemoryWorkspaceStore();
  const existing = await store.createNeutralConversation(context, "Existing");
  const app = Fastify();
  registerConversationImportRoute(app, store, { authenticate: async () => context });
  try {
    const response = await app.inject({ method: "POST", url: "/conversations/import", payload });
    expect(response.statusCode).toBe(201);
    const imported = response.json();
    expect(imported.userId).toBe(context.userId);
    expect(imported.businessId).toBeNull();
    const history = await store.getNeutralConversation(context, imported.id);
    expect(history.messages.map(({ role, content }) => ({ role, content }))).toEqual(payload.messages);
    expect((await store.listNeutralConversations(context)).map(row => row.id)).toContain(existing.id);
    await expect(store.getNeutralConversation({ ...context, userId: "other" }, imported.id)).rejects.toThrow();
    const bad = await app.inject({ method: "POST", url: "/conversations/import", payload: { ...payload, messages: [{ role: "tool", content: "bad" }] } });
    expect(bad.statusCode).toBe(400);
    expect(await store.listNeutralConversations(context)).toHaveLength(2);
  } finally { await app.close(); }
});

it("removes an incomplete chat if saving a message fails", async () => {
  const store = new InMemoryWorkspaceStore();
  vi.spyOn(store, "appendNeutralMessage").mockRejectedValueOnce(new Error("Storage unavailable"));
  const app = Fastify();
  registerConversationImportRoute(app, store, { authenticate: async () => context });
  try {
    expect((await app.inject({ method: "POST", url: "/conversations/import", payload })).statusCode).toBe(500);
    expect(await store.listNeutralConversations(context)).toHaveLength(0);
  } finally { await app.close(); }
});
