import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PostgresWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CodeService } from "../apps/agent-api/src/code-service";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { currentToolManifest } from "../apps/agent-api/src/code-tool-registry";
import type { ProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import { databaseDescribe } from "./support/database-describe";

const url = process.env.DATABASE_URL;
const database = databaseDescribe(Boolean(url) && process.env.NPATI_SECURITY_GATE_DB === "1", describe, describe.skip);
database("individual PLAN C1 PostgreSQL persistence", () => {
  it("persists restricted project metadata and pins the manifest on the original session INSERT", async () => {
    const ctx: AuthContext = { workspaceId: "c1-" + randomUUID(), userId: "c1-" + randomUUID(),
      permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"] };
    const store = new PostgresWorkspaceStore(String(url));
    try {
      await store.initialize(ctx);
      const company = await store.createCompany(ctx, { name: "C1 isolated SQL" }, randomUUID());
      const workspace = { readFile: async () => { throw Object.assign(new Error("Absent"), { code: "ENOENT" }); } } as unknown as ProjectWorkspace;
      const service = new CodeService(store, new ProjectService(store), workspace, undefined, undefined, undefined,
        { assertEnabled: async () => true });
      const project = await service.createProject(ctx, company.id, { name: "Restricted",
        dataClassification: "restricted", retentionClass: "extended", branch: "develop" }, randomUUID());
      expect(await store.getProject(ctx, company.id, project.id)).toMatchObject({
        type: "code_project", dataClassification: "restricted", retentionClass: "extended", defaultBranch: "develop" });
      const update = vi.spyOn(store, "updateCodeSession").mockRejectedValue(new Error("Second write unavailable"));
      const session = await service.createSession(ctx, company.id, project.id);
      expect(session.revision).toBe(1);
      expect(session.toolManifestVersion).toBe(currentToolManifest().version);
      expect(await store.getCodeSession(ctx, company.id, session.id)).toEqual(session);
      expect(session).toMatchObject({ dataClassification: "restricted", retentionClass: "extended",
        projectId: project.id, companyId: company.id, userId: ctx.userId });
      expect(update).not.toHaveBeenCalled();
      const { CodeRunStateLog } = await import("../apps/agent-api/src/code-run-state");
      const runs = new CodeRunStateLog({ store });
      const runId = "c1a-sql-" + randomUUID();
      await runs.startRun({ ctx, companyId: company.id, projectId: project.id, sessionId: session.id, runId, owner: "first" });
      await runs.markFinished({ companyId: company.id, runId, status: "suspended_by_flag", reason: "feature_disabled" });
      await runs.releaseLease({ companyId: company.id, runId, owner: "foreign" });
      expect(await store.getCodeRunState(company.id, runId)).toMatchObject({ leaseOwner: "first" });
      await runs.releaseLease({ companyId: company.id, runId, owner: "first" });
      expect(await store.getCodeRunState(company.id, runId)).toMatchObject({ status: "suspended_by_flag", leaseOwner: null });
      const resumed = await runs.resumeRun({ companyId: company.id, runId, owner: "second" });
      expect(resumed).toMatchObject({ held: true, state: { status: "running", finishedAt: null, leaseOwner: "second" } });

      await expect(service.createSession({ ...ctx, workspaceId: "foreign-workspace" }, company.id, project.id)).rejects.toThrow();
    } finally { await store.close(); }
  }, 60_000);

  it("persists feature flags across global, company, and user scopes and records complete before/after audit history", async () => {
    const ctx: AuthContext = { workspaceId: "c1a-" + randomUUID(), userId: "c1a-user-" + randomUUID(),
      permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"] };
    const store = new PostgresWorkspaceStore(String(url));
    try {
      await store.initialize(ctx);
      const companyId = "c1a-comp-" + randomUUID();
      const userId = "c1a-target-" + randomUUID();

      // 1. Global scope
      const globalFlag = await store.setFeatureFlag(ctx, {
        scope: "global", flagKey: "coding.master", stage: "internal", enabled: true
      });
      expect(globalFlag.scope).toBe("global");
      expect(globalFlag.enabled).toBe(true);
      expect(globalFlag.stage).toBe("internal");
      expect(globalFlag.revision).toBe(1);

      // 2. Company scope
      const companyFlag = await store.setFeatureFlag(ctx, {
        scope: "company", scopeId: companyId, flagKey: "coding.master", stage: "allowlist", enabled: true, allowlist: [userId]
      });
      expect(companyFlag.scope).toBe("company");
      expect(companyFlag.scopeId).toBe(companyId);
      expect(companyFlag.allowlist).toEqual([userId]);

      // 3. User scope
      const userFlag = await store.setFeatureFlag(ctx, {
        scope: "user", scopeId: userId, flagKey: "coding.master", stage: "percent", rolloutPercent: 50, enabled: true
      });
      expect(userFlag.scope).toBe("user");
      expect(userFlag.scopeId).toBe(userId);
      expect(userFlag.enabled).toBe(true);

      // 4. Update flag and check revision + history
      const updatedGlobal = await store.setFeatureFlag(ctx, {
        scope: "global", flagKey: "coding.master", stage: "ga", enabled: true, expectedRevision: 1
      });
      expect(updatedGlobal.revision).toBe(2);
      expect(updatedGlobal.stage).toBe("ga");

      // Verify history
      const history = await store.listFeatureFlagHistory(ctx, "coding.master");
      expect(history.length).toBeGreaterThanOrEqual(2);
      const latest = history[0]!;
      expect(latest.flagKey).toBe("coding.master");
      expect(latest.actor).toBe(ctx.userId);
      expect(latest.nextValue).toMatchObject({ stage: "ga", revision: 2 });
      expect(latest.previousValue).toMatchObject({ stage: "internal", revision: 1 });
    } finally {
      await store.close();
    }
  }, 60_000);
});
