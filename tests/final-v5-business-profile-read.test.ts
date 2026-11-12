import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { ActiveContextResolver } from "../apps/agent-api/src/active-context-resolver";
import { executeChatEntityRead } from "../apps/agent-api/src/project-chat-cards";
import { createChatProjectIntentResolver } from "../apps/agent-api/src/chat-project-intent";
const auth: AuthContext = { workspaceId: "d102", userId: "owner", permissions: ["*", "workspace:read", "workspace:write", "business:manage"] };
const prompt = "Lies das Profil \"Profile Business\" und nenne dessen Markt und aktualisierte Zielgruppe. Keine Änderungen.";
async function fixture() {
 const store = new InMemoryWorkspaceStore();
 const business = await store.createBusiness(auth, { name: "Profile Business", businessStage: "operating", market: "Kyiv", country: "Ukraine",
  audienceSummary: "famílias locais e pequenos escritórios", productsServicesSummary: "sourdough bread and coffee" });
 await store.createBusiness(auth, { name: "Other Business", market: "Lviv", audienceSummary: "FOREIGN_AUDIENCE" });
 const resolved = await new ActiveContextResolver(store).resolve(auth, { contextType: "none", businessId: null, companyId: null });
 return { store, business, resolved };
}
describe("D102: Business Profile reads never claim stored facts are missing", () => {
 it("reads market and audience of the named Business from storage", async () => {
  const f = await fixture();
  const result = await executeChatEntityRead(f.store, auth, f.resolved, { field: "profile", entityType: "business" }, prompt);
  expect(result?.entityRead).toMatchObject({ entityType: "business", entityId: f.business.id, field: "profile", source: "workspace_store" });
  expect(result?.message).toContain("Markt: Kyiv"); expect(result?.message).toContain("Zielgruppe: famílias locais e pequenos escritórios");
  expect(result?.message).not.toContain("FOREIGN_AUDIENCE"); expect(result?.message).not.toContain("No stored value");
 });
 // Live V6 step 03: "яка ніша у бізнес-профілі V6TEST_Flowers?" got English labels and no niche.
 it("answers a profile question with every filled field, niche included, labelled in the user's language", async () => {
  const f = await fixture();
  await f.store.updateBusiness(auth, f.business.id, { niche: "Букети V6TEST_UI", industry: "Retail" });
  const result = await executeChatEntityRead(f.store, auth, f.resolved, { field: "profile", entityType: "business" }, "яка ніша у бізнес-профілі \"Profile Business\"? одним рядком");
  expect(result?.message).toContain("Ніша: Букети V6TEST_UI");
  expect(result?.message).toContain("Галузь: Retail");
  expect(result?.message).not.toMatch(/\b(?:Stage|Market|Name):/u);
 });
 it("falls through to the full chat path when a single empty Business field was chosen", async () => {
  const f = await fixture();
  expect(await executeChatEntityRead(f.store, auth, f.resolved, { field: "description", entityType: "business" }, prompt)).toBeNull();
 });
 it("still answers a stored Business description directly", async () => {
  const f = await fixture();
  await f.store.updateBusiness(auth, f.business.id, { description: "Neighbourhood bakery" });
  const result = await executeChatEntityRead(f.store, auth, f.resolved, { field: "description", entityType: "business" }, "Read the description of Business \"Profile Business\"");
  expect(result?.message).toBe("Neighbourhood bakery");
 });
 it("accepts the profile descriptor only for Business reads", async () => {
  const reply = (entityType: string) => vi.fn(async () => ({ content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [], entityRead: { field: "profile", entityType }, coreCapability: null, coreMutation: false }) }));
  const resolve = (chat: ReturnType<typeof reply>) => createChatProjectIntentResolver({ engine: { chat }, getAIContext: async () => ({}), log: { warn: vi.fn() } });
  expect((await resolve(reply("business"))(auth, { message: prompt })).entityRead).toEqual({ field: "profile", entityType: "business" });
  expect((await resolve(reply("company"))(auth, { message: prompt })).entityRead).toBeUndefined();
 });
});
