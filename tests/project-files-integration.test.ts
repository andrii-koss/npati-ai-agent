import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CapabilityInspectorService, defaultCapabilityRegistry } from "@npati/shared";
import type { AIEngine } from "@npati/omniroute-adapter";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { LocalProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import { CompanyToolRuntime } from "../apps/agent-api/src/company-tool-runtime";
import { CompanyDelegationRuntime, type DurableApprovalGateway } from "../apps/agent-api/src/company-runtime";
import { registerProjectFileRoutes } from "../apps/agent-api/src/project-file-routes";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const owner: AuthContext = { workspaceId: "tenant-a", userId: "user-a", permissions: ["workspace:read", "business:manage"] };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "npati-project-integration-")); roots.push(root);
  const store = new InMemoryWorkspaceStore(); await store.initialize();
  let company = await store.createCompany(owner, { name: "Project Company" }, "project-company");
  const otherCompany = await store.createCompany({ ...owner, userId: "user-b" }, { name: "Other Company" }, "other-company");
  const projects = new ProjectService(store);
  const { project } = await projects.create(owner, company.id, { name: "Site", type: "website" }, "project-site");
  const workspace = new LocalProjectWorkspace(projects, { root });
  return { store, company, otherCompany, project, workspace };
}
function toolRuntime(store: InMemoryWorkspaceStore, workspace: LocalProjectWorkspace) {
  return new CompanyToolRuntime({ executeTool: vi.fn() } as unknown as AIEngine, undefined, undefined, undefined, undefined, undefined, undefined, undefined, workspace, store);
}
describe("Project file capabilities", () => {
  it("denies agents without Project Read or Project Write", async () => {
    const { store, company, project, workspace } = await fixture();
    const reader = await store.createCompanyAgent(owner, company.id, { name: "Reader", role: "Reader", tools: ["project.files.read"] }, "reader-agent");
    const writer = await store.createCompanyAgent(owner, company.id, { name: "Writer", role: "Writer", tools: ["project.files.create"] }, "writer-agent");
    const tools = toolRuntime(store, workspace), signal = new AbortController().signal;
    await expect(tools.execute(owner, company, "project.files.create", { projectId: project.id, path: "a.txt", content: "a", __npatiAgentId: reader.id }, signal)).rejects.toThrow("permission");
    await tools.execute(owner, company, "project.files.create", { projectId: project.id, path: "a.txt", content: "a", __npatiAgentId: writer.id }, signal);
    await expect(tools.execute(owner, company, "project.files.read", { projectId: project.id, path: "a.txt", __npatiAgentId: writer.id }, signal)).rejects.toThrow("permission");
    for (const action of ["write", "edit", "delete"]) await expect(tools.execute(owner, company, `project.files.${action}`, { projectId: project.id, path: "a.txt", __npatiAgentId: reader.id }, signal)).rejects.toThrow("permission");
    await expect(tools.execute(owner, company, "project.files.create", { projectId: project.id, path: "b.txt", content: "a", workspaceId: "forged", __npatiAgentId: writer.id }, signal)).rejects.toMatchObject({ code: "workspace_mismatch" });
  });
  it("creates and edits through ordinary Company Runs and shows files through the UI API", async () => {
    const { store, project, workspace } = await fixture();
    let company = await store.getCompany(owner, project.companyId);
    const agent = await store.createCompanyAgent(owner, company.id, { name: "Builder", role: "Developer", tools: ["project.files.create", "project.files.edit", "project.files.read"] }, "builder-agent");
    company = await store.setCompanyMainAgent(owner, company.id, agent.id, company.revision);
    let request = { agentId: agent.id, tool: "project.files.create", input: { projectId: project.id, path: "index.html", content: "<h1>First</h1>" } };
    const ai = { executeTool: vi.fn(), ensureA2AEnabled: vi.fn(), ensureCombo: vi.fn(async (input: { name: string }) => ({ name: input.name })),
      a2aSend: vi.fn(async () => ({ taskId: "plan", content: JSON.stringify({ mode: "single", agentIds: [agent.id], toolRequests: [request] }), metadata: {} })),
      chat: vi.fn(async () => ({ content: "done", model: "auto" })) } as unknown as AIEngine;
    const runtime = new CompanyDelegationRuntime(store, ai, 10_000, toolRuntime(store, workspace));
    const first = await runtime.execute(owner, company.id, { task: "Create an index file", mode: "single" }, "site-create-run");
    expect(first.run.status).toBe("completed");
    const created = await workspace.readFile(owner, company.id, project.id, "index.html");
    request = { agentId: agent.id, tool: "project.files.edit", input: { projectId: project.id, path: "index.html", find: "First", replacement: "Second", expectedRevision: created.revision } };
    const second = await runtime.execute(owner, company.id, { task: "Edit the index file", mode: "single" }, "site-edit-run");
    expect(second.run.status).toBe("completed");
    expect((await workspace.readFile(owner, company.id, project.id, "index.html")).content).toContain("Second");
    expect(JSON.stringify(second.toolAudit)).not.toContain("Second");
    const app = Fastify();
    registerProjectFileRoutes(app, workspace, { authenticate: async () => owner });
    const base = `/companies/${company.id}/projects/${project.id}/files`;
    expect((await app.inject({ method: "GET", url: base + "/tree" })).json().files).toMatchObject([{ path: "index.html", type: "file" }]);
    expect((await app.inject({ method: "GET", url: base + "/search?query=index" })).json().files).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: base + "/read?path=index.html" })).json().content).toContain("Second");
    await app.close();
  });
  it("requires approval for mass delete and rejects cross-tenant file APIs", async () => {
    const { store, company, otherCompany, project, workspace } = await fixture();
    await workspace.createFile(owner, company.id, project.id, "one.txt", "one");
    await workspace.createFile(owner, company.id, project.id, "two.txt", "two");
    const agent = await store.createCompanyAgent(owner, company.id, { name: "Cleaner", role: "Developer", tools: ["project.files.delete"] }, "delete-agent");
    const main = await store.getCompany(owner, company.id);
    await store.setCompanyMainAgent(owner, company.id, agent.id, main.revision);
    const approvals: DurableApprovalGateway = { requestApproval: vi.fn(async () => ({ id: "approved-id" })), consumeApproved: vi.fn(async () => undefined) };
    const ai = { executeTool: vi.fn(), ensureA2AEnabled: vi.fn(), ensureCombo: vi.fn(async (input: { name: string }) => ({ name: input.name })),
      a2aSend: vi.fn(async () => ({ taskId: "plan", content: JSON.stringify({ mode: "single", agentIds: [agent.id], toolRequests: [{ agentId: agent.id, tool: "project.files.delete", input: { projectId: project.id, paths: ["one.txt", "two.txt"] } }] }), metadata: {} })),
      chat: vi.fn(async () => ({ content: "done", model: "auto" })) } as unknown as AIEngine;
    const runtime = new CompanyDelegationRuntime(store, ai, 10_000, toolRuntime(store, workspace), undefined, undefined, undefined, undefined, approvals);
    const pending = await runtime.execute(owner, company.id, { task: "Delete project files", mode: "single" }, "site-delete-run");
    expect(pending.run.errorCode).toBe("APPROVAL_REQUIRED");
    expect((await workspace.listFiles(owner, company.id, project.id))).toHaveLength(2);
    expect(approvals.requestApproval).toHaveBeenCalledOnce();
    expect(approvals.requestApproval).toHaveBeenCalledWith(owner, company.id, expect.objectContaining({ riskLevel: "high", toolName: "project.files.delete" }));
    const resumed = await runtime.process(owner, company.id, pending.run.id, { approvalId: "approved-id" });
    expect(resumed.run.status).toBe("completed");
    expect((await workspace.listFiles(owner, company.id, project.id))).toHaveLength(0);
    const app = Fastify();
    let context = owner;
    registerProjectFileRoutes(app, workspace, { authenticate: async () => context });
    const own = `/companies/${company.id}/projects/${project.id}/files/tree`;
    expect((await app.inject({ method: "GET", url: `/companies/${otherCompany.id}/projects/${project.id}/files/tree` })).statusCode).toBe(403);
    context = { ...owner, userId: "user-b" };
    expect((await app.inject({ method: "GET", url: own })).statusCode).toBe(403);
    context = owner;
    expect((await app.inject({ method: "GET", url: own + "?workspaceId=forged" })).statusCode).toBe(403);
    await app.close();
  });
  it("registers all file capabilities in the canonical registry and inspector", () => {
    const actions = ["list", "read", "search", "create", "write", "edit", "move", "delete"];
    const report = new CapabilityInspectorService().inspect("all");
    for (const action of actions) {
      const id = `project.files.${action}`;
      const definition = defaultCapabilityRegistry.get(id);
      expect(definition).toMatchObject({ id, type: "tool", domain: "files", agentCallable: true, requiresConfirmation: action === "delete" });
      expect(definition?.risk).toBe(action === "delete" ? "high" : ["create", "write", "edit", "move"].includes(action) ? "medium" : "low");
      expect(definition?.requiredPermissions).toEqual([["list", "read", "search"].includes(action) ? "workspace:read" : "workspace:write"]);
      expect(report.items.find((item) => item.capabilityId === id)).toMatchObject({ capabilityId: id, risk: definition?.risk });
    }
  });
});

