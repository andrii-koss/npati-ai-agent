import type { AuthContext } from "@npati/workspace";
import type { PatchMutation } from "./code-patch-transaction";
import { ProjectFileError, type ProjectWorkspace } from "./project-workspace";

/** Managed Terminal output uses the canonical transaction, never compensating copy-back.
 * Commands execute in the existing sandbox projection; arbitrary external effects
 * are non-transactional. This commits only validated returned file writes.
 */
export async function commitSandboxWrites(workspace: ProjectWorkspace, ctx: AuthContext, companyId: string, projectId: string, plan: readonly PatchMutation[]) {
  if (!plan.length) return;
  if (workspace.applyPatchTransaction) {
    try { await workspace.applyPatchTransaction(ctx, companyId, projectId, plan); }
    catch (error) {
      if (error instanceof ProjectFileError) throw error;
      throw new ProjectFileError("write_failed", "Terminal already executed but its workspace commit failed; inspect before rerunning the command", 500);
    }
    return;
  }
  // Older/custom providers retain single-file CAS. Multi-file atomicity must not
  // silently degrade to a sequence of writes on a provider without transactions.
  if (plan.length !== 1) throw new ProjectFileError("workspace_transaction_unavailable", "Workspace cannot commit a multi-file Terminal result atomically", 503);
  const item = plan[0]!;
  if (item.existing) await workspace.writeFile(ctx, companyId, projectId, item.path, item.after, item.revision ?? "");
  else await workspace.createFile(ctx, companyId, projectId, item.path, item.after);
}

export interface SandboxBinaryWrite { path: string; content: string; revision?: string }

/** Images and fonts a command produced. The workspace keeps exact bytes; only the text commit is transactional. */
export async function commitSandboxBinaries(workspace: ProjectWorkspace, ctx: AuthContext, companyId: string, projectId: string, files: readonly SandboxBinaryWrite[]): Promise<void> {
  for (const file of files) {
    const bytes = Buffer.from(file.content, "base64");
    if (file.revision) await workspace.writeFile(ctx, companyId, projectId, file.path, bytes, file.revision);
    else await workspace.createFile(ctx, companyId, projectId, file.path, bytes);
  }
}
