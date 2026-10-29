import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { CodeBackgroundRunRegistry } from "../apps/agent-api/src/code-background-run-registry";
import { registerCodeBackgroundRunRoutes } from "../apps/agent-api/src/code-background-run-routes";

describe("background abort company binding", () => {
  for (const finished of [false, true]) {
    it(`refuses a foreign ${finished ? "finished" : "live"} run without stopping or exposing it`, async () => {
      const registry = new CodeBackgroundRunRegistry();
      const run = registry.start({ runId: "run-a", sessionId: "session-a", companyId: "company-a", userId: "user-a", projectId: "project-a" });
      if (finished) run.finish("completed", null);
      const app = Fastify();
      await registerCodeBackgroundRunRoutes(app, {
        registry,
        // The principal may operate company-b; that must not grant authority over a run of company-a.
        authorize: async (_ctx, companyId) => { if (companyId !== "company-b" && companyId !== "company-a") throw new Error("denied"); },
        getAuthContext: () => ({ workspaceId: "workspace-a", userId: "user-a", permissions: ["workspace:write"] }),
      });
      try {
        const abort = (companyId: string, runId: string) => app.inject({ method: "POST", url: `/companies/${companyId}/code/runs/${runId}/background/abort`, payload: { expectedRunId: runId } });
        const foreign = await abort("company-b", "run-a");
        const unknown = await abort("company-b", "missing");
        expect(foreign.statusCode).toBe(404);
        expect(foreign.json()).toEqual(unknown.json());
        expect(run.signal.aborted).toBe(false);
        const own = await abort("company-a", "run-a");
        expect(own.statusCode).toBe(finished ? 200 : 202);
        expect(own.json().status).toBe(finished ? "already_finished" : "aborting");
        expect(run.signal.aborted).toBe(!finished);
      } finally { await app.close(); }
    });
  }
});
