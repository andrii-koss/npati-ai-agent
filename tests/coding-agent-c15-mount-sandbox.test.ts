import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryWorkspaceStore, type AuthContext, type ProjectMountedFolder } from "@npati/workspace";
import { buildSandboxCreateArgs, DockerSandboxProvider } from "../apps/agent-api/src/docker-sandbox-provider";
import { SANDBOX_MOUNT_TARGET, RemoteSandboxProvider, sandboxMountRequest, type SandboxMount, type SandboxScope } from "../apps/agent-api/src/sandbox-provider";
import { RunnerMountGate, type SandboxMountGate } from "../apps/agent-api/src/mounted-folder-gate";
import { CodeMountedFolderService } from "../apps/agent-api/src/code-mounted-folder";
import { mountedFolderRoots } from "../apps/agent-api/src/project-mount-policy";
import { resolveRunnerStore, type RunnerStoreNotice } from "../apps/agent-api/src/sandbox-runner-store";

/**
 * C15 security-gate suite, second half — the **sandbox side**: how a mounted folder reaches a container, and
 * every reason it must not.
 *
 * The owner decision for this step names two things that must be true at the container level rather than only
 * in the API: an `ro` mount is mounted `readonly` (a kernel fact, not a check a caller can skip), and no host
 * mount is allowed that the runner has not itself re-authorized. This suite pins both, plus the TOCTOU window
 * that makes the second one necessary:
 *
 *  - the argument line: with a mount, `--mount type=bind,source=…,target=/workspace` and **no** `--tmpfs
 *    /workspace` (a shadowed bind would be a silent no-op), with `readonly` appended for an `ro` mount; without a
 *    mount, byte-for-byte the pre-C15 hardening the C14 suite already pins, which is extended here rather than
 *    weakened;
 *  - the runner gate: a path the allowlist does not name, an unconfirmed project, a widened `ro`, a target other
 *    than `/workspace`, an unreadable allowlist, a non-local runner — and the TOCTOU case, a path that was a real
 *    directory when the owner confirmed it and is a junction by the time the container is created (the junction is
 *    created for real here);
 *  - the provider refuses to mount at all when it has no gate, so a deployment cannot end up with a bind mount
 *    nobody re-authorized;
 *  - the administration service: the server-side flag, the owner/admin role, the explicit confirmation, the path
 *    validation and the audit **before** the write, each with the mutation proven not to have happened.
 *
 * Honest limit (the same one the C14 suite states): there is no Docker in this environment, so the bind mount is
 * asserted on the argument vector and on the gate's decision, not by inspecting a running container.
 */

const owner = { workspaceId: "tenant-c15", userId: "user-c15", permissions: ["workspace:read", "workspace:write", "business:manage", "owner"], role: "owner" } as unknown as AuthContext;
const developer = { ...owner, userId: "user-dev", role: "developer" } as unknown as AuthContext;
const scope: SandboxScope = { workspaceId: "tenant-c15", userId: "user-c15", companyId: "company-c15", projectId: "project-c15" };
/** Admits every image: this suite is about the mount gate, which is decided after admission and before docker. */
const ADMISSION = { admit: async () => ({ allowed: true as const, reference: "npati/project-sandbox:local", digest: "sha256:" + "0".repeat(64), variant: "base" as const, dev: false }) };

const LIMITS = { sandboxName: "npati-sb-c15", sandboxId: "c15", network: "npati-net-c15", scope, image: "npati/project-sandbox:local", cpus: "1", memory: "1536m", pids: 128, diskBytes: 1536 * 1024 * 1024 };

async function temp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Harness-proof rejection probe (`toThrow` regex matching is not implemented by the shim). */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    const typed = error as { code?: string; message?: string };
    return `${typed.code ?? ""} ${typed.message ?? ""}`.trim();
  }
}

/** The synchronous twin of `rejection`, for the pure shape validators. */
function rejectionOf(run: () => unknown): string {
  try {
    run();
    return "";
  } catch (error) {
    const typed = error as { code?: string; message?: string };
    return `${typed.code ?? ""} ${typed.message ?? ""}`.trim();
  }
}

function record(overrides: Partial<ProjectMountedFolder> = {}): ProjectMountedFolder {
  return {
    id: "mount-1", workspaceId: "tenant-c15", companyId: "company-c15", projectId: "project-c15",
    path: "/host/repo", mode: "rw", confirmedBy: "user-c15", confirmedAt: new Date().toISOString(),
    revision: 1, updatedAt: new Date().toISOString(), ...overrides,
  };
}

describe("security-gate: C15 sandbox mount — the argument line", () => {
  it("mounts the confirmed folder at /workspace and never shadows it with a tmpfs", () => {
    const plain = buildSandboxCreateArgs(LIMITS);
    const plainLine = plain.join(" ");
    // The pre-C15 hardening is unchanged when nothing is mounted: the C14 suite asserts these same strings, and
    // this positive control is what makes the mounted case below a real difference rather than a rewritten line.
    expect(plainLine).toContain(`--tmpfs /workspace:rw,exec,nosuid,nodev,uid=10001,gid=10001,size=${1536 * 1024 * 1024}`);
    expect(plain.includes("--mount")).toBe(false);
    expect(plain.includes("-v")).toBe(false);

    const mounted = buildSandboxCreateArgs({ ...LIMITS, mount: { source: "/host/repo", target: SANDBOX_MOUNT_TARGET, readOnly: false } });
    const mountedLine = mounted.join(" ");
    expect(mountedLine).toContain("--mount type=bind,source=/host/repo,target=/workspace");
    // Docker refuses two mounts at one destination; a tmpfs over the bind would be worse than a refusal: the agent
    // would work in a throwaway filesystem while the user's folder stayed untouched.
    expect(mountedLine.includes("--tmpfs /workspace:")).toBe(false);
    // …but the runtime directory (HOME and the package caches) stays a bounded tmpfs, which is what keeps an `ro`
    // mount usable without writing into the user's folder.
    expect(mountedLine).toContain("--tmpfs /workspace/.npati-runtime:rw,exec,nosuid,nodev,uid=10001,gid=10001,size=268435456");
    expect(mountedLine).toContain("--tmpfs /tmp:rw,exec,nosuid,nodev,uid=10001,gid=10001,size=64m");
    // No host escape beyond the one confirmed directory.
    expect(mountedLine.includes("--privileged")).toBe(false);
    expect(mountedLine.includes("docker.sock")).toBe(false);
    expect(mountedLine.includes("--read-only")).toBe(true);
    expect(mountedLine.includes("--cap-drop ALL")).toBe(true);
  });

  it("mounts an ro folder with the Docker readonly flag, not only with an API refusal", () => {
    const args = buildSandboxCreateArgs({ ...LIMITS, mount: { source: "/host/repo", target: SANDBOX_MOUNT_TARGET, readOnly: true } });
    const index = args.indexOf("--mount");
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe("type=bind,source=/host/repo,target=/workspace,readonly");
    // The writable form of the very same mount is one word shorter, so the difference is the readonly flag and not
    // some other argument that happens to be present.
    const writable = buildSandboxCreateArgs({ ...LIMITS, mount: { source: "/host/repo", target: SANDBOX_MOUNT_TARGET, readOnly: false } });
    expect(writable[writable.indexOf("--mount") + 1]).toBe("type=bind,source=/host/repo,target=/workspace");
  });

  it("accepts only /workspace as a mount target and rejects a malformed mount", () => {
    expect(sandboxMountRequest({ source: "/host/repo", target: "/workspace", readOnly: true }))
      .toEqual({ source: "/host/repo", target: "/workspace", readOnly: true });
    expect(sandboxMountRequest(undefined)).toBeUndefined();
    expect(rejectionOf(() => sandboxMountRequest({ source: "/host/repo", target: "/", readOnly: false }))).toContain("mount_target_denied");
    expect(rejectionOf(() => sandboxMountRequest({ source: "/host/repo", target: "/workspace" }))).toContain("invalid_mount");
    expect(rejectionOf(() => sandboxMountRequest({ target: "/workspace", readOnly: false }))).toContain("invalid_mount");
    expect(rejectionOf(() => sandboxMountRequest({ source: "/host/\0repo", target: "/workspace", readOnly: false }))).toContain("invalid_mount");
    // Negative control: the same validator accepts the neighbouring legal shapes.
    expect(rejectionOf(() => sandboxMountRequest({ source: "/host/repo", target: "/workspace", readOnly: false }))).toBe("");
  });

  it("refuses to create a container with a mount when the runner has no gate at all", async () => {
    const admission = ADMISSION;
    const provider = new DockerSandboxProvider({}, admission);
    const create = vi.spyOn(provider as unknown as { createSandboxInternal: () => Promise<never> }, "createSandboxInternal")
      .mockRejectedValue(new Error("test_container_boundary"));
    // The refusal happens after image admission and before any docker command, so this is the provider's own
    // decision rather than a failure of the environment.
    const refused = await rejection(provider.createSandbox(scope, { mount: { source: "/host/repo", target: "/workspace", readOnly: false } }));
    expect(refused).toContain("mounted_folder_gate_unavailable");
    expect(create).not.toHaveBeenCalled();

    // Negative control reaches the container boundary without calling real Docker.
    // This is a hermetic gate test even when Docker is installed on the developer's machine.
    const withoutMount = await rejection(provider.createSandbox(scope, {}));
    expect(withoutMount.includes("mounted_folder")).toBe(false);
    expect(withoutMount).toContain("test_container_boundary");
    expect(create).toHaveBeenCalledOnce();
  });

  it("a gate refusal stops the container before it exists", async () => {
    const admission = ADMISSION;
    const gate: SandboxMountGate = { authorizeMount: async () => { throw new Error("the runner refused the mount"); } };
    const refused = await rejection(new DockerSandboxProvider({}, admission, undefined, gate).createSandbox(scope, { mount: { source: "/host/repo", target: "/workspace", readOnly: false } }));
    expect(refused).toContain("the runner refused the mount");
  });

  it("never sends a mount to a remote runner, and does send it to a local one", async () => {
    const bodies: string[] = [];
    const transport = (async (_url: unknown, init: { body?: string }) => {
      bodies.push(String(init.body ?? ""));
      return {
        ok: true,
        json: async () => ({ result: { id: "11111111-1111-4111-8111-111111111111", state: "created", createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() } }),
      };
    }) as unknown as typeof fetch;
    const secret = "s".repeat(40);
    const request: SandboxMount = { source: "/host/repo", target: SANDBOX_MOUNT_TARGET, readOnly: false };

    // A remote runner is on another machine: the confirmed path would name a directory it does not have, so the
    // request is refused before the transport is touched.
    const remote = new RemoteSandboxProvider("https://runner.example.com", secret, transport, "remote");
    expect(await rejection(remote.createSandbox(scope, { mount: request }))).toContain("mounted_folder_requires_local_runner");
    expect(bodies.length).toBe(0);
    // …while with no mount the same remote client is unchanged.
    await remote.createSandbox(scope, {});
    expect(bodies.length).toBe(1);
    expect(bodies[0]?.includes("mount")).toBe(false);

    const local = new RemoteSandboxProvider("http://sandbox-runner:7865", secret, transport, "local");
    await local.createSandbox(scope, { mount: request });
    expect(bodies.length).toBe(2);
    // The mount travels in the payload, and the runner re-derives the same path from the allowlist it reads.
    expect(bodies[1]).toContain('"mount":{"source":"/host/repo","target":"/workspace","readOnly":false}');
  });
});

describe("security-gate: C15 runner mount gate — re-authorised where the container is created", () => {
  it("authorises exactly the confirmed folder, in the confirmed mode, on a local runner only", async () => {
    const allowRoot = await temp("npati-c15-gate-");
    try {
      const repo = path.join(allowRoot, "repo");
      await mkdir(repo);
      const gate = (overrides: Partial<ConstructorParameters<typeof RunnerMountGate>[0]> = {}) => new RunnerMountGate({
        allowlist: { getConfirmed: async () => record({ path: repo }) },
        roots: [allowRoot],
        runnerMode: "local",
        ...overrides,
      });
      const request: SandboxMount = { source: repo, target: SANDBOX_MOUNT_TARGET, readOnly: false };
      const allowed = await gate().authorizeMount({ companyId: "company-c15", projectId: "project-c15", requested: request });
      expect(allowed).toEqual({ source: repo, target: "/workspace", readOnly: false });
      const roAllowed = await gate({ allowlist: { getConfirmed: async () => record({ path: repo, mode: "ro" }) } })
        .authorizeMount({ companyId: "company-c15", projectId: "project-c15", requested: { ...request, readOnly: true } });
      expect(roAllowed.readOnly).toBe(true);
    } finally {
      await rm(allowRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("refuses an unconfirmed project, a foreign path, a widened mode and a non-local runner", async () => {
    const allowRoot = await temp("npati-c15-gate-refusals-");
    try {
      const repo = path.join(allowRoot, "repo");
      const other = path.join(allowRoot, "other");
      await mkdir(repo);
      await mkdir(other);
      const request: SandboxMount = { source: repo, target: SANDBOX_MOUNT_TARGET, readOnly: false };
      const gate = (overrides: Partial<ConstructorParameters<typeof RunnerMountGate>[0]> = {}) => new RunnerMountGate({
        allowlist: { getConfirmed: async () => record({ path: repo }) },
        roots: [allowRoot],
        runnerMode: "local",
        ...overrides,
      });

      expect(await rejection(gate({ allowlist: { getConfirmed: async () => null } }).authorizeMount({ companyId: "company-c15", projectId: "project-c15", requested: request })))
        .toContain("mounted_folder_not_confirmed");
      expect(await rejection(gate({ allowlist: { getConfirmed: async () => record({ path: repo, revokedAt: new Date().toISOString() }) } }).authorizeMount({ companyId: "company-c15", projectId: "project-c15", requested: request })))
        .toContain("mounted_folder_not_confirmed");
      // The path a caller asked for is compared with the path on file: a client that posts its own path (bypassing
      // the API) gets nowhere.
      expect(await rejection(gate().authorizeMount({ companyId: "company-c15", projectId: "project-c15", requested: { ...request, source: other } })))
        .toContain("mounted_folder_path_mismatch");
      // An `ro` confirmation cannot be widened by asking for a writable bind.
      expect(await rejection(gate({ allowlist: { getConfirmed: async () => record({ path: repo, mode: "ro" }) } }).authorizeMount({ companyId: "company-c15", projectId: "project-c15", requested: request })))
        .toContain("mounted_folder_mode_mismatch");
      expect(await rejection(gate().authorizeMount({ companyId: "company-c15", projectId: "project-c15", requested: { ...request, target: "/etc" } })))
        .toContain("mount_target_denied");
      // A host bind mount only means something where the runner shares the host filesystem with the API.
      expect(await rejection(gate({ runnerMode: "remote" }).authorizeMount({ companyId: "company-c15", projectId: "project-c15", requested: request })))
        .toContain("mounted_folder_requires_local_runner");
      // No allowlist read means no mount: a runner without the database must not mount anything.
      expect(await rejection(new RunnerMountGate({ roots: [allowRoot], runnerMode: "local" }).authorizeMount({ companyId: "company-c15", projectId: "project-c15", requested: request })))
        .toContain("mounted_folder_allowlist_unavailable");
    } finally {
      await rm(allowRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("refuses a folder that became a junction between the confirmation and the create (TOCTOU)", async () => {
    const allowRoot = await temp("npati-c15-toctou-");
    try {
      const repo = path.join(allowRoot, "repo");
      const elsewhere = path.join(allowRoot, "elsewhere");
      await mkdir(repo);
      await mkdir(elsewhere);
      const request: SandboxMount = { source: repo, target: SANDBOX_MOUNT_TARGET, readOnly: false };
      const gate = new RunnerMountGate({
        allowlist: { getConfirmed: async () => record({ path: repo }) },
        roots: [allowRoot],
        runnerMode: "local",
      });
      // Authorized while it is a real directory…
      expect((await gate.authorizeMount({ companyId: "company-c15", projectId: "project-c15", requested: request })).source).toBe(repo);
      // …and after the swap the same request is refused, because the runner re-validates the path it is about to
      // hand to `docker create` instead of trusting the confirmation.
      await rm(repo, { recursive: true, force: true });
      await symlink(elsewhere, repo, "junction");
      expect(await rejection(gate.authorizeMount({ companyId: "company-c15", projectId: "project-c15", requested: request })))
        .toContain("symlink_escape");
    } finally {
      await rm(allowRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("reads the operator allowlist from the environment, so an unconfigured deployment mounts nothing", () => {
    expect(mountedFolderRoots({ NPATI_MOUNTED_FOLDER_ROOTS: "" })).toEqual([]);
    expect(mountedFolderRoots({})).toEqual([]);
    // A relative entry is not a host path and is ignored rather than resolved against the runner's cwd.
    const roots = mountedFolderRoots({ NPATI_MOUNTED_FOLDER_ROOTS: `${path.parse(process.cwd()).root}tmp,relative/path` });
    expect(roots.length).toBe(1);
    expect(path.isAbsolute(roots[0] ?? "")).toBe(true);
  });
});

describe("security-gate: C15 mounted-folder administration — flag, role, validation, audit first", () => {
  async function fixture(options: { mode?: "ro" | "rw"; role?: AuthContext; flag?: boolean } = {}) {
    const allowRoot = await temp("npati-c15-admin-allow-");
    const workspaceRoot = await temp("npati-c15-admin-ws-");
    const store = new InMemoryWorkspaceStore();
    await store.initialize();
    const company = await store.createCompany(owner, { name: "C15 Admin" }, `c15-admin-${Math.random().toString(36).slice(2)}`);
    const order: string[] = [];
    const auditEntries: Array<{ action: string; decision?: string }> = [];
    const deps = {
      store: {
        getProjectMountedFolder: (ctx: AuthContext, companyId: string, projectId: string) => store.getProjectMountedFolder(ctx, companyId, projectId),
        setProjectMountedFolder: async (ctx: AuthContext, companyId: string, projectId: string, input: Parameters<InMemoryWorkspaceStore["setProjectMountedFolder"]>[3]) => {
          order.push("write");
          return store.setProjectMountedFolder(ctx, companyId, projectId, input);
        },
      },
      audit: {
        record: async (input: { action: string; decision?: "allow" | "deny" }) => { order.push("audit"); auditEntries.push({ action: input.action, decision: input.decision }); },
      },
      flags: { isEnabled: async () => options.flag !== false },
      roots: [allowRoot],
      projectWorkspacesRoot: workspaceRoot,
    };
    const service = new CodeMountedFolderService(deps);
    const repo = path.join(allowRoot, "repo");
    await mkdir(repo);
    return { allowRoot, workspaceRoot, store, company, service, repo, order, auditEntries, deps };
  }

  it("confirms a folder inside the allowlist, journalling before the write", async () => {
    const fx = await fixture();
    try {
      const saved = await fx.service.confirm(owner, fx.company.id, "project-1", { path: fx.repo, mode: "rw", expectedRevision: 0, confirm: true, reason: "local repo" });
      expect(saved.path).toBe(fx.repo);
      expect(saved.mode).toBe("rw");
      expect(saved.confirmedBy).toBe(owner.userId);
      expect(saved.confirmedAt).toBeTruthy();
      expect(saved.revision).toBe(1);
      // The journal entry exists *before* the row: an unavailable journal must mean "no change", not "an
      // unaudited change".
      expect(fx.order).toEqual(["audit", "write"]);
      expect(fx.auditEntries[0]?.action).toBe("code.project.mount");
      // Re-read through the service: the confirmation is the stored fact, not a returned value.
      expect((await fx.service.get(owner, fx.company.id, "project-1"))?.path).toBe(fx.repo);
    } finally {
      await rm(fx.allowRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(fx.workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("refuses a path outside the allowlist, a missing confirmation, a bad mode — and stores nothing", async () => {
    const fx = await fixture();
    try {
      const outside = await temp("npati-c15-admin-outside-");
      const refused = await rejection(fx.service.confirm(owner, fx.company.id, "project-1", { path: outside, mode: "rw", expectedRevision: 0, confirm: true }));
      expect(refused).toContain("mounted_folder_not_allowlisted");
      // A refused path is journalled as a denial (the refusal already happened, so an unavailable journal must
      // not change it) but it is **not** written: the row is what makes a folder mountable. The entry carries the
      // `<action>.denied` spelling C5a (D7) established for every refused administrative change — the same spelling
      // `code-project-trust.ts` writes and the same one this suite asserts for the role refusal below.
      expect(fx.order).not.toContain("write");
      expect(fx.auditEntries.some((entry) => entry.action === "code.project.mount.denied" && entry.decision === "deny")).toBe(true);
      expect(await fx.service.get(owner, fx.company.id, "project-1")).toBeNull();

      expect(await rejection(fx.service.confirm(owner, fx.company.id, "project-1", { path: fx.repo, mode: "rw", expectedRevision: 0 })))
        .toContain("mounted_folder_confirmation_required");
      expect(await rejection(fx.service.confirm(owner, fx.company.id, "project-1", { path: fx.repo, mode: "sideways" as "rw", expectedRevision: 0, confirm: true })))
        .toContain("invalid_mount_mode");
      expect(await fx.service.get(owner, fx.company.id, "project-1")).toBeNull();
      await rm(outside, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      await rm(fx.allowRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(fx.workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("refuses a symlinked folder, a non-owner role and a disabled flag", async () => {
    const fx = await fixture();
    try {
      const target = path.join(fx.allowRoot, "target");
      const link = path.join(fx.allowRoot, "link");
      await mkdir(target);
      await symlink(target, link, "junction");
      expect(await rejection(fx.service.confirm(owner, fx.company.id, "project-1", { path: link, mode: "rw", expectedRevision: 0, confirm: true })))
        .toContain("symlink_escape");
      expect(await rejection(fx.service.confirm(developer, fx.company.id, "project-1", { path: fx.repo, mode: "rw", expectedRevision: 0, confirm: true })))
        .toContain("code_mounted_folder_admin_required");
      // The refusal is journalled as a denial, and nothing was written.
      expect(fx.auditEntries.some((entry) => entry.action === "code.project.mount.denied" && entry.decision === "deny")).toBe(true);
      expect(await fx.service.get(owner, fx.company.id, "project-1")).toBeNull();
    } finally {
      await rm(fx.allowRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(fx.workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    const off = await fixture({ flag: false });
    try {
      expect(await rejection(off.service.confirm(owner, off.company.id, "project-1", { path: off.repo, mode: "rw", expectedRevision: 0, confirm: true })))
        .toContain("feature_disabled");
      expect(off.order).toEqual([]);
    } finally {
      await rm(off.allowRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(off.workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("refuses the change when the journal is unavailable, and enforces the revision token", async () => {
    const fx = await fixture();
    try {
      const withoutAudit = new CodeMountedFolderService({ ...fx.deps, audit: undefined });
      expect(await rejection(withoutAudit.confirm(owner, fx.company.id, "project-1", { path: fx.repo, mode: "rw", expectedRevision: 0, confirm: true })))
        .toContain("audit_unavailable");
      expect(fx.order).toEqual([]);

      const throwing = new CodeMountedFolderService({ ...fx.deps, audit: { record: async () => { throw new Error("journal down"); } } });
      expect(await rejection(throwing.confirm(owner, fx.company.id, "project-1", { path: fx.repo, mode: "rw", expectedRevision: 0, confirm: true })))
        .toContain("audit_unavailable");

      await fx.service.confirm(owner, fx.company.id, "project-1", { path: fx.repo, mode: "rw", expectedRevision: 0, confirm: true });
      // A stale token cannot overwrite the decision another request made in the meantime.
      expect(await rejection(fx.service.confirm(owner, fx.company.id, "project-1", { path: fx.repo, mode: "ro", expectedRevision: 0, confirm: true })))
        .toContain("Mounted folder changed");
      expect((await fx.service.get(owner, fx.company.id, "project-1"))?.mode).toBe("rw");

      const revoked = await fx.service.revoke(owner, fx.company.id, "project-1", { expectedRevision: 1, reason: "done" });
      expect(revoked.revokedAt).toBeTruthy();
      expect(revoked.revision).toBe(2);
      expect(await rejection(fx.service.revoke(owner, fx.company.id, "no-such-project", { expectedRevision: 0 })))
        .toContain("mounted_folder_not_found");
    } finally {
      await rm(fx.allowRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(fx.workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("security-gate: C15 wiring — one resolver, and the runner reads the allowlist itself", () => {
  it("composes one workspace resolver and hands it to the workspace provider and to git", () => {
    const app = readFileSync(path.resolve("apps/agent-api/src/app.ts"), "utf8");
    // The managed root is joined exactly once in the composition; the second join that used to feed
    // `ProjectGitService` is gone, which is what makes "one canonical workspace" a property of the code.
    const joins = app.match(/path\.join\(config\.dataDirectory \?\? "\.data", "project-workspaces"\)/g) ?? [];
    expect(joins.length).toBe(1);
    expect(app).toContain("new ProjectWorkspaceBaseResolver({");
    expect(app).toContain("new MountedWorkspaceProvider(projectService");
    // …and the git service receives that same object rather than a root string. The pattern has to see through the
    // *documentation* between the arguments: the wiring comments the hand-over where it happens, and a guard that
    // only matched two adjacent arguments would fail on the very wiring it exists to pin. `\s*(?:\/\/[^\n]*\n\s*)*`
    // admits whole comment lines and nothing else, so the third argument is still proven to be the resolver object
    // (a string root, or any other argument, still fails this assertion).
    expect(app).toMatch(/projectGitService = new ProjectGitService\(\s*workspaceStore,\s*projectService,\s*(?:\/\/[^\n]*\n\s*)*projectWorkspaceBases,/);
    // The allowlist read and the flag read are the resolver's, not a second lookup.
    expect(app).toContain("workspaceStore.getProjectMountedFolder(ctx, companyId, projectId)");
    expect(app).toContain("mountedFolderFlags = featureFlagService");

    const git = readFileSync(path.resolve("apps/agent-api/src/project-git-service.ts"), "utf8");
    const gitWorkspace = readFileSync(path.resolve("apps/agent-api/src/project-git-workspace-service.ts"), "utf8");
    // The git service no longer joins a root of its own: it asks the resolver. The resolution itself now lives in
    // the workspace primitives module, which the service reaches through a delegation, so neither file may join a root.
    expect(git.includes("path.join(this.workspaceRoot")).toBe(false);
    expect(gitWorkspace.includes("path.join(this.workspaceRoot")).toBe(false);
    expect(gitWorkspace).toContain("await host.bases.resolve(ctx, companyId, projectId)");
    expect(gitWorkspace).toContain('"MOUNTED_FOLDER_READ_ONLY"');
  });

  it("the runner re-reads the allowlist from the database and gates the create with it", () => {
    const runner = readFileSync(path.resolve("apps/agent-api/src/sandbox-runner-server.ts"), "utf8");
    expect(runner).toContain("new RunnerMountGate({");
    // The runner's own read, with no user context — this is what makes the re-validation independent of the API.
    expect(runner).toContain("store.getProjectMountedFolderForSystem(companyId, projectId)");
    /**
     * R1 (section A, item 4) appended two more provider collaborators **after** the mount gate, so the exact
     * substring this line used to assert (`runnerMountGate)`) no longer appears. The assertion is updated to the
     * new argument list rather than dropped: the mount gate is still passed positionally, and the line is now
     * strictly stronger, because it also pins that the aggregate Company quota and host admission were wired in.
     */
    expect(runner).toContain("runnerMountGate, sandboxCompanyQuota, hostAdmission)");
    expect(runner).toContain("p.options as SandboxCreateOptions | undefined");

    const provider = readFileSync(path.resolve("apps/agent-api/src/docker-sandbox-provider.ts"), "utf8");
    // The gate is required: without it the provider refuses a mount instead of trusting the payload.
    expect(provider).toContain("mounted_folder_gate_unavailable");
    expect(provider).toContain("await this.authorizeMount(scope, options.mount)");
    // …and the authorization happens before any container-creating docker command.
    expect(provider.indexOf("await this.authorizeMount(scope, options.mount)")).toBeLessThan(provider.indexOf("private async createSandboxInternal"));
  });

  it("the sandbox service mounts the canonical folder and skips the copy in both directions", async () => {
    const service = readFileSync(path.resolve("apps/agent-api/src/project-sandbox-service.ts"), "utf8");
    // The mount comes from the provider (`mountFor`), not from a second path derivation.
    expect(service).toContain("this.workspace.mountFor ?");
    expect(service).toContain("...(mount ? { mount } : {})");
    // No copy in either direction for a mounted project, which is what keeps the sandbox from becoming a second
    // writer of the canonical folder.
    expect(service).toContain("if (mount) return new Map<string, SandboxFile>();");
    expect(service).toContain("if (!startProcess && !ready.mount && !commandChangesNothing(normalized.executable, normalized.args, command)) await this.download(");
  });
});

/**
 * G1 (item 4): the runner's own workspace store. The runner reads its image catalogue **and** its confirmed
 * mounted folder from this store, so a store whose migration chain failed to initialize is not a degraded runner —
 * it is a runner that cannot answer either question. The behaviour that used to be there,
 * `await postgres.initialize().catch((error) => console.error(…))`, reported the failure through a bare
 * `console.error`, kept the uninitialized store, and could not be tested at all because it lived in a module that
 * starts an HTTP server at import time. `resolveRunnerStore` is that decision as a function of injected factories,
 * so both directions are asserted here without Docker and without a database.
 */
describe("security-gate: G1 the runner's workspace store fails closed and says why", () => {
  /** A store that cannot be initialized, for the reason a missing `vector` extension gives in production. */
  class UninitializableStore extends InMemoryWorkspaceStore {
    override async initialize(): Promise<void> {
      throw new Error('migration 014 failed: extension "vector" is not available');
    }
  }

  it("surfaces the reason of a failed initialization instead of logging it and carrying on", async () => {
    const notices: RunnerStoreNotice[] = [];
    const resolution = await resolveRunnerStore({
      databaseUrl: "postgres://postgres:postgres@127.0.0.1:55432/npati_agent",
      createPostgresStore: () => new UninitializableStore(),
      createMemoryStore: () => new InMemoryWorkspaceStore(),
      report: (notice) => notices.push(notice),
    });

    // The state, not a log line: the reason is carried forward to the component that decides admissions.
    expect(resolution.database).toBe(true);
    expect(resolution.failure).toContain("vector");
    // …and the failure is reported once, structured, with the same reason — this is what was silence before.
    expect(notices.length).toBe(1);
    const notice = notices[0]!;
    expect(notice.event).toBe("runner_store_unavailable");
    expect(notice.code).toBe("runner_store_unavailable");
    expect(notice.database).toBe(true);
    expect(notice.message).toContain('extension "vector" is not available');
  });

  it("reports nothing when the store initializes, and reports the in-memory fallback as its own state", async () => {
    const healthy: RunnerStoreNotice[] = [];
    const withDatabase = await resolveRunnerStore({
      databaseUrl: "postgres://postgres:postgres@127.0.0.1:55432/npati_agent",
      createPostgresStore: () => new InMemoryWorkspaceStore(),
      createMemoryStore: () => new InMemoryWorkspaceStore(),
      report: (notice) => healthy.push(notice),
    });
    expect(withDatabase).toMatchObject({ database: true, failure: null });
    expect(healthy).toEqual([]);

    // No `DATABASE_URL` is a deliberate fallback, not an initialization failure: a revocation issued through the
    // API is invisible here, and that is what the notice says.
    const fallback: RunnerStoreNotice[] = [];
    const withoutDatabase = await resolveRunnerStore({
      databaseUrl: undefined,
      createPostgresStore: () => new InMemoryWorkspaceStore(),
      createMemoryStore: () => new InMemoryWorkspaceStore(),
      report: (notice) => fallback.push(notice),
    });
    expect(withoutDatabase).toMatchObject({ database: false, failure: null });
    expect(fallback.map((notice) => notice.event)).toEqual(["runner_store_not_configured"]);
    expect(fallback[0]?.message).toContain("revocations");
  });

  it("keeps the runner's admission closed while the store is unavailable, and no longer swallows the error", () => {
    const runner = readFileSync(path.resolve("apps/agent-api/src/sandbox-runner-server.ts"), "utf8");
    // The resolution is read by the admission, which refuses with its own code rather than querying a store that
    // cannot answer — a container must never be admitted on the strength of a failed initialization.
    expect(runner).toContain("resolution.failure !== null");
    expect(runner).toContain('"runner_store_unavailable"');
    expect(runner).toContain("resolveRunnerStore({");
    // The defect itself: a `.catch(...)` that logs and continues must not come back.
    expect(runner).not.toContain("initialize().catch(");
    expect(runner).not.toContain("database unavailable");
  });
});
