import { createHash, randomUUID } from "node:crypto";
import type { AuthContext, Project, WorkspaceStore } from "@npati/workspace";
import { ProjectFileError, safeProjectPath, type ProjectWorkspace } from "./project-workspace";
import type { SandboxBrowserQaOptions, SandboxProvider, SandboxScope, SandboxStatus, SandboxCommandResult, SandboxFile } from "./sandbox-provider";
import { SandboxProviderError } from "./sandbox-provider";
import { classifyTerminalCommand, normalizeTerminalCommand, redactTerminalText, type TerminalCommandDecision } from "./terminal-command-policy";
import { ProjectTerminalEventsRepository } from "./project-terminal-events";
import { logTerminalPolicy } from "./terminal-policy-log";
import type { ProjectService } from "./project-service";

export interface TerminalSecretReference { id: string; field: string; }
export interface TerminalRequest {
  projectId: string; sandboxId?: string; command?: string; executable?: string; args?: string[]; cwd?: string; processId?: string;
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
  async inspectBrowser(ctx: AuthContext, companyId: string, projectId: string, options: SandboxBrowserQaOptions & { agentId?: string }) {
    const project = await this.project(ctx, companyId, projectId);
    await this.agent(ctx, companyId, options.agentId ?? "system", "project.qa.inspect");
    if (!project.sandboxId || !this.provider.inspectBrowser) throw new SandboxProviderError("qa_unavailable", "Browser QA runner is unavailable", 503, "browser_qa", "project.qa.inspect");
    const scope = scopeOf(ctx, project);
    const status = await this.provider.getStatus(scope, project.sandboxId);
    if (status.state !== "running") throw new SandboxProviderError("sandbox_not_running", "Project sandbox is not running", 409, "browser_qa", "project.qa.inspect");
    this.touch(ctx, project);
    return this.provider.inspectBrowser(scope, project.sandboxId, options);
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
    const normalized = normalizeTerminalCommand(request);
    const command = normalized.command;
    const decision = classifyTerminalCommand({ command: normalized.command, cwd: normalized.cwd });
    if ((decision.requiresApproval || Object.keys(request.environmentReferences ?? {}).length > 0) && request.approved !== true) {
      logTerminalPolicy({ rawCommand: normalized.rawCommand, normalizedCommand: command, sandboxId: project.sandboxId, projectId: project.id, decision: "approval", reason: decision.requiresApproval ? decision.reason : "Secret references require approval", policyRule: decision.policyRule, toolName: tool, executionContext: "project_sandbox", runId: request.runId ?? "direct", agentId: request.agentId, runType: "project_tool", cwd: normalized.cwd, rawArgs: normalized.args, commandPolicyRule: decision.policyRule });
      throw new SandboxProviderError("approval_required", "Terminal command requires approval", 403, "approval", tool);
    }
    const environment = await this.environment(ctx, companyId, request.environmentReferences);
    const secrets = Object.values(environment);
    const timeoutMs = decision.timeoutClass === "install_build" ? this.limits.installBuildTimeoutMs : this.limits.commandTimeoutMs;
    let sandboxId = project.sandboxId ?? "";
    try {
      const ready = await this.ensure(ctx, project);
      sandboxId = ready.sandboxId;
      if (request.sandboxId && request.sandboxId !== sandboxId) throw new SandboxProviderError("sandbox_mismatch", "Sandbox does not belong to this Project", 403, "authorization", tool);
      logTerminalPolicy({ rawCommand: normalized.rawCommand, normalizedCommand: command, sandboxId, projectId: project.id, decision: "allow", reason: request.approved && decision.requiresApproval ? "human_approved" : "sandbox_execution", policyRule: decision.policyRule, toolName: tool, executionContext: "project_sandbox", runId: request.runId ?? "direct", agentId: request.agentId, runType: "project_tool", cwd: normalized.cwd, rawArgs: normalized.args, commandPolicyRule: decision.policyRule });
      const originals = await this.upload(ctx, ready.project, ready.scope, sandboxId);
      const raw = startProcess
        ? await this.provider.startProcess(ready.scope, sandboxId, command, { timeoutMs, outputLimitBytes: this.limits.outputLimitBytes, environment, cwd: normalized.cwd })
        : await this.provider.executeCommand(ready.scope, sandboxId, command, { timeoutMs, outputLimitBytes: this.limits.outputLimitBytes, environment, cwd: normalized.cwd });
      const output = redactTerminalText(raw.stdout + (raw.stderr ? "\n" + raw.stderr : ""), secrets).slice(0, this.limits.outputLimitBytes);
      if (!startProcess) await this.download(ctx, ready.project, ready.scope, sandboxId, originals, secrets);
      const commandKind = decision.reason === "Install dependencies inside sandbox" ? "install" : normalized.args.includes("build") ? "build" : startProcess ? "preview" : "command";
      const failureCode = raw.status === "timed_out" ? "command_timeout" : raw.exitCode === 127 ? "command_not_found" : commandKind === "install" ? "install_failed" : commandKind === "build" ? "build_failed" : commandKind === "preview" ? "preview_start_failed" : "command_failed";
      const failureMessage = raw.status === "timed_out" ? "Sandbox command timed out" : commandKind === "install" ? "Dependency install failed" : commandKind === "build" ? "Build command failed" : commandKind === "preview" ? "Preview server failed to start" : "Sandbox command failed";
      await this.events.append(ctx, companyId, request.projectId, { runId: request.runId, agentId: request.agentId, sandboxId, processId: raw.processId, commandSummary: decision.requiresApproval ? "Approved command (" + createHash("sha256").update(command).digest("hex").slice(0, 12) + ")" : redactTerminalText(command, secrets), riskLevel: decision.level, status: startProcess ? "running" : raw.status, exitCode: raw.exitCode, output, durationMs: raw.durationMs, errorCode: raw.status === "completed" ? undefined : failureCode });
      if (raw.status !== "completed" && !startProcess) {
        throw new SandboxProviderError(failureCode, failureMessage, raw.status === "timed_out" ? 504 : 409, stepOf(decision), tool, raw.status === "timed_out");
      }
      return { ...raw, stdout: redactTerminalText(raw.stdout, secrets).slice(0, this.limits.outputLimitBytes), stderr: redactTerminalText(raw.stderr, secrets).slice(0, this.limits.outputLimitBytes), sandboxId, riskLevel: decision.level };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      if (error instanceof ProjectFileError) throw new SandboxProviderError(error.code, error.message, error.status, "workspace_sync", tool, false, error.currentRevision);
      throw new SandboxProviderError("sandbox_execution_failed", "Sandbox execution failed", 503, "sandbox", tool, true);
    }
  }
  async cloneRepository(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    input: { url: string; branch: string; token?: string; timeoutMs: number },
  ): Promise<SandboxFile[]> {
    await this.agent(ctx, companyId, "system", "project.terminal.exec");
    const project = await this.project(ctx, companyId, projectId);
    if (project.repositoryProvider !== "github" || project.repositoryUrl !== input.url) {
      throw new SandboxProviderError("repository_mismatch", "Repository is not connected to this Project", 403, "clone");
    }
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(input.url)
      || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(input.branch)
      || input.branch.includes("..") || input.branch.includes("@{")) {
      throw new SandboxProviderError("invalid_repository", "Invalid repository connection", 400, "clone");
    }
    if ((await this.workspace.listFiles(ctx, companyId, projectId)).length > 0) {
      throw new SandboxProviderError("project_not_empty", "Import requires an empty Project workspace", 409, "clone");
    }
    const ready = await this.ensure(ctx, project);
    const target = `/workspace/.npati-runtime/import-${randomUUID()}`;
    const command = `git -c core.hooksPath=/workspace/.npati-runtime/no-hooks clone --depth 1 --single-branch --branch '${input.branch}' -- '${input.url}' '${target}' && cp -R '${target}/.' /workspace/`;
    const environment: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
    if (input.token) {
      const header = Buffer.from(`x-access-token:${input.token}`).toString("base64");
      environment.GIT_CONFIG_COUNT = "1";
      environment.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      environment.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${header}`;
    }
    let result: SandboxCommandResult;
    try {
      result = await this.provider.executeCommand(ready.scope, ready.sandboxId, command, {
        timeoutMs: Math.min(Math.max(input.timeoutMs, 1_000), 300_000),
        outputLimitBytes: 4_096,
        environment,
      });
    } catch {
      throw new SandboxProviderError("repository_clone_failed", "Repository clone failed in sandbox", 502, "clone");
    }
    if (result.status !== "completed") {
      throw new SandboxProviderError(result.status === "timed_out" ? "repository_clone_timeout" : "repository_access_denied",
        result.status === "timed_out" ? "Repository clone timed out" : "Repository clone failed or access was denied",
        result.status === "timed_out" ? 504 : 403, "clone");
    }
    const files = await this.provider.downloadFiles(ready.scope, ready.sandboxId);
    if (files.length > this.limits.syncMaxFiles || files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content, "utf8"), 0) > this.limits.syncMaxBytes) {
      throw new SandboxProviderError("repository_too_large", "Repository exceeds Project import limits", 413, "clone");
    }
    for (const file of files) safeProjectPath(file.path);
    return files;
  }

  async evaluateAutoApprovalTerminal(ctx: AuthContext, companyId: string, runProjectId: string, request: TerminalRequest, tool: "project.terminal.exec" | "project.terminal.process"): Promise<{ allowed: boolean; reason: string; sandboxId?: string }> {
    if (!runProjectId) return { allowed: false, reason: "run_has_no_project" };
    if (request.projectId !== runProjectId) return { allowed: false, reason: "project_mismatch" };
    if (!request.agentId || request.agentId === "system") return { allowed: false, reason: "not_project_agent" };
    if (Object.keys(request.environmentReferences ?? {}).length) return { allowed: false, reason: "secret_references" };
    if (tool === "project.terminal.process" && request.action !== "start" && !["status", "logs", "stop"].includes(request.action ?? "")) return { allowed: false, reason: "invalid_process_action" };
    if ((tool === "project.terminal.exec" || request.action === "start") && classifyTerminalCommand(request).requiresApproval) return { allowed: false, reason: "command_policy_requires_approval" };
    const project = await this.project(ctx, companyId, request.projectId);
    await this.agent(ctx, companyId, request.agentId, tool);
    if (request.sandboxId && request.sandboxId !== project.sandboxId) return { allowed: false, reason: "sandbox_mismatch", sandboxId: project.sandboxId };
    return { allowed: true, reason: "project_sandbox_verified", sandboxId: project.sandboxId };
  }
  async canAutoApproveTerminal(ctx: AuthContext, companyId: string, runProjectId: string, request: TerminalRequest, tool: "project.terminal.exec" | "project.terminal.process") {
    return (await this.evaluateAutoApprovalTerminal(ctx, companyId, runProjectId, request, tool)).allowed;
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
  async proxyPreview(scope: SandboxScope, sandboxId: string, options: import("./sandbox-provider").PreviewProxyRequest) {
    if (!this.provider.proxyPreview) throw new Error("Sandbox runner does not support preview proxy");
    return this.provider.proxyPreview(scope, sandboxId, options);
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
