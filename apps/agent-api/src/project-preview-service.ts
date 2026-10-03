import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext, Project, ProjectStatus, WorkspaceStore } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import type { ProjectWorkspace } from "./project-workspace";
import type { ProjectSandboxService } from "./project-sandbox-service";

export interface DetectedStack {
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  framework: string;
  command: string;
  port: number;
}

export interface PreviewTokenPayload {
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
  internalHost: string;
}

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
    const hasNext = Boolean(deps["next"] || Array.from(pathSet).some((p) => /^next\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasVite = Boolean(deps["vite"] || Array.from(pathSet).some((p) => /^vite\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasAstro = Boolean(deps["astro"] || Array.from(pathSet).some((p) => /^astro\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasNuxt = Boolean(deps["nuxt"] || Array.from(pathSet).some((p) => /^nuxt\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasRemix = Boolean(deps["@remix-run/react"] || Array.from(pathSet).some((p) => /^remix\.config\.(?:js|ts|mjs)$/.test(p)));
    const hasSvelteKit = Boolean(deps["@sveltejs/kit"] || Array.from(pathSet).some((p) => /^svelte\.config\.(?:js|ts|mjs)$/.test(p)));

    if (hasNext) {
      const command = pkg.scripts?.dev ? `${packageManager} run dev` : "npx next dev";
      return { packageManager, framework: "nextjs", command, port: 3000 };
    }
    if (hasAstro) {
      const command = pkg.scripts?.dev
        ? pkg.scripts.dev.includes("--host") ? `${packageManager} run dev` : `${packageManager} run dev -- --host 0.0.0.0`
        : "npx astro dev --host 0.0.0.0";
      return { packageManager, framework: "astro", command, port: 4321 };
    }
    if (hasVite || hasSvelteKit) {
      const framework = hasSvelteKit ? "sveltekit" : "vite";
      const command = pkg.scripts?.dev
        ? pkg.scripts.dev.includes("--host") ? `${packageManager} run dev` : `${packageManager} run dev -- --host 0.0.0.0`
        : "npx vite --host 0.0.0.0";
      return { packageManager, framework, command, port: 5173 };
    }
    if (hasNuxt) {
      const command = pkg.scripts?.dev ? `${packageManager} run dev` : "npx nuxi dev";
      return { packageManager, framework: "nuxt", command, port: 3000 };
    }
    if (hasRemix) {
      const command = pkg.scripts?.dev ? `${packageManager} run dev` : "npx remix dev";
      return { packageManager, framework: "remix", command, port: 3000 };
    }
    if (pkg.scripts?.dev) {
      return { packageManager, framework: "custom", command: `${packageManager} run dev`, port: 3000 };
    }
    if (pkg.scripts?.start) {
      return { packageManager, framework: "custom", command: `${packageManager} start`, port: 3000 };
    }
  }

  // Non-Node / Static detection
  if (pathSet.has("index.html")) {
    return { packageManager, framework: "static", command: "npx -y serve -s . -l 3000", port: 3000 };
  }
  if (pathSet.has("requirements.txt") || pathSet.has("Pipfile") || pathSet.has("app.py") || pathSet.has("main.py")) {
    return { packageManager, framework: "python", command: "python3 -m http.server 8000", port: 8000 };
  }
  if (pathSet.has("index.php") || pathSet.has("composer.json")) {
    return { packageManager, framework: "php", command: "php -S 0.0.0.0:8000", port: 8000 };
  }

  return { packageManager, framework: "static", command: "npx -y serve -s . -l 3000", port: 3000 };
}

export function extractPortFromCommand(command: string, fallbackPort: number): number {
  const match = command.match(/(?:-p|--port|-l)\s+(\d+)/);
  if (match && match[1]) {
    const parsed = Number(match[1]);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  }
  return fallbackPort;
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
  ) {
    this.secret = secret || process.env.NPATI_PREVIEW_SECRET || randomBytes(32).toString("hex");
  }

  async buildProject(ctx: AuthContext, companyId: string, projectId: string): Promise<void> {
    if (!this.sandbox) throw new PreviewError("sandbox_unavailable", "Sandbox runner is not configured", 503);
    const files = await this.workspace.listFiles(ctx, companyId, projectId);
    const stack = await detectProjectStack(files, async (filePath) => (await this.workspace.readFile(ctx, companyId, projectId, filePath)).content);
    const paths = new Set(files.map((file) => file.path));
    if (!paths.has("package.json")) return;
    const manifest = JSON.parse((await this.workspace.readFile(ctx, companyId, projectId, "package.json")).content) as { scripts?: Record<string, string> };
    if (!manifest.scripts?.build) return;
    const install = stack.packageManager === "npm" && paths.has("package-lock.json") ? "npm ci"
      : stack.packageManager === "pnpm" && paths.has("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile"
      : `${stack.packageManager} install`;
    try {
      await this.sandbox.execute(ctx, companyId, { projectId, command: install, agentId: "system", approved: true });
      await this.sandbox.execute(ctx, companyId, { projectId, command: `${stack.packageManager} run build`, agentId: "system", approved: true });
    } catch (error) {
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
    options: { command?: string; port?: number; agentId?: string } = {},
  ): Promise<{
    status: string;
    previewUrl: string;
    token: string;
    port: number;
    framework: string;
    command: string;
  }> {
    if (!this.sandbox) throw new PreviewError("sandbox_unavailable", "Sandbox runner is not configured", 503);
    const project = await this.projects.get(ctx, companyId, projectId);
    if (project.status === "archived") throw new PreviewError("project_archived", "Archived project cannot run preview", 409);

    // Detect stack & dev command
    const files = await this.workspace.listFiles(ctx, companyId, projectId);
    const detected = await detectProjectStack(files, async (p) => (await this.workspace.readFile(ctx, companyId, projectId, p)).content);

    const devCommand = options.command?.trim() || detected.command;
    const devPort = options.port && Number.isInteger(options.port) ? options.port : extractPortFromCommand(devCommand, detected.port);

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
    const portExposure = await this.sandbox.exposePort(ctx, companyId, projectId, devPort);
    const updatedProject = await this.projects.get(ctx, companyId, projectId);
    const sandboxId = updatedProject.sandboxId;
    if (!sandboxId) throw new PreviewError("sandbox_failed", "Failed to obtain sandbox ID", 500);

    // Start process in sandbox
    const result = await this.sandbox.process(ctx, companyId, {
      projectId,
      action: "start",
      command: devCommand,
      agentId: options.agentId || "system",
      approved: true,
    });

    const processId = result.processId;
    if (!processId) throw new PreviewError("process_failed", "Failed to start preview dev server process", 500);

    // Generate signed preview token
    const { token } = this.generateToken({
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
      internalHost: portExposure.internalHost,
    };
    this.sessions.set(projectId, session);

    // Update project state in DB
    const finalFramework = project.framework || detected.framework;
    await this.projects.updatePreview(ctx, companyId, projectId, {
      status: "previewing",
      previewUrl,
      previewPort: devPort,
      framework: finalFramework,
      lastBuildStatus: "ready",
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
        isRunning: false,
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

  setSession(projectId: string, session: ActivePreviewSession): void {
    this.sessions.set(projectId, session);
  }

  async handleProxy(
    request: FastifyRequest<{ Params: { companyId: string; projectId: string; "*": string }; Querystring: { token?: string } }>,
    reply: FastifyReply,
  ) {
    const { companyId, projectId } = request.params;
    const token = request.query.token || (request.headers.authorization?.replace(/^Bearer\s+/i, "")) || "";

    try {
      this.validateTokenForRequest(token, companyId, projectId);
    } catch (error) {
      const known = error instanceof PreviewError ? error : new PreviewError("access_denied", "Unauthorized preview token", 403);
      return reply.code(known.status).send({ error: { code: known.code, message: known.message } });
    }

    const session = this.sessions.get(projectId);
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

    const subpath = "/" + (request.params["*"] ?? "");
    const targetHost = session.internalHost;
    const targetPort = session.port;

    return new Promise<void>((resolve, reject) => {
      const headers = { ...request.headers };
      delete headers["host"];
      delete headers["connection"];

      const req = http.request(
        {
          host: targetHost,
          port: targetPort,
          path: subpath + (request.url.includes("?") ? "?" + request.url.split("?")[1] : ""),
          method: request.method,
          headers: {
            ...headers,
            host: `${targetHost}:${targetPort}`,
          },
        },
        (res) => {
          reply.code(res.statusCode ?? 200);
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) {
              reply.header(key, value);
            }
          }
          res.pipe(reply.raw);
          res.on("end", () => resolve());
          res.on("error", (err) => reject(err));
        },
      );

      req.on("error", (err) => {
        reply.code(502).type("text/html").send(`
          <!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview Error</title>
          <style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;padding:2rem;}
          .card{background:#1e293b;border:1px solid #ef4444;border-radius:8px;padding:1.5rem;max-width:800px;margin:2rem auto;}
          h1{color:#f87171;font-size:1.25rem;margin-top:0;}
          pre{background:#0f172a;padding:1rem;border-radius:6px;overflow-x:auto;color:#fca5a5;font-size:0.875rem;}</style></head>
          <body><div class="card"><h1>Preview Connection Failed</h1><p>Could not connect to preview server on port ${targetPort}:</p><pre><code>${escapeHtml(err.message)}</code></pre></div></body></html>
        `);
        resolve();
      });

      if (request.body && (request.method === "POST" || request.method === "PUT" || request.method === "PATCH")) {
        const payload = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
        req.write(payload);
      }
      req.end();
    });
  }
}
