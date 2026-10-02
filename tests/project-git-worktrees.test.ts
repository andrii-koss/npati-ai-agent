import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryWorkspaceStore } from "../packages/workspace/src/in-memory-store";
import type { AuthContext, Project } from "@npati/workspace";
import {
  ProjectGitService,
  GitError,
  GitConflictEscalationError,
} from "../apps/agent-api/src/project-git-service";
import { LocalProjectWorkspace } from "../apps/agent-api/src/project-workspace";
import { ProjectMultiAgentService } from "../apps/agent-api/src/project-multi-agent";
import type { CompanyDelegationRuntime } from "../apps/agent-api/src/company-runtime";
import type { ProjectPreviewService } from "../apps/agent-api/src/project-preview-service";

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
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "npati-worktree-test-"));
  tempDirs.push(root);

  const store = new InMemoryWorkspaceStore();
  await store.initialize(ctxA);

  const company = await store.createCompany(ctxA, { name: "Worktree Corp" }, "comp-wt-1");
  const { project } = await store.createProject(
    ctxA,
    company.id,
    { name: "SaaS Platform", type: "website" },
    "proj-wt-1"
  );

  const projectService = {
    get: async (ctx: AuthContext, companyId: string, projectId: string) => {
      return store.getProject(ctx, companyId, projectId);
    },
  };

  const gitService = new ProjectGitService(store, projectService, root);
  const workspace = new LocalProjectWorkspace(projectService, { root });
  const { dir: projectDir } = await gitService.getProjectPath(ctxA, company.id, project.id);
  await gitService.ensureRepository(ctxA, company.id, project.id);

  return { store, company, project, gitService, workspace, root, projectDir };
}

describe("Step 9: Agent Worktrees", () => {
  it("creates an isolated agent worktree and branch from project/main", async () => {
    const { company, project, gitService } = await createFixture();

    const wt = await gitService.createAgentWorktree(ctxA, company.id, project.id, {
      agentSlug: "frontend",
      baseBranch: "project/main",
    });

    expect(wt.branch).toBe("agent/frontend");
    expect(wt.baseBranch).toBe("project/main");
    expect(wt.worktreePath).toContain(".worktrees");
    expect(wt.worktreePath).toContain("frontend");

    const list = await gitService.listAgentWorktrees(ctxA, company.id, project.id);
    expect(list.some((item) => item.branch === "agent/frontend")).toBe(true);
  });

  it("enforces strict isolation between agent branches", async () => {
    const { company, project, gitService, projectDir } = await createFixture();

    // Create worktrees for two separate agents
    const wtFrontend = await gitService.createAgentWorktree(ctxA, company.id, project.id, {
      agentSlug: "frontend",
    });
    const wtSeo = await gitService.createAgentWorktree(ctxA, company.id, project.id, {
      agentSlug: "seo",
    });

    // Frontend creates src/Hero.tsx
    await mkdir(path.join(wtFrontend.worktreePath, "src"), { recursive: true });
    await writeFile(path.join(wtFrontend.worktreePath, "src", "Hero.tsx"), "export const Hero = () => <h1>Hero</h1>;\n");

    // SEO creates public/robots.txt
    await mkdir(path.join(wtSeo.worktreePath, "public"), { recursive: true });
    await writeFile(path.join(wtSeo.worktreePath, "public", "robots.txt"), "User-agent: *\nAllow: /\n");

    // Verify isolation: Frontend's file is NOT in SEO worktree, nor in main project dir
    const frontendFileInSeo = await readFile(path.join(wtSeo.worktreePath, "src", "Hero.tsx")).catch(() => null);
    expect(frontendFileInSeo).toBeNull();

    const frontendFileInMain = await readFile(path.join(projectDir, "src", "Hero.tsx")).catch(() => null);
    expect(frontendFileInMain).toBeNull();

    // SEO's file is NOT in Frontend worktree, nor in main project dir
    const seoFileInFrontend = await readFile(path.join(wtFrontend.worktreePath, "public", "robots.txt")).catch(() => null);
    expect(seoFileInFrontend).toBeNull();

    const seoFileInMain = await readFile(path.join(projectDir, "public", "robots.txt")).catch(() => null);
    expect(seoFileInMain).toBeNull();
  });

  it("executes review -> merge pipeline and updates project/main", async () => {
    const { company, project, gitService, projectDir } = await createFixture();

    const wt = await gitService.createAgentWorktree(ctxA, company.id, project.id, {
      agentSlug: "frontend",
      baseBranch: "project/main",
    });

    // Make changes in frontend worktree
    await mkdir(path.join(wt.worktreePath, "src"), { recursive: true });
    await writeFile(path.join(wt.worktreePath, "src", "Header.tsx"), "export const Header = () => <header>Logo</header>;\n");

    // Commit worktree changes
    const commit = await gitService.commitAgentWorktree(ctxA, company.id, project.id, {
      agentSlug: "frontend",
      message: "Add Header component",
    });
    expect(commit.commitHash).toMatch(/^[0-9a-f]{40}$/);

    // Review step: check diff
    const review = await gitService.diffAgentWorktree(ctxA, company.id, project.id, {
      agentSlug: "frontend",
      baseBranch: "project/main",
    });
    expect(review.files).toContain("src/Header.tsx");
    expect(review.diff).toContain("+export const Header");

    // Merge step: merge agent/frontend into project/main
    const merge = await gitService.mergeAgentWorktree(ctxA, company.id, project.id, {
      agentSlug: "frontend",
      targetBranch: "project/main",
    });
    expect(merge.merged).toBe(true);
    expect(merge.targetBranch).toBe("project/main");
    expect(merge.sourceBranch).toBe("agent/frontend");

    // Verify Header.tsx is now in main repository
    const mainHeader = await readFile(path.join(projectDir, "src", "Header.tsx"), "utf-8");
    expect(mainHeader).toContain("<header>Logo</header>");
  });

  it("detects merge conflict, aborts merge cleanly, and throws GitConflictEscalationError", async () => {
    const { company, project, gitService, projectDir } = await createFixture();

    // Ensure branch project/main exists and is checked out
    await gitService.branch(ctxA, company.id, project.id, { action: "create", branch: "project/main" }).catch(() =>
      gitService.branch(ctxA, company.id, project.id, { action: "switch", branch: "project/main" })
    );

    // Create an initial shared file on project/main
    await writeFile(path.join(projectDir, "README.md"), "# Initial Title\n");
    await gitService.stage(ctxA, company.id, project.id);
    await gitService.commit(ctxA, company.id, project.id, { message: "Initial README" });

    // Create worktree from project/main
    const wt = await gitService.createAgentWorktree(ctxA, company.id, project.id, {
      agentSlug: "frontend",
      baseBranch: "project/main",
    });

    // Frontend modifies README.md in worktree
    await writeFile(path.join(wt.worktreePath, "README.md"), "# Frontend Custom Title\n");
    await gitService.commitAgentWorktree(ctxA, company.id, project.id, {
      agentSlug: "frontend",
      message: "Frontend edits README",
    });

    // Meanwhile, project/main gets a conflicting modification
    await gitService.branch(ctxA, company.id, project.id, { action: "switch", branch: "project/main" });
    await writeFile(path.join(projectDir, "README.md"), "# Main Conflicting Title\n");
    await gitService.stage(ctxA, company.id, project.id);
    await gitService.commit(ctxA, company.id, project.id, { message: "Main edits README" });

    // Attempting to merge should detect the conflict and escalate
    let thrownError: unknown;
    try {
      await gitService.mergeAgentWorktree(ctxA, company.id, project.id, {
        agentSlug: "frontend",
        targetBranch: "project/main",
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(GitConflictEscalationError);
    const escalation = thrownError as GitConflictEscalationError;
    expect(escalation.conflictingFiles).toContain("README.md");

    // Verify main repository status is clean because merge was aborted
    const status = await gitService.status(ctxA, company.id, project.id);
    expect(status.clean).toBe(true);
  });

  it("cleans up individual agent worktrees and prunes git", async () => {
    const { company, project, gitService } = await createFixture();

    const wt = await gitService.createAgentWorktree(ctxA, company.id, project.id, {
      agentSlug: "design",
    });

    const listBefore = await gitService.listAgentWorktrees(ctxA, company.id, project.id);
    expect(listBefore.some((item) => item.branch === "agent/design")).toBe(true);

    const removeResult = await gitService.removeAgentWorktree(ctxA, company.id, project.id, {
      agentSlug: "design",
      deleteBranch: true,
    });
    expect(removeResult.removed).toBe(true);

    const listAfter = await gitService.listAgentWorktrees(ctxA, company.id, project.id);
    expect(listAfter.some((item) => item.branch === "agent/design")).toBe(false);
  });

  it("cleans up all agent worktrees in batch", async () => {
    const { company, project, gitService } = await createFixture();

    await gitService.createAgentWorktree(ctxA, company.id, project.id, { agentSlug: "agent-1" });
    await gitService.createAgentWorktree(ctxA, company.id, project.id, { agentSlug: "agent-2" });

    const before = await gitService.listAgentWorktrees(ctxA, company.id, project.id);
    expect(before.length).toBeGreaterThanOrEqual(2);

    const cleanup = await gitService.cleanupAllWorktrees(ctxA, company.id, project.id);
    expect(cleanup.cleanedCount).toBeGreaterThanOrEqual(2);

    const after = await gitService.listAgentWorktrees(ctxA, company.id, project.id);
    expect(after.length).toBe(0);
  });

  it("routes LocalProjectWorkspace operations to worktree when agent worktree is registered", async () => {
    const { company, project, gitService, workspace } = await createFixture();

    const wt = await gitService.createAgentWorktree(ctxA, company.id, project.id, {
      agentSlug: "frontend",
    });

    const agentId = "agent-fe-1";
    workspace.registerWorktree(company.id, project.id, agentId, wt.worktreePath);

    // Write file using workspace with agentId
    await workspace.createFile(ctxA, company.id, project.id, "src/Component.tsx", "export const Comp = 1;", undefined, agentId);

    // File should exist inside worktree
    const fileInWt = await readFile(path.join(wt.worktreePath, "src", "Component.tsx"), "utf-8");
    expect(fileInWt).toBe("export const Comp = 1;");

    // Reading with agentId retrieves the file
    const read = await workspace.readFile(ctxA, company.id, project.id, "src/Component.tsx", undefined, agentId);
    expect(read.content).toBe("export const Comp = 1;");

    // Unregister
    workspace.unregisterWorktree(company.id, project.id, agentId);
    expect(workspace.getWorktree(company.id, project.id, agentId)).toBeUndefined();
  });

  it("prevents worktree directory path traversal attacks", async () => {
    const { company, project, gitService } = await createFixture();

    await expect(
      gitService.createAgentWorktree(ctxA, company.id, project.id, {
        agentSlug: "../../etc/evil",
      })
    ).rejects.toThrow();
  });

  it("enforces tenant isolation: Tenant B cannot access or create worktrees for Tenant A", async () => {
    const { company, project, gitService } = await createFixture();

    await expect(
      gitService.createAgentWorktree(ctxB, company.id, project.id, {
        agentSlug: "frontend",
      })
    ).rejects.toThrow();
  });

  it("executes multi-agent workflow in worktree mode with review, merge, and events", async () => {
    const { store, company, project, gitService, workspace } = await createFixture();

    // Create specialist agents
    const mainAgent = await store.createCompanyAgent(ctxA, company.id, {
      name: "Main Coordinator",
      role: "main",
      systemInstruction: "Coordinate and plan website development tasks.",
      tools: ["project.files.read", "project.files.write"],
    }, "agent-key-main");
    const curComp = await store.getCompany(ctxA, company.id);
    await store.updateCompany(ctxA, company.id, { mainAgentId: mainAgent.id }, curComp.revision);

    const frontendAgent = await store.createCompanyAgent(ctxA, company.id, {
      name: "Frontend Specialist",
      role: "frontend",
      systemInstruction: "Build frontend UI components.",
      tools: ["project.files.read", "project.files.write"],
    }, "agent-key-fe");

    const seoAgent = await store.createCompanyAgent(ctxA, company.id, {
      name: "SEO Specialist",
      role: "seo",
      systemInstruction: "Optimize metadata and sitemap.",
      tools: ["project.files.read", "project.files.write"],
    }, "agent-key-seo");

    const mockRuntime: CompanyDelegationRuntime = {
      execute: async (_ctx, _companyId, input, _key) => {
        const taskText = String(input.task);
        if (taskText.includes("Plan website implementation tasks")) {
          return {
            run: {
              id: "run-plan",
              status: "completed" as const,
              result: JSON.stringify({
                tasks: [
                  { id: "fe-task", title: "Build hero component", role: "frontend", depends_on: [], paths: ["src/Hero.tsx"] },
                  { id: "seo-task", title: "Add sitemap", role: "seo", depends_on: [], paths: ["public/sitemap.xml"] },
                  { id: "qa-task", title: "Verify preview and tests", role: "qa", depends_on: ["fe-task", "seo-task"], paths: [] },
                ],
              }),
            } as any,
          };
        }
        if (taskText.includes("Review this project implementation")) {
          return {
            run: {
              id: "run-qa",
              status: "completed" as const,
              result: JSON.stringify({ issues: [] }),
            } as any,
          };
        }
        // Implementation tasks write file
        if (taskText.includes("Role: frontend")) {
          await workspace.createFile(ctxA, company.id, project.id, "src/Hero.tsx", "export const Hero = () => <h1>Hero</h1>;", undefined, frontendAgent.id);
          return {
            run: { id: "run-fe", status: "completed" as const, result: "Hero created" } as any,
          };
        }
        if (taskText.includes("Role: seo")) {
          await workspace.createFile(ctxA, company.id, project.id, "public/sitemap.xml", "<urlset></urlset>", undefined, seoAgent.id);
          return {
            run: { id: "run-seo", status: "completed" as const, result: "Sitemap created" } as any,
          };
        }
        return {
          run: { id: "run-default", status: "completed" as const, result: "OK" } as any,
        };
      },
    } as any;

    let previewStarted = false;
    const mockPreview: ProjectPreviewService = {
      startPreview: async () => {
        previewStarted = true;
        return { previewUrl: "http://localhost:3000", port: 3000, status: "ready" } as any;
      },
      stopPreview: async () => ({ status: "stopped" } as any),
      getPreviewStatus: async () => ({ status: "ready" } as any),
    } as any;

    const multiAgent = new ProjectMultiAgentService(
      store,
      mockRuntime,
      mockPreview,
      undefined,
      gitService,
      workspace,
      { worktreeMode: true }
    );

    const result = await multiAgent.execute(
      ctxA,
      company.id,
      project.id,
      "Build a modern SaaS landing page",
      undefined,
      "idemp-wt-test"
    );

    expect(result).toBeDefined();
    expect(result?.run.status).toBe("completed");
    expect(previewStarted).toBe(true);

    // Check events emitted
    const details = await store.getCompanyAgentRun(ctxA, company.id, result!.run.id);
    const eventKeys = details.backgroundEvents.map((e) => e.eventKey);

    expect(eventKeys.some((k) => k.startsWith("project-worktree:"))).toBe(true);
    expect(eventKeys.some((k) => k.startsWith("project-review:"))).toBe(true);
    expect(eventKeys.some((k) => k.startsWith("project-merge:"))).toBe(true);
    expect(eventKeys.some((k) => k.startsWith("project-build:"))).toBe(true);

    // Verify all worktrees were cleaned up at the end of the run
    const remainingWorktrees = await gitService.listAgentWorktrees(ctxA, company.id, project.id);
    expect(remainingWorktrees.length).toBe(0);
  });
});
