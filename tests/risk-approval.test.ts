import { describe, it, expect, vi } from "vitest";
import {
  RiskApprovalService,
  defaultRiskApprovalService,
} from "@npati/shared";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import type { AIEngine } from "@npati/omniroute-adapter";

describe("PHASE 6: Risk, Approval and Destructive Action Policy", () => {
  const service = new RiskApprovalService("test-secret-salt");

  const authUserA: AuthContext = {
    workspaceId: "ws-risk-1",
    userId: "user-alice",
    permissions: ["workspace:read", "workspace:write", "business:manage", "files:execute", "research:execute"],
  };

  const authUserB: AuthContext = {
    workspaceId: "ws-risk-1",
    userId: "user-bob",
    permissions: ["workspace:read", "workspace:write", "business:manage", "files:execute", "research:execute"],
  };

  function mockEngine(overrides: Partial<AIEngine> = {}): AIEngine {
    return {
      chat: async () => ({ content: "Operation completed", model: "auto" }),
      async *stream() { yield ""; },
      listModels: async () => [],
      getModel: async () => undefined,
      executeTool: async () => ({ status: "executed" }),
      searchMemory: async () => [],
      saveMemory: async () => undefined,
      getCapabilities: async () => ["chat"],
      healthCheck: async () => ({ status: "ok" }),
      ensureA2AEnabled: async () => undefined,
      a2aSend: async () => ({ taskId: "a2a-test", content: '{"mode":"single","agentIds":[],"toolRequests":[]}', metadata: {} }),
      cancelA2ATask: async () => undefined,
      ensureCombo: async (input) => ({ name: input.name }),
      ...overrides,
    };
  }

  describe("Risk Classification & Auto Path for Read Tools", () => {
    it("classifies read/research tools as low risk and allows auto path execution", () => {
      expect(service.classifyRisk("web.search")).toBe("low");
      expect(service.classifyRisk("web.fetch")).toBe("low");
      expect(service.classifyRisk("files.read")).toBe("low");
      expect(service.classifyRisk("knowledge")).toBe("low");

      expect(service.requiresApproval("web.search")).toBe(false);
      expect(service.requiresApproval("web.fetch")).toBe(false);
      expect(service.requiresApproval("knowledge")).toBe(false);
    });

    it("classifies mutate/send as high risk and destructive/delete as critical", () => {
      expect(service.classifyRisk("files.delete")).toBe("critical");
      expect(service.classifyRisk("bash.exec")).toBe("critical");
      expect(service.classifyRisk("email.bulk_send")).toBe("critical");
      expect(service.classifyRisk("system.eval")).toBe("critical");

      expect(service.classifyRisk("files.write")).toBe("high");
      expect(service.classifyRisk("email.send")).toBe("high");
      expect(service.classifyRisk("db.update")).toBe("high");

      expect(service.requiresApproval("files.delete")).toBe(true);
      expect(service.requiresApproval("email.send")).toBe(true);
    });
  });

  describe("Backend Enforcement & Tampering Protection", () => {
    it("blocks ask-first / high-risk action when no approval token is provided", async () => {
      const store = new InMemoryWorkspaceStore();
      await store.initialize();

      const company = await store.createCompany(authUserA, { name: "Safe Co" }, "safe-co");
      const manager = await store.createCompanyAgent(authUserA, company.id, { name: "Manager", role: "Coordinator" }, "safe-mgr");
      const worker = await store.createCompanyAgent(
        authUserA,
        company.id,
        { name: "Worker", role: "Worker", tools: ["files"] },
        "safe-worker"
      );
      await store.setCompanyMainAgent(authUserA, company.id, manager.id, company.revision);

      const ai = mockEngine({
        a2aSend: async () => ({
          taskId: "a2a-delete",
          content: JSON.stringify({
            mode: "single",
            agentIds: [worker.id],
            toolRequests: [
              {
                agentId: worker.id,
                tool: "files.delete",
                input: { path: "/important/database.sql" },
              },
            ],
          }),
          metadata: {},
        }),
      });

      const runtime = new CompanyDelegationRuntime(store, ai, 5000, undefined, undefined, undefined, service);
      const result = await runtime.execute(authUserA, company.id, { task: "Delete file" }, "risk-run-001");

      expect(result.run.status).toBe("failed");
      expect(result.run.errorCode).toBe("APPROVAL_REQUIRED");
      expect(result.toolAudit).toHaveLength(1);
      expect(result.toolAudit[0].decision).toBe("denied");
      expect(result.toolAudit[0].status).toBe("blocked");
      expect(result.toolAudit[0].errorMessage).toContain("Human approval required");
    });

    it("allows execution when a valid signed approval token is provided", async () => {
      const store = new InMemoryWorkspaceStore();
      await store.initialize();

      const company = await store.createCompany(authUserA, { name: "Approved Co" }, "app-co");
      const manager = await store.createCompanyAgent(authUserA, company.id, { name: "Manager", role: "Coordinator" }, "app-mgr");
      const worker = await store.createCompanyAgent(
        authUserA,
        company.id,
        { name: "Worker", role: "Worker", tools: ["files"] },
        "app-worker"
      );
      await store.setCompanyMainAgent(authUserA, company.id, manager.id, company.revision);

      const executeTool = vi.fn(async () => ({ written: true }));
      let token = "";
      const payload = { path: "/safe/report.pdf" };

      const ai = mockEngine({
        executeTool,
        a2aSend: async () => ({
          taskId: "a2a-write",
          content: JSON.stringify({
            mode: "single",
            agentIds: [worker.id],
            toolRequests: [
              {
                agentId: worker.id,
                tool: "files.write",
                input: { ...payload, _approvalToken: token },
              },
            ],
          }),
          metadata: {},
        }),
      });

      const runtime = new CompanyDelegationRuntime(store, ai, 5000, undefined, undefined, undefined, service);
      const created = await runtime.create(authUserA, company.id, { task: "Write report" }, "app-key-001");
      const runId = created.run.id;

      // Generate valid approval request & token for the actual runId
      const req = service.createApprovalRequest(authUserA, company.id, runId, worker.id, "files.write", payload);
      token = req.token;

      const result = await (runtime as any).process(authUserA, company.id, runId, "auto");

      expect(result.run.status).toBe("completed");
      expect(executeTool).toHaveBeenCalled();
      // Audit records both requested and succeeded
      expect(result.toolAudit.filter((a: any) => a.toolName !== "ai.inference").map((a: any) => a.status)).toEqual([
        "requested",
        "succeeded",
      ]);
      expect(result.toolAudit.some((a: any) => a.toolName === "ai.inference" && a.status === "succeeded")).toBe(true);
    });

    it("invalidates approval and blocks execution if the payload was modified (tampering protection)", async () => {
      const store = new InMemoryWorkspaceStore();
      await store.initialize();

      const company = await store.createCompany(authUserA, { name: "Tamper Co" }, "tamper-co");
      const manager = await store.createCompanyAgent(authUserA, company.id, { name: "Manager", role: "Coordinator" }, "tamper-mgr");
      const worker = await store.createCompanyAgent(
        authUserA,
        company.id,
        { name: "Worker", role: "Worker", tools: ["files"] },
        "tamper-worker"
      );
      await store.setCompanyMainAgent(authUserA, company.id, manager.id, company.revision);

      let tamperedPayload: Record<string, unknown> = {};

      const ai = mockEngine({
        a2aSend: async () => ({
          taskId: "a2a-tamper",
          content: JSON.stringify({
            mode: "single",
            agentIds: [worker.id],
            toolRequests: [
              {
                agentId: worker.id,
                tool: "files.write",
                input: tamperedPayload,
              },
            ],
          }),
          metadata: {},
        }),
      });

      const runtime = new CompanyDelegationRuntime(store, ai, 5000, undefined, undefined, undefined, service);
      const created = await runtime.create(authUserA, company.id, { task: "Tampered write" }, "tamper-key-001");
      const runId = created.run.id;

      const originalPayload = { path: "/harmless.txt", content: "hello" };
      // Approved for harmless.txt
      const req = service.createApprovalRequest(authUserA, company.id, runId, worker.id, "files.write", originalPayload);

      // Malicious or modified payload passed at execution time: /system/root.key with token for harmless.txt
      tamperedPayload = { path: "/system/root.key", content: "hacked", _approvalToken: req.token };

      const result = await (runtime as any).process(authUserA, company.id, runId, "auto");

      expect(result.run.status).toBe("failed");
      expect(result.run.errorCode).toBe("INVALID_APPROVAL_TOKEN");
      expect(result.toolAudit[0].status).toBe("blocked");
      expect(result.toolAudit[0].errorMessage).toContain("tampering detected");
    });
  });

  describe("Cross-User, Expiry & Replay Protections", () => {
    it("rejects approval token when submitted by a different user (cross-user isolation)", () => {
      const payload = { target: "production" };
      const req = service.createApprovalRequest(authUserA, "comp-1", "run-1", "ag-1", "email.send", payload);

      // User B tries to use User A's token
      const check = service.verifyApprovalToken(req.token, authUserB, "comp-1", "run-1", "email.send", payload);
      expect(check.valid).toBe(false);
      expect(check.reasonCode).toBe("cross_user");
    });

    it("rejects expired approval tokens (TTL expiry)", () => {
      const payload = { target: "production" };
      // Expired TTL (-1 second)
      const req = service.createApprovalRequest(authUserA, "comp-1", "run-1", "ag-1", "email.send", payload, -1000);

      const check = service.verifyApprovalToken(req.token, authUserA, "comp-1", "run-1", "email.send", payload);
      expect(check.valid).toBe(false);
      expect(check.reasonCode).toBe("expired");
    });

    it("blocks duplicate replay of an already consumed token (idempotency / single side effect)", () => {
      const payload = { target: "production" };
      const req = service.createApprovalRequest(authUserA, "comp-1", "run-1", "ag-1", "email.send", payload);

      // First verification: valid
      const check1 = service.verifyApprovalToken(req.token, authUserA, "comp-1", "run-1", "email.send", payload);
      expect(check1.valid).toBe(true);

      // First consumption: success
      const consumed1 = service.consumeToken(req.token);
      expect(consumed1).toBe(true);

      // Second consumption / verification: rejected!
      const check2 = service.verifyApprovalToken(req.token, authUserA, "comp-1", "run-1", "email.send", payload);
      expect(check2.valid).toBe(false);
      expect(check2.reasonCode).toBe("already_consumed");

      const consumed2 = service.consumeToken(req.token);
      expect(consumed2).toBe(false);
    });

    it("guarantees duplicate submit with same idempotency key executes exactly one side effect", async () => {
      const store = new InMemoryWorkspaceStore();
      await store.initialize();

      const company = await store.createCompany(authUserA, { name: "Idempotent Co" }, "idem-co");
      const manager = await store.createCompanyAgent(authUserA, company.id, { name: "Manager", role: "Coordinator" }, "idem-mgr");
      await store.setCompanyMainAgent(authUserA, company.id, manager.id, company.revision);

      const executeTool = vi.fn(async () => ({ written: true }));
      const ai = mockEngine({ executeTool });

      const runtime = new CompanyDelegationRuntime(store, ai, 5000, undefined, undefined, undefined, service);

      // First execution with key "idem-key-123"
      const res1 = await runtime.execute(authUserA, company.id, { task: "Idempotent task" }, "idem-key-123");
      expect(res1.run.status).toBe("completed");

      // Duplicate execution with exact same key "idem-key-123"
      const res2 = await runtime.execute(authUserA, company.id, { task: "Idempotent task" }, "idem-key-123");
      expect(res2.run.id).toBe(res1.run.id); // Exactly same run returned
    });

    it("records full audit trail containing requested, approved, blocked, and executed statuses", async () => {
      const store = new InMemoryWorkspaceStore();
      await store.initialize();

      const company = await store.createCompany(authUserA, { name: "Audit Co" }, "audit-co");
      const manager = await store.createCompanyAgent(authUserA, company.id, { name: "Manager", role: "Coordinator" }, "audit-mgr");
      const worker = await store.createCompanyAgent(authUserA, company.id, { name: "Worker", role: "Worker", tools: ["files"] }, "audit-worker");
      await store.setCompanyMainAgent(authUserA, company.id, manager.id, company.revision);

      const ai = mockEngine({
        a2aSend: async () => ({
          taskId: "a2a-audit",
          content: JSON.stringify({
            mode: "single",
            agentIds: [worker.id],
            toolRequests: [{ agentId: worker.id, tool: "files.delete", input: { path: "/test.txt" } }],
          }),
          metadata: {},
        }),
      });

      const runtime = new CompanyDelegationRuntime(store, ai, 5000, undefined, undefined, undefined, service);
      const res = await runtime.execute(authUserA, company.id, { task: "Audit test" }, "audit-key-1");

      expect(res.run.status).toBe("failed");
      expect(res.toolAudit).toHaveLength(1);
      const audit = res.toolAudit[0];
      expect(audit.decision).toBe("denied");
      expect(audit.status).toBe("blocked");
      expect(audit.toolName).toBe("files.delete");
    });
  });
});
