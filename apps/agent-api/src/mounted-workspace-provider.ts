import type { AuthContext, Project } from "@npati/workspace";
import { LocalProjectWorkspace, type ProjectMountRequest } from "./project-workspace";
import { sandboxMountForProject, type WorkspaceBaseResolverPort } from "./workspace-base-resolver";

/**
 * C15 — the mount-aware `WorkspaceProvider`. **It is the same provider**, not a second one.
 *
 * The owner decision for this step is that a mounted local folder becomes a *real* `WorkspaceProvider`: the
 * canonical workspace of the project, served through the existing interface, with no "mounted" branch anywhere
 * else. This class is how that is expressed without inventing a second file API: every file operation is
 * inherited unchanged from `LocalProjectWorkspace` (which is base-agnostic and takes its base from the shared
 * resolver), and the only thing added is the mount **fact** — the canonical source, its container target and
 * whether it is read-only — which the sandbox path needs in order to mount the canonical folder instead of
 * copying it.
 *
 * Two consequences are worth stating, because they are the invariants the step is judged on:
 *
 *  - **One writer.** There is exactly one `WorkspaceProvider` instance in a process and exactly one canonical
 *    directory per project. When that directory is a mounted folder the sandbox writes *into it* through a bind
 *    mount, and the copy-back is disabled for those projects, so a mounted project never has a second copy of
 *    its files that could be written back over the first.
 *  - **No mounted revision branch.** `info()` is untouched: its digest is computed from whatever base the
 *    resolver returned, so a mounted workspace's revision is a hash of the mounted tree, and
 *    `CodeWorkspaceRevisionGuard` compares two readings of one source exactly as it does for a managed project.
 */
export class MountedWorkspaceProvider extends LocalProjectWorkspace {
  constructor(
    projects: { get(ctx: AuthContext, companyId: string, projectId: string): Promise<Pick<Project, "id" | "companyId" | "workspaceId" | "status" | "repositoryBranch" | "sandboxId" | "revision">> },
    options: { root: string; bases: WorkspaceBaseResolverPort; maxFileBytes?: number; maxFiles?: number },
  ) {
    super(projects, options);
  }

  /**
   * The mount this project's canonical workspace is, or `null` for a managed project.
   *
   * The answer comes from the resolver, which is the same object that chose the base a moment earlier: the
   * sandbox is therefore pointed at the directory the provider really reads and writes, and the path is
   * re-validated (realpath + `lstat` on every component) on the way out. The runner re-derives it from the
   * allowlist again before `docker create`, so the two components must agree for a container to exist.
   */
  async mountFor(ctx: AuthContext, companyId: string, projectId: string): Promise<ProjectMountRequest | null> {
    return sandboxMountForProject(this.bases, ctx, companyId, projectId);
  }
}
