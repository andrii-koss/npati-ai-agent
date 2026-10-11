import path from "node:path";
import type { AuthContext } from "@npati/workspace";
import { status } from "./project-git-repository-service";
import { GitError } from "./project-git-service";
import type { GitStatusResult, GitLogEntry } from "./project-git-service";

export interface ProjectGitHistoryHost {
  runGit: (dir: string, args: string[], env?: Record<string, string>) => Promise<{ stdout: string; stderr: string }>
  requireWrite: (ctx: AuthContext) => void
  ensureRepository: (ctx: AuthContext, companyId: string, projectId: string) => Promise<string>
  assertSafeIndex: (dir: string) => Promise<void>
  status: (ctx: AuthContext, companyId: string, projectId: string) => Promise<GitStatusResult>
  stage: (ctx: AuthContext, companyId: string, projectId: string, files?: string[]) => Promise<{ staged: string[] }>
}

export async function log(host: ProjectGitHistoryHost, ctx: AuthContext, companyId: string, projectId: string, limit = 20): Promise<GitLogEntry[]> {
    const dir = await host.ensureRepository(ctx, companyId, projectId);
    const safeLimit = Math.max(1, Math.min(limit, 100));
    try {
      const { stdout } = await host.runGit(dir, ["log", `-n`, String(safeLimit), `--pretty=format:%H|%an|%ad|%s`]);
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      return lines.map((line) => {
        const [hash = "", author = "", date = "", ...msgParts] = line.split("|");
        return {
          hash,
          author,
          date,
          message: msgParts.join("|"),
        };
      });
    } catch {
      return [];
    }
  }

export async function commit(host: ProjectGitHistoryHost, ctx: AuthContext, companyId: string, projectId: string, options: { message: string; files?: string[]; stageAll?: boolean }): Promise<{ commitHash: string; message: string }> {
    host.requireWrite(ctx);
    const dir = await host.ensureRepository(ctx, companyId, projectId);
    if (!options.message || !options.message.trim()) {
      throw new GitError("COMMIT_MESSAGE_REQUIRED", "Commit message is required", 400);
    }
    if (options.stageAll || options.files) {
      await host.stage(ctx, companyId, projectId, options.files);
    }
    let st = await host.status(ctx, companyId, projectId);
    if (st.staged.length === 0) {
      await host.stage(ctx, companyId, projectId);
      st = await host.status(ctx, companyId, projectId);
    }
    await host.assertSafeIndex(dir);
    await host.runGit(dir, st.staged.length === 0 ? ["commit", "--allow-empty", "-m", options.message.trim()] : ["commit", "-m", options.message.trim()]);

    const { stdout } = await host.runGit(dir, ["rev-parse", "HEAD"]);
    const commitHash = stdout.trim();
    return { commitHash, message: options.message.trim() };
  }

