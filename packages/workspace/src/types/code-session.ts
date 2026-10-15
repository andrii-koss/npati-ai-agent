import type { DataClassification, RetentionClass } from "./retention";

export type CodeSessionMode = "plan" | "edit" | "auto" | "full_auto";export const CODE_SESSION_MODES: readonly CodeSessionMode[] = ["plan", "edit", "auto", "full_auto"] as const;
export type CodeSessionStatus = "active" | "paused" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "archived" | "suspended_by_flag";
export const CODE_SESSION_STATUSES: readonly CodeSessionStatus[] = ["active", "paused", "awaiting_approval", "completed", "failed", "cancelled", "archived", "suspended_by_flag"] as const;

/**
 * A code session is the unit the CodingAgentRunner will drive in C6. It deliberately links to the
 * existing company Run instead of duplicating run state, and carries the classification and
 * retention fields required by rule 18.
 */
export interface CodeSession {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  userId: string;
  agentId?: string | null;
  mode: CodeSessionMode;
  modelProfile?: string | null;
  status: CodeSessionStatus;
  parentSessionId?: string | null;
  /** Existing company run driving this session (C6); null until a run is attached. */
  runId?: string | null;
  summary?: string | null;
  /** Set when the session finishes and drives History (C7). */
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
  /** C1a fills this with the set of code.* tool versions the session was created with. */
  toolManifestVersion?: number | null;
  /** C5: bumped on every update; the optimistic token for user-driven mode changes. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * C5: explicit trust for a project's own instructions (README/NPATI.md/AGENTS.md and any workspace
 * file). Trust is granted only by an owner/admin, is audited, and never widens policy: it only allows
 * the repository's own instructions to guide the *content* of the work. Hard deny, session mode,
 * approvals, the tool list and the network allowlist stay outside its reach.
 */
export interface ProjectCodeTrust {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  trusted: boolean;
  trustedBy?: string | null;
  trustedAt?: string | null;
  revokedBy?: string | null;
  revokedAt?: string | null;
  reason?: string | null;
  revision: number;
  updatedAt: string;
}

export interface ProjectCodeTrustInput {
  trusted: boolean;
  actor: string;
  reason?: string;
  /** Optimistic concurrency token: must match the current record revision (0 for a first write). */
  expectedRevision: number;
}

/**
 * C15: a **mounted local folder** — the explicit, owner/admin-confirmed allowlist entry that makes one
 * directory outside the managed workspace root the canonical workspace of one project.
 *
 * Why this is a record rather than a column on `projects`: the folder is a *security decision* about the
 * deployment's host filesystem. It carries the actor and time of the confirmation, its own optimistic
 * `revision`, and a revocation; a column on `projects` would be rewritten by the product's own project
 * update path (so a `PATCH` could silently repoint a workspace at another directory) and would be invisible
 * to the sandbox runner, which must be able to re-read the allowlist **itself** — without trusting the API —
 * immediately before `docker create`.
 *
 * `mode` is the only writability statement there is: `rw` writes straight into the canonical folder, `ro` is
 * mounted `readonly` at the container level, so the refusal is a kernel/Docker fact and not only an API check.
 */
export interface ProjectMountedFolder {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  /** The canonical absolute path, as confirmed. Every use re-validates it (realpath + lstat). */
  path: string;
  mode: MountedFolderMode;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
  revokedBy?: string | null;
  revokedAt?: string | null;
  reason?: string | null;
  revision: number;
  updatedAt: string;
}

export type MountedFolderMode = "ro" | "rw";

export interface ProjectMountedFolderInput {
  /** The canonical absolute path the confirmation applies to; validated at the API boundary before the write. */
  path: string;
  mode: MountedFolderMode;
  /** Confirmed (`confirmedBy`/`confirmedAt`) or revoked (`revokedBy`/`revokedAt`). */
  confirmed: boolean;
  actor: string;
  reason?: string;
  /** Optimistic concurrency token: must match the current record revision (0 for a first write). */
  expectedRevision: number;
}

export interface CodeSessionInput {
  /** Internal deterministic child-session identity; never accepted by public session routes. */
  childKey?: string;
  mode?: CodeSessionMode;
  agentId?: string;
  modelProfile?: string;
  parentSessionId?: string;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  summary?: string;
}

