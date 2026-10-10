import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryWorkspaceStore, type AuthContext, type Project } from "@npati/workspace";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { LocalProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import { ProjectSandboxService, defaultTerminalLimits, type TerminalLimits } from "../apps/agent-api/src/project-sandbox-service";
import { ProjectTerminalEventsRepository } from "../apps/agent-api/src/project-terminal-events";
import { SandboxProviderError, type SandboxProvider, type SandboxScope, type SandboxStatus } from "../apps/agent-api/src/sandbox-provider";

/**
 * C10 security-gate suite (ТЗ item 7): the sandbox lifecycle — auto-stop, retention, and removal with the project.
 *
 * Auto-stop already existed (`stopInactive`, driven by a timer) and `ensure` could already reattach, restart or
 * recreate a sandbox. What did **not** exist was the retention policy: nothing ever destroyed a sandbox that had
 * been idle for a long time, so a stopped container kept its disk for as long as the process lived — and after a
 * restart nothing could even name it, because the project row is the only durable pointer.
 *
 * What is pinned here:
 *
 *  - `stopInactive` stops a genuinely idle sandbox and **keeps** it tracked, which is what lets the retention pass
 *    reason about it without a second registry. A sandbox the provider no longer knows is forgotten.
 *  - `sweepRetention` destroys an idle sandbox past the retention window and leaves alone one that is idle but
 *    still inside it, or one that is **running**: retention applies to idle sandboxes, never to live work.
 *  - The retention window can never be configured shorter than the inactivity window. Retention destroys, so a
 *    single typo must not be able to delete a sandbox the moment it stops.
 *  - `destroy` forgets the sandbox and clears the project's `sandbox_id`, so a release built on a **stale** project
 *    object is a no-op — which is exactly the defect this step also fixes at the chat entry point, where the
 *    project was read before the run and the release therefore never destroyed anything.
 *  - Deleting a project destroys its sandbox through the existing `beforeRemove` hook.
 */

const owner: AuthContext = { workspaceId: "tenant-a", userId: "user-a", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };

class FakeSandbox implements SandboxProvider {
  readonly id = "11111111-1111-4111-8111-111111111111";
  state: SandboxStatus["state"] = "created";
  lastActivityAt = new Date().toISOString();
  calls: string[] = [];
  inaccessible = false;
  private status(): SandboxStatus {
    return { id: this.id, state: this.state, createdAt: this.lastActivityAt, lastActivityAt: this.lastActivityAt };
  }
  private check(id: string) {
    if (this.inaccessible) throw new SandboxProviderError("sandbox_not_found", "Sandbox not found", 404);
    if (id !== this.id) throw new SandboxProviderError("sandbox_scope_denied", "Sandbox scope denied", 403);
  }
  async createSandbox() { this.calls.push("create"); this.state = "created"; return this.status(); }
  async startSandbox(_scope: SandboxScope, id: string) { this.check(id); this.state = "running"; this.calls.push("start"); return this.status(); }
  async stopSandbox(_scope: SandboxScope, id: string) { this.check(id); this.state = "stopped"; this.calls.push("stop"); return this.status(); }
  async destroySandbox(_scope: SandboxScope, id: string) { this.check(id); this.state = "destroyed"; this.calls.push("destroy"); }
  async getStatus(_scope: SandboxScope, id: string) { this.check(id); return this.status(); }
  async uploadFiles(): Promise<void> { this.calls.push("upload"); }
  async downloadFiles() { this.calls.push("download"); return []; }
  async executeCommand() { return { status: "completed" as const, exitCode: 0, stdout: "", stderr: "", durationMs: 1, step: "command", tool: "project.terminal.exec", retryable: false }; }
  async exposePort() { return { port: 3000, internalHost: "sandbox" }; }
  async getLogs() { return ""; }
  async startProcess() { return { status: "running" as const, exitCode: null, stdout: "", stderr: "", durationMs: 1, step: "process", tool: "project.terminal.process", retryable: false }; }
  async stopProcess() { return { status: "stopped" as const, exitCode: 0, stdout: "", stderr: "", durationMs: 1, step: "process", tool: "project.terminal.process", retryable: false }; }
  async getProcessStatus() { return { status: "stopped" as const, exitCode: 0, stdout: "", stderr: "", durationMs: 1, step: "process", tool: "project.terminal.process", retryable: false }; }
}

async function fixture(limits: Partial<TerminalLimits> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "npati-sandbox-retention-"));
  const store = new InMemoryWorkspaceStore();
  await store.initialize();
  const company = await store.createCompany(owner, { name: "Sandbox Co" }, "sandbox-company");
  const projects = new ProjectService(store);
  const { project } = await projects.create(owner, company.id, { name: "Code", type: "code_project" }, "sandbox-project");
  const workspace = new LocalProjectWorkspace(projects, { root });
  const provider = new FakeSandbox();
  const events = new ProjectTerminalEventsRepository(projects);
  const sandbox = new ProjectSandboxService(projects, store, workspace, provider, events, undefined, {
    inactivityMs: 1_000,
    retentionMs: 5_000,
    ...limits,
  });
  return { root, store, company, projects, project, workspace, provider, events, sandbox };
}

describe("security-gate: C10 sandbox lifecycle — auto-stop keeps the sandbox for retention", () => {
  it("stops an idle running sandbox and keeps it tracked rather than forgetting it", async () => {
    const { store, company, project, provider, sandbox } = await fixture();
    const live = await store.setProjectSandbox(owner, company.id, project.id, provider.id, null);
    provider.state = "running";
    provider.lastActivityAt = new Date(Date.now() - 60_000).toISOString();
    await sandbox.trackForRetention(owner, live);

    await sandbox.stopInactive(Date.now());
    expect(provider.calls).toContain("stop");
    // Still tracked: the retention pass needs to know the sandbox exists and when it went quiet.
    expect(sandbox.listTrackedSandboxIds()).toEqual([provider.id]);
  });

  it("leaves a sandbox that is still active, and forgets one the provider no longer knows", async () => {
    const { store, company, project, provider, sandbox } = await fixture();
    const live = await store.setProjectSandbox(owner, company.id, project.id, provider.id, null);
    provider.state = "running";
    provider.lastActivityAt = new Date().toISOString();
    await sandbox.trackForRetention(owner, live);
    await sandbox.stopInactive(Date.now());
    expect(provider.calls).not.toContain("stop");
    expect(sandbox.listTrackedSandboxIds()).toEqual([provider.id]);

    provider.inaccessible = true;
    await sandbox.stopInactive(Date.now() + 60_000);
    expect(sandbox.listTrackedSandboxIds()).toEqual([]);
  });
});

describe("security-gate: C10 sandbox lifecycle — retention destroys only what is idle", () => {
  it("previews and then destroys a sandbox past the retention window", async () => {
    const { store, company, project, provider, sandbox } = await fixture();
    const live = await store.setProjectSandbox(owner, company.id, project.id, provider.id, null);
    provider.state = "running";
    provider.lastActivityAt = new Date(Date.now() - 60_000).toISOString();
    await sandbox.trackForRetention(owner, live);

    // Auto-stop is what starts the retention clock: after the stop, nothing has touched the sandbox.
    const stoppedAt = Date.now();
    await sandbox.stopInactive(stoppedAt);
    expect(provider.calls).toContain("stop");
    // Still inside the window: idle for less than the configured retention.
    expect(await sandbox.retentionPreview(stoppedAt + 4_000)).toEqual([]);

    const later = stoppedAt + 6_000;
    const preview = await sandbox.retentionPreview(later);
    expect(preview.length).toBe(1);
    expect(preview[0]).toMatchObject({ projectId: project.id, sandboxId: provider.id });

    const swept = await sandbox.sweepRetention(later);
    expect(swept).toEqual({ destroyed: 1, candidates: 1 });
    expect(provider.calls).toContain("destroy");
    // The project no longer points at the sandbox, so `ensure` will build a fresh one on demand.
    const after = await store.getProject(owner, company.id, project.id);
    expect(after.sandboxId ?? null).toBeNull();
  });

  it("never destroys a sandbox that is still inside the retention window or still running", async () => {
    const { store, company, project, provider, sandbox } = await fixture();
    const live = await store.setProjectSandbox(owner, company.id, project.id, provider.id, null);
    await sandbox.trackForRetention(owner, live);

    // Running and active: retention applies to idle sandboxes only.
    provider.state = "running";
    provider.lastActivityAt = new Date().toISOString();
    expect((await sandbox.sweepRetention(Date.now() + 60_000)).destroyed).toBe(0);
    expect(provider.calls).not.toContain("destroy");

    // Even a sandbox that has been idle far longer than the window is left alone while it is still running.
    provider.state = "running";
    provider.lastActivityAt = new Date(Date.now() - 600_000).toISOString();
    expect((await sandbox.sweepRetention(Date.now() + 600_000)).destroyed).toBe(0);
    expect(provider.calls).not.toContain("destroy");
  });

  it("never lets the retention window be configured shorter than the inactivity window", () => {
    // Retention destroys, so a single typo must not be able to delete a sandbox the moment it stops.
    const service = new ProjectSandboxService(
      { get: async () => { throw new Error("unused"); } } as never,
      { getCompanyAgent: async () => { throw new Error("unused"); }, setProjectSandbox: async () => { throw new Error("unused"); } } as never,
      {} as never,
      new FakeSandbox(),
      {} as never,
      undefined,
      { inactivityMs: 60_000, retentionMs: 1_000 },
    );
    expect(service.retentionWindowMs).toBeGreaterThanOrEqual(60_000);
    expect(defaultTerminalLimits.retentionMs).toBeGreaterThanOrEqual(defaultTerminalLimits.inactivityMs);
  });
});

describe("security-gate: C10 sandbox lifecycle — the retention sweep can address a project without a user", () => {
  it("reads a project through the system scope while the tenant-scoped read refuses a context that owns nothing", async () => {
    const { store, company, project } = await fixture();
    const asDeployment: AuthContext = { workspaceId: "tenant-a", userId: "system", permissions: [] };
    // The tenant-scoped read is `createdBy`-scoped, so the deployment's own identity cannot use it — which is why
    // the retention sweep needs the system-scope reader below.
    let refused = false;
    try {
      await store.getProject(asDeployment, company.id, project.id);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);

    const found = await store.getProjectForSystem(company.id, project.id);
    expect(found?.id).toBe(project.id);
    // And it is still tenant-scoped: another company's id finds nothing.
    expect(await store.getProjectForSystem("company-other", project.id)).toBeNull();
    expect(await store.getProjectForSystem(company.id, "project-other")).toBeNull();
  });
});

describe("security-gate: C10 sandbox lifecycle — release is real, not a no-op on a stale object", () => {
  it("destroys nothing for a stale project object and destroys for a fresh one", async () => {
    const { store, company, project, provider, sandbox } = await fixture();
    // The chat entry point read the project *before* the run, when it had no sandbox. Releasing with that object
    // destroys nothing and leaves the sandbox alive — the defect this step fixes by re-reading the project.
    const stale: Project = { ...project };
    expect(stale.sandboxId ?? null).toBeNull();
    await sandbox.destroy(owner, stale);
    expect(provider.calls).not.toContain("destroy");

    // The run created a sandbox; the fresh read has it, and the release is real.
    await store.setProjectSandbox(owner, company.id, project.id, provider.id, null);
    const fresh = await store.getProject(owner, company.id, project.id);
    expect(fresh.sandboxId).toBe(provider.id);
    await sandbox.destroy(owner, fresh);
    expect(provider.calls).toContain("destroy");
    expect((await store.getProject(owner, company.id, project.id)).sandboxId ?? null).toBeNull();
    // And the service no longer tracks it, so the retention pass cannot chase a destroyed sandbox.
    expect(sandbox.listTrackedSandboxIds()).toEqual([]);
  });

  it("destroys the sandbox when the project itself is deleted, through the existing beforeRemove hook", async () => {    const { store, company, project, provider, sandbox } = await fixture();
    const withSandbox = await store.setProjectSandbox(owner, company.id, project.id, provider.id, null);
    await sandbox.trackForRetention(owner, withSandbox);

    // This is the composition `app.ts` builds: `ProjectService` owns the hook, so every delete path (route and
    // service) removes the sandbox without the route repeating the cleanup.
    const hooked = new ProjectService(store, async (context, target) => { await sandbox.destroy(context, target); });
    await hooked.delete(owner, company.id, project.id);
    expect(provider.calls).toContain("destroy");
    expect(sandbox.listTrackedSandboxIds()).toEqual([]);
    let removed = false;
    try {
      await store.getProject(owner, company.id, project.id);
    } catch {
      removed = true;
    }
    expect(removed).toBe(true);
  });
});


describe("security-gate: tracked producer pins the existing sandbox lifecycle", () => {
  it("keeps the sandbox pointer and does not stop or count a pinned sandbox as destroyed", async () => {
    const f = await fixture();
    try {
      const live = await f.store.setProjectSandbox(owner, f.company.id, f.project.id, f.provider.id, null);
      f.provider.state = "running";
      f.provider.lastActivityAt = new Date(Date.now() - 60_000).toISOString();
      await f.sandbox.trackForRetention(owner, live);
      f.sandbox.setProcessCleanupGuard({ acquire: async () => null });
      await f.sandbox.stopInactive(Date.now());
      expect(f.provider.calls).not.toContain("stop");
      expect(await f.sandbox.destroy(owner, live)).toBe(false);
      f.provider.state = "stopped";
      expect(await f.sandbox.sweepRetention(Date.now() + 60_000)).toEqual({ destroyed: 0, candidates: 1 });
      expect(f.provider.calls).not.toContain("destroy");
      expect((await f.store.getProject(owner, f.company.id, f.project.id)).sandboxId).toBe(f.provider.id);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("releases the durable cleanup fence after provider failure so cleanup can retry", async () => {
    const f = await fixture();
    try {
      const live = await f.store.setProjectSandbox(owner, f.company.id, f.project.id, f.provider.id, null);
      let held = false; let releases = 0;
      f.sandbox.setProcessCleanupGuard({ acquire: async () => {
        if (held) return null;
        held = true;
        return async () => { held = false; releases++; };
      } });
      const destroy = f.provider.destroySandbox.bind(f.provider);
      f.provider.destroySandbox = async () => { throw new Error("provider temporarily unavailable"); };
      await expect(f.sandbox.destroy(owner, live)).rejects.toThrow("provider temporarily unavailable");
      expect(held).toBe(false);
      expect((await f.store.getProject(owner, f.company.id, f.project.id)).sandboxId).toBe(f.provider.id);
      f.provider.destroySandbox = destroy;
      expect(await f.sandbox.destroy(owner, live)).toBe(true);
      expect(releases).toBe(2);
      expect((await f.store.getProject(owner, f.company.id, f.project.id)).sandboxId ?? null).toBeNull();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
