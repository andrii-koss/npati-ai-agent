import path from "node:path";
import type { AuthContext } from "@npati/workspace";
import { inspectRepository, branch } from "./project-git-repository-service";
import { push } from "./project-git-push-service";
import { GitError } from "./project-git-service";
import type { GitRepositoryInspection } from "./project-git-service";

export interface ProjectGitBranchHost {
  inspectRepository: (ctx: AuthContext, companyId: string, projectId: string) => Promise<GitRepositoryInspection>
}

export async function currentBranch(host: ProjectGitBranchHost, ctx: AuthContext, companyId: string, projectId: string, inspection?: GitRepositoryInspection): Promise<string> {
    const state = inspection ?? await host.inspectRepository(ctx, companyId, projectId);
    if (!state.initialized) {
      // A caller that names no branch cannot be answered from a repository that does not exist, and this is
      // the refusal that says so without creating one.
      throw new GitError(
        "repository_not_initialized",
        "The project workspace has no git repository yet, so the branch of its checkout cannot be resolved; name the branch explicitly",
        409,
        { requiresInitialization: true, repositoryInitialized: false, projectId, repositoryState: "uninitialized" },
      );
    }
    if (state.branch) return state.branch;
    // A detached HEAD (or an unreadable checkout) answers nothing usable, which is not a branch to push by
    // name: an unresolvable checkout is never a branch name to guess at.
    throw new GitError(
      "BRANCH_UNRESOLVED",
      "The branch of the project checkout could not be resolved; name the branch explicitly",
      409,
    );
  }

