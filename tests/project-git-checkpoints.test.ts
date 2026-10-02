import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryWorkspaceStore } from "../packages/workspace/src/in-memory-store";
import type { AuthContext, Project } from "@npati/workspace";
import {
  ProjectGitService,
  GitError,
  GitConflictError,
  GitConflictEscalationError,
  GitApprovalRequiredError,
} from "../apps/agent-api/src/project-git-service";

const ctxA: AuthContext = {
  userId: "user-alpha",
  workspaceId: "tenant-alpha",
  permissions: ["workspace:read", "workspace:write", "business:manage", "tools:execute"],
};

const ctxB: AuthContext = {
  userId: "user-beta",
  workspaceId: "tenant-beta",
  permissions: ["workspace:read", "workspace:write"],
};

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "npati-git-test-"));
  tempDirs.push(root);

  const store = new InMemoryWorkspaceStore();
  await store.initialize(ctxA);

  const company = await store.createCompany(ctxA, { name: "Test Company" }, "comp-1");
  const { project } = await store.createProject(
    ctxA,
    company.id,
    { name: "My Website", type: "website" },
    "proj-1"
  );

  const projectService = {
    get: async (ctx: AuthContext, companyId: string, projectId: string) => {
      return store.getProject(ctx, companyId, projectId);
    },
  };

  const gitService = new ProjectGitService(store, projectService, root);
  const { dir: projectDir } = await gitService.getProjectPath(ctxA, company.id, project.id);
  await gitService.ensureRepository(ctxA, company.id, project.id);

  return { store, company, project, gitService, root, projectDir };
}

describe("Step 6: Git operations in Project Workspace", () => {
  it("initializes repository and reports clean status initially", async () => {
    const { company, project, gitService } = await createFixture();

    const status = await gitService.status(ctxA, company.id, project.id);
    expect(status.branch).toBe("main");
    expect(status.clean).toBe(true);
  });

  it("detects untracked and modified files, generates diff, stages and commits", async () => {
    const { company, project, gitService, root } = await createFixture();
    const projectDir = path.join(root, company.id, project.id);

    // Create a new file
    await writeFile(path.join(projectDir, "index.html"), "<h1>Hello World</h1>\n");

    const st1 = await gitService.status(ctxA, company.id, project.id);
    expect(st1.untracked).toContain("index.html");

    // Stage file
    await gitService.stage(ctxA, company.id, project.id, ["index.html"]);
    const st2 = await gitService.status(ctxA, company.id, project.id);
    expect(st2.staged).toContain("index.html");

    // Check diff
    const { diff } = await gitService.diff(ctxA, company.id, project.id, { staged: true });
    expect(diff).toContain("+<h1>Hello World</h1>");

    // Commit
    const commitRes = await gitService.commit(ctxA, company.id, project.id, {
      message: "Add index.html homepage",
    });
    expect(commitRes.commitHash).toMatch(/^[0-9a-f]{40}$/);

    const st3 = await gitService.status(ctxA, company.id, project.id);
    expect(st3.clean).toBe(true);

    // Verify commit in log
    const log = await gitService.log(ctxA, company.id, project.id, 5);
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0]!.message).toBe("Add index.html homepage");
  });

  it("creates and switches Git branches", async () => {
    const { company, project, gitService } = await createFixture();

    const created = await gitService.branch(ctxA, company.id, project.id, {
      action: "create",
      branch: "feature/navbar",
    });
    expect(created.current).toBe("feature/navbar");
    expect(created.branches).toContain("feature/navbar");

    const switched = await gitService.branch(ctxA, company.id, project.id, {
      action: "switch",
      branch: "main",
    });
    expect(switched.current).toBe("main");
    const commit = await gitService.commit(ctxA, company.id, project.id, { message: "Mark completed run" });
    expect(commit.commitHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("restores file changes discarding uncommitted modifications", async () => {
    const { company, project, gitService, root } = await createFixture();
    const projectDir = path.join(root, company.id, project.id);
    const filePath = path.join(projectDir, "app.js");

    await writeFile(filePath, "console.log('original');\n");
    await gitService.commit(ctxA, company.id, project.id, { message: "Original app.js", stageAll: true });

    // Modify file
    await writeFile(filePath, "console.log('broken modification');\n");
    const diff = await gitService.diff(ctxA, company.id, project.id);
    expect(diff.diff).toContain("+console.log('broken modification');");

    // Restore
    await gitService.restore(ctxA, company.id, project.id, { files: ["app.js"] });
    const restoredContent = await readFile(filePath, "utf-8");
    expect(restoredContent).toContain("console.log('original');");
  });
});

describe("Step 6: Checkpoints and Safety Rollback", () => {
  it("creates checkpoints and lists them in descending order", async () => {
    const { company, project, gitService, root } = await createFixture();
    const projectDir = path.join(root, company.id, project.id);

    await writeFile(path.join(projectDir, "file1.txt"), "Version 1");
    const cp1 = await gitService.createCheckpoint(ctxA, company.id, project.id, {
      name: "Initial layout",
      description: "Baseline checkpoint",
      trigger: "manual",
    });

    expect(cp1.name).toBe("Initial layout");
    expect(cp1.trigger).toBe("manual");
    expect(cp1.commitHash).toBeDefined();

    await writeFile(path.join(projectDir, "file2.txt"), "Version 2");
    const cp2 = await gitService.createCheckpoint(ctxA, company.id, project.id, {
      name: "Added file 2",
      trigger: "post_run",
    });

    const list = await gitService.listCheckpoints(ctxA, company.id, project.id);
    expect(list.length).toBe(2);
    expect(list[0]!.id).toBe(cp2.id);
    expect(list[1]!.id).toBe(cp1.id);
  });

  it("restores checkpoint and automatically creates a pre_restore safety backup first", async () => {
    const { company, project, gitService, root } = await createFixture();
    const projectDir = path.join(root, company.id, project.id);
    const testFile = path.join(projectDir, "page.txt");

    // State 1: Checkpoint A
    await writeFile(testFile, "State A: Clean design");
    const checkpointA = await gitService.createCheckpoint(ctxA, company.id, project.id, {
      name: "Clean design",
      trigger: "manual",
    });

    // State 2: Checkpoint B
    await writeFile(testFile, "State B: Redesign with bugs");
    await gitService.createCheckpoint(ctxA, company.id, project.id, {
      name: "Buggy redesign",
      trigger: "manual",
    });

    // Restore to Checkpoint A
    const result = await gitService.restoreCheckpoint(ctxA, company.id, project.id, checkpointA.id, { approved: true });

    // 1. Working tree is restored to State A
    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("State A: Clean design");

    // 2. An automatic pre_restore backup checkpoint was created before rollback
    expect(result.backupCheckpoint).toBeDefined();
    expect(result.backupCheckpoint.trigger).toBe("pre_restore");
    expect(result.backupCheckpoint.name).toContain('Before restoring "Clean design"');

    // 3. Checkpoints list contains the automatic pre_restore checkpoint
    const allCheckpoints = await gitService.listCheckpoints(ctxA, company.id, project.id);
    const preRestore = allCheckpoints.find((c) => c.trigger === "pre_restore");
    expect(preRestore).toBeDefined();
    await gitService.restoreCheckpoint(ctxA, company.id, project.id, result.backupCheckpoint.id, { approved: true });
    expect(await readFile(testFile, "utf-8")).toBe("State B: Redesign with bugs");
  });
});

describe("Step 6: Remote Approval Gating and Security Isolation", () => {
  it("blocks external push without explicit human approval", async () => {
    const { company, project, gitService, store } = await createFixture();

    // Set repository url
    await store.updateProjectPreview(ctxA, company.id, project.id, {
      status: "ready",
    });

    await expect(
      gitService.push(ctxA, company.id, project.id, { approved: false })
    ).rejects.toThrow(GitApprovalRequiredError);
  });

  it("blocks Pull Request creation without explicit human approval", async () => {
    const { company, project, gitService } = await createFixture();

    await expect(
      gitService.createPullRequest(ctxA, company.id, project.id, {
        title: "Deploy update",
        approved: false,
      })
    ).rejects.toThrow(GitApprovalRequiredError);
  });

  it("enforces tenant isolation between different companies and workspaces", async () => {
    const { company, project, gitService } = await createFixture();

    // User from tenant-beta cannot access tenant-alpha project
    await expect(
      gitService.status(ctxB, company.id, project.id)
    ).rejects.toThrow();

    // Wrong company ID fails
    await expect(
      gitService.status(ctxA, "other-company-id", project.id)
    ).rejects.toThrow();
  });

  it("prevents path traversal in git file operations", async () => {
    const { company, project, gitService } = await createFixture();

    await expect(
      gitService.stage(ctxA, company.id, project.id, ["../../etc/passwd"])
    ).rejects.toThrow();

    await expect(
      gitService.restore(ctxA, company.id, project.id, { files: ["../secret.txt"] })
    ).rejects.toThrow();
  });
});

describe("Step 6: Repository connection and route approval", () => {
  it("persists a validated GitHub repository connection", async () => {
    const { company, project, gitService, store } = await createFixture();
    const connected = await gitService.connectRepository(ctxA, company.id, project.id, { url: "https://github.com/example/site" });
    expect(connected.repositoryUrl).toBe("https://github.com/example/site.git");
    expect((await store.getProject(ctxA, company.id, project.id)).repositoryProvider).toBe("github");
    await expect(gitService.push(ctxA, company.id, project.id, { approved: true })).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
    await expect(gitService.connectRepository(ctxA, company.id, project.id, { url: "https://github.com.evil.test/example/site" })).rejects.toThrow(GitError);
    await expect(gitService.connectRepository(ctxA, company.id, project.id, { url: "https://token@github.com/example/site" })).rejects.toThrow(GitError);
  });

  it("rejects forged HTTP approval and never echoes a supplied token", async () => {
    const { company, project, gitService } = await createFixture();
    const { default: fastify } = await import("fastify");
    const { registerProjectGitRoutes } = await import("../apps/agent-api/src/project-git-routes");
    const app = fastify();
    registerProjectGitRoutes(app, gitService, { authenticate: async () => ctxA } as any);
    const secret = "github_pat_FAKETOKENFORTEST";
    const response = await app.inject({
      method: "POST",
      url: `/companies/${company.id}/projects/${project.id}/git/push`,
      payload: { approved: true, token: secret },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(secret);
    await app.close();
  });
});
describe("Step 6: Git Conflict Handling", () => {
  it("reports unmerged files without changing conflict contents", async () => {
    const { company, project, gitService, projectDir } = await createFixture();
    const { execFileSync } = await import("node:child_process");
    const filePath = path.join(projectDir, "conflict.txt");
    await writeFile(filePath, "base\n");
    await gitService.commit(ctxA, company.id, project.id, { message: "Base", stageAll: true });
    await gitService.branch(ctxA, company.id, project.id, { action: "create", branch: "feature/conflict" });
    await writeFile(filePath, "feature\n");
    await gitService.commit(ctxA, company.id, project.id, { message: "Feature", stageAll: true });
    await gitService.branch(ctxA, company.id, project.id, { action: "switch", branch: "main" });
    await writeFile(filePath, "main\n");
    await gitService.commit(ctxA, company.id, project.id, { message: "Main", stageAll: true });
    expect(() => execFileSync("git", ["merge", "feature/conflict"], { cwd: projectDir })).toThrow();
    const before = await readFile(filePath, "utf-8");
    await expect(gitService.status(ctxA, company.id, project.id)).rejects.toThrow(GitConflictError);
    expect(await readFile(filePath, "utf-8")).toBe(before);
  });
});