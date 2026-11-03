import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { LocalProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import { ProjectGitService } from "../apps/agent-api/src/project-git-service";
import { ProjectImportService } from "../apps/agent-api/src/project-import-service";
import { extractProjectZip, ProjectImportError } from "../apps/agent-api/src/project-import-zip";
import { SandboxProviderError, type SandboxProvider } from "../apps/agent-api/src/sandbox-provider";
import { ProjectSandboxService } from "../apps/agent-api/src/project-sandbox-service";
import { ProjectTerminalEventsRepository } from "../apps/agent-api/src/project-terminal-events";
import type { ProjectSandboxService } from "../apps/agent-api/src/project-sandbox-service";
import type { ProjectPreviewService } from "../apps/agent-api/src/project-preview-service";

const ctx: AuthContext = {
  workspaceId: "tenant-import", userId: "user-import",
  permissions: ["workspace:read", "workspace:write", "business:manage"],
};
const outsider: AuthContext = {
  workspaceId: "other-tenant", userId: "other-user",
  permissions: ["workspace:read", "workspace:write"],
};
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function zip(files: Array<{ path: string; content: string; method?: 0 | 8; declaredSize?: number; mode?: number }>): Buffer {
  const locals: Buffer[] = [];
  const directories: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path);
    const data = Buffer.from(file.content);
    const compressed = file.method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(file.method ?? 0, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.declaredSize ?? data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(file.method ?? 0, 10);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(file.declaredSize ?? data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((file.mode ?? 0) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    directories.push(directory, name);
    offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directories);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

async function fixture(options: { cloneFiles?: Array<{ path: string; content: string }>; installError?: Error; credentialToken?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "npati-import-"));
  roots.push(root);
  const store = new InMemoryWorkspaceStore();
  await store.initialize(ctx);
  let company = await store.createCompany(ctx, { name: "Import Company" }, "import-company");
  const agent = await store.createCompanyAgent(ctx, company.id, { name: "Developer", role: "developer", isActive: true }, "import-agent");
  company = await store.setCompanyMainAgent(ctx, company.id, agent.id, company.revision);
  const projects = new ProjectService(store);
  const { project } = await projects.create(ctx, company.id, { name: "Imported Website", type: "website" }, "import-project");
  const workspace = new LocalProjectWorkspace(projects, { root });
  const cloneRepository = vi.fn(async () => options.cloneFiles ?? []);
  const execute = vi.fn(async () => {
    if (options.installError) throw options.installError;
    return { status: "completed", exitCode: 0 };
  });
  const sandbox = { cloneRepository, execute } as unknown as ProjectSandboxService;
  const startPreview = vi.fn(async () => ({ previewUrl: "/api/preview/test", framework: "vite", status: "running", token: "test", port: 5173, command: "npm run dev" }));
  const preview = { startPreview } as unknown as ProjectPreviewService;
  const git = new ProjectGitService(store, projects, root);
  const resolve = vi.fn(async () => ({ token: options.credentialToken ?? "vault-test-token" }));
  const imports = new ProjectImportService(store, projects, workspace, sandbox, preview, git, { resolve });
  return { root, store, company, project, workspace, imports, cloneRepository, execute, startPreview, resolve };
}

describe("Step 7 ZIP import safety", () => {
  it("rejects ZIP traversal, protected paths, symlinks, and duplicate entries", () => {
    for (const name of ["../outside.txt", "/absolute.txt", ".env", "folder/../../outside.txt"]) {
      expect(() => extractProjectZip(zip([{ path: name, content: "unsafe" }]))).toThrow(ProjectImportError);
    }
    expect(() => extractProjectZip(zip([{ path: "link", content: "target", mode: 0xa000 }]))).toThrow(ProjectImportError);
    expect(() => extractProjectZip(zip([{ path: "A.txt", content: "one" }, { path: "a.txt", content: "two" }]))).toThrow(ProjectImportError);
  });

  it("rejects ZIP bombs before writing files", () => {
    const bomb = zip([{ path: "large.txt", content: "x".repeat(100_000), method: 8 }]);
    expect(() => extractProjectZip(bomb, { maxCompressionRatio: 10 })).toThrow(ProjectImportError);
    expect(() => extractProjectZip(bomb, { maxExpandedBytes: 10_000 })).toThrow(ProjectImportError);
  });

  it("imports a Vite ZIP, installs dependencies, writes PROJECT.md, and opens Preview", async () => {
    const f = await fixture();
    const archive = zip([
      { path: "vite-site/package.json", content: JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vite: "^5.0.0" } }) },
      { path: "vite-site/index.html", content: "<html><div id='app'></div></html>" },
    ]);
    const result = await f.imports.importZip(ctx, f.company.id, f.project.id, archive);
    expect(result.framework).toBe("vite");
    expect(result.previewUrl).toBe("/api/preview/test");
    expect(f.execute).toHaveBeenCalledWith(ctx, f.company.id, expect.objectContaining({ command: "npm install --no-audit --no-fund" }));
    expect((await f.workspace.readFile(ctx, f.company.id, f.project.id, "PROJECT.md")).content).toContain("Framework: vite");
    expect((await f.store.listProjectRuns(ctx, f.company.id, f.project.id))[0]?.status).toBe("completed");
  });
});

describe("Step 7 repository import boundaries", () => {
  it("imports a connected Next.js repository through the sandbox", async () => {
    const f = await fixture({ cloneFiles: [
      { path: "package.json", content: JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "^15.0.0" } }) },
      { path: "package-lock.json", content: "{}" },
      { path: "app/page.tsx", content: "export default function Page() { return <div>Hello</div>; }" },
    ] });
    const result = await f.imports.importRepository(ctx, f.company.id, f.project.id, { url: "https://github.com/example/next-site" });
    expect(result.framework).toBe("nextjs");
    expect(f.cloneRepository).toHaveBeenCalledWith(ctx, f.company.id, f.project.id, expect.objectContaining({ url: "https://github.com/example/next-site.git", token: undefined }));
    expect(f.execute).toHaveBeenCalledWith(ctx, f.company.id, expect.objectContaining({ command: "npm ci --no-audit --no-fund" }));
    expect(f.startPreview).toHaveBeenCalledOnce();
  });

  it("imports a repository of any size", async () => {
    const f = await fixture({ cloneFiles: Array.from({ length: 501 }, (_, index) => ({ path: `file-${index}.txt`, content: "x" })) });
    await expect(f.imports.importRepository(ctx, f.company.id, f.project.id, { url: "https://github.com/example/huge" }))
      .resolves.toBeTruthy();
    expect((await f.workspace.listFiles(ctx, f.company.id, f.project.id)).length).toBeGreaterThanOrEqual(501);
  }, 120_000);

  it("reports private repository access failure without exposing vault credentials", async () => {
    const f = await fixture({ credentialToken: "github_pat_SECRET_TEST" });
    f.cloneRepository.mockRejectedValueOnce(new SandboxProviderError("repository_access_denied", "Repository clone failed or access was denied", 403, "clone"));
    await expect(f.imports.importRepository(ctx, f.company.id, f.project.id, {
      url: "https://github.com/example/private", credentialId: "vault-id",
    })).rejects.toMatchObject({ code: "repository_access_denied" });
    expect(f.resolve).toHaveBeenCalledWith(ctx, f.company.id, "vault-id");
    const runs = await f.store.listProjectRuns(ctx, f.company.id, f.project.id);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.errorMessage).not.toContain("github_pat_SECRET_TEST");
  });

  it("keeps imported files but marks failed install without starting Preview", async () => {
    const f = await fixture({ installError: new SandboxProviderError("install_failed", "Sandbox command failed", 409, "install_build") });
    const archive = zip([{ path: "package.json", content: JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vite: "^5.0.0" } }) }]);
    await expect(f.imports.importZip(ctx, f.company.id, f.project.id, archive)).rejects.toMatchObject({ code: "install_failed" });
    expect(f.startPreview).not.toHaveBeenCalled();
    expect((await f.store.getProject(ctx, f.company.id, f.project.id)).status).toBe("failed");
  });

  it("clones only through the scoped sandbox provider and keeps tokens out of commands", async () => {
    const f = await fixture();
    const projects = new ProjectService(f.store);
    const git = new ProjectGitService(f.store, projects, f.root);
    const connected = await git.connectRepository(ctx, f.company.id, f.project.id, { url: "https://github.com/example/private-site" });
    const sandboxId = randomUUID();
    const status = { id: sandboxId, state: "running" as const, createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() };
    const executeCommand = vi.fn(async (_scope: unknown, _id: string, _command: string, _options: unknown) => ({ status: "completed" as const, exitCode: 0, stdout: "", stderr: "", durationMs: 1, step: "command", tool: "project.terminal.exec", retryable: false }));
    const provider = {
      createSandbox: vi.fn(async () => ({ ...status, state: "created" as const })),
      startSandbox: vi.fn(async () => status),
      executeCommand,
      downloadFiles: vi.fn(async () => [{ path: "package.json", content: "{}" }]),
    } as unknown as SandboxProvider;
    const sandbox = new ProjectSandboxService(projects, f.store, f.workspace, provider, new ProjectTerminalEventsRepository(projects));
    const files = await sandbox.cloneRepository(ctx, f.company.id, f.project.id, {
      url: connected.repositoryUrl!, branch: "main", token: "github_pat_PRIVATE_TEST", timeoutMs: 5_000,
    });
    expect(files).toHaveLength(1);
    const command = executeCommand.mock.calls[0]?.[2] as string;
    const options = executeCommand.mock.calls[0]?.[3] as { environment: Record<string, string> };
    expect(command).toContain("git -c core.hooksPath");
    expect(command).not.toContain("github_pat_PRIVATE_TEST");
    expect(options.environment.GIT_CONFIG_VALUE_0).toContain("Authorization: Basic ");
  });
  it("rejects cross-tenant project imports before sandbox access", async () => {
    const f = await fixture();
    await expect(f.imports.importRepository(outsider, f.company.id, f.project.id, { url: "https://github.com/example/site" })).rejects.toThrow();
    expect(f.cloneRepository).not.toHaveBeenCalled();
  });
});
