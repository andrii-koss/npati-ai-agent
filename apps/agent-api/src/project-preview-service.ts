import { rewriteSetCookieHeader, filterIncomingCookies, previewAuthCookieName, readCookieValue } from "./project-preview-cookies";
export { rewriteSetCookieHeader, filterIncomingCookies, previewAuthCookieName, readCookieValue } from "./project-preview-cookies";
import { validateStaticProjectResources } from "./static-project-validation";
import { detectProjectStack, extractPortFromCommand } from "./project-preview-stack";
export { detectProjectStack, extractPortFromCommand } from "./project-preview-stack";
export type { DetectedStack } from "./project-preview-stack";
import { canReusePreviewSession, reuseDevelopmentPreview } from "./project-preview-reuse";
import { previewBrowserBridge, rewritePreviewSsrResources } from "./preview-browser-bridge";
import { createHmac, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext, Project, ProjectStatus, WorkspaceStore } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import type { ProjectWorkspace } from "./project-workspace";
import type { ProjectSandboxService } from "./project-sandbox-service";
import { SandboxProviderError } from "./sandbox-provider";
import { projectRuntimeCommandPort } from "./shared-project-runtime-provider";
import { canonicalFrameworkName, isDesktopProjectFramework } from "@npati/shared";
/** Stable across API/worker instances; the encryption key is never used directly as a signing key. */
export function resolvePreviewSecret(secret?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (secret || env.NPATI_PREVIEW_SECRET) return (secret || env.NPATI_PREVIEW_SECRET)!;
  if (env.NPATI_ENCRYPTION_KEY) return createHmac("sha256", env.NPATI_ENCRYPTION_KEY).update("npati/project-preview/v1").digest("hex");
  return randomBytes(32).toString("hex");
}

export interface PreviewTokenPayload {
  workspaceId?: string;
  userId: string;
  companyId: string;
  projectId: string;
  sandboxId: string;
  expiresAt: number;
}
export interface ActivePreviewSession {
  projectId: string;
  companyId: string;
  sandboxId: string;
  processId: string;
  port: number;
  framework: string;
  command: string;
  restartCount: number;
  maxRestarts: number;
  status: "starting" | "running" | "restarting" | "failed" | "stopped";
  lastError?: string;
  startedAt: string;
  workspaceId: string;
  userId: string;
}
const sandboxInfrastructureErrors = new Set(["sandbox_image_not_found", "docker_cli_missing", "docker_daemon_unavailable", "docker_socket_permission_denied", "sandbox_network_not_found", "sandbox_container_start_failed", "sandbox_workspace_permission_denied", "sandbox_storage_full", "runner_unavailable"]);
export class PreviewError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}
function base64UrlEncode(data: string): string {
  return Buffer.from(data, "utf8").toString("base64url");
}
function base64UrlDecode(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export type PreviewOriginRegistrar = (ctx: AuthContext, companyId: string, projectId: string, origin: string) => Promise<void>;
export function parseExactHttpOrigin(raw?: string | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("*")) return null;
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.origin !== trimmed) return null;
    return url.origin;
  } catch {
    return null;
  }
}
export class ProjectPreviewService {
  private readonly secret: string;
  private readonly sessions = new Map<string, ActivePreviewSession>();
  private readonly recoveries = new Map<string, Promise<unknown>>();
  private readonly starts = new Map<string, ReturnType<ProjectPreviewService["launchPreview"]>>();
  constructor(
    private readonly projects: ProjectService,
    private readonly workspaceStore: WorkspaceStore,
    private readonly workspace: ProjectWorkspace,
    private readonly sandbox: ProjectSandboxService | undefined,
    secret?: string,
    private readonly onPreviewStart?: PreviewOriginRegistrar,
  ) {
    this.secret = resolvePreviewSecret(secret);
  }
  async buildProject(ctx: AuthContext, companyId: string, projectId: string, onStage?: (stage: "dependencies" | "build", details?: { command: string; status: "running" | "completed" | "failed"; stdout?: string; stderr?: string; exitCode?: number; durationMs?: number }) => void, options: { dependenciesOnly?: boolean } = {}): Promise<void> {
    if (!this.sandbox) throw new PreviewError("sandbox_unavailable", "Sandbox runner is not configured", 503);
    const files = await this.workspace.listFiles(ctx, companyId, projectId);
    const stack = await detectProjectStack(files, async (filePath) => (await this.workspace.readFile(ctx, companyId, projectId, filePath)).content);
    const paths = new Set(files.map((file) => file.path));
    try {
      const run = async (stage: "dependencies" | "build", command: string) => {
        onStage?.(stage, { command, status: "running" });
        try {
          const result = await this.sandbox!.execute(ctx, companyId, { projectId, command, agentId: "system", approved: true });
          onStage?.(stage, { command, status: result.exitCode === 0 ? "completed" : "failed", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? undefined, durationMs: result.durationMs });
          if (result.exitCode !== 0) throw new PreviewError("build_failed", "Command failed: " + command, 409);
        } catch (error) { onStage?.(stage, { command, status: "failed" }); throw error; }
      };
      if (!paths.has("package.json")) {
        if (paths.has("requirements.txt")) {
          await run("dependencies", "python3 -m venv .venv");
          await run("dependencies", ".venv/bin/python -m pip install -r requirements.txt");
        } else if (paths.has("composer.json")) {
          await run("dependencies", "composer install --no-interaction --prefer-dist");
        } else {
          return;
        }
        if (!options.dependenciesOnly && paths.has("Makefile")) await run("build", "make build");
        return;
      }
      const manifest = JSON.parse((await this.workspace.readFile(ctx, companyId, projectId, "package.json")).content) as { scripts?: Record<string, string> };
      if (!options.dependenciesOnly && !manifest.scripts?.build) return;
      const install = stack.packageManager === "npm" && paths.has("package-lock.json") ? "npm ci"
        : stack.packageManager === "pnpm" && paths.has("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile"
        : `${stack.packageManager} install`;
      await run("dependencies", install);
      if (!options.dependenciesOnly && manifest.scripts?.build) await run("build", `${stack.packageManager} run build`);
    } catch (error) {
      if (error instanceof SandboxProviderError && sandboxInfrastructureErrors.has(error.code)) {
        throw new PreviewError("sandbox_unavailable", error.message, error.status);
      }
      throw new PreviewError("build_failed", error instanceof Error ? error.message : String(error), 409);
    }
  }
  generateToken(
    payload: Omit<PreviewTokenPayload, "expiresAt">,
    ttlMs = 24 * 60 * 60 * 1000,
  ): { token: string; expiresAt: number } {
    const expiresAt = Date.now() + ttlMs;
    const fullPayload: PreviewTokenPayload = { ...payload, expiresAt };
    const serialized = JSON.stringify(fullPayload);
    const body = base64UrlEncode(serialized);
    const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
    return { token: `${body}.${signature}`, expiresAt };
  }
  verifyToken(token: string): PreviewTokenPayload {
    if (typeof token !== "string" || !token.includes(".")) {
      throw new PreviewError("invalid_token", "Invalid preview token format", 401);
    }
    const [body, signature] = token.split(".");
    if (!body || !signature) {
      throw new PreviewError("invalid_token", "Invalid preview token structure", 401);
    }
    const expected = createHmac("sha256", this.secret).update(body).digest("base64url");
    if (signature !== expected) {
      throw new PreviewError("invalid_token", "Preview token signature verification failed", 403);
    }
    let payload: PreviewTokenPayload;
    try {
      payload = JSON.parse(base64UrlDecode(body));
    } catch {
      throw new PreviewError("invalid_token", "Preview token payload is corrupt", 400);
    }
    if (typeof payload.expiresAt !== "number" || Date.now() > payload.expiresAt) {
      throw new PreviewError("token_expired", "Preview token has expired", 403);
    }
    return payload;
  }
  validateTokenForRequest(
    token: string,
    companyId: string,
    projectId: string,
  ): PreviewTokenPayload {
    const payload = this.verifyToken(token);
    if (payload.companyId !== companyId || payload.projectId !== projectId) {
      throw new PreviewError("token_scope_denied", "Preview token does not match requested project", 403);
    }
    return payload;
  }
  /**
   * Shows a file saved outside a run in the running Preview, which serves the sandbox's copy of the project. A static
   * site or a dev server only needs the copy refreshed; a production server shows what was built, so it is rebuilt.
   */
  async applyFileChanges(ctx: AuthContext, companyId: string, projectId: string): Promise<{ status: string; rebuilt: boolean }> {
    const project = await this.projects.get(ctx, companyId, projectId);
    if (project.status !== "previewing") return { status: "not_running", rebuilt: false };
    const files = await this.workspace.listFiles(ctx, companyId, projectId);
    const detected = await detectProjectStack(files, async (p) => (await this.workspace.readFile(ctx, companyId, projectId, p)).content);
    if (detected.framework === "static") return { status: (await this.startPreview(ctx, companyId, projectId)).status, rebuilt: false };
    if (project.lastBuildStatus !== "ready") return { status: (await this.startPreview(ctx, companyId, projectId, { verifiedBuild: false })).status, rebuilt: false };
    await this.buildProject(ctx, companyId, projectId);
    return { status: (await this.startPreview(ctx, companyId, projectId, { verifiedBuild: true })).status, rebuilt: true };
  }

  async startPreview(
    ctx: AuthContext, companyId: string, projectId: string,
    options: { command?: string; port?: number; agentId?: string; signal?: AbortSignal; callerOrigin?: string; verifiedBuild?: boolean; forceRestart?: boolean } = {},
  ): ReturnType<ProjectPreviewService["launchPreview"]> {
    // Browser actions can overlap a status recovery. Keep one identical launch in flight.
    if (options.signal || options.forceRestart) return this.launchPreview(ctx, companyId, projectId, options);
    const key = JSON.stringify([ctx.workspaceId, ctx.userId, ctx.companyId, companyId, projectId, options.command, options.port, options.verifiedBuild, options.agentId]);
    const pending = this.starts.get(key);
    if (pending) return pending;
    const start = this.launchPreview(ctx, companyId, projectId, options);
    this.starts.set(key, start);
    try { return await start; }
    finally { if (this.starts.get(key) === start) this.starts.delete(key); }
  }
  private async launchPreview(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { command?: string; port?: number; agentId?: string; signal?: AbortSignal; callerOrigin?: string; verifiedBuild?: boolean; forceRestart?: boolean } = {},
  ): Promise<{
    status: string;
    previewUrl: string;
    token: string;
    port: number;
    framework: string;
    command: string;
  }> {
    if (!this.sandbox) throw new PreviewError("sandbox_unavailable", "Sandbox runner is not configured", 503);
    options.signal?.throwIfAborted();
    const validOrigin = parseExactHttpOrigin(options.callerOrigin);
    if (validOrigin && this.onPreviewStart) {
      await this.onPreviewStart(ctx, companyId, projectId, validOrigin).catch((err) => {
        console.warn(`[startPreview] Failed to auto-register preview CORS origin:`, err);
      });
    }
    const project = await this.projects.get(ctx, companyId, projectId);
    if (isDesktopProjectFramework(project.framework)) throw new PreviewError("desktop_preview_unsupported", "Desktop projects require a supported display runtime; HTTP Preview is not a GUI window", 409);
    if (project.status === "archived") throw new PreviewError("project_archived", "Archived project cannot run preview", 409);
    if (project.status === "soft_deleted" || project.status === "purging" || project.status === "deleted") {
      throw new PreviewError("project_deleted", "Deleted project cannot run preview", 409);
    }
    const files = await this.workspace.listFiles(ctx, companyId, projectId);
    const detected = await detectProjectStack(files, async (p) => (await this.workspace.readFile(ctx, companyId, projectId, p)).content);
    if (project.framework === "Flutter" && detected.framework !== "flutter") throw new PreviewError("native_preview_unsupported", "This project has no Flutter source to build for the web; HTTP Preview is not a native application", 409);
    if (detected.framework === "static" && (!options.command || project.framework === "HTML/CSS")) {
      try { await validateStaticProjectResources(files, async p => (await this.workspace.readFile(ctx, companyId, projectId, p)).content); }
      catch (error) { throw new PreviewError("preview_resources_missing", error instanceof Error ? error.message : "Static resource validation failed", 409); }
    }
    const verifiedBuild = options.verifiedBuild ?? project.lastBuildStatus === "ready";
    let devCommand = options.command?.trim()
      || (verifiedBuild && detected.productionCommand ? detected.productionCommand : detected.command);
    let devPort = options.port && Number.isInteger(options.port) ? options.port : extractPortFromCommand(devCommand, detected.port);
    const reused = canReusePreviewSession({ verifiedBuild: options.verifiedBuild, command: options.command, port: options.port, framework: detected.framework, forceRestart: options.forceRestart })
      ? await reuseDevelopmentPreview(ctx, project, devCommand, devPort, detected.framework, this.sandbox, this.projects, scope => this.generateToken(scope), options.signal) : null;
    if (reused) { this.sessions.set(projectId, reused.session); return reused.result; }
    // Stop existing session process if running
    const existing = this.sessions.get(projectId);
    await this.projects.updatePreview(ctx, companyId, projectId, { status: "building" });
    if (existing) existing.status = "restarting";
    try {
    if (existing) {
      await this.sandbox.process(ctx, companyId, {
        projectId,
        action: "stop",
        processId: existing.processId,
        agentId: options.agentId || "system",
      }).catch(() => undefined);
      this.sessions.delete(projectId);
    }
    // Expose port on sandbox runner
    const exposed = await this.sandbox.exposePort(ctx, companyId, projectId, devPort);
    if (exposed && exposed.port !== devPort) {
      devPort = exposed.port;
      devCommand = projectRuntimeCommandPort(devCommand, devPort);
    }
    const updatedProject = await this.projects.get(ctx, companyId, projectId);
    const sandboxId = updatedProject.sandboxId;
    if (!sandboxId) throw new PreviewError("sandbox_failed", "Failed to obtain sandbox ID", 500);
    // API and worker session maps can disagree; stop every recorded listener before replacement.
    const previousCommands = new Set([projectRuntimeCommandPort(detected.command, devPort), devCommand]);
    if (detected.productionCommand) previousCommands.add(projectRuntimeCommandPort(detected.productionCommand, devPort));
    for (const command of previousCommands) await this.sandbox.stopRecordedPreview(ctx, companyId, projectId, command);
    // Ensure dependencies are installed before starting the dev server for node/framework projects
    if (!verifiedBuild && options.verifiedBuild !== false && detected.framework !== "static" && files.some((f) => f.path === "package.json")) {
      let hasModules = false;
      try {
        const check = await this.sandbox.execute(ctx, companyId, {
          projectId,
          command: "ls node_modules",
          agentId: options.agentId || "system",
          approved: true,
        });
        hasModules = check.exitCode === 0;
      } catch {}
      if (!hasModules) {
        const paths = new Set(files.map((f) => f.path));
        const installCmd = detected.packageManager === "pnpm" && paths.has("pnpm-lock.yaml")
          ? "pnpm install"
          : detected.packageManager === "yarn" && paths.has("yarn.lock")
            ? "yarn install"
            : "npm install";
        try {
          await this.sandbox.execute(ctx, companyId, {
            projectId,
            command: installCmd,
            agentId: options.agentId || "system",
            approved: true,
          });
        } catch (installErr) {
          console.warn(`[startPreview] Dependency preparation warning for project ${projectId}:`, installErr);
        }
      }
    }
    // Python and PHP projects have no node_modules step: without their own environment the server command cannot start.
    if (!verifiedBuild && options.verifiedBuild !== false && !files.some((f) => f.path === "package.json")) {
      const paths = new Set(files.map((f) => f.path));
      const setup = paths.has("requirements.txt")
        ? { check: "test -x .venv/bin/python", commands: ["python3 -m venv .venv", ".venv/bin/python -m pip install -r requirements.txt"] }
        : paths.has("composer.json") ? { check: "test -f vendor/autoload.php", commands: ["composer install --no-interaction --prefer-dist"] } : null;
      if (setup) {
        const ready = await this.sandbox.execute(ctx, companyId, { projectId, command: setup.check, agentId: options.agentId || "system", approved: true }).then((result) => result.exitCode === 0, () => false);
        if (!ready) for (const command of setup.commands) {
          await this.sandbox.execute(ctx, companyId, { projectId, command, agentId: options.agentId || "system", approved: true }).catch((error) => console.warn(`[startPreview] Dependency preparation warning for project ${projectId}:`, error));
        }
      }
    }
    // Start process in sandbox
    options.signal?.throwIfAborted();
    const result = await this.sandbox.process(ctx, companyId, {
      projectId,
      action: "start",
      command: devCommand,
      agentId: options.agentId || "system",
      approved: true,
    });
    const processId = result.processId;
    if (!processId) throw new PreviewError("process_failed", "Failed to start preview dev server process", 500);
    // Starting a process does not mean its HTTP server (or first compilation) is ready.
    if (this.sandbox.supportsPreviewProxy()) {
      const deadline = Date.now() + 90_000;
      let ready = false;
      try {
        while (Date.now() < deadline) {
          options.signal?.throwIfAborted();
          const response = await this.sandbox.proxyPreview({
            workspaceId: ctx.workspaceId, userId: ctx.userId, companyId, projectId,
          }, sandboxId, { port: devPort, path: "/", method: "GET", headers: {} }).catch(() => null);
          if (response && response.status < 500) { ready = true; break; }
          const state = await this.sandbox.process(ctx, companyId, {
            projectId, action: "status", processId, agentId: options.agentId || "system",
          });
          if (!("status" in state) || state.status !== "running") break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!ready) throw new PreviewError("preview_start_failed", "Preview server did not become HTTP-ready", 503);
      } catch (error) {
        await this.sandbox.process(ctx, companyId, {
          projectId, action: "stop", processId, agentId: options.agentId || "system",
        }).catch(() => undefined);
        throw error;
      }
    }
    if (options.signal?.aborted) {
      await this.sandbox.process(ctx, companyId, { projectId, action: "stop", processId, agentId: options.agentId || "system" }).catch(() => undefined);
      options.signal.throwIfAborted();
    }
    // Generate signed preview token
    const { token } = this.generateToken({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      companyId,
      projectId,
      sandboxId,
    });
    const previewUrl = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/preview/proxy/?token=${encodeURIComponent(token)}`;
    // Store active preview session
    const session: ActivePreviewSession = {
      projectId,
      companyId,
      sandboxId,
      processId,
      port: devPort,
      framework: detected.framework,
      command: devCommand,
      restartCount: 0,
      maxRestarts: 3,
      status: "running",
      startedAt: new Date().toISOString(),
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
    };
    this.sessions.set(projectId, session);
    // Update project state in DB
    // The project keeps a canonical framework name ("React + Vite", "HTML/CSS"), not Preview's own stack label.
    const finalFramework = project.framework || detected.framework;
    const storedFramework = project.framework || canonicalFrameworkName(detected.framework) || detected.framework;
    await this.projects.updatePreview(ctx, companyId, projectId, {
      status: "previewing",
      previewUrl,
      previewPort: devPort,
      framework: storedFramework,
      lastBuildStatus: verifiedBuild || !detected.productionCommand ? "ready" : "development",
    });
    return {
      status: "running",
      previewUrl,
      token,
      port: devPort,
      framework: finalFramework,
      command: devCommand,
    };
    } catch (error) {
      if (existing) { existing.status = "failed"; existing.lastError = "Preview server failed to become ready"; this.sessions.set(projectId, existing); }
      await this.projects.updatePreview(ctx, companyId, projectId, { status: "failed" }).catch(() => undefined);
      throw error;
    }
  }
  async stopPreview(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { agentId?: string } = {},
  ): Promise<{ status: string; projectId: string }> {
    const project = await this.projects.get(ctx, companyId, projectId);
    const existing = this.sessions.get(projectId);
    if (existing && this.sandbox) {
      await this.sandbox.process(ctx, companyId, {
        projectId,
        action: "stop",
        processId: existing.processId,
        agentId: options.agentId || "system",
      });
      this.sessions.delete(projectId);
    }
    // The listener may belong to a worker or a previous API instance. Reuse the
    // durable Terminal journal just as replacement startup already does.
    if (this.sandbox && project.sandboxId && project.previewPort) {
      const files = await this.workspace.listFiles(ctx, companyId, projectId);
      const detected = await detectProjectStack(files, async p => (await this.workspace.readFile(ctx, companyId, projectId, p)).content);
      const commands = new Set([projectRuntimeCommandPort(detected.command, project.previewPort)]);
      if (detected.productionCommand) commands.add(projectRuntimeCommandPort(detected.productionCommand, project.previewPort));
      if (existing?.command) commands.add(existing.command);
      for (const command of commands) await this.sandbox.stopRecordedPreview(ctx, companyId, projectId, command);
    }
    await this.projects.updatePreview(ctx, companyId, projectId, {
      status: "ready",
      previewUrl: null,
      previewPort: null,
    });
    return { status: "stopped", projectId };
  }
  async getPreviewStatus(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
  ): Promise<{
    status: ProjectStatus;
    previewUrl?: string | null;
    port?: number | null;
    framework?: string | null;
    lastBuildStatus?: string | null;
    isRunning: boolean;
    error: string | null;
    restartCount: number;
  }> {
    let project = await this.projects.get(ctx, companyId, projectId);
    const session = this.sessions.get(projectId);
    if (!session || !this.sandbox) {
      // Database state survives a restart; the site's HTTP process may not.
      if (this.sandbox?.supportsPreviewProxy() && ["previewing", "failed"].includes(project.status) && project.sandboxId && project.previewPort) {
        const scope = { workspaceId: ctx.workspaceId, userId: ctx.userId, companyId, projectId };
        const response = await this.sandbox.proxyPreview(scope, project.sandboxId,
          { port: project.previewPort, path: "/", method: "GET", headers: {} }).catch(() => null);
        if (response && response.status >= 200 && response.status < 400 && project.status === "failed") {
          project = await this.projects.updatePreview(ctx, companyId, projectId, { status: "previewing" });
        } else if (project.status === "failed") {
          return { status: project.status, previewUrl: project.previewUrl, port: project.previewPort, framework: project.framework,
            lastBuildStatus: project.lastBuildStatus, isRunning: false, error: "Preview server is not running", restartCount: 0 };
        }
        if (!response || response.status >= 500) {
          const key = JSON.stringify(scope);
          let recovery = this.recoveries.get(key);
          if (!recovery) {
            recovery = this.startPreview(ctx, companyId, projectId, { verifiedBuild: project.lastBuildStatus === "ready" });
            this.recoveries.set(key, recovery);
          }
          try {
            await recovery;
          } catch (error) {
            return { status: project.status, previewUrl: project.previewUrl, port: project.previewPort,
              framework: project.framework, lastBuildStatus: project.lastBuildStatus, isRunning: false,
              error: error instanceof Error ? error.message : "Preview recovery failed", restartCount: 0 };
          } finally {
            if (this.recoveries.get(key) === recovery) this.recoveries.delete(key);
          }
          return this.getPreviewStatus(ctx, companyId, projectId);
        }
      }
      let activePreviewUrl = project.previewUrl;
      if (this.sandbox && project.status === "previewing" && project.previewPort) {
        let isExpired = false;
        if (activePreviewUrl) {
          const match = activePreviewUrl.match(/token=([^&]+)/);
          if (match && match[1]) {
            try { this.verifyToken(decodeURIComponent(match[1])); }
            catch { isExpired = true; }
          }
        }
        if (!activePreviewUrl || isExpired) {
          const { token } = this.generateToken({
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            companyId,
            projectId,
            sandboxId: project.sandboxId || "default",
          });
          activePreviewUrl = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/preview/proxy/?token=${encodeURIComponent(token)}`;
          void this.projects.updatePreview(ctx, companyId, projectId, { previewUrl: activePreviewUrl }).catch(() => {});
        }
      }
      return {
        status: project.status,
        previewUrl: activePreviewUrl,
        port: project.previewPort,
        framework: project.framework,
        lastBuildStatus: project.lastBuildStatus,
        isRunning: !!this.sandbox && project.status === "previewing" && !!activePreviewUrl && !!project.previewPort,
        error: null,
        restartCount: 0,
      };
    }
    // Monitor process status
    try {
      const procStatus = await this.sandbox.process(ctx, companyId, {
        projectId,
        action: "status",
        processId: session.processId,
        agentId: "system",
      });
      const statusValue = (procStatus as any).status;
      if (statusValue === "failed" || statusValue === "completed" || statusValue === "timed_out" || statusValue === "stopped") {
        // Dev server exited
        const logData = await this.sandbox.process(ctx, companyId, {
          projectId,
          action: "logs",
          processId: session.processId,
          agentId: "system",
        }).catch(() => ({ output: "" }));
        const rawLog = (logData as any)?.output ?? "";
        if (rawLog.includes("EADDRINUSE") || rawLog.includes("address already in use")) {
          session.lastError = `Port ${session.port} is already in use`;
        } else if (rawLog.trim()) {
          session.lastError = rawLog.trim().slice(-2000);
        }
        if (session.restartCount < session.maxRestarts) {
          session.restartCount++;
          session.status = "restarting";
          // Auto-restart
          const restartResult = await this.sandbox.process(ctx, companyId, {
            projectId,
            action: "start",
            command: session.command,
            agentId: "system",
            approved: true,
          }) as any;
          if (restartResult?.processId) {
            session.processId = restartResult.processId;
            session.status = "running";
          } else {
            session.status = "failed";
          }
        } else {
          session.status = "failed";
          session.lastError = session.lastError || "Dev server crashed after 3 auto-restart attempts";
          await this.projects.updatePreview(ctx, companyId, projectId, {
            status: "failed",
            lastBuildStatus: "failed",
          });
        }
      }
    } catch (cause) {
      session.status = "failed";
      session.lastError = cause instanceof Error ? cause.message : "Failed to inspect process";
    }
    let activePreviewUrl = project.previewUrl;
    if (session.status === "running") {
      let isExpired = false;
      if (activePreviewUrl) {
        const match = activePreviewUrl.match(/token=([^&]+)/);
        if (match && match[1]) {
          try { this.verifyToken(decodeURIComponent(match[1])); }
          catch { isExpired = true; }
        }
      }
      if (!activePreviewUrl || isExpired) {
        const { token } = this.generateToken({
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          companyId,
          projectId,
          sandboxId: session.sandboxId,
        });
        activePreviewUrl = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/preview/proxy/?token=${encodeURIComponent(token)}`;
      }
    }
    return {
      status: session.status === "failed" ? "failed" : project.status,
      previewUrl: activePreviewUrl,
      port: session.port,
      framework: session.framework,
      lastBuildStatus: session.status === "failed" ? "failed" : project.lastBuildStatus,
      isRunning: session.status === "running",
      error: session.lastError ?? null,
      restartCount: session.restartCount,
    };
  }
  getSession(projectId: string): ActivePreviewSession | undefined {
    return this.sessions.get(projectId);
  }
  async assertProjectAccess(ctx: AuthContext, companyId: string, projectId: string): Promise<Project> {
    return this.projects.get(ctx, companyId, projectId);
  }
  setSession(projectId: string, session: ActivePreviewSession): void {
    this.sessions.set(projectId, session);
  }
  async handleProxy(
    request: FastifyRequest<{ Params: { companyId: string; projectId: string; "*": string }; Querystring: { token?: string } }>,
    reply: FastifyReply,
  ) {
    const { companyId, projectId } = request.params;
    const cookieName = previewAuthCookieName(projectId);
    const token = request.query.token
      || (request.headers.authorization?.replace(/^Bearer\s+/i, ""))
      || readCookieValue(request.headers.cookie, cookieName)
      || "";
    let tokenPayload: PreviewTokenPayload | undefined;
    try {
      tokenPayload = this.validateTokenForRequest(token, companyId, projectId);
    } catch (error) {
      if (error instanceof PreviewError && error.code === "token_expired") {
        try {
          const [body, signature] = (token || "").split(".");
          if (body && signature) {
            const expected = createHmac("sha256", this.secret).update(body).digest("base64url");
            if (signature === expected) {
              const rawPayload = JSON.parse(base64UrlDecode(body)) as PreviewTokenPayload;
              if (rawPayload.companyId === companyId && rawPayload.projectId === projectId) {
                tokenPayload = rawPayload;
                const cookiePath = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/preview/proxy`;
                const fresh = this.generateToken({
                  workspaceId: rawPayload.workspaceId,
                  userId: rawPayload.userId,
                  companyId,
                  projectId,
                  sandboxId: rawPayload.sandboxId || "default",
                });
                reply.header("Set-Cookie", `${cookieName}=${fresh.token}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=86400`);
              }
            }
          }
        } catch { }
      }
      if (!tokenPayload) {
        const known = error instanceof PreviewError ? error : new PreviewError("access_denied", "Unauthorized preview token", 403);
        return reply.code(known.status).send({ error: { code: known.code, message: known.message } });
      }
    }
    const scope = { workspaceId: tokenPayload.workspaceId ?? this.sessions.get(projectId)?.workspaceId ?? "", userId: tokenPayload.userId, permissions: ["workspace:read"] };
    try {
      const project = await this.projects.get(scope, companyId, projectId);
      if (project.status === "building") return reply.code(503).header("retry-after", "1").send({ error: { code: "preview_starting", message: "Preview is restarting; its upstream is not ready yet." } });
      if (project.status === "failed") return reply.code(502).send({ error: { code: "preview_failed", message: "Preview failed to start. Inspect the build or runtime error before restarting." } });
    } catch { return reply.code(403).send({ error: { code: "preview_access_denied", message: "Preview project is unavailable." } }); }
    let session: Pick<ActivePreviewSession, "workspaceId" | "userId" | "sandboxId" | "port" | "status" | "lastError"> | undefined = this.sessions.get(projectId);
    // Worker-created previews and API restarts have no local session; authorize the signed scope again.
    if (!session && tokenPayload.workspaceId && this.sandbox) {
      try {
        const project = await this.projects.get({ workspaceId: tokenPayload.workspaceId, userId: tokenPayload.userId, permissions: ["workspace:read"] }, companyId, projectId);
        if (project.status === "previewing" && project.previewPort && project.sandboxId === tokenPayload.sandboxId) {
          session = { workspaceId: tokenPayload.workspaceId, userId: tokenPayload.userId, sandboxId: tokenPayload.sandboxId, port: project.previewPort, status: "running" };
        }
      } catch { return reply.code(403).send({ error: { code: "preview_access_denied", message: "Preview project is unavailable." } }); }
    }
    if (!session) {
      return reply.code(404).type("text/html").send(`
        <!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview Inactive</title>
        <style>body{font-family:sans-serif;background:#0f172a;color:#94a3b8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
        .card{background:#1e293b;padding:2rem;border-radius:8px;text-align:center;border:1px solid #334155;}</style></head>
        <body><div class="card"><h2>Preview server is not running</h2><p>Click "Start Preview" in the Project header to launch the site.</p></div></body></html>
      `);
    }
    if (session.status === "starting" || session.status === "restarting") return reply.code(503).header("retry-after", "1").send({ error: { code: "preview_starting", message: "Preview upstream is not ready yet." } });
    if (session.status === "failed") {
      return reply.code(502).type("text/html").send(`
        <!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview Error</title>
        <style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;padding:2rem;}
        .card{background:#1e293b;border:1px solid #ef4444;border-radius:8px;padding:1.5rem;max-width:800px;margin:2rem auto;}
        h1{color:#f87171;font-size:1.25rem;margin-top:0;}
        pre{background:#0f172a;padding:1rem;border-radius:6px;overflow-x:auto;color:#fca5a5;font-size:0.875rem;}</style></head>
        <body><div class="card"><h1>Build / Runtime Error</h1><p>The preview dev server exited with an error:</p><pre><code>${escapeHtml(session.lastError || "Unknown error")}</code></pre></div></body></html>
      `);
    }
    if (!this.sandbox) return reply.code(503).send({ error: "Sandbox runner unavailable" });
    const cookiePath = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/preview/proxy`;
    const secureCookie = (request.headers["x-forwarded-proto"] ?? request.protocol) === "https";
    // Both supported API aliases serve relative parser-loaded assets. Keep the same signed
    // session scoped to this Project on each alias; a /api cookie cannot authorize /companies.
    const previewCookies = request.query.token
      ? [cookiePath, cookiePath.slice(4)].map(path => `${cookieName}=${token}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=900${secureCookie ? "; Secure" : ""}`)
      : [];
    const subpath = "/" + (request.params["*"] ?? "");
    // The query stays as written: Vite reads flags like ?astro&lang.css, and URLSearchParams would rewrite them to lang.css=.
    const rawQuery = request.url.includes("?") ? request.url.slice(request.url.indexOf("?") + 1).split("&").filter((part) => part && !part.startsWith("token=")).join("&") : "";
    const path = subpath + (rawQuery ? "?" + rawQuery : "");
    const headers: Record<string, string> = {};
    const forwardedHeaderNames = [
      "accept",
      "accept-language",
      "content-type",
      "user-agent",
      "cache-control",
      "pragma",
      "if-match",
      "if-none-match",
      "if-modified-since",
      "if-unmodified-since",
      "x-requested-with",
      "x-user-token",
    ];
    for (const name of forwardedHeaderNames) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const authHeader = request.headers.authorization;
    if (typeof authHeader === "string" && authHeader.trim()) {
      const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
      const isPlatformToken = bearer === token || bearer.startsWith("npati_");
      if (!isPlatformToken) {
        headers["authorization"] = authHeader;
      }
    }
    const projectPrefix = `_npati_p_${projectId.slice(0, 8)}_`;
    // Frameworks reject a form whose Origin differs from their own host (SvelteKit answers 403), and the browser only knows the proxy's.
    if (typeof request.headers.origin === "string") headers["origin"] = `http://127.0.0.1:${session.port}`;
    const filteredCookies = filterIncomingCookies(request.headers.cookie, projectPrefix);
    if (filteredCookies) {
      headers["cookie"] = filteredCookies;
    }
    const payload = request.body === undefined ? undefined
      : Buffer.from(typeof request.body === "string" ? request.body : JSON.stringify(request.body)).toString("base64");
    try {
      let result: import("./sandbox-provider").PreviewProxyResponse | undefined;
      const maxAttempts = request.method === "GET" ? 8 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          result = await this.sandbox.proxyPreview({
            workspaceId: session.workspaceId, userId: session.userId, companyId, projectId,
          }, session.sandboxId, { port: session.port, path, method: request.method, headers, body: payload });
          if (result.status < 500 || attempt === maxAttempts - 1) break;
          await new Promise((r) => setTimeout(r, 350));
        } catch (attemptErr) {
          if (attempt === maxAttempts - 1) throw attemptErr;
          await new Promise((r) => setTimeout(r, 350));
        }
      }
      if (!result) throw new Error("Preview server unavailable");
      reply.code(result.status);
      const prefix = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/preview/proxy`;
      const routed = (target: string) => `${prefix}${target}${target.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
      for (const [name, value] of Object.entries(result.headers)) {
        if (["connection", "transfer-encoding", "content-length", "content-encoding", "set-cookie"].includes(name.toLowerCase())) continue;
        if (typeof value === "string") {
          reply.header(name, name.toLowerCase() === "location" && value.startsWith("/") && !value.startsWith("//") ? routed(value) : value);
        }
      }
      // A file server that states no caching rule lets the browser reuse a stylesheet it just saw, so a fresh edit looked
      // unchanged. The browser now asks every time and gets a cheap 304 when nothing changed; a framework's own rule stays.
      if (!Object.keys(result.headers).some((name) => name.toLowerCase() === "cache-control")) reply.header("cache-control", "no-cache");
      const setCookieRaw = result.headers["set-cookie"] || result.headers["Set-Cookie"];
      let rewritten: string[] = [];
      if (setCookieRaw) {
        const cookieList: string[] = Array.isArray(setCookieRaw)
          ? setCookieRaw
          : typeof setCookieRaw === "string" && setCookieRaw.includes("\n")
            ? setCookieRaw.split("\n")
            : [String(setCookieRaw)];
        rewritten = cookieList.map((c) => rewriteSetCookieHeader(c, projectPrefix, prefix));
      }
      const cookies = [...previewCookies, ...rewritten];
      if (cookies.length) reply.header("set-cookie", cookies);
      let body = Buffer.from(result.body, "base64");
      if (String(result.headers["content-type"] ?? "").includes("text/html")) {
        const html = body.toString("utf8").replace(/(src|href|action|poster)=(["'])(\/[^"']*)\2/gi, (match, attr: string, quote: string, target: string, offset: number, source: string) => {
          // React must hydrate the original anchor props. The browser bridge routes clicks instead.
          const tag = source.slice(source.lastIndexOf("<", offset), offset);
          if (target.startsWith("//") || attr.toLowerCase() === "href" && /^<a\s/i.test(tag)) return match;
          // The document establishes the scoped HttpOnly preview cookie. Module URLs must
          // match their relative imports exactly, otherwise Nuxt/Vue executes twice.
          const resource = `${prefix}${target}`;
          return `${attr}=${quote}${attr.toLowerCase() === "action" ? routed(target) : resource}${quote}`;
        });
        const cssUrls = (css: string) => css.replace(/url\(\s*(["']?)(\/(?!\/)[^)'"\s]+)\1\s*\)/gi,
          (match, quote: string, target: string) => target.startsWith(prefix + "/") ? match : `url(${quote}${prefix}${target}${quote})`);
        const styledHtml = rewritePreviewSsrResources(html, prefix).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, cssUrls);
        const bridge = previewBrowserBridge(prefix, token);
        body = Buffer.from(styledHtml.includes("<head>") ? styledHtml.replace("<head>", "<head>"+bridge) : bridge+styledHtml);
      }
      return reply.send(body);
    } catch (error) {
      return reply.code(502).type("text/html").send(`<!DOCTYPE html><html><body><h1>Preview Connection Failed</h1><pre>${escapeHtml(error instanceof Error ? error.message : "Unknown error")}</pre></body></html>`);
    }
  }
}
