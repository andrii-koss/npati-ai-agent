import type { ProjectMountedFolder } from "@npati/workspace";
import {
  MOUNTED_FOLDER_TARGET,
  ProjectMountError,
  mountPathKey,
  mountedFolderRoots,
  validateMountedFolder,
  type MountValidationInput,
} from "./project-mount-policy";
import { SandboxProviderError, type SandboxMount } from "./sandbox-provider";

/**
 * C15 — the **runner's own** mount gate.
 *
 * The API validates a mounted folder when an owner confirms it, and the workspace provider validates it again
 * on every resolution. Neither of those is enough for the component that actually calls `docker create`, for
 * one reason: the path is a *host* path, and between the confirmation and the container creation the directory
 * it names can be replaced by a symlink or a junction — while a caller who never went through the API at all
 * can simply post a path of their choosing to the runner's endpoint.
 *
 * So the runner does not check "did someone approve this": it reads the confirmed record for the project from
 * the database **itself** (`DATABASE_URL` is already configured on the runner for the image catalogue), and
 * validates *that* path — realpath plus `lstat` on every component, the protected-location rules and the
 * operator allowlist — immediately before the bind argument would be built. The requested path must agree with
 * the record; a disagreement is a refusal rather than a "closest match", because the only thing that could make
 * two paths different for the same project is that one of them is not the confirmed one.
 *
 * Two further facts are enforced here, both owner decisions:
 *
 *  - **Local runner only.** A host bind mount only makes sense where the runner runs beside the API on the same
 *    machine (`NPATI_SANDBOX_RUNNER_MODE=local`, which is also the only mode whose URL is allowed to be the
 *    internal `http://sandbox-runner:7865`). In `remote` mode the runner is on a separate host and the
 *    confirmed path refers to a filesystem it does not have, so a mount is refused outright.
 *  - **The mode is the record's, not the caller's.** `readOnly` must equal what was confirmed: an `rw` mount
 *    cannot be requested as `ro` and — the direction that matters — an `ro` confirmation cannot be widened by
 *    asking for a writable bind.
 */

export interface MountedFolderAllowlistPort {
  /**
   * The confirmed mounted folder of a project, read **without a user context**: the runner has no session, and
   * asking as a system identity is what makes this read independent of the API. `null` for an unknown project
   * or an unavailable database, which is the fail-closed answer.
   */
  getConfirmed(companyId: string, projectId: string): Promise<ProjectMountedFolder | null>;
}

export interface SandboxMountGate {
  authorizeMount(input: { companyId: string; projectId: string; requested: SandboxMount }): Promise<SandboxMount>;
}

export interface RunnerMountGateOptions {
  allowlist?: MountedFolderAllowlistPort;
  /** Operator allowlist; defaults to `NPATI_MOUNTED_FOLDER_ROOTS`. */
  roots?: readonly string[];
  protectedRoots?: readonly string[];
  projectWorkspacesRoot?: string;
  /** `NPATI_SANDBOX_RUNNER_MODE`; anything but `local` refuses every mount. */
  runnerMode?: string;
  /** Test seam for the filesystem checks; production uses the real `realpath`/`lstat`. */
  validate?: (input: MountValidationInput) => Promise<{ canonicalPath: string; matchedRoot: string }>;
}

function refusal(code: string, message: string, status = 403): SandboxProviderError {
  return new SandboxProviderError(code, message, status, "sandbox.create", "project.terminal.exec");
}

function asRefusal(error: unknown): SandboxProviderError {
  if (error instanceof SandboxProviderError) return error;
  if (error instanceof ProjectMountError) return refusal(error.code, error.message, error.status);
  return refusal("mounted_folder_validation_failed", "The mounted folder could not be validated on the sandbox runner");
}

export class RunnerMountGate implements SandboxMountGate {
  private readonly roots: readonly string[];
  private readonly protectedRoots: readonly string[];
  private readonly validate: (input: MountValidationInput) => Promise<{ canonicalPath: string; matchedRoot: string }>;

  constructor(private readonly options: RunnerMountGateOptions) {
    this.roots = options.roots ?? mountedFolderRoots();
    this.protectedRoots = options.protectedRoots ?? [];
    this.validate = options.validate ?? validateMountedFolder;
  }

  async authorizeMount(input: { companyId: string; projectId: string; requested: SandboxMount }): Promise<SandboxMount> {
    const { requested } = input;
    const mode = this.options.runnerMode ?? process.env.NPATI_SANDBOX_RUNNER_MODE ?? "remote";
    if (mode !== "local") {
      throw refusal("mounted_folder_requires_local_runner", "A mounted local folder is only available on a local sandbox runner");
    }
    // The target is re-checked here as well: what arrives is untrusted input, not a decision.
    if (requested.target !== MOUNTED_FOLDER_TARGET) {
      throw refusal("mount_target_denied", `A mounted folder may only be exposed at ${MOUNTED_FOLDER_TARGET}`, 400);
    }
    const allowlist = this.options.allowlist;
    if (!allowlist) {
      throw refusal("mounted_folder_allowlist_unavailable", "The sandbox runner cannot read the mounted-folder allowlist, so no host folder can be mounted");
    }
    const record = await allowlist.getConfirmed(input.companyId, input.projectId).catch(() => null);
    if (!record || record.revokedAt || !record.confirmedAt) {
      throw refusal("mounted_folder_not_confirmed", "This project has no confirmed mounted folder");
    }
    if (mountPathKey(record.path) !== mountPathKey(requested.source)) {
      throw refusal("mounted_folder_path_mismatch", "The requested folder is not the folder confirmed for this project");
    }
    const readOnly = record.mode === "ro";
    if (requested.readOnly !== readOnly) {
      throw refusal("mounted_folder_mode_mismatch", `This project's mounted folder is confirmed as ${record.mode}`);
    }
    try {
      const facts = await this.validate({
        candidate: record.path,
        roots: this.roots,
        protectedRoots: this.protectedRoots,
        ...(this.options.projectWorkspacesRoot ? { projectWorkspacesRoot: this.options.projectWorkspacesRoot } : {}),
      });
      // The validated canonical path is what is mounted; it must still be the confirmed spelling, otherwise the
      // record and the directory it names have diverged since the confirmation.
      if (mountPathKey(facts.canonicalPath) !== mountPathKey(record.path)) {
        throw refusal("mounted_folder_path_changed", "The mounted folder no longer resolves to the confirmed path");
      }
      return { source: facts.canonicalPath, target: MOUNTED_FOLDER_TARGET, readOnly };
    } catch (error) {
      throw asRefusal(error);
    }
  }
}
