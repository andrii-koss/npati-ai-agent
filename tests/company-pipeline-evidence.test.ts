import { describe, expect, it, vi } from "vitest";
import type { AIEngine, ChatRequest } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";

const auth: AuthContext = { workspaceId: "pipeline-audit", userId: "owner", permissions: ["workspace:read", "workspace:write", "business:manage"] };
async function fixture(failSecond = false, mode: "pipeline" | "fusion" = "pipeline") {
  const store = new InMemoryWorkspaceStore(); await store.initialize();
  let company = await store.createCompany(auth, { name: "Audit Pipeline" }, "company");
  const agents = await Promise.all(["Manager", "Researcher", "Writer"].map(name => store.createCompanyAgent(auth, company.id, { name, role: name }, name)));
  company = await store.setCompanyMainAgent(auth, company.id, agents[0]!.id, company.revision);
  const calls: ChatRequest[] = [];
  const ai = {
    ensureA2AEnabled: vi.fn(), ensureCombo: vi.fn(async input => ({ name: input.name })),
    a2aSend: async () => ({ taskId: "plan", metadata: {}, content: JSON.stringify({ mode, agentIds: agents.slice(1).map(a => a.id), toolRequests: [] }) }),
    chat: async (request: ChatRequest) => { calls.push(request); if (failSecond && request.idempotencyKey?.endsWith(agents[2]!.id)) throw Error("Unavailable model"); return { content: `Answer-${calls.length}`, model: request.model, usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } }; },
  } as unknown as AIEngine;
  return { store, company, agents, calls, runtime: new CompanyDelegationRuntime(store, ai) };
}
describe("auditable agent stages", () => {
  it.each(["pipeline", "fusion"] as const)("persists every actual agent answer, status and usage for %s", async mode => {
    const { runtime, company, agents, calls } = await fixture(false, mode);
    const result = await runtime.execute(auth, company.id, { task: "Review the project", mode }, "run");
    expect(result.run.status).toBe("completed");
    expect(calls).toHaveLength(3);
    expect(result.steps.map(step => step.status)).toEqual(["completed", "completed", "completed"]);
    const answers = result.toolAudit.filter(item => item.inputSummary.phase === "agent-result");
    expect(new Set(answers.map(item => item.agentId))).toEqual(new Set(agents.map(agent => agent.id)));
    expect(answers.map(item => item.inputSummary.result)).toEqual(["Answer-1", "Answer-2", "Answer-3"]);
    expect(result.run.totalTokens).toBe(30);
    expect(JSON.stringify(calls[2]!.messages)).toContain("Answer-1");
    expect(JSON.stringify(calls[2]!.messages)).toContain("Answer-2");
    if (mode === "pipeline") expect(JSON.stringify(calls[1]!.messages)).toContain("Answer-1");
  });
  it("keeps a successful answer when a later agent fails, and never invents the manager answer", async () => {
    const { runtime, company, agents, calls } = await fixture(true);
    const result = await runtime.execute(auth, company.id, { task: "Review", mode: "pipeline" }, "failed-run");
    expect(result.run.status).toBe("failed");
    expect(calls).toHaveLength(2);
    expect(result.steps.find(step => step.agentId === agents[1]!.id)?.status).toBe("completed");
    expect(result.steps.find(step => step.agentId === agents[2]!.id)?.status).toBe("failed");
    expect(result.steps.find(step => step.agentId === agents[0]!.id)?.status).toBe("cancelled");
    expect(result.toolAudit.filter(item => item.inputSummary.result).map(item => item.inputSummary.result)).toEqual(["Answer-1"]);
  });
});

it("supplies runtime identity to each agent and rejects fabricated run identifiers", async () => {
 const { executeAgentStages } = await import("../apps/agent-api/src/company-runtime-stages");
 const f = await fixture();
 let system = "";
 const completed = vi.fn(); const failed = vi.fn();
 const ai = { chat: async (request: ChatRequest) => { system = String(request.messages[0]?.content); return { content: "Run ID: STRESS-DS1023-RUN-FAKE" }; } } as unknown as AIEngine;
 await expect(executeAgentStages({ ai, main: f.agents[0]!, selected: [], mainAssignedWork: false, mode: "single", agentModels: {}, signal: new AbortController().signal, timeoutMs: 1000, task: "Show the run ID", evidence: "", managerInstruction: "Report", knowledgeContext: "", runId: "runtime-authoritative-id", admission: undefined, before: async () => {}, completed, failed })).rejects.toThrow("runtime_run_identifier_mismatch");
 expect(system).toContain('"runId":"runtime-authoritative-id"');
 expect(completed).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
});
