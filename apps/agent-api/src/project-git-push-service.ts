import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AuthContext, Project } from "@npati/workspace";
import { gitApprovalPayload, type GitWriteIntent } from "./code-git-write-policy";
import type { CodeWorkspaceRevisionSnapshot } from "./code-workspace-revision";
import { requireGitWriteApproval, resolveWriteIntent } from "./project-git-approval-service";
import { ensureRepositoryInitialized, inspectRepository, branch } from "./project-git-repository-service";
import { GitError, GitApprovalRequiredError } from "./project-git-service";
import type { GitRepositoryInspection, GitWriteApprovalRequest, ProjectGitBoundary } from "./project-git-service";

export interface ProjectGitPushHost {
  boundary?: ProjectGitBoundary
  resolveGithubCredential?: (ctx: AuthContext, companyId: string, credentialId: string) => Promise<string>
  runGit: (dir: string, args: string[], env?: Record<string, string>) => Promise<{ stdout: string; stderr: string }>
  requireWrite: (ctx: AuthContext) => void
  requireGitWriteApproval: (ctx: AuthContext, companyId: string, projectId: string, binding: GitWriteIntent | { projectId: string; tool: string; payload: Record<string, unknown> }, toolName: string, approval?: GitWriteApprovalRequest) => Promise<void>
  acquireCredential: (ctx: AuthContext, companyId: string, projectId: string, input: { credentialId?: string; purpose: "git.push" | "pull_request.create" | "pull_request.comment"; toolCallId: string }) => Promise<{ value: string; leaseId: string | null }>
  ensureRepositoryInitialized: (ctx: AuthContext, companyId: string, projectId: string) => Promise<string>
  inspectRepository: (ctx: AuthContext, companyId: string, projectId: string) => Promise<GitRepositoryInspection>
  resolveWriteIntent: (ctx: AuthContext, companyId: string, projectId: string, project: Project, namedBranch: string | undefined, force: boolean, credentialId?: string, namedSourceBranch?: string, inspection?: GitRepositoryInspection) => Promise<GitWriteIntent>
  assertGitWriteBoundary: (ctx: AuthContext, companyId: string, intent: GitWriteIntent) => Promise<void>
  captureWorkspaceRevision: (ctx: AuthContext, companyId: string, projectId: string) => Promise<CodeWorkspaceRevisionSnapshot | null>
  assertWorkspaceRevisionUnchanged: (ctx: AuthContext, companyId: string, projectId: string, snapshot: CodeWorkspaceRevisionSnapshot | null) => Promise<void>
  credentialEnvironment: (token: string) => Record<string, string>
}

export async function push(host: ProjectGitPushHost, ctx: AuthContext, companyId: string, projectId: string, options: {
      branch?: string;
      /**
       * C11: the local branch to publish, when it differs from the remote branch being written. The
       * `code.git.push` tool names both, and the approval payload binds both, so the two must resolve to the
       * same pair on the request side and at the boundary — collapsing them here would make the hashes
       * disagree and refuse every approval.
       */
      sourceBranch?: string;
      credentialId?: string;
      approved?: boolean;
      /** C11: `true` asks for a history rewrite. The policy judges it; the structured API then refuses it. */
      force?: boolean;
      /** C11: a remote the caller names explicitly, when one is meaningful (bound into the approval hash). */
      remote?: string;
      /** C11 (owner decision 5): the real approval record for this exact write. */
      approval?: GitWriteApprovalRequest;
    }): Promise<{ pushed: boolean; branch: string; remote: string }> {
    host.requireWrite(ctx);
    if (!options.approved) throw new GitApprovalRequiredError();
    /**
     * C11 (owner decision 13, the last known issue): the order of this method is the fix.
     *
     *   inspect (read-only) -> repository_not_initialized -> policy -> approval -> ensureRepositoryInitialized
     *   -> revision check -> lease -> git push
     *
     * Before it, an unnamed branch asked the checkout for its branch (`resolveWriteIntent` ->
     * `currentBranch`), and `currentBranch` went through `ensureRepository`, which runs `git init` for a
     * repository that does not exist yet. A request that was about to be refused — by the policy, by the
     * missing approval record, by RBAC — still created `.git`, wrote `.gitignore` and made a commit. The
     * inspection below cannot do any of that, and the two git calls it may make are read-only `rev-parse`
     * probes, so every refusal below leaves the disk exactly as it was.
     */
    const inspection = await host.inspectRepository(ctx, companyId, projectId);
    const project = inspection.project;
    if (project.repositoryProvider !== "github" || !project.repositoryUrl) throw new GitError("REPOSITORY_NOT_CONNECTED", "Connect a GitHub repository first", 400);
    const namedBranch = options.branch?.trim();
    const namedSource = options.sourceBranch?.trim();
    for (const candidate of [namedBranch, namedSource]) {
      if (candidate && (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(candidate) || candidate.includes("..") || candidate.includes("@{"))) {
        throw new GitError("INVALID_BRANCH_NAME", "Invalid branch name", 400);
      }
    }
    // The credential reference must exist *before* anything privileged happens, but the lease itself is
    // only issued after the two checks below: a refused write must not have touched the vault.
    if (!options.credentialId || (!host.boundary?.credentials && !host.resolveGithubCredential)) {
      throw new GitError("CREDENTIAL_MISSING", "A Company vault credential reference is required", 400);
    }
    /**
     * C11 (owner decision 13): an uninitialized workspace is **not** a push target, and this is where the
     * service says so instead of repairing it. The refusal is structured — `repository_not_initialized` with
     * `requiresInitialization: true` and `repositoryInitialized: false` — and it is returned before the
     * policy, before the approval is consumed and before any git process runs, so nothing is created.
     *
     * The act it names is a *different* act with a *different* approval: `create the repository and push`
     * rather than `push`, which is exactly what `gitApprovalPayload` binds through `repositoryInitialized`.
     * A caller that holds an approval record for it presents that record (the request side resolves the same
     * fact through `inspectRepository`, so the two payload hashes are comparable); the record is then
     * verified against the initialization payload below and, once consumed,
     * `ensureRepositoryInitialized()` runs.
     */
    if (!inspection.initialized && !options.approval?.approvalId) {
      throw new GitError(
        "repository_not_initialized",
        "The project workspace has no git repository yet, so this push would have to create one; that is a different "
        + "approved act (it is bound to `repositoryInitialized: false`), and this request carries no approval record for it",
        409,
        { requiresInitialization: true, repositoryInitialized: false, projectId, repositoryState: "uninitialized" },
      );
    }
    /**
     * C11 (owner decision 3): the branch is resolved by the **service** when the caller names none — a
     * `git push` without a refspec writes to the checked-out branch, which is a property of the checkout
     * and never a configuration default. The resolved branch is what the policy is asked about. For an
     * uninitialized workspace the branch comes from the caller or not at all: there is no checkout to ask,
     * and the inspection never creates one.
     */
    const intent = await host.resolveWriteIntent(ctx, companyId, projectId, project, namedBranch, options.force === true, options.credentialId, namedSource, inspection);
    /**
     * C11 (owner decision 7 + 13): the canonical revision this write is prepared from, read **before** any
     * side effect and re-checked after the write's own initialization. Without the port no revision is
     * claimed (a hand-built service); with it, an unreadable revision refuses the write rather than letting
     * it act on bytes nobody can name.
     */
    const authorisedRevision = await host.captureWorkspaceRevision(ctx, companyId, projectId);
    // C11 (owner decision 3): the SECOND protected-branch check, at the git-policy boundary.
    //
    // It runs **before** the approval record is consumed, and that order is deliberate: a hard deny must
    // not spend a human's one-shot approval (the same "hard deny before approval" rule the engine's phase
    // order implements). Nothing that follows this call can change the target of the write — the refspec is
    // built from `intent` — so the check still stands immediately in front of the side effect, and the only
    // work between the two is bookkeeping (the approval consumption and the credential lease).
    await host.assertGitWriteBoundary(ctx, companyId, intent);
    // C11 (owner decision 5): the `approved` flag is not a trust boundary. A real approval record, bound
    // to this payload hash, is consumed before the lease and before the push. The payload is built from the
    // **typed request** (operation, branches, force, credential, and — decision 13 — whether this write has
    // to create the repository), which is the same material the requester approved; the repository URL is
    // deliberately not part of it (it is pinned by the stored, validated `repositoryUrl`, so a caller cannot
    // choose a different remote). A record issued for a plain push therefore cannot be redeemed here, and a
    // record issued for `create the repository and push` cannot be redeemed against an existing repository.
    await host.requireGitWriteApproval(ctx, companyId, projectId, { ...intent, remote: options.remote ?? null }, "project.git.push", options.approval);
    // The structured API performs no history rewrite. The refusal comes *after* the policy spoke, so a
    // force push into a protected branch is reported as `force_push_denied` (the policy's own code) rather
    // than as "unsupported": the reason a caller sees is the reason that actually stopped it. An
    // unprotected force push is refused here — this service does not rewrite history through a tool call.
    if (intent.force) {
      throw new GitError(
        "FORCE_PUSH_NOT_SUPPORTED",
        "This API does not perform force pushes; the write was refused. A force push into a protected branch is force_push_denied",
        403,
      );
    }
    /**
     * C11 (owner decision 13): **the only mutation in this method, and it happens here** — after RBAC
     * (`requireWrite`), after the credential reference and the branch checks, after the protected-branch
     * policy, and after the approval record for `repositoryInitialized: false` was consumed. A refused write
     * never reaches this line.
     */
    if (!inspection.initialized) await host.ensureRepositoryInitialized(ctx, companyId, projectId);
    /**
     * C11 (owner decision 7 + 13): the revision is checked **after** the initialization, because the
     * initialization is itself a change to the canonical workspace (`git init` plus the `.gitignore` write).
     * Comparing a pre-init revision with a post-init one would refuse every first push for a reason nobody
     * could act on, so the comparison the guard makes is: "is the canonical workspace still the revision this
     * write was prepared from?" — with the initialization already applied. An already-initialized repository
     * is unaffected except that the check now also covers the approval window, which is strictly stronger
     * than before; an initialization that moved the workspace refuses the push as
     * `workspace_revision_mismatch` (409, retryable): the approved initialization is on disk, the push is
     * not, and the caller re-prepares against the revision that now exists.
     */
    await host.assertWorkspaceRevisionUnchanged(ctx, companyId, projectId, authorisedRevision);
    // The directory the inspection resolved, and — when this call had to create the repository — the one
    // `ensureRepositoryInitialized()` just proved belongs to this workspace. The write path therefore makes
    // no second "ensure" call: one inspection, one (approved) initialization, then the push.
    const dir = inspection.dir;
    const credential = await host.acquireCredential(ctx, companyId, projectId, {
      credentialId: options.credentialId,
      purpose: "git.push",
      toolCallId: options.approval?.approvalId ?? `git-push:${projectId}:${randomUUID()}`,
    });
    try {
      await host.runGit(
        dir,
        ["push", project.repositoryUrl, `refs/heads/${intent.sourceBranch}:refs/heads/${intent.targetBranch}`],
        host.credentialEnvironment(credential.value),
      );
    } catch (error) {
      if (error instanceof GitError) throw error;
      throw new GitError("GIT_PUSH_FAILED", "GitHub push failed; inspect branch and repository permissions", 502);
    } finally {
      // The lease never outlives the call, whatever happened.
      if (credential.leaseId && host.boundary?.credentials) {
        await host.boundary.credentials.revoke(credential.leaseId, "call_finished").catch(() => undefined);
      }
    }
    return { pushed: true, branch: intent.targetBranch, remote: project.repositoryUrl };
  }

