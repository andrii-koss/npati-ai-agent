import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, link, lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { ProjectService } from "../apps/agent-api/src/project-service";
import { MountedWorkspaceProvider } from "../apps/agent-api/src/mounted-workspace-provider";
import { LocalProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import { ProjectWorkspaceBaseResolver } from "../apps/agent-api/src/workspace-base-resolver";
import { ProjectImportService } from "../apps/agent-api/src/project-import-service";
import { validateMountedFolder } from "../apps/agent-api/src/project-mount-policy";
import { CodeWorkspaceRevisionGuard } from "../apps/agent-api/src/code-workspace-revision";
import { WORKSPACE_REVISION_MISMATCH } from "../apps/agent-api/src/code-git-workflow";

/**
 * C15 security-gate suite, first half — the **mounted local folder as a real `WorkspaceProvider`**.
 *
 * The owner decision for this step is that a mounted folder becomes the canonical workspace through the
 * existing provider interface, with no "mounted" branch in the workspace revision guards and no second writer.
 * This suite drives the real provider over real directories (no fake filesystem) so the claims are about
 * behaviour:
 *
 *  - the allowlist, not the caller, decides which directories may be mounted: a folder outside the configured
 *    roots, the filesystem root, the home directory, the data root, anything inside the managed workspace root
 *    and anything that *contains* one of those is refused, each with its own code (and the refusals are shown
 *    non-vacuous by the accepted case at the end of the same probe);
 *  - a symlink or a Windows junction anywhere in the path is refused, which is what makes "the validated path"
 *    and "the opened path" the same path;
 *  - `MountedWorkspaceProvider.currentRevision()` is derived from the **mounted tree**: the digest moves when a
 *    file is written into the mounted folder directly (not through the provider), exactly as it moves for a
 *    managed project, which is why `workspace_revision_mismatch` needs no mounted branch — the guard is shown
 *    firing for both providers through the same unchanged code path;
 *  - `rw` writes land in the canonical mounted directory itself (read back with `readFile`, not through the
 *    provider) and `ro` refuses every write through the API;
 *  - removing a project's workspace **never deletes the mounted source**;
 *  - the `code.mounted_folder` flag is read on the real path: with it off the project resolves to the managed
 *    root and carries no mount, so nothing about this step is reachable;
 *  - tenant isolation: a record belonging to another workspace is ignored rather than used.
 */

const owner = { workspaceId: "tenant-c15", userId: "user-c15", permissions: ["workspace:read", "workspace:write", "business:manage", "owner"], role: "owner" } as unknown as AuthContext;
const foreignOwner = { ...owner, workspaceId: "tenant-other", userId: "user-other" } as unknown as AuthContext;

interface Fixture {
  root: string;
  allowRoot: string;
  mounted: string;
  managed: string;
  companyId: string;
  projectId: string;
  store: InMemoryWorkspaceStore;
  projects: ProjectService;
  bases: ProjectWorkspaceBaseResolver;
  workspace: MountedWorkspaceProvider;
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function fixture(options: { mode?: "ro" | "rw"; flagEnabled?: boolean; confirm?: boolean; recordWorkspaceId?: string } = {}): Promise<Fixture> {
  const root = await tempDir("npati-c15-managed-");
  const allowRoot = await tempDir("npati-c15-allow-");
  const mounted = path.join(allowRoot, "repo");
  await mkdir(mounted);
  const store = new InMemoryWorkspaceStore();
  await store.initialize();
  const company = await store.createCompany(owner, { name: "C15 Co" }, `c15-company-${Math.random().toString(36).slice(2)}`);
  const projects = new ProjectService(store);
  const { project } = await projects.create(owner, company.id, { name: "Repo", type: "code_project" }, `c15-project-${Math.random().toString(36).slice(2)}`);
  if (options.confirm !== false) {
    const record = await store.setProjectMountedFolder(owner, company.id, project.id, {
      path: mounted, mode: options.mode ?? "rw", confirmed: true, actor: owner.userId, expectedRevision: 0,
    });
    if (options.recordWorkspaceId) {
      // Simulates a record that belongs to another tenant: the resolver must ignore it rather than mount it.
      (store as unknown as { projectMountedFolders: Map<string, typeof record> }).projectMountedFolders.set(`${company.id}:${project.id}`, { ...record, workspaceId: options.recordWorkspaceId });
    }
  }
  const bases = new ProjectWorkspaceBaseResolver({
    root,
    mounts: { lookup: (ctx, companyId, projectId) => store.getProjectMountedFolder(ctx, companyId, projectId) },
    flags: { isEnabled: async () => options.flagEnabled !== false },
    roots: [allowRoot],
  });
  const workspace = new MountedWorkspaceProvider(projects, { root, bases });
  return { root, allowRoot, mounted, managed: path.join(root, company.id, project.id), companyId: company.id, projectId: project.id, store, projects, bases, workspace };
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

describe("security-gate: C15 mounted folder policy — the allowlist decides what may be mounted", () => {
  it("refuses every directory outside the configured roots and accepts one inside, with the same call", async () => {
    const allowRoot = await tempDir("npati-c15-policy-allow-");
    const outside = await tempDir("npati-c15-policy-outside-");
    const inside = path.join(allowRoot, "repo");
    await mkdir(inside);

    const refused = await rejection(validateMountedFolder({ candidate: outside, roots: [allowRoot] }));
    expect(refused).toContain("mounted_folder_not_allowlisted");
    // Negative control: the same function, the same roots, a directory inside them.
    const facts = await validateMountedFolder({ candidate: inside, roots: [allowRoot] });
    expect(facts.canonicalPath).toBe(inside);
    expect(facts.matchedRoot).toBe(allowRoot);

    // An unconfigured allowlist allows nothing — "we did not configure this" must never read as "anywhere".
    expect(await rejection(validateMountedFolder({ candidate: inside, roots: [] })))
      .toContain("mounted_folder_roots_unconfigured");
  });

  it("refuses the filesystem root, the home directory, the data root and the managed workspace root", async () => {
    const allowRoot = await tempDir("npati-c15-policy-protected-");
    const dataRoot = await tempDir("npati-c15-policy-data-");
    const workspaceRoot = await tempDir("npati-c15-policy-workspaces-");
    const insideWorkspaces = path.join(workspaceRoot, "company", "project");
    await mkdir(insideWorkspaces, { recursive: true });
    const insideData = path.join(dataRoot, "project-workspaces");
    await mkdir(insideData, { recursive: true });

    const cases: Array<{ candidate: string; expected: string }> = [
      { candidate: path.parse(allowRoot).root, expected: "mounted_folder_forbidden_root" },
      { candidate: homedir(), expected: "mounted_folder_forbidden_root" },
      { candidate: dataRoot, expected: "mounted_folder_inside_protected_root" },
      { candidate: insideData, expected: "mounted_folder_inside_protected_root" },
      { candidate: insideWorkspaces, expected: "mounted_folder_inside_protected_root" },
    ];
    for (const probe of cases) {
      const refused = await rejection(validateMountedFolder({
        candidate: probe.candidate, roots: [path.parse(allowRoot).root], protectedRoots: [dataRoot], projectWorkspacesRoot: workspaceRoot,
      }));
      expect(refused, probe.candidate).toContain(probe.expected);
    }

    // A directory that *contains* the protected root would expose it one level down, so it is refused too…
    const parent = path.dirname(dataRoot);
    const containing = await rejection(validateMountedFolder({ candidate: parent, roots: [path.parse(parent).root], protectedRoots: [dataRoot] }));
    expect(containing).toContain("mounted_folder_contains_protected_root");
    // …while a sibling directory of the data root is still mountable, so the rule is about containment. The sibling
    // is created through `mkdtemp`, i.e. as a uniquely named directory *inside the data root's own parent*: the
    // containment question is unchanged (a sibling, not an ancestor and not a descendant), while a fixed name would
    // make the probe depend on the machine's history — the second run on any host finds the directory the first run
    // left in the shared temp directory and fails on `EEXIST`, which is a property of the fixture and not of the
    // policy.
    const sibling = await mkdtemp(path.join(parent, "npati-c15-sibling-not-the-data-root-"));
    const facts = await validateMountedFolder({ candidate: sibling, roots: [parent], protectedRoots: [dataRoot] });
    expect(facts.canonicalPath).toBe(sibling);
  });

  it("refuses a symlink or junction in any component, and reports a missing path as missing", async () => {
    const allowRoot = await tempDir("npati-c15-policy-links-");
    const target = path.join(allowRoot, "target");
    const link = path.join(allowRoot, "link");
    await mkdir(target);
    // A junction is the spelling that works without elevation on Windows; `lstat` reports it as a directory, so
    // the resolved-path comparison is what catches it.
    await symlink(target, link, "junction");

    const facts = await validateMountedFolder({ candidate: target, roots: [allowRoot] });
    expect(facts.canonicalPath).toBe(target);

    const linked = await rejection(validateMountedFolder({ candidate: link, roots: [allowRoot] }));
    expect(linked).toContain("symlink_escape");

    const missing = await rejection(validateMountedFolder({ candidate: path.join(allowRoot, "nope"), roots: [allowRoot] }));
    expect(missing).toContain("mounted_folder_not_found");

    const notDirectory = path.join(allowRoot, "file.txt");
    await writeFile(notDirectory, "x", "utf8");
    expect(await rejection(validateMountedFolder({ candidate: notDirectory, roots: [allowRoot] })))
      .toContain("mounted_folder_not_a_directory");

    // A traversal spelling is refused before anything is resolved, so cleaning a hostile path can never make it
    // acceptable (a rule applied after `path.resolve` would be decorative, since resolve removes the segment).
    expect(await rejection(validateMountedFolder({ candidate: `${allowRoot}/sub/../target`, roots: [allowRoot] })))
      .toContain("mounted_folder_invalid_path");
  });
});

describe("security-gate: C15 mounted provider — one canonical workspace, one writer", () => {
  it("serves the allowlisted folder as the base and derives the revision from the mounted tree", async () => {
    const fx = await fixture({ mode: "rw" });
    try {
      const projectMount = await fx.workspace.mountFor(owner, fx.companyId, fx.projectId);
      expect(projectMount?.source).toBe(fx.mounted);
      expect(projectMount?.target).toBe("/workspace");
      expect(projectMount?.readOnly).toBe(false);

      const empty = await fx.workspace.info(owner, fx.companyId, fx.projectId);
      expect(empty.currentRevision).toBeTruthy();

      // A write that does not go through the provider at all — the user editing their own folder — must move the
      // canonical revision, otherwise the sandbox would be authorised against a digest that is not the tree.
      await writeFile(path.join(fx.mounted, "README.md"), "hello from the mounted folder\n", "utf8");
      const afterExternalWrite = await fx.workspace.info(owner, fx.companyId, fx.projectId);
      expect(afterExternalWrite.currentRevision).not.toBe(empty.currentRevision);

      // …and the same content read through the provider proves the provider really is looking at that folder.
      const read = await fx.workspace.readFile(owner, fx.companyId, fx.projectId, "README.md");
      expect(read.content).toContain("hello from the mounted folder");

      // A managed project of the same deployment moves its revision the same way: the digest is a property of
      // the resolved tree, not of the mount.
      const managed = await fixture({ confirm: false });
      try {
        const managedEmpty = await managed.workspace.info(owner, managed.companyId, managed.projectId);
        await managed.workspace.createFile(owner, managed.companyId, managed.projectId, "README.md", "managed\n");
        const managedAfter = await managed.workspace.info(owner, managed.companyId, managed.projectId);
        expect(managedAfter.currentRevision).not.toBe(managedEmpty.currentRevision);
        expect(existsSync(managed.managed)).toBe(true);
      } finally {
        await rm(managed.root, { recursive: true, force: true });
        await rm(managed.allowRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(fx.root, { recursive: true, force: true });
      await rm(fx.allowRoot, { recursive: true, force: true });
    }
  });

  it("rw writes straight into the canonical folder and ro refuses every write", async () => {
    const rw = await fixture({ mode: "rw" });
    try {
      const written = await rw.workspace.createFile(owner, rw.companyId, rw.projectId, "src/index.ts", "export const a = 1;\n");
      // Read back from the **host path**, not through the provider: the mounted folder is the canonical writer.
      const onDisk = await readFile(path.join(rw.mounted, "src", "index.ts"), "utf8");
      expect(onDisk).toBe("export const a = 1;\n");
      expect(written.revision).toBeTruthy();
      // Nothing was created under the managed root: there is no second copy of the workspace.
      expect(existsSync(rw.managed)).toBe(false);
      // Reading is unaffected, and the file the tool sees is the file on disk.
      expect((await rw.workspace.readFile(owner, rw.companyId, rw.projectId, "src/index.ts")).content).toBe(onDisk);
    } finally {
      await rm(rw.root, { recursive: true, force: true });
      await rm(rw.allowRoot, { recursive: true, force: true });
    }

    const ro = await fixture({ mode: "ro" });
    try {
      expect(await rejection(ro.workspace.createFile(owner, ro.companyId, ro.projectId, "src/index.ts", "x")))
        .toContain("mounted_folder_read_only");
      expect(await rejection(ro.workspace.writeFile(owner, ro.companyId, ro.projectId, "README.md", "x", "any")))
        .toContain("mounted_folder_read_only");
      // Negative control: reading the same ro mount works, so the refusal is about writing.
      await writeFile(path.join(ro.mounted, "README.md"), "read me\n", "utf8");
      expect((await ro.workspace.readFile(owner, ro.companyId, ro.projectId, "README.md")).content).toBe("read me\n");
    } finally {
      await rm(ro.root, { recursive: true, force: true });
      await rm(ro.allowRoot, { recursive: true, force: true });
    }
  });

  it("never deletes the mounted source when a project's workspace is removed", async () => {
    const fx = await fixture({ mode: "rw" });
    try {
      await writeFile(path.join(fx.mounted, "keep.txt"), "mine\n", "utf8");
      const outcome = await fx.workspace.removeProjectWorkspace(owner, fx.companyId, fx.projectId);
      expect(outcome.removed).toBe(true);
      expect(outcome.reason).toBe("mounted_source_preserved");
      expect(outcome.path).toBe(fx.mounted);
      expect(existsSync(path.join(fx.mounted, "keep.txt"))).toBe(true);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
      await rm(fx.allowRoot, { recursive: true, force: true });
    }
  });

  it("refuses import into a mounted workspace instead of writing a second copy of it", async () => {
    const fx = await fixture({ mode: "rw" });
    try {
      const imports = new ProjectImportService(
        fx.store,
        fx.projects,
        fx.workspace,
        undefined,
        { startPreview: async () => { throw new Error("the preview must not be reached"); } },
        { connectRepository: async () => { throw new Error("git must not be reached"); } },
      );
      // The refusal comes before anything is cloned, unpacked or written: the mounted folder is the user's own
      // directory and the import pipeline writes every file back through the workspace.
      expect(await rejection(imports.importZip(owner, fx.companyId, fx.projectId, Buffer.from("not a zip"))))
        .toContain("mounted_folder_import_unsupported");
      expect(await rejection(imports.importRepository(owner, fx.companyId, fx.projectId, { url: "https://github.com/o/r.git" })))
        .toContain("mounted_folder_import_unsupported");
    } finally {
      await rm(fx.root, { recursive: true, force: true }).catch(() => undefined);
      await rm(fx.allowRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    // Negative control: the same service on a managed project does not answer with the mount rule.
    const managed = await fixture({ confirm: false });
    try {
      const managedImports = new ProjectImportService(
        managed.store,
        managed.projects,
        new LocalProjectWorkspace(managed.projects, { root: managed.root }),
        undefined,
        { startPreview: async () => { throw new Error("the preview must not be reached"); } },
        { connectRepository: async () => { throw new Error("git must not be reached"); } },
      );
      const code = await rejection(managedImports.importZip(owner, managed.companyId, managed.projectId, Buffer.from("not a zip")));
      expect(code).not.toContain("mounted_folder_import_unsupported");
      expect(code.length).toBeGreaterThan(0);
    } finally {
      await rm(managed.root, { recursive: true, force: true }).catch(() => undefined);
      await rm(managed.allowRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("ignores an already-confirmed mount while the code.mounted_folder flag is off", async () => {
    const off = await fixture({ mode: "rw", flagEnabled: false });
    try {
      const resolved = await off.bases.resolve(owner, off.companyId, off.projectId);
      expect(resolved.source).toBe("managed");
      expect(resolved.mounted).toBe(false);
      expect(resolved.base).toBe(off.managed);
      expect(await off.workspace.mountFor(owner, off.companyId, off.projectId)).toBeNull();
      // The record is still there — the flag decides whether it is *used*, it does not erase the decision.
      const record = await off.store.getProjectMountedFolder(owner, off.companyId, off.projectId);
      expect(record?.confirmedAt).toBeTruthy();
    } finally {
      await rm(off.root, { recursive: true, force: true });
      await rm(off.allowRoot, { recursive: true, force: true });
    }
  });

  it("isolates tenants: another workspace's record is ignored, a revoked record is not a mount", async () => {
    const foreign = await fixture({ mode: "rw", recordWorkspaceId: "tenant-someone-else" });
    try {
      const resolved = await foreign.bases.resolve(owner, foreign.companyId, foreign.projectId);
      expect(resolved.source).toBe("managed");
      expect(resolved.base).toBe(foreign.managed);
    } finally {
      await rm(foreign.root, { recursive: true, force: true });
      await rm(foreign.allowRoot, { recursive: true, force: true });
    }

    const revoked = await fixture({ mode: "rw" });
    try {
      await revoked.store.setProjectMountedFolder(owner, revoked.companyId, revoked.projectId, {
        path: revoked.mounted, mode: "rw", confirmed: false, actor: owner.userId, expectedRevision: 1,
      });
      const resolved = await revoked.bases.resolve(owner, revoked.companyId, revoked.projectId);
      expect(resolved.source).toBe("managed");
      const record = await revoked.store.getProjectMountedFolder(owner, revoked.companyId, revoked.projectId);
      expect(record?.revokedAt).toBeTruthy();
      expect(await revoked.bases.mountedSource(owner, revoked.companyId, revoked.projectId)).toBeNull();
      // A foreign workspace cannot read the row at all: the store refuses before it looks.
      expect(await rejection(revoked.store.getProjectMountedFolder(foreignOwner, revoked.companyId, revoked.projectId)))
        .toContain("Company is not available");
    } finally {
      await rm(revoked.root, { recursive: true, force: true });
      await rm(revoked.allowRoot, { recursive: true, force: true });
    }
  });

  it("refuses a mount whose directory changed after the confirmation, at the workspace provider too", async () => {
    const fx = await fixture({ mode: "rw", confirm: false });
    try {
      // The confirmation happened while `linked` was a real directory…
      const linked = path.join(fx.allowRoot, "linked");
      await mkdir(linked);
      await fx.store.setProjectMountedFolder(owner, fx.companyId, fx.projectId, {
        path: linked, mode: "rw", confirmed: true, actor: owner.userId, expectedRevision: 0,
      });
      expect((await fx.bases.resolve(owner, fx.companyId, fx.projectId)).base).toBe(linked);
      // …and afterwards it was replaced by a junction pointing at another directory.
      await rm(linked, { recursive: true, force: true });
      const elsewhere = path.join(fx.allowRoot, "elsewhere");
      await mkdir(elsewhere, { recursive: true });
      await symlink(elsewhere, linked, "junction");

      const refused = await rejection(fx.bases.resolve(owner, fx.companyId, fx.projectId));
      expect(refused).toContain("symlink_escape");
      // A mount that stopped being safe stops the call: falling back to the managed root would silently point
      // the workspace somewhere nobody confirmed.
      expect(await rejection(fx.workspace.listFiles(owner, fx.companyId, fx.projectId))).toContain("symlink_escape");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
      await rm(fx.allowRoot, { recursive: true, force: true });
    }
  });

  /**
   * G1 (D9) — the hardlink case, **measured** rather than assumed.
   *
   * A hardlink is a second *name* for an inode, not a link that is followed, so neither half of the path
   * guard can see it: `lstat` reports a regular file (not a symbolic link) and `realpath` resolves *inside*
   * the workspace, which is why a component check and a resolved-path comparison both pass. This test pins
   * both halves of the answer:
   *
   *  - **what the path guard cannot do** — measured: the linked name is a regular file with `nlink > 1`, and
   *    it carries no target to compare, so a name-based protection would be a name-length away from useless;
   *  - **what actually refuses the secret** — the workspace provider checks the **content**, not the name
   *    (`project-workspace.ts`: `secret_content`, 403), and a private-key block is refused under the innocent
   *    name `notes.txt`. The negative control is a second hardlink whose content is ordinary text: it is
   *    served normally, so the refusal comes from the content rule and not from "hardlinks are blocked"
   *    (which the guard does not even implement).
   *
   * Residual honest limitation (recorded, not papered over): the content rule is a pattern check with a
   * manifest/lockfile exemption, so it recognises private-key blocks and the documented token shapes rather
   * than "any secret". That limit is a property of the content rule and is identical for a **copied** file —
   * a hardlink adds no capability the copy does not already have, which is why no hardlink-specific rule is
   * added here (it would refuse the hardlinks `pnpm`/`npm` legitimately create in `node_modules` and protect
   * nothing, and the read-side check covers both shapes).
   */
  it("measures the hardlink case: the path guard cannot see it, the content rule refuses the secret", async () => {
    const fx = await fixture({ mode: "rw" });
    const outside = await tempDir("npati-c15-hardlink-outside-");
    try {
      // Both files live OUTSIDE the mounted folder, in a directory the allowlist would refuse.
      const secret = path.join(outside, "id_rsa");
      const ordinary = path.join(outside, "ordinary.txt");
      await writeFile(secret, "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n", "utf8");
      await writeFile(ordinary, "an ordinary sentence\n", "utf8");

      const linkedSecret = path.join(fx.mounted, "notes.txt");
      const linkedOrdinary = path.join(fx.mounted, "notes2.txt");
      await link(secret, linkedSecret);
      await link(ordinary, linkedOrdinary);

      // The path guard's blind spot, measured: a regular file, twice-linked inode, no link target to resolve.
      const stats = await lstat(linkedSecret);
      const source = await lstat(secret);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.nlink).toBeGreaterThan(1);
      expect(stats.ino).toBe(source.ino);
      expect(stats.dev).toBe(source.dev);

      // What refuses it: the content rule, under a name no sensitive-path pattern matches.
      expect(await rejection(fx.workspace.readFile(owner, fx.companyId, fx.projectId, "notes.txt")))
        .toContain("secret_content");

      // Negative control: the same link shape with ordinary content is served, so the refusal above is the
      // content rule and not a blanket refusal of multiply-linked files.
      const served = await fx.workspace.readFile(owner, fx.companyId, fx.projectId, "notes2.txt");
      expect(served.content).toBe("an ordinary sentence\n");

      // Containment, measured: a workspace written only through the API can never contain such a name,
      // because the API writes content and produces single-link regular files.
      await fx.workspace.createFile(owner, fx.companyId, fx.projectId, "written-by-api.txt", "same bytes\n");
      expect((await lstat(path.join(fx.mounted, "written-by-api.txt"))).nlink).toBe(1);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
      await rm(fx.allowRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("security-gate: C15 — the revision guard has no mounted branch", () => {
  it("fires workspace_revision_mismatch for a mounted project through the unchanged guard", async () => {
    const fx = await fixture({ mode: "rw" });
    try {
      // The guard's only port is `ProjectWorkspace.info` — nothing about a mount is visible to it.
      const guard = new CodeWorkspaceRevisionGuard({
        read: async ({ ctx, companyId, projectId }) => {
          const info = await fx.workspace.info(ctx, companyId, projectId);
          return { currentRevision: info.currentRevision, currentBranch: info.currentBranch ?? null };
        },
      });
      const scope = { ctx: owner, companyId: fx.companyId, projectId: fx.projectId };
      const snapshot = await guard.capture(scope);
      // Unchanged: the guard lets the operation through, so the refusal below is not a blanket denial.
      await guard.assertUnchanged(scope, snapshot, "sandbox_exec");

      await writeFile(path.join(fx.mounted, "changed-by-the-user.txt"), "moved\n", "utf8");
      let code = "";
      try {
        await guard.assertUnchanged(scope, snapshot, "sandbox_exec");
      } catch (error) {
        code = (error as { code?: string }).code ?? "";
      }
      expect(code).toBe(WORKSPACE_REVISION_MISMATCH);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
      await rm(fx.allowRoot, { recursive: true, force: true });
    }
  });

  it("is the same code path for a managed project, and the guard source names no mount at all", async () => {
    const managed = await fixture({ confirm: false });
    try {
      const workspace = new LocalProjectWorkspace(managed.projects, { root: managed.root });
      const guard = new CodeWorkspaceRevisionGuard({
        read: async ({ ctx, companyId, projectId }) => {
          const info = await workspace.info(ctx, companyId, projectId);
          return { currentRevision: info.currentRevision, currentBranch: info.currentBranch ?? null };
        },
      });
      const scope = { ctx: owner, companyId: managed.companyId, projectId: managed.projectId };
      const snapshot = await guard.capture(scope);
      await guard.assertUnchanged(scope, snapshot, "git_commit");
      await workspace.createFile(owner, managed.companyId, managed.projectId, "a.txt", "a\n");
      let code = "";
      try {
        await guard.assertUnchanged(scope, snapshot, "git_commit");
      } catch (error) {
        code = (error as { code?: string }).code ?? "";
      }
      expect(code).toBe(WORKSPACE_REVISION_MISMATCH);
    } finally {
      await rm(managed.root, { recursive: true, force: true });
      await rm(managed.allowRoot, { recursive: true, force: true });
    }

    /**
     * The source half of the same claim: the guard cannot have a mounted branch because it never mentions a
     * mount, and neither does the module that decides `workspace_revision_mismatch`. A future "special case for
     * mounted workspaces" here would be the exact bypass the owner decision forbids, so the absence is pinned
     * rather than described.
     */
    const guardSource = readFileSync(path.resolve("apps/agent-api/src/code-workspace-revision.ts"), "utf8");
    expect(/mount/i.test(guardSource)).toBe(false);
  });
});

describe("security-gate: C15 — the allowlist is additive, server-gated and tenant scoped", () => {
  it("migration 086 is additive, constrained and registered by the store", () => {
    const migration = readFileSync(path.resolve("packages/workspace/src/migration-086.ts"), "utf8");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS project_mounted_folders");
    expect(migration).toContain("CHECK (mode IN ('ro', 'rw'))");
    expect(migration).toContain("UNIQUE (company_id, project_id)");
    expect(migration).toContain("revision integer NOT NULL DEFAULT 0");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS project_mounted_folders_company_idx");
    // No existing table is touched: a previous application version keeps working against the new schema.
    expect(migration).not.toMatch(/ALTER TABLE/);
    expect(migration).not.toMatch(/DROP /);

    const store = readFileSync(path.resolve("packages/workspace/src/postgres-store.ts"), "utf8");
    expect(store).toMatch(/await import\("\.\/migration-086"\)/);
    expect(store).toMatch(/INSERT INTO schema_migrations\(version\) VALUES \('086_project_mounted_folders'\)/);
    expect(store).toMatch(/SELECT 1 FROM schema_migrations WHERE version='086_project_mounted_folders'/);
    expect(store).toContain("getProjectMountedFolderForSystem");
  });

  it("the mount decisions are journalled with their own action names, mapped to the owner-level permission", () => {
    const rbac = readFileSync(path.resolve("apps/agent-api/src/code-rbac.ts"), "utf8");
    expect(rbac).toContain('"code.project.mount": "business:manage"');
    expect(rbac).toContain('"code.project.unmount": "business:manage"');

    const gate = readFileSync(path.resolve("apps/agent-api/src/code-mounted-folder.ts"), "utf8");
    // Audit before the write, and a refusal to change anything without the journal.
    expect(gate.indexOf('await this.audit("code.project.mount"')).toBeLessThan(gate.indexOf("return this.deps.store.setProjectMountedFolder"));
    expect(gate).toContain('"audit_unavailable"');
    expect(gate).toContain('"feature_disabled"');
    expect(gate).toContain('"mounted_folder_confirmation_required"');
  });
});
