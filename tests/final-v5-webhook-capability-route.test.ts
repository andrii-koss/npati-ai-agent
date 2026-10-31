import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { createChatProjectIntentResolver } from "../apps/agent-api/src/chat-project-intent";
import { WorkspaceChatActions } from "../apps/agent-api/src/workspace-chat-actions";
const auth: AuthContext = { workspaceId: "d103", userId: "owner", permissions: ["*", "workspace:read", "workspace:write", "business:manage"] };
const prompt = "Enable the test webhook \"Stress Hook\" in \"Stress Bakery\". Do not invoke it or expose its secret in chat.";
const companyRoute = vi.fn(async () => ({ content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [], entityRead: null, coreCapability: "npati_company_action", coreMutation: true, assignsWorkToCompanyAgent: false }) }));
const resolver = (namesOwnedWebhook?: () => Promise<boolean>) => createChatProjectIntentResolver({ engine: { chat: companyRoute }, getAIContext: async () => ({}), log: { warn: vi.fn() }, ...(namesOwnedWebhook ? { namesOwnedWebhook } : {}) });
async function webhookFixture() {
 const store = new InMemoryWorkspaceStore();
 const company = await store.createCompany(auth, { name: "Stress Bakery" }, "bakery");
 const listWebhooks = vi.fn(async (_auth: AuthContext, companyId: string) => companyId === company.id ? [{ name: "Stress Hook" }] : []);
 return { store, webhooks: { listWebhooks, createWebhook: vi.fn(), deleteWebhook: vi.fn(), setWebhookActive: vi.fn() } as never };
}
describe("D103: an owned webhook stays reachable when the Company tool is chosen", () => {
 it("routes a change of a named existing webhook to the workspace tool, keeping the Company tool", async () => {
  const result = await resolver(async () => true)(auth, { message: prompt, activeCompanyId: "bakery", focusedEntityType: "company" });
  expect(result.coreCapability).toBe("npati_workspace_action");
  expect(result.coreRoute).toMatchObject({ capability: "npati_workspace_action", also: ["npati_company_action"], mutation: true });
 });
 it("keeps the Company tool when no existing webhook is named (for example granting an agent the Webhooks capability)", async () => {
  const result = await resolver(async () => false)(auth, { message: "Give agent Ira the Webhooks capability in \"Stress Bakery\"", activeCompanyId: "bakery" });
  expect(result.coreRoute).toMatchObject({ capability: "npati_company_action", mutation: true });
  expect(result.coreRoute?.also ?? []).not.toContain("npati_workspace_action");
 });
 it("matches only the exact name of the user's own webhook", async () => {
  const f = await webhookFixture();
  expect(await WorkspaceChatActions.namesOwnedWebhook(auth, f.store, prompt, f.webhooks)).toBe(true);
  expect(await WorkspaceChatActions.namesOwnedWebhook(auth, f.store, "Enable the webhook \"Stress Hooks Archive\"", f.webhooks)).toBe(false);
  expect(await WorkspaceChatActions.namesOwnedWebhook(auth, f.store, "Give agent Ira the Webhooks capability", f.webhooks)).toBe(false);
  expect(await WorkspaceChatActions.namesOwnedWebhook({ ...auth, permissions: ["workspace:read"] }, f.store, prompt, f.webhooks)).toBe(false);
 });
});
