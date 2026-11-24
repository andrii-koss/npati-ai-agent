import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceAccessError, type AuthContext, type ProjectCheckpoint } from "@npati/workspace";
import { registerProjectFileRoutes } from "../apps/agent-api/src/project-file-routes";
import type { ProjectWorkspace } from "../apps/agent-api/src/project-workspace";

/** The chat file viewer marks an agent run's changes against the file in the run's first checkpoint. */
describe("files/before-run", () => {
  const context: AuthContext = { userId: "owner", workspaceId: "workspace", companyId: "company-a", permissions: ["workspace:read"] };
  const checkpoint = (id: string, runId: string, createdAt: string, trigger: ProjectCheckpoint["trigger"] = "pre_run"): ProjectCheckpoint =>
    ({ id, runId, createdAt, trigger, commitHash: "a".repeat(40), workspaceId: "workspace", companyId: "company-a", projectId: "p", userId: "owner", name: id, fileCount: 1 });
  async function request(url: string, readFile = vi.fn(async () => ({ content: "now", revision: "r" }))) {
    const app = Fastify();
    const checkpoints = {
      listCheckpoints: vi.fn(async () => [checkpoint("late", "run-1", "2026-11-24T10:05:00Z"), checkpoint("other", "run-2", "2026-11-24T09:00:00Z"), checkpoint("manual", "run-1", "2026-11-24T09:30:00Z", "manual"), checkpoint("first", "run-1", "2026-11-24T10:00:00Z")]),
      readCheckpointFile: vi.fn(async (_c: AuthContext, _co: string, _p: string, id: string) => ({ content: id === "first" ? "before" : "wrong" })),
    };
    registerProjectFileRoutes(app, { readFile } as unknown as ProjectWorkspace, { authenticate: async () => context }, undefined, undefined, checkpoints);
    try { return { response: await app.inject({ method: "GET", url }), checkpoints, readFile }; } finally { await app.close(); }
  }

  it("returns the file from the run's first automatic checkpoint", async () => {
    const { response, checkpoints } = await request("/companies/company-a/projects/p/files/before-run?path=styles.css&runId=run-1");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ content: "before", checkpointId: "first" });
    expect(checkpoints.readCheckpointFile).toHaveBeenCalledWith(context, "company-a", "p", "first", "styles.css");
  });

  it("reads nothing from a checkpoint when the user may not read the file now", async () => {
    const { response, checkpoints } = await request("/companies/company-a/projects/p/files/before-run?path=.env&runId=run-1", vi.fn(async () => { throw new WorkspaceAccessError("Protected file"); }));
    expect(response.statusCode).toBe(403);
    expect(checkpoints.readCheckpointFile).not.toHaveBeenCalled();
  });

  it("needs a run id and a checkpoint of that run", async () => {
    expect((await request("/companies/company-a/projects/p/files/before-run?path=styles.css")).response.statusCode).toBe(400);
    expect((await request("/companies/company-a/projects/p/files/before-run?path=styles.css&runId=run-9")).response.statusCode).toBe(404);
  });
});
