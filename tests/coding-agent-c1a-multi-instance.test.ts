import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PostgresWorkspaceStore, type AuthContext } from "@npati/workspace";
import {
  FeatureFlagService,
  FeatureDisabledError,
  CODE_AGENT_MASTER_FLAG,
} from "../apps/agent-api/src/feature-flags";
import { AuditLogService } from "../apps/agent-api/src/audit-log";
import { databaseDescribe } from "./support/database-describe";

const url = process.env.DATABASE_URL;
const database = databaseDescribe(Boolean(url) && process.env.NPATI_SECURITY_GATE_DB === "1", describe, describe.skip);

database("security-gate: C1a multi-instance feature flag synchronization and resiliency", () => {
  it("synchronizes flag updates and kill switch between independent API and Worker instances sharing PostgreSQL", async () => {
    const ctx: AuthContext = {
      workspaceId: "ws-c1a-sync-" + randomUUID(),
      userId: "u-admin-" + randomUUID(),
      permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"],
    };
    const store = new PostgresWorkspaceStore(String(url));
    try {
      await store.initialize(ctx);
      const company = await store.createCompany(ctx, { name: "C1a Multi-Instance Co" }, randomUUID());

      // Instance A (Agent API) and Instance B (Background Worker)
      const auditLog = new AuditLogService(store, { verifyIntervalMs: 60000, anchorIntervalMs: 60000, retentionDays: 365, blockOnBreak: true });
      const apiFlags = new FeatureFlagService(store, auditLog, { cacheTtlMs: 1000 });
      const workerFlags = new FeatureFlagService(store, auditLog, { cacheTtlMs: 1000 });

      // Step 1: Default state is dark launch (disabled)
      expect(await apiFlags.isEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId: company.id })).toBe(false);
      expect(await workerFlags.isEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId: company.id })).toBe(false);

      // Step 2: Instance A enables the master flag for the company
      await apiFlags.setFlag(ctx, {
        scope: "company",
        scopeId: company.id,
        flagKey: CODE_AGENT_MASTER_FLAG,
        stage: "internal",
        enabled: true,
      });

      // Instance A sees it immediately
      expect(await apiFlags.isEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId: company.id })).toBe(true);

      // Instance B reads from the shared PostgreSQL store and observes enabled: true
      workerFlags.invalidate(ctx.workspaceId);
      expect(await workerFlags.isEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId: company.id })).toBe(true);

      // Step 3: Kill switch triggered on Instance A
      const killResult = await apiFlags.killSwitch(ctx, {
        scope: "company",
        scopeId: company.id,
        companyId: company.id,
        reason: "Emergency stop test",
      });
      expect(killResult.flag.enabled).toBe(false);
      expect(killResult.flag.stage).toBe("off");

      // Instance A immediately refuses writes
      await expect(apiFlags.assertEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId: company.id }))
        .rejects.toBeInstanceOf(FeatureDisabledError);

      // Instance B observes kill switch after cache invalidation or within cache TTL <= 30s
      workerFlags.invalidate(ctx.workspaceId);
      await expect(workerFlags.assertEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId: company.id }))
        .rejects.toBeInstanceOf(FeatureDisabledError);

      // Verify audit history is preserved in PostgreSQL
      const history = await store.listFeatureFlagHistory(ctx, CODE_AGENT_MASTER_FLAG);
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history[0]?.actor).toBe(ctx.userId);
    } finally {
      await store.close();
    }
  }, 60_000);

  it("handles concurrent conflicting flag mutations using optimistic revision locks without corruption", async () => {
    const ctx: AuthContext = {
      workspaceId: "ws-c1a-race-" + randomUUID(),
      userId: "u-admin-" + randomUUID(),
      permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"],
    };
    const store = new PostgresWorkspaceStore(String(url));
    try {
      await store.initialize(ctx);
      const companyId = "c1a-race-" + randomUUID();

      // Initial flag row
      const initial = await store.setFeatureFlag(ctx, {
        scope: "company",
        scopeId: companyId,
        flagKey: "code.write",
        stage: "internal",
        enabled: true,
      });
      expect(initial.revision).toBe(1);

      // Worker 1 and Worker 2 both try to update using revision 1
      const p1 = store.setFeatureFlag(ctx, {
        scope: "company",
        scopeId: companyId,
        flagKey: "code.write",
        stage: "allowlist",
        enabled: true,
        allowlist: ["user-1"],
        expectedRevision: 1,
      });

      const p2 = store.setFeatureFlag(ctx, {
        scope: "company",
        scopeId: companyId,
        flagKey: "code.write",
        stage: "percent",
        enabled: true,
        rolloutPercent: 25,
        expectedRevision: 1,
      });

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly one succeeds, the other is rejected with revision conflict
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // Database state reflects exactly the winner's revision 2
      const allFlags = await store.listFeatureFlags(ctx);
      const current = allFlags.find((f) => f.scope === "company" && f.scopeId === companyId && f.flagKey === "code.write");
      expect(current?.revision).toBe(2);
    } finally {
      await store.close();
    }
  }, 60_000);

  it("fails closed when PostgreSQL store encounters transient failures", async () => {
    const ctx: AuthContext = {
      workspaceId: "ws-c1a-fail-" + randomUUID(),
      userId: "u-admin-" + randomUUID(),
      permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"],
    };
    const store = new PostgresWorkspaceStore(String(url));
    try {
      await store.initialize(ctx);
      const flags = new FeatureFlagService(store, undefined, { cacheTtlMs: 1000 });

      // Mock transient DB query failure
      vi.spyOn(store, "listFeatureFlags").mockRejectedValueOnce(new Error("connection timeout"));

      // Under transient DB failure, assertEnabled fails closed
      await expect(flags.assertEnabled(ctx, "code.write", { companyId: "comp-1" }))
        .rejects.toThrow();
    } finally {
      await store.close();
    }
  }, 60_000);
});
