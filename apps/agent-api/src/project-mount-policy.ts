import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { mountedFolderPathKey, type MountedFolderMode } from "@npati/workspace";

/**
 * C15 — the **mounted local folder** policy: what may become a project's canonical workspace.
 *
 * A mounted folder is a directory on the runner's host that the owner/admin of one Company names explicitly.
 * It is the only place in this product where a container is given a path from outside the managed workspace
 * root, so this module exists to make that decision one function instead of a habit spread over the API, the
 * workspace provider and the sandbox runner.
 *
 * The rules, and why each one is here rather than only at the API boundary:
 *
 *  - **Explicit allowlist.** The folder must live inside one of the operator-configured roots
 *    (`NPATI_MOUNTED_FOLDER_ROOTS`). An empty configuration allows nothing — "we did not configure this" must
 *    read as "no", never as "anywhere".
 *  - **realpath + lstat on every component.** A symlink (or, on Windows, a *junction*, which `lstat` reports
 *    as an ordinary directory) anywhere along the path would make the validated path and the opened path two
 *    different things. Every segment must be a real directory that is not a link, and the resolved path must
 *    equal the requested one: that second check is what catches a junction, which `lstat` cannot see.
 *  - **Protected locations.** The filesystem root, the home directory, the NPATI data root and the managed
 *    workspace root are refused, and so is a folder that *contains* one of them — mounting `C:\Users` would
 *    hand the sandbox the data root one level down, which no amount of path comparison would catch later.
 *  - **No loop.** Mounting anything inside the managed `project-workspaces` root would make the workspace
 *    contain itself (and the "no second writer" invariant unprovable), so it is refused by name.
 *
 * The same function runs at the API boundary (when a folder is confirmed) **and** in the sandbox runner
 * immediately before `docker create`. That second call is not belt-and-braces: between the confirmation and
 * the container creation the path can be replaced by a symlink, and a client can simply have sent another path
 * than the one on file. The runner re-reads the allowlist itself and re-runs these checks, so the decision is
 * made at the only moment it can be true.
 *
 * `mount_target_is_workspace` also lives here: the container target is not caller-chosen. Only `/workspace`
 * is accepted, so a request cannot ask for a mount at `/`, `/etc` or over the docker socket path.
 */

export class ProjectMountError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`);
    this.name = "ProjectMountError";
  }
}

/** The only container path a mounted folder may be exposed at. */
export const MOUNTED_FOLDER_TARGET = "/workspace";

/** Operator-configured roots a mounted folder may come from. Empty means "nothing may be mounted". */
export function mountedFolderRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.NPATI_MOUNTED_FOLDER_ROOTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
}

/** Case-folded, separator-normalised comparison key; one definition for the API and the runner. */
export function mountPathKey(value: string): string {
  return mountedFolderPathKey(value);
}

/** `target` is `root` itself or lives below it. */
export function isInsideMountRoot(target: string, root: string): boolean {
  const targetKey = mountPathKey(target);
  const rootKey = mountPathKey(root);
  if (!rootKey) return false;
  return targetKey === rootKey || targetKey.startsWith(`${rootKey}/`);
}

export interface MountValidationInput {
  /** The path as requested. May be a symlink, a junction, a relative path or nonsense — this is untrusted input. */
  candidate: string;
  /** Operator allowlist. A folder outside every root is refused. */
  roots: readonly string[];
  /** Directories that may never be mounted and may never be *contained* by a mount (data root, managed root). */
  protectedRoots?: readonly string[];
  /** The managed workspace root; a folder inside it is a loop and refused by name. */
  projectWorkspacesRoot?: string;
  /** Overridable for tests; production uses the real filesystem. */
  realpathImpl?: (value: string) => Promise<string>;
  lstatImpl?: (value: string) => Promise<MountPathEntry>;
}

/** The two `Stats` questions this policy asks, so a test can supply them without a filesystem. */
export interface MountPathEntry {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface MountValidationFacts {
  /** The resolved canonical path — what must be stored in the allowlist and compared against on every use. */
  canonicalPath: string;
  /** The allowlist root the folder matched, for the audit trail. */
  matchedRoot: string;
}

function normalizedSegments(value: string): string[] {
  return value.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0);
}

/**
 * Validates a candidate mounted folder and returns its canonical path.
 *
 * Throws `ProjectMountError` with a precise code; it never "cleans up" a hostile path and continues, because a
 * silently normalised path is a path the caller did not choose.
 */
export async function validateMountedFolder(input: MountValidationInput): Promise<MountValidationFacts> {
  const candidate = input.candidate;
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 1024 || candidate.includes("\0")) {
    throw new ProjectMountError("mounted_folder_invalid_path", "A mounted folder path is required and must be a plain absolute path");
  }
  const resolveImpl = input.realpathImpl ?? realpath;
  const statImpl = input.lstatImpl ?? lstat;

  const requested = path.resolve(candidate);
  if (!path.isAbsolute(requested)) {
    throw new ProjectMountError("mounted_folder_invalid_path", "A mounted folder must be an absolute path");
  }
  // Checked on the **raw** candidate: `path.resolve` collapses `..` segments, so a check after resolving would
  // never fire and would be a decorative rule.
  if (normalizedSegments(candidate.replace(/\\/g, "/")).includes("..")) {
    throw new ProjectMountError("mounted_folder_invalid_path", "A mounted folder path may not contain a traversal segment");
  }

  // Every component from the root down: a real directory, never a link. `lstat` is what tells the two apart;
  // a missing component is reported as "not found" rather than as "unsafe", so an operator can tell a typo
  // from an attack.
  const root = path.parse(requested).root;
  const relativeParts = normalizedSegments(requested.slice(root.length));
  let current = root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    let entry: MountPathEntry;
    try {
      entry = await statImpl(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProjectMountError("mounted_folder_not_found", "The mounted folder does not exist", 404, { path: current });
      }
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new ProjectMountError("symlink_escape", "A mounted folder may not contain a symlink", 403, { path: current });
    }
    if (!entry.isDirectory()) {
      throw new ProjectMountError("mounted_folder_not_a_directory", "A mounted folder must be a directory", 400, { path: current });
    }
  }

  // The junction (and, on any platform, the bind-mount-shaped) case: `lstat` cannot distinguish it, so the
  // resolved path is compared with the requested one and a disagreement is treated as an escape.
  const resolved = await resolveImpl(requested);
  if (mountPathKey(resolved) !== mountPathKey(requested)) {
    throw new ProjectMountError("symlink_escape", "The mounted folder resolves to a different path than requested", 403, {
      requested, resolved,
    });
  }
  const canonicalPath = resolved;

  const forbiddenExact: Array<{ value: string; code: string; label: string }> = [
    { value: path.parse(canonicalPath).root, code: "mounted_folder_forbidden_root", label: "filesystem_root" },
    { value: homedir(), code: "mounted_folder_forbidden_root", label: "home_directory" },
  ];
  for (const forbidden of forbiddenExact) {
    if (forbidden.value && mountPathKey(canonicalPath) === mountPathKey(path.resolve(forbidden.value))) {
      throw new ProjectMountError(forbidden.code, `The ${forbidden.label} may not be mounted`, 403, { path: canonicalPath, forbidden: forbidden.label });
    }
  }

  const protectedRoots = [...(input.protectedRoots ?? [])].filter((value) => Boolean(value));
  if (input.projectWorkspacesRoot) protectedRoots.push(input.projectWorkspacesRoot);
  for (const protectedRoot of protectedRoots) {
    const absolute = path.resolve(protectedRoot);
    if (isInsideMountRoot(canonicalPath, absolute)) {
      throw new ProjectMountError(
        "mounted_folder_inside_protected_root",
        "A mounted folder may not live inside the managed workspace or the data root",
        403,
        { path: canonicalPath, protectedRoot: absolute },
      );
    }
    // The reverse direction: a mount that *contains* a protected root would expose it one level down.
    if (isInsideMountRoot(absolute, canonicalPath) && mountPathKey(absolute) !== mountPathKey(canonicalPath)) {
      throw new ProjectMountError(
        "mounted_folder_contains_protected_root",
        "Mounted folder contains the managed workspace or the data root, so it cannot be mounted",
        403,
        { path: canonicalPath, protectedRoot: absolute },
      );
    }
  }

  if (input.roots.length === 0) {
    throw new ProjectMountError(
      "mounted_folder_roots_unconfigured",
      "No mounted-folder roots are configured, so no local folder may be mounted",
      403,
    );
  }
  const matched: string[] = [];
  for (const allowedRoot of input.roots) {
    const absoluteRoot = path.resolve(allowedRoot);
    // The root is canonicalised too: a root spelled through a link must match its own real target, otherwise
    // the containment test would compare two different names for the same directory.
    const canonicalRoot = await resolveImpl(absoluteRoot).catch(() => absoluteRoot);
    if (isInsideMountRoot(canonicalPath, canonicalRoot)) matched.push(canonicalRoot);
  }
  if (matched.length === 0) {
    throw new ProjectMountError("mounted_folder_not_allowlisted", "The folder is outside every configured mounted-folder root", 403, {
      path: canonicalPath,
    });
  }
  const matchedRoot = matched.reduce((longest, entry) => (entry.length > longest.length ? entry : longest), matched[0] ?? canonicalPath);
  return { canonicalPath, matchedRoot };
}

/**
 * The container target of a mount is **not** caller-chosen: only `/workspace` is accepted, so a request can
 * never ask for the host's `/`, `/etc` or the docker socket path.
 */
export function assertMountTarget(target: unknown): string {
  if (target !== MOUNTED_FOLDER_TARGET) {
    throw new ProjectMountError("mount_target_denied", `A mounted folder may only be exposed at ${MOUNTED_FOLDER_TARGET}`, 400, { target: String(target) });
  }
  return MOUNTED_FOLDER_TARGET;
}
