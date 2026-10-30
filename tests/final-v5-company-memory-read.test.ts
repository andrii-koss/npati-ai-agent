import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { ActiveContextResolver } from "../apps/agent-api/src/active-context-resolver";
import { executeChatEntityRead } from "../apps/agent-api/src/project-chat-cards";
import { createChatProjectIntentResolver } from "../apps/agent-api/src/chat-project-intent";
const auth: AuthContext = { workspaceId: "d101", userId: "owner", permissions: ["*", "workspace:read", "workspace:write", "business:manage"] };
async function fixture(empty = false) {
 const store = new InMemoryWorkspaceStore();
 const business = await store.createBusiness(auth, { name: "Other Business" });
 await store.createMemory(auth, business.id, { type: "business_fact", title: "Recipe", content: "FOREIGN_BUSINESS", confidence: 1, source: "user" });
 await store.createCompany(auth, { name: "Other Company", businessId: business.id, memory: { recipe: "FOREIGN_COMPANY" } }, "other");
 const company = await store.createCompany(auth, { name: "Selected Company", ...(!empty ? { companyInstructions: "OWN_INSTRUCTIONS", memory: { recipe: "OWN_V1" } } : {}) }, "selected");
 const resolved = await new ActiveContextResolver(store).resolve(auth, { contextType: "company", companyId: company.id, businessId: null });
 return { store, company, resolved };
}
describe("D101: authoritative own Company memory reads", () => {
 it("returns only persisted facts and instructions of the selected Company", async () => {
  const f = await fixture(), memories = vi.spyOn(f.store, "listMemory");
  const result = await executeChatEntityRead(f.store, auth, f.resolved, { field: "memory", entityType: "company" }, "Read this Company's own memory");
  expect(result?.entityRead).toMatchObject({ entityType: "company", companyId: f.company.id, field: "memory", source: "workspace_store" });
  expect(result?.message).toContain("OWN_INSTRUCTIONS"); expect(result?.message).toContain("OWN_V1");
  expect(result?.message).not.toContain("FOREIGN_"); expect(memories).not.toHaveBeenCalled();
 });
 it("reads fresh storage even when the resolved context predates an update", async () => {
  const f = await fixture();
  await f.store.updateCompany(auth, f.company.id, { memory: { recipe: "OWN_V2" }, companyInstructions: "CURRENT_INSTRUCTIONS" }, f.company.revision);
  const result = await executeChatEntityRead(f.store, auth, f.resolved, { field: "memory", entityType: "company" }, "Read this Company's own memory");
  expect(result?.message).toContain("OWN_V2"); expect(result?.message).not.toContain("OWN_V1"); expect(result?.message).toContain("CURRENT_INSTRUCTIONS");
 });
 it("returns an authoritative empty value without substituting another Business", async () => {
  const f = await fixture(true);
  const result = await executeChatEntityRead(f.store, auth, f.resolved, { field: "memory", entityType: "company" }, "Does this Company have its own recipe code?");
  expect(result?.entityRead?.companyId).toBe(f.company.id); expect(result?.message).toBe("No stored value is available for this field.");
 });
 it("honors no-memory mode before reading the Company record", async () => {
  const f = await fixture(), get = vi.spyOn(f.store, "getCompany");
  expect(await executeChatEntityRead(f.store, auth, f.resolved, { field: "memory", entityType: "company" }, "Read its memory", undefined, undefined, true)).toBeNull();
  expect(get).not.toHaveBeenCalled();
 });
 it("accepts the finite Company memory descriptor from native semantic classification", async () => {
  const chat = vi.fn(async () => ({ content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [], entityRead: { field: "memory", entityType: "company" }, coreCapability: "npati_company_action", coreMutation: false }) }));
  const resolve = createChatProjectIntentResolver({ engine: { chat }, getAIContext: async () => ({ model: "selected" }), log: { warn: vi.fn() } });
  expect(await resolve(auth, { message: "Read this Company's own memory", activeCompanyId: "selected", focusedEntityType: "company" })).toMatchObject({ entityRead: { field: "memory", entityType: "company" } });
  expect(chat).toHaveBeenCalledOnce();
 });
 it("keeps Business Memory on its native workspace path", async () => {
  const chat = vi.fn(async () => ({ content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [], entityRead: { field: "memory", entityType: "business" }, coreCapability: "npati_workspace_action", coreMutation: false }) }));
  const resolve = createChatProjectIntentResolver({ engine: { chat }, getAIContext: async () => ({}), log: { warn: vi.fn() } });
  const result = await resolve(auth, { message: "Read the named Business Profile memory", activeCompanyId: "selected" });
  expect(result.entityRead).toBeUndefined(); expect(result.coreCapability).toBe("npati_workspace_action");
 });
});

describe("D101: validated reads survive record guards", () => {
 it.each(["memory", "instructions", "agents"] as const)("preserves the %s read when an owned-record guard keeps the intent in CHAT", async field => {
  const chat = vi.fn(async () => ({ content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [], entityRead: { field, entityType: "company" }, coreCapability: "npati_company_action", coreMutation: false }) }));
  const resolve = createChatProjectIntentResolver({ engine: { chat }, getAIContext: async () => ({}), namesOwnedManagementRecord: async () => true, log: { warn: vi.fn() } });
  const result = await resolve(auth, { message: "Read the selected Company's persisted record", activeCompanyId: "selected", focusedEntityType: "company" });
  expect(result).toMatchObject({ source: "guard", decision: { intent: "CHAT" }, entityRead: { field, entityType: "company" } });
 });
 it("does not let an inconsistent read descriptor intercept a semantic mutation", async () => {
  const chat = vi.fn(async () => ({ content: JSON.stringify({ intent: "CHAT", confidence: 1, targets: [], entityRead: { field: "memory", entityType: "company" }, coreCapability: "npati_company_action", coreMutation: true }) }));
  const resolve = createChatProjectIntentResolver({ engine: { chat }, getAIContext: async () => ({}), log: { warn: vi.fn() } });
  const result = await resolve(auth, { message: "Save this fact for the selected Company", activeCompanyId: "selected" });
  expect(result.entityRead).toBeUndefined(); expect(result.coreRoute?.mutation).toBe(true);
 });
});
