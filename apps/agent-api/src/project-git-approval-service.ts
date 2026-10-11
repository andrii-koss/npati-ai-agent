import path from "node:path";
import type { AuthContext, Project } from "@npati/workspace";
import { gitApprovalPayload, normalizeGitBranch, type GitWriteIntent } from "./code-git-write-policy";
import { GitError } from "./project-git-service";
import type { GitRepositoryInspection, GitWriteApprovalRequest, ProjectGitBoundary } from "./project-git-service";

export interface ProjectGitApprovalHost {
  boundary?: ProjectGitBoundary
  currentBranch: (ctx: AuthContext, companyId: string, projectId: string, inspection?: GitRepositoryInspection) => Promise<string>
}

export async function requireGitWriteApproval(host: ProjectGitApprovalHost, ctx: AuthContext, companyId: string, projectId: string, binding: GitWriteIntent | { projectId: string; tool: string; payload: Record<string, unknown> }, toolName: string, approval?: GitWriteApprovalRequest): Promise<void> {
    const port = host.boundary?.approvals;
    if (!port) {
      throw new GitError(
        "GIT_APPROVAL_UNAVAILABLE",
        "Git write approval verification is not configured; the remote write is refused",
        503,
      );
    }
    if (!approval?.approvalId) {
      throw new GitError(
        "GIT_APPROVAL_RECORD_REQUIRED",
        "A remote git write requires an approved Company run: the approval record is missing and the `approved` flag alone is not proof",
        403,
      );
    }
    /**
     * C11 (owner decision 5, corrected): the tool id inside the payload is the one the **record** was created
     * under, because that is the name the request side hashed and the name `consumeApproved` matches on. For
     * a push the request side is `code.git.push` (the tool the runtime gated), not this service's historical
     * `project.git.push`; rebuilding the payload under the wrong name produced a different hash and made every
     * record unredeemable. A record without a name cannot get here (`GIT_APPROVAL_RECORD_REQUIRED` above), and
     * the caller-supplied name is only a fallback so a hand-built caller keeps working.
     */
    const recordTool = approval?.toolName?.trim() || toolName;
    const inputPayload = "payload" in binding
      ? binding.payload
      : gitApprovalPayload({ projectId, tool: recordTool, intent: binding });
    try {
      await port.consumeApproved(ctx, companyId, approval.approvalId, {
        runId: approval.runId ?? "",
        agentId: approval.agentId ?? "",
        toolName: recordTool,
        inputPayload,
      });
    } catch (error) {
      const code = String((error as { code?: string }).code ?? "GIT_APPROVAL_INVALID");
      throw new GitError(
        code,
        "The approval record does not authorise this git write (status, single use, expiry and payload hash are all verified)",
        403,
      );
    }
  }

export async function resolveWriteIntent(host: ProjectGitApprovalHost, ctx: AuthContext, companyId: string, projectId: string, project: Project, namedBranch: string | undefined, force: boolean, credentialId?: string, namedSourceBranch?: string, inspection?: GitRepositoryInspection): Promise<GitWriteIntent> {
    const target = namedBranch || await host.currentBranch(ctx, companyId, projectId, inspection);
    const branch = normalizeGitBranch(target);
    if (!branch || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(branch) || branch.includes("..") || branch.includes("@{")) {
      throw new GitError("INVALID_BRANCH_NAME", "Invalid branch name", 400);
    }
    /**
     * C11: the local branch is the target unless the caller named a different one. When it did, the source
     * is normalised the same way and validated the same way — the two are separate fields of the intent
     * because the approval hash covers both, and the refspec below is built from both.
     */
    const source = namedSourceBranch ? normalizeGitBranch(namedSourceBranch) : branch;
    if (!source || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(source) || source.includes("..") || source.includes("@{")) {
      throw new GitError("INVALID_BRANCH_NAME", "Invalid branch name", 400);
    }
    return {
      gitOperation: force ? "force_push" : "push",
      sourceBranch: source,
      targetBranch: branch,
      remoteBranch: branch,
      // The configured URL is credential-free by construction (`connectRepository` refuses a URL that
      // carries a user or a password), so no secret can enter the approval payload through it.
      remote: project.repositoryUrl ?? null,
      force,
      credentialId: credentialId ?? null,
      // C11 (owner decision 13): the resolved fact, from the read-only inspection — never from an argument.
      // `gitApprovalPayload` writes it into the payload only when it is `false`.
      ...(inspection ? { repositoryInitialized: inspection.initialized } : {}),
    };
  }

