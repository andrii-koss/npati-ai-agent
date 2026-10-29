import { expect, it } from "vitest";
import type { OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";

const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
const user = (id: string): AuthContext => ({ userId: id, workspaceId: "open-workspace", permissions: ["workspace:read", "workspace:write", "business:manage"] });

it("opens a chat with one request: latest messages, the selected company, the first sidebar page", async () => {
  const store = new InMemoryWorkspaceStore();
  const alice = user("alice"), bob = user("bob");
  const companies = [];
  for (let index = 0; index < 5; index += 1) companies.push(await store.createCompany(alice, { name: `Open Co ${index}` }, `open-${index}`));
  const chat = await store.createNeutralConversation(alice, "Long chat");
  for (let index = 0; index < 25; index += 1) await store.appendNeutralMessage(alice, chat.id, index % 2 ? "assistant" : "user", `Message ${index}`);
  for (let index = 0; index < 24; index += 1) await store.createNeutralConversation(alice, `Other ${index}`);
  const foreign = await store.createNeutralConversation(bob, "Bob private");
  let current = alice;
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => current }, marketplace });
  try {
    const opened = (await app.inject({ method: "GET", url: `/chat/open?conversationId=${chat.id}&companyId=${companies[2]!.id}` })).json() as {
      conversation: { id: string; title: string; messages: Array<{ content: string }>; earlier: number };
      company: { id: string; name: string }; chats: { items: Array<{ title: string }>; more: boolean }; processes: unknown[] };
    expect(opened.conversation.messages.map((message) => message.content)).toEqual(Array.from({ length: 10 }, (_, index) => `Message ${index + 15}`));
    expect(opened.conversation.earlier).toBe(15);
    expect(opened.company).toEqual({ id: companies[2]!.id, name: "Open Co 2" });
    expect(opened.chats.items).toHaveLength(20);
    expect(opened.chats.more).toBe(true);
    expect(JSON.stringify(opened)).not.toContain("Bob private");

    // The history cursor is the oldest loaded message id.
    const cursor = (opened.conversation as unknown as { cursor: string }).cursor;
    const byCursor = (await app.inject({ method: "GET", url: `/conversations/${chat.id}/messages?before=${cursor}` })).json() as { messages: Array<{ content: string }>; cursor: string; hasMore: boolean };
    expect(byCursor.messages.map((message) => message.content)).toEqual(Array.from({ length: 10 }, (_, index) => `Message ${index + 5}`));
    expect(byCursor.hasMore).toBe(true);
    const last = (await app.inject({ method: "GET", url: `/conversations/${chat.id}/messages?before=${byCursor.cursor}` })).json() as { messages: unknown[]; hasMore: boolean };
    expect(last.messages).toHaveLength(5);
    expect(last.hasMore).toBe(false);
    expect((await app.inject({ method: "GET", url: `/conversations/${chat.id}/messages?before=not-a-message` })).statusCode).toBe(400);
    const earlier = (await app.inject({ method: "GET", url: `/conversations/${chat.id}/messages?before=15` })).json() as { messages: Array<{ content: string }>; earlier: number };
    expect(earlier.messages.map((message) => message.content)).toEqual(Array.from({ length: 10 }, (_, index) => `Message ${index + 5}`));
    expect(earlier.earlier).toBe(5);

    const next = (await app.inject({ method: "GET", url: "/chat/sidebar?offset=20" })).json() as { items: unknown[]; more: boolean };
    expect(next.items).toHaveLength(5);
    expect(next.more).toBe(false);

    const foreignOpen = await app.inject({ method: "GET", url: `/chat/open?conversationId=${foreign.id}` });
    expect(foreignOpen.statusCode).toBe(200);
    expect(foreignOpen.json().conversation).toBeNull();
    expect(foreignOpen.body).not.toContain("Bob private");
    current = bob;
    expect((await app.inject({ method: "GET", url: `/chat/open?companyId=${companies[0]!.id}` })).json().company).toBeNull();
  } finally { await app.close(); }
});

it("orders the sidebar when the store returns Date timestamps, as PostgreSQL does", async () => {
  const store = new InMemoryWorkspaceStore();
  const alice = user("alice");
  const older = await store.createNeutralConversation(alice, "Older");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = await store.createNeutralConversation(alice, "Newer");
  const list = store.listNeutralConversations.bind(store);
  store.listNeutralConversations = async (context) => (await list(context)).map((row) => ({ ...row, updatedAt: new Date(row.updatedAt) as unknown as string }));
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => alice }, marketplace });
  try {
    const response = await app.inject({ method: "GET", url: "/chat/sidebar" });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { items: Array<{ id: string }> }).items.map((row) => row.id)).toEqual([newer.id, older.id]);
  } finally { await app.close(); }
});
