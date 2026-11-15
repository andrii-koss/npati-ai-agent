import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { ActiveContextResolver } from "../apps/agent-api/src/active-context-resolver";
import { persistChatResultContext, readChatActiveContext, saveChatProjectCard, executeChatEntityRead } from "../apps/agent-api/src/project-chat-cards";
import { CompanyChatActions, isInformationalOrCapabilityQuery } from "../apps/agent-api/src/company-chat-actions";
import { WorkspaceChatActions } from "../apps/agent-api/src/workspace-chat-actions";

const auth: AuthContext = { userId: "entity-owner", workspaceId: "entity-workspace", permissions: ["workspace:read", "workspace:write", "business:manage"] };
async function fixture() {
  const store = new InMemoryWorkspaceStore();
  const a = await store.createCompany(auth, { name: "North Labs", description: "COMPANY_DESCRIPTION", companyInstructions: "Latest checkpoint: SEQUENCE_42" }, "north");
  const b = await store.createCompany(auth, { name: "South Labs" }, "south");
  await store.createProject(auth, a.id, { name: "North Portal", type: "code_project", description: "PROJECT_DESCRIPTION" }, "portal");
  const project = (await store.listProjects(auth, a.id))[0]!;
  const chat = await store.createNeutralConversation(auth, "Company work");
  const other = await store.createNeutralConversation(auth, "Independent chat");
  return { store, a, b, project, chat, other, resolver: new ActiveContextResolver(store) };
}
describe("confirmed conversation entity context", () => {
  it("distinguishes read questions with formatting clauses from a following real mutation", () => {
    for (const message of ["What fact did you remember for the company? Reply with the value only.", "Який факт ти запам'ятав для компанії? Назви лише значення.", "¿Cuál es su descripción? Sé breve."]) {
      expect(isInformationalOrCapabilityQuery(message)).toBe(true);
      expect(WorkspaceChatActions.isManagementRequest(message)).toBe(false);
    }
    expect(isInformationalOrCapabilityQuery('What companies exist? Create a company called "New Studio".')).toBe(false);
    expect(CompanyChatActions.isManagementRequest('What companies exist? Create a company called "New Studio".')).toBe(true);
    expect(WorkspaceChatActions.isManagementRequest('What automations exist? Run automation "Nightly" once.')).toBe(true);
  });
  it("reads the current typed record directly, preserving Company/Project/Agent distinctions and conversation ownership", async () => {
    const { store, a, project, chat, other, resolver } = await fixture();
    const lead = await store.createCompanyAgent(auth, a.id, { name: "Lead", role: "Coordinator", description: "AGENT_DESCRIPTION", tools: [] }, "entity-lead");
    await persistChatResultContext(store, auth, { conversationId: chat.id, companyAction: { action: "update", companyId: a.id } });
    for (let i = 0; i < 40; i++) await store.appendNeutralMessage(auth, chat.id, "assistant", "Old summary: the description is PROJECT_DESCRIPTION or AGENT_DESCRIPTION.");
    await store.updateCompany(auth, a.id, { description: "CURRENT_COMPANY_DESCRIPTION" }, a.revision);
    const companyContext = await resolver.resolve(auth, { contextType: "company", companyId: a.id });
    const confirmed = await readChatActiveContext(store, auth, chat.id);
    const read = await executeChatEntityRead(store, auth, companyContext, { field: "description", entityType: "focused" }, "What is its description?", chat.id, confirmed);
    expect(read).toMatchObject({ message: "CURRENT_COMPANY_DESCRIPTION", entityRead: { entityType: "company", entityId: a.id, field: "description", source: "workspace_store" } });
    expect((await executeChatEntityRead(store, auth, await resolver.resolve(auth, { contextType: "project", companyId: a.id, projectId: project.id }), { field: "description", entityType: "focused" }, "Its description?", chat.id, confirmed))?.message).toBe("PROJECT_DESCRIPTION");
    const agentRead = await executeChatEntityRead(store, auth, companyContext, { field: "description", entityType: "agent" }, "What is Lead's description?", chat.id, confirmed);
    expect(agentRead?.message).toBe("AGENT_DESCRIPTION");
    await persistChatResultContext(store, auth, agentRead);
    const agentFocus = await readChatActiveContext(store, auth, chat.id);
    expect((await executeChatEntityRead(store, auth, companyContext, { field: "role", entityType: "focused" }, "Its role?", chat.id, agentFocus))?.message).toBe(lead.role);
    expect((await executeChatEntityRead(store, auth, companyContext, { field: "projects", entityType: "company" }, "List its projects.", chat.id, confirmed))?.message).toBe(a.name + " — projects: 1:\n- " + project.name);
    const business = await store.createBusiness(auth, { name: a.name, businessStage: "operating", description: "BUSINESS_DESCRIPTION" });
    const businessRead = await executeChatEntityRead(store, auth, companyContext, { field: "description", entityType: "business" }, `Show the description of Business Profile "${a.name}".`, chat.id, confirmed);
    expect(businessRead).toMatchObject({ message: "BUSINESS_DESCRIPTION", entityRead: { entityType: "business", entityId: business.id, companyId: null } });
    expect((await store.getCompany(auth, a.id)).description).toBe("CURRENT_COMPANY_DESCRIPTION");
    await expect(executeChatEntityRead(store, auth, companyContext, { field: "name", entityType: "focused" }, "Its name?", other.id, confirmed)).rejects.toThrow("another conversation");
    expect(await executeChatEntityRead(store, auth, companyContext, { field: "instructions", entityType: "company" }, "Show instructions", undefined, undefined, true)).toBeNull();
  });
  it("resolves a durable remember target by owned entity type and never converts Business or chat memory into Company instructions", async () => {
    const { store, a, b } = await fixture();
    const business = await store.createBusiness(auth, { name: "Independent business profile", businessStage: "operating" });
    expect((await WorkspaceChatActions.companyInstructionTarget(auth, store, `Remember for company "${a.name}": a verified decision.`, b.id))?.id).toBe(a.id);
    expect((await WorkspaceChatActions.companyInstructionTarget(auth, store, "Remember this verified decision.", a.id))?.id).toBe(a.id);
    expect(await WorkspaceChatActions.companyInstructionTarget(auth, store, `Remember for "${business.name}": a verified decision.`, a.id)).toBeUndefined();
    expect(await WorkspaceChatActions.companyInstructionTarget(auth, store, "Remember in this chat: a temporary checkpoint.", a.id)).toBeUndefined();
    expect(await WorkspaceChatActions.companyInstructionTarget(auth, store, `Remember for ${a.name} and ${b.name}: a decision.`, a.id)).toBeUndefined();
    expect(await WorkspaceChatActions.companyInstructionTarget(auth, store, `What did you remember for ${a.name}?`, a.id)).toBeUndefined();
  });
  it.each(["company", "project"] as const)("round-trips a linked %s selection while keeping Business association in the snapshot", async contextType => {
    const store = new InMemoryWorkspaceStore();
    const business = await store.createBusiness(auth, { name: "Linked profile", businessStage: "operating" });
    const company = await store.createCompany(auth, { name: "Linked company", businessId: business.id }, "linked-company");
    const { project } = await store.createProject(auth, company.id, { name: "Linked site", type: "code_project" }, "linked-site");
    const resolver = new ActiveContextResolver(store);
    const selected = await resolver.resolve(auth, { contextType, companyId: company.id, ...(contextType === "project" ? { projectId: project.id } : {}) });
    expect(selected.context.businessId).toBeNull();
    expect(selected.snapshot.businessId).toBe(business.id);
    expect(selected.business?.id).toBe(business.id);
    expect((await resolver.resolve(auth, selected.context)).context).toEqual(selected.context);
    await expect(resolver.resolve(auth, { contextType, companyId: company.id, businessId: business.id })).rejects.toThrow("mutually exclusive");
  });
  it("validates an onboarding conversation through its Business owner and restores it without an owner hint", async () => {
    const { store } = await fixture();
    const business = await store.createBusiness(auth, { name: "Onboarding profile", businessStage: "idea" });
    const conversation = await store.createConversation(auth, business.id, "Setup");
    const result = await persistChatResultContext(store, auth, { conversationId: conversation.id,
      activeContext: { contextType: "none" }, onboarding: { businessId: business.id } });
    expect(result.activeContext).toMatchObject({ contextType: "business", businessId: business.id });
    expect((await readChatActiveContext(store, auth, conversation.id))?.lastConfirmedAction).toMatchObject({ entityType: "business", entityId: business.id });
    await expect(readChatActiveContext(store, { ...auth, userId: "foreign-owner" }, conversation.id, business.id)).rejects.toThrow();
  });
  it("keeps the original Business conversation owner when its action creates a different Business", async () => {
    const { store } = await fixture();
    const anchor = await store.createBusiness(auth, { name: "Conversation owner", businessStage: "idea" });
    const target = await store.createBusiness(auth, { name: "New profile", businessStage: "operating" });
    const chat = await store.createConversation(auth, anchor.id, "Profile work");
    const result = await persistChatResultContext(store, auth, { conversationId: chat.id,
      activeContext: { contextType: "business", businessId: anchor.id }, businessAction: { action: "create", business: target } });
    expect(result.activeContext).toMatchObject({ contextType: "business", businessId: anchor.id });
    const saved = await readChatActiveContext(store, auth, chat.id, anchor.id);
    expect(saved?.lastConfirmedAction).toMatchObject({ entityType: "business", entityId: target.id, companyId: null });
    expect((await store.getConversation(auth, anchor.id, chat.id)).conversation.id).toBe(chat.id);
  });
  it("selects a named Company without inventing a Project from updated-at order", async () => {
    const { resolver, a, b } = await fixture();
    const current = await resolver.resolve(auth, { contextType: "company", companyId: b.id });
    const selected = await resolver.resolveNamedCompany(auth, current, 'Switch to company "North Labs".', { intent: "CHAT" } as never);
    expect(selected?.context).toMatchObject({ contextType: "company", companyId: a.id });
    expect(selected?.context.projectId).toBeUndefined();
  });
  it("demotes the current Project for a named Company read, and resolves an explicitly named Project", async () => {
    const { resolver, a, project } = await fixture();
    const current = await resolver.resolve(auth, { contextType: "project", companyId: a.id, projectId: project.id });
    expect((await resolver.resolveNamedCompany(auth, current, 'Remember for "North Labs": SEQUENCE_43.', { intent: "CHAT" } as never))?.context.contextType).toBe("company");
    expect((await resolver.resolveNamedCompany(auth, current, 'Inspect the files of "North Portal".', { intent: "CHAT" } as never))?.project?.id).toBe(project.id);
  });
  it("persists the verified Company operation rather than the stale Project response scope", async () => {
    const { store, a, project, chat, resolver } = await fixture();
    const old = await resolver.resolve(auth, { contextType: "project", companyId: a.id, projectId: project.id });
    const result = await persistChatResultContext(store, auth, { conversationId: chat.id, activeContext: old.context, companyAction: { action: "update", companyId: a.id } });
    expect(result.activeContext).toMatchObject({ contextType: "company", companyId: a.id });
    expect(result.activeContext.projectId).toBeUndefined();
    const selected = await readChatActiveContext(store, auth, chat.id);
    expect(selected?.lastConfirmedAction).toMatchObject({ entityType: "company", entityId: a.id, companyId: a.id, projectId: null, action: "update" });
  });
  it("keeps independent chats separate and ignores prose or project cards as confirmation", async () => {
    const { store, a, project, chat, other, resolver } = await fixture();
    const context = (await resolver.resolve(auth, { contextType: "company", companyId: a.id })).context;
    await persistChatResultContext(store, auth, { conversationId: chat.id, activeContext: context });
    const message = await store.appendNeutralMessage(auth, chat.id, "assistant", "Selected project: malicious-invented-id");
    await saveChatProjectCard(store, auth, chat.id, message.id, { id: project.id, projectId: project.id, companyId: a.id, name: project.name } as never);
    expect((await readChatActiveContext(store, auth, chat.id))?.context.contextType).toBe("company");
    expect(await readChatActiveContext(store, auth, other.id)).toBeNull();
    await expect(readChatActiveContext(store, { ...auth, userId: "other-owner" }, chat.id)).rejects.toThrow();
  });
  it("reloads authoritative instructions for recall rather than relying on old conversation summaries", async () => {
    const { store, a } = await fixture();
    const prompt = await CompanyChatActions.buildSystemPrompt(auth, store, 'Recall the checkpoint for "North Labs".', a.id);
    expect(prompt).toContain("SEQUENCE_42");
    const current = await store.getCompany(auth, a.id);
    await store.updateCompany(auth, a.id, { companyInstructions: "Latest checkpoint: SEQUENCE_43" }, current.revision);
    const fresh = await CompanyChatActions.buildSystemPrompt(auth, store, 'Recall the checkpoint for "North Labs".', a.id);
    expect(fresh).toContain("SEQUENCE_43");
    expect(fresh).not.toContain("SEQUENCE_42");
  });
  it("validates ownership before accepting a result scope and records deletion as no selected entity", async () => {
    const { store, a, chat, resolver } = await fixture();
    await expect(persistChatResultContext(store, auth, { conversationId: chat.id, activeContext: { contextType: "company", companyId: "not-owned" } })).rejects.toThrow();
    const context = (await resolver.resolve(auth, { contextType: "company", companyId: a.id })).context;
    await persistChatResultContext(store, auth, { conversationId: chat.id, activeContext: context, companyAction: { companyId: a.id, action: "delete" } });
    expect((await readChatActiveContext(store, auth, chat.id))?.context.contextType).toBe("none");
  });
});
