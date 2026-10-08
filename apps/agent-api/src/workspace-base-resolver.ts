import path from "node:path";
import type { AuthContext, MountedFolderMode, ProjectMountedFolder } from "@npati/workspace";
import { MOUNTED_FOLDER_TARGET, ProjectMountError, mountedFolderRoots, validateMountedFolder } from "./project-mount-policy";

/**
 * C15 — **the one resolver** that answers "where is this project's workspace".
 *
 * Before this module the answer existed twice: `LocalProjectWorkspace.access()` joined
 * `path.join(root, companyId, projectId)` and `ProjectGitService.resolveProjectWorkspace()` joined the very
 * same root a second time, in a different file, from a value passed in separately. Two joins of one value are
 * two sources of truth the moment anything can change the value — which is exactly what a mounted folder does.
 * Both consumers now read this object, so "the canonical workspace of this project" has one implementation.
 *
 * The resolver is also where the mount decision is **re-validated**, not remembered: a record in the allowlist
 * says a path was a real directory inside a configured root when an owner confirmed it. That statement is not
 * true forever — the path can be replaced by a symlink or a junction — so every resolution runs the same
 * validation the confirmation ran (`realpath` + `lstat` on every component), and a mount that no longer
 * passes is a **refusal**, never a silent fallback to the managed root: falling back would quietly point the
 * workspace somewhere else rather than telling anyone the workspace moved.
 *
 * The feature flag `code.mounted_folder` is read here, on the real path, with the caller's context. With the
 * flag off a project with a confirmed mount resolves to the ordinary managed root and carries no mount, so the
 * sandbox is created exactly as it was before this step.
 */

export interface WorkspaceBase {
  /** The absolute directory that is the canonical workspace. For a mount this is the user's own folder. */
  base: string;
  /** `true` when the canonical workspace must not be written to (an `ro` mount). */
  readOnly: boolean;
  /** `true` when `base` came from the mounted-folder allowlist rather than the managed root. */
  mounted: boolean;
  source: "managed" | "mounted";
}

/** The allowlist read the resolver needs. Both stores implement it; the store is the single writer. */
export interface MountedFolderLookup {
  lookup(ctx: AuthContext, companyId: string, projectId: string): Promise<ProjectMountedFolder | null>;
}

export interface MountedFolderFlagPort {
  isEnabled(ctx: AuthContext, flagKey: string, options?: { companyId?: string; userId?: string }): Promise<boolean>;
}

export interface WorkspaceBaseResolverPort {
  /** The managed root, for the callers that must reason about it (loop prevention, cleanup). */
  readonly managedRoot: string;
  resolve(ctx: AuthContext, companyId: string, projectId: string): Promise<WorkspaceBase>;
  /** The managed base without touching the allowlist — used by the mount-independent code paths. */
  managedBase(companyId: string, projectId: string): string;
  /**
   * The confirmed mounted path of a project, or `null` when it has none. Deliberately **not** flag-gated and
   * not filesystem-validated: it answers "did a human point this project at a folder", which is what the
   * removal path must know before it considers deleting anything. A revoked record is `null`, and an
   * unreadable allowlist is `null` too — nothing may be deleted because a lookup failed.
   */
  mountedSource(ctx: AuthContext, companyId: string, projectId: string): Promise<string | null>;
}

export interface ProjectWorkspaceBaseResolverOptions {
  root: string;
  mounts?: MountedFolderLookup;
  flags?: MountedFolderFlagPort;
  /** Operator allowlist; defaults to `NPATI_MOUNTED_FOLDER_ROOTS`. */
  roots?: readonly string[];
  /** Data root and any other directory a mount may not touch. */
  protectedRoots?: readonly string[];
}

export const MOUNTED_FOLDER_FLAG = "code.mounted_folder";

export class ProjectWorkspaceBaseResolver implements WorkspaceBaseResolverPort {
  readonly managedRoot: string;
  private readonly roots: readonly string[];
  private readonly protectedRoots: readonly string[];

  constructor(private readonly options: ProjectWorkspaceBaseResolverOptions) {
    this.managedRoot = path.resolve(options.root);
    this.roots = options.roots ?? mountedFolderRoots();
    this.protectedRoots = options.protectedRoots ?? [];
  }

  managedBase(companyId: string, projectId: string): string {
    return path.join(this.managedRoot, companyId, projectId);
  }

  async mountedSource(ctx: AuthContext, companyId: string, projectId: string): Promise<string | null> {
    const mounts = this.options.mounts;
    if (!mounts) return null;
    const record = await mounts.lookup(ctx, companyId, projectId).catch(() => null);
    if (!record || record.workspaceId !== ctx.workspaceId || record.revokedAt || !record.confirmedAt) return null;
    return record.path;
  }

  async resolve(ctx: AuthContext, companyId: string, projectId: string): Promise<WorkspaceBase> {
    const managed: WorkspaceBase = { base: this.managedBase(companyId, projectId), readOnly: false, mounted: false, source: "managed" };
    const mounts = this.options.mounts;
    const flags = this.options.flags;
    if (!mounts || !flags) return managed;
    // Fail closed on a flag store that throws: an unanswerable "is this enabled" is not "yes".
    const enabled = await flags.isEnabled(ctx, MOUNTED_FOLDER_FLAG, { companyId }).catch(() => false);
    if (!enabled) return managed;
    // An unreadable allowlist answers "no mount": that answer exposes no host path, and the project keeps the
    // managed root it had before this step — the same direction a missing flag takes.
    const record = await mounts.lookup(ctx, companyId, projectId).catch(() => null);
    if (!record || record.revokedAt || !record.confirmedAt) return managed;
    if (record.workspaceId !== ctx.workspaceId) return managed;
    // The record is a statement about a path that was safe when an owner confirmed it; it is not true forever.
    // The path is therefore re-validated here, on every resolution, and a mount that no longer passes throws —
    // it never falls back to the managed root, because a silent fallback would point the workspace somewhere
    // nobody chose instead of saying that the workspace moved.
    const facts = await validateMountedFolder({
      candidate: record.path,
      roots: this.roots,
      protectedRoots: this.protectedRoots,
      projectWorkspacesRoot: this.managedRoot,
    });
    return {
      base: facts.canonicalPath,
      readOnly: record.mode === "ro",
      mounted: true,
      source: "mounted",
    };
  }
}

/** The mount request one sandbox creation carries. Derived from the same record the resolver read. */
export interface ResolvedSandboxMount {
  source: string;
  target: string;
  readOnly: boolean;
  mode: MountedFolderMode;
}

/** A read-only resolver for the managed root, used where no allowlist exists (workers, tests). */
export function managedWorkspaceBaseResolver(root: string): WorkspaceBaseResolverPort {
  const resolved = path.resolve(root);
  return {
    managedRoot: resolved,
    managedBase: (companyId, projectId) => path.join(resolved, companyId, projectId),
    mountedSource: async () => null,
    resolve: async (_ctx, companyId, projectId) => ({ base: path.join(resolved, companyId, projectId), readOnly: false, mounted: false, source: "managed" }),
  };
}

/**
 * The mount a sandbox creation should carry for this project, or `null`.
 *
 * It is the resolver's answer and nothing else, so the path the API sends is the path the workspace provider
 * would use; the runner then re-derives it from the allowlist and refuses a disagreement. The target is fixed
 * (`/workspace`) because the workspace of one project is the workspace of one project — a caller-chosen target
 * would be an arbitrary host mount with extra steps.
 */
export async function sandboxMountForProject(
  resolver: WorkspaceBaseResolverPort,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
): Promise<ResolvedSandboxMount | null> {
  const base = await resolver.resolve(ctx, companyId, projectId);
  if (!base.mounted) return null;
  if (!path.isAbsolute(base.base)) throw new ProjectMountError("mounted_folder_invalid_path", "A mounted folder must be an absolute path", 403);
  return { source: base.base, target: MOUNTED_FOLDER_TARGET, readOnly: base.readOnly, mode: base.readOnly ? "ro" : "rw" };
}
