import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CodeService, CodeError } from "../apps/agent-api/src/code-service";
import { registerCodeRoutes } from "../apps/agent-api/src/code-routes";
import { AuthenticationError } from "../apps/agent-api/src/auth";
import { detectToolchain } from "../apps/agent-api/src/code-toolchain-detector";
import { DEFAULT_CODE_AGENT_LIMITS, CODE_AGENT_ENABLED_BY_DEFAULT, resolveCodeAgentLimits } from "../apps/agent-api/src/code-agent-config";
import { CODE_TOOL_MANIFEST_VERSION } from "../apps/agent-api/src/code-tool-registry";
import { ProjectService } from "../apps/agent-api/src/project-service";
import type { FeatureFlagService } from "../apps/agent-api/src/feature-flags";
import type { ProjectWorkspace } from "../apps/agent-api/src/project-workspace";

const owner: AuthContext = { workspaceId: "ws-c1", userId: "user-c1", permissions: ["workspace:read", "workspace:write", "business:manage"] };
const admin: AuthContext = { workspaceId: "ws-c1", userId: "user-c1", permissions: ["workspace:read", "business:manage", "admin:all"] };
const other: AuthContext = { workspaceId: "ws-c1", userId: "user-other", permissions: ["workspace:read", "workspace:write", "business:manage"] };
const stranger: AuthContext = { workspaceId: "ws-other", userId: "user-c1", permissions: ["business:manage", "workspace:read"] };
const reader: AuthContext = { workspaceId: "ws-c1", userId: "user-c1", permissions: ["workspace:read"] };

/** Minimal workspace double: only manifest reads are needed by detection. */
function fakeWorkspace(files: Record<string, string>) {
  return {
    async readFile(_ctx: AuthContext, _companyId: string, _projectId: string, path: string) {
      const content = files[path];
      if (content === undefined) throw new Error("not found");
      return { path, content, revision: "r1", size: content.length };
    },
  } as unknown as ProjectWorkspace;
}

/**
 * C1a made every coding entry point deny-by-default (dark launch): `CodeService` without a flag
 * service refuses mutations. This suite exercises the C1 foundation logic, so it injects an explicit
 * allow-all stub — the denial path itself is covered by the `security-gate: C1a dark launch` suite in
 * `tests/coding-agent-c1a-flags.test.ts`, which never uses this stub.
 */
const allowAllFlags = { assertEnabled: async () => true as const, isEnabled: async () => true } as unknown as FeatureFlagService;

async function harness(files: Record<string, string> = {}, importer?: CodeService["importRepository"]) {
  const store = new InMemoryWorkspaceStore();
  await store.initialize();
  const company = await store.createCompany(owner, { name: "C1 Co" }, "c1-company");
  const projects = new ProjectService(store);
  const importStub = importer ?? (async () => ({ imported: 0 }));
  const service = new CodeService(store, projects, fakeWorkspace(files), { importRepository: importStub }, undefined, undefined, allowAllFlags);
  return { store, company, projects, service };
}

type ImportFn = ConstructorParameters<typeof CodeService>[3];

describe("code project API creation flow versus stored category", () => {
  it.each(["empty", "upload", "import_repository"])("creates the %s flow without persisting it as a ProjectKind", async (kind) => {
    const { service, company, projects } = await harness();
    const app = Fastify();
    registerCodeRoutes(app, { authenticate: async () => owner }, service, allowAllFlags);
    try {
      const response = await app.inject({ method: "POST", url: `/companies/${company.id}/code/projects`, payload: {
        name: "Flow " + kind, kind, ...(kind === "import_repository" ? { repositoryUrl: "https://example.com/repo.git" } : {}),
      } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ type: "code_project", kind: "website" });
      expect((await projects.list(owner, company.id)).map(p => p.id)).toEqual([response.json().id]);
    } finally { await app.close(); }
  });
});

describe("C1 — toolchain detection", () => {
  it("detects a Node project with the package manager taken from the lockfile", () => {
    const detection = detectToolchain({ files: {
      "package.json": JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", build: "tsc -p ." } }),
      "pnpm-lock.yaml": "lockfileVersion: 9",
      "tsconfig.json": "{}",
    } });
    expect(detection.languages).toEqual(["node", "typescript"]);
    expect(detection.packageManagers).toEqual(["pnpm"]);
    expect(detection.verifyCommands).toEqual({ test: "pnpm test", lint: "pnpm lint", build: "pnpm build", typecheck: "npx tsc --noEmit" });
    expect(detection.evidence).toContain("package.json");
  });

  it("detects a Python project (poetry + pytest + ruff)", () => {
    const detection = detectToolchain({ files: {
      "pyproject.toml": "[tool.poetry]\nname = \"x\"\n[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n",
      "requirements.txt": "pytest==8",
    } });
    expect(detection.languages).toEqual(["python"]);
    expect(detection.packageManagers).toContain("poetry");
    expect(detection.verifyCommands.test).toBe("python -m pytest");
    expect(detection.verifyCommands.lint).toBe("python -m ruff check .");
    expect(detection.verifyCommands.typecheck).toBe("python -m mypy .");
  });

  it("detects Go and Rust projects", () => {
    const go = detectToolchain({ files: { "go.mod": "module example.com/x\n", ".golangci.yml": "run: {}" } });
    expect(go.languages).toEqual(["go"]);
    expect(go.verifyCommands).toMatchObject({ test: "go test ./...", build: "go build ./...", lint: "golangci-lint run" });
    const rust = detectToolchain({ files: { "Cargo.toml": "[package]\nname = \"x\"\n" } });
    expect(rust.languages).toEqual(["rust"]);
    expect(rust.verifyCommands.test).toBe("cargo test");
  });

  it("falls back to Makefile targets and never overrides package-manager scripts", () => {
    const onlyMake = detectToolchain({ files: { Makefile: "test:\n\tgo test ./...\nlint:\n\tgolangci-lint run\n" } });
    expect(onlyMake.verifyCommands).toEqual({ test: "make test", lint: "make lint" });
    const both = detectToolchain({ files: {
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      Makefile: "test:\n\tmake-it\n",
    } });
    expect(both.verifyCommands.test).toBe("npm test");
  });

  it("returns an empty proposal for an unknown repository", () => {
    expect(detectToolchain({ files: { "README.md": "# hi" } })).toEqual({ languages: [], packageManagers: [], verifyCommands: {}, evidence: [] });
  });
});

describe("C1 — configuration", () => {
  it("ships the plan defaults, is env-overridable and stays dark by default", () => {
    expect(DEFAULT_CODE_AGENT_LIMITS.maxStepsPerRun).toBe(40);
    expect(DEFAULT_CODE_AGENT_LIMITS.maxRunMinutes).toBe(30);
    expect(DEFAULT_CODE_AGENT_LIMITS.toolOutputChars).toBe(30_000);
    expect(DEFAULT_CODE_AGENT_LIMITS.commandTimeoutMs).toBe(120_000);
    expect(DEFAULT_CODE_AGENT_LIMITS.installBuildTimeoutMs).toBe(600_000);
    expect(DEFAULT_CODE_AGENT_LIMITS.parallelReadOnlyCalls).toBe(8);
    expect(DEFAULT_CODE_AGENT_LIMITS.toolResultRetentionDays).toBe(30);
    expect(CODE_AGENT_ENABLED_BY_DEFAULT).toBe(false);
    expect(resolveCodeAgentLimits({ NPATI_CODE_MAX_STEPS: "12" } as NodeJS.ProcessEnv).maxStepsPerRun).toBe(12);
    expect(resolveCodeAgentLimits({ NPATI_CODE_MAX_STEPS: "-3" } as NodeJS.ProcessEnv).maxStepsPerRun).toBe(40);
    expect(resolveCodeAgentLimits({ NPATI_CODE_MAX_STEPS: "0" } as NodeJS.ProcessEnv).maxStepsPerRun).toBe(0);
    expect(resolveCodeAgentLimits({ NPATI_CODE_MAX_RUN_MINUTES: "0" } as NodeJS.ProcessEnv).maxRunMinutes).toBe(0);
  });
});

describe("C1 — code projects", () => {
  it("creates a code project, detects the toolchain and keeps the classification defaults", async () => {
    const { service, company, projects } = await harness({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "package-lock.json": "{}" });
    const project = await service.createProject(owner, company.id, { name: "Repo", repositoryUrl: "https://github.com/example/repo" });
    expect(project.type).toBe("code_project");
    expect(project.dataClassification).toBe("confidential");
    expect(project.retentionClass).toBe("standard");
    expect(project.toolchain?.source).toBe("detected");
    expect(project.toolchain?.verifyCommands.test).toBe("npm test");
    expect(project.toolchain?.packageManagers).toEqual(["npm"]);
    // listProjects filters to code projects only
    expect((await service.listProjects(owner, company.id)).map((entry) => entry.id)).toEqual([project.id]);
    // Website Builder projects are untouched by the code list
    await projects.create(owner, company.id, { name: "Site", type: "website" }, "website-key");
    expect((await service.listProjects(owner, company.id)).map((entry) => entry.id)).toEqual([project.id]);
  });

  it("rejects an invalid repository URL and a missing name before creating anything", async () => {
    const { service, company, projects } = await harness();
    await expect(service.createProject(owner, company.id, { name: "Bad", repositoryUrl: "ftp://example.com/repo" }))
      .rejects.toMatchObject({ code: "invalid_repository_url" });
    await expect(service.createProject(owner, company.id, { name: "   " })).rejects.toMatchObject({ code: "invalid_name" });
    expect(await projects.list(owner, company.id)).toHaveLength(0);
  });

  it("keeps user edits of verify commands and default branch", async () => {
    const { service, company } = await harness({ "go.mod": "module x\n" });
    const project = await service.createProject(owner, company.id, { name: "Go repo" });
    const updated = await service.updateProject(owner, company.id, project.id, {
      expectedRevision: project.revision,
      verifyCommands: { test: "go test ./internal/...", lint: "golangci-lint run" },
      defaultBranch: "develop",
    });
    expect(updated.toolchain?.source).toBe("manual");
    expect(updated.toolchain?.verifyCommands.test).toBe("go test ./internal/...");
    expect(updated.toolchain?.languages).toEqual(["go"]);
    expect(updated.defaultBranch).toBe("develop");
  });

  it("rejects a stale revision and requires write permission", async () => {
    const { service, company } = await harness();
    const project = await service.createProject(owner, company.id, { name: "Repo" });
    await expect(service.updateProject(owner, company.id, project.id, { expectedRevision: project.revision + 5, verifyCommands: { test: "x" } }))
      .rejects.toThrow(/changed by another request|Invalid/i);
    await expect(service.createProject(reader, company.id, { name: "Nope" })).rejects.toMatchObject({ code: "code_write_denied" });
  });
});

describe("C1 — code sessions", () => {
  it("creates, lists, reads and archives a session linked to its project", async () => {
    const { service, company } = await harness();
    const project = await service.createProject(owner, company.id, { name: "Repo" });
    const session = await service.createSession(owner, company.id, project.id, { mode: "plan", summary: "initial" });
    // C1a (rule 12): the session pins the tool-schema manifest version it was created with, so the
    // assertion follows the published manifest instead of hardcoding a number that C2 already bumped.
    expect(session).toMatchObject({ projectId: project.id, mode: "plan", status: "active", dataClassification: "confidential", retentionClass: "standard", runId: null, toolManifestVersion: CODE_TOOL_MANIFEST_VERSION });
    expect((await service.getSession(owner, company.id, session.id)).id).toBe(session.id);
    const withProjects = await service.listSessionsWithProjects(owner, company.id);
    expect(withProjects[0]).toMatchObject({ id: session.id, projectName: "Repo" });
    const archived = await service.archiveSession(owner, company.id, session.id);
    expect(archived.status).toBe("archived");
    expect(await service.listSessions(owner, company.id)).toHaveLength(0);
    expect(await service.listSessions(owner, company.id, undefined, { includeArchived: true })).toHaveLength(1);
  });

  it("inherits the project classification, allows raising it and rejects lowering", async () => {
    const { service, company } = await harness();
    const project = await service.createProject(owner, company.id, { name: "Repo", dataClassification: "internal" });
    const raised = await service.createSession(owner, company.id, project.id, { dataClassification: "restricted" });
    expect(raised.dataClassification).toBe("restricted");
    await expect(service.createSession(owner, company.id, project.id, { dataClassification: "public" }))
      .rejects.toThrow(/cannot be lower/i);
    // lowering needs an administrative role: the store refuses it through any path
    await expect(service.updateProject(owner, company.id, project.id, { expectedRevision: project.revision, dataClassification: "public" }))
      .rejects.toMatchObject({ code: "classification_downgrade_denied" });
    const adminView = await harness();
    const adminProject = await adminView.service.createProject(admin, adminView.company.id, { name: "Repo", dataClassification: "restricted" });
    const lowered = await adminView.service.updateProject(admin, adminView.company.id, adminProject.id, { expectedRevision: adminProject.revision, dataClassification: "internal" });
    expect(lowered.dataClassification).toBe("internal");
  });

  it("refuses sessions in an archived project and sessions of another project's parent", async () => {
    const { service, company } = await harness();
    const first = await service.createProject(owner, company.id, { name: "One" });
    const second = await service.createProject(owner, company.id, { name: "Two" });
    const session = await service.createSession(owner, company.id, first.id, {});
    await expect(service.createSession(owner, company.id, second.id, { parentSessionId: session.id }))
      .rejects.toThrow(/another project/i);
  });
});

describe("security-gate: C1 isolation and repository credentials", () => {
  it("does not leak code sessions, projects or sessions across companies, users or permissions", async () => {
    const { store, service, company, projects } = await harness();
    const project = await service.createProject(owner, company.id, { name: "Private repo" });
    const session = await service.createSession(owner, company.id, project.id, {});

    // Another user in the same workspace cannot see the project or the session (the company-level
    // ownership check already refuses the request, which is a stronger guarantee).
    await expect(service.getSession(other, company.id, session.id)).rejects.toThrow(/not found|not available/i);
    await expect(service.listSessions(other, company.id)).rejects.toThrow(/not available/i);
    await expect(projects.get(other, company.id, project.id)).rejects.toThrow(/not found|not available/i);

    // A user of another workspace cannot reach the company at all.
    await expect(service.listSessions(stranger, company.id)).rejects.toThrow();
    await expect(store.getCodeSession(stranger, company.id, session.id)).rejects.toThrow();

    // Repository import failures surface as a structured error and never echo the credential.
    const failing = await harness({}, (async () => { throw new Error("fatal: Authentication failed for 'https://github.com/secret-owner/private-repo'"); }) as unknown as CodeService["importRepository"]);
    const failingProject = await failing.service.createProject(owner, failing.company.id, {
      name: "Private", repositoryUrl: "https://github.com/secret-owner/private-repo", credentialId: "cred-1",
    }).catch((error: unknown) => error);
    expect(failingProject).toBeInstanceOf(CodeError);
    expect((failingProject as CodeError).code).toBe("repository_import_failed");
    expect(JSON.stringify((failingProject as CodeError).message)).not.toContain("token");
  });

  it("rejects anonymous and under-privileged API callers and returns feature-safe errors", async () => {
    const { service } = await harness();
    const app = Fastify();
    registerCodeRoutes(app, { authenticate: async () => { throw new AuthenticationError("unauthorized"); } } as never, service, allowAllFlags);
    const anonymous = await app.inject({ method: "GET", url: "/companies/c1/code/projects" });
    expect(anonymous.statusCode).toBe(401);

    const readOnly = Fastify();
    registerCodeRoutes(readOnly, { authenticate: async () => reader } as never, service, allowAllFlags);
    const denied = await readOnly.inject({ method: "POST", url: "/companies/c1/code/projects", payload: { name: "x" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("code_access_denied");

    const unavailable = Fastify();
    registerCodeRoutes(unavailable, { authenticate: async () => owner } as never, undefined, allowAllFlags);
    const featureOff = await unavailable.inject({ method: "GET", url: "/companies/c1/code/projects" });
    expect(featureOff.statusCode).toBe(503);
    expect(featureOff.json().error.code).toBe("code_unavailable");
    await app.close(); await readOnly.close(); await unavailable.close();
  });

  it("exposes the C1 API over HTTP with ownership enforced", async () => {
    const { service, company } = await harness({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
    const app = Fastify();
    registerCodeRoutes(app, { authenticate: async () => owner } as never, service, allowAllFlags);

    const created = await app.inject({ method: "POST", url: `/companies/${company.id}/code/projects`, payload: { name: "HTTP repo" } });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project.toolchain.verifyCommands.test).toBe("npm test");

    const listed = await app.inject({ method: "GET", url: `/companies/${company.id}/code/projects` });
    expect(listed.json().projects).toHaveLength(1);

    const session = await app.inject({ method: "POST", url: `/companies/${company.id}/projects/${project.id}/code/sessions`, payload: { mode: "auto" } });
    expect(session.statusCode).toBe(201);
    expect(session.json().mode).toBe("auto");

    const badClassification = await app.inject({ method: "PATCH", url: `/companies/${company.id}/projects/${project.id}/code`, payload: { expectedRevision: project.revision, dataClassification: "public" } });
    expect(badClassification.statusCode).toBe(403);
    expect(badClassification.json().error.code).toBe("classification_downgrade_denied");

    const limits = await app.inject({ method: "GET", url: `/companies/${company.id}/code/limits` });
    expect(limits.json().limits.maxStepsPerRun).toBe(40);

    const invalid = await app.inject({ method: "POST", url: `/companies/${company.id}/code/projects`, payload: { name: "" } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });
});
