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
import { ProjectSandboxService } from "../apps/agent-api/src/project-sandbox-service";
import { ProjectTerminalEventsRepository } from "../apps/agent-api/src/project-terminal-events";
import { SandboxProviderError, type SandboxProvider, type SandboxScope, type SandboxStatus, type SandboxCommandResult, type SandboxFile } from "../apps/agent-api/src/sandbox-provider";
import { registerProjectTerminalRoutes } from "../apps/agent-api/src/project-terminal-routes";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const owner: AuthContext = { workspaceId: "tenant-a", userId: "user-a", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
const other: AuthContext = { ...owner, userId: "user-b" };
const result = (status: SandboxCommandResult["status"] = "completed", exitCode = 0, stdout = ""): SandboxCommandResult => ({ status, exitCode, stdout, stderr: "", durationMs: 4, step: "command", tool: "project.terminal.exec", retryable: status === "timed_out" });
class FakeSandbox implements SandboxProvider {
  readonly id = "11111111-1111-4111-8111-111111111111";
  state: SandboxStatus["state"] = "created";
  files: SandboxFile[] = [];
  commandResult = result();
  creationFailure = false;
  calls: string[] = [];
  private status(): SandboxStatus { return { id: this.id, state: this.state, createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() }; }
  private check(scope: SandboxScope, id: string) { if (id !== this.id || !scope.projectId || !scope.companyId) throw new SandboxProviderError("sandbox_scope_denied", "Sandbox scope denied", 403); }
  async createSandbox(_scope: SandboxScope) { if (this.creationFailure) throw new SandboxProviderError("sandbox_creation_failed", "Sandbox creation failed"); this.calls.push("create"); return this.status(); }
  async startSandbox(scope: SandboxScope, id: string) { this.check(scope, id); this.state = "running"; this.calls.push("start"); return this.status(); }
  async stopSandbox(scope: SandboxScope, id: string) { this.check(scope, id); this.state = "stopped"; this.calls.push("stop"); return this.status(); }
  async destroySandbox(scope: SandboxScope, id: string) { this.check(scope, id); this.state = "destroyed"; this.calls.push("destroy"); }
  async getStatus(scope: SandboxScope, id: string) { this.check(scope, id); return this.status(); }
  async uploadFiles(scope: SandboxScope, id: string, files: SandboxFile[]) { this.check(scope, id); this.files = files; this.calls.push("upload"); }
  async downloadFiles(scope: SandboxScope, id: string) { this.check(scope, id); this.calls.push("download"); return this.files; }
  async executeCommand(scope: SandboxScope, id: string, command: string) { this.check(scope, id); this.calls.push(command); if (command === "npm run build") this.files = [{ path: "generated.html", content: "<h1>built</h1>" }]; return this.commandResult; }
  async exposePort(): Promise<{ port: number; internalHost: string }> { throw new Error("unavailable"); }
  async getLogs(scope: SandboxScope, id: string) { this.check(scope, id); return "runner logs"; }
  async startProcess(scope: SandboxScope, id: string, command: string) { this.check(scope, id); this.calls.push("process:" + command); return { ...result(), processId: "22222222-2222-4222-8222-222222222222" }; }
  async stopProcess(scope: SandboxScope, id: string) { this.check(scope, id); return result(); }
  async getProcessStatus(scope: SandboxScope, id: string) { this.check(scope, id); return result(); }
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "npati-terminal-")); roots.push(root);
  const store = new InMemoryWorkspaceStore(); await store.initialize();
  let company = await store.createCompany(owner, { name: "Site Company" }, "terminal-company");
  const otherCompany = await store.createCompany(other, { name: "Other Company" }, "other-terminal-company");
  const projects = new ProjectService(store);
  const { project } = await projects.create(owner, company.id, { name: "Site", type: "website" }, "terminal-project");
  const workspace = new LocalProjectWorkspace(projects, { root });
  const provider = new FakeSandbox();
  const events = new ProjectTerminalEventsRepository(projects);
  const sandbox = new ProjectSandboxService(projects, store, workspace, provider, events);
  return { store, company, otherCompany, project, projects, workspace, provider, events, sandbox };
}
describe("Project terminal integration", () => {
  it("registers Terminal capabilities in the inspector", () => {
    const report = new CapabilityInspectorService().inspect("all");
    for (const id of ["project.terminal.exec", "project.terminal.process"]) {
      expect(defaultCapabilityRegistry.get(id)).toMatchObject({ id, agentCallable: true, risk: "high", requiresConfirmation: true });
      expect(report.items.find((item) => item.capabilityId === id)).toBeDefined();
    }
  });
  it("denies agents without Terminal and prevents sandbox or tenant substitution", async () => {
    const { store, company, otherCompany, project, provider, sandbox } = await fixture();
    const agent = await store.createCompanyAgent(owner, company.id, { name: "Reader", role: "Reader", tools: ["project.files.read"] }, "terminal-reader");
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "pwd", agentId: agent.id })).rejects.toMatchObject({ code: "terminal_permission_denied" });
    const permitted = await store.createCompanyAgent(owner, company.id, { name: "Builder", role: "Developer", tools: ["project.terminal.exec"] }, "terminal-builder");
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, sandboxId: "33333333-3333-4333-8333-333333333333", command: "pwd", agentId: permitted.id })).rejects.toMatchObject({ code: "sandbox_mismatch" });
    await expect(sandbox.execute(owner, otherCompany.id, { projectId: project.id, command: "pwd", agentId: permitted.id })).rejects.toThrow();
    await expect(sandbox.execute(other, company.id, { projectId: project.id, command: "pwd", agentId: permitted.id })).rejects.toThrow();
    expect(provider.calls).not.toContain("pwd");
  });
  it("uses ordinary Company Run approval and syncs generated files", async () => {
    const { store, project, workspace, provider, events, sandbox } = await fixture();
    let company = await store.getCompany(owner, project.companyId);
    await workspace.createFile(owner, company.id, project.id, "package.json", '{"scripts":{"build":"echo built"}}');
    const agent = await store.createCompanyAgent(owner, company.id, { name: "Builder", role: "Developer", tools: ["project.terminal.exec"] }, "terminal-exec-agent");
    company = await store.setCompanyMainAgent(owner, company.id, agent.id, company.revision);
    let command = "npm install";
    let environmentReferences: Record<string, { id: string; field: string }> | undefined;
    const ai = { executeTool: vi.fn(), ensureA2AEnabled: vi.fn(), ensureCombo: vi.fn(async (input: { name: string }) => ({ name: input.name })),
      a2aSend: vi.fn(async () => ({ taskId: "plan", content: JSON.stringify({ mode: "single", agentIds: [agent.id], toolRequests: [{ agentId: agent.id, tool: "project.terminal.exec", input: { projectId: project.id, command, environmentReferences } }] }), metadata: {} })),
      chat: vi.fn(async () => ({ content: "done", model: "auto" })) } as unknown as AIEngine;
    const tools = new CompanyToolRuntime(ai, undefined, undefined, undefined, undefined, undefined, undefined, undefined, workspace, store, sandbox);
    const approvals: DurableApprovalGateway = { requestApproval: vi.fn(async () => ({ id: "terminal-approval" })), consumeApproved: vi.fn(async () => undefined) };
    const runtime = new CompanyDelegationRuntime(store, ai, 10_000, tools, undefined, undefined, undefined, undefined, approvals);
    const controlled = await runtime.execute(owner, company.id, { task: "Install dependencies", mode: "single" }, "terminal-install-run");
    expect(controlled.run.status, JSON.stringify(controlled.run)).toBe("completed");
    expect(provider.calls).toContain("npm install");
    command = "echo built && rm -rf ./";
    const pending = await runtime.execute(owner, company.id, { task: "Clean build", mode: "single" }, "terminal-approval-run");
    expect(pending.run.errorCode).toBe("APPROVAL_REQUIRED");
    expect(provider.calls).not.toContain(command);
    expect(JSON.stringify((approvals.requestApproval as any).mock.calls)).not.toContain(command);
    const resumed = await runtime.process(owner, company.id, pending.run.id, { approvalId: "terminal-approval" });
    expect(resumed.run.status).toBe("completed");
    expect(provider.calls).toContain(command);
    expect(JSON.stringify(await events.list(owner, company.id, project.id))).not.toContain(command);
    command = "echo denied";
    const deniedPending = await runtime.execute(owner, company.id, { task: "Denied command", mode: "single" }, "terminal-denied-run");
    expect(deniedPending.run.errorCode).toBe("APPROVAL_REQUIRED");
    vi.mocked(approvals.consumeApproved).mockRejectedValueOnce(new Error("Approval denied"));
    const denied = await runtime.process(owner, company.id, deniedPending.run.id, { approvalId: "terminal-approval" });
    expect(denied.run.status).toBe("failed");
    expect(provider.calls).not.toContain(command);
    command = "pwd";
    environmentReferences = { API_TOKEN: { id: "44444444-4444-4444-8444-444444444444", field: "token" } };
    const credentialPending = await runtime.execute(owner, company.id, { task: "Use credential", mode: "single" }, "terminal-credential-run");
    expect(credentialPending.run.errorCode).toBe("APPROVAL_REQUIRED");
    expect(JSON.stringify((approvals.requestApproval as any).mock.calls)).not.toContain("44444444-4444-4444-8444-444444444444");
    expect(provider.calls.filter((call) => call === "pwd")).toHaveLength(0);
    environmentReferences = undefined;
    command = "npm run build";
    const built = await runtime.execute(owner, company.id, { task: "Build the project", mode: "single" }, "terminal-build-run");
    expect(built.run.status).toBe("completed");
    expect((await workspace.readFile(owner, company.id, project.id, "generated.html")).content).toContain("built");
    expect((await events.list(owner, company.id, project.id)).length).toBeGreaterThan(0);
  });
  it("runs process start, status, logs, and stop without approval for safe actions", async () => {
    const { store, project, workspace, provider, sandbox } = await fixture();
    let company = await store.getCompany(owner, project.companyId);
    const agent = await store.createCompanyAgent(owner, company.id, { name: "Builder", role: "Developer", tools: ["project.terminal.process"] }, "terminal-process-agent");
    company = await store.setCompanyMainAgent(owner, company.id, agent.id, company.revision);
    const processId = "22222222-2222-4222-8222-222222222222";
    let input: Record<string, unknown> = { projectId: project.id, action: "start", command: "npm run build" };
    const ai = { executeTool: vi.fn(), ensureA2AEnabled: vi.fn(), ensureCombo: vi.fn(async (value: { name: string }) => ({ name: value.name })),
      a2aSend: vi.fn(async () => ({ taskId: "plan", content: JSON.stringify({ mode: "single", agentIds: [agent.id], toolRequests: [{ agentId: agent.id, tool: "project.terminal.process", input }] }), metadata: {} })),
      chat: vi.fn(async () => ({ content: "done", model: "auto" })) } as unknown as AIEngine;
    const approvals: DurableApprovalGateway = { requestApproval: vi.fn(async () => ({ id: "unexpected" })), consumeApproved: vi.fn(async () => undefined) };
    const runtime = new CompanyDelegationRuntime(store, ai, 10_000, new CompanyToolRuntime(ai, undefined, undefined, undefined, undefined, undefined, undefined, undefined, workspace, store, sandbox), undefined, undefined, undefined, undefined, approvals);
    expect((await runtime.execute(owner, company.id, { task: "Start build", mode: "single" }, "process-start-run")).run.status).toBe("completed");
    for (const action of ["status", "logs", "stop"] as const) {
      input = { projectId: project.id, action, processId };
      expect((await runtime.execute(owner, company.id, { task: action + " build", mode: "single" }, "process-" + action + "-run")).run.status).toBe("completed");
    }
    expect(provider.calls).toContain("process:npm run build");
    expect(approvals.requestApproval).not.toHaveBeenCalled();
  });
  it("reports timeout, install failure, missing command, runner failure, and redacts secret output", async () => {
    const { store, company, project, provider, sandbox, events } = await fixture();
    const agent = await store.createCompanyAgent(owner, company.id, { name: "Builder", role: "Developer", tools: ["project.terminal.exec"] }, "terminal-error-agent");
    provider.creationFailure = true;
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "pwd", agentId: agent.id })).rejects.toMatchObject({ code: "sandbox_creation_failed" });
    provider.creationFailure = false;
    provider.commandResult = result("timed_out", 124);
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "npm run build", agentId: agent.id })).rejects.toMatchObject({ code: "command_timeout", status: 504, step: "install_build", tool: "project.terminal.exec", retryable: true });
    provider.commandResult = result("failed", 1);
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "npm install", agentId: agent.id })).rejects.toMatchObject({ code: "install_failed" });
    provider.commandResult = result("failed", 127);
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "unknowncmd", agentId: agent.id, approved: true })).rejects.toMatchObject({ code: "command_not_found" });
    provider.commandResult = result("completed", 0, "password=top-secret-value");
    await sandbox.execute(owner, company.id, { projectId: project.id, command: "pwd", agentId: agent.id });
    expect(JSON.stringify(await events.list(owner, company.id, project.id))).not.toContain("top-secret-value");
  });
  it("keeps vault values out of output, events, and returned results", async () => {
    const { store, company, project, workspace, provider, events, projects } = await fixture();
    const agent = await store.createCompanyAgent(owner, company.id, { name: "Builder", role: "Developer", tools: ["project.terminal.exec"] }, "terminal-vault-agent");
    provider.commandResult = result("completed", 0, "PRIVATE_VALUE_1234");
    const vault = { resolve: vi.fn(async () => ({ token: "PRIVATE_VALUE_1234" })) };
    const secure = new ProjectSandboxService(projects, store, workspace, provider, events, vault);
    const response = await secure.execute(owner, company.id, { projectId: project.id, command: "pwd", agentId: agent.id, approved: true, environmentReferences: { API_TOKEN: { id: "44444444-4444-4444-8444-444444444444", field: "token" } } });
    expect(response.stdout).not.toContain("PRIVATE_VALUE_1234");
    expect(JSON.stringify(await events.list(owner, company.id, project.id))).not.toContain("PRIVATE_VALUE_1234");
    expect(vault.resolve).toHaveBeenCalledWith(owner, company.id, "44444444-4444-4444-8444-444444444444");
  });
  it("preserves optimistic revision conflicts when a file changes during execution", async () => {
    const { store, company, project, workspace, provider, sandbox } = await fixture();
    const agent = await store.createCompanyAgent(owner, company.id, { name: "Builder", role: "Developer", tools: ["project.terminal.exec"] }, "terminal-revision-agent");
    const original = await workspace.createFile(owner, company.id, project.id, "index.html", "before");
    provider.executeCommand = async () => {
      await workspace.writeFile(owner, company.id, project.id, "index.html", "concurrent", original.revision);
      provider.files = [{ path: "index.html", content: "sandbox edit" }];
      return result();
    };
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "pwd", agentId: agent.id })).rejects.toMatchObject({ code: "revision_conflict", status: 409, currentRevision: expect.any(String) });
    expect((await workspace.readFile(owner, company.id, project.id, "index.html")).content).toBe("concurrent");
  });
  it("checks runner activity before stopping an idle sandbox", async () => {
    const { store, company, project, provider, sandbox } = await fixture();
    const agent = await store.createCompanyAgent(owner, company.id, { name: "Builder", role: "Developer", tools: ["project.terminal.exec"] }, "terminal-idle-agent");
    await sandbox.execute(owner, company.id, { projectId: project.id, command: "pwd", agentId: agent.id });
    const now = Date.now();
    vi.spyOn(provider, "getStatus").mockResolvedValue({ id: provider.id, state: "running", createdAt: new Date(now).toISOString(), lastActivityAt: new Date(now + 850_000).toISOString() });
    await sandbox.stopInactive(now + 950_000);
    expect(provider.calls).not.toContain("stop");
    await sandbox.stopInactive(now + 1_800_000);
    expect(provider.calls).toContain("stop");
  });
  it("destroys a sandbox before Project archive and deletion", async () => {
    const { store, company, project, provider, sandbox } = await fixture();
    const agent = await store.createCompanyAgent(owner, company.id, { name: "Builder", role: "Developer", tools: ["project.terminal.exec"] }, "terminal-lifecycle-agent");
    await sandbox.execute(owner, company.id, { projectId: project.id, command: "pwd", agentId: agent.id });
    const hooked = new ProjectService(store, (context, current) => sandbox.destroy(context, current));
    const current = await hooked.get(owner, company.id, project.id);
    const archived = await hooked.archive(owner, company.id, project.id, current.revision);
    expect(archived.status).toBe("archived");
    expect(archived.sandboxId).toBeUndefined();
    expect(provider.calls).toContain("destroy");
    await hooked.delete(owner, company.id, project.id);
  });
  it("serves read-only Terminal and Logs with project authorization", async () => {
    const { company, otherCompany, project, events, sandbox } = await fixture();
    const app = Fastify(); let context = owner;
    registerProjectTerminalRoutes(app, { authenticate: async () => context }, events, sandbox);
    const base = `/companies/${company.id}/projects/${project.id}/terminal`;
    expect((await app.inject({ method: "GET", url: base + "/events" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/companies/${otherCompany.id}/projects/${project.id}/terminal/events` })).statusCode).toBe(403);
    context = other;
    expect((await app.inject({ method: "GET", url: base + "/logs" })).statusCode).toBe(403);
    await app.close();
  });
});