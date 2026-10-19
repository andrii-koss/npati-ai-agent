import type { AuthContext, Project } from "@npati/workspace";
import type { GitWriteIntent } from "./code-git-write-policy";
import type { CodeWorkspaceRevisionSnapshot, WorkspaceRevisionPhase } from "./code-workspace-revision";
import { GitError, redactSecrets } from "./project-git-shared";

export interface GitStatusResult {
  branch: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export interface GitBranchResult {
  current: string;
  branches: string[];
}

export interface GitRepositoryInspection {
  project: Project;
  dir: string;
  initialized: boolean;
  branch: string | null;
}

export interface ProjectGitRevisionPort {
  capture(scope: { ctx: AuthContext; companyId: string; projectId: string }): Promise<CodeWorkspaceRevisionSnapshot>;
  assertUnchanged(
    scope: { ctx: AuthContext; companyId: string; projectId: string },
    snapshot: CodeWorkspaceRevisionSnapshot,
    phase: WorkspaceRevisionPhase,
  ): Promise<unknown>;
}

export interface GitWriteApprovalRequest {
  approvalId: string;
  runId: string;
  agentId: string;
  toolName: string;
}

export interface GitApprovalPort {
  consumeApproved(
    ctx: AuthContext,
    companyId: string,
    approvalId: string,
    params: { runId: string; agentId: string; toolName: string; inputPayload: Record<string, unknown> },
  ): Promise<unknown>;
}

export interface HostGitCredentialLease {
  leaseId: string;
  value: string;
}

export interface HostGitCredentialPort {
  acquire(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    credentialId: string;
    toolCallId: string;
    purpose: "git.push" | "pull_request.create" | "pull_request.comment";
  }): Promise<HostGitCredentialLease>;
  revoke(leaseId: string, reason: string): Promise<void>;
}

export interface ProjectGitBoundary {
  /** Same canonical coordinator as File Tools; not a separate Git lock. */
  withFileLease?: NonNullable<import("./project-workspace").ProjectWorkspace["withFileLease"]>;
  assertGitWriteAllowed?: (ctx: AuthContext, companyId: string, input: GitWriteIntent) => Promise<unknown>;
  approvals?: GitApprovalPort;
  credentials?: HostGitCredentialPort;
  workspaceRevisions?: ProjectGitRevisionPort;
}

export interface CheckpointThresholds {
  fileThreshold: number;
  lineThreshold: number;
}

export const defaultCheckpointThresholds: CheckpointThresholds = {
  fileThreshold: 5,
  lineThreshold: 200,
};

export function safeAgentSlug(slug: string): string {
  if (typeof slug !== "string" || !slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new GitError("INVALID_AGENT_SLUG", "Invalid agent slug for worktree", 400);
  }
  const clean = slug.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  if (!clean || clean === "." || clean === "..") throw new GitError("INVALID_AGENT_SLUG", "Invalid agent slug for worktree", 400);
  return clean;
}

export { redactSecrets as redactGitSecrets };
