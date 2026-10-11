import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AuthContext, Project } from "@npati/workspace";
import { normalizeGitBranch, pullRequestApprovalPayload, type GitWriteIntent } from "./code-git-write-policy";
import { pullRequestCommentApprovalPayload } from "./code-git-workflow";
import { GitError, GitApprovalRequiredError } from "./project-git-service";
import type { GitWriteApprovalRequest, ProjectGitBoundary } from "./project-git-service";

export interface ProjectGitPullRequestHost {
  boundary?: ProjectGitBoundary
  resolveGithubCredential?: (ctx: AuthContext, companyId: string, credentialId: string) => Promise<string>
  getProjectPath: (ctx: AuthContext, companyId: string, projectId: string) => Promise<{ project: Project; dir: string }>
  requireGitWriteApproval: (ctx: AuthContext, companyId: string, projectId: string, binding: GitWriteIntent | { projectId: string; tool: string; payload: Record<string, unknown> }, toolName: string, approval?: GitWriteApprovalRequest) => Promise<void>
  requireWrite: (ctx: AuthContext) => void
  acquireCredential: (ctx: AuthContext, companyId: string, projectId: string, input: { credentialId?: string; purpose: "git.push" | "pull_request.create" | "pull_request.comment"; toolCallId: string }) => Promise<{ value: string; leaseId: string | null }>
}

export async function createPullRequest(host: ProjectGitPullRequestHost, ctx: AuthContext, companyId: string, projectId: string, options: {
      title: string;
      body?: string;
      base?: string;
      head?: string;
      credentialId?: string;
      approved?: boolean;
      /**
       * C11: the tool id the approval record was created under. It is part of the approval **payload**, so it
       * must be the same string on both sides — the requester (`code-tool-runtime`) names the tool it was
       * called with, and the boundary rebuilds the payload here. Defaulting to `project.git.pr` keeps every
       * existing caller (`company-tool-runtime`) byte-for-byte identical, and the `code.git.pr.create`
       * executor passes its own id, which is what makes the two hashes comparable.
       */
      toolName?: string;
      /** C11 (owner decision 5): the real approval record for this exact pull request. */
      approval?: GitWriteApprovalRequest;
    }): Promise<{ prNumber?: number; prUrl?: string; message: string }> {
    host.requireWrite(ctx);
    if (!options.approved) throw new GitApprovalRequiredError();
    const recordTool = options.toolName?.trim() || "project.git.pr";
    const { project } = await host.getProjectPath(ctx, companyId, projectId);
    if (!options.title?.trim()) throw new GitError("PR_TITLE_REQUIRED", "Pull Request title is required", 400);
    if (project.repositoryProvider !== "github" || !project.repositoryUrl) throw new GitError("REPOSITORY_NOT_CONNECTED", "Connect a GitHub repository first", 400);
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/.exec(project.repositoryUrl);
    if (!match) throw new GitError("INVALID_REPOSITORY_URL", "Invalid configured GitHub URL", 400);
    const base = normalizeGitBranch(options.base);
    const head = normalizeGitBranch(options.head);
    // C11 (owner decision 5): the approval for a pull request is bound to the (base, head) pair, so both
    // have to be named. An unnamed target would produce an approval that authorises "some pull request".
    if (!base || !head) {
      throw new GitError(
        "GIT_PR_TARGET_REQUIRED",
        "A pull request must name the branch it targets (`base`) and the branch under review (`head`); an approval cannot be bound to an unnamed target",
        400,
      );
    }
    for (const branch of [base, head]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(branch) || branch.includes("..") || branch.includes("@{")) {
        throw new GitError("INVALID_BRANCH_NAME", "Invalid branch name", 400);
      }
    }
    if (!options.credentialId || (!host.boundary?.credentials && !host.resolveGithubCredential)) {
      throw new GitError("CREDENTIAL_MISSING", "A Company vault credential reference is required", 400);
    }
    // C11 (owner decision 5): opening a pull request is the same class of remote write as a push (it
    // publishes a branch for review), so it needs the same proof — and its payload binds the (base, head)
    // pair and the remote, not "some pull request".
    await host.requireGitWriteApproval(
      ctx,
      companyId,
      projectId,
      {
        projectId,
        tool: recordTool,
        payload: pullRequestApprovalPayload({
          projectId, tool: recordTool, base, head, credentialId: options.credentialId,
        }),
      },
      recordTool,
      options.approval,
    );
    const credential = await host.acquireCredential(ctx, companyId, projectId, {
      credentialId: options.credentialId,
      purpose: "pull_request.create",
      toolCallId: options.approval?.approvalId ?? `git-pr:${projectId}:${randomUUID()}`,
    });
    const [, owner, repo] = match;
    let response: Response;
    try {
      response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${credential.value}`, "User-Agent": "NPATI-Agent-Website-Builder" },
        body: JSON.stringify({ title: options.title.trim(), body: options.body || "", base, head }),
      });
    } catch {
      throw new GitError("GITHUB_PR_FAILED", "GitHub pull request request failed", 502);
    } finally {
      if (credential.leaseId && host.boundary?.credentials) {
        await host.boundary.credentials.revoke(credential.leaseId, "call_finished").catch(() => undefined);
      }
    }
    if (!response.ok) throw new GitError("GITHUB_PR_FAILED", "GitHub rejected the pull request", response.status);
    const data = await response.json() as { number?: number; html_url?: string };
    return { prNumber: data.number, prUrl: data.html_url, message: `Pull Request #${data.number} created successfully.` };
  }

export async function commentOnPullRequest(host: ProjectGitPullRequestHost, ctx: AuthContext, companyId: string, projectId: string, options: {
      pullNumber: number;
      body: string;
      credentialId?: string;
      approved?: boolean;
      approval?: GitWriteApprovalRequest;
    }): Promise<{ commentId?: number; commentUrl?: string; pullNumber: number; message: string }> {
    host.requireWrite(ctx);
    if (!options.approved) throw new GitApprovalRequiredError();
    const { project } = await host.getProjectPath(ctx, companyId, projectId);
    if (project.repositoryProvider !== "github" || !project.repositoryUrl) throw new GitError("REPOSITORY_NOT_CONNECTED", "Connect a GitHub repository first", 400);
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/.exec(project.repositoryUrl);
    if (!match) throw new GitError("INVALID_REPOSITORY_URL", "Invalid configured GitHub URL", 400);
    const pullNumber = Number(options.pullNumber);
    if (!Number.isInteger(pullNumber) || pullNumber < 1 || pullNumber > 1_000_000) {
      throw new GitError("GIT_PR_NUMBER_REQUIRED", "A pull-request comment must name the pull request it belongs to", 400);
    }
    const body = String(options.body ?? "").trim();
    if (!body) throw new GitError("GIT_PR_COMMENT_BODY_REQUIRED", "A pull-request comment needs a body", 400);
    if (!options.credentialId || (!host.boundary?.credentials && !host.resolveGithubCredential)) {
      throw new GitError("CREDENTIAL_MISSING", "A Company vault credential reference is required", 400);
    }
    await host.requireGitWriteApproval(
      ctx,
      companyId,
      projectId,
      {
        projectId,
        tool: "code.git.pr.comment",
        payload: pullRequestCommentApprovalPayload({
          projectId, tool: "code.git.pr.comment", pullNumber, body, credentialId: options.credentialId,
        }),
      },
      "code.git.pr.comment",
      options.approval,
    );
    const credential = await host.acquireCredential(ctx, companyId, projectId, {
      credentialId: options.credentialId,
      purpose: "pull_request.comment",
      toolCallId: options.approval?.approvalId ?? `git-pr-comment:${projectId}:${randomUUID()}`,
    });
    const [, owner, repo] = match;
    let response: Response;
    try {
      response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${credential.value}`, "User-Agent": "NPATI-Agent-Website-Builder" },
        body: JSON.stringify({ body }),
      });
    } catch {
      throw new GitError("GITHUB_PR_COMMENT_FAILED", "GitHub pull request comment request failed", 502);
    } finally {
      if (credential.leaseId && host.boundary?.credentials) {
        await host.boundary.credentials.revoke(credential.leaseId, "call_finished").catch(() => undefined);
      }
    }
    if (!response.ok) throw new GitError("GITHUB_PR_COMMENT_FAILED", "GitHub rejected the pull request comment", response.status);
    const data = await response.json() as { id?: number; html_url?: string };
    return {
      commentId: data.id,
      commentUrl: data.html_url,
      pullNumber,
      message: `Comment posted on pull request #${pullNumber}.`,
    };
  }

