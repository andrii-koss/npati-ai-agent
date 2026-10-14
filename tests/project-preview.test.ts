import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CapabilityInspectorService, defaultCapabilityRegistry } from "@npati/shared";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { LocalProjectWorkspace, generateUnifiedDiff } from "../apps/agent-api/src/project-workspace";
import { ProjectSandboxService } from "../apps/agent-api/src/project-sandbox-service";
import { ProjectTerminalEventsRepository } from "../apps/agent-api/src/project-terminal-events";
import {
  detectProjectStack,
  extractPortFromCommand,
  ProjectPreviewService,
  PreviewError,
} from "../apps/agent-api/src/project-preview-service";
import { registerProjectPreviewRoutes } from "../apps/agent-api/src/project-preview-routes";
import {
  SandboxProviderError,
  type SandboxCommandResult,
  type SandboxFile,
  type SandboxProvider,
  type SandboxScope,
  type SandboxStatus,
} from "../apps/agent-api/src/sandbox-provider";
import { LocalDevAuthProvider } from "../apps/agent-api/src/auth";
import { CompanyToolRuntime } from "../apps/agent-api/src/company-tool-runtime";
import { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
import type { AIEngine } from "@npati/omniroute-adapter";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const owner: AuthContext = {
  workspaceId: "tenant-a",
  userId: "user-a",
  permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"],
};

const otherUser: AuthContext = {
  ...owner,
  userId: "user-b",
};

const commandResult = (status: SandboxCommandResult["status"] = "completed", exitCode = 0, stdout = ""): SandboxCommandResult => ({
  status,
  exitCode,
  stdout,
  stderr: "",
  durationMs: 5,
  step: "command",
  tool: "project.terminal.exec",
  retryable: false,
});

class MockSandbox implements SandboxProvider {
  readonly id = "33333333-3333-4333-8333-333333333333";
  state: SandboxStatus["state"] = "created";
  files: SandboxFile[] = [];
  processStatus: SandboxCommandResult["status"] = "running";
  processExitCode: number | null = null;
  processLogs = "Dev server listening on 0.0.0.0:3000";
  processFailOnCheck = false;
  calls: string[] = [];

  private status(): SandboxStatus {
    return { id: this.id, state: this.state, createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() };
  }

  private check(scope: SandboxScope, id: string) {
    if (id !== this.id || !scope.projectId || !scope.companyId) {
      throw new SandboxProviderError("sandbox_scope_denied", "Sandbox scope denied", 403);
    }
  }

  async createSandbox(_scope: SandboxScope) {
    this.calls.push("create");
    return this.status();
  }
  async startSandbox(scope: SandboxScope, id: string) {
    this.check(scope, id);
    this.state = "running";
    this.calls.push("start");
    return this.status();
  }
  async stopSandbox(scope: SandboxScope, id: string) {
    this.check(scope, id);
    this.state = "stopped";
    this.calls.push("stop");
    return this.status();
  }
  async destroySandbox(scope: SandboxScope, id: string) {
    this.check(scope, id);
    this.state = "destroyed";
    this.calls.push("destroy");
  }
  async getStatus(scope: SandboxScope, id: string) {
    this.check(scope, id);
    return this.status();
  }
  async uploadFiles(scope: SandboxScope, id: string, files: SandboxFile[]) {
    this.check(scope, id);
    this.files = files;
    this.calls.push("upload");
  }
  async downloadFiles(scope: SandboxScope, id: string) {
    this.check(scope, id);
    this.calls.push("download");
    return this.files;
  }
  async executeCommand(scope: SandboxScope, id: string, command: string) {
    this.check(scope, id);
    this.calls.push("exec:" + command);
    return commandResult();
  }
  async exposePort(scope: SandboxScope, id: string, port: number): Promise<{ port: number; internalHost: string }> {
    this.check(scope, id);
    this.calls.push("expose:" + port);
    return { port, internalHost: "127.0.0.1" };
  }
  async getLogs(scope: SandboxScope, id: string, _processId?: string) {
    this.check(scope, id);
    return this.processLogs;
  }
  async startProcess(scope: SandboxScope, id: string, command: string) {
    this.check(scope, id);
    this.calls.push("process:" + command);
    return { ...commandResult(), processId: "44444444-4444-4444-8444-444444444444" };
  }
  async stopProcess(scope: SandboxScope, id: string, _processId: string) {
    this.check(scope, id);
    this.calls.push("stopProcess");
    return commandResult("stopped");
  }
  async getProcessStatus(scope: SandboxScope, id: string, _processId: string) {
    this.check(scope, id);
    if (this.processFailOnCheck) {
      return commandResult("failed", 1);
    }
    return commandResult(this.processStatus, this.processExitCode);
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "npati-preview-test-"));
  roots.push(root);
  const store = new InMemoryWorkspaceStore();
  await store.initialize();
  const company = await store.createCompany(owner, { name: "Preview Co" }, "preview-company");
  const otherCompany = await store.createCompany(otherUser, { name: "Other Co" }, "other-preview-company");
  const projects = new ProjectService(store);
  const { project } = await projects.create(owner, company.id, { name: "Site", type: "website" }, "preview-project");
  const workspace = new LocalProjectWorkspace(projects, { root });
  const provider = new MockSandbox();
  const events = new ProjectTerminalEventsRepository(projects);
  const sandbox = new ProjectSandboxService(projects, store, workspace, provider, events);
  const preview = new ProjectPreviewService(projects, store, workspace, sandbox, "test-preview-secret-key-32chars!");

  return { store, company, otherCompany, project, projects, workspace, provider, events, sandbox, preview };
}

describe("Step 4 — Project Preview & Changes", () => {
  it("prepares dependencies without building or starting Preview before agent edits", async () => {
    const { preview, sandbox, workspace, company, project } = await fixture();
    await workspace.createFile(owner, company.id, project.id, "package.json", JSON.stringify({ scripts: { build: "next build" }, dependencies: { next: "15.0.0" } }));
    const execute = vi.spyOn(sandbox, "execute").mockResolvedValue(commandResult());
    const stages: string[] = [];
    await preview.buildProject(owner, company.id, project.id, stage => stages.push(stage), { dependenciesOnly: true });
    expect(execute.mock.calls.map(call => call[2].command)).toEqual(["npm install"]);
    expect(stages).toEqual(["dependencies", "dependencies"]);
    expect(preview.getSession(project.id)).toBeUndefined();
    execute.mockClear();
    await preview.buildProject(owner, company.id, project.id);
    expect(execute.mock.calls.map(call => call[2].command)).toEqual(["npm install", "npm run build"]);
  });
  it("waits for HTTP readiness before publishing the preview", async () => {
    const { preview, sandbox, workspace, company, project } = await fixture();
    await workspace.createFile(owner, company.id, project.id, "index.html", "Ready");
    vi.spyOn(sandbox, "supportsPreviewProxy").mockReturnValue(true);
    const probe = vi.spyOn(sandbox, "proxyPreview")
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockResolvedValueOnce({ status: 200, headers: {}, body: "" });
    await expect(preview.startPreview(owner, company.id, project.id)).resolves.toMatchObject({ status: "running" });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[0][0].projectId).toBe(project.id);
  });

  it("stops a failed preview process without publishing a ready session", async () => {
    const { preview, sandbox, workspace, provider, company, project } = await fixture();
    await workspace.createFile(owner, company.id, project.id, "index.html", "Ready");
    vi.spyOn(sandbox, "supportsPreviewProxy").mockReturnValue(true);
    vi.spyOn(sandbox, "proxyPreview").mockResolvedValue({ status: 502, headers: {}, body: "" });
    provider.processFailOnCheck = true;
    await expect(preview.startPreview(owner, company.id, project.id)).rejects.toMatchObject({ code: "preview_start_failed" });
    expect(provider.calls).toContain("stopProcess");
    expect((await preview.getPreviewStatus(owner, company.id, project.id)).isRunning).toBe(false);
  });

  it("classifies a missing sandbox image as an infrastructure failure", async () => {
    const { preview, workspace, provider, company, project } = await fixture();
    await workspace.createFile(owner, company.id, project.id, "package.json", JSON.stringify({ scripts: { build: "next build" }, dependencies: { next: "15.0.0" } }));
    vi.spyOn(provider, "createSandbox").mockRejectedValueOnce(new SandboxProviderError("sandbox_image_not_found", "Sandbox image not found", 503));
    await expect(preview.buildProject(owner, company.id, project.id)).rejects.toMatchObject({ code: "sandbox_unavailable", message: "Sandbox image not found", status: 503 });
  });
  it("stops the recorded preview listener after API session state is lost", async () => {
    const { preview, sandbox, workspace, provider, projects, store, company, project } = await fixture();
    await workspace.createFile(owner, company.id, project.id, "index.html", "Preview");
    await preview.startPreview(owner, company.id, project.id);
    const restored = new ProjectPreviewService(projects, store, workspace, sandbox, "test-preview-secret-key-32chars!");
    const count = provider.calls.length;
    await restored.startPreview(owner, company.id, project.id);
    const calls = provider.calls.slice(count);
    expect(calls.indexOf("stopProcess")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("stopProcess")).toBeLessThan(calls.findIndex(call => call.startsWith("process:")));
  });
  describe("1. Framework & dev command & port detection", () => {
    it("detects Next.js with npm", async () => {
      const files = [{ path: "package.json" }, { path: "package-lock.json" }, { path: "next.config.js" }];
      const stack = await detectProjectStack(files, async () => JSON.stringify({
        name: "next-site",
        scripts: { dev: "next dev" },
        dependencies: { next: "^14.0.0", react: "^18.0.0" },
      }));
      expect(stack.packageManager).toBe("npm");
      expect(stack.framework).toBe("nextjs");
      expect(stack.command).toBe("npm run dev");
      expect(stack.port).toBe(3000);
    });

    it("detects Vite with yarn and custom host", async () => {
      const files = [{ path: "package.json" }, { path: "yarn.lock" }, { path: "vite.config.ts" }];
      const stack = await detectProjectStack(files, async () => JSON.stringify({
        name: "vite-site",
        scripts: { dev: "vite" },
        devDependencies: { vite: "^5.0.0" },
      }));
      expect(stack.packageManager).toBe("yarn");
      expect(stack.framework).toBe("vite");
      expect(stack.command).toBe("yarn run dev -- --host 0.0.0.0");
      expect(stack.port).toBe(5173);
    });

    it("detects Astro with pnpm", async () => {
      const files = [{ path: "package.json" }, { path: "pnpm-lock.yaml" }, { path: "astro.config.mjs" }];
      const stack = await detectProjectStack(files, async () => JSON.stringify({
        name: "astro-site",
        scripts: { dev: "astro dev" },
        dependencies: { astro: "^4.0.0" },
      }));
      expect(stack.packageManager).toBe("pnpm");
      expect(stack.framework).toBe("astro");
      expect(stack.command).toBe("pnpm run dev -- --host 0.0.0.0");
      expect(stack.port).toBe(4321);
    });

    it("detects static HTML site without package.json", async () => {
      const files = [{ path: "index.html" }, { path: "style.css" }, { path: "main.js" }];
      const stack = await detectProjectStack(files, async () => "");
      expect(stack.framework).toBe("static");
      expect(stack.command).toBe("npx -y serve -s . -l 3000");
      expect(stack.port).toBe(3000);
    });

    it("detects Python http server when python files exist", async () => {
      const files = [{ path: "requirements.txt" }, { path: "main.py" }];
      const stack = await detectProjectStack(files, async () => "");
      expect(stack.framework).toBe("python");
      expect(stack.command).toBe("python3 -m http.server 8000");
      expect(stack.port).toBe(8000);
    });

    it("extracts custom port flag from dev commands", () => {
      expect(extractPortFromCommand("vite --port 8080", 5173)).toBe(8080);
      expect(extractPortFromCommand("next dev -p 4000", 3000)).toBe(4000);
      expect(extractPortFromCommand("serve -l 5000", 3000)).toBe(5000);
      expect(extractPortFromCommand("npm run dev", 3000)).toBe(3000);
    });
  });

  describe("2. Authenticated Signed Preview Token", () => {
    it("generates valid signed token and verifies it", async () => {
      const { preview, company, project } = await fixture();
      const { token, expiresAt } = preview.generateToken({
        userId: "user-a",
        companyId: company.id,
        projectId: project.id,
        sandboxId: "sandbox-123",
      });

      expect(typeof token).toBe("string");
      expect(expiresAt).toBeGreaterThan(Date.now());

      const payload = preview.verifyToken(token);
      expect(payload.userId).toBe("user-a");
      expect(payload.companyId).toBe(company.id);
      expect(payload.projectId).toBe(project.id);
      expect(payload.sandboxId).toBe("sandbox-123");
    });

    it("rejects expired token with 403 token_expired", async () => {
      const { preview, company, project } = await fixture();
      // Generate token that expired 1 second ago
      const { token } = preview.generateToken(
        {
          userId: "user-a",
          companyId: company.id,
          projectId: project.id,
          sandboxId: "sandbox-123",
        },
        -1000,
      );

      expect(() => preview.verifyToken(token)).toThrowError(PreviewError);
      expect(() => preview.verifyToken(token)).toThrow(/expired/i);
    });

    it("rejects forged or tampered token signature", async () => {
      const { preview, company, project } = await fixture();
      const { token } = preview.generateToken({
        userId: "user-a",
        companyId: company.id,
        projectId: project.id,
        sandboxId: "sandbox-123",
      });

      const parts = token.split(".");
      const forged = `${parts[0]}.invalidSignatureHmac12345`;
      expect(() => preview.verifyToken(forged)).toThrowError(/signature verification failed/i);
    });

    it("rejects token when companyId or projectId does not match request", async () => {
      const { preview, company, otherCompany, project } = await fixture();
      const { token } = preview.generateToken({
        userId: "user-a",
        companyId: company.id,
        projectId: project.id,
        sandboxId: "sandbox-123",
      });

      expect(() => preview.validateTokenForRequest(token, otherCompany.id, project.id)).toThrowError(
        /does not match requested project/i,
      );
      expect(() => preview.validateTokenForRequest(token, company.id, "different-project")).toThrowError(
        /does not match requested project/i,
      );
    });
  });

  describe("3. Dev server lifecycle, start, stop, and status", () => {
    it("uses the runtime-assigned port instead of a framework default", async () => {
      const { preview, workspace, company, project, provider } = await fixture();
      await workspace.createFile(owner, company.id, project.id, "index.html", "<h1>Shared runtime</h1>");
      vi.spyOn(provider, "exposePort").mockResolvedValue({ port: 3002, internalHost: "127.0.0.1" });
      const result = await preview.startPreview(owner, company.id, project.id);
      expect(result.port).toBe(3002);
      expect(result.command).toContain("-l 3002");
      expect(provider.calls).toContain("process:npx -y serve -s . -l 3002");
      expect((await preview.getPreviewStatus(owner, company.id, project.id)).port).toBe(3002);
    });

    it("starts dev server, updates status to previewing, and exposes port", async () => {
      const { preview, workspace, company, project } = await fixture();
      await workspace.createFile(owner, company.id, project.id, "index.html", "<h1>Hello World</h1>");

      const result = await preview.startPreview(owner, company.id, project.id);
      expect(result.status).toBe("running");
      expect(result.previewUrl).toContain("/preview/proxy/?token=");
      expect(result.port).toBe(3000);
      expect(result.framework).toBe("static");

      const status = await preview.getPreviewStatus(owner, company.id, project.id);
      expect(status.status).toBe("previewing");
      expect(status.isRunning).toBe(true);
      expect(status.port).toBe(3000);
    });

    it("stops dev server and resets project status to ready", async () => {
      const { preview, workspace, company, project } = await fixture();
      await workspace.createFile(owner, company.id, project.id, "index.html", "<h1>Hello</h1>");
      await preview.startPreview(owner, company.id, project.id);

      const stopResult = await preview.stopPreview(owner, company.id, project.id);
      expect(stopResult.status).toBe("stopped");

      const status = await preview.getPreviewStatus(owner, company.id, project.id);
      expect(status.status).toBe("ready");
      expect(status.isRunning).toBe(false);
      expect(status.previewUrl).toBeFalsy();
    });
  });

  describe("4. Auto-restart monitoring on crash and error states", () => {
    it("auto-restarts failed server up to limit (3 restarts), then marks failed", async () => {
      const { preview, workspace, provider, company, project } = await fixture();
      await workspace.createFile(owner, company.id, project.id, "index.html", "<h1>Crash Test</h1>");
      await preview.startPreview(owner, company.id, project.id);

      provider.processFailOnCheck = true;
      provider.processLogs = "Fatal error: crashed during render";

      // 1st check -> triggers restart #1
      const st1 = await preview.getPreviewStatus(owner, company.id, project.id);
      expect(st1.restartCount).toBe(1);

      // 2nd check -> triggers restart #2
      const st2 = await preview.getPreviewStatus(owner, company.id, project.id);
      expect(st2.restartCount).toBe(2);

      // 3rd check -> triggers restart #3
      const st3 = await preview.getPreviewStatus(owner, company.id, project.id);
      expect(st3.restartCount).toBe(3);

      // 4th check -> exceeded limit -> transitions to failed
      const st4 = await preview.getPreviewStatus(owner, company.id, project.id);
      expect(st4.status).toBe("failed");
      expect(st4.lastBuildStatus).toBe("failed");
      expect(st4.error).toContain("Fatal error");
    });

    it("detects port in use error and returns structured message", async () => {
      const { preview, workspace, provider, company, project } = await fixture();
      await workspace.createFile(owner, company.id, project.id, "index.html", "<h1>Port Test</h1>");
      await preview.startPreview(owner, company.id, project.id);

      provider.processFailOnCheck = true;
      provider.processLogs = "Error: listen EADDRINUSE: address already in use :::3000";

      const st = await preview.getPreviewStatus(owner, company.id, project.id);
      expect(st.error).toContain("Port 3000 is already in use");
    });
  });

  describe("5. Changes tracking & unified diff", () => {
    it("correctly identifies added, modified, deleted files with unified diff", async () => {
      const { workspace, company, project } = await fixture();

      // Create initial files
      const f1 = await workspace.createFile(owner, company.id, project.id, "index.html", "<h1>Title</h1>\n<p>Original</p>");
      const f2 = await workspace.createFile(owner, company.id, project.id, "style.css", "body { color: black; }");

      // Snapshot baseline
      const baseResult = await workspace.setBaseline(owner, company.id, project.id);
      expect(baseResult.fileCount).toBe(2);

      // Verify no changes immediately after baseline
      const chg0 = await workspace.getChanges(owner, company.id, project.id);
      expect(chg0.summary.total).toBe(0);

      // 1. Modify f1
      await workspace.writeFile(owner, company.id, project.id, "index.html", "<h1>Title</h1>\n<p>Updated text</p>", f1.revision);

      // 2. Delete f2
      await workspace.deleteFile(owner, company.id, project.id, "style.css");

      // 3. Add new file f3
      await workspace.createFile(owner, company.id, project.id, "script.js", "console.log('hi');");

      // Get changes
      const chg = await workspace.getChanges(owner, company.id, project.id);
      expect(chg.summary.added).toBe(1);
      expect(chg.summary.modified).toBe(1);
      expect(chg.summary.deleted).toBe(1);
      expect(chg.summary.total).toBe(3);

      const added = chg.changes.find((c) => c.path === "script.js");
      expect(added?.status).toBe("added");
      expect(added?.diff).toContain("--- /dev/null");
      expect(added?.diff).toContain("+++ b/script.js");
      expect(added?.diff).toContain("+console.log('hi');");

      const modified = chg.changes.find((c) => c.path === "index.html");
      expect(modified?.status).toBe("modified");
      expect(modified?.diff).toContain("--- a/index.html");
      expect(modified?.diff).toContain("+++ b/index.html");
      expect(modified?.diff).toContain("-<p>Original</p>");
      expect(modified?.diff).toContain("+<p>Updated text</p>");

      const deleted = chg.changes.find((c) => c.path === "style.css");
      expect(deleted?.status).toBe("deleted");
      expect(deleted?.diff).toContain("--- a/style.css");
      expect(deleted?.diff).toContain("+++ /dev/null");
    });
  });

  describe("6. Fastify Preview Routes & Reverse Proxy", () => {
    it("does not mint a preview token for another user's project", async () => {
      const { preview, workspace, company, project } = await fixture();
      const app = Fastify();
      registerProjectPreviewRoutes(app, preview, workspace, { authenticate: async () => otherUser });
      const response = await app.inject({ method: "GET", url: `/companies/${company.id}/projects/${project.id}/preview/token` });
      expect([403, 404]).toContain(response.statusCode);
      expect(response.json().token).toBeUndefined();
      await app.close();
    });
    it("serves preview status and blocks invalid tokens", async () => {
      const { preview, workspace, company, project } = await fixture();
      const app = Fastify();
      const auth = new LocalDevAuthProvider({
        userId: "user-a",
        workspaceId: "tenant-a",
        permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"],
      });
      registerProjectPreviewRoutes(app, preview, workspace, auth);

      // Check status
      const res1 = await app.inject({
        method: "GET",
        url: `/companies/${company.id}/projects/${project.id}/preview/status`,
      });
      expect(res1.statusCode).toBe(200);
      expect(JSON.parse(res1.body).status).toBe("ready");

      // Request proxy without token -> 401
      const res2 = await app.inject({
        method: "GET",
        url: `/companies/${company.id}/projects/${project.id}/preview/proxy/`,
      });
      expect(res2.statusCode).toBe(401);

      // Request proxy with invalid token signature -> 403
      const res3 = await app.inject({
        method: "GET",
        url: `/companies/${company.id}/projects/${project.id}/preview/proxy/?token=invalid.signature`,
      });
      expect(res3.statusCode).toBe(403);
    });

    it("routes Next.js assets through the runner without a sandbox IP", async () => {
      const { preview, workspace, sandbox, company, project } = await fixture();
      const started = await preview.startPreview(owner, company.id, project.id);
      const proxy = vi.spyOn(sandbox, "proxyPreview").mockResolvedValue({
        status: 200, headers: { "content-type": "text/html" },
        body: Buffer.from('<head></head><a href="/auth">Account</a><script src="/_next/static/app.js"></script><img src="//images.example/product.png">').toString("base64"),
      });
      const app = Fastify();
      registerProjectPreviewRoutes(app, preview, workspace, new LocalDevAuthProvider(owner));
      const res = await app.inject({
        method: "GET",
        url: `/companies/${company.id}/projects/${project.id}/preview/proxy/?token=${started.token}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`/api/companies/${company.id}/projects/${project.id}/preview/proxy/_next/static/app.js?token=`);
      expect(res.body).toContain('<a href="/auth">Account</a>');
      expect(res.body).toContain('<img src="//images.example/product.png">');
      expect(res.body).toContain('document.addEventListener("click"');
      expect(proxy).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: owner.workspaceId, companyId: company.id }), expect.any(String), expect.objectContaining({ port: started.port, path: "/", method: "GET" }));
    });

    it("displays error card instead of blank page when dev server failed", async () => {
      const { preview, workspace, company, project } = await fixture();
      const app = Fastify();
      const auth = new LocalDevAuthProvider(owner);
      registerProjectPreviewRoutes(app, preview, workspace, auth);

      // Set session to failed state
      preview.setSession(project.id, {
        projectId: project.id,
        companyId: company.id,
        sandboxId: "test-sbx",
        processId: "proc-123",
        port: 3000,
        framework: "nextjs",
        command: "npm run dev",
        restartCount: 3,
        maxRestarts: 3,
        status: "failed",
        lastError: "SyntaxError: Unexpected token in app/page.tsx",
        startedAt: new Date().toISOString(),
        workspaceId: owner.workspaceId,
        userId: owner.userId,
      });

      const { token } = preview.generateToken({
        userId: owner.userId,
        companyId: company.id,
        projectId: project.id,
        sandboxId: "test-sbx",
      });

      const res = await app.inject({
        method: "GET",
        url: `/companies/${company.id}/projects/${project.id}/preview/proxy/?token=${token}`,
      });

      expect(res.statusCode).toBe(502);
      expect(res.body).toContain("Build / Runtime Error");
      expect(res.body).toContain("SyntaxError: Unexpected token in app/page.tsx");
    });
  });

  describe("7. Capability Inspector & Registry verification", () => {
    it("registers project.preview capabilities with proper permissions", () => {
      const report = new CapabilityInspectorService().inspect("all");
      for (const id of ["project.preview.start", "project.preview.stop", "project.preview.status"]) {
        const item = report.items.find((i) => i.capabilityId === id);
        expect(item).toBeDefined();
        expect(defaultCapabilityRegistry.get(id)).toMatchObject({ id, agentCallable: true });
      }
    });
  });

  describe("8. Acceptance Scenario E2E: Company -> Developer Agent -> Project -> Build -> Preview -> Changes", () => {
    it("completes the end-to-end website builder workflow", async () => {
      const { store, projects, workspace, provider, sandbox, preview, company, project } = await fixture();

      // 1. Create Developer Agent in Company with project capabilities
      const devAgent = await store.createCompanyAgent(owner, company.id, {
        name: "Developer Agent",
        role: "Frontend Developer",
        description: "Builds modern responsive web applications",
        tools: [
          "project.files.list",
          "project.files.read",
          "project.files.create",
          "project.files.write",
          "project.terminal.exec",
          "project.terminal.process",
          "project.preview.start",
          "project.preview.status",
        ],
        isActive: true,
        recommendedPrompts: [],
        sortOrder: 1,
      });

      // 2. Developer Agent creates landing page files
      await workspace.createFile(
        owner,
        company.id,
        project.id,
        "index.html",
        "<!DOCTYPE html><html><head><title>My Landing Page</title></head><body><h1>Welcome</h1></body></html>",
      );

      // 3. Developer Agent launches preview dev server
      const toolRuntime = new CompanyToolRuntime(
        {} as AIEngine,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        workspace,
        store,
        sandbox,
        preview,
      );

      const previewStartResult = await toolRuntime.execute(
        owner,
        company,
        "project.preview.start",
        {
          projectId: project.id,
          __npatiAgentId: devAgent.id,
        },
        new AbortController().signal,
      ) as { status: string; previewUrl: string; port: number };

      expect(previewStartResult.status).toBe("running");
      expect(previewStartResult.port).toBe(3000);
      expect(previewStartResult.previewUrl).toContain("/preview/proxy/?token=");

      // 4. Verify preview status is live
      const previewStatusResult = await toolRuntime.execute(
        owner,
        company,
        "project.preview.status",
        {
          projectId: project.id,
          __npatiAgentId: devAgent.id,
        },
        new AbortController().signal,
      ) as { status: string; isRunning: boolean };

      expect(previewStatusResult.status).toBe("previewing");
      expect(previewStatusResult.isRunning).toBe(true);

      // 5. Verify Changes tracking shows created files
      const changes = await workspace.getChanges(owner, company.id, project.id);
      expect(changes.summary.added).toBe(1);
      expect(changes.changes[0]?.path).toBe("index.html");
      expect(changes.changes[0]?.status).toBe("added");
    });
  });
});
