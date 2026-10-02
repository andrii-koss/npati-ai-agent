import { createHash } from "node:crypto";
import type { AuthContext, Project, WorkspaceStore } from "@npati/workspace";
import { ProjectFileError, safeProjectPath, type ProjectWorkspace } from "./project-workspace";
import type { SandboxProvider, SandboxScope, SandboxStatus, SandboxCommandResult, SandboxFile } from "./sandbox-provider";
import { SandboxProviderError } from "./sandbox-provider";
import { classifyTerminalCommand, redactTerminalText, type TerminalCommandDecision } from "./terminal-command-policy";
import { ProjectTerminalEventsRepository } from "./project-terminal-events";
import type { ProjectService } from "./project-service";

export interface TerminalSecretReference { id: string; field: string; }
export interface TerminalRequest {
  projectId: string; sandboxId?: string; command?: string; processId?: string;
  action?: "start" | "status" | "logs" | "stop";
  environmentReferences?: Record<string, TerminalSecretReference>;
  approved?: boolean; runId?: string; agentId: string;
}
export interface TerminalLimits { commandTimeoutMs: number; installBuildTimeoutMs: number; outputLimitBytes: number; inactivityMs: number; syncMaxBytes: number; syncMaxFiles: number; }
export const defaultTerminalLimits: TerminalLimits = { commandTimeoutMs: 120_000, installBuildTimeoutMs: 600_000, outputLimitBytes: 64_000, inactivityMs: 900_000, syncMaxBytes: 20_000_000, syncMaxFiles: 500 };
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const scopeOf = (ctx: AuthContext, project: Project): SandboxScope => ({ workspaceId: ctx.workspaceId, userId: ctx.userId, companyId: project.companyId, projectId: project.id });
const stepOf = (decision: TerminalCommandDecision) => decision.timeoutClass === "install_build" ? "install_build" : "command";
const artifact = (filePath: string) => filePath.split("/").some((part) => ["node_modules", "dist", "build", ".next", ".cache", "vendor", "__pycache__", ".venv"].includes(part));

export class ProjectSandboxService {
  private readonly limits: TerminalLimits;
  private readonly lastUse = new Map<string, { ctx: AuthContext; project: Project; at: number }>();
  constructor(
    private readonly projects: Pick<ProjectService, "get">,
    private readonly store: Pick<WorkspaceStore, "getCompanyAgent" | "setProjectSandbox">,
    private readonly workspace: ProjectWorkspace,
    private readonly provider: SandboxProvider,
    private readonly events: ProjectTerminalEventsRepository,
    private readonly secretResolver?: { resolve(ctx: AuthContext, companyId: string, id: string): Promise<Record<string, string>> },
    limits: Partial<TerminalLimits> = {},
  ) {
    const configured = Object.fromEntries(Object.entries(limits).filter(([, value]) => Number.isSafeInteger(value) && Number(value) > 0));
    this.limits = { ...defaultTerminalLimits, ...configured };
    this.limits.commandTimeoutMs = Math.min(this.limits.commandTimeoutMs, 600_000);
    this.limits.installBuildTimeoutMs = Math.min(this.limits.installBuildTimeoutMs, 600_000);
    this.limits.outputLimitBytes = Math.min(this.limits.outputLimitBytes, 128_000);
  }
  private async project(ctx: AuthContext, companyId: string, projectId: string, allowArchived = false) {
    const project = await this.projects.get(ctx, companyId, projectId);
    if (project.status === "archived" && !allowArchived) throw new SandboxProviderError("project_archived", "Archived project cannot use Terminal", 409);
    return project;
  }
  private async agent(ctx: AuthContext, companyId: string, agentId: string, tool: string) {
    if (!agentId || agentId === "system") {
      const allowed = ctx.permissions.includes("*") || ctx.permissions.includes("owner") || ctx.permissions.includes("business:manage") || ctx.permissions.includes("workspace:write");
      if (!allowed) throw new SandboxProviderError("terminal_permission_denied", "User lacks permission", 403, "authorization", tool);
      return;
    }
    const agent = await this.store.getCompanyAgent(ctx, companyId, agentId);
    if (!agent.isActive || !agent.tools.includes(tool)) throw new SandboxProviderError("terminal_permission_denied", "Agent lacks Terminal permission", 403, "authorization", tool);
  }
  private async environment(ctx: AuthContext, companyId: string, references: TerminalRequest["environmentReferences"]) {
    const entries = Object.entries(references ?? {});
    if (entries.length > 20) throw new SandboxProviderError("invalid_environment", "Too many environment references", 400);
    if (entries.length && !this.secretResolver) throw new SandboxProviderError("secret_store_unavailable", "Project secret references are unavailable", 503);
    const values: Record<string, string> = {};
    for (const [key, reference] of entries) {
      if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) || !reference || !uuid(reference.id) || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(reference.field)) throw new SandboxProviderError("invalid_environment", "Invalid environment reference", 400);
      const fields = await this.secretResolver!.resolve(ctx, companyId, reference.id);
      if (typeof fields[reference.field] !== "string") throw new SandboxProviderError("secret_not_found", "Secret reference was not found", 404);
      values[key] = fields[reference.field]!;
    }
    return values;
  }
  private touch(ctx: AuthContext, project: Project) { this.lastUse.set(project.id, { ctx, project, at: Date.now() }); }
  async stopInactive(now = Date.now()) {
    for (const [projectId, item] of this.lastUse) {
      if (now - item.at < this.limits.inactivityMs || !item.project.sandboxId) continue;
      try {
        const scope = scopeOf(item.ctx, item.project);
        const status = await this.provider.getStatus(scope, item.project.sandboxId);
        if (status.state !== "running") { this.lastUse.delete(projectId); continue; }
        const remoteAt = Date.parse(status.lastActivityAt);
        if (Number.isFinite(remoteAt) && now - remoteAt < this.limits.inactivityMs) { item.at = remoteAt; continue; }
        await this.provider.stopSandbox(scope, item.project.sandboxId);
        this.lastUse.delete(projectId);
      } catch (error) {
        if (error instanceof SandboxProviderError && error.status === 404) this.lastUse.delete(projectId);
      }
    }
  }
  private async ensure(ctx: AuthContext, project: Project) {
    const scope = scopeOf(ctx, project);
    let sandboxId = project.sandboxId;
    if (sandboxId) {
      try {
        const status = await this.provider.getStatus(scope, sandboxId);
        if (status.state === "stopped") await this.provider.startSandbox(scope, sandboxId);
        else if (status.state === "failed" || status.state === "destroyed") sandboxId = undefined;
      } catch (error) {
        if (error instanceof SandboxProviderError && error.status === 404) sandboxId = undefined;
        else throw error;
      }
    }
    if (!sandboxId) {
      const created = await this.provider.createSandbox(scope, { runtime: project.runtime });
      try { project = await this.store.setProjectSandbox(ctx, project.companyId, project.id, created.id, project.sandboxId ?? null); }
      catch (error) { await this.provider.destroySandbox(scope, created.id).catch(() => undefined); throw error; }
      sandboxId = created.id;
      await this.provider.startSandbox(scope, sandboxId);
    }
    this.touch(ctx, { ...project, sandboxId });
    return { project: { ...project, sandboxId }, scope, sandboxId };
  }
  private async upload(ctx: AuthContext, project: Project, scope: SandboxScope, sandboxId: string) {
    const entries = await this.workspace.listFiles(ctx, project.companyId, project.id);
    const files: SandboxFile[] = [];
    let total = 0;
    for (const entry of entries.filter((item) => !artifact(item.path))) {
      const file = await this.workspace.readFile(ctx, project.companyId, project.id, entry.path);
      total += file.size;
      if (files.length >= this.limits.syncMaxFiles || total > this.limits.syncMaxBytes) throw new SandboxProviderError("workspace_sync_limit", "Project exceeds sandbox sync limits", 413, "upload");
      files.push({ path: file.path, content: file.content, revision: file.revision });
    }
    await this.provider.uploadFiles(scope, sandboxId, files);
    return new Map(files.map((file) => [file.path, file]));
  }
  private async download(ctx: AuthContext, project: Project, scope: SandboxScope, sandboxId: string, originals: Map<string, SandboxFile>, secrets: string[]) {
    const files = await this.provider.downloadFiles(scope, sandboxId);
    if (files.length > this.limits.syncMaxFiles) throw new SandboxProviderError("workspace_sync_limit", "Sandbox returned too many files", 413, "download");
    let total = 0;
    for (const file of files) {
      if (artifact(file.path)) continue;
      safeProjectPath(file.path);
      total += Buffer.byteLength(file.content, "utf8");
      if (total > this.limits.syncMaxBytes) throw new SandboxProviderError("workspace_sync_limit", "Sandbox file output exceeds sync limit", 413, "download");
      if (secrets.some((secret) => secret.length > 0 && file.content.includes(secret)) || redactTerminalText(file.content) !== file.content) throw new SandboxProviderError("secret_content", "Sandbox produced protected file content", 403, "download");
      const original = originals.get(file.path);
      if (!original) await this.workspace.createFile(ctx, project.companyId, project.id, file.path, file.content);
      else if (original.content !== file.content) await this.workspace.writeFile(ctx, project.companyId, project.id, file.path, file.content, original.revision!);
    }
  }
  private async run(ctx: AuthContext, companyId: string, request: TerminalRequest, tool: "project.terminal.exec" | "project.terminal.process", startProcess = false) {
    await this.agent(ctx, companyId, request.agentId, tool);
    const project = await this.project(ctx, companyId, request.projectId);
    if (request.sandboxId && request.sandboxId !== project.sandboxId) throw new SandboxProviderError("sandbox_mismatch", "Sandbox does not belong to this Project", 403, "authorization", tool);
    const command = request.command ?? "";
    const decision = classifyTerminalCommand(command);
    if ((decision.requiresApproval || Object.keys(request.environmentReferences ?? {}).length > 0) && request.approved !== true) throw new SandboxProviderError("approval_required", "Terminal command requires approval", 403, "approval", tool);
    const environment = await this.environment(ctx, companyId, request.environmentReferences);
    const secrets = Object.values(environment);
    const timeoutMs = decision.timeoutClass === "install_build" ? this.limits.installBuildTimeoutMs : this.limits.commandTimeoutMs;
    let sandboxId = project.sandboxId ?? "";
    try {
      const ready = await this.ensure(ctx, project);
      sandboxId = ready.sandboxId;
      if (request.sandboxId && request.sandboxId !== sandboxId) throw new SandboxProviderError("sandbox_mismatch", "Sandbox does not belong to this Project", 403, "authorization", tool);
      const originals = await this.upload(ctx, ready.project, ready.scope, sandboxId);
      const raw = startProcess
        ? await this.provider.startProcess(ready.scope, sandboxId, command, { timeoutMs, outputLimitBytes: this.limits.outputLimitBytes, environment })
        : await this.provider.executeCommand(ready.scope, sandboxId, command, { timeoutMs, outputLimitBytes: this.limits.outputLimitBytes, environment });
      const output = redactTerminalText(raw.stdout + (raw.stderr ? "\n" + raw.stderr : ""), secrets).slice(0, this.limits.outputLimitBytes);
      if (!startProcess) await this.download(ctx, ready.project, ready.scope, sandboxId, originals, secrets);
      await this.events.append(ctx, companyId, request.projectId, { runId: request.runId, agentId: request.agentId, sandboxId, processId: raw.processId, commandSummary: decision.requiresApproval ? "Approved command (" + createHash("sha256").update(command).digest("hex").slice(0, 12) + ")" : redactTerminalText(command, secrets), riskLevel: decision.level, status: startProcess ? "running" : raw.status, exitCode: raw.exitCode, output, durationMs: raw.durationMs, errorCode: raw.status === "completed" ? undefined : raw.status === "timed_out" ? "command_timeout" : raw.exitCode === 127 ? "command_not_found" : decision.timeoutClass === "install_build" ? "install_failed" : "command_failed" });
      if (raw.status !== "completed" && !startProcess) {
        const code = raw.status === "timed_out" ? "command_timeout" : raw.exitCode === 127 ? "command_not_found" : decision.timeoutClass === "install_build" ? "install_failed" : "command_failed";
        throw new SandboxProviderError(code, raw.status === "timed_out" ? "Sandbox command timed out" : "Sandbox command failed", raw.status === "timed_out" ? 504 : 409, stepOf(decision), tool, raw.status === "timed_out");
      }
      return { ...raw, stdout: redactTerminalText(raw.stdout, secrets).slice(0, this.limits.outputLimitBytes), stderr: redactTerminalText(raw.stderr, secrets).slice(0, this.limits.outputLimitBytes), sandboxId, riskLevel: decision.level };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      if (error instanceof ProjectFileError) throw new SandboxProviderError(error.code, error.message, error.status, "workspace_sync", tool, false, error.currentRevision);
      throw new SandboxProviderError("sandbox_execution_failed", "Sandbox execution failed", 503, "sandbox", tool, true);
    }
  }
  execute(ctx: AuthContext, companyId: string, request: TerminalRequest) { return this.run(ctx, companyId, request, "project.terminal.exec"); }
  async process(ctx: AuthContext, companyId: string, request: TerminalRequest) {
    const tool = "project.terminal.process" as const;
    if (request.action === "start") return this.run(ctx, companyId, request, tool, true);
    await this.agent(ctx, companyId, request.agentId, tool);
    const project = await this.project(ctx, companyId, request.projectId);
    if (!project.sandboxId || (request.sandboxId && request.sandboxId !== project.sandboxId)) throw new SandboxProviderError("sandbox_mismatch", "Sandbox does not belong to this Project", 403, "authorization", tool);
    if (!request.processId || !uuid(request.processId)) throw new SandboxProviderError("invalid_process", "Invalid process ID", 400, "process", tool);
    const scope = scopeOf(ctx, project);
    if (request.action === "stop") {
      const result = await this.provider.stopProcess(scope, project.sandboxId, request.processId);
      await this.events.append(ctx, companyId, project.id, { runId: request.runId, agentId: request.agentId, sandboxId: project.sandboxId, processId: request.processId, commandSummary: "Stop process", riskLevel: "safe", status: "stopped", exitCode: result.exitCode, output: "", durationMs: result.durationMs });
      return result;
    }
    if (request.action === "status") return this.provider.getProcessStatus(scope, project.sandboxId, request.processId);
    if (request.action === "logs") return { processId: request.processId, output: redactTerminalText(await this.provider.getLogs(scope, project.sandboxId, request.processId)).slice(0, this.limits.outputLimitBytes) };
    throw new SandboxProviderError("invalid_process_action", "Invalid process action", 400, "process", tool);
  }
  async exposePort(ctx: AuthContext, companyId: string, projectId: string, port: number) {
    const project = await this.project(ctx, companyId, projectId);
    const ready = await this.ensure(ctx, project);
    return this.provider.exposePort(ready.scope, ready.sandboxId, port);
  }
  async status(ctx: AuthContext, companyId: string, projectId: string): Promise<SandboxStatus | null> {
    const project = await this.project(ctx, companyId, projectId, true);
    return project.sandboxId ? this.provider.getStatus(scopeOf(ctx, project), project.sandboxId) : null;
  }
  async logs(ctx: AuthContext, companyId: string, projectId: string) {
    const project = await this.project(ctx, companyId, projectId, true);
    const history = await this.events.list(ctx, companyId, projectId, 50);
    const recorded = history.reverse().map((event) => `[${event.createdAt}] ${event.commandSummary} (${event.status})\n${event.output}`).join("\n");
    const runner = project.sandboxId ? redactTerminalText(await this.provider.getLogs(scopeOf(ctx, project), project.sandboxId)) : "";
    const processIds = [...new Set(history.map((event) => event.processId).filter((id): id is string => Boolean(id)))].slice(-5);
    const processLogs = project.sandboxId ? await Promise.all(processIds.map(async (id) => redactTerminalText(await this.provider.getLogs(scopeOf(ctx, project), project.sandboxId!, id)).slice(0, 8_000)).map((item) => item.catch(() => ""))) : [];
    return [recorded, runner, ...processLogs].filter(Boolean).join("\n").slice(0, this.limits.outputLimitBytes);
  }
  async destroy(ctx: AuthContext, project: Project) {
    if (!project.sandboxId) return;
    try { await this.provider.destroySandbox(scopeOf(ctx, project), project.sandboxId); }
    catch (error) { if (!(error instanceof SandboxProviderError && error.status === 404)) throw error; }
    this.lastUse.delete(project.id);
    await this.store.setProjectSandbox(ctx, project.companyId, project.id, null, project.sandboxId);
  }
}
