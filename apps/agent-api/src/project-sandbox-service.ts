import { createHash, randomUUID } from "node:crypto";
import type { AuthContext, Project, WorkspaceStore } from "@npati/workspace";
import { ProjectFileError, safeProjectPath, type ProjectMountRequest, type ProjectWorkspace } from "./project-workspace";
import type { SandboxBrowserQaOptions, SandboxProvider, SandboxScope, SandboxStatus, SandboxCommandResult, SandboxFile } from "./sandbox-provider";
import { SandboxProviderError, SANDBOX_PROCESS_ENVIRONMENT_ALLOWLIST } from "./sandbox-provider";
import { classifyTerminalCommand, normalizeTerminalCommand, redactTerminalText, type TerminalCommandDecision } from "./terminal-command-policy";
import { ProjectTerminalEventsRepository } from "./project-terminal-events";
import { logTerminalPolicy } from "./terminal-policy-log";
import { gitShellHardeningEnv, resolveDepsPolicyLimits } from "./code-deps-policy";
import type { ProjectService } from "./project-service";
import { scanTextForSecrets } from "./code-secret-scanner";

export interface TerminalSecretReference { id: string; field: string; }
export interface TerminalRequest {
  projectId: string; sandboxId?: string; command?: string; executable?: string; args?: string[]; cwd?: string; processId?: string;
  action?: "start" | "status" | "logs" | "stop";
  environmentReferences?: Record<string, TerminalSecretReference>;
  approved?: boolean; runId?: string; agentId: string;
}
export interface TerminalLimits {
  commandTimeoutMs: number;
  installBuildTimeoutMs: number;
  outputLimitBytes: number;
  inactivityMs: number;
  syncMaxBytes: number;
  syncMaxFiles: number;
  /**
   * C10 (ТЗ item 7): how long a sandbox may stay idle (stopped **or** running) before the retention policy
   * destroys it. Destroying is safe — `ensure` recreates the sandbox from the stored project files — and not
   * destroying is not: a stopped container keeps its disk for as long as nothing removes it. Default seven days.
   */
  retentionMs: number;
}
export const defaultTerminalLimits: TerminalLimits = {
  commandTimeoutMs: 120_000, installBuildTimeoutMs: 600_000, outputLimitBytes: 64_000,
  inactivityMs: 900_000, syncMaxBytes: 20_000_000, syncMaxFiles: 500,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
};
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const scopeOf = (ctx: AuthContext, project: Project): SandboxScope => ({ workspaceId: ctx.workspaceId, userId: ctx.userId, companyId: project.companyId, projectId: project.id });
const stepOf = (decision: TerminalCommandDecision) => decision.timeoutClass === "install_build" ? "install_build" : "command";
const artifact = (filePath: string) => filePath.split("/").some((part) => ["node_modules", "dist", "build", ".next", ".nuxt", ".output", ".astro", ".cache", ".turbo", "vendor", "__pycache__", ".venv"].includes(part));

/** The only Project API variables a sandbox may receive (D5). */
export const PROJECT_API_SANDBOX_VARIABLES = SANDBOX_PROCESS_ENVIRONMENT_ALLOWLIST;
/** Server-side secrets and DB credentials never enter a sandbox; PROJECT_SECRET_KEY is deploy-only (D7). */
export function isForbiddenSandboxVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return upper === "PROJECT_SECRET_KEY" || upper === "EXPO_TOKEN" || upper === "DATABASE_URL" || upper.startsWith("PG") || upper.startsWith("POSTGRES") || upper.startsWith("NPATI_PROJECTS_POSTGRES") || /(^|_)DB_(URL|PASSWORD|USER|HOST)$/.test(upper);
}

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
    private readonly projectApiEnvironment?: (ctx: AuthContext, companyId: string, projectId: string) => Promise<Record<string, string>>,
  ) {
    const configured = Object.fromEntries(Object.entries(limits).filter(([, value]) => Number.isSafeInteger(value) && Number(value) > 0));
    this.limits = { ...defaultTerminalLimits, ...configured };
    this.limits.commandTimeoutMs = Math.min(this.limits.commandTimeoutMs, 600_000);
    this.limits.installBuildTimeoutMs = Math.min(this.limits.installBuildTimeoutMs, 600_000);
    this.limits.outputLimitBytes = Math.min(this.limits.outputLimitBytes, 128_000);
    /**
     * C10: the retention window can never be shorter than the inactivity window. Retention **destroys**, so a
     * misconfiguration that made the two disagree would delete a sandbox the very moment it was stopped — the
     * destructive outcome of a single typo, which is exactly what a floor here prevents.
     */
    this.limits.retentionMs = Math.max(this.limits.retentionMs, this.limits.inactivityMs);
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
      if (/(?:DATABASE_URL|PROJECT_SECRET_KEY|POSTGRES|PGPASSWORD|DB_PASSWORD|MIGRATOR|PROVISIONER|RUNTIME.*PASSWORD)/i.test(key) || /(?:DATABASE_URL|PROJECT_SECRET_KEY|POSTGRES|PGPASSWORD|DB_PASSWORD|MIGRATOR|PROVISIONER|RUNTIME.*PASSWORD)/i.test(reference.field)) throw new SandboxProviderError("protected_environment", "Database credentials and Project API secret keys are unavailable in sandbox", 403);
      const fields = await this.secretResolver!.resolve(ctx, companyId, reference.id);
      if (typeof fields[reference.field] !== "string") throw new SandboxProviderError("secret_not_found", "Secret reference was not found", 404);
      if (/^npati_sk_(?:dev|prod)_/i.test(fields[reference.field]!) || /^postgres(?:ql)?:\/\//i.test(fields[reference.field]!)) throw new SandboxProviderError("protected_environment", "Database credentials and Project API secret keys are unavailable in sandbox", 403);
      values[key] = fields[reference.field]!;
    }
    return values;
  }
  private touch(ctx: AuthContext, project: Project) { this.lastUse.set(project.id, { ctx, project, at: Date.now() }); }

  /**
   * C10 (ТЗ item 7): stops every sandbox whose **last activity** is older than the inactivity window.
   *
   * The timestamp comes from the sandbox itself (`status.lastActivityAt`), never from this process's clock alone:
   * a sandbox kept busy by a background process is not idle, and stopping it on the strength of "our map says so"
   * would kill work this process cannot see. A stopped sandbox is **kept in the map** rather than forgotten, which
   * is what makes the retention pass below able to reason about it without a second registry.
   */
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
        // Kept, not removed: the retention pass needs to know this sandbox exists and when it went quiet.
        item.at = now;
      } catch (error) {
        if (error instanceof SandboxProviderError && error.status === 404) this.lastUse.delete(projectId);
      }
    }
  }

  /**
   * C10 (ТЗ item 7): the retention policy that was missing.
   *
   * Auto-stop existed (above) and reattachment existed (`ensure`), but nothing ever **destroyed** a sandbox that
   * had been idle for a long time: a stopped container kept its disk for as long as the process lived and, after a
   * restart, forever — nothing could even name it, because the project row is the only durable pointer and the
   * idle map is in memory. This pass closes that: a sandbox whose last activity is older than the configured
   * retention window is destroyed, and `ensure` recreates it on demand (fresh, from the stored project files).
   *
   * `preview` exists for the reaper's dry run, so "nothing to clean" and "the port is unavailable" stay
   * distinguishable answers.
   */
  async retentionPreview(now = Date.now()): Promise<Array<{ projectId: string; sandboxId: string; idleMs: number }>> {
    const candidates: Array<{ projectId: string; sandboxId: string; idleMs: number }> = [];
    for (const [projectId, item] of this.lastUse) {
      if (!item.project.sandboxId) continue;
      const isRunning = await this.sandboxRuns(item).catch(() => null);
      if (isRunning === true) continue;
      const idleMs = now - item.at;
      if (idleMs < this.limits.retentionMs) continue;
      candidates.push({ projectId, sandboxId: item.project.sandboxId, idleMs });
    }
    return candidates;
  }

  /**
   * Destroys every sandbox past its retention window. Answers how many were destroyed. A sandbox that turns out to
   * be **running** is left alone: retention applies to idle sandboxes, and a pass that destroyed live work would be
   * a much worse bug than a late cleanup.
   */
  async sweepRetention(now = Date.now()): Promise<{ destroyed: number; candidates: number }> {
    const candidates = await this.retentionPreview(now);
    let destroyed = 0;
    for (const candidate of candidates) {
      const item = this.lastUse.get(candidate.projectId);
      if (!item || !item.project.sandboxId) continue;
      try {
        const isRunning = await this.sandboxRuns(item).catch(() => null);
        if (isRunning === true) continue;
        await this.destroy(item.ctx, item.project);
        destroyed += 1;
      } catch (error) {
        if (error instanceof SandboxProviderError && error.status === 404) this.lastUse.delete(candidate.projectId);
      }
    }
    return { destroyed, candidates: candidates.length };
  }

  /** What is currently tracked, for the reaper's `activeSandboxes` port. Never contains a destroyed sandbox. */
  listTrackedSandboxIds(): string[] {
    return [...this.lastUse.values()].map((item) => item.project.sandboxId).filter((id): id is string => Boolean(id));
  }

  /**
   * C10: the effective retention window, after the floor that keeps it at or above the inactivity window. Exposed
   * so the guarantee is observable from outside the class instead of being a claim in a comment.
   */
  get retentionWindowMs(): number {
    return this.limits.retentionMs;
  }

  /**
   * C10 (ТЗ item 7): puts a project under the retention policy **without** starting or creating anything.
   *
   * Why it is needed: the idle map is in memory, so after a restart a sandbox that exists on disk is invisible to
   * the sweep — it would never be stopped and never be destroyed, which is precisely the leak retention exists to
   * close. The caller re-registers the projects that recent runs touched (they are the only projects that can own
   * a code-run sandbox), and this records the sandbox's own `lastActivityAt` as the baseline rather than "now", so
   * a sandbox that has genuinely been idle for a week is not given a fresh week by the restart.
   */
  async trackForRetention(ctx: AuthContext, project: Project): Promise<boolean> {
    if (!project.sandboxId) return false;
    if (!this.lastUse.has(project.id)) this.lastUse.set(project.id, { ctx, project, at: Date.now() });
    const scope = scopeOf(ctx, project);
    try {
      const status = await this.provider.getStatus(scope, project.sandboxId);
      const remoteAt = Date.parse(status.lastActivityAt);
      const item = this.lastUse.get(project.id);
      if (item && Number.isFinite(remoteAt)) item.at = Math.min(item.at, remoteAt);
      return true;
    } catch (error) {
      // A sandbox the provider no longer knows about is not a retention candidate; drop it rather than retrying.
      if (error instanceof SandboxProviderError && error.status === 404) this.lastUse.delete(project.id);
      return false;
    }
  }

  /** `null` when the sandbox could not be asked; `true`/`false` otherwise, so an unknown is never read as `false`. */
  private async sandboxRuns(item: { ctx: AuthContext; project: Project }): Promise<boolean | null> {
    if (!item.project.sandboxId) return false;
    try {
      const status = await this.provider.getStatus(scopeOf(item.ctx, item.project), item.project.sandboxId);
      return status.state === "running";
    } catch (error) {
      if (error instanceof SandboxProviderError && error.status === 404) return false;
      return null;
    }
  }
  private async ensure(ctx: AuthContext, project: Project) {
    const scope = scopeOf(ctx, project);
    /**
     * C15: the mount this project's canonical workspace is, resolved **before** the container exists. It comes
     * from the workspace provider's own resolver (`mountFor`), so the directory handed to Docker is the one the
     * provider reads and writes — not a second path derived from a request. The runner re-derives it from the
     * allowlist it reads itself and refuses a disagreement, so a path that changed since the confirmation (or a
     * forged one) cannot become a bind mount.
     */
    const mount = this.workspace.mountFor ? await this.workspace.mountFor(ctx, project.companyId, project.id) : null;
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
      const created = await this.provider.createSandbox(scope, { runtime: project.runtime, ...(mount ? { mount } : {}) });
      try { project = await this.store.setProjectSandbox(ctx, project.companyId, project.id, created.id, project.sandboxId ?? null); }
      catch (error) { await this.provider.destroySandbox(scope, created.id).catch(() => undefined); throw error; }
      sandboxId = created.id;
      await this.provider.startSandbox(scope, sandboxId);
    }
    this.touch(ctx, { ...project, sandboxId });
    return { project: { ...project, sandboxId }, scope, sandboxId, mount };
  }
  private async upload(ctx: AuthContext, project: Project, scope: SandboxScope, sandboxId: string, mount: ProjectMountRequest | null) {
    /**
     * C15: nothing is uploaded into a mounted workspace. The container's `/workspace` **is** the canonical
     * folder, so a copy would be a second writer of the same files — and on an `ro` mount it could not be
     * written at all (which is the correct outcome, not an error to work around).
     */
    if (mount) return new Map<string, SandboxFile>();
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
      const fileName = file.path.split("/").pop() || "";
      const isLockfile = /^(?:package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|composer\.(?:json|lock)|requirements\.txt|Pipfile(?:\.lock)?)$/i.test(fileName);
      const original = originals.get(file.path);
      // Terminal redaction also matches TypeScript declarations such as `password: string`.
      // Scan source credentials instead, and avoid revalidating unchanged canonical files.
      const changed = !original || original.content !== file.content;
      const quotedCredential = /(?<![-A-Za-z0-9_])[A-Za-z0-9_]*(?:api[_-]?key|password|secret|token)(?![sS]\b)[A-Za-z0-9_]*["']?\s*[:=]\s*["'][^"']{8,}["']/i;
      if (secrets.some((secret) => secret.length > 0 && file.content.includes(secret)) ||
        (changed && !isLockfile && (!scanTextForSecrets(file.content).clean || quotedCredential.test(file.content)))) {
        throw new SandboxProviderError("secret_content", "Sandbox produced protected file content", 403, "download");
      }
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
    if (this.projectApiEnvironment) {
      const apiEnvironment = await this.projectApiEnvironment(ctx, companyId, project.id);
      for (const name of PROJECT_API_SANDBOX_VARIABLES) if (apiEnvironment[name]) environment[name] = apiEnvironment[name];
    }
    for (const name of Object.keys(environment)) if (isForbiddenSandboxVariable(name)) delete environment[name];
    /**
     * C11 (owner decision 6): every sandboxed command runs with the git credential surfaces neutralised,
     * from the same primitives the installer path uses (`code-deps-policy.ts`). `/workspace/.git/config`
     * and a container-global config persist for the life of the sandbox, so without this a later `git push`
     * could use a credential helper or an `extraheader` an earlier step left behind. Applied **after** the
     * secret values were captured for redaction (these values are not secrets) and after the
     * forbidden-variable filter, and it can only add git-scoped variables.
     */
    // Background processes accept only public Project API variables on the wire.
    // Their trusted Git hardening is supplied inside the runner after this validation.
    if (!startProcess) Object.assign(environment, gitShellHardeningEnv(resolveDepsPolicyLimits()));

    const timeoutMs = decision.timeoutClass === "install_build" ? this.limits.installBuildTimeoutMs : this.limits.commandTimeoutMs;
    let sandboxId = project.sandboxId ?? "";
    try {
      const ready = await this.ensure(ctx, project);
      sandboxId = ready.sandboxId;
      if (request.sandboxId && request.sandboxId !== sandboxId) throw new SandboxProviderError("sandbox_mismatch", "Sandbox does not belong to this Project", 403, "authorization", tool);
      logTerminalPolicy({ rawCommand: normalized.rawCommand, normalizedCommand: command, sandboxId, projectId: project.id, decision: "allow", reason: request.approved && decision.requiresApproval ? "human_approved" : "sandbox_execution", policyRule: decision.policyRule, toolName: tool, executionContext: "project_sandbox", runId: request.runId ?? "direct", agentId: request.agentId, runType: "project_tool", cwd: normalized.cwd, rawArgs: normalized.args, commandPolicyRule: decision.policyRule });
      const originals = await this.upload(ctx, ready.project, ready.scope, sandboxId, ready.mount);
      const raw = startProcess
        ? await this.provider.startProcess(ready.scope, sandboxId, command, { timeoutMs, outputLimitBytes: this.limits.outputLimitBytes, environment, cwd: normalized.cwd })
        : await this.provider.executeCommand(ready.scope, sandboxId, command, { timeoutMs, outputLimitBytes: this.limits.outputLimitBytes, environment, cwd: normalized.cwd });
      const output = redactTerminalText(raw.stdout + (raw.stderr ? "\n" + raw.stderr : ""), secrets).slice(0, this.limits.outputLimitBytes);
      /**
       * C15: for a **mounted** project the sandbox writes into the canonical folder through the bind mount, so
       * there is nothing to copy back — and copying back would be actively wrong: it would make the sandbox a
       * second writer of the same directory (whichever copy landed last would win, and a file the agent deleted
       * would reappear from the container's view of it) and it would apply the sync size ceilings
       * (`syncMaxFiles`/`syncMaxBytes`) to a folder the user owns rather than to the project's own quota. The
       * upload is skipped for the same reason: the files are already there, because the container *is* mounted
       * on them. The read-before-write `originals` map is therefore empty for a mounted project, and the
       * download below is the only place the distinction is observable.
       */
      if (!startProcess && !ready.mount) await this.download(ctx, ready.project, ready.scope, sandboxId, originals, secrets);
      const commandKind = decision.reason === "Install dependencies inside sandbox" ? "install" : normalized.args.includes("build") ? "build" : startProcess ? "preview" : "command";
      const failureCode = raw.status === "timed_out" ? "command_timeout" : raw.exitCode === 127 ? "command_not_found" : commandKind === "install" ? "install_failed" : commandKind === "build" ? "build_failed" : commandKind === "preview" ? "preview_start_failed" : "command_failed";
      const detail = (raw.stderr || raw.stdout || "").trim();
      const failureMessage = raw.status === "timed_out" ? "Sandbox command timed out" : commandKind === "install" ? `Dependency install failed${detail ? `: ${detail.slice(-300)}` : ""}` : commandKind === "build" ? `Build command failed${detail ? `: ${detail.slice(-300)}` : ""}` : commandKind === "preview" ? `Preview server failed to start${detail ? `: ${detail.slice(-300)}` : ""}` : `Sandbox command failed${detail ? `: ${detail.slice(-300)}` : ""}`;
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
  supportsPreviewProxy(): boolean {
    return typeof this.provider.proxyPreview === "function";
  }

  async stopRecordedPreview(ctx: AuthContext, companyId: string, projectId: string, command: string) {
    const project = await this.project(ctx, companyId, projectId);
    if (!project.sandboxId) return;
    const history = await this.events.list(ctx, companyId, projectId);
    const approvedSummary = "Approved command (" + createHash("sha256").update(command).digest("hex").slice(0, 12) + ")";
    const previous = history.find(event => event.processId && event.sandboxId === project.sandboxId && (event.commandSummary === command || event.commandSummary === approvedSummary) && event.status === "running");
    if (!previous?.processId) return;
    const latest = history.find(event => event.processId === previous.processId);
    if (latest?.status === "stopped") return;
    await this.process(ctx, companyId, { projectId, processId: previous.processId, action: "stop", agentId: "system" });
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
