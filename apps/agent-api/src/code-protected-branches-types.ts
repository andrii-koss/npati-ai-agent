import type { AuthContext } from "@npati/workspace";
import type { CodePrivilegedAuditPort } from "./code-step-up";
import { normalizeGitBranch, type GitWriteIntent, type GitWriteOperation } from "./code-git-write-policy";

/** Branches protected when a company has no stored policy. Mirrors `code-shell-classifier.ts`. */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ["main", "master", "release"];

/** Stable operation name of the policy change; the step-up challenge is bound to it by payload hash. */
export const PROTECTED_BRANCH_UPDATE_OPERATION = "code.protected_branches.update";

export const MAX_PROTECTED_BRANCHES = 100;

/** The only keys a policy change accepts. Anything else is rejected (see the module doc comment). */
export const PROTECTED_BRANCH_POLICY_INPUT_KEYS: readonly string[] = ["branches", "expectedRevision", "challengeId"];

export type ProtectedBranchOperation = GitWriteOperation;

export type ProtectedBranchDenialCode = "protected_branch_write_denied" | "force_push_denied";

export class CodeProtectedBranchError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeProtectedBranchError";
    this.retryable = retryable;
  }
}

export interface ProtectedBranchPolicy {
  companyId: string;
  /** The branches the owner protected. `DEFAULT_PROTECTED_BRANCHES` with `revision: 0` means "never set". */
  branches: string[];
  revision: number;
  updatedBy: string | null;
  updatedAt: string;
}

export interface StoredProtectedBranchPolicy {
  companyId: string;
  workspaceId: string;
  branches: string[];
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

/**
 * Storage port. Company-scoped on purpose: no `AuthContext`, no principal, no request — a store can
 * neither widen nor narrow a decision, it only remembers what the owner set.
 */
export interface CodeProtectedBranchStore {
  get(companyId: string): Promise<StoredProtectedBranchPolicy | null>;
  save(input: {
    companyId: string;
    workspaceId: string;
    branches: readonly string[];
    expectedRevision: number;
    updatedBy: string;
    updatedAt: string;
  }): Promise<StoredProtectedBranchPolicy>;
}

/** The slice of `code-step-up.ts` this module consults. The challenge flow stays in that module. */
export interface ProtectedBranchStepUpPort {
  requireStepUp(
    ctx: AuthContext,
    companyId: string,
    input: { operation: string; payloadHash: string; challengeId?: string },
  ): Promise<unknown>;
}

/** Configuration is data: an operator turns the hook on with an environment variable, with no code edit. */
export interface ProtectedBranchGuardConfig {
  /** True when a policy change needs a fresh, matching step-up confirmation. */
  stepUpRequired: boolean;
  /** True when the installation asks for two-person confirmation (enforced by `code-step-up.ts`). */
  twoPersonRequested: boolean;
}

export function resolveProtectedBranchGuardConfig(
  env: Record<string, string | undefined> = process.env,
): ProtectedBranchGuardConfig {
  return {
    stepUpRequired: String(env.NPATI_CODE_PROTECTED_BRANCHES_STEP_UP ?? "").toLowerCase() === "true",
    twoPersonRequested: String(env.NPATI_CODE_PROTECTED_BRANCHES_TWO_PERSON ?? "").toLowerCase() === "true",
  };
}

/**
 * C11 (owner decision 3): the policy request for a git write is **typed**.
 *
 * `GitWriteIntent` (`code-git-write-policy.ts`) carries `gitOperation`, `sourceBranch`, `targetBranch`,
 * `remoteBranch`, `remote`, `force` and the credential reference as explicit fields. Nothing in this
 * module parses a command string: an unrefspec'd shell push is resolved (or refused) *before* it reaches
 * here, and a git tool supplies the same shape through its own typed arguments. `viaPullRequestMerge` is
 * the one policy-only fact and stays outside the shared intent because a tool input must never set it.
 */
export interface GitWriteAttempt extends GitWriteIntent {
  /**
   * Set only by the pull-request/merge flow (a human merging a reviewed PR). A tool input must never be
  * able to set it — that is the caller's responsibility, and an agent principal is refused anyway.
   */
  viaPullRequestMerge?: boolean;
}

export interface ProtectedBranchDecision {
  allowed: boolean;
  protected: boolean;
  /** The branch the decision was made on: the intent's `targetBranch`. */
  branch: string;
  operation: ProtectedBranchOperation;
  /** C11: the typed facts the decision was made on, echoed so no caller can claim a different target. */
  sourceBranch: string | null;
  remoteBranch: string | null;
  remote: string | null;
  force: boolean;
  code: ProtectedBranchDenialCode | null;
  reason: string;
  policyRevision: number;
  /**
   * Proof of the input surface: the decision was made on the branch name, the operation and the
   * principal kind — never on repository content. Any future change that needs another input has to
   * change this value, which is a reviewable edit.
   */
  decidedOn: "branch_name_and_operation_only";
}

export interface CodeProtectedBranchDeps {
  store: CodeProtectedBranchStore;
  /** Company role lookup, injected from `CodeMembershipService.resolveRoleForUser` (no hardcoded roles). */
  resolveRole: (ctx: AuthContext, companyId: string) => Promise<string | null>;
  audit?: CodePrivilegedAuditPort;
  stepUp?: ProtectedBranchStepUpPort;
  guard?: Partial<ProtectedBranchGuardConfig>;
  now?: () => Date;
  logger?: { warn(payload: unknown, message?: string): void };
}

export interface UpdateProtectedBranchPolicyInput {
  branches?: unknown;
  expectedRevision?: number;
  challengeId?: string;
  /** The route forwards the raw body so the key check can reject unknown (repository-content) fields. */
  [key: string]: unknown;
}

/** Git branch name: no whitespace, no wildcards, no `..`, no leading dash. */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

/**
 * Strips the ref prefix so `refs/heads/main` and `main` are the same branch. The implementation lives in
 * `code-git-write-policy.ts` so the typed git intent, the protected-branch policy and the git-policy
 * boundary cannot disagree about which branch a write targets; the name is kept here because this is
 * where the policy surface is read from.
 */
export function normalizeBranchName(value: unknown): string {
  return normalizeGitBranch(value);
}

/**
 * Validates and de-duplicates a policy's branch list. An empty list is refused deliberately: an empty
 * policy would silently unprotect every branch, which is exactly the state the owner decisions forbid.
 */
export function normalizeProtectedBranchNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new CodeProtectedBranchError(
      "invalid_protected_branch_policy",
      "branches must be an array of branch names",
      400,
      { received: typeof value },
    );
  }
  const names = value.map((entry) => normalizeBranchName(entry));
  if (names.some((name) => !name)) {
    throw new CodeProtectedBranchError(
      "invalid_protected_branch_policy",
      "Every protected-branch entry must be a non-empty branch name",
      400,
    );
  }
  if (names.length > MAX_PROTECTED_BRANCHES) {
    throw new CodeProtectedBranchError(
      "invalid_protected_branch_policy",
      `At most ${MAX_PROTECTED_BRANCHES} protected branches are supported`,
      400,
      { received: names.length },
    );
  }
  for (const name of names) {
    if (!BRANCH_NAME_PATTERN.test(name) || name.includes("..") || name.endsWith(".lock")) {
      throw new CodeProtectedBranchError(
        "invalid_protected_branch_policy",
        `Not a valid git branch name: ${name}`,
        400,
        { branch: name },
      );
    }
  }
  const unique = [...new Set(names)];
  if (unique.length === 0) {
    throw new CodeProtectedBranchError(
      "invalid_protected_branch_policy",
      "A protected-branch policy cannot be empty: name at least one branch",
      400,
      { minimum: 1 },
    );
  }
  return unique;
}

/**
 * The policy-change input is administrative only. A field that could carry repository content (a file
 * list, `NPATI.md`, a CI configuration, a diff) is rejected instead of being silently ignored, so the
 * "content never influences the policy" rule is mechanical rather than aspirational.
 */
export function assertPolicyInputKeysAreAdministrative(input: Record<string, unknown>): void {
  const rejected = Object.keys(input).filter((key) => !PROTECTED_BRANCH_POLICY_INPUT_KEYS.includes(key));
  if (rejected.length > 0) {
    throw new CodeProtectedBranchError(
      "protected_branch_policy_input_rejected",
      `A protected-branch policy change accepts only ${PROTECTED_BRANCH_POLICY_INPUT_KEYS.join(", ")}. ` +
        `Repository content is not an input to this policy (rejected: ${rejected.join(", ")}).`,
      400,
      { rejected, accepted: [...PROTECTED_BRANCH_POLICY_INPUT_KEYS] },
    );
  }
}
