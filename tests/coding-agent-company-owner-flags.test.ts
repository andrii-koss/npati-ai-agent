import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { FeatureFlagService } from "../apps/agent-api/src/feature-flags";
import { registerCodeRoutes } from "../apps/agent-api/src/code-routes";
import { CodeService } from "../apps/agent-api/src/code-service";
import { ProjectService } from "../apps/agent-api/src/project-service";

const creator: AuthContext = {
  userId: "account-user", externalSubject: "npati:account-user", workspaceId: "workspace:account-user",
  permissions: ["workspace:read", "workspace:write", "business:manage", "chat:use"],
};

async function fixture() {
  const store = new InMemoryWorkspaceStore();
  const company = await store.createCompany(creator, { name: "Owner company" }, "create");
  const flags = new FeatureFlagService(store);
  const workspace = { readFile: async () => { throw { code: "ENOENT" }; } } as never;
  const service = new CodeService(store, new ProjectService(store), workspace, undefined, undefined, undefined, flags);
  const app = Fastify();
  registerCodeRoutes(app, { authenticate: async () => creator } as never, service, flags);
  return { store, company, flags, service, app };
}

describe("company owner coding flag management", () => {
  it("persists a creator membership without granting account-wide admin permissions", async () => {
    const { store, company, flags, app } = await fixture();
    try {
      expect(await store.getCompanyMembership(company.id, creator.userId)).toMatchObject({ role: "owner", status: "active" });
      expect(await flags.canManage(creator, company.id)).toBe(true);
      expect(await flags.canManage(creator)).toBe(false);
      expect(creator.permissions).not.toContain("admin:all");
      const view = await app.inject({ method: "GET", url: `/companies/${company.id}/code/flags` });
      expect(view.json().management).toEqual({ company: true, global: false });
    } finally { await app.close(); }
  });

  it("lets a company owner enable the agent and create projects with an ordinary user JWT context", async () => {
    const { company, flags, app } = await fixture();
    try {
      for (const flagKey of ["coding_agent.enabled", "code.write"]) {
        const saved = await app.inject({ method: "PUT", url: `/companies/${company.id}/code/flags`,
          payload: { scope: "company", scopeId: company.id, flagKey, stage: "internal", enabled: true } });
        expect(saved.statusCode, saved.body).toBe(200);
      }
      // Evaluation uses the original unprivileged context in both API and chat, not a fabricated admin.
      expect(await flags.isEnabled(creator, "code.write", { companyId: company.id })).toBe(true);
      const project = await app.inject({ method: "POST", url: `/companies/${company.id}/code/projects`, payload: { name: "Working project" } });
      expect(project.statusCode, project.body).toBe(201);
    } finally { await app.close(); }
  });

  it("denies global flags and changing a different company through the current company's route", async () => {
    const { company, app } = await fixture();
    try {
      const global = await app.inject({ method: "PUT", url: `/companies/${company.id}/code/flags`,
        payload: { scope: "global", flagKey: "coding_agent.enabled", stage: "internal", enabled: true } });
      expect(global.statusCode).toBe(403);
      const foreign = await app.inject({ method: "PUT", url: `/companies/${company.id}/code/flags`,
        payload: { scope: "company", scopeId: "other-company", flagKey: "code.write", stage: "internal", enabled: true } });
      expect(foreign.statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it("keeps the global kill switch authoritative and permits the owner to stop their company", async () => {
    const { company, flags, app } = await fixture();
    const admin = { ...creator, permissions: [...creator.permissions, "admin:all"] };
    try {
      await flags.setFlag(admin, { scope: "global", flagKey: "coding_agent.enabled", stage: "off", enabled: false });
      await flags.setFlag(creator, { scope: "company", scopeId: company.id, flagKey: "coding_agent.enabled", stage: "internal", enabled: true });
      expect(await flags.isEnabled(creator, "coding_agent.enabled", { companyId: company.id })).toBe(false);
      const stopped = await app.inject({ method: "POST", url: `/companies/${company.id}/code/flags/kill-switch`, payload: { scope: "company" } });
      expect(stopped.statusCode, stopped.body).toBe(200);
      const global = await app.inject({ method: "POST", url: `/companies/${company.id}/code/flags/kill-switch`, payload: { scope: "global" } });
      expect(global.statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it("does not let suspended or unrecorded membership, API keys or agent identities manage flags", async () => {
    const { company, flags, store, app } = await fixture();
    try {
      const membership = await store.getCompanyMembership(company.id, creator.userId);
      vi.spyOn(store, "getCompanyMembership").mockResolvedValueOnce({ ...membership!, status: "suspended" }).mockResolvedValueOnce(null);
      expect(await flags.canManage(creator, company.id)).toBe(false);
      expect(await flags.canManage(creator, company.id)).toBe(false);
      for (const externalSubject of ["npati:apikey:key", "npati:remote:token", "agent:worker", "service:worker"]) {
        const ctx = { ...creator, externalSubject, permissions: [...creator.permissions, "admin:all"] };
        expect(await flags.canManage(ctx, company.id)).toBe(false);
        await expect(flags.setFlag(ctx, { scope: "company", scopeId: company.id, flagKey: "code.write", stage: "internal", enabled: true })).rejects.toMatchObject({ code: "flag_admin_required" });
      }
    } finally { await app.close(); }
  });

  it("records company ownership once and preserves an existing role on creation retries", async () => {
    const { company, store, app } = await fixture();
    try {
      const before = await store.getCompanyMembership(company.id, creator.userId);
      await store.createCompany(creator, { name: "Ignored on retry" }, "create");
      expect(await store.getCompanyMembership(company.id, creator.userId)).toEqual(before);
      expect((await store.listCompanyMembers(company.id))).toHaveLength(1);
    } finally { await app.close(); }
  });

  it("does not reuse a human owner's enabled internal flags for an API key with the same user ID", async () => {
    const { company, flags, app } = await fixture();
    try {
      for (const flagKey of ["coding_agent.enabled", "code.write"]) {
        await flags.setFlag(creator, { scope: "company", scopeId: company.id, flagKey, stage: "internal", enabled: true });
      }
      expect(await flags.isEnabled(creator, "code.write", { companyId: company.id })).toBe(true);
      const key = { ...creator, companyId: company.id, externalSubject: "npati:apikey:key" };
      expect(await flags.isEnabled(key, "code.write", { companyId: company.id })).toBe(false);
    } finally { await app.close(); }
  });
});
