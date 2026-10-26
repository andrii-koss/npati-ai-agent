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
  resolvePreviewSecret,
  detectProjectStack,
  extractPortFromCommand,
  ProjectPreviewService,
  PreviewError,
  previewAuthCookieName,
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
    return { ...commandResult("running"), processId: "44444444-4444-4444-8444-444444444444" };
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
  it("serves verified Next.js builds and restores them without switching back to dev", async () => {
    const { preview, workspace, projects, company, project } = await fixture();
    await workspace.createFile(owner, company.id, project.id, "package.json", JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "14.2.35" } }));
    expect((await preview.startPreview(owner, company.id, project.id)).command).toBe("npm run dev");
    expect((await projects.get(owner, company.id, project.id)).lastBuildStatus).not.toBe("ready");
    const built = await preview.startPreview(owner, company.id, project.id, { verifiedBuild: true });
    expect(built.command).toBe("npx next start --hostname 0.0.0.0 --port 3000");
    const manual = await preview.startPreview(owner, company.id, project.id);
    expect(manual.command).toBe("npx next start --hostname 0.0.0.0 --port 3000");
    expect((await preview.startPreview(owner, company.id, project.id, { command: "npm run dev" })).command).toBe("npm run dev");
  });
  it("compiles style edits in development without reinstalling unchanged dependencies",async()=>{
    const {preview,workspace,projects,provider,company,project}=await fixture();
    await workspace.createFile(owner,company.id,project.id,"package.json",JSON.stringify({scripts:{dev:"next dev"},dependencies:{next:"14.2.35"}}));
    await projects.updatePreview(owner,company.id,project.id,{lastBuildStatus:"ready"});
    expect((await preview.startPreview(owner,company.id,project.id,{verifiedBuild:false})).command).toBe("npm run dev");
    expect(provider.calls.some(call=>/^exec:.*(?:install|ci)/.test(call))).toBe(false);
    expect((await projects.get(owner,company.id,project.id)).lastBuildStatus).not.toBe("ready");
  });
  it("stops a recorded production server when switching to CSS development Preview after restart",async()=>{
    const {preview,sandbox,workspace,projects,store,provider,company,project}=await fixture();
    await workspace.createFile(owner,company.id,project.id,"package.json",JSON.stringify({scripts:{dev:"next dev"},dependencies:{next:"14.2.35"}}));
    vi.spyOn(provider,"startProcess").mockImplementation(async(_scope,_id,command)=>{provider.calls.push("process:"+command);return {...commandResult("running"),processId:"44444444-4444-4444-8444-444444444444"};});
    await preview.startPreview(owner,company.id,project.id,{verifiedBuild:true});
    const restored=new ProjectPreviewService(projects,store,workspace,sandbox,"test-preview-secret-key-32chars!");
    const count=provider.calls.length;
    await restored.startPreview(owner,company.id,project.id,{verifiedBuild:false});
    const calls=provider.calls.slice(count);expect(calls.indexOf("stopProcess")).toBeGreaterThanOrEqual(0);expect(calls.indexOf("stopProcess")).toBeLessThan(calls.findIndex(call=>call.startsWith("process:")));
  });
  it("reports restart readiness as 503 until HTTP becomes ready, including another API instance", async () => {
    const { preview, sandbox, workspace, store, projects, company, project } = await fixture();
    await workspace.createFile(owner, company.id, project.id, "index.html", "Ready");
    vi.spyOn(sandbox, "supportsPreviewProxy").mockReturnValue(true);
    let ready!: (value: { status: number; headers: Record<string, string>; body: string }) => void;
    const pending = new Promise<{ status: number; headers: Record<string, string>; body: string }>(resolve => { ready = resolve; });
    const probe = vi.spyOn(sandbox, "proxyPreview").mockReturnValueOnce(pending);
    const start = preview.startPreview(owner, company.id, project.id);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    const app = Fastify();
    const api = new ProjectPreviewService(projects, store, workspace, sandbox, "test-preview-secret-key-32chars!");
    registerProjectPreviewRoutes(app, api, workspace, new LocalDevAuthProvider(owner));
    const { token } = preview.generateToken({ workspaceId: owner.workspaceId, userId: owner.userId, companyId: company.id, projectId: project.id, sandboxId: "test" });
    try {
      const response = await app.inject({ method: "GET", url: "/companies/"+company.id+"/projects/"+project.id+"/preview/proxy/?token="+token });
      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("1");
      expect(response.json().error.code).toBe("preview_starting");
      expect(probe).toHaveBeenCalledTimes(1);
    } finally { ready({ status: 200, headers: {}, body: "" }); await start; await app.close(); }
    expect((await projects.get(owner, company.id, project.id)).status).toBe("previewing");
  });

  it("preserves a durable preview failure as 502 after an API restart", async () => {
    const { preview, projects, workspace, company, project } = await fixture();
    await projects.updatePreview(owner, company.id, project.id, { status: "failed" });
    const app = Fastify();
    registerProjectPreviewRoutes(app, preview, workspace, new LocalDevAuthProvider(owner));
    const { token } = preview.generateToken({ workspaceId: owner.workspaceId, userId: owner.userId, companyId: company.id, projectId: project.id, sandboxId: "failed-sandbox" });
    try {
      const response = await app.inject({ method: "GET", url: "/companies/"+company.id+"/projects/"+project.id+"/preview/proxy/?token="+token });
      expect(response.statusCode).toBe(502);
      expect(response.json().error.code).toBe("preview_failed");
    } finally { await app.close(); }
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
  it("stops the worker listener when the API retains an older preview session", async () => {
    const { preview, sandbox, workspace, provider, projects, store, company, project } = await fixture();
    const startProcess = provider.startProcess.bind(provider);
    let sequence = 0;
    vi.spyOn(provider, "startProcess").mockImplementation(async (...args) => ({
      ...await startProcess(...args), status: "running", processId: "44444444-4444-4444-8444-" + String(++sequence).padStart(12, "0"),
    }));
    await workspace.createFile(owner, company.id, project.id, "index.html", "Preview");
    await preview.startPreview(owner, company.id, project.id);
    const worker = new ProjectPreviewService(projects, store, workspace, sandbox, "test-preview-secret-key-32chars!");
    await worker.startPreview(owner, company.id, project.id);
    const count = provider.calls.length;
    await preview.startPreview(owner, company.id, project.id);
    const calls = provider.calls.slice(count);
    const start = calls.findIndex(call => call.startsWith("process:"));
    expect(calls.slice(0, start).filter(call => call === "stopProcess")).toHaveLength(2);
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
      expect(stack.command).toBe("python3 -m http.server $PORT --bind 0.0.0.0");
      expect(stack.port).toBe(3000);
    });

    it("detects Python http server when python files exist", async () => {
      const files = [{ path: "requirements.txt" }, { path: "main.py" }];
      const stack = await detectProjectStack(files, async () => "");
      expect(stack.framework).toBe("python");
      expect(stack.command).toBe(".venv/bin/python -m http.server $PORT --bind 0.0.0.0");
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
      expect(result.command).toBe("python3 -m http.server $PORT --bind 0.0.0.0");
      expect(provider.calls).toContain("process:python3 -m http.server $PORT --bind 0.0.0.0");
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
      await workspace.createFile(owner, company.id, project.id, "index.html", "<html><head></head><body>Preview</body></html>");
      const started = await preview.startPreview(owner, company.id, project.id);
      const proxy = vi.spyOn(sandbox, "proxyPreview").mockResolvedValue({
        status: 200, headers: { "content-type": "text/html" },
        body: Buffer.from('<head><style>.avatar{background:url("/references/photo.png")}</style></head><a href="/auth">Account</a><script src="/_next/static/app.js"></script><img src="//images.example/product.png">').toString("base64"),
      });
      const app = Fastify();
      registerProjectPreviewRoutes(app, preview, workspace, new LocalDevAuthProvider(owner));
      const res = await app.inject({
        method: "GET",
        url: `/companies/${company.id}/projects/${project.id}/preview/proxy/?token=${started.token}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`/api/companies/${company.id}/projects/${project.id}/preview/proxy/_next/static/app.js"`);
      expect(res.body).toContain('<a href="/auth">Account</a>');
      expect(res.body).toContain(`background:url("/api/companies/${company.id}/projects/${project.id}/preview/proxy/references/photo.png")`);
      expect(res.body).toContain('<img src="//images.example/product.png">');
      expect(res.body).toContain('document.addEventListener("click"');
      expect(proxy).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: owner.workspaceId, companyId: company.id }), expect.any(String), expect.objectContaining({ port: started.port, path: "/", method: "GET" }));
    });

    it("keeps preview authorization in a project-scoped HttpOnly cookie for internal navigation", async () => {
      const { preview, workspace, sandbox, company, project } = await fixture();
      await workspace.createFile(owner, company.id, project.id, "index.html", "<html><head></head><body>Preview</body></html>");
      const started = await preview.startPreview(owner, company.id, project.id);
      vi.spyOn(sandbox, "proxyPreview").mockResolvedValue({
        status: 200, headers: { "content-type": "text/html" },
        body: Buffer.from("<head></head><a href=\"/hosting.html\">Hosting</a>").toString("base64"),
      });
      const app = Fastify();
      registerProjectPreviewRoutes(app, preview, workspace, new LocalDevAuthProvider(owner));
      const first = await app.inject({ method: "GET", url: `/companies/${company.id}/projects/${project.id}/preview/proxy/?token=${started.token}` });
      expect(first.statusCode).toBe(200);
      const cookieName = previewAuthCookieName(project.id);
      const setCookie = String(first.headers["set-cookie"]);
      expect(setCookie).toContain(`${cookieName}=`);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain(`Path=/api/companies/${company.id}/projects/${project.id}/preview/proxy`);

      // A relative navigation drops the query token; the scoped cookie must still authorize it.
      const second = await app.inject({
        method: "GET",
        url: `/companies/${company.id}/projects/${project.id}/preview/proxy/hosting.html`,
        headers: { cookie: `${cookieName}=${started.token}` },
      });
      expect(second.statusCode).toBe(200);
      expect(second.headers["set-cookie"]).toBeUndefined();
    });

    it("executes a relative counter script through the direct API preview with a browser cookie jar", async () => {
      const { chromium } = await import("playwright");
      const { preview, workspace, sandbox, company, project } = await fixture();
      await workspace.createFile(owner, company.id, project.id, "index.html", "<html><head></head><body>Preview</body></html>");
      const started = await preview.startPreview(owner, company.id, project.id);
      vi.spyOn(sandbox, "proxyPreview").mockImplementation(async (_scope, _sandbox, input) => ({
        status: 200, headers: { "content-type": input.path === "/script.js" ? "application/javascript" : "text/html" },
        body: Buffer.from(input.path === "/script.js"
          ? 'document.getElementById("increment").onclick=()=>{document.getElementById("counter").textContent="1";};'
          : '<html><head></head><body><button id="increment">Click Me</button><span id="counter">0</span><script src="script.js"></script></body></html>').toString("base64"),
      }));
      const app = Fastify();
      registerProjectPreviewRoutes(app, preview, workspace, new LocalDevAuthProvider(owner));
      const base = await app.listen({ host: "127.0.0.1", port: 0 });
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const scriptResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/script.js"));
        await page.goto(`${base}/companies/${company.id}/projects/${project.id}/preview/proxy/?token=${started.token}`);
        expect((await scriptResponse).status()).toBe(200);
        expect(await page.locator("#counter").innerText()).toBe("0");
        await page.getByRole("button", { name: "Click Me" }).click();
        expect(await page.locator("#counter").innerText()).toBe("1");
      } finally { await browser.close(); await app.close(); }
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

it("stops an older recorded preview even when a newer matching preview is already stopped", async () => {
 const {preview,sandbox,workspace,projects,events,company,project}=await fixture();
 await workspace.createFile(owner,company.id,project.id,"index.html","Ready");
 const started=await preview.startPreview(owner,company.id,project.id);
 const saved=await projects.get(owner,company.id,project.id);
 const processId="55555555-5555-4555-8555-555555555555";
 for(const status of ["running","stopped"] as const)await events.append(owner,company.id,project.id,{sandboxId:saved.sandboxId!,processId,commandSummary:started.command,riskLevel:"safe",status,exitCode:status==="running"?null:0,output:"",durationMs:0});
 const process=vi.spyOn(sandbox,"process").mockResolvedValue(commandResult("stopped"));
 await sandbox.stopRecordedPreview(owner,company.id,project.id,started.command);
 expect(process).toHaveBeenCalledTimes(1);
 expect(process.mock.calls[0]![2]).toMatchObject({action:"stop",processId:"44444444-4444-4444-8444-444444444444"});
});

it("shares Preview signatures across API/worker without a dedicated preview secret",async()=>{
 const env={NPATI_ENCRYPTION_KEY:"installation-encryption-key-for-preview-tests"};
 expect(resolvePreviewSecret(undefined,env)).toBe(resolvePreviewSecret(undefined,env));
 expect(resolvePreviewSecret(undefined,{NPATI_ENCRYPTION_KEY:"another-installation-key"})).not.toBe(resolvePreviewSecret(undefined,env));
 expect(resolvePreviewSecret("dedicated-preview-secret",env)).toBe("dedicated-preview-secret");
 expect(resolvePreviewSecret(undefined,{...env,NPATI_PREVIEW_SECRET:"configured-secret"})).toBe("configured-secret");
 const {projects,store,workspace,sandbox,company,project}=await fixture();
 const worker=new ProjectPreviewService(projects,store,workspace,sandbox,resolvePreviewSecret(undefined,env));
 const api=new ProjectPreviewService(projects,store,workspace,sandbox,resolvePreviewSecret(undefined,env));
 const {token}=worker.generateToken({userId:owner.userId,companyId:company.id,projectId:project.id,sandboxId:"33333333-3333-4333-8333-333333333333"});
 expect(api.verifyToken(token)).toMatchObject({projectId:project.id});
});

it("proxies a worker-created Preview after API restart using signed scope and persisted sandbox binding",async()=>{
 const {preview,projects,store,workspace,sandbox,company,project}=await fixture();
 await workspace.createFile(owner,company.id,project.id,"index.html","Preview");
 const started=await preview.startPreview(owner,company.id,project.id);
 const restored=new ProjectPreviewService(projects,store,workspace,sandbox,"test-preview-secret-key-32chars!");
 const proxy=vi.spyOn(sandbox,"proxyPreview").mockResolvedValue({status:200,headers:{"content-type":"text/html"},body:Buffer.from("<h1>Restored Preview</h1>").toString("base64")});
 const app=Fastify();registerProjectPreviewRoutes(app,restored,workspace,new LocalDevAuthProvider(owner));
 try{
  const root='/companies/'+company.id+'/projects/'+project.id+'/preview';
  const response=await app.inject({method:"GET",url:root+'/proxy/?token='+started.token});expect(response.statusCode).toBe(200);expect(response.body).toContain("Restored Preview");
  expect(proxy).toHaveBeenCalledWith(expect.objectContaining({workspaceId:owner.workspaceId,userId:owner.userId}),expect.any(String),expect.objectContaining({port:started.port}));
  expect((await restored.getPreviewStatus(owner,company.id,project.id)).isRunning).toBe(true);
  const renewed=(await app.inject({method:"GET",url:root+'/token'})).json();expect(restored.verifyToken(renewed.token)).toMatchObject({workspaceId:owner.workspaceId,sandboxId:restored.verifyToken(started.token).sandboxId});
  const calls=proxy.mock.calls.length;
  for(const override of [{workspaceId:"foreign-workspace"},{sandboxId:"foreign-sandbox"}]){
   const {token}=restored.generateToken({...restored.verifyToken(started.token),...override});expect((await app.inject({method:"GET",url:root+'/proxy/?token='+token})).statusCode).not.toBe(200);
  }
  expect(proxy).toHaveBeenCalledTimes(calls);
 }finally{await app.close();}
});

it("reuses a live recorded Next dev server across service instances and uploads CSS before HTTP verification", async () => {
 const {preview,sandbox,workspace,projects,store,provider,company,project}=await fixture();
 await workspace.createFile(owner,company.id,project.id,"package.json",JSON.stringify({scripts:{dev:"next dev"},dependencies:{next:"14.2.35"}}));
 await workspace.createFile(owner,company.id,project.id,"app/global.css","body{background:gray}");
 vi.spyOn(sandbox,"supportsPreviewProxy").mockReturnValue(true);
 const probe=vi.spyOn(sandbox,"proxyPreview").mockResolvedValue({status:200,headers:{},body:""});
 vi.spyOn(provider,"startProcess").mockImplementation(async(_scope,_id,command)=>{provider.calls.push("process:"+command);return {...commandResult("running"),processId:"44444444-4444-4444-8444-444444444444"};});
 await preview.startPreview(owner,company.id,project.id,{verifiedBuild:false});
 const file=await workspace.readFile(owner,company.id,project.id,"app/global.css");
 await workspace.writeFile(owner,company.id,project.id,file.path,"body{background:white}",file.revision);
 const restored=new ProjectPreviewService(projects,store,workspace,sandbox,"test-preview-secret-key-32chars!");
 const count=provider.calls.length;probe.mockClear();
 const result=await restored.startPreview(owner,company.id,project.id,{verifiedBuild:false});
 expect(result.status).toBe("running");expect(provider.calls.slice(count).some(call=>call.startsWith("process:")||call==="stopProcess")).toBe(false);
 expect(provider.calls.slice(count)).toContain("upload");expect(probe).toHaveBeenCalled();
 expect((await provider.downloadFiles({workspaceId:owner.workspaceId,userId:owner.userId,companyId:company.id,projectId:project.id},restored.getSession(project.id)!.sandboxId)).find(file=>file.path==="app/global.css")?.content).toBe("body{background:white}");
});

it("replaces a recorded dev process that has exited instead of reporting reused Preview", async()=>{
 const {preview,sandbox,workspace,provider,company,project}=await fixture();
 await workspace.createFile(owner,company.id,project.id,"package.json",JSON.stringify({scripts:{dev:"next dev"},dependencies:{next:"14.2.35"}}));
 vi.spyOn(sandbox,"supportsPreviewProxy").mockReturnValue(true);
 vi.spyOn(sandbox,"proxyPreview").mockResolvedValue({status:200,headers:{},body:""});
 await preview.startPreview(owner,company.id,project.id,{verifiedBuild:false});
 vi.spyOn(provider,"getProcessStatus").mockResolvedValueOnce(commandResult("failed",1));
 const count=provider.calls.length;
 expect((await preview.startPreview(owner,company.id,project.id,{verifiedBuild:false})).status).toBe("running");
 expect(provider.calls.slice(count)).toContain("process:npm run dev");
});

it("explicitly stops the durable worker preview after the API session map is lost", async () => {
 const {preview,sandbox,workspace,provider,projects,store,company,project,events}=await fixture();
 await workspace.createFile(owner,company.id,project.id,"index.html","<h1>Recorded</h1>");
 await preview.startPreview(owner,company.id,project.id);
 const restored=new ProjectPreviewService(projects,store,workspace,sandbox,"test-preview-secret-key-32chars!");
 const stopped=vi.spyOn(provider,"stopProcess");
 await restored.stopPreview(owner,company.id,project.id);
 expect(stopped).toHaveBeenCalledTimes(1);
 expect((await events.list(owner,company.id,project.id))[0]).toMatchObject({status:"stopped",commandSummary:"Stop process"});
 expect((await projects.get(owner,company.id,project.id)).previewPort ?? null).toBeNull();
});
it("keeps durable preview metadata when the runner cannot confirm explicit stop", async () => {
 const {preview,sandbox,workspace,provider,projects,store,company,project}=await fixture();
 await workspace.createFile(owner,company.id,project.id,"index.html","<h1>Recorded</h1>");
 await preview.startPreview(owner,company.id,project.id);
 const restored=new ProjectPreviewService(projects,store,workspace,sandbox,"test-preview-secret-key-32chars!");
 vi.spyOn(provider,"stopProcess").mockRejectedValueOnce(new Error("runner unavailable"));
 await expect(restored.stopPreview(owner,company.id,project.id)).rejects.toThrow("runner unavailable");
 expect((await projects.get(owner,company.id,project.id)).previewPort).toBe(3000);
});

it("recovers a persisted preview after API and runtime restart, coalescing concurrent status checks", async () => {
 const {preview,projects,store,workspace,sandbox,provider,company,project}=await fixture();
 await workspace.createFile(owner,company.id,project.id,"index.html","<h1>Recovered</h1>");
 await preview.startPreview(owner,company.id,project.id);
 const restored=new ProjectPreviewService(projects,store,workspace,sandbox,"test-preview-secret-key-32chars!");
 vi.spyOn(sandbox,"supportsPreviewProxy").mockReturnValue(true);
 const probe=vi.spyOn(sandbox,"proxyPreview").mockRejectedValue(new Error("Project Preview server unavailable"));
 const launch=vi.spyOn(provider,"startProcess").mockImplementation(async()=>{
   probe.mockResolvedValue({status:200,headers:{},body:""});
   return {...commandResult("running"),processId:"55555555-5555-4555-8555-555555555555"};
 });
 const results=await Promise.all([restored.getPreviewStatus(owner,company.id,project.id),restored.getPreviewStatus(owner,company.id,project.id)]);
 expect(results.every(result=>result.isRunning)).toBe(true);
 expect(launch).toHaveBeenCalledTimes(1);
 expect(restored.getSession(project.id)?.processId).toBe("55555555-5555-4555-8555-555555555555");
});

it("does not restart a healthy persisted preview or a deliberately stopped site", async () => {
 const {preview,projects,store,workspace,sandbox,provider,company,project}=await fixture();
 await workspace.createFile(owner,company.id,project.id,"index.html","<h1>Healthy</h1>");
 await preview.startPreview(owner,company.id,project.id);
 vi.spyOn(sandbox,"supportsPreviewProxy").mockReturnValue(true);
 const probe=vi.spyOn(sandbox,"proxyPreview").mockResolvedValue({status:200,headers:{},body:""});
 const launch=vi.spyOn(provider,"startProcess");
 const restored=new ProjectPreviewService(projects,store,workspace,sandbox,"test-preview-secret-key-32chars!");
 expect((await restored.getPreviewStatus(owner,company.id,project.id)).isRunning).toBe(true);
 expect(launch).not.toHaveBeenCalled();
 await preview.stopPreview(owner,company.id,project.id);
 probe.mockClear();
 expect((await restored.getPreviewStatus(owner,company.id,project.id)).isRunning).toBe(false);
 expect(probe).not.toHaveBeenCalled();
 expect(launch).not.toHaveBeenCalled();
});

it("reports recovery failure instead of claiming a dead persisted preview is running", async () => {
 const {preview,projects,store,workspace,sandbox,company,project}=await fixture();
 await workspace.createFile(owner,company.id,project.id,"index.html","<h1>Site</h1>");
 await preview.startPreview(owner,company.id,project.id);
 vi.spyOn(sandbox,"supportsPreviewProxy").mockReturnValue(true);
 vi.spyOn(sandbox,"proxyPreview").mockRejectedValue(new Error("unavailable"));
 const restored=new ProjectPreviewService(projects,store,workspace,sandbox,"test-preview-secret-key-32chars!");
 vi.spyOn(restored,"startPreview").mockRejectedValue(new Error("runner unavailable"));
 const status=await restored.getPreviewStatus(owner,company.id,project.id);
 expect(status.isRunning).toBe(false);
 expect(status.error).toBe("runner unavailable");
 await expect(restored.getPreviewStatus(otherUser,company.id,project.id)).rejects.toThrow();
});
