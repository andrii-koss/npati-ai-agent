import { createShellSandboxPortWiring } from "../apps/agent-api/src/shell-sandbox-port-wiring";
import Fastify from "fastify";
import { toFailure } from "../apps/agent-api/src/code-tool-runtime-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  workingDirectories: string[] = [];
  private status(): SandboxStatus { return { id: this.id, state: this.state, createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() }; }
  private check(scope: SandboxScope, id: string) { if (id !== this.id || !scope.projectId || !scope.companyId) throw new SandboxProviderError("sandbox_scope_denied", "Sandbox scope denied", 403); }
  async createSandbox(_scope: SandboxScope) { if (this.creationFailure) throw new SandboxProviderError("sandbox_creation_failed", "Sandbox creation failed"); this.calls.push("create"); return this.status(); }
  async startSandbox(scope: SandboxScope, id: string) { this.check(scope, id); this.state = "running"; this.calls.push("start"); return this.status(); }
  async stopSandbox(scope: SandboxScope, id: string) { this.check(scope, id); this.state = "stopped"; this.calls.push("stop"); return this.status(); }
  async destroySandbox(scope: SandboxScope, id: string) { this.check(scope, id); this.state = "destroyed"; this.calls.push("destroy"); }
  async getStatus(scope: SandboxScope, id: string) { this.check(scope, id); return this.status(); }
  async uploadFiles(scope: SandboxScope, id: string, files: SandboxFile[]) { this.check(scope, id); this.files = files; this.calls.push("upload"); }
  async downloadFiles(scope: SandboxScope, id: string) { this.check(scope, id); this.calls.push("download"); return this.files; }
  async executeCommand(scope: SandboxScope, id: string, command: string, options?: { cwd?: string }) { this.check(scope, id); this.calls.push(command); this.workingDirectories.push(options?.cwd ?? "."); if (command === "npm run build") this.files = [{ path: "generated.html", content: "<h1>built</h1>" }]; return this.commandResult; }
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
  return { root, store, company, otherCompany, project, projects, workspace, provider, events, sandbox };
}
describe("Project terminal integration", () => {
  it("syncs unchanged production SDK and new typed account fields after dependency installation", async () => {
    const { company, project, workspace, provider, sandbox } = await fixture();
    const sdk = await readFile("packages/project-client/src/index.ts", "utf8");
    const original = await workspace.createFile(owner, company.id, project.id, "npati-client.ts", sdk);
    provider.executeCommand = async () => {
      provider.files.push({ path: "account.ts", content: "export interface Account { password: string; token: string; }" });
      return result();
    };
    await sandbox.execute(owner, company.id, { projectId: project.id, command: "npm install", agentId: "system", approved: true });
    expect((await workspace.readFile(owner, company.id, project.id, "npati-client.ts")).revision).toBe(original.revision);
    expect((await workspace.readFile(owner, company.id, project.id, "account.ts")).content).toContain("password: string");
  });
  it.each(["export const apiKey = 'sk-123456789012345678901234567890';", "export const password = 'actual-private-password';"])("rejects credentials generated by a command: %s", async (content) => {
    const { company, project, provider, sandbox } = await fixture();
    provider.executeCommand = async () => { provider.files.push({ path: "generated.ts", content }); return result(); };
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "npm install", agentId: "system", approved: true })).rejects.toMatchObject({ code: "secret_content" });
  });
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
    let args: string[] | undefined;
    let cwd: string | undefined;
    let environmentReferences: Record<string, { id: string; field: string }> | undefined;
    const ai = { executeTool: vi.fn(), ensureA2AEnabled: vi.fn(), ensureCombo: vi.fn(async (input: { name: string }) => ({ name: input.name })),
      a2aSend: vi.fn(async () => ({ taskId: "plan", content: JSON.stringify({ mode: "single", agentIds: [agent.id], toolRequests: [{ agentId: agent.id, tool: "project.terminal.exec", input: { projectId: project.id, command, args, cwd, environmentReferences } }] }), metadata: {} })),
      chat: vi.fn(async () => ({ content: "done", model: "auto" })) } as unknown as AIEngine;
    const tools = new CompanyToolRuntime(ai, undefined, undefined, undefined, undefined, undefined, undefined, undefined, workspace, store, sandbox);
    const approvals: DurableApprovalGateway = { requestApproval: vi.fn(async () => ({ id: "terminal-approval" })), consumeApproved: vi.fn(async () => undefined) };
    const runtime = new CompanyDelegationRuntime(store, ai, 10_000, tools, undefined, undefined, undefined, undefined, approvals);
    const controlled = await runtime.execute(owner, company.id, { task: "Install dependencies", mode: "single", projectId: project.id }, "terminal-install-run");
    expect(controlled.run.status, JSON.stringify(controlled.run)).toBe("completed");
    expect(provider.calls).toContain("npm install");
    expect(approvals.requestApproval).not.toHaveBeenCalled();
    command = "npm"; args = ["run", "dev", "--", "-H", "0.0.0.0"]; cwd = "/workspace/site";
    const structured = await runtime.execute(owner, company.id, { task: "Start structured dev command", mode: "single", projectId: project.id }, "terminal-structured-run");
    expect(structured.run.status).toBe("completed");
    expect(provider.calls).toContain("npm run dev -- -H 0.0.0.0");
    expect(provider.workingDirectories).toContain("site");
    expect(approvals.requestApproval).not.toHaveBeenCalled();
    args = undefined; cwd = undefined; command = "npm run dev -- --hostname 0.0.0.0 --port 3000";
    const dev = await runtime.execute(owner, company.id, { task: "Start dev server", mode: "single", projectId: project.id }, "terminal-dev-run");
    expect(dev.run.status).toBe("completed");
    expect(provider.calls).toContain(command);
    expect(approvals.requestApproval).not.toHaveBeenCalled();
    command = "echo built && rm -rf ./";
    const pending = await runtime.execute(owner, company.id, { task: "Clean build", mode: "single", projectId: project.id }, "terminal-approval-run");
    expect(pending.run.status).toBe("awaiting_approval");
    expect(pending.run.errorCode).toBe("APPROVAL_REQUIRED");
    expect(provider.calls).not.toContain(command);
    expect(JSON.stringify((approvals.requestApproval as any).mock.calls)).not.toContain(command);
    const approvedCommand = command;
    const planningCalls = vi.mocked(ai.a2aSend!).mock.calls.length;
    command = "pwd";
    const resumed = await runtime.process(owner, company.id, pending.run.id, { approvalId: "terminal-approval" });
    expect(vi.mocked(ai.a2aSend!).mock.calls.length).toBe(planningCalls);
    expect(resumed.run.status).toBe("completed");
    expect(provider.calls).toContain(approvedCommand);
    expect(JSON.stringify(await events.list(owner, company.id, project.id))).not.toContain(approvedCommand);
    command = "echo denied";
    const deniedPending = await runtime.execute(owner, company.id, { task: "Denied command", mode: "single", projectId: project.id }, "terminal-denied-run");
    expect(deniedPending.run.errorCode).toBe("APPROVAL_REQUIRED");
    vi.mocked(approvals.consumeApproved).mockRejectedValueOnce(new Error("Approval denied"));
    const denied = await runtime.process(owner, company.id, deniedPending.run.id, { approvalId: "terminal-approval" });
    expect(denied.run.status).toBe("failed");
    expect(provider.calls).not.toContain(command);
    command = "pwd";
    environmentReferences = { API_TOKEN: { id: "44444444-4444-4444-8444-444444444444", field: "token" } };
    const credentialPending = await runtime.execute(owner, company.id, { task: "Use credential", mode: "single", projectId: project.id }, "terminal-credential-run");
    expect(credentialPending.run.errorCode).toBe("APPROVAL_REQUIRED");
    expect(JSON.stringify((approvals.requestApproval as any).mock.calls)).not.toContain("44444444-4444-4444-8444-444444444444");
    expect(provider.calls.filter((call) => call === "pwd")).toHaveLength(0);
    environmentReferences = undefined;
    command = "npm run build";
    const built = await runtime.execute(owner, company.id, { task: "Build the project", mode: "single", projectId: project.id }, "terminal-build-run");
    expect(built.run.status).toBe("completed");
    expect(approvals.requestApproval).toHaveBeenCalledTimes(3);
    const unbound = await runtime.execute(owner, company.id, { task: "Unbound terminal request", mode: "single" }, "terminal-unbound-run");
    expect(unbound.run.status).toBe("awaiting_approval");
    expect(approvals.requestApproval).toHaveBeenCalledTimes(4);
    expect(provider.calls.filter((call) => call === "npm run build")).toHaveLength(1);
    expect((await workspace.readFile(owner, company.id, project.id, "generated.html")).content).toContain("built");
    expect((await events.list(owner, company.id, project.id)).length).toBeGreaterThan(0);
  });
  it("runs process start, status, logs, and stop without approval for safe actions", async () => {
    const { store, project, workspace, provider, sandbox } = await fixture();
    let company = await store.getCompany(owner, project.companyId);
    const agent = await store.createCompanyAgent(owner, company.id, { name: "Builder", role: "Developer", tools: ["project.terminal.process"] }, "terminal-process-agent");
    company = await store.setCompanyMainAgent(owner, company.id, agent.id, company.revision);
    const processId = "22222222-2222-4222-8222-222222222222";
    let input: Record<string, unknown> = { projectId: project.id, action: "start", command: "npm run dev" };
    const ai = { executeTool: vi.fn(), ensureA2AEnabled: vi.fn(), ensureCombo: vi.fn(async (value: { name: string }) => ({ name: value.name })),
      a2aSend: vi.fn(async () => ({ taskId: "plan", content: JSON.stringify({ mode: "single", agentIds: [agent.id], toolRequests: [{ agentId: agent.id, tool: "project.terminal.process", input }] }), metadata: {} })),
      chat: vi.fn(async () => ({ content: "done", model: "auto" })) } as unknown as AIEngine;
    const approvals: DurableApprovalGateway = { requestApproval: vi.fn(async () => ({ id: "unexpected" })), consumeApproved: vi.fn(async () => undefined) };
    const runtime = new CompanyDelegationRuntime(store, ai, 10_000, new CompanyToolRuntime(ai, undefined, undefined, undefined, undefined, undefined, undefined, undefined, workspace, store, sandbox), undefined, undefined, undefined, undefined, approvals);
    expect((await runtime.execute(owner, company.id, { task: "Start build", mode: "single", projectId: project.id }, "process-start-run")).run.status).toBe("completed");
    for (const action of ["status", "logs", "stop"] as const) {
      input = { projectId: project.id, action, processId };
      expect((await runtime.execute(owner, company.id, { task: action + " build", mode: "single", projectId: project.id }, "process-" + action + "-run")).run.status).toBe("completed");
    }
    expect(provider.calls).toContain("process:npm run dev");
    expect(approvals.requestApproval).not.toHaveBeenCalled();
  });
  it("reports timeout, install failure, missing command, runner failure, and redacts secret output", async () => {
    const { store, company, project, provider, sandbox, events } = await fixture();
    const agent = await store.createCompanyAgent(owner, company.id, { name: "Builder", role: "Developer", tools: ["project.terminal.exec"] }, "terminal-error-agent");
    provider.creationFailure = true;
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "pwd", agentId: agent.id })).rejects.toMatchObject({ code: "sandbox_creation_failed" });
    provider.creationFailure = false;
    provider.commandResult = result("timed_out", 124);
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "npm run build", agentId: agent.id })).rejects.toMatchObject({ code: "command_timeout", status: 504, step: "install_build", tool: "project.terminal.exec", retryable: false });
    provider.commandResult = result("failed", 1);
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "npm install", agentId: agent.id })).rejects.toMatchObject({ code: "install_failed" });
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "npm run build", agentId: agent.id })).rejects.toMatchObject({ code: "build_failed", message: "Build command failed" });
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
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "node build.js", agentId: agent.id })).rejects.toMatchObject({ code: "revision_conflict", status: 409, currentRevision: expect.any(String) });
    expect((await workspace.readFile(owner, company.id, project.id, "index.html")).content).toBe("concurrent");
  });
  it("does not resend an unchanged project or copy back after a read-only command", async () => {
    const { store, company, project, workspace, provider, sandbox } = await fixture();
    const agent = await store.createCompanyAgent(owner, company.id, { name: "Reader", role: "Developer", tools: ["project.terminal.exec"] }, "terminal-reader");
    await workspace.createFile(owner, company.id, project.id, "index.html", "before");
    const uploads = () => provider.calls.filter((call) => call === "upload").length;
    const downloads = () => provider.calls.filter((call) => call === "download").length;
    await sandbox.execute(owner, company.id, { projectId: project.id, command: "pwd", agentId: agent.id });
    const firstUploads = uploads();
    await sandbox.execute(owner, company.id, { projectId: project.id, command: "ls", agentId: agent.id });
    expect(uploads()).toBe(firstUploads);
    expect(downloads()).toBe(0);
    const current = await workspace.readFile(owner, company.id, project.id, "index.html");
    await workspace.writeFile(owner, company.id, project.id, "index.html", "after", current.revision);
    await sandbox.execute(owner, company.id, { projectId: project.id, command: "pwd", agentId: agent.id });
    expect(uploads()).toBe(firstUploads + 1);
    expect(provider.files.find((item) => item.path === "index.html")?.content).toBe("after");
  });
  it("blocks a leased vault value written into a manifest during execution", async () => {
    const { store, company, project, workspace, provider, events, projects } = await fixture();
    const vault = { resolve: vi.fn(async () => ({ token: "PRIVATE_VALUE_1234" })) };
    const secure = new ProjectSandboxService(projects, store, workspace, provider, events, vault);
    provider.executeCommand = async () => {
      provider.files.push({ path: "package.json", content: JSON.stringify({ name: "PRIVATE_VALUE_1234" }) });
      return result();
    };
    await expect(secure.execute(owner, company.id, { projectId: project.id, command: "npm install", agentId: "system", approved: true, environmentReferences: { API_TOKEN: { id: "44444444-4444-4444-8444-444444444444", field: "token" } } })).rejects.toMatchObject({ code: "secret_content" });
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
    const hooked = new ProjectService(store, async (context, current) => { await sandbox.destroy(context, current); });
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

describe("C2 search target shell boundary", () => {
  it("quotes metacharacters in the search target as one literal path", async () => {
    const h = await fixture();
    const command = vi.spyOn(h.provider, "executeCommand");
    await h.sandbox.search(owner, h.company.id, { projectId: h.project.id, query: "needle", path: "src; printf INJECTED" });
    expect(command).toHaveBeenCalled();
    expect(command.mock.calls[0]![2]).toContain("-- './src; printf INJECTED'");
  });
});

describe("C2 search output and failures", () => {
  it("returns JSON context and preserves nested glob filters", async () => {
    const h = await fixture();
    const json = [
      { type: "context", data: { path: { text: "src/app.ts" }, line_number: 1, lines: { text: "before\n" } } },
      { type: "match", data: { path: { text: "src/app.ts" }, line_number: 2, lines: { text: "needle\n" } } },
      { type: "context", data: { path: { text: "src/app.ts" }, line_number: 3, lines: { text: "after\n" } } },
    ].map(event => JSON.stringify(event)).join("\n");
    h.provider.commandResult = result("completed", 0, json);
    const output = await h.sandbox.search(owner, h.company.id, { projectId: h.project.id, query: "needle",
      glob: "src/**/*.ts", type: "ts", contextLines: 1 });
    expect(output.matches).toEqual([{ path: "src/app.ts", line: 2, text: "needle",
      context: [{ line: 1, text: "before" }, { line: 3, text: "after" }] }]);
    expect(h.provider.calls.some(command => command.includes("--glob 'src/**/*.ts'"))).toBe(true);
  });
  it("returns a structured failure for rg errors rather than an empty successful result", async () => {
    const h = await fixture();
    h.provider.commandResult = { ...result("failed", 2), stderr: "regex parse error" };
    await expect(h.sandbox.search(owner, h.company.id, { projectId: h.project.id, query: "[" }))
      .rejects.toMatchObject({ code: "search_failed" });
  });
});

describe("C2 filesystem modification metadata", () => {
  it("passes real mtimes to the read port without making content revisions depend on touch", async () => {
    const h = await fixture();
    await h.workspace.createFile(owner, h.company.id, h.project.id, "older.ts", "export const old = 1;\n");
    await h.workspace.createFile(owner, h.company.id, h.project.id, "newer.ts", "export const latest = 1;\n");
    const { utimes } = await import("node:fs/promises");
    const before = await h.workspace.info(owner, h.company.id, h.project.id);
    await utimes(path.join(h.root, h.company.id, h.project.id, "older.ts"), new Date(1000), new Date(1000));
    await utimes(path.join(h.root, h.company.id, h.project.id, "newer.ts"), new Date(2000), new Date(2000));
    const { createProjectWorkspaceReadPort } = await import("../apps/agent-api/src/code-tool-runtime-workspace");
    const port = createProjectWorkspaceReadPort(h.workspace);
    const { entries } = await port.listDir({ ctx: owner, companyId: h.company.id, projectId: h.project.id, path: "." });
    expect(entries.find(entry => entry.path === "older.ts")?.mtimeMs).toBe(1000);
    expect(entries.find(entry => entry.path === "newer.ts")?.mtimeMs).toBe(2000);
    expect((await h.workspace.info(owner, h.company.id, h.project.id)).currentRevision).toBe(before.currentRevision);
  });
});

describe("C2 real binary metadata", () => {
  it("identifies JPEG bytes before UTF-8 decoding loses their magic number", async () => {
    const h = await fixture();
    await h.workspace.createFile(owner, h.company.id, h.project.id, "image.jpg", "placeholder");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(h.root, h.company.id, h.project.id, "image.jpg"), Buffer.from([255, 216, 255, 219]));
    const file = await h.workspace.readFile(owner, h.company.id, h.project.id, "image.jpg");
    expect(file).toMatchObject({ binary: true, mimeGuess: "image/jpeg", encoding: "binary", size: 4 });
    const { createProjectWorkspaceReadPort } = await import("../apps/agent-api/src/code-tool-runtime-workspace");
    const result = await createProjectWorkspaceReadPort(h.workspace).readFile({ ctx: owner, companyId: h.company.id,
      projectId: h.project.id, path: "image.jpg", maxLines: 2000, maxBytes: 1_000_000 });
    expect(result).toMatchObject({ binary: true, mimeGuess: "image/jpeg", encoding: "binary", sha256: file.revision });
    const { CodeToolRuntime } = await import("../apps/agent-api/src/code-tool-runtime");
    const { canonicalExecutors } = await import("../apps/agent-api/src/code-tool-executors");
    const { FeatureFlagService } = await import("../apps/agent-api/src/feature-flags");
    const runtime = new CodeToolRuntime({ store: h.store,
      flags: new FeatureFlagService(h.store, undefined, { enabledByDefault: true, allowPreGateRollout: true }),
      executors: canonicalExecutors(), toPort: () => createProjectWorkspaceReadPort(h.workspace) });
    const invoked = await runtime.invoke(owner, { companyId: h.company.id, projectId: h.project.id,
      tool: "code.fs.read", toolCallId: "real-jpeg", args: { path: "image.jpg" } });
    expect(invoked).toMatchObject({ ok: true, result: { data: { binary: true, image: true, mimeGuess: "image/jpeg", lines: [] } } });
  });
});

describe("Workspace literal editing regression", () => {
  it.each(["$&", "$$", "$" + String.fromCharCode(96), "$'"])("persists literal replacement %s in real files", async (replacement) => {
    const { company, project, workspace } = await fixture();
    const file = await workspace.createFile(owner, company.id, project.id, "literal.txt", "before TARGET after\n");
    const edited = await workspace.editFile(owner, company.id, project.id, "literal.txt", "TARGET", replacement, file.revision);
    expect(edited.content).toBe("before " + replacement + " after\n");
    expect((await workspace.readFile(owner, company.id, project.id, "literal.txt")).content).toBe(edited.content);
  });
  it("preserves BOM and CRLF when replacement contains LF", async () => {
    const { company, project, workspace } = await fixture();
    const file = await workspace.createFile(owner, company.id, project.id, "lines.txt", "\uFEFFfirst\r\nTARGET\r\nlast\r\n");
    const edited = await workspace.editFile(owner, company.id, project.id, "lines.txt", "TARGET", "two\nlines", file.revision);
    expect(edited.content).toBe("\uFEFFfirst\r\ntwo\r\nlines\r\nlast\r\n");
  });
});

describe("Workspace delete revision regression", () => {
  it("refuses a stale delete through the real canonical adapter", async () => {
    const { createProjectWorkspaceWritePort } = await import("../apps/agent-api/src/code-tool-runtime-workspace");
    const { company, project, workspace } = await fixture();
    const file = await workspace.createFile(owner, company.id, project.id, "retained.txt", "original\n");
    const changed = await workspace.writeFile(owner, company.id, project.id, "retained.txt", "concurrent\n", file.revision);
    const port = createProjectWorkspaceWritePort(workspace);
    const scope = { ctx: owner, companyId: company.id, projectId: project.id, path: "retained.txt" };
    await expect(port.deleteFile({ ...scope, expectedRevision: file.revision })).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await workspace.readFile(owner, company.id, project.id, "retained.txt")).content).toBe("concurrent\n");
    await port.deleteFile({ ...scope, expectedRevision: changed.revision });
    await expect(workspace.readFile(owner, company.id, project.id, "retained.txt")).rejects.toMatchObject({ code: "file_not_found" });
  });

  it("rejects a late conflicting Terminal result before committing earlier files", async () => {
    const { company, project, workspace, provider, sandbox, events } = await fixture();
    for (const file of ["a.ts", "b.ts"]) await workspace.createFile(owner, company.id, project.id, file, "original");
    provider.executeCommand = async () => {
      const b = await workspace.readFile(owner, company.id, project.id, "b.ts");
      await workspace.writeFile(owner, company.id, project.id, "b.ts", "peer", b.revision);
      provider.files = provider.files.map(file => ({ ...file, content: "terminal" }));
      return result();
    };
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "npm run build", agentId: "system" })).rejects.toMatchObject({ code: "revision_conflict", retryable: false });
    expect((await workspace.readFile(owner, company.id, project.id, "a.ts")).content).toBe("original");
    expect((await workspace.readFile(owner, company.id, project.id, "b.ts")).content).toBe("peer");
    expect(await events.list(owner, company.id, project.id)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "failed", errorCode: "revision_conflict", exitCode: 0 })]));
  });
  it("validates every returned Terminal file before copying any of them", async () => {
    const { company, project, workspace, provider, sandbox } = await fixture();
    await workspace.createFile(owner, company.id, project.id, "a.ts", "original");
    provider.executeCommand = async () => {
      provider.files = [{ path: "a.ts", content: "must not commit" }, { path: "b.ts", content: 'export const password = "actual-private-password";' }];
      return result();
    };
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "npm run build", agentId: "system" })).rejects.toMatchObject({ code: "secret_content" });
    expect((await workspace.readFile(owner, company.id, project.id, "a.ts")).content).toBe("original");
  });
  it("does not advertise replay after a dispatched command loses its transport response", async () => {
    const { company, project, workspace, provider, sandbox } = await fixture();
    let executions = 0;
    provider.executeCommand = async () => { executions++; throw new SandboxProviderError("runner_disconnected", "Reply lost", 503, "execute", "project.terminal.exec", true); };
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "npm run build", agentId: "system" })).rejects.toMatchObject({ code: "runner_disconnected", retryable: false });
    expect(executions).toBe(1);
    expect(await workspace.listFiles(owner, company.id, project.id)).toHaveLength(0);
  });
});

describe("Terminal cleanup guard release", () => {
  it("does not replay a completed command when durable guard release fails", async () => {
    const { sandbox, provider, events, company, project, workspace } = await fixture();
    sandbox.setProcessCleanupGuard({ acquire: async () => async () => { throw new Error("private-store-detail"); } });
    const failure = await sandbox.execute(owner, company.id, { projectId: project.id, command: "npm run build", agentId: "system" }).catch(error => error);
    expect(failure).toMatchObject({ code: "process_cleanup_failed", retryable: false, step: "cleanup" });
    expect(toFailure(failure, "code.shell.exec")).toMatchObject({ ok: false, error: { code: "process_cleanup_failed", retryable: false } });
    expect(provider.calls.filter(call => call === "npm run build")).toHaveLength(1);
    expect((await workspace.readFile(owner, company.id, project.id, "generated.html")).content).toBe("<h1>built</h1>");
    const trace = await events.list(owner, company.id, project.id);
    expect(JSON.stringify(trace)).toContain("process_cleanup_failed");
    expect(JSON.stringify(trace)).not.toContain("private-store-detail");
  });
  it("preserves a diagnosed command failure when durable guard release also fails", async () => {
    const { sandbox, provider, events, company, project } = await fixture();
    sandbox.setProcessCleanupGuard({ acquire: async () => async () => { throw new Error("private-store-detail"); } });
    provider.executeCommand = async () => { throw new SandboxProviderError("command_timeout", "Inspect command effects", 504, "command", "project.terminal.exec", false); };
    await expect(sandbox.execute(owner, company.id, { projectId: project.id, command: "pwd", agentId: "system" })).rejects.toMatchObject({ code: "command_timeout", retryable: false });
    const trace = await events.list(owner, company.id, project.id);
    expect(JSON.stringify(trace)).toContain("process_cleanup_failed");
    expect(JSON.stringify(trace)).toContain("command_timeout");
    expect(JSON.stringify(trace)).not.toContain("private-store-detail");
  });
});

it.each(["runtime_recovery_required", "runtime_state_invalid", "process_termination_unconfirmed"])("preserves fail-closed native diagnosis for %s", code => {
  const failure = new SandboxProviderError(code, "Admission remains closed", 503, "ownership", "code.shell.exec", false);
  expect(toFailure(failure, "code.shell.exec")).toMatchObject({ ok: false, error: { code, retryable: false, status: 503 } });
});

describe("C4 production shell adapter timeout contract", () => {
  it.each([
    { command: "pwd", timeoutMs: 3000, expected: 3000 },
    { command: "pwd", timeoutMs: undefined, expected: 120000 },
    { command: "pwd", timeoutMs: 600000, expected: 120000 },
    { command: "npm install", timeoutMs: undefined, expected: 3600000 },
  ])("forwards and caps provider timeout for $command at $expected", async ({ command, timeoutMs, expected }) => {
    const { company, project, provider, sandbox } = await fixture();
    const dispatch = vi.spyOn(provider, "executeCommand");
    const { shellSandboxPort } = createShellSandboxPortWiring({ projectSandbox: sandbox } as Parameters<typeof createShellSandboxPortWiring>[0]);
    const raw = await shellSandboxPort!.execute({ context: owner, companyId: company.id, projectId: project.id,
      agentId: "system", command, timeoutMs, approved: true, runId: "correlated-shell-run" });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), expect.anything(), command, expect.objectContaining({ timeoutMs: expected }));
    expect(raw).toMatchObject({ exitCode: 0, status: "completed", durationMs: 4 });
  });
});

it("returns the TypeScript build error with useful context instead of only its code-frame tail",async()=>{
  const {store,company,project,provider,sandbox}=await fixture();
  const agent=await store.createCompanyAgent(owner,company.id,{name:"Builder",role:"Developer",tools:["project.terminal.exec"]},"build-diagnostic-agent");
  provider.commandResult={...result("failed",1,"Compiling Next.js application"),stderr:"app/account/page.tsx:70: Type error: Record<string, unknown>[] is not assignable to Order[].\n"+"Source excerpt line\n".repeat(35)+"password=do-not-expose\nNext.js build worker exited with code: 1"};
  const error=await sandbox.execute(owner,company.id,{projectId:project.id,command:"npm run build",agentId:agent.id}).catch(error=>error);
  expect(error.code).toBe("build_failed");
  expect(error.message).toContain("app/account/page.tsx:70: Type error");
  expect(error.message).toContain("Next.js build worker exited");
  expect(error.message).not.toContain("do-not-expose");
});

it("stops the recorded Next.js dev listener before a production build writes .next",async()=>{
 const {projects,company,project,workspace,provider,sandbox}=await fixture();
 await workspace.createFile(owner,company.id,project.id,"package.json","{}");
 await projects.updatePreview(owner,company.id,project.id,{framework:"Next.js",previewPort:3078});
 vi.spyOn(provider,"startProcess").mockResolvedValue({...result(),status:"running",processId:"22222222-2222-4222-8222-222222222222"});
 const order:string[]=[];vi.spyOn(provider,"stopProcess").mockImplementation(async()=>{order.push("stop");return {...result(),status:"stopped"};});
 vi.spyOn(provider,"executeCommand").mockImplementation(async()=>{order.push("build");return result();});
 await sandbox.process(owner,company.id,{projectId:project.id,action:"start",command:"npm run dev -- --port 3078",agentId:"system",approved:true});
 await sandbox.execute(owner,company.id,{projectId:project.id,command:"npm run build",agentId:"system",approved:true});
 expect(order).toEqual(["stop","build"]);
});

it.each([false,true])("keeps binary assets, unchanged or produced by a Terminal command (modified=%s)",async modified=>{
 const f=await fixture();const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,255,128]);const produced=Buffer.from([137,80,78,71,13,10,26,10,0,255,129]);
 await f.workspace.createFile(owner,f.company.id,f.project.id,"public/reference.png",bytes);
 await f.workspace.createFile(owner,f.company.id,f.project.id,"page.ts","export const color = 'old';");
 f.provider.executeCommand=async()=>{f.provider.files=f.provider.files.map(file=>file.path==="page.ts"?{...file,content:"export const color = 'new';"}:modified?{...file,content:produced.toString("base64")}:file);return result();};
 const run=f.sandbox.execute(owner,f.company.id,{projectId:f.project.id,agentId:"system",command:"npm run build"});
 await expect(run).resolves.toMatchObject({status:"completed"});
 const photo=await f.workspace.readFile(owner,f.company.id,f.project.id,"public/reference.png");expect(photo.binary).toBe(true);expect(photo.contentBase64).toBe((modified?produced:bytes).toString("base64"));
 expect(f.provider.files.find(file=>file.path==="public/reference.png")).toMatchObject({encoding:"base64"});
 expect((await f.workspace.readFile(owner,f.company.id,f.project.id,"page.ts")).content).toContain("new");
});

it.each(["running", "failed", "timed_out"] as const)("records the actual preview process outcome %s without a spurious failure", async status => {
 const {company,project,workspace,provider,sandbox,events}=await fixture();
 await workspace.createFile(owner,company.id,project.id,"package.json","{}");
 vi.spyOn(provider,"startProcess").mockResolvedValue({...result(status,status==="failed"?1:0),processId:"22222222-2222-4222-8222-222222222222"});
 await sandbox.process(owner,company.id,{projectId:project.id,action:"start",command:"npm run dev",agentId:"system",approved:true});
 const event=(await events.list(owner,company.id,project.id)).find(e=>e.commandSummary==="npm run dev")!;
 expect(event.status).toBe(status);
 expect(event.errorCode).toBe(status==="running"?undefined:status==="timed_out"?"command_timeout":"preview_start_failed");
});
