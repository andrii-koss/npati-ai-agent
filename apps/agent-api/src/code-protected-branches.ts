import type { Pool } from "pg";
import type { AuthContext } from "@npati/workspace";
import { classifyPrincipal } from "./code-rbac";
import { productionPayloadHash, type CodePrivilegedAuditPort } from "./code-step-up";
import { normalizeGitBranch, type GitWriteIntent, type GitWriteOperation } from "./code-git-write-policy";

/**
 * C5a (part 2B) — company-level protected-branch policy.
 *
 * Owner decisions this module implements, literally:
 *  - A **direct write into a protected branch is a hard deny for everybody, the owner included**
 *    (`protected_branch_write_denied`); a **force push** is refused with `force_push_denied`. Protected
 *    branches are only ever reached through a pull request that a **human** merges; the merge pathway is
 *    explicit in the input (`viaPullRequestMerge`) and an agent principal may never use it.
 *  - **Only the company `owner` may change the policy, and only as an administrative action outside an
 *    agent session.** An agent/service principal refuses with
 *    `agent_cannot_change_protected_branches`; a human who is not the owner refuses with
 *    `protected_branches_owner_required` (403).
 *  - **Repository content can never influence the policy.** There is deliberately no parameter, no
 *    lookup and no import in this module that can read a file: the decision inputs are the branch name,
 *    the operation and the principal kind (`decidedOn` records that), and the policy-change input is
 *    key-checked so that a caller trying to smuggle `files`, `NPATI.md`, a CI config or any other
 *    repository content into the request is rejected with `protected_branch_policy_input_rejected`.
 *    Nothing here touches the filesystem, and this module must stay that way.
 *  - The audit entry (`code.protected_branches.update`) is written **before** the change is applied; if
 *    the journal is unavailable the change does not happen (`audit_unavailable`, fail closed).
 *  - Step-up / two-person for a policy change is **configuration**, and the flow itself belongs to
 *    `code-step-up.ts`: this module consults `requireStepUp` through an injected port and never
 *    implements a second confirmation mechanism.
 *
 * Where the policy lives (and why not somewhere else):
 *  - NOT in `Company.memory`. That blob is writable through the generic
 *    `PATCH /companies/:companyId` route with only `business:manage` and without any audit entry, which
 *    would be a second, unaudited, non-owner path to change a policy that the owner decisions reserve to
 *    the owner alone. A dedicated store keeps the single administrative path.
 *  - A dedicated, company-scoped, revisioned table (`company_protected_branches`), reached through the
 *    injected `CodeProtectedBranchStore` port — the same shape the existing company policy storage uses
 *    (`GuardrailPolicyRepository` / `company_guardrail_policies`, migration 027). No new permission
 *    system is introduced: authorisation is the existing `code-rbac.ts` vocabulary plus the company role
 *    from `code-membership.ts`.
 *  - `CodeProtectedBranchRepository` below implements the port for PostgreSQL (with the revision guard in
 *    SQL) and in-process for development/tests. Its DDL is owned by the migration owner and **has been
 *    added**: migration 073 (`packages/workspace/src/migration-073.ts`) creates
 *    `company_protected_branches` with exactly the columns below, `revision` included, plus
 *    `company_protected_branches_scope_idx` on `workspace_id`. Because the table exists, a policy read
 *    answers from it and only falls back to `DEFAULT_PROTECTED_BRANCHES` when the company has no row —
 *    never to an empty set, and never by pretending a missing table is an empty policy.
 *
 *    The historical TODO that stood here is closed; it is kept in the description rather than deleted so
 *    that a reader who remembers it can see where the DDL went. This file still creates no tables.
 */

export * from "./code-protected-branches-types";
export * from "./code-protected-branches-repository";
import {
  DEFAULT_PROTECTED_BRANCHES,
  PROTECTED_BRANCH_UPDATE_OPERATION,
  CodeProtectedBranchError,
  type CodeProtectedBranchStore,
  type ProtectedBranchPolicy,
  type StoredProtectedBranchPolicy,
  type ProtectedBranchOperation,
  type ProtectedBranchStepUpPort,
  type ProtectedBranchGuardConfig,
  type GitWriteAttempt,
  type ProtectedBranchDecision,
  type CodeProtectedBranchDeps,
  type UpdateProtectedBranchPolicyInput,
  normalizeBranchName,
  normalizeProtectedBranchNames,
  assertPolicyInputKeysAreAdministrative,
} from "./code-protected-branches-types";

/**
 * The gate and the administrative surface of the protected-branch policy.
 *
 * `evaluateGitWrite`/`assertGitWriteAllowed` are the hard deny consulted by the enforcement layer;
 * `getPolicy`/`updatePolicy` are the owner-only administrative path. The two never share a decision:
 * a policy can be changed by the owner, and a protected branch stays refused for every principal.
 */
export class CodeProtectedBranchService {
  private readonly store: CodeProtectedBranchStore;
  private readonly resolveRole: (ctx: AuthContext, companyId: string) => Promise<string | null>;
  private readonly audit?: CodePrivilegedAuditPort;
  private readonly stepUp?: ProtectedBranchStepUpPort;
  private readonly guard: ProtectedBranchGuardConfig;
  private readonly now: () => Date;
  private readonly logger?: { warn(payload: unknown, message?: string): void };

  constructor(deps: CodeProtectedBranchDeps) {
    this.store = deps.store;
    this.resolveRole = deps.resolveRole;
    this.audit = deps.audit;
    this.stepUp = deps.stepUp;
    this.guard = { stepUpRequired: false, twoPersonRequested: false, ...(deps.guard ?? {}) };
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger;
  }

  get effectiveGuard(): ProtectedBranchGuardConfig {
    return { ...this.guard };
  }

  /**
   * The hard deny for a git write. Hard means hard: the owner's role, `admin:all`, `*` and an explicit
   * privileged permission are all irrelevant here — this method never consults the RBAC matrix, so no
   * grant can lift it. Only a human merging a reviewed pull request reaches a protected branch.
   *
   * C11: the input is the **typed** intent. The decision is made on `targetBranch` and `gitOperation` and
   * `force` — never on a command line — and an intent whose branch is empty is refused upstream
   * (`git_push_requires_resolved_branch`) rather than being read as "no branch to protect".
   */
  async evaluateGitWrite(
    ctx: AuthContext,
    companyId: string,
    input: GitWriteAttempt,
  ): Promise<ProtectedBranchDecision> {
    const policy = await this.loadPolicyForDecision(companyId);
    const branch = normalizeBranchName(input.targetBranch);
    const operation: ProtectedBranchOperation = input.force === true || input.gitOperation === "force_push"
      ? "force_push"
      : "push";
    const protectedBranch = branch ? policy.branches.includes(branch) : true;
    const base = {
      protected: protectedBranch,
      branch,
      operation,
      sourceBranch: input.sourceBranch ? normalizeBranchName(input.sourceBranch) : null,
      remoteBranch: input.remoteBranch ? normalizeBranchName(input.remoteBranch) : null,
      remote: input.remote ?? null,
      force: operation === "force_push",
      policyRevision: policy.revision,
      decidedOn: "branch_name_and_operation_only" as const,
    };
    if (!branch) {
      // Fail closed. A git write with no target branch is exactly the shape the C11 finding named: it must
      // never be answered with "not in the protected list", which would read as "safe to write".
      return this.recordDenial(ctx, companyId, {
        ...base,
        allowed: false,
        code: "protected_branch_write_denied",
        reason: "A git write with no resolved target branch cannot be evaluated against the protected-branch policy",
      });
    }
    if (!protectedBranch) {
      return {
        ...base,
        allowed: true,
        code: null,
        reason: `Branch "${branch}" is not in the company protected-branch policy`,
      };
    }
    // Force push is refused first: it is never a merge and never a reviewable change.
    if (operation === "force_push") {
      return this.recordDenial(ctx, companyId, {
        ...base,
        allowed: false,
        code: "force_push_denied",
        reason: `Force push to protected branch "${branch}" is denied for every principal, the owner included`,
      });
    }
    // The only sanctioned pathway: a pull request that a human merges. Two independent facts are
    // required, because `classifyPrincipal` is marker-based and a token without the `agent:`/`service:`
    // marker must not become a merge path on its own: the principal is a human **and** it holds an active
    // company membership. The pull-request review rule itself (reviewer/admin/owner, never the author)
    // belongs to the PR flow; this gate only proves *which pathway* is being used.
    if (input.viaPullRequestMerge === true) {
      const role = await this.roleOrNull(ctx, companyId);
      if (classifyPrincipal(ctx) === "user" && role !== null) {
        return {
          ...base,
          allowed: true,
          code: null,
          reason:
            `Pull-request merge by a human member (role: ${role}) is the sanctioned pathway into ` +
            `protected branch "${branch}"`,
        };
      }
      return this.recordDenial(ctx, companyId, {
        ...base,
        allowed: false,
        code: "protected_branch_write_denied",
        reason:
          `The pull-request pathway into protected branch "${branch}" requires an authenticated human ` +
          "with an active company membership",
      });
    }
    return this.recordDenial(ctx, companyId, {
      ...base,
      allowed: false,
      code: "protected_branch_write_denied",
      reason:
        `A direct write into protected branch "${branch}" is denied for every principal, the owner included; ` +
        "protected branches are only reachable through a pull request that a human merges",
    });
  }

  /** `evaluateGitWrite` for callers that want the refusal as an exception. */
  async assertGitWriteAllowed(ctx: AuthContext, companyId: string, input: GitWriteAttempt): Promise<ProtectedBranchDecision> {
    const decision = await this.evaluateGitWrite(ctx, companyId, input);
    if (!decision.allowed) {
      throw new CodeProtectedBranchError(decision.code ?? "protected_branch_write_denied", decision.reason, 403, {
        branch: decision.branch,
        operation: decision.operation,
        protected: decision.protected,
        policyRevision: decision.policyRevision,
        // C11: the typed facts travel into the refusal so the caller that was refused can be sure which
        // target was judged (a service boundary refusal must be actionable, and provable in a test).
        targetBranch: decision.branch,
        sourceBranch: decision.sourceBranch,
        remote: decision.remote,
        force: decision.force,
      });
    }
    return decision;
  }

  /** Administrative read. Requires an active company membership; a store failure refuses (no fake policy). */
  async getPolicy(ctx: AuthContext, companyId: string): Promise<ProtectedBranchPolicy> {
    const role = await this.resolveRole(ctx, companyId);
    if (!role) {
      throw new CodeProtectedBranchError(
        "protected_branches_membership_required",
        "Reading the protected-branch policy requires an active company membership",
        403,
        { companyId },
      );
    }
    return this.readCurrentPolicy(companyId);
  }

  /**
   * The owner-only administrative change. Order is deliberate: shape, principal, owner role, current
   * revision, step-up, **audit**, and only then the write — an unavailable journal refuses the change.
   */
  async updatePolicy(
    ctx: AuthContext,
    companyId: string,
    input: UpdateProtectedBranchPolicyInput,
  ): Promise<ProtectedBranchPolicy> {
    // Order matters for the refusal a caller sees: the principal is checked first (an agent must always
    // learn `agent_cannot_change_protected_branches`, not a shape error), then the input shape, then the
    // company role — and only after all of that the revision, step-up, audit and the write.
    const actor = this.requireHumanActor(ctx, companyId);
    assertPolicyInputKeysAreAdministrative(input as Record<string, unknown>);
    const role = await this.resolveRole(ctx, companyId);
    if (!role) {
      await this.recordPolicyDenial(ctx, companyId, "protected_branches_membership_required");
      throw new CodeProtectedBranchError(
        "protected_branches_membership_required",
        "Changing the protected-branch policy requires an active company membership",
        403,
        { companyId },
      );
    }
    if (role !== "owner") {
      await this.recordPolicyDenial(ctx, companyId, "protected_branches_owner_required", { role });
      throw new CodeProtectedBranchError(
        "protected_branches_owner_required",
        "Only the company owner can change the protected-branch policy",
        403,
        { role },
      );
    }
    const branches = normalizeProtectedBranchNames(input.branches);
    const expectedRevision = input.expectedRevision;
    if (!Number.isInteger(expectedRevision)) {
      throw new CodeProtectedBranchError(
        "invalid_protected_branch_policy",
        "expectedRevision must be an integer (0 for the first policy)",
        400,
        { received: expectedRevision },
      );
    }
    const current = await this.readCurrentPolicy(companyId);
    if (current.revision !== expectedRevision) {
      throw new CodeProtectedBranchError(
        "policy_revision_conflict",
        "The protected-branch policy changed by another request. Reload and try again.",
        409,
        { expectedRevision, currentRevision: current.revision },
      );
    }
    const payloadHash = productionPayloadHash(PROTECTED_BRANCH_UPDATE_OPERATION, {
      companyId,
      branches,
      expectedRevision,
    });
    await this.satisfyStepUp(ctx, companyId, input.challengeId, payloadHash);

    // Audit first, fail closed: without the journal entry the policy is not changed.
    await this.auditOrFail({
      action: PROTECTED_BRANCH_UPDATE_OPERATION,
      actor,
      companyId,
      resourceType: "company_protected_branches",
      resourceId: companyId,
      decision: "allow",
      payloadHash,
      metadata: {
        before: current.branches,
        after: branches,
        expectedRevision,
        stepUpRequired: this.guard.stepUpRequired,
        twoPersonRequested: this.guard.twoPersonRequested,
        // The "different confirmer" rule is enforced by `code-step-up.ts`; recorded so an auditor knows
        // which module answered the two-person question.
        twoPersonEnforcedBy: "code-step-up.ts",
        challengeId: input.challengeId ?? null,
        // Recorded, not inferred: no repository path, file list or file content reaches this decision.
        repositoryContentConsulted: false,
      },
    });

    const saved = await this.saveOrFail({
      companyId,
      workspaceId: ctx.workspaceId,
      branches,
      expectedRevision,
      updatedBy: actor,
      updatedAt: this.now().toISOString(),
    });
    return toPolicy(saved);
  }

  /**
   * Membership lookup that never throws: an unresolvable role is `null`, which fails closed on every
   * caller (no role means denied, and a broken membership store can never widen a decision).
   */
  private async roleOrNull(ctx: AuthContext, companyId: string): Promise<string | null> {
    try {
      return await this.resolveRole(ctx, companyId);
    } catch (error) {
      this.logger?.warn({ err: error, companyId }, "code_protected_branches_role_lookup_failed");
      return null;
    }
  }

  /** A human principal only; an agent or a service identity has no administrative surface at all. */
  private requireHumanActor(ctx: AuthContext, companyId: string): string {
    const actor = String(ctx.userId ?? "");
    if (!actor) {
      throw new CodeProtectedBranchError("unauthorized", "Authentication required", 401, { companyId });
    }
    const principal = classifyPrincipal(ctx);
    if (principal !== "user") {
      throw new CodeProtectedBranchError(
        "agent_cannot_change_protected_branches",
        "An agent or service identity cannot change the protected-branch policy; it is an administrative action",
        403,
        { principal, companyId },
      );
    }
    return actor;
  }

  private async satisfyStepUp(
    ctx: AuthContext,
    companyId: string,
    challengeId: string | undefined,
    payloadHash: string,
  ): Promise<void> {
    if (!this.guard.stepUpRequired && !this.guard.twoPersonRequested) return;
    if (!challengeId) {
      throw new CodeProtectedBranchError(
        "protected_branches_step_up_required",
        "Changing the protected-branch policy requires a fresh step-up confirmation",
        403,
        { stepUpRequired: this.guard.stepUpRequired, twoPersonRequested: this.guard.twoPersonRequested },
      );
    }
    if (!this.stepUp) {
      throw new CodeProtectedBranchError(
        "protected_branches_step_up_unavailable",
        "Step-up is configured but no step-up service is wired",
        503,
        { reason: "protected_branches_step_up_unavailable" },
        true,
      );
    }
    // TODO(C5a step-up flow): the challenge is created/confirmed by `code-step-up.ts`
    // (`requestConfirmation` → `confirmConfirmation` with operation
    // `code.protected_branches.update`). This call only *checks* that a matching grant exists; a
    // `CodeStepUpError` from it propagates unchanged (same `code`/`httpStatus` shape).
    await this.stepUp.requireStepUp(ctx, companyId, {
      operation: PROTECTED_BRANCH_UPDATE_OPERATION,
      payloadHash,
      challengeId,
    });
  }

  /**
   * Administrative read: the stored policy, or the built-in defaults when nothing was ever set. A store
   * failure refuses instead of inventing a policy, because the caller is about to compare revisions.
   */
  private async readCurrentPolicy(companyId: string): Promise<ProtectedBranchPolicy> {
    let stored: StoredProtectedBranchPolicy | null;
    try {
      stored = await this.store.get(companyId);
    } catch (error) {
      this.logger?.warn({ err: error, companyId }, "code_protected_branches_store_unavailable");
      throw new CodeProtectedBranchError(
        "protected_branches_store_unavailable",
        "The protected-branch policy store is unavailable",
        503,
        { reason: "protected_branches_store_unavailable" },
        true,
      );
    }
    if (!stored) {
      return {
        companyId,
        branches: [...DEFAULT_PROTECTED_BRANCHES],
        revision: 0,
        updatedBy: null,
        updatedAt: new Date(0).toISOString(),
      };
    }
    return toPolicy(stored);
  }

  /**
   * Enforcement read that never throws: if the policy cannot be read, the built-in default set applies —
   * never an empty one. A push to a branch outside that default set is then judged by the remaining
   * layers (shell classifier, approvals, RBAC); the protected-branch hard deny never silently disappears.
   */
  private async loadPolicyForDecision(companyId: string): Promise<ProtectedBranchPolicy> {
    try {
      const stored = await this.store.get(companyId);
      if (stored) return toPolicy(stored);
    } catch (error) {
      this.logger?.warn({ err: error, companyId }, "code_protected_branches_policy_unavailable");
    }
    return {
      companyId,
      branches: [...DEFAULT_PROTECTED_BRANCHES],
      revision: 0,
      updatedBy: null,
      updatedAt: new Date(0).toISOString(),
    };
  }

  private async saveOrFail(input: {
    companyId: string;
    workspaceId: string;
    branches: readonly string[];
    expectedRevision: number;
    updatedBy: string;
    updatedAt: string;
  }): Promise<StoredProtectedBranchPolicy> {
    try {
      return await this.store.save(input);
    } catch (error) {
      if (error instanceof CodeProtectedBranchError) throw error;
      this.logger?.warn({ err: error, companyId: input.companyId }, "code_protected_branches_store_write_failed");
      throw new CodeProtectedBranchError(
        "protected_branches_store_unavailable",
        "The protected-branch policy store is unavailable; the policy was not changed",
        503,
        { reason: "protected_branches_store_unavailable" },
        true,
      );
    }
  }

  /** A refusal of a policy change is journalled too (best effort: it can never undo the refusal). */
  private async recordPolicyDenial(
    ctx: AuthContext,
    companyId: string,
    code: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.record({
        action: PROTECTED_BRANCH_UPDATE_OPERATION,
        actor: String(ctx.userId ?? "unknown"),
        companyId,
        resourceType: "company_protected_branches",
        resourceId: companyId,
        decision: "deny",
        metadata: {
          reason: code,
          principal: classifyPrincipal(ctx),
          repositoryContentConsulted: false,
          ...metadata,
        },
      });
    } catch (error) {
      this.logger?.warn({ err: error, code }, "code_protected_branches_denial_audit_failed");
    }
  }

  /** Denials are journalled, but an unavailable journal never turns a refusal into an allow. */
  private async recordDenial(
    ctx: AuthContext,
    companyId: string,
    decision: ProtectedBranchDecision,
  ): Promise<ProtectedBranchDecision> {
    if (!this.audit) return decision;
    try {
      await this.audit.record({
        action: "code.protected_branches.denied",
        actor: String(ctx.userId ?? "unknown"),
        companyId,
        resourceType: "company_protected_branches",
        resourceId: companyId,
        decision: "deny",
        metadata: {
          reason: decision.code,
          branch: decision.branch,
          operation: decision.operation,
          // C11: the journalled facts are the typed intent's, so an auditor sees the exact target that was
          // refused — including the remote, which the command line never had to name (it is the checkout's).
          sourceBranch: decision.sourceBranch,
          remoteBranch: decision.remoteBranch,
          remote: decision.remote,
          force: decision.force,
          principal: classifyPrincipal(ctx),
          policyRevision: decision.policyRevision,
          repositoryContentConsulted: false,
        },
      });
    } catch (error) {
      this.logger?.warn({ err: error, code: decision.code }, "code_protected_branches_denial_audit_failed");
    }
    return decision;
  }

  /** Audit before the change is applied. No journal (or a failing one) means no change. */
  private async auditOrFail(entry: Parameters<CodePrivilegedAuditPort["record"]>[0]): Promise<void> {
    if (!this.audit) {
      throw new CodeProtectedBranchError(
        "audit_unavailable",
        "Changing the protected-branch policy requires the audit journal",
        503,
        { reason: "audit_unavailable" },
        true,
      );
    }
    try {
      await this.audit.record(entry);
    } catch (error) {
      if (error instanceof CodeProtectedBranchError) throw error;
      this.logger?.warn({ err: error, action: entry.action }, "code_protected_branches_audit_failed");
      throw new CodeProtectedBranchError(
        "audit_unavailable",
        "Changing the protected-branch policy requires the audit journal",
        503,
        { reason: "audit_unavailable" },
        true,
      );
    }
  }
}

function toPolicy(stored: StoredProtectedBranchPolicy): ProtectedBranchPolicy {
  return {
    companyId: stored.companyId,
    branches: [...stored.branches],
    revision: stored.revision,
    updatedBy: stored.updatedBy,
    updatedAt: stored.updatedAt,
  };
}
