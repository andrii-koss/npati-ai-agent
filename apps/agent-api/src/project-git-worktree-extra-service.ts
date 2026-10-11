import { rm } from "node:fs/promises";
import path from "node:path";
import type { AuthContext } from "@npati/workspace";
import { branch } from "./project-git-repository-service";
import { safeAgentSlug } from "./project-git-service";

export interface ProjectGitWorktreeExtraHost {
  runGit: (dir: string, args: string[], env?: Record<string, string>) => Promise<{ stdout: string; stderr: string }>
  requireWrite: (ctx: AuthContext) => void
  ensureRepository: (ctx: AuthContext, companyId: string, projectId: string) => Promise<string>
  getAgentWorktreePath: (dir: string, agentSlug: string) => string
}

export async function diffAgentWorktree(host: ProjectGitWorktreeExtraHost, ctx: AuthContext, companyId: string, projectId: string, options: { agentSlug: string; baseBranch?: string }): Promise<{ diff: string; files: string[] }> {
    const dir = await host.ensureRepository(ctx, companyId, projectId);
    const slug = safeAgentSlug(options.agentSlug);
    const branch = `agent/${slug}`;
    const baseBranch = options.baseBranch ?? "project/main";

    const { stdout: namesOut } = await host.runGit(dir, ["diff", "--name-only", `${baseBranch}...${branch}`]);
    const files = namesOut.split(/\r?\n/).filter(Boolean);

    const { stdout: diffOut } = await host.runGit(dir, ["diff", "--no-ext-diff", `${baseBranch}...${branch}`]);
    return {
      diff: diffOut.slice(0, 128_000),
      files,
    };
  }

export async function removeAgentWorktree(host: ProjectGitWorktreeExtraHost, ctx: AuthContext, companyId: string, projectId: string, options: { agentSlug: string; deleteBranch?: boolean }): Promise<{ removed: boolean }> {
    host.requireWrite(ctx);
    const dir = await host.ensureRepository(ctx, companyId, projectId);
    const slug = safeAgentSlug(options.agentSlug);
    const wtDir = host.getAgentWorktreePath(dir, slug);

    try {
      await host.runGit(dir, ["worktree", "remove", "--force", wtDir]);
    } catch {}
    await host.runGit(dir, ["worktree", "prune"]).catch(() => undefined);
    await rm(wtDir, { recursive: true, force: true }).catch(() => undefined);

    if (options.deleteBranch) {
      await host.runGit(dir, ["branch", "-D", `agent/${slug}`]).catch(() => undefined);
    }

    return { removed: true };
  }

