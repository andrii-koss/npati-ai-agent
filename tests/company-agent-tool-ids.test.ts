import { expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CompanyChatActions } from "../apps/agent-api/src/company-chat-actions";
import { toolName } from "../apps/agent-api/src/company-runtime-types";

const auth: AuthContext = { userId: "tools-owner", workspaceId: "tools-ws", permissions: ["workspace:read", "business:manage"] };
const directive = (value: object) => "```company-action\n" + JSON.stringify(value) + "\n```";

it.each([
  ["research.web_search", "web.search"], ["browser.web_fetch", "web.fetch"],
  ["system.text-to-speech", "audio.speech"], ["storage.agent_knowledge_retrieval", "knowledge"],
])("the Company runtime executes the catalog tool %s saved by the UI and chat as %s", (saved, runtime) => {
  expect(toolName(saved)).toBe(runtime);
});

it("persists a tool named by its runtime ID and refuses an unknown tool instead of saving an empty list", async () => {
  const store = new InMemoryWorkspaceStore();
  const company = await store.createCompany(auth, { name: "Tool Studio" }, "tool-studio");
  const agent = await store.createCompanyAgent(auth, company.id, { name: "Researcher", role: "Research", tools: [] }, "tool-researcher");

  const granted = await CompanyChatActions.extractAndExecute(auth, directive({ action: "update", companyId: company.id,
    agents: [{ action: "update", agentName: "Researcher", fields: { tools: ["web.search"] } }] }), store, "conversation");
  expect(granted.companyAction).toBeDefined();
  const saved = await store.getCompanyAgent(auth, company.id, agent.id);
  expect(saved.tools).toEqual(["research.web_search"]);
  expect(saved.tools.map(toolName)).toEqual(["web.search"]);

  const refused = await CompanyChatActions.extractAndExecute(auth, directive({ action: "update", companyId: company.id,
    agents: [{ action: "update", agentName: "Researcher", fields: { tools: ["teleport.magic"] } }] }), store, "conversation");
  expect(refused.companyAction).toBeUndefined();
  expect(refused.cleanText).toContain("teleport.magic");
  expect((await store.getCompanyAgent(auth, company.id, agent.id)).tools).toEqual(["research.web_search"]);
});
