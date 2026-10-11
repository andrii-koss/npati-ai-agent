import { rm } from "node:fs/promises";
import path from "node:path";
import type { AuthContext } from "@npati/workspace";

export interface ProjectGitCleanupHost {
  runGit: (dir: string, args: string[], env?: Record<string, string>) => Promise<{ stdout: string; stderr: string }>
  requireWrite: (ctx: AuthContext) => void
  ensureRepository: (ctx: AuthContext, companyId: string, projectId: string) => Promise<string>
}

export async function cleanupAllWorktrees(host: ProjectGitCleanupHost, ctx: AuthContext, companyId: string, projectId: string): Promise<{ cleanedCount: number }> {
    host.requireWrite(ctx);
    const dir = await host.ensureRepository(ctx, companyId, projectId);
    let cleanedCount = 0;

    try {
      const { stdout } = await host.runGit(dir, ["worktree", "list", "--porcelain"]);
      const lines = stdout.split(/\r?\n/);
      const wtBase = path.resolve(path.join(dir, ".worktrees"));

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          const wtPath = path.resolve(line.slice(9).trim());
          if (wtPath.startsWith(wtBase + path.sep)) {
            try {
              await host.runGit(dir, ["worktree", "remove", "--force", wtPath]);
              cleanedCount++;
            } catch {}
            await rm(wtPath, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }
    } catch {}

    await host.runGit(dir, ["worktree", "prune"]).catch(() => undefined);
    await rm(path.join(dir, ".worktrees"), { recursive: true, force: true }).catch(() => undefined);

    return { cleanedCount };
  }

