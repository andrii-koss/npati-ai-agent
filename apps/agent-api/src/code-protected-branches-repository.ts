import type { Pool } from "pg";
import {
  CodeProtectedBranchError,
  type CodeProtectedBranchStore,
  type StoredProtectedBranchPolicy,
} from "./code-protected-branches-types";

/**
 * PostgreSQL / in-process implementation of the port, mirroring `GuardrailPolicyRepository`: the
 * revision guard is part of the write, so two owners cannot silently overwrite each other.
 */
export class CodeProtectedBranchRepository implements CodeProtectedBranchStore {
  private readonly memory = new Map<string, StoredProtectedBranchPolicy>();

  constructor(private readonly pool?: Pool) {}

  async get(companyId: string): Promise<StoredProtectedBranchPolicy | null> {
    if (this.pool) {
      const result = await this.pool.query<StoredProtectedBranchPolicy>(
        `SELECT company_id AS "companyId", workspace_id AS "workspaceId", branches, revision,
                updated_by AS "updatedBy", updated_at AS "updatedAt"
           FROM company_protected_branches WHERE company_id = $1`,
        [companyId],
      );
      return result.rows[0] ?? null;
    }
    const found = this.memory.get(companyId);
    return found ? { ...found, branches: [...found.branches] } : null;
  }

  async save(input: {
    companyId: string;
    workspaceId: string;
    branches: readonly string[];
    expectedRevision: number;
    updatedBy: string;
    updatedAt: string;
  }): Promise<StoredProtectedBranchPolicy> {
    if (this.pool) {
      const result = await this.pool.query<StoredProtectedBranchPolicy>(
        `INSERT INTO company_protected_branches(company_id, workspace_id, branches, revision, updated_by)
         SELECT $1, $2, $3::text[], 1, $4 WHERE $5 = 0
         ON CONFLICT(company_id) DO UPDATE SET
           branches = EXCLUDED.branches,
           updated_by = EXCLUDED.updated_by,
           revision = company_protected_branches.revision + 1,
           updated_at = now()
         WHERE company_protected_branches.workspace_id = $2
           AND company_protected_branches.revision = $5
         RETURNING company_id AS "companyId", workspace_id AS "workspaceId", branches, revision,
                   updated_by AS "updatedBy", updated_at AS "updatedAt"`,
        [input.companyId, input.workspaceId, [...input.branches], input.updatedBy, input.expectedRevision],
      );
      const row = result.rows[0];
      if (!row) {
        throw new CodeProtectedBranchError(
          "policy_revision_conflict",
          "The protected-branch policy changed by another request. Reload and try again.",
          409,
          { expectedRevision: input.expectedRevision },
        );
      }
      return row;
    }
    const current = this.memory.get(input.companyId) ?? null;
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      throw new CodeProtectedBranchError(
        "policy_revision_conflict",
        "The protected-branch policy changed by another request. Reload and try again.",
        409,
        { expectedRevision: input.expectedRevision, currentRevision: current?.revision ?? 0 },
      );
    }
    const stored: StoredProtectedBranchPolicy = {
      companyId: input.companyId,
      workspaceId: input.workspaceId,
      branches: [...input.branches],
      revision: input.expectedRevision + 1,
      updatedBy: input.updatedBy,
      updatedAt: input.updatedAt,
    };
    this.memory.set(input.companyId, stored);
    return { ...stored, branches: [...stored.branches] };
  }
}
