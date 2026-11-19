import Fastify from "fastify";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { expect, it } from "vitest";
import { CompanyAutomationsRepository } from "../apps/agent-api/src/automations-repository";
import { registerCompanyAutomationsRoutes } from "../apps/agent-api/src/automations-routes";
import type { BulkRecord } from "../apps/agent-api/src/bulk-records";
import { registerWorkspaceRoutes } from "../apps/agent-api/src/workspace-routes";

it.each(["goals", "memory", "automations"] as const)("selects every matching %s record and deletes only authorized selected records", async resource => {
  const app = Fastify();
  const store = new InMemoryWorkspaceStore();
  const repo = new CompanyAutomationsRepository();
  const owner: AuthContext = { workspaceId: "bulk-workspace", userId: "owner-user", permissions: ["workspace:read", "business:manage"] };
  const other = { ...owner, userId: "other-user" };
  const auth = { authenticate: async () => owner };
  registerWorkspaceRoutes(app, store, auth);
  registerCompanyAutomationsRoutes(app, { store, repo, auth });

  const makeOwner = async (ctx: AuthContext) => resource === "automations"
    ? (await store.createCompany(ctx, { name: "Automation company" }, `bulk-${ctx.userId}`)).id
    : (await store.createBusiness(ctx, { name: "Business records" })).id;
  const add = async (ctx: AuthContext, ownerId: string, name: string): Promise<BulkRecord> => {
    const item = resource === "automations"
      ? await repo.create(ctx, ownerId, { name, prompt: "Prepare a report", cronExpression: "0 9 * * *" })
      : resource === "memory"
        ? await store.createMemory(ctx, ownerId, { type: "business_fact", title: name, content: "A durable note" })
        : await store.createGoal(ctx, ownerId, { title: name });
    return { id: item.id, ownerId };
  };

  try {
    const ownerId = await makeOwner(owner);
    const otherId = await makeOwner(other);
    const foreign = await add(other, otherId, "Selected foreign record");
    const keep = await add(owner, ownerId, "Keep this record");
    const matching = await Promise.all(Array.from({ length: 14 }, (_, index) => add(owner, ownerId, `Selected record ${index}`)));
    const page = await app.inject({ url: `/${resource}/page?search=selected` });
    expect(page.statusCode).toBe(200);
    const filtered = page.json();
    expect(filtered.matchingTotal).toBe(14);
    expect(filtered.goals ?? filtered.items).toHaveLength(10);
    const selection = await app.inject({ url: `/${resource}/page?select=1&search=selected` });
    expect(selection.statusCode).toBe(200);
    const { records } = selection.json<{ records: BulkRecord[] }>();
    expect(new Set(records.map(record => record.id))).toEqual(new Set(matching.map(record => record.id)));
    const result = await app.inject({ method: "POST", url: `/${resource}/bulk-delete`, payload: { records: [...records, records[0], foreign] } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ deleted: matching.length, failed: [foreign] });
    expect((await app.inject({ url: `/${resource}/page?select=1` })).json()).toEqual({ records: [keep] });
    const retry = await app.inject({ method: "POST", url: `/${resource}/bulk-delete`, payload: { records } });
    expect(retry.json().deleted).toBe(0);
  } finally {
    await app.close();
  }
});
