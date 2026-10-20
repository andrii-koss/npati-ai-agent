import { reuseDevelopmentPreview } from "./project-preview-reuse";
import { previewBrowserBridge } from "./preview-browser-bridge";
import { createHmac, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext, Project, ProjectStatus, WorkspaceStore } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import type { ProjectWorkspace } from "./project-workspace";
import type { ProjectSandboxService } from "./project-sandbox-service";
import { SandboxProviderError } from "./sandbox-provider";
import { projectRuntimeCommandPort } from "./shared-project-runtime-provider";

/** Stable across API/worker instances; the encryption key is never used directly as a signing key. */
export function resolvePreviewSecret(secret?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (secret || env.NPATI_PREVIEW_SECRET) return (secret || env.NPATI_PREVIEW_SECRET)!;
  if (env.NPATI_ENCRYPTION_KEY) return createHmac("sha256", env.NPATI_ENCRYPTION_KEY).update("npati/project-preview/v1").digest("hex");
  return randomBytes(32).toString("hex");
}

export interface DetectedStack {
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  framework: string;
  command: string;
  port: number;
  /** Command that serves the verified production build, when the framework has one. */
  productionCommand?: string;
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

export async function detectProjectStack(
  files: Array<{ path: string }>,
  readFile: (filePath: string) => Promise<string>,
): Promise<DetectedStack> {
  const pathSet = new Set(files.map((f) => f.path));

  // 1. Detect Package Manager
  let packageManager: "npm" | "pnpm" | "yarn" | "bun" = "npm";
  if (pathSet.has("pnpm-lock.yaml")) {
    packageManager = "pnpm";
  } else if (pathSet.has("yarn.lock")) {
    packageManager = "yarn";
  } else if (pathSet.has("bun.lock") || pathSet.has("bun.lockb")) {
    packageManager = "bun";
  } else if (pathSet.has("package-lock.json")) {
    packageManager = "npm";
  }

  // 2. Inspect package.json if present
  let pkg: any = null;
  if (pathSet.has("package.json")) {
    try {
      const content = await readFile("package.json");
      pkg = JSON.parse(content);
      if (pkg?.packageManager) {
        if (pkg.packageManager.startsWith("pnpm")) packageManager = "pnpm";
        else if (pkg.packageManager.startsWith("yarn")) packageManager = "yarn";
        else if (pkg.packageManager.startsWith("bun")) packageManager = "bun";
        else if (pkg.packageManager.startsWith("npm")) packageManager = "npm";
      }
    } catch {
      // Ignore parse failure, fallback
    }
  }

  // 3. Framework & Dev command detection
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    // Expo (React Native) projects preview through an Expo Web export served statically (D6).
    // The static export avoids Metro WebSockets and keeps bundle responses inside the preview
    // proxy limits; the port matches the static branch so the existing proxy path is reused.
    const hasExpo = Boolean(deps["expo"] || deps["react-native"] && (pathSet.has("app.json") || pathSet.has("app.config.js") || pathSet.has("app.config.ts")));
    if (hasExpo) {
      const port = 3000;
      const command = pkg.scripts?.export
        ? `${packageManager} run export && npx -y serve -s dist -l ${port}`
        : `npx expo export --platform web --output-dir dist && npx -y serve -s dist -l ${port}`;
      return { packageManager, framework: "expo", command, port };
    }
    const hasNext = Boolean(deps["next"] || Array.from(pathSet).some((p) => /^next\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasVite = Boolean(deps["vite"] || Array.from(pathSet).some((p) => /^vite\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasAstro = Boolean(deps["astro"] || Array.from(pathSet).some((p) => /^astro\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasNuxt = Boolean(deps["nuxt"] || Array.from(pathSet).some((p) => /^nuxt\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasRemix = Boolean(deps["@remix-run/react"] || deps["@react-router/dev"] || deps["@react-router/serve"] || Array.from(pathSet).some((p) => /^(?:remix|react-router)\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasSvelteKit = Boolean(deps["@sveltejs/kit"] || Array.from(pathSet).some((p) => /^svelte\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasAngular = Boolean(deps["@angular/core"]);
    const hasNest = Boolean(deps["@nestjs/core"]);
    const hasFastify = Boolean(deps["fastify"]);
    const hasExpress = Boolean(deps["express"]);

    if (hasNext) {
      const command = pkg.scripts?.dev ? `${packageManager} run dev` : "npx next dev";
      return { packageManager, framework: "nextjs", command, port: 3000, productionCommand: serveCommand("npx next start --hostname 0.0.0.0", 3000) };
    }
    if (hasNuxt) {
      const command = pkg.scripts?.dev ? `${packageManager} run dev` : "npx nuxi dev";
      return { packageManager, framework: "nuxt", command, port: 3000, productionCommand: "node .output/server/index.mjs" };
    }
    if (hasAstro) {
      const command = pkg.scripts?.dev
        ? pkg.scripts.dev.includes("--host") ? `${packageManager} run dev` : `${packageManager} run dev -- --host 0.0.0.0`
        : "npx astro dev --host 0.0.0.0";
      return { packageManager, framework: "astro", command, port: 4321, productionCommand: "npx astro preview --host 0.0.0.0 --port 4321" };
    }
    if (hasSvelteKit) {
      const command = pkg.scripts?.dev
        ? pkg.scripts.dev.includes("--host") ? `${packageManager} run dev` : `${packageManager} run dev -- --host 0.0.0.0`
        : "npx vite --host 0.0.0.0";
      return { packageManager, framework: "sveltekit", command, port: 5173, productionCommand: "node build/index.js" };
    }
    if (hasRemix) {
      const command = pkg.scripts?.dev ? `${packageManager} run dev` : "npx remix dev";
      return { packageManager, framework: "remix", command, port: 3000, productionCommand: "npx react-router-serve ./build/server/index.js" };
    }
    if (hasAngular) {
      const command = pkg.scripts?.start ? `${packageManager} run start` : "npx serve -s dist -l 3000";
      return { packageManager, framework: "angular", command, port: 3000, productionCommand: command };
    }
    if (hasNest) {
      const command = pkg.scripts?.start ? `${packageManager} run start` : "node dist/main.js";
      return { packageManager, framework: "nestjs", command, port: 3000, productionCommand: "node dist/main.js" };
    }
    if (hasFastify) {
      const command = pkg.scripts?.start ? `${packageManager} run start` : "node dist/server.js";
      return { packageManager, framework: "fastify", command, port: 3000, productionCommand: "node dist/server.js" };
    }
    if (hasExpress) {
      const command = pkg.scripts?.start ? `${packageManager} run start` : "node dist/server.js";
      return { packageManager, framework: "express", command, port: 3000, productionCommand: "node dist/server.js" };
    }
    if (hasVite) {
      const framework = deps["vue"] ? "vue" : "vite";
      const command = pkg.scripts?.dev
        ? pkg.scripts.dev.includes("--host") ? `${packageManager} run dev` : `${packageManager} run dev -- --host 0.0.0.0`
        : "npx vite --host 0.0.0.0";
      return { packageManager, framework, command, port: 5173, productionCommand: "npx vite preview --host 0.0.0.0 --port 5173" };
    }
    if (pkg.scripts?.dev) {
      return { packageManager, framework: "custom", command: `${packageManager} run dev`, port: 3000 };
    }
    if (pkg.scripts?.start) {
      return { packageManager, framework: "custom", command: `${packageManager} run start`, port: 3000 };
    }
  }

  // Non-Node / Static detection
  if (pathSet.has("manage.py") && pathSet.has("requirements.txt")) {
    const command = ".venv/bin/python manage.py runserver 0.0.0.0:$PORT --noreload";
    return { packageManager, framework: "django", command, port: 8000, productionCommand: command };
  }
  if (pathSet.has("requirements.txt")) {
    let fastapi = false;
    if (pathSet.has("main.py")) {
      const entry = await readFile("main.py").catch(() => "");
      fastapi = /FastAPI\s*\(|from\s+fastapi\b/.test(entry);
    }
    if (fastapi) {
      const command = ".venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port $PORT";
      return { packageManager, framework: "fastapi", command, port: 8000, productionCommand: command };
    }
    if (pathSet.has("app.py")) {
      return { packageManager, framework: "flask", command: ".venv/bin/python app.py", port: 3000, productionCommand: ".venv/bin/python app.py" };
    }
    return { packageManager, framework: "python", command: ".venv/bin/python -m http.server $PORT --bind 0.0.0.0", port: 8000, productionCommand: ".venv/bin/python -m http.server $PORT --bind 0.0.0.0" };
  }
  if (pathSet.has("composer.json")) {
    const command = pathSet.has("artisan") ? "php artisan serve --host=0.0.0.0 --port=$PORT" : "php -S 0.0.0.0:$PORT -t public";
    return { packageManager, framework: pathSet.has("artisan") ? "laravel" : "php", command, port: 8000, productionCommand: command };
  }
  if (pathSet.has("index.php")) {
    return { packageManager, framework: "php", command: "php -S 0.0.0.0:$PORT", port: 8000, productionCommand: "php -S 0.0.0.0:$PORT" };
  }
  if (pathSet.has("index.html")) {
    return { packageManager, framework: "static", command: "python3 -m http.server $PORT --bind 0.0.0.0", port: 3000, productionCommand: "python3 -m http.server $PORT --bind 0.0.0.0" };
  }

  return { packageManager, framework: "static", command: "python3 -m http.server $PORT --bind 0.0.0.0", port: 3000, productionCommand: "python3 -m http.server $PORT --bind 0.0.0.0" };
}

function serveCommand(command: string, port: number): string {
  return `${command} --port ${port}`;
}

export function extractPortFromCommand(command: string, fallbackPort: number): number {
  const match = command.match(/(?:-p|--port|-l)\s+(\d+)/);
  if (match && match[1]) {
    const parsed = Number(match[1]);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  }
  return fallbackPort;
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

export function rewriteSetCookieHeader(
  cookieStr: string,
  projectPrefix: string,
  proxyPath: string,
): string {
  const parts = cookieStr.split(";").map((p) => p.trim());
  if (parts.length === 0 || !parts[0] || !parts[0].includes("=")) return cookieStr;
  const eqIdx = parts[0].indexOf("=");
  const name = parts[0].slice(0, eqIdx);
  const val = parts[0].slice(eqIdx + 1);
  const newName = `${projectPrefix}${name}`;
  const attributes: string[] = [`${newName}=${val}`];
  let pathSet = false;
  let sameSiteSet = false;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const lower = part.toLowerCase();
    if (lower.startsWith("domain=")) {
      continue;
    }
    if (lower.startsWith("path=")) {
      attributes.push(`Path=${proxyPath}`);
      pathSet = true;
      continue;
    }
    if (lower.startsWith("samesite=")) {
      attributes.push("SameSite=Lax");
      sameSiteSet = true;
      continue;
    }
    attributes.push(part);
  }

  if (!pathSet) {
    attributes.push(`Path=${proxyPath}`);
  }
  if (!sameSiteSet) {
    attributes.push("SameSite=Lax");
  }

  return attributes.join("; ");
}

export function filterIncomingCookies(
  rawCookieHeader: string | undefined,
  projectPrefix: string,
): string | undefined {
  if (!rawCookieHeader || typeof rawCookieHeader !== "string") return undefined;
  const parts = rawCookieHeader.split(";");
  const upstreamCookies: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(projectPrefix)) {
      upstreamCookies.push(trimmed.slice(projectPrefix.length));
    }
  }
  return upstreamCookies.length > 0 ? upstreamCookies.join("; ") : undefined;
}

/** Project-scoped, HttpOnly preview session cookie. It is never forwarded to the project server. */
export function previewAuthCookieName(projectId: string): string {
  return `_npati_preview_${projectId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
}

export function readCookieValue(rawCookieHeader: string | undefined, name: string): string | undefined {
  if (!rawCookieHeader) return undefined;
  for (const part of rawCookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

export class ProjectPreviewService {
  private readonly secret: string;
  private readonly sessions = new Map<string, ActivePreviewSession>();

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
    ttlMs = 15 * 60 * 1000,
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

  async startPreview(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { command?: string; port?: number; agentId?: string; signal?: AbortSignal; callerOrigin?: string; verifiedBuild?: boolean } = {},
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
    if (project.status === "archived") throw new PreviewError("project_archived", "Archived project cannot run preview", 409);
    if (project.status === "soft_deleted" || project.status === "purging" || project.status === "deleted") {
      throw new PreviewError("project_deleted", "Deleted project cannot run preview", 409);
    }

    const files = await this.workspace.listFiles(ctx, companyId, projectId);
    const detected = await detectProjectStack(files, async (p) => (await this.workspace.readFile(ctx, companyId, projectId, p)).content);

    const verifiedBuild = options.verifiedBuild ?? project.lastBuildStatus === "ready";
    let devCommand = options.command?.trim()
      || (verifiedBuild && detected.productionCommand ? detected.productionCommand : detected.command);
    let devPort = options.port && Number.isInteger(options.port) ? options.port : extractPortFromCommand(devCommand, detected.port);

    const reused = options.verifiedBuild === false && !options.command && !options.port
      ? await reuseDevelopmentPreview(ctx, project, devCommand, devPort, detected.framework, this.sandbox, this.projects, scope => this.generateToken(scope), options.signal) : null;
    if (reused) { this.sessions.set(projectId, reused.session); return reused.result; }
    // Stop existing session process if running
    const existing = this.sessions.get(projectId);
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
    if (options.verifiedBuild !== true && options.verifiedBuild !== false && detected.framework !== "static" && files.some((f) => f.path === "package.json")) {
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
          await new Promise((resolve) => setTimeout(resolve, 1000));
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
    const finalFramework = project.framework || detected.framework;
    await this.projects.updatePreview(ctx, companyId, projectId, {
      status: "previewing",
      previewUrl,
      previewPort: devPort,
      framework: finalFramework,
      lastBuildStatus: verifiedBuild ? "ready" : detected.framework === "nextjs" ? null : "ready",
    });

    return {
      status: "running",
      previewUrl,
      token,
      port: devPort,
      framework: finalFramework,
      command: devCommand,
    };
  }

  async stopPreview(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { agentId?: string } = {},
  ): Promise<{ status: string; projectId: string }> {
    const existing = this.sessions.get(projectId);
    if (existing && this.sandbox) {
      await this.sandbox.process(ctx, companyId, {
        projectId,
        action: "stop",
        processId: existing.processId,
        agentId: options.agentId || "system",
      }).catch(() => undefined);
      this.sessions.delete(projectId);
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
    const project = await this.projects.get(ctx, companyId, projectId);
    const session = this.sessions.get(projectId);

    if (!session || !this.sandbox) {
      return {
        status: project.status,
        previewUrl: project.previewUrl,
        port: project.previewPort,
        framework: project.framework,
        lastBuildStatus: project.lastBuildStatus,
        isRunning: !!this.sandbox && project.status === "previewing" && !!project.previewUrl && !!project.previewPort,
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

      if (statusValue === "failed" || statusValue === "completed" || statusValue === "timed_out") {
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

    return {
      status: session.status === "failed" ? "failed" : project.status,
      previewUrl: project.previewUrl,
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

    let tokenPayload: PreviewTokenPayload;
    try {
      tokenPayload = this.validateTokenForRequest(token, companyId, projectId);
    } catch (error) {
      const known = error instanceof PreviewError ? error : new PreviewError("access_denied", "Unauthorized preview token", 403);
      return reply.code(known.status).send({ error: { code: known.code, message: known.message } });
    }

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
    const previewCookie = request.query.token
      ? `${cookieName}=${token}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=900${secureCookie ? "; Secure" : ""}`
      : null;
    const subpath = "/" + (request.params["*"] ?? "");
    const query = new URL(request.url, "http://localhost").searchParams;
    query.delete("token");
    const path = subpath + (query.size ? "?" + query.toString() : "");
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
    const filteredCookies = filterIncomingCookies(request.headers.cookie, projectPrefix);
    if (filteredCookies) {
      headers["cookie"] = filteredCookies;
    }

    const payload = request.body === undefined ? undefined
      : Buffer.from(typeof request.body === "string" ? request.body : JSON.stringify(request.body)).toString("base64");
    try {
      const result = await this.sandbox.proxyPreview({
        workspaceId: session.workspaceId, userId: session.userId, companyId, projectId,
      }, session.sandboxId, { port: session.port, path, method: request.method, headers, body: payload });
      reply.code(result.status);
      const prefix = `/api/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/preview/proxy`;
      const routed = (target: string) => `${prefix}${target}${target.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
      for (const [name, value] of Object.entries(result.headers)) {
        if (["connection", "transfer-encoding", "content-length", "content-encoding", "set-cookie"].includes(name.toLowerCase())) continue;
        if (typeof value === "string") {
          reply.header(name, name.toLowerCase() === "location" && value.startsWith("/") && !value.startsWith("//") ? routed(value) : value);
        }
      }

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
      const cookies = previewCookie ? [previewCookie, ...rewritten] : rewritten;
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
        const styledHtml = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, cssUrls);
        const bridge = previewBrowserBridge(prefix, token);
        body = Buffer.from(styledHtml.includes("<head>") ? styledHtml.replace("<head>", "<head>"+bridge) : bridge+styledHtml);
      }
      return reply.send(body);
    } catch (error) {
      return reply.code(502).type("text/html").send(`<!DOCTYPE html><html><body><h1>Preview Connection Failed</h1><pre>${escapeHtml(error instanceof Error ? error.message : "Unknown error")}</pre></body></html>`);
    }
  }
}
