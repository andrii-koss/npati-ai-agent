import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import type { ProjectService } from "./project-service";
import type { WorkspaceBaseResolverPort } from "./workspace-base-resolver";
import type { ProjectGitBoundary, CheckpointThresholds } from "./project-git-types";
import { safeAgentSlug } from "./project-git-types";
import { validId, redactSecrets, execFileAsync } from "./project-git-shared";
import type { ProjectGitCoreHost } from "./project-git-core-service";
import type { ProjectGitWorkspaceHost } from "./project-git-workspace-service";
import type { ProjectGitGuardHost } from "./project-git-guard-service";
import type { ProjectGitHistoryHost } from "./project-git-history-service";
import type { ProjectGitCleanupHost } from "./project-git-cleanup-service";
import type { ProjectGitBranchHost } from "./project-git-branch-service";
import type { ProjectGitCredentialHost } from "./project-git-credential-service";
import type { ProjectGitPushHost } from "./project-git-push-service";
import type { ProjectGitCheckpointWriteHost } from "./project-git-checkpoint-write-service";
import type { ProjectGitWorktreeExtraHost } from "./project-git-worktree-extra-service";
import type { ProjectGitRepositoryHost } from "./project-git-repository-service";
import type { ProjectGitApprovalHost } from "./project-git-approval-service";
import type { ProjectGitCheckpointHost } from "./project-git-checkpoint-service";
import type { ProjectGitPullRequestHost } from "./project-git-pull-request-service";
import type { ProjectGitWorktreeHost } from "./project-git-worktree-service";

export interface ProjectGitHostState {
  bases: WorkspaceBaseResolverPort;
  workspaceStore: WorkspaceStore;
  projectService: Pick<ProjectService, "get">;
  thresholds: CheckpointThresholds;
  boundary?: ProjectGitBoundary;
  runGitImpl?: (dir: string, args: string[], env: Record<string, string>) => Promise<{ stdout: string; stderr: string }>;
  resolveGithubCredential?: (ctx: AuthContext, companyId: string, credentialId: string) => Promise<string>;
  mergeLocks: Map<string, Promise<void>>;
}

export function buildGitCoreHost(state: ProjectGitHostState, svc: any): ProjectGitCoreHost {
  return {
    bases: state.bases,
    projectService: state.projectService,
    workspaceStore: state.workspaceStore,
    thresholds: state.thresholds,
    boundary: state.boundary,
    runGitImpl: state.runGitImpl,
    resolveGithubCredential: state.resolveGithubCredential,
    diff: svc.diff.bind(svc),
    validId: validId,
    redactSecrets: redactSecrets,
    execFileAsync: execFileAsync,
    resolveProjectWorkspace: svc.resolveProjectWorkspace.bind(svc),
    runGit: svc.runGit.bind(svc),
    assertSafeIndex: svc.assertSafeIndex.bind(svc),
    requireWrite: svc.requireWrite.bind(svc),
    githubToken: svc.githubToken.bind(svc),
    inspectRepository: svc.inspectRepository.bind(svc),
    ensureRepositoryInitialized: svc.ensureRepositoryInitialized.bind(svc),
    ensureRepository: svc.ensureRepository.bind(svc),
    status: svc.status.bind(svc),
    log: svc.log.bind(svc),
    branch: svc.branch.bind(svc),
    stage: svc.stage.bind(svc),
    commit: svc.commit.bind(svc),
    createCheckpoint: svc.createCheckpoint.bind(svc),
    getCheckpoint: svc.getCheckpoint.bind(svc),
    restoreCheckpoint: svc.restoreCheckpoint.bind(svc),
    restorePaths: svc.restorePaths.bind(svc),
    resolveRevertTarget: svc.resolveRevertTarget.bind(svc),
    removePathForRevert: svc.removePathForRevert.bind(svc),
    assertNoSymlinkPath: svc.assertNoSymlinkPath.bind(svc),
    push: svc.push.bind(svc),
    createPullRequest: svc.createPullRequest.bind(svc),
    commentOnPullRequest: svc.commentOnPullRequest.bind(svc),
    resolveWriteIntent: svc.resolveWriteIntent.bind(svc),
    currentBranch: svc.currentBranch.bind(svc),
    requireGitWriteApproval: svc.requireGitWriteApproval.bind(svc),
    assertWorkspaceRevisionUnchanged: svc.assertWorkspaceRevisionUnchanged.bind(svc),
    acquireCredential: svc.acquireCredential.bind(svc),
    createAgentWorktree: svc.createAgentWorktree.bind(svc),
    commitAgentWorktree: svc.commitAgentWorktree.bind(svc),
    diffAgentWorktree: svc.diffAgentWorktree.bind(svc),
    mergeAgentWorktree: svc.mergeAgentWorktree.bind(svc),
    removeAgentWorktree: svc.removeAgentWorktree.bind(svc),
    cleanupAllWorktrees: svc.cleanupAllWorktrees.bind(svc),
    listAgentWorktrees: svc.listAgentWorktrees.bind(svc),
  };
}

export function buildGitWorkspaceHost(state: ProjectGitHostState, svc: any): ProjectGitWorkspaceHost {
  return {
    bases: state.bases,
    projectService: state.projectService,
    runGitImpl: state.runGitImpl,
    validId: validId,
    redactSecrets: redactSecrets,
    parseConflictFiles: svc.parseConflictFiles.bind(svc),
    status: svc.status.bind(svc),
    execFileAsync: execFileAsync,
    ensureRepositoryInitialized: svc.ensureRepositoryInitialized.bind(svc),
  };
}

export function buildGitGuardHost(state: ProjectGitHostState, svc: any): ProjectGitGuardHost {
  return {
    boundary: state.boundary,
    workspaceStore: state.workspaceStore,
    runGit: svc.runGit.bind(svc),
    getCheckpoint: svc.getCheckpoint.bind(svc),
    listCheckpoints: svc.listCheckpoints.bind(svc),
  };
}

export function buildGitHistoryHost(state: ProjectGitHostState, svc: any): ProjectGitHistoryHost {
  return {
    runGit: svc.runGit.bind(svc),
    requireWrite: svc.requireWrite.bind(svc),
    ensureRepository: svc.ensureRepository.bind(svc),
    assertSafeIndex: svc.assertSafeIndex.bind(svc),
    status: svc.status.bind(svc),
    stage: svc.stage.bind(svc),
  };
}

export function buildGitCleanupHost(state: ProjectGitHostState, svc: any): ProjectGitCleanupHost {
  return {
    runGit: svc.runGit.bind(svc),
    requireWrite: svc.requireWrite.bind(svc),
    ensureRepository: svc.ensureRepository.bind(svc),
  };
}

export function buildGitBranchHost(svc: any): ProjectGitBranchHost {
  return {
    inspectRepository: svc.inspectRepository.bind(svc),
  };
}

export function buildGitCredentialHost(state: ProjectGitHostState): ProjectGitCredentialHost {
  return {
    boundary: state.boundary,
    resolveGithubCredential: state.resolveGithubCredential,
  };
}

export function buildGitPushHost(state: ProjectGitHostState, svc: any): ProjectGitPushHost {
  return {
    boundary: state.boundary,
    resolveGithubCredential: state.resolveGithubCredential,
    runGit: svc.runGit.bind(svc),
    requireWrite: svc.requireWrite.bind(svc),
    requireGitWriteApproval: svc.requireGitWriteApproval.bind(svc),
    acquireCredential: svc.acquireCredential.bind(svc),
    ensureRepositoryInitialized: svc.ensureRepositoryInitialized.bind(svc),
    inspectRepository: svc.inspectRepository.bind(svc),
    resolveWriteIntent: svc.resolveWriteIntent.bind(svc),
    assertGitWriteBoundary: svc.assertGitWriteBoundary.bind(svc),
    captureWorkspaceRevision: svc.captureWorkspaceRevision.bind(svc),
    assertWorkspaceRevisionUnchanged: svc.assertWorkspaceRevisionUnchanged.bind(svc),
    credentialEnvironment: svc.credentialEnvironment.bind(svc),
  };
}

export function buildGitCheckpointWriteHost(state: ProjectGitHostState, svc: any): ProjectGitCheckpointWriteHost {
  return {
    workspaceStore: state.workspaceStore,
    assertSafeIndex: svc.assertSafeIndex.bind(svc),
    ensureRepository: svc.ensureRepository.bind(svc),
    getProjectPath: svc.getProjectPath.bind(svc),
    requireWrite: svc.requireWrite.bind(svc),
    runGit: svc.runGit.bind(svc),
    status: svc.status.bind(svc),
    countWorkspaceFiles: svc.countWorkspaceFiles.bind(svc),
  };
}

export function buildGitWorktreeExtraHost(svc: any): ProjectGitWorktreeExtraHost {
  return {
    runGit: svc.runGit.bind(svc),
    requireWrite: svc.requireWrite.bind(svc),
    ensureRepository: svc.ensureRepository.bind(svc),
    getAgentWorktreePath: svc.getAgentWorktreePath.bind(svc),
  };
}

export function buildGitRepositoryHost(state: ProjectGitHostState, svc: any): ProjectGitRepositoryHost {
  return {
    bases: state.bases,
    assertSafeIndex: svc.assertSafeIndex.bind(svc),
    ensureRepository: svc.ensureRepository.bind(svc),
    requireWrite: svc.requireWrite.bind(svc),
    runGit: svc.runGit.bind(svc),
    resolveProjectWorkspace: svc.resolveProjectWorkspace.bind(svc),
  };
}

export function buildGitApprovalHost(state: ProjectGitHostState, svc: any): ProjectGitApprovalHost {
  return {
    boundary: state.boundary,
    currentBranch: svc.currentBranch.bind(svc),
  };
}

export function buildGitCheckpointHost(svc: any): ProjectGitCheckpointHost {
  return {
    requireWrite: svc.requireWrite.bind(svc),
    ensureRepository: svc.ensureRepository.bind(svc),
    getCheckpoint: svc.getCheckpoint.bind(svc),
    createCheckpoint: svc.createCheckpoint.bind(svc),
    runGit: svc.runGit.bind(svc),
    assertNoSymlinkPath: svc.assertNoSymlinkPath.bind(svc),
    resolveRevertTarget: svc.resolveRevertTarget.bind(svc),
    pathExistsInCommit: svc.pathExistsInCommit.bind(svc),
    removePathForRevert: svc.removePathForRevert.bind(svc),
  };
}

export function buildGitPullRequestHost(state: ProjectGitHostState, svc: any): ProjectGitPullRequestHost {
  return {
    boundary: state.boundary,
    resolveGithubCredential: state.resolveGithubCredential,
    getProjectPath: svc.getProjectPath.bind(svc),
    requireGitWriteApproval: svc.requireGitWriteApproval.bind(svc),
    requireWrite: svc.requireWrite.bind(svc),
    acquireCredential: svc.acquireCredential.bind(svc),
  };
}

export function buildGitWorktreeHost(state: ProjectGitHostState, svc: any): ProjectGitWorktreeHost {
  return {
    mergeLocks: state.mergeLocks,
    runGit: svc.runGit.bind(svc),
    requireWrite: svc.requireWrite.bind(svc),
    ensureRepository: svc.ensureRepository.bind(svc),
    branch: svc.branch.bind(svc),
    getAgentWorktreePath: svc.getAgentWorktreePath.bind(svc),
    safeAgentSlug: safeAgentSlug,
  };
}
