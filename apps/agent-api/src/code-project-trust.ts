import type { AuthContext, ProjectCodeTrust, WorkspaceStore } from "@npati/workspace";

/**
 * C5: project trust.
 *
 * Trust answers exactly one question: may the *content* of a repository's own instructions
 * (README, NPATI.md, AGENTS.md, any file inside the workspace) guide the work? It never widens
 * policy. Hard deny, the session mode, approvals, the tool list, the network allowlist and the
 * capability groups stay outside its reach — see `code-prompt-injection-guard.ts` for the checks
 * that make that structural rather than advisory.
 *
 * Trust is granted and revoked only by an owner/admin, is revision-checked, and is written to the
 * audit journal *before* it is applied: if the journal is unavailable the change does not happen
 * (fail closed, rule 23).
 */

export const CODE_TRUST_ROLES = ["owner", "admin"] as const;

export type CodeTrustAction = "code.project.trust" | "code.project.untrust";

export interface CodeAuditPort {
  record(input: {
    action: string;
    actor: string;
    companyId: string;
    resourceType: string;
    resourceId: string;
    /** C5a (D7): a refusal is journalled with `decision: "deny"` (the adapter records it as denied). */
    decision?: "allow" | "deny";
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export class CodeTrustError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`[${code}] ${message}`);
    this.name = "CodeTrustError";
  }
}

export interface CodeProjectTrustDeps {
  store: Pick<WorkspaceStore, "getProjectCodeTrust" | "setProjectCodeTrust">;
  audit?: CodeAuditPort;
}

function roleOf(context: AuthContext): string {
  return String((context as unknown as { role?: string }).role ?? "member");
}

export class CodeProjectTrustService {
  constructor(private readonly deps: CodeProjectTrustDeps) {}

  private async auditOrFail(action: CodeTrustAction, context: AuthContext, companyId: string, projectId: string, metadata: Record<string, unknown>) {
    if (!this.deps.audit) {
      throw new CodeTrustError("audit_unavailable", "Project trust requires the audit journal", 503, {
        reason: "audit_unavailable",
      });
    }
    try {
      await this.deps.audit.record({
        action,
        actor: context.userId,
        companyId,
        resourceType: "code_project",
        resourceId: projectId,
        metadata,
      });
    } catch {
      throw new CodeTrustError("audit_unavailable", "Project trust requires the audit journal", 503, {
        reason: "audit_unavailable",
      });
    }
  }

  /**
   * C5a (D7): a refusal of a trust change is written to the journal (`code.project.trust.denied` /
   * `code.project.untrust.denied`). Best effort on purpose: the refusal already happened, so an
   * unavailable journal must not change it — the failure is reported separately.
   */
  private async auditDenial(action: CodeTrustAction, context: AuthContext, companyId: string, projectId: string, code: string) {
    const audit = this.deps.audit;
    if (!audit) return;
    try {
      await audit.record({
        action: `${action}.denied`,
        actor: String(context.userId ?? "unknown"),
        companyId,
        resourceType: "code_project",
        resourceId: projectId,
        decision: "deny",
        metadata: { reason: code, role: roleOf(context) },
      });
    } catch {
      // Deliberately swallowed: the denial stands, and the journal failure must not become an error
      // path of its own (the write path reports an unavailable journal with `audit_unavailable`).
    }
  }

  /** Owner/admin only; a refusal is journalled (D7) and then thrown unchanged (fail closed). */
  private async assertOwnerOrAdmin(context: AuthContext, companyId: string, projectId: string, action: CodeTrustAction) {
    if (!CODE_TRUST_ROLES.includes(roleOf(context) as (typeof CODE_TRUST_ROLES)[number])) {
      await this.auditDenial(action, context, companyId, projectId, "code_trust_admin_required");
      throw new CodeTrustError("code_trust_admin_required", "Only an owner or admin can change project trust", 403, {
        reason: "code_trust_admin_required",
      });
    }
  }

  async get(context: AuthContext, companyId: string, projectId: string): Promise<ProjectCodeTrust | null> {
    return this.deps.store.getProjectCodeTrust(context, companyId, projectId);
  }

  async isTrusted(context: AuthContext, companyId: string, projectId: string): Promise<boolean> {
    const record = await this.get(context, companyId, projectId);
    return record?.trusted === true;
  }

  /** Grant trust. Owner/admin only, audited before the write, revision-checked. */
  async trust(context: AuthContext, companyId: string, projectId: string, input: { expectedRevision: number; reason?: string }): Promise<ProjectCodeTrust> {
    await this.assertOwnerOrAdmin(context, companyId, projectId, "code.project.trust");
    await this.auditOrFail("code.project.trust", context, companyId, projectId, {
      expectedRevision: input.expectedRevision,
      reason: input.reason ?? null,
    });
    return this.deps.store.setProjectCodeTrust(context, companyId, projectId, {
      trusted: true,
      actor: context.userId,
      reason: input.reason,
      expectedRevision: input.expectedRevision,
    });
  }

  /** Revoke trust. Owner/admin only, audited before the write, revision-checked. */
  async revoke(context: AuthContext, companyId: string, projectId: string, input: { expectedRevision: number; reason?: string }): Promise<ProjectCodeTrust> {
    await this.assertOwnerOrAdmin(context, companyId, projectId, "code.project.untrust");
    await this.auditOrFail("code.project.untrust", context, companyId, projectId, {
      expectedRevision: input.expectedRevision,
      reason: input.reason ?? null,
    });
    return this.deps.store.setProjectCodeTrust(context, companyId, projectId, {
      trusted: false,
      actor: context.userId,
      reason: input.reason,
      expectedRevision: input.expectedRevision,
    });
  }
}

/**
 * The single predicate the rest of the harness asks: are repository instructions usable as content?
 * A missing record, a revoked record or an unavailable store all mean "not trusted" — never "trusted
 * by default".
 */
export async function isRepositoryInstructionsTrusted(
  service: CodeProjectTrustService,
  context: AuthContext,
  companyId: string,
  projectId: string,
): Promise<boolean> {
  try {
    return await service.isTrusted(context, companyId, projectId);
  } catch {
    return false;
  }
}
