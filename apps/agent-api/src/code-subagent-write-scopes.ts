/**
 * Step 5 — **detached** async sub-agents, on top of C12.
 *
 * Why this module exists and what it deliberately is **not**:
 *
 *   - It is not a runner. The child is executed by the existing `CodingAgentRunner`, reached through the same
 *     `CodeSubagentChildRunner` port the blocking path already uses. This module only decides *when* the call is
 *     made (immediately, in the background) and *when the delegation counts as settled*.
 *   - It is not a process manager, a queue or an outbox. The delegation is one more operation in the **existing**
 *     `CodeProcessStore`, in the same project transaction that already holds process accounting. "An active child
 *     blocks the parent's sandbox cleanup" therefore comes from `activeCodeProcess` — the accounting that exists —
 *     and the completion is delivered by the **existing** Step-4 outbox (`CodeProcessCompletionService`) into the
 *     **existing** inbox.
 *   - It is not a second policy engine. Type resolution, the capability intersection, path validation, the depth
 *     limit, the parallelism ceiling and the digest all stay where C12 put them; this module receives the
 *     already-resolved request.
 *
 * The three properties the detached path has to add, and how each is obtained rather than promised:
 *
 *  1. **The parent is not awaited.** `startDetached` reserves the durable operation, hands the child to the runner
 *     without awaiting it and returns an accepted receipt. The child's completion travels through the completion
 *     outbox and is collected at the parent's next turn boundary, exactly like a background process.
 *  2. **A retry is the same delegation.** The reserve is idempotent by the join key
 *     `(parentRunId, toolCallId) → childRunId`; a retried tool call reads back the operation instead of starting a
 *     second child. This is also what makes recovery safe: nothing here starts a child whose durable record
 *     already says it ran.
 *  3. **An unknown outcome is never replayed blindly.** Recovery reads the **child's own durable run state**
 *     first: a terminal run is settled from that state without running anything, a live lease is left alone (its
 *     owner settles it), and only a reservation that never dispatched is launched automatically.
 *     Interrupted children require explicit C10 continuation under the same run id.
 */
/** One live delegation's write claim, for one parent run. */
export interface CodeSubagentWriteClaim {
    operationId: string;
    childRunId: string;
    paths: readonly string[];
}
/**
 * The write-scope registry of the **live** delegations of one parent run.
 *
 * It exists because "default read-only, or disjoint approved write scopes" is a property of the set of children
 * running at the same time: two read-only children may share a scope, but two writing children whose scopes
 * overlap would produce exactly the concurrent-edit conflict the plan names. The registry is in memory on purpose
 * — it describes what is in flight *now* — and the scopes themselves stay recorded in each child's own run and
 * Activity records. It is keyed by parent run, so two parents never constrain each other.
 */
export class CodeSubagentWriteScopeRegistry {
    private readonly claims = new Map<string, CodeSubagentWriteClaim[]>();
    /**
     * The conflicting claim, or `null` when the scope may be taken. Two scope lists overlap when they share a path
     * or when one path is a prefix of the other (a directory and a file inside it overlap).
     */
    conflict(parentRunId: string, paths: readonly string[], operationId: string): CodeSubagentWriteClaim | null {
        for (const claim of this.claims.get(parentRunId) ?? []) {
            if (claim.operationId === operationId)
                continue;
            for (const left of claim.paths) {
                for (const right of paths) {
                    if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`))
                        return claim;
                }
            }
        }
        return null;
    }
    claim(parentRunId: string, entry: CodeSubagentWriteClaim): void {
        const list = this.claims.get(parentRunId) ?? [];
        this.claims.set(parentRunId, [...list.filter((claim) => claim.operationId !== entry.operationId), entry]);
    }
    release(parentRunId: string, operationId: string): void {
        const list = (this.claims.get(parentRunId) ?? []).filter((claim) => claim.operationId !== operationId);
        if (list.length)
            this.claims.set(parentRunId, list);
        else
            this.claims.delete(parentRunId);
    }
    scope(parentRunId: string): string[] {
        return [...new Set((this.claims.get(parentRunId) ?? []).flatMap((claim) => claim.paths))].sort();
    }
}
