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
      await expect(service.createSession({ ...ctx, workspaceId: "foreign-workspace" }, company.id, project.id)).rejects.toThrow();
    } finally { await store.close(); }
  }, 60_000);
});
