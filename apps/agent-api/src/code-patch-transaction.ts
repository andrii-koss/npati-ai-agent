import { CodeToolError } from "./code-tools-path";
import { assertNoPlaceholderInWrite } from "./provider-data-guard";
import { assertCodeWriteReadable } from "./workspace-protected-content";
import { assertEditSize, assertMassOperation, detectEncoding, detectEol, guardWritePath, resolveWriteLimits, type CodeWritePort, type WriteOptions } from "./code-tools-write";

export interface PatchMutation {
  path: string; before: string; after: string; existing: boolean;
  delete?: boolean; mode?: number; revision?: string;
}

/** Shared commit boundary for canonical and legacy patches. No mutation precedes validation. */
export async function commitPatchMutations(plan: PatchMutation[], port: CodeWritePort, options: WriteOptions, dryRun = false) {
  const tool = options.tool ?? "code.fs.apply_patch", limits = { ...resolveWriteLimits(), ...options.limits };
  assertMassOperation(plan.length, tool, limits, options.approved);
  const seen = new Set<string>();
  for (const item of plan) {
    item.path = guardWritePath({ raw: item.path, tool, approved: options.approved }).path;
    if (seen.has(item.path)) throw new CodeToolError("patch_invalid", "Duplicate patch target", tool);
    seen.add(item.path);
    assertEditSize(item.after, tool, limits);
    if (!item.delete) {
      assertNoPlaceholderInWrite(item.after, { tool, path: item.path });
      assertCodeWriteReadable(item.path, item.after, tool);
    }
    if (item.delete && !dryRun && !options.approved) throw new CodeToolError("approval_required", "Patch deletion requires approval", tool, 409, false, "approval");
  }
  const written: Array<{ item: PatchMutation; revision?: string }> = [];
  const results: Array<{ path: string; sha256?: string; revision?: string }> = [];
  if (dryRun) return results;
  // Recheck the whole read set before the first side effect.
  for (const item of plan) {
    if (!item.existing) {
      if ((await port.stat(item.path)).exists) throw new CodeToolError("revision_conflict", "Patch target was created by another writer", tool, 409, false, "preflight", { path: item.path });
      continue;
    }
    const current = await port.readFile(item.path);
    if (current.content !== item.before || (item.revision !== undefined && current.revision !== item.revision)) {
      throw new CodeToolError("revision_conflict", "Patch target changed before commit", tool, 409, false, "preflight", { path: item.path });
    }
  }

  if (port.applyPatchTransaction) return port.applyPatchTransaction(plan);
  try {
    for (const item of plan) {
      if (item.delete) {
        await port.deletePath(item.path, { expectedRevision: item.revision });
        written.push({ item }); results.push({ path: item.path });
      } else {
        const result = await port.writeFile(item.path, item.after, { encoding: detectEncoding(item.after).encoding, eol: detectEol(item.after).eol, mode: item.mode, expectedRevision: item.revision });
        written.push({ item, revision: result.revision }); results.push({ path: item.path, ...result });
      }
    }
  } catch (error) {
    const failed: string[] = [];
    for (const { item, revision } of written.reverse()) {
      try {
        if (item.delete) {
          if ((await port.stat(item.path)).exists) throw new Error("Rollback target recreated");
        } else {
          const current = await port.readFile(item.path);
          if (current.content !== item.after || (revision !== undefined && current.revision !== revision)) throw new Error("Rollback target changed");
        }
        if (!item.existing) await port.deletePath(item.path, { expectedRevision: revision });
        else await port.writeFile(item.path, item.before, { encoding: detectEncoding(item.before).encoding, eol: detectEol(item.before).eol, mode: item.mode, expectedRevision: revision });
      } catch { failed.push(item.path); }
    }
    if (failed.length) throw new CodeToolError("write_failed", "Patch failed and rollback is incomplete. Inspect the workspace and checkpoint before retrying.", tool, 500, false, "rollback", { rollbackIncomplete: true, paths: failed });
    throw error;
  }
  return results;
}
