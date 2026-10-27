import { expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CompanyAutomationsRepository } from "../apps/agent-api/src/automations-repository";
import { WORKSPACE_ACTION_TOOL } from "../apps/agent-api/src/chat-productivity-tools";
import { ContentLibraryStore } from "../apps/agent-api/src/content-library-store";
import { WorkspaceChatActions, type WorkspaceChatActionDependencies } from "../apps/agent-api/src/workspace-chat-actions";

const auth: AuthContext = { userId: "memory-owner", workspaceId: "memory-ws", permissions: ["workspace:read", "business:manage"] };
const directive = (value: object) => "```workspace-action\n" + JSON.stringify(value) + "\n```";

it("describes Business Memory with the fields and types its executor accepts", () => {
  const memory = (WORKSPACE_ACTION_TOOL.function.parameters.properties as Record<string, any>).memory;
  expect(memory).toMatchObject({ additionalProperties: false, properties: { type: { enum: expect.arrayContaining(["business_fact", "other"]) } } });
  expect(Object.keys(memory.properties).sort()).toEqual(["confidence", "content", "title", "type"]);
});

it("returns the executor's validation reason for an invented memory shape, then saves a valid one", async () => {
  const store = new InMemoryWorkspaceStore();
  const business = await store.createBusiness(auth, { name: "Reason Bakery" }, "reason-business");
  const deps = { store, automations: new CompanyAutomationsRepository(), content: new ContentLibraryStore(store) } as unknown as WorkspaceChatActionDependencies;
  // Shape seen live: a free-form category and a type outside the enum.
  const rejected = await WorkspaceChatActions.extractAndExecute(auth, directive({ action: "memory.create", businessId: business.id,
    memory: { title: "Opening date", content: "Opens on 1 December", type: "fact" } }), deps, "conversation", { requestMessage: "Remember the opening date" });
  expect(rejected.workspaceAction).toBeUndefined();
  expect(rejected.cleanText).toContain("Invalid memory");
  const saved = await WorkspaceChatActions.extractAndExecute(auth, directive({ action: "memory.create", businessId: business.id,
    memory: { title: "Opening date", content: "Opens on 1 December", type: "business_fact" } }), deps, "conversation", { requestMessage: "Remember the opening date" });
  expect(saved.workspaceAction).toMatchObject({ action: "memory.create", businessId: business.id });
  expect((await store.listMemory(auth, business.id)).map(item => item.content)).toEqual(["Opens on 1 December"]);
});
