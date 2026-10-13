import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { FeatureFlagService, CODE_AGENT_SUB_FLAGS } from "../apps/agent-api/src/feature-flags";
import { CodeService } from "../apps/agent-api/src/code-service";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { registerCodeExecutionModeRoutes } from "../apps/agent-api/src/code-execution-mode-routes";
import { createCompanyCodingDelegation } from "../apps/agent-api/src/code-company-delegation";

const user: AuthContext = { userId: "owner", workspaceId: "ws-owner", externalSubject: "npati:owner",
  permissions: ["workspace:read", "workspace:write", "business:manage"] };
const admin = { ...user, permissions: [...user.permissions, "admin:all"], role: "owner" };
afterEach(() => vi.unstubAllEnvs());

async function fixture(ctx = user) {
  const store = new InMemoryWorkspaceStore();
  const company = await store.createCompany(ctx, { name: "Company" }, "company");
  const audit = { record: vi.fn(async () => ({})) };
  const flags = new FeatureFlagService(store, audit as never, { enabledByDefault: true });
  const code = new CodeService(store, new ProjectService(store), {} as never, undefined, undefined, undefined, flags);
  const project = await code.createProject(ctx, company.id, { name: "Project" }, "project");
  return { store, company, flags, code, project, audit };
}

describe("Coding Agent execution scopes", () => {
  it("starts in Company with every supported feature and model profile enabled", async () => {
    const { flags, company } = await fixture();
    expect((await flags.executionModes.get(user, company.id)).mode).toBe("company");
    for (const key of ["coding_agent.enabled", ...CODE_AGENT_SUB_FLAGS,
      "code.model_profile.hosted-native-tools", "code.model_profile.hosted-native-tools-small-context", "code.model_profile.local-text-tools"]) {
      expect(await flags.resolve(user, key, { companyId: company.id })).toMatchObject({ enabled: true, stage: "ga", scope: "company", source: "company_default" });
    }
    expect(await flags.isEnabled(user, "code.sandbox_image.abcdef01", { companyId: company.id })).toBe(false);
  });

  it("preserves a company opt-out and the global master kill switch", async () => {
    const { flags, company } = await fixture();
    await flags.setFlag(user, { scope: "company", scopeId: company.id, flagKey: "code.write", enabled: false, stage: "off" });
    expect(await flags.isEnabled(user, "code.write", { companyId: company.id })).toBe(false);
    expect(await flags.isEnabled(user, "code.read", { companyId: company.id })).toBe(true);
    await flags.killSwitch(admin, {});
    expect(await flags.isEnabled(user, "code.read", { companyId: company.id })).toBe(false);
  });

  it("persists Sandbox for the company without changing another company or accepting stale writes", async () => {
    const { flags, company, store, audit } = await fixture();
    const other = await store.createCompany(user, { name: "Other" }, "other");
    const saved = await flags.executionModes.set(user, company.id, "sandbox", 0);
    expect(saved).toMatchObject({ mode: "sandbox", revision: 1 });
    const restarted = new FeatureFlagService(store, audit as never, { enabledByDefault: true });
    expect((await restarted.executionModes.get(user, company.id)).mode).toBe("sandbox");
    expect((await restarted.executionModes.get(user, other.id)).mode).toBe("company");
    await expect(flags.executionModes.set(user, company.id, "company", 0)).rejects.toMatchObject({ code: "mode_revision_conflict" });
  });

  it("does not turn an ordinary company owner into an NPATI source administrator", async () => {
    const { flags, company } = await fixture();
    await expect(flags.executionModes.set(user, company.id, "global", 0)).rejects.toMatchObject({ code: "creator_admin_required" });
    await flags.executionModes.set(admin, company.id, "global", 0);
    await expect(flags.executionModes.assertToolAllowed(admin, company.id, "project", "code.fs.read")).rejects.toMatchObject({ code: "creator_workspace_required" });
  });

  it("confines Sandbox to managed project files and Data Studio", async () => {
    const { flags, company, project } = await fixture();
    await flags.executionModes.set(user, company.id, "sandbox", 0);
    for (const tool of ["code.fs.read", "code.fs.write", "code.shell.exec", "code.data.schema.modify", "code.data.rows.list"]) {
      await expect(flags.executionModes.assertToolAllowed(user, company.id, project.id, tool)).resolves.toBeUndefined();
    }
    for (const tool of ["code.agent.spawn", "code.data.backend.attach", "code.data.rows.transfer", "mcp.provider_tool"]) {
      await expect(flags.executionModes.assertToolAllowed(user, company.id, project.id, tool)).rejects.toMatchObject({ code: "execution_scope_denied" });
    }
    await expect(flags.executionModes.assertToolAllowed(user, company.id, project.id, "code.data.rows.list", { targetProjectId: "other" })).rejects.toMatchObject({ code: "execution_scope_denied" });
  });

  it("permits NPATI source operations only for the bound Creator project in Global", async () => {
    vi.stubEnv("NPATI_CREATOR_SOURCE_ROOT", path.resolve("creator-checkout"));
    const { flags, company, project, store } = await fixture(admin);
    const session = await codeSession();
    async function codeSession() { return store.createCodeSession(admin, company.id, project.id, { mode: "auto" }); }
    await store.setProjectMountedFolder(admin, company.id, project.id, { path: path.resolve("creator-checkout"), mode: "rw", confirmed: true, actor: admin.userId, expectedRevision: 0 });
    await flags.executionModes.bindCreator(admin, company.id, project.id, session.id);
    await expect(flags.executionModes.assertToolAllowed(admin, company.id, project.id, "code.fs.write")).resolves.toBeUndefined();
    await expect(flags.executionModes.assertToolAllowed(admin, company.id, "other-project", "code.fs.write")).rejects.toMatchObject({ code: "creator_workspace_required" });
    await flags.executionModes.set(admin, company.id, "company", 1);
    await expect(flags.executionModes.assertToolAllowed(admin, company.id, project.id, "code.fs.write")).rejects.toMatchObject({ code: "execution_scope_denied" });
  });

  it("requires an audit journal before changing access mode", async () => {
    const { store, company } = await fixture();
    const flags = new FeatureFlagService(store, undefined, { enabledByDefault: true });
    await expect(flags.executionModes.set(user, company.id, "sandbox", 0)).rejects.toMatchObject({ code: "audit_unavailable" });
    expect((await flags.executionModes.get(user, company.id)).mode).toBe("company");
  });

  it("connects a source checkout through the existing mount and session APIs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "npati-creator-"));
    vi.stubEnv("NPATI_CREATOR_SOURCE_ROOT", root);
    const { flags, company, code, store } = await fixture(admin);
    await mkdir(path.join(root, "apps/web/src"), { recursive: true });
    await mkdir(path.join(root, "apps/agent-api/src"), { recursive: true });
    await Promise.all(["package.json", "apps/web/src/App.tsx", "apps/agent-api/src/server.ts"].map(file => writeFile(path.join(root, file), "{}")));
    const confirm = vi.fn(async (ctx, companyId, projectId, input) => store.setProjectMountedFolder(ctx, companyId, projectId,
      { path: input.path, mode: input.mode, confirmed: true, actor: ctx.userId, expectedRevision: input.expectedRevision }));
    const app = Fastify();
    registerCodeExecutionModeRoutes(app, { auth: { authenticate: async () => admin } as never, flags, code,
      mounts: { get: (ctx, companyId, projectId) => store.getProjectMountedFolder(ctx, companyId, projectId), confirm } as never });
    try {
      const first = await app.inject({ method: "POST", url: `/companies/${company.id}/code/creator-workspace` });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().workspaceUrl).toContain("?session=");
      const second = await app.inject({ method: "POST", url: `/companies/${company.id}/code/creator-workspace` });
      expect(second.json().projectId).toBe(first.json().projectId);
      expect(second.json().sessionId).toBe(first.json().sessionId);
      expect(confirm).toHaveBeenCalledOnce();
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("delegates from Company through the shared executor and releases its run slot", async () => {
    const { flags, company, project, code } = await fixture();
    const release = vi.fn();
    const execute = vi.fn(async () => ({ terminalStatus: "completed", needsApproval: false, result: { status: "completed" } }));
    const delegate = createCompanyCodingDelegation({ flags, code, executor: { execute } as never,
      admission: { admit: vi.fn(async () => ({ release })) } as never });
    const result = await delegate(user, company, { projectId: project.id, task: "Build a page" }, new AbortController().signal);
    expect(result).toMatchObject({ routed: "code_runner", projectId: project.id, status: "completed" });
    expect(execute).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
    await flags.executionModes.set(user, company.id, "sandbox", 0);
    await expect(delegate(user, company, { projectId: project.id, task: "Escape sandbox" }, new AbortController().signal)).rejects.toMatchObject({ code: "execution_scope_denied" });
    expect(execute).toHaveBeenCalledOnce();
  });
});
