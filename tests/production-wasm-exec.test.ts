import { describe, expect, it, vi } from "vitest";
import type { AIEngine } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import { WasmExecSandbox } from "../apps/agent-api/src/wasm-exec-sandbox";
import { CompanyToolRuntime } from "../apps/agent-api/src/company-tool-runtime";
import { CompanyDelegationRuntime, type DurableApprovalGateway } from "../apps/agent-api/src/company-runtime";

describe("Production WebAssembly Exec sandbox", () => {
  it("executes JavaScript without exposing host, network, modules, or environment", async () => {
    const sandbox = new WasmExecSandbox();
    const result = await sandbox.execute({
      code: 'console.log("NPATI_EXEC_OK"); ({ process: typeof process, require: typeof require, fetch: typeof fetch, result: 6 * 7 })',
    }, new AbortController().signal);
    expect(result).toMatchObject({
      runtime: "quickjs-wasm-worker", success: true, stdout: "NPATI_EXEC_OK", isolated: true,
      networkAccess: false, hostFileAccess: false,
      result: { process: "undefined", require: "undefined", fetch: "undefined", result: 42 },
    });
  });

  it("interrupts infinite execution at the bounded timeout", async () => {
    const result = await new WasmExecSandbox().execute({ code: "for (;;) {}", timeoutMs: 50 }, new AbortController().signal);
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain("timed out");
  });

  it("cancels an active execution without blocking the API event loop", async () => {
    const sandbox = new WasmExecSandbox();
    const controller = new AbortController();
    const execution = sandbox.execute({ code: "for (;;) {}", timeoutMs: 5_000 }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sandbox.activeExecutions()).toHaveLength(1);
    controller.abort();
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(sandbox.activeExecutions()).toHaveLength(0);
  });

  it("runs through Company Agent only after one exact durable approval", async () => {
    const auth = { workspaceId: "exec-ws", userId: "exec-user", permissions: ["workspace:read", "workspace:write", "business:manage"] };
    const store = new InMemoryWorkspaceStore(); await store.initialize();
    let company = await store.createCompany(auth, { name: "Exec Company" }, "exec-company");
    const agent = await store.createCompanyAgent(auth, company.id, { name: "Main", role: "Developer", modelId: "auto", tools: ["exec"], isActive: true }, "exec-agent");
    company = await store.setCompanyMainAgent(auth, company.id, agent.id, company.revision);
    const approvalId = "22222222-2222-4222-8222-222222222222";
    let consumed = false;
    const approvals: DurableApprovalGateway = {
      requestApproval: vi.fn(async () => ({ id: approvalId })),
      consumeApproved: vi.fn(async (_ctx, _companyId, id, input) => {
        if (id !== approvalId || input.toolName !== "exec" || input.inputPayload.code !== 'console.log("APPROVED_EXEC")') {
          throw Object.assign(new Error("Approval context or payload does not match"), { code: "APPROVAL_INVALID", status: 409 });
        }
        if (consumed) throw Object.assign(new Error("Approval has already been consumed"), { code: "APPROVAL_ALREADY_USED", status: 409 });
        consumed = true;
      }),
    };
    const chat = vi.fn(async (input: { messages: Array<{ content: string }> }) => ({ content: input.messages.at(-1)?.content ?? "", model: "auto" }));
    const ai = {
      executeTool: vi.fn(), ensureA2AEnabled: vi.fn(), ensureCombo: vi.fn(async (input: { name: string }) => ({ name: input.name })),
      a2aSend: vi.fn(async () => ({ taskId: "exec-plan", content: JSON.stringify({ mode: "single", agentIds: [], toolRequests: [{ agentId: agent.id, tool: "exec", input: { language: "javascript", code: 'console.log("APPROVED_EXEC")' } }] }), metadata: {} })),
      chat,
    } as unknown as AIEngine;
    const tools = new CompanyToolRuntime(ai, undefined, undefined, undefined, undefined, new WasmExecSandbox());
    const runtime = new CompanyDelegationRuntime(store, ai, 10_000, tools, undefined, undefined, undefined, undefined, approvals);

    const first = await runtime.execute(auth, company.id, { task: "Run the approved calculation" }, "exec-run");
    expect(first.run.errorCode).toBe("APPROVAL_REQUIRED");
    expect(chat).not.toHaveBeenCalled();
    const resumed = await runtime.process(auth, company.id, first.run.id, { approvalId });
    expect(resumed.run.status).toBe("completed");
    expect(chat.mock.calls[0]?.[0].messages.at(-1)?.content).toContain("APPROVED_EXEC");
    expect(chat.mock.calls[0]?.[0].messages.at(-1)?.content).toContain('"codeMode":true');
    const callsBeforeReplay = chat.mock.calls.length;
    await expect(runtime.process(auth, company.id, first.run.id, { approvalId })).rejects.toMatchObject({ code: "APPROVAL_INVALID", status: 409 });
    expect(chat).toHaveBeenCalledTimes(callsBeforeReplay);
    expect((await store.getCompanyAgentRun(auth, company.id, first.run.id)).run.status).toBe("completed");
  });

  it("blocks a host escape attempt before creating an approval", async () => {
    const auth = { workspaceId: "review-ws", userId: "review-user", permissions: ["workspace:read", "workspace:write", "business:manage"] };
    const store = new InMemoryWorkspaceStore(); await store.initialize();
    let company = await store.createCompany(auth, { name: "Review Company" }, "review-company");
    const agent = await store.createCompanyAgent(auth, company.id, { name: "Main", role: "Developer", modelId: "auto", tools: ["exec"], isActive: true }, "review-agent");
    company = await store.setCompanyMainAgent(auth, company.id, agent.id, company.revision);
    const approvals: DurableApprovalGateway = { requestApproval: vi.fn(), consumeApproved: vi.fn() };
    const ai = {
      executeTool: vi.fn(), ensureA2AEnabled: vi.fn(), ensureCombo: vi.fn(),
      a2aSend: vi.fn(async () => ({ taskId: "escape-plan", content: JSON.stringify({ mode: "single", agentIds: [], toolRequests: [{ agentId: agent.id, tool: "exec", input: { code: 'require("node:fs").readFileSync(".env")' } }] }), metadata: {} })),
      chat: vi.fn(),
    } as unknown as AIEngine;
    const runtime = new CompanyDelegationRuntime(store, ai, 10_000,
      new CompanyToolRuntime(ai, undefined, undefined, undefined, undefined, new WasmExecSandbox()),
      undefined, undefined, undefined, undefined, approvals);
    const result = await runtime.execute(auth, company.id, { task: "Read host secrets" }, "escape-run");
    expect(result.run.errorCode).toBe("EXEC_REVIEW_BLOCKED");
    expect(approvals.requestApproval).not.toHaveBeenCalled();
    expect(result.toolAudit).toEqual(expect.arrayContaining([expect.objectContaining({ reasonCode: "auto_exec_reviewer", status: "blocked" })]));
  });
});
