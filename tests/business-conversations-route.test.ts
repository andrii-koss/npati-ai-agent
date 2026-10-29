import { expect, it } from "vitest";
import type { OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";

const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;
const user = (id: string): AuthContext => ({ userId: id, workspaceId: "shared-workspace", permissions: ["workspace:read", "workspace:write", "business:manage"] });

it("returns every owned Business conversation in one response and nothing of another user", async () => {
  const store = new InMemoryWorkspaceStore();
  const alice = user("alice"), bob = user("bob");
  const bakery = await store.createBusiness(alice, { name: "Alice Bakery", businessStage: "operating" });
  const cafe = await store.createBusiness(alice, { name: "Alice Cafe", businessStage: "idea" });
  const foreign = await store.createBusiness(bob, { name: "Bob Shop", businessStage: "idea" });
  await store.createConversation(alice, bakery.id, "Bread plan");
  await store.createConversation(alice, cafe.id, "Menu");
  await store.createConversation(bob, foreign.id, "Bob secret");
  let current = alice;
  const app = buildApp({ workspaceStore: store, authProvider: { authenticate: async () => current }, marketplace });
  try {
    const response = await app.inject({ method: "GET", url: "/business-conversations" });
    expect(response.statusCode).toBe(200);
    const rows = response.json() as Array<{ title: string; businessId: string; businessName: string }>;
    expect(rows.map((row) => [row.title, row.businessName]).sort()).toEqual([["Bread plan", "Alice Bakery"], ["Menu", "Alice Cafe"]]);
    expect(JSON.stringify(rows)).not.toContain("Bob");
    current = bob;
    expect((await app.inject({ method: "GET", url: "/business-conversations" })).json()).toHaveLength(1);
  } finally { await app.close(); }
});
