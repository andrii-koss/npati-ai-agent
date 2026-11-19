import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type ActivityAgentRun } from "@npati/workspace";
import { LocalDevAuthProvider } from "../apps/agent-api/src/auth";
import { registerActivityRoutes } from "../apps/agent-api/src/activity-routes";
import { ProjectService } from "../apps/agent-api/src/project-service";

it("returns Activity totals, the first trace and a full filtered selection and removes only matching history entries", async () => {
  const store = new InMemoryWorkspaceStore();
  const companies = [{ id: "a", name: "Company A" }, { id: "b", name: "Company B" }];
  const runs: ActivityAgentRun[] = Array.from({ length: 23 }, (_, index) => ({
    id: `run-${index}`, companyId: index < 22 ? "a" : "b", task: `Task ${index}`,
    requestedMode: "single", status: index === 22 ? "failed" : "completed",
    createdAt: new Date(Date.UTC(2026, 10, 1, index)).toISOString(),
  }));
  vi.spyOn(store, "readActivityCatalog").mockImplementation(async (context, companyId) => ({
    companies: context.userId === "dev-user" ? companies : [],
    agentRuns: context.userId === "dev-user" ? runs.filter(run => !companyId || run.companyId === companyId) : [],
    projects: [], codeRuns: [],
  }));
  const trace = vi.spyOn(store, "getCompanyAgentRun").mockImplementation(async (_, companyId, runId) => ({
    run: runs.find(run => run.id === runId && run.companyId === companyId)!,
    steps: [], toolAudit: [], backgroundEvents: [],
  } as Awaited<ReturnType<typeof store.getCompanyAgentRun>>));
  const app = Fastify();
  const local = new LocalDevAuthProvider();
  registerActivityRoutes(app, {
    store, projects: new ProjectService(store),
    auth: {
      authenticate: async request => ({
        ...await local.authenticate(request),
        userId: request.headers.authorization === "other" ? "other-user" : "dev-user",
      }),
    },
    codeRbac: { authorize: async () => { throw new Error("No snapshot permissions"); } },
    projectTrust: { get: async () => null },
  });
  try {
    const open = await app.inject("/activity/page");
    expect(open.statusCode).toBe(200);
    expect(open.json()).toMatchObject({
      companies, matchingTotal: 23,
      counts: { total: 23, completed: 22, running: 0, failed: 1 },
      selected: { id: "run-22" }, detail: { agent: { run: { id: "run-22" } } },
    });
    const { nextCursor, items } = open.json();
    expect(items).toHaveLength(20);
    const next = await app.inject(`/activity/page?cursor=${nextCursor}`);
    expect(next.json()).toMatchObject({ nextCursor: null, matchingTotal: 23, detail: null });
    expect(next.json().items.map((run: ActivityAgentRun) => run.id)).toEqual(["run-2", "run-1", "run-0"]);
    expect(trace).toHaveBeenCalledTimes(1);

    const selection = (await app.inject("/activity/page?company=a&status=completed&select=1")).json().records;
    expect(selection).toHaveLength(22);
    const first = selection[0];
    const otherUser = await app.inject({
      method: "POST", url: "/activity/bulk-delete", headers: { authorization: "other" }, payload: { records: [first] },
    });
    expect(otherUser.json()).toEqual({ deleted: 0, failed: [first] });
    const removed = await app.inject({ method: "POST", url: "/activity/bulk-delete", payload: { records: selection } });
    expect(removed.json()).toEqual({ deleted: 22, failed: [] });
    expect((await app.inject("/activity/page")).json().counts).toEqual({ total: 1, completed: 0, running: 0, failed: 1 });
    expect((await app.inject(`/activity/a/runs/${first.id}`)).statusCode).toBe(404);
    expect(runs).toHaveLength(23);
    const retry = await app.inject({ method: "POST", url: "/activity/bulk-delete", payload: { records: [first] } });
    expect(retry.json()).toEqual({ deleted: 0, failed: [] });
  } finally {
    await app.close();
  }
});
