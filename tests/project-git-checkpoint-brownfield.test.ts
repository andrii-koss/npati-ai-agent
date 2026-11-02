import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryWorkspaceStore } from "../packages/workspace/src/in-memory-store";
import type { AuthContext } from "@npati/workspace";
import { ProjectGitService } from "../apps/agent-api/src/project-git-service";

const ctx: AuthContext = { userId: "checkpoint-user", workspaceId: "checkpoint-tenant", permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"] };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function importedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "npati-checkpoint-brownfield-"));
  roots.push(root);
  const store = new InMemoryWorkspaceStore();
  await store.initialize(ctx);
  const company = await store.createCompany(ctx, { name: "Checkpoint test" }, "checkpoint-company");
  const { project } = await store.createProject(ctx, company.id, { name: "Imported repo", type: "website" }, "checkpoint-project");
  const service = new ProjectGitService(store, { get: (auth, companyId, projectId) => store.getProject(auth, companyId, projectId) }, root);
  const { dir } = await service.getProjectPath(ctx, company.id, project.id);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
  git(["init", "-b", "main"]);
  await writeFile(path.join(dir, "app.txt"), "baseline\n");
  git(["add", "app.txt"]);
  git(["-c", "user.name=Fixture Author", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "-m", "Imported baseline"]);
  // Ensure the service's real Git subprocesses also ignore ambient machine identity.
  const runGit = (service as unknown as { runGit: (dir: string, args: string[], env?: Record<string, string>) => Promise<{stdout: string; stderr: string}> }).runGit.bind(service);
  (service as unknown as { runGit: typeof runGit }).runGit = (cwd, args, overrides) => runGit(cwd, args, { ...env, ...overrides });
  return { service, company, project, dir, git };
}

describe("checkpoints in unnormalized imported repositories", () => {
  it("excludes runtime lock/worktree sidecars, including leftovers staged by a failed old checkpoint", async () => {
    const f = await importedFixture();
    f.git(["config", "user.name", "Existing Author"]);
    f.git(["config", "user.email", "existing@localhost"]);
    await mkdir(path.join(f.dir, ".npati-write-lock"));
    await writeFile(path.join(f.dir, ".npati-write-lock", "owner"), "active-lease");
    await mkdir(path.join(f.dir, ".worktrees", "child"), { recursive: true });
    await writeFile(path.join(f.dir, ".worktrees", "child", "private.txt"), "internal");
    await writeFile(path.join(f.dir, "app.txt"), "dirty application\n");
    f.git(["add", "-A"]); // Matches the index left by the historical failed checkpoint.
    const checkpoint = await f.service.createCheckpoint(ctx, f.company.id, f.project.id, { name: "Before edit", trigger: "pre_run" });
    expect(checkpoint.commitHash).toMatch(/^[a-f0-9]{40}$/);
    expect(f.git(["ls-tree", "-r", "--name-only", checkpoint.commitHash!])).toBe("app.txt");
    expect(f.git(["show", `${checkpoint.commitHash}:app.txt`])).toBe("dirty application");
    expect(await readFile(path.join(f.dir, ".npati-write-lock", "owner"), "utf8")).toBe("active-lease");
    expect(await readFile(path.join(f.dir, ".worktrees", "child", "private.txt"), "utf8")).toBe("internal");
    expect(f.git(["show", "-s", "--format=%an <%ae>", checkpoint.commitHash!])).toBe("Existing Author <existing@localhost>");
  });

  it("checkpoints dirty imported source without repository/global identity or editing user config", async () => {
    const f = await importedFixture();
    const config = await readFile(path.join(f.dir, ".git", "config"), "utf8");
    await writeFile(path.join(f.dir, "app.txt"), "unsaved user work\n");
    const checkpoint = await f.service.createCheckpoint(ctx, f.company.id, f.project.id, { name: "Imported dirty source" });
    expect(f.git(["show", `${checkpoint.commitHash}:app.txt`])).toBe("unsaved user work");
    expect(await readFile(path.join(f.dir, ".git", "config"), "utf8")).toBe(config);
    expect(f.git(["show", "-s", "--format=%an <%ae>", checkpoint.commitHash!])).toBe("NPATI AI Agent <agent@npati.ai>");
  });

  it("still refuses protected application files rather than bypassing index security", async () => {
    const f = await importedFixture();
    await mkdir(path.join(f.dir, ".npati-write-lock"));
    await writeFile(path.join(f.dir, ".npati-write-lock", "owner"), "lease");
    await writeFile(path.join(f.dir, ".env"), "FAKE_SECRET=synthetic\n");
    await expect(f.service.createCheckpoint(ctx, f.company.id, f.project.id, { name: "Must refuse secret" })).rejects.toMatchObject({ code: "PROTECTED_FILE" });
    expect(f.git(["log", "--format=%s"])).toBe("Imported baseline");
  });

  it("can snapshot an unborn imported branch while a runtime lease is staged", async () => {
    const f = await importedFixture();
    f.git(["checkout", "--orphan", "fresh-import"]);
    await mkdir(path.join(f.dir, ".npati-write-lock"));
    await writeFile(path.join(f.dir, ".npati-write-lock", "owner"), "lease");
    f.git(["add", "-A"]);
    const checkpoint = await f.service.createCheckpoint(ctx, f.company.id, f.project.id, { name: "First imported commit" });
    expect(f.git(["ls-tree", "-r", "--name-only", checkpoint.commitHash!])).toBe("app.txt");
    expect(await readFile(path.join(f.dir, ".npati-write-lock", "owner"), "utf8")).toBe("lease");
  });

  it("preserves an imported repository's required commit signing instead of bypassing it", async () => {
    const f = await importedFixture();
    f.git(["config", "commit.gpgsign", "true"]);
    f.git(["config", "gpg.program", "npati-e2e-nonexistent-signing-program"]);
    const configBefore = await readFile(path.join(f.dir, ".git", "config"), "utf8");
    await writeFile(path.join(f.dir, "app.txt"), "unsigned source must not be committed");
    await expect(f.service.createCheckpoint(ctx, f.company.id, f.project.id, { name: "Required signing" })).rejects.toThrow();
    expect(f.git(["log", "--format=%s"])).toBe("Imported baseline");
    expect(await readFile(path.join(f.dir, ".git", "config"), "utf8")).toBe(configBefore);
  });
});
