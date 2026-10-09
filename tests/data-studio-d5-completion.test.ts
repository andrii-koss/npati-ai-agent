import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { defaultCapabilityRegistry, isDataCapabilityPermitted } from "@npati/shared";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { LocalProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import { ProjectSandboxService } from "../apps/agent-api/src/project-sandbox-service";
import { ProjectTerminalEventsRepository } from "../apps/agent-api/src/project-terminal-events";
import {
  SandboxProviderError,
  sandboxProcessEnvironment,
  type SandboxCommandOptions,
  type SandboxCommandResult,
  type SandboxProvider,
  type SandboxScope,
  type SandboxStatus,
} from "../apps/agent-api/src/sandbox-provider";
import { ProjectApiKeyManager } from "../apps/agent-api/src/data-studio/api-key-manager";
import {
  PROJECT_SDK_FILE_NAME,
  PROJECT_SDK_IMPORT_PATH,
  ensureProjectSdkFile,
  loadProjectClientSdkSource,
} from "../apps/agent-api/src/data-studio/project-sdk-file";
import { formatSchemaForProjectContext } from "../apps/agent-api/src/data-studio/agent-data-service";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const owner: AuthContext = {
  workspaceId: "tenant-d5",
  userId: "user-d5",
  permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"],
};

const SANDBOX_ID = "44444444-4444-4444-8444-444444444444";

class CaptureSandbox implements SandboxProvider {
  readonly id = SANDBOX_ID;
  processEnvironment: Record<string, string> | undefined;

  private status(): SandboxStatus {
    return { id: this.id, state: "running", createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() };
  }
  async createSandbox() { return this.status(); }
  async startSandbox() { return this.status(); }
  async stopSandbox() { return this.status(); }
  async destroySandbox() { /* no-op */ }
  async getStatus() { return this.status(); }
  async executeCommand(): Promise<SandboxCommandResult> {
    return { status: "completed", exitCode: 0, stdout: "", stderr: "", durationMs: 1, step: "command", tool: "project.terminal.exec", retryable: false };
  }
  async uploadFiles() { /* workspace is already synced in this fixture */ }
  async downloadFiles() { return []; }
  async exposePort(_scope: SandboxScope, _id: string, port: number) { return { port, internalHost: "sandbox" }; }
  async getLogs() { return ""; }
  async startProcess(
    _scope: SandboxScope,
    _id: string,
    _command: string,
    options: SandboxCommandOptions,
  ): Promise<SandboxCommandResult> {
    this.processEnvironment = options.environment;
    return { status: "running", exitCode: null, stdout: "", stderr: "", durationMs: 0, step: "process", tool: "project.terminal.process", retryable: false, processId: "55555555-5555-4555-8555-555555555555" };
  }
  async stopProcess(): Promise<SandboxCommandResult> {
    return { status: "stopped", exitCode: 0, stdout: "", stderr: "", durationMs: 1, step: "process", tool: "project.terminal.process", retryable: false, processId: "55555555-5555-4555-8555-555555555555" };
  }
  async getProcessStatus(): Promise<SandboxCommandResult> {
    return { status: "running", exitCode: null, stdout: "", stderr: "", durationMs: 1, step: "process", tool: "project.terminal.process", retryable: false, processId: "55555555-5555-4555-8555-555555555555" };
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "npati-d5-"));
  roots.push(root);
  const store = new InMemoryWorkspaceStore();
  await store.initialize();
  const company = await store.createCompany(owner, { name: "D5 Co" }, "d5-company");
  const projects = new ProjectService(store);
  const { project } = await projects.create(owner, company.id, { name: "Shop", type: "website" }, "d5-project");
  const workspace = new LocalProjectWorkspace(projects, { root });
  const provider = new CaptureSandbox();
  await store.setProjectSandbox(owner, company.id, project.id, provider.id, null);
  const events = new ProjectTerminalEventsRepository(projects);
  const sandbox = new ProjectSandboxService(
    projects,
    store,
    workspace,
    provider,
    events,
    undefined,
    {},
    async () => ({ PROJECT_API_URL: "https://api.npati.example.test/v1/projects/p1", PROJECT_PUBLISHABLE_KEY: "npati_pk_dev_deadbeefdeadbeefdeadbeefdeadbeef" }),
  );
  return { store, company, project, projects, workspace, provider, sandbox };
}

describe("D5 completion — sandbox process environment", () => {
  it("allows only the public Project API variables for background processes", () => {
    expect(sandboxProcessEnvironment({ PROJECT_API_URL: "https://api.example.test", PROJECT_PUBLISHABLE_KEY: "npati_pk_dev_x" }))
      .toEqual([["PROJECT_API_URL", "https://api.example.test"], ["PROJECT_PUBLISHABLE_KEY", "npati_pk_dev_x"]]);
    expect(sandboxProcessEnvironment(undefined)).toEqual([]);

    for (const name of ["PROJECT_SECRET_KEY", "DATABASE_URL", "PGPASSWORD", "POSTGRES_PASSWORD", "SHOP_DB_PASSWORD"]) {
      expect(() => sandboxProcessEnvironment({ [name]: "secret" }), name).toThrow(SandboxProviderError);
    }
    expect(() => sandboxProcessEnvironment({ "lower-case": "x" })).toThrow(SandboxProviderError);
  });

  it("starts the Live Preview dev server with the Project API variables and without secrets", async () => {
    const { sandbox, company, project, provider } = await fixture();
    const result = await sandbox.process(owner, company.id, {
      projectId: project.id,
      action: "start",
      command: "npm run dev",
      agentId: "system",
      approved: true,
    });

    expect(result.processId).toBe("55555555-5555-4555-8555-555555555555");
    expect(provider.processEnvironment).toMatchObject({
      PROJECT_API_URL: "https://api.npati.example.test/v1/projects/p1",
      PROJECT_PUBLISHABLE_KEY: "npati_pk_dev_deadbeefdeadbeefdeadbeefdeadbeef",
    });
    expect(JSON.stringify(provider.processEnvironment)).not.toContain("npati_sk_");
  });
});

describe("D5 completion — SDK delivery into the Project workspace", () => {
  it("ships the Project client SDK source with the repository checkout", async () => {
    const source = await loadProjectClientSdkSource();
    expect(source).toBeTruthy();
    expect(source).toContain("export function createProjectClient");
  });

  it("vendors the SDK into the Project workspace once and stays idempotent", async () => {
    const { workspace, company, project } = await fixture();
    expect(await ensureProjectSdkFile(owner, company.id, project.id, workspace)).toBe("written");

    const stored = await workspace.readFile(owner, company.id, project.id, PROJECT_SDK_FILE_NAME);
    expect(stored.content).toContain("export function createProjectClient");
    expect(stored.content).toContain("Generated by NPATI Data Studio");

    const revisionAfterFirstWrite = stored.revision;
    expect(await ensureProjectSdkFile(owner, company.id, project.id, workspace)).toBe("unchanged");
    const again = await workspace.readFile(owner, company.id, project.id, PROJECT_SDK_FILE_NAME);
    expect(again.revision).toBe(revisionAfterFirstWrite);

    // The file is a regular Project file, so the sandbox sync uploads it like any other.
    const files = await workspace.listFiles(owner, company.id, project.id);
    expect(files.some((file) => file.path === PROJECT_SDK_FILE_NAME)).toBe(true);
  });

  it("documents the local SDK import path in the Shared Project Context", () => {
    const context = formatSchemaForProjectContext("Backend", { tables: [] });
    expect(context).toContain(PROJECT_SDK_IMPORT_PATH);
    expect(context).toContain(PROJECT_SDK_FILE_NAME);
    expect(context).toContain("PROJECT_PUBLISHABLE_KEY");
    expect(context).not.toContain("npati_sk_");
  });
});

describe("D5 completion — API key rotation grace period", () => {
  const vault = { encrypt: (value: string) => `enc:${value}`, decrypt: (value: string) => value.replace(/^enc:/, "") };

  it("keeps rotated publishable and secret keys valid for a grace period", () => {
    const initial = ProjectApiKeyManager.ensureKeys({}, "dev", vault as never);
    const publishableA = initial.publishableKey;
    const secretA = initial.secretKey!;

    const rotated = ProjectApiKeyManager.rotateKeys(initial.updatedConfig, "dev", "both", vault as never);
    const publishableB = rotated.publishableKey;
    const secretB = rotated.secretKey!;
    expect(publishableB).not.toBe(publishableA);
    expect(Array.isArray(rotated.updatedConfig.previousKeys)).toBe(true);
    expect((rotated.updatedConfig.previousKeys as unknown[]).length).toBe(2);

    const current = ProjectApiKeyManager.validateKey(publishableB, rotated.updatedConfig, "dev");
    expect(current).toMatchObject({ valid: true, keyType: "publishable", isDeprecated: false });
    const previousPublishable = ProjectApiKeyManager.validateKey(publishableA, rotated.updatedConfig, "dev");
    expect(previousPublishable).toMatchObject({ valid: true, keyType: "publishable", isDeprecated: true });
    const previousSecret = ProjectApiKeyManager.validateKey(secretA, rotated.updatedConfig, "dev");
    expect(previousSecret).toMatchObject({ valid: true, keyType: "secret", isDeprecated: true });
    expect(ProjectApiKeyManager.validateKey(secretB, rotated.updatedConfig, "dev")).toMatchObject({ valid: true, isDeprecated: false });

    // A different environment never validates.
    expect(ProjectApiKeyManager.validateKey(publishableA, rotated.updatedConfig, "prod").valid).toBe(false);
  });

  it("keeps only the most recent deprecated keys", () => {
    let config = ProjectApiKeyManager.ensureKeys({}, "dev", vault as never).updatedConfig;
    for (let i = 0; i < ProjectApiKeyManager.MAX_PREVIOUS_KEYS + 3; i += 1) {
      config = ProjectApiKeyManager.rotateKeys(config, "dev", "publishable", vault as never).updatedConfig;
    }
    expect((config.previousKeys as unknown[]).length).toBe(ProjectApiKeyManager.MAX_PREVIOUS_KEYS);
  });
});

describe("D5 completion — project.api.inspect capability", () => {
  it("is registered as a low-risk agent tool in the canonical registry", () => {
    const capability = defaultCapabilityRegistry.get("project.api.inspect");
    expect(capability).toBeDefined();
    expect(capability).toMatchObject({
      type: "tool",
      domain: "storage",
      agentCallable: true,
      userVisible: true,
      risk: "low",
      requiresConfirmation: false,
    });
    expect(capability!.inventoryIds).toContain(347);
    expect(defaultCapabilityRegistry.getByInventoryId(347)?.id).toBe("project.api.inspect");
    expect(defaultCapabilityRegistry.listAgentCallable().some((item) => item.id === "project.api.inspect")).toBe(true);
  });

  it("is gated by the data.read capability group", () => {
    expect(isDataCapabilityPermitted(["data.read"], "project.api.inspect")).toBe(true);
    expect(isDataCapabilityPermitted(["project.data.*"], "project.api.inspect")).toBe(true);
    expect(isDataCapabilityPermitted(["data.write"], "project.api.inspect")).toBe(false);
    expect(isDataCapabilityPermitted([], "project.api.inspect")).toBe(false);
  });
});
