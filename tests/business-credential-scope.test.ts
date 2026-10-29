import { expect, it } from "vitest";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";

const owner: AuthContext = { userId: "scope-owner", workspaceId: "scope-ws", permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"] };
const marketplace = { marketplace: async () => ({ overview: { connectedProviders: 1 } }) } as unknown as OmniRouteMarketplace;

it("a company-scoped credential reaches only the Business linked to its company", async () => {
  const store = new InMemoryWorkspaceStore();
  const linked = await store.createBusiness(owner, { name: "Linked Bakery" }, "linked");
  const other = await store.createBusiness(owner, { name: "Other Bakery" }, "other");
  let company = await store.createCompany(owner, { name: "Keyed Studio" }, "keyed");
  company = await store.updateCompany(owner, company.id, { businessId: linked.id }, company.revision);
  // As the API key and remote token paths build it: the owner's identity, limited to one company.
  const key: AuthContext = { ...owner, permissions: ["workspace:read", "business:manage"], companyId: company.id };
  const app = buildApp({ workspaceStore: store, aiEngine: {} as AIEngine, marketplace, authProvider: { authenticate: async () => key } });
  try {
    const list = await app.inject({ method: "GET", url: "/businesses" });
    expect(list.json().map((item: { id: string }) => item.id)).toEqual([linked.id]);
    expect((await app.inject({ method: "GET", url: `/businesses/${linked.id}` })).statusCode).toBe(200);
    for (const [method, url, payload] of [["GET", `/businesses/${other.id}`], ["GET", `/businesses/${other.id}/goals`], ["GET", `/businesses/${other.id}/memory`],
      ["PATCH", `/businesses/${other.id}`, { name: "Taken" }], ["POST", `/businesses/${other.id}/goals`, { title: "Taken" }], ["DELETE", `/businesses/${other.id}`],
      ["POST", "/businesses", { name: "Key-made Business" }]] as const) {
      const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await store.getUserBusiness(owner, other.id)).name).toBe("Other Bakery");
    expect(await store.listGoals(owner, other.id)).toEqual([]);
    expect((await store.listUserBusinesses(owner)).map(item => item.name).sort()).toEqual(["Linked Bakery", "Other Bakery"]);
    expect((await store.listUserBusinesses(key)).map(item => item.id)).toEqual([linked.id]);
  } finally { await app.close(); }
});
