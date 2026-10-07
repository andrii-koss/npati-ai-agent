/**
 * C11 (owner decision 7) — one canonical revision for the canonical workspace, and fail closed when the
 * execution environment cannot be proven to have received it.
 *
 * The rule this module implements:
 *
 *   `Project` / `WorkspaceProvider` is the **canonical state**. A sandbox is an **execution environment**,
 *   never a second source of truth. A git operation and a build/test therefore have to be able to prove
 *   that they acted on the *same* canonical revision — and when that cannot be proven, the answer is
 *   `workspace_revision_mismatch` (fail closed), not "probably fine".
 *
 * How a proof is possible at all: the canonical revision is a content digest
 * (`ProjectWorkspace.info().currentRevision`, a hash over the workspace's file set), so it moves exactly
 * when the stored bytes move. A consumer captures the revision it was authorised against and asserts,
 * immediately before the side effect, that the canonical revision has not moved since. Two moments are
 * covered:
 *
 *  - **before a build/test command leaves** — the tool runtime captures the revision when it authorises
 *    the call, and the single sandbox transport re-reads it before dispatching. A command that would run
 *    against a workspace nobody authorised is refused rather than run against stale bytes;
 *  - **before a git operation** — the same capture, re-checked in the git executor. A commit or a push
 *    prepared from revision R1 while the canonical workspace is at R2 is refused, because "which bytes did
 *    this commit contain" would otherwise be unanswerable.
 *
 * The ledger also records the revision the sandbox was **given** (`recordSandboxBinding`), so the answer to
 * "what did the build actually see" is a stored fact rather than a reconstruction. It is a record, not a
 * second source of truth: it is never compared against a sandbox-side revision, because the sandbox has no
 * revision of its own to compare — the canonical digest is the only one there is.
 */

import type { AuthContext } from "@npati/workspace";
import { WORKSPACE_REVISION_MISMATCH } from "./code-git-workflow";

export interface CodeWorkspaceRevisionSnapshot {
  revision: string;
  /** The branch the canonical workspace is on, when the reader can establish it. */
  branch: string | null;
  capturedAt: number;
}

/** The canonical revision reader. Implemented over `ProjectWorkspace.info` in the application. */
export interface CodeWorkspaceRevisionPort {
  read(input: { ctx: AuthContext; companyId: string; projectId: string }): Promise<{ currentRevision: string; currentBranch: string | null } | null>;
}

export interface CodeWorkspaceRevisionScope {
  ctx: AuthContext;
  companyId: string;
  projectId: string;
  sessionId?: string | null;
}

/** Which side of the boundary was about to act when the revision moved. */
export type WorkspaceRevisionPhase = "sandbox_exec" | "sandbox_process" | "git_commit" | "git_push" | "git_write";

export class CodeWorkspaceRevisionError extends Error {
  readonly code = WORKSPACE_REVISION_MISMATCH;
  readonly httpStatus = 409;

  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly retryable = true,
  ) {
    super(`[${WORKSPACE_REVISION_MISMATCH}] ${message}`);
    this.name = "CodeWorkspaceRevisionError";
  }
}

export interface SandboxRevisionBinding {
  revision: string;
  boundAt: number;
  phase: WorkspaceRevisionPhase;
}

function scopeKey(scope: CodeWorkspaceRevisionScope): string {
  return `${scope.companyId}:${scope.projectId}:${scope.sessionId ?? "-"}`;
}

/**
 * Captures the canonical revision a call was authorised against and refuses, later, to let a side effect
 * run once the canonical revision has moved.
 *
 * The reader is a port so this module stays free of the workspace implementation, and a reader that throws
 * or answers `null` is **not** treated as "unchanged": an unprovable revision is exactly the case the
 * mismatch code exists for.
 */
export class CodeWorkspaceRevisionGuard {
  private readonly sandboxBindings = new Map<string, SandboxRevisionBinding>();

  constructor(private readonly port: CodeWorkspaceRevisionPort) {}

  /** The revision right now, or a fail-closed refusal when it cannot be read. */
  async capture(scope: CodeWorkspaceRevisionScope): Promise<CodeWorkspaceRevisionSnapshot> {
    let read: { currentRevision: string; currentBranch: string | null } | null = null;
    try {
      read = await this.port.read({ ctx: scope.ctx, companyId: scope.companyId, projectId: scope.projectId });
    } catch (error) {
      throw new CodeWorkspaceRevisionError(
        "The canonical workspace revision could not be read, so no consumer can prove which revision it acts on",
        { reason: "revision_unavailable", cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const revision = String(read?.currentRevision ?? "");
    if (!revision) {
      throw new CodeWorkspaceRevisionError(
        "The canonical workspace reported no revision, so no consumer can prove which revision it acts on",
        { reason: "revision_unavailable" },
      );
    }
    return { revision, branch: read?.currentBranch ?? null, capturedAt: Date.now() };
  }

  /**
   * Re-reads the canonical revision and refuses when it moved. `phase` names the side effect that was about
   * to happen, so the refusal says which boundary noticed.
   */
  async assertUnchanged(
    scope: CodeWorkspaceRevisionScope,
    snapshot: CodeWorkspaceRevisionSnapshot,
    phase: WorkspaceRevisionPhase,
  ): Promise<CodeWorkspaceRevisionSnapshot> {
    const current = await this.capture(scope);
    if (current.revision !== snapshot.revision) {
      throw new CodeWorkspaceRevisionError(
        `The canonical workspace moved from revision ${snapshot.revision.slice(0, 12)} to ${current.revision.slice(0, 12)} `
        + `before ${phase}; the operation is refused instead of acting on a revision nobody authorised`,
        {
          phase,
          expectedRevision: snapshot.revision,
          currentRevision: current.revision,
          expectedBranch: snapshot.branch,
          currentBranch: current.branch,
        },
      );
    }
    return current;
  }

  /** Records the exact revision handed to the execution environment, so "what did the build see" is stored. */
  recordSandboxBinding(scope: CodeWorkspaceRevisionScope, revision: string, phase: WorkspaceRevisionPhase): void {
    if (!revision) return;
    this.sandboxBindings.set(scopeKey(scope), { revision, boundAt: Date.now(), phase });
  }

  lastSandboxBinding(scope: CodeWorkspaceRevisionScope): SandboxRevisionBinding | null {
    return this.sandboxBindings.get(scopeKey(scope)) ?? null;
  }
}
