import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CodeService } from "../apps/agent-api/src/code-service";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { registerCodeRoutes } from "../apps/agent-api/src/code-routes";
import { currentToolManifest } from "../apps/agent-api/src/code-tool-registry";
import { detectToolchain } from "../apps/agent-api/src/code-toolchain-detector";
import type { ProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import type { FeatureFlagService } from "../apps/agent-api/src/feature-flags";

const ctx: AuthContext = { workspaceId: "plan-c1-ws", userId: "plan-c1-owner", permissions: ["workspace:read", "workspace:write", "business:manage", "admin:all"] };
const flags = { assertEnabled: async () => true as const, isEnabled: async () => true } as unknown as FeatureFlagService;
async function fixture(files: Record<string, string> = {}, audit?: ConstructorParameters<typeof CodeService>[5],
  importer?: ConstructorParameters<typeof CodeService>[3]) {
  const store = new InMemoryWorkspaceStore(); await store.initialize();
  const company = await store.createCompany(ctx, { name: "PLAN C1" }, "plan-c1");
  const projects = new ProjectService(store);
  const workspace = { readFile: async (_ctx: AuthContext, _company: string, _project: string, path: string) => {
    const content = files[path];
    if (content === undefined) throw Object.assign(new Error("Not found"), { status: 404 });
    return { path, content, revision: "fixture", size: content.length };
  } } as unknown as ProjectWorkspace;
  const service = new CodeService(store, projects, workspace, importer, undefined, audit, flags);
  return { store, company, projects, workspace, service };
}
describe("security-gate: individual PLAN C1 contracts", () => {
  it("preserves requested classification, retention and branch across HTTP creation and session inheritance", async () => {
    const h = await fixture(); const app = Fastify();
    registerCodeRoutes(app, { authenticate: async () => ctx }, h.service, flags);
    try {
      const response = await app.inject({ method: "POST", url: "/companies/" + h.company.id + "/code/projects",
        payload: { name: "Restricted", dataClassification: "restricted", retentionClass: "until_deleted", branch: "develop" } });
      expect(response.statusCode).toBe(201);
      const project = response.json();
      expect(project).toMatchObject({ dataClassification: "restricted", retentionClass: "until_deleted", defaultBranch: "develop" });
      const session = await h.service.createSession(ctx, h.company.id, project.id);
      expect(session).toMatchObject({ dataClassification: "restricted", retentionClass: "until_deleted" });
      expect(await h.projects.get(ctx, h.company.id, project.id)).toMatchObject({ dataClassification: "restricted", retentionClass: "until_deleted" });
    } finally { await app.close(); }
  });
  it("refuses project creation before any mutation when its configured audit writer fails", async () => {
    const h = await fixture({}, { record: async () => { throw new Error("audit_unavailable"); } });
    const create = vi.spyOn(h.store, "createProject");
    await expect(h.service.createProject(ctx, h.company.id, { name: "Must not exist" })).rejects.toThrow("audit_unavailable");
    expect(create).not.toHaveBeenCalled();
    expect(await h.projects.list(ctx, h.company.id)).toEqual([]);
  });
  it("pins the tool manifest in the original session insert instead of returning an unpinned session on update failure", async () => {
    const h = await fixture();
    const project = await h.service.createProject(ctx, h.company.id, { name: "Manifest" });
    const update = vi.spyOn(h.store, "updateCodeSession").mockRejectedValue(new Error("write_unavailable"));
    const session = await h.service.createSession(ctx, h.company.id, project.id);
    expect(session.toolManifestVersion).toBe(currentToolManifest().version);
    expect((await h.store.getCodeSession(ctx, h.company.id, session.id)).toolManifestVersion).toBe(currentToolManifest().version);
    expect(update).not.toHaveBeenCalled();
  });
  it("refuses a real agent from a different company without creating a session", async () => {
    const h = await fixture();
    const other = await h.store.createCompany(ctx, { name: "Other" }, "other-plan-c1");
    const agent = await h.store.createCompanyAgent(ctx, other.id, { name: "Foreign", role: "Developer" }, "foreign-agent");
    const project = await h.service.createProject(ctx, h.company.id, { name: "Project" });
    await expect(h.service.createSession(ctx, h.company.id, project.id, { agentId: agent.id })).rejects.toThrow(/belong/i);
    expect(await h.service.listSessions(ctx, h.company.id, project.id)).toEqual([]);
  });
  it("discovers a Makefile typecheck through the actual service manifest loader", async () => {
    const h = await fixture({ Makefile: "typecheck:\n\techo checking\ntest:\n\techo test\n" });
    const project = await h.service.createProject(ctx, h.company.id, { name: "Make" });
    expect(project.toolchain?.verifyCommands).toMatchObject({ test: "make test", typecheck: "make typecheck" });
  });
  it("loads pytest's test-package marker instead of silently missing it during service detection", async () => {
    const h = await fixture({ "pyproject.toml": "[project]\nname='example'\n", "tests/__init__.py": "# test package\n" });
    const project = await h.service.createProject(ctx, h.company.id, { name: "Python" });
    expect(project.toolchain?.verifyCommands.test).toBe("python -m pytest");
  });
  it("does not infer pytest just because setup.cfg configures an unrelated tool", () => {
    expect(detectToolchain({ files: { "pyproject.toml": "[project]\nname='example'", "setup.cfg": "[flake8]\nmax-line-length=100\n" } }).verifyCommands.test).toBeUndefined();
  });
  it("redacts URL credentials from a repository import failure returned by HTTP", async () => {
    const canary = "IMPORT_PASSWORD_CANARY_20261017";
    const h = await fixture({}, undefined, { importRepository: async () => { throw new Error("Authentication failed for https://user:" + canary + "@git.example/repo.git"); } });
    const app = Fastify(); registerCodeRoutes(app, { authenticate: async () => ctx }, h.service, flags);
    try {
      const result = await app.inject({ method: "POST", url: "/companies/" + h.company.id + "/code/projects",
        payload: { name: "Private", repositoryUrl: "https://git.example/repo.git", credentialId: "vault-reference" } });
      expect(result.statusCode).toBe(502);
      expect(result.json().error.code).toBe("repository_import_failed");
      expect(result.body).not.toContain(canary);
      expect(result.body).toContain("[REDACTED]");
    } finally { await app.close(); }
  });
});

describe("individual PLAN C1 detection coverage", () => {
  it.each([
    ["npm", { "package-lock.json": "{}" }],
    ["pnpm", { "pnpm-lock.yaml": "lockfileVersion: 9" }],
    ["yarn", { "yarn.lock": "# yarn lockfile" }],
  ] as const)("detects the %s package manager through persisted project metadata", async (manager, lock) => {
    const h = await fixture({ "package.json": JSON.stringify({ scripts: { test: "runner", lint: "lint", typecheck: "check", build: "build" } }), ...lock });
    const project = await h.service.createProject(ctx, h.company.id, { name: manager });
    expect(project.toolchain?.packageManagers).toEqual([manager]);
    expect(project.toolchain?.verifyCommands.test).toBe(manager + " test");
    expect(Object.keys(project.toolchain?.verifyCommands ?? {}).sort()).toEqual(["build", "lint", "test", "typecheck"]);
  });
  it.each([
    ["pip", { "requirements.txt": "pytest==8" }],
    ["poetry", { "pyproject.toml": "[tool.poetry]\nname='example'\n[tool.pytest.ini_options]\n" }],
    ["uv", { "pyproject.toml": "[project]\nname='example'\n[tool.pytest.ini_options]\n", "uv.lock": "version = 1" }],
  ] as const)("detects the Python %s manager and test command through the loader", async (manager, files) => {
    const h = await fixture(files);
    const project = await h.service.createProject(ctx, h.company.id, { name: manager });
    expect(project.toolchain?.languages).toContain("python");
    expect(project.toolchain?.packageManagers).toContain(manager);
    expect(project.toolchain?.verifyCommands.test).toBe("python -m pytest");
  });
  it.each([
    ["go", "go", { "go.mod": "module example.test/app\n" }, "go test ./...", "go build ./..."],
    ["rust", "cargo", { "Cargo.toml": "[package]\nname='example'\n" }, "cargo test", "cargo build"],
    ["java", "maven", { "pom.xml": "<project/>" }, "mvn -q test", "mvn -q -DskipTests package"],
    ["java", "gradle", { "build.gradle.kts": "plugins {}" }, "gradle test", "gradle build"],
    ["php", "composer", { "composer.json": JSON.stringify({ scripts: { test: "phpunit", lint: "phpcs" } }) }, "composer test", undefined],
  ] as const)("detects %s / %s and its commands", async (language, manager, files, test, build) => {
    const h = await fixture(files);
    const project = await h.service.createProject(ctx, h.company.id, { name: manager });
    expect(project.toolchain?.languages).toContain(language);
    expect(project.toolchain?.packageManagers).toContain(manager);
    expect(project.toolchain?.verifyCommands.test).toBe(test);
    expect(project.toolchain?.verifyCommands.build).toBe(build);
  });
  it("recognizes an empty but valid test package marker", async () => {
    const h = await fixture({ "pyproject.toml": "[project]\nname='example'\n", "tests/__init__.py": "" });
    const project = await h.service.createProject(ctx, h.company.id, { name: "Empty marker" });
    expect(project.toolchain?.verifyCommands.test).toBe("python -m pytest");
  });
  it("recognizes a Python project with an empty requirements file", async () => {
    const h = await fixture({ "requirements.txt": "" });
    const project = await h.service.createProject(ctx, h.company.id, { name: "Zero dependencies" });
    expect(project.toolchain?.languages).toEqual(["python"]);
    expect(project.toolchain?.packageManagers).toEqual(["pip"]);
  });
  it("persists all session identity fields and refuses creation after project archival", async () => {
    const h = await fixture();
    const project = await h.service.createProject(ctx, h.company.id, { name: "Lifecycle" });
    const agent = await h.store.createCompanyAgent(ctx, h.company.id, { name: "Own", role: "Developer" }, "own");
    const parent = await h.service.createSession(ctx, h.company.id, project.id);
    const child = await h.service.createSession(ctx, h.company.id, project.id, {
      parentSessionId: parent.id, agentId: agent.id, mode: "plan", modelProfile: "native-test",
      summary: "Retained summary", dataClassification: "restricted", retentionClass: "extended",
    });
    expect(child).toMatchObject({ workspaceId: ctx.workspaceId, userId: ctx.userId, companyId: h.company.id,
      projectId: project.id, agentId: agent.id, parentSessionId: parent.id, mode: "plan",
      modelProfile: "native-test", status: "active", summary: "Retained summary",
      dataClassification: "restricted", retentionClass: "extended", runId: null });
    expect(child.id).toBeTruthy();
    expect(Number.isFinite(Date.parse(child.createdAt))).toBe(true);
    expect(Number.isFinite(Date.parse(child.updatedAt))).toBe(true);
    expect(await h.service.getSession(ctx, h.company.id, child.id)).toEqual(child);
    await h.projects.archive(ctx, h.company.id, project.id, project.revision);
    await expect(h.service.createSession(ctx, h.company.id, project.id)).rejects.toMatchObject({ code: "project_archived" });
  });
  it("keeps Website Builder projects eligible for coding sessions", async () => {
    const h = await fixture();
    const { project } = await h.projects.create(ctx, h.company.id, { name: "Website", type: "website" }, "website");
    const session = await h.service.createSession(ctx, h.company.id, project.id);
    expect(session.projectId).toBe(project.id);
    expect((await h.projects.get(ctx, h.company.id, project.id)).type).toBe("website");
  });
});

describe("individual PLAN C1 detection error recovery", () => {
  it("keeps existing metadata when a manifest read fails for a reason other than absence", async () => {
    const h = await fixture({ "go.mod": "module example.test/project\n" });
    const project = await h.service.createProject(ctx, h.company.id, { name: "Read failure" });
    const edited = await h.service.updateProject(ctx, h.company.id, project.id, {
      expectedRevision: project.revision, verifyCommands: { test: "go test ./internal/..." },
    });
    vi.spyOn(h.workspace, "readFile").mockRejectedValue(Object.assign(new Error("Access denied"), { code: "EACCES" }));
    await expect(h.service.detectAndPersist(ctx, h.company.id, project.id)).rejects.toMatchObject({ code: "toolchain_detection_failed" });
    expect(await h.projects.get(ctx, h.company.id, project.id)).toEqual(edited);
  });
});
