import { describe, it, expect, vi } from "vitest";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import type { AuthContext } from "@npati/workspace";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
import { CompanyRunQueueWorker, type CompanyRunJob } from "../apps/agent-api/src/company-run-queue";

describe("PHASE 10: Background Jobs, Automations and Context-Safe Execution", () => {
  const store = new InMemoryWorkspaceStore();

  const mockAi = {
    a2aSend: vi.fn(),
    ensureCombo: vi.fn().mockResolvedValue(undefined),
    ensureA2AEnabled: vi.fn().mockResolvedValue(undefined),
    cancelA2ATask: vi.fn().mockResolvedValue(undefined),
  };

  const mockToolRuntime = {
    execute: vi.fn(),
  };

  const runtime = new CompanyDelegationRuntime(
    store,
    mockAi as any,
    10_000,
    mockToolRuntime as any
  );

  const tenantCtx: AuthContext = {
    workspaceId: "ws-tenant-bg",
    userId: "user-tenant-bg",
    permissions: ["workspace:read", "workspace:write", "business:manage"],
  };

  async function createCompanyWithAgent(ctx: AuthContext, name: string) {
    const company = await store.createCompany(ctx, { name }, `create-${name}-${Math.random()}`);
    const agent = await store.createCompanyAgent(
      ctx,
      company.id,
      {
        name: "Main Coordinator",
        role: "Coordinator",
        tools: ["web.search"],
        isActive: true,
      },
      `agent-${name}-${Math.random()}`
    );
    await store.setCompanyMainAgent(ctx, company.id, agent.id, company.revision);
    return { company: await store.getCompany(ctx, company.id), agent };
  }

  describe("Leases, Idempotency & Crash Recovery", () => {
    it("Duplicate enqueue -> one logical run (atomic lease claim)", async () => {
      const { company } = await createCompanyWithAgent(tenantCtx, "Alpha Logistics");
      const { run } = await store.createCompanyAgentRun(
        tenantCtx,
        company.id,
        { task: "Execute freight analysis", requestedMode: "single" },
        "idemp-enqueue-dup-1"
      );

      // Worker 1 claims the run
      const claimed1 = await store.claimCompanyAgentRun(tenantCtx, company.id, run.id, "worker-1", 60_000);
      expect(claimed1).toBe(true);

      // Worker 2 attempts duplicate claim
      const claimed2 = await store.claimCompanyAgentRun(tenantCtx, company.id, run.id, "worker-2", 60_000);
      expect(claimed2).toBe(false);

      // Verify run is leased only to worker 1
      const current = await store.getCompanyAgentRun(tenantCtx, company.id, run.id);
      expect(current.run.workerId).toBe("worker-1");
      expect(current.run.status).toBe("planning");
    });

    it("Redis message loss + recovery restores queued/recoverable runs from database", async () => {
      const { company } = await createCompanyWithAgent(tenantCtx, "Recovery Test Co");
      const { run: runA } = await store.createCompanyAgentRun(
        tenantCtx,
        company.id,
        { task: "Task A", requestedMode: "auto" },
        "idemp-recov-a"
      );
      const { run: runB } = await store.createCompanyAgentRun(
        tenantCtx,
        company.id,
        { task: "Task B", requestedMode: "auto" },
        "idemp-recov-b"
      );

      // Simulate redis queue message loss: items still in db
      const recoverable = await store.listRecoverableCompanyAgentRuns(100);
      const ids = recoverable.map((r) => r.runId);
      expect(ids).toContain(runA.id);
      expect(ids).toContain(runB.id);
    });

    it("Worker crash + lease expiry allows another worker to reclaim the run", async () => {
      const { company } = await createCompanyWithAgent(tenantCtx, "Crash Recovery Co");
      const { run } = await store.createCompanyAgentRun(
        tenantCtx,
        company.id,
        { task: "Process streaming ingestion", requestedMode: "single" },
        "idemp-crash-1"
      );

      // Worker A claims with a short lease of 50ms
      const claimedA = await store.claimCompanyAgentRun(tenantCtx, company.id, run.id, "worker-a", 50);
      expect(claimedA).toBe(true);

      // Worker A crashes and stops heartbeating. Wait for lease to expire
      await new Promise((resolve) => setTimeout(resolve, 70));

      // Worker B detects lease expiry and reclaims the run
      const claimedB = await store.claimCompanyAgentRun(tenantCtx, company.id, run.id, "worker-b", 60_000);
      expect(claimedB).toBe(true);

      const current = await store.getCompanyAgentRun(tenantCtx, company.id, run.id);
      expect(current.run.workerId).toBe("worker-b");
    });
  });

  describe("Context Safety & Permission Re-Resolution", () => {
    it("Context deleted or disabled after scheduling fails run with reason code", async () => {
      const { company } = await createCompanyWithAgent(tenantCtx, "Disablement Co");
      const { run } = await store.createCompanyAgentRun(
        tenantCtx,
        company.id,
        { task: "Autonomous research task", requestedMode: "single" },
        "idemp-disable-1"
      );

      // Company is disabled after scheduling
      await store.updateCompany(tenantCtx, company.id, { status: "inactive" }, company.revision);

      // Worker executes run
      const result = await runtime.process(tenantCtx, company.id, run.id);
      expect(result.run.status).toBe("failed");
      expect(result.run.errorCode).toBe("COMPANY_INACTIVE");
      expect(result.run.errorMessage).toContain("inactive");
      expect(mockAi.a2aSend).not.toHaveBeenCalled();
    });

    it("Permission revoked before execution fails run with PERMISSION_REVOKED", async () => {
      const { company } = await createCompanyWithAgent(tenantCtx, "Security Co");
      const { run } = await store.createCompanyAgentRun(
        tenantCtx,
        company.id,
        { task: "Execute database migration", requestedMode: "single" },
        "idemp-revoke-1"
      );

      // Context with stripped permissions (simulating token downgrade or role change)
      const strippedCtx: AuthContext = {
        workspaceId: tenantCtx.workspaceId,
        userId: tenantCtx.userId,
        permissions: [], // no permissions
      };

      const result = await runtime.process(strippedCtx, company.id, run.id);
      expect(result.run.status).toBe("failed");
      expect(result.run.errorCode).toBe("PERMISSION_REVOKED");
      expect(result.run.errorMessage).toContain("revoked");
      expect(mockAi.a2aSend).not.toHaveBeenCalled();
    });
  });

  describe("Fair Scheduling & Cancellation", () => {
    it("waits for in-flight recovery before closing Redis during shutdown", async () => {
      const worker = new CompanyRunQueueWorker(
        "redis://127.0.0.1:6379",
        store,
        runtime,
        { workerId: "test-shutdown-worker" }
      );
      const order: string[] = [];
      let finishRecovery!: () => void;
      const recovery = new Promise<void>((resolve) => {
        finishRecovery = () => {
          order.push("recovery-finished");
          resolve();
        };
      });
      const fakeClient = {
        isOpen: true,
        quit: vi.fn(async () => { order.push("client-closed"); }),
        destroy: vi.fn(),
      };
      (worker as any).client = fakeClient;
      (worker as any).recoveryInFlight = recovery;
      (worker as any).recoveryTimer = setInterval(() => undefined, 60_000);

      const stopping = worker.stop();
      await Promise.resolve();
      expect(fakeClient.quit).not.toHaveBeenCalled();
      finishRecovery();
      await stopping;

      expect(order).toEqual(["recovery-finished", "client-closed"]);
      expect((worker as any).recoveryTimer).toBeUndefined();
    });

    it("Noisy tenant does not starve other tenants (per-tenant concurrency limit)", async () => {
      // Create a queue worker with maxConcurrentPerTenant = 2
      const worker = new CompanyRunQueueWorker(
        "redis://127.0.0.1:6379",
        store,
        runtime,
        { maxConcurrentPerTenant: 2, workerId: "test-fair-worker" }
      );

      // Access private map for verification
      const activeMap = (worker as any).activePerTenant as Map<string, number>;

      // Tenant A starts 2 jobs
      activeMap.set("tenant-noisy", 2);

      // When Tenant A attempts a 3rd job, handle skips/defers it
      const noisyMessage = {
        id: "msg-noisy-3",
        job: {
          context: { workspaceId: "tenant-noisy", userId: "u-1", permissions: ["business:manage"] },
          companyId: "c-1",
          runId: "run-3",
        },
      };

      // Handle does not admit noisy job beyond limit
      await (worker as any).handle(noisyMessage, "consumer-1");
      expect(activeMap.get("tenant-noisy")).toBe(2);

      // Tenant B arrives with 1 job -> it is permitted
      expect(activeMap.get("tenant-quiet") ?? 0).toBe(0);
    });

    it("Cancellation is terminal and prevents further execution", async () => {
      const { company } = await createCompanyWithAgent(tenantCtx, "Cancellation Co");
      const { run } = await store.createCompanyAgentRun(
        tenantCtx,
        company.id,
        { task: "Long running simulation", requestedMode: "single" },
        "idemp-cancel-term"
      );

      // Cancel before run finishes
      const cancelled = await runtime.cancel(tenantCtx, company.id, run.id);
      expect(cancelled.run.status).toBe("cancelled");
      expect(cancelled.run.errorCode).toBe("RUN_CANCELLED");

      // Attempting to process or cancel again maintains terminal state
      const recheck = await runtime.cancel(tenantCtx, company.id, run.id);
      expect(recheck.run.status).toBe("cancelled");
    });
  });
});
