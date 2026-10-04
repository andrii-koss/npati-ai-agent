import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { DataBackendService } from "../apps/agent-api/src/data-studio/service";
import { registerDataBackendRoutes } from "../apps/agent-api/src/data-studio/routes";
import type { DataBackendRepository } from "../apps/agent-api/src/data-studio/repository";
import type { DatabaseProvisioner } from "../apps/agent-api/src/data-studio/provisioner";

describe("DataBackend control-plane routes", () => {
  it("denies a Project from another Company before repository attach", async () => {
    const store = new InMemoryWorkspaceStore();
    const ownerA: AuthContext = { workspaceId: "tenant", userId: "owner-a", permissions: ["workspace:read", "business:manage"] };
    const ownerB: AuthContext = { workspaceId: "tenant", userId: "owner-b", permissions: ["workspace:read", "business:manage"] };
    const companyA = await store.createCompany(ownerA, { name: "A" }, "company-a");
    const companyB = await store.createCompany(ownerB, { name: "B" }, "company-b");
    const projectB = (await store.createProject(ownerB, companyB.id, { name: "Site B", type: "website" }, "project-b")).project;
    let attached = false;
    const repository = {
      get: async () => ({ id: "backend-a", companyId: companyA.id }),
      attach: async () => { attached = true; return "backend-a"; },
    } as unknown as DataBackendRepository;
    const service = new DataBackendService(store, repository, {} as DatabaseProvisioner);
    const app = Fastify();
    registerDataBackendRoutes(app, { authenticate: async () => ownerA }, service);
    const response = await app.inject({ method: "PUT", url: "/companies/" + companyA.id + "/projects/" + projectB.id + "/data-backend",
      payload: { dataBackendId: "12345678-1234-1234-1234-123456789012" } });
    expect(response.statusCode).toBe(404);
    expect(attached).toBe(false);
    await app.close();
  });

  it("leaves NPATI routes available when Data Studio is disabled", async () => {
    const app = Fastify();
    const owner: AuthContext = { workspaceId: "tenant", userId: "owner", permissions: ["workspace:read", "business:manage"] };
    registerDataBackendRoutes(app, { authenticate: async () => owner });
    const response = await app.inject({ method: "GET", url: "/companies/anything/data-backends" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("DATA_STUDIO_UNAVAILABLE");
    await app.close();
  });
});
