import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import {
  CODE_FORK_STATUSES,
  CODE_REWIND_TARGETS,
  CODE_SESSION_HEAD_REASONS,
  CodeSessionHeadRevisionConflictError,
  CodeSessionOperationInProgressError,
} from "@npati/workspace";
import { isValidCodeFlagKey } from "../apps/agent-api/src/feature-flags";
import { requiredPermissionForAction, CODE_ACTION_PERMISSIONS } from "../apps/agent-api/src/code-rbac";
import { CODE_SESSION_DURABILITY_ACTIONS, CODE_SESSION_DURABILITY_FLAGS, defaultOperationKey } from "../apps/agent-api/src/code-session-durability";

/**
 * C10 security-gate suite: the durable state the three operations are built on.
 *
 * Four properties, all of which are structural rather than conventional:
 *
 *  1. **The conversation cursor is versioned and single.** A rewind is a pointer move (the replay bundle and the
 *     context summaries are append-only in the database), so two concurrent rewinds must not silently overwrite
 *     each other, and a session must not accumulate cursors.
 *  2. **An operation is claimed before it is performed, and the claim is the idempotency key.** A retried request
 *     returns the stored outcome; a request that arrives while the first is still running is refused rather than
 *     duplicated. A claim that provably changed nothing may be reopened, and a claim that did change something may
 *     **not** — that asymmetry is exactly what stops a retry from creating a second pre-rewind checkpoint or a
 *     second session.
 *  3. **Everything is tenant-scoped.** A cursor, an operation or a notice of another company is not found, so no
 *     read can become an existence oracle.
 *  4. **Migration 082 is additive and repeatable**: four new tables, the established classification/retention
 *     vocabulary, no foreign key to a structure that does not exist yet, and an append-only notice.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function store(): InMemoryWorkspaceStore {
  return new InMemoryWorkspaceStore();
}

describe("security-gate: C10 session durability — the conversation cursor", () => {
  it("creates the cursor at revision 1 and moves it only past the revision the caller read", async () => {
    const workspace = store();
    const created = await workspace.setCodeSessionHead({
      companyId: "company-1", projectId: "project-1", sessionId: "session-1",
      runId: "run-1", turnIndex: 3, reason: "rewind", operationId: "op-1", expectedRevision: 0,
    });
    expect(created.revision).toBe(1);
    expect(created.turnIndex).toBe(3);
    expect(created.reason).toBe("rewind");
    expect(created.operationId).toBe("op-1");

    const moved = await workspace.setCodeSessionHead({
      companyId: "company-1", projectId: "project-1", sessionId: "session-1",
      runId: "run-1", turnIndex: 1, reason: "rewind", operationId: "op-2", expectedRevision: 1,
    });
    expect(moved.revision).toBe(2);
    expect(moved.turnIndex).toBe(1);
  });

  it("refuses a stale revision instead of overwriting a cursor somebody else already moved", async () => {
    const workspace = store();
    await workspace.setCodeSessionHead({
      companyId: "company-1", projectId: "project-1", sessionId: "session-1",
      runId: "run-1", turnIndex: 3, reason: "resume", expectedRevision: 0,
    });
    await expect(workspace.setCodeSessionHead({
      companyId: "company-1", projectId: "project-1", sessionId: "session-1",
      runId: "run-1", turnIndex: 0, reason: "rewind", operationId: "op-3", expectedRevision: 0,
    })).rejects.toBeInstanceOf(CodeSessionHeadRevisionConflictError);

    // And the stored cursor is untouched by the refused write.
    const current = await workspace.getCodeSessionHead("company-1", "session-1");
    expect(current?.turnIndex).toBe(3);
    expect(current?.revision).toBe(1);
  });

  it("is tenant-scoped: another company's cursor is not found", async () => {
    const workspace = store();
    await workspace.setCodeSessionHead({
      companyId: "company-1", projectId: "project-1", sessionId: "session-1",
      runId: "run-1", turnIndex: 2, reason: "rewind", expectedRevision: 0,
    });
    expect(await workspace.getCodeSessionHead("company-2", "session-1")).toBeNull();
    // A company-scoped write cannot reach another tenant's session either.
    await expect(workspace.setCodeSessionHead({
      companyId: "company-2", projectId: "project-1", sessionId: "session-1",
      runId: "run-1", turnIndex: 9, reason: "rewind", expectedRevision: 1,
    })).rejects.toBeInstanceOf(CodeSessionHeadRevisionConflictError);
    expect((await workspace.getCodeSessionHead("company-1", "session-1"))?.turnIndex).toBe(2);
  });

  it("keeps the cursor vocabulary closed", () => {
    expect(CODE_SESSION_HEAD_REASONS).toEqual(["created", "resume", "rewind", "fork"]);
    expect(CODE_REWIND_TARGETS).toEqual(["code", "conversation", "both"]);
    expect(CODE_FORK_STATUSES).toEqual(["pending", "completed", "failed"]);
  });
});

describe("security-gate: C10 session durability — the operation ledgers", () => {
  const rewindClaim = {
    companyId: "company-1", projectId: "project-1", sessionId: "session-1",
    operationId: "op-1", target: "both" as const, runId: "run-1", turnIndex: 2, checkpointId: "cp-2",
    previousHeadTurn: 5,
  };

  it("claims a rewind once, refuses a concurrent retry and replays a finished one", async () => {
    const workspace = store();
    const first = await workspace.createCodeSessionRewind(rewindClaim);
    expect(first.replayed).toBe(false);
    expect(first.record.status).toBe("pending");

    // A second call while the first is still pending is refused: the operation is claimed, not duplicated.
    await expect(workspace.createCodeSessionRewind(rewindClaim)).rejects.toBeInstanceOf(CodeSessionOperationInProgressError);

    await workspace.completeCodeSessionRewind({
      companyId: "company-1", operationId: "op-1", status: "completed",
      restoredCheckpointId: "cp-2", safetyCheckpointId: "cp-safety", headTurn: 2,
    });

    const replay = await workspace.createCodeSessionRewind(rewindClaim);
    expect(replay.replayed).toBe(true);
    expect(replay.record.status).toBe("completed");
    expect(replay.record.safetyCheckpointId).toBe("cp-safety");
    expect(replay.record.headTurn).toBe(2);
    // The stored outcome is not rewritten by a later completion attempt.
    const after = await workspace.completeCodeSessionRewind({ companyId: "company-1", operationId: "op-1", status: "failed" });
    expect(after.status).toBe("completed");
    expect(after.failureReason).toBeNull();
  });

  it("reopens only a claim that provably changed nothing", async () => {
    const workspace = store();
    await workspace.createCodeSessionRewind(rewindClaim);
    await workspace.completeCodeSessionRewind({
      companyId: "company-1", operationId: "op-1", status: "failed", failureReason: "audit_unavailable",
    });
    const reopened = await workspace.reopenCodeSessionRewind({ companyId: "company-1", operationId: "op-1" });
    expect(reopened.reopened).toBe(true);
    expect(reopened.record?.status).toBe("pending");
    expect(reopened.record?.failureReason).toBeNull();

    // Now that it has an effect, a failure is final: reopening it is how a retry would create a second checkpoint.
    await workspace.completeCodeSessionRewind({
      companyId: "company-1", operationId: "op-1", status: "completed",
      restoredCheckpointId: "cp-2", safetyCheckpointId: "cp-safety", headTurn: 2,
    });
    const second = await workspace.reopenCodeSessionRewind({ companyId: "company-1", operationId: "op-1" });
    expect(second.reopened).toBe(false);
    expect(second.record?.status).toBe("completed");
  });

  it("reopens a pending claim only after the staleness window", async () => {
    const workspace = store();
    await workspace.createCodeSessionRewind(rewindClaim);
    const fresh = await workspace.reopenCodeSessionRewind({
      companyId: "company-1", operationId: "op-1", staleMs: 60_000,
    });
    expect(fresh.reopened).toBe(false);
    expect(fresh.record?.status).toBe("pending");

    const stale = await workspace.reopenCodeSessionRewind({
      companyId: "company-1", operationId: "op-1", staleMs: 0, now: new Date(Date.now() + 1_000),
    });
    expect(stale.reopened).toBe(true);
  });

  it("does not confuse two tenants that chose the same operation id", async () => {
    const workspace = store();
    await workspace.createCodeSessionRewind(rewindClaim);
    const other = await workspace.createCodeSessionRewind({ ...rewindClaim, companyId: "company-2" });
    expect(other.replayed).toBe(false);
    expect(await workspace.getCodeSessionRewind("company-2", "op-1")).not.toBeNull();
    expect(await workspace.getCodeSessionRewind("company-3", "op-1")).toBeNull();
  });

  it("makes a fork idempotent by operation id and never reopens a claim that created a session", async () => {
    const workspace = store();
    const claim = {
      companyId: "company-1", projectId: "project-1", parentSessionId: "session-1",
      operationId: "fork-1", runId: "run-1", turnIndex: 2, checkpointId: "cp-2",
    };
    const first = await workspace.createCodeSessionFork(claim);
    expect(first.replayed).toBe(false);
    await expect(workspace.createCodeSessionFork(claim)).rejects.toBeInstanceOf(CodeSessionOperationInProgressError);

    await workspace.completeCodeSessionFork({
      companyId: "company-1", operationId: "fork-1", status: "completed",
      sessionId: "session-fork", copiedPlan: true, copiedTodos: true, copiedHead: true, planRevision: 2, todoCount: 3,
    });
    const replay = await workspace.createCodeSessionFork(claim);
    expect(replay.replayed).toBe(true);
    expect(replay.record.sessionId).toBe("session-fork");
    expect(replay.record.planRevision).toBe(2);
    expect(replay.record.todoCount).toBe(3);

    // A claim that already minted a session is never reopened, even with a stale timestamp.
    const reopened = await workspace.reopenCodeSessionFork({
      companyId: "company-1", operationId: "fork-1", staleMs: 0, now: new Date(Date.now() + 10_000),
    });
    expect(reopened.reopened).toBe(false);
    expect(reopened.record?.sessionId).toBe("session-fork");

    // A failed claim that created no session may be reopened: a crash inside the window must not brick the id.
    const failedClaim = { ...claim, operationId: "fork-2" };
    await workspace.createCodeSessionFork(failedClaim);
    await workspace.completeCodeSessionFork({
      companyId: "company-1", operationId: "fork-2", status: "failed", failureReason: "audit_unavailable",
    });
    const reopenedFailed = await workspace.reopenCodeSessionFork({ companyId: "company-1", operationId: "fork-2" });
    expect(reopenedFailed.reopened).toBe(true);
    expect(reopenedFailed.record?.status).toBe("pending");
  });

  it("builds a deterministic operation key so a retried request carries the same id", () => {
    const first = defaultOperationKey(["rewind", "company-1", "session-1", "run-1", 2, "cp-2", "both"]);
    const same = defaultOperationKey(["rewind", "company-1", "session-1", "run-1", 2, "cp-2", "both"]);
    const different = defaultOperationKey(["rewind", "company-1", "session-1", "run-1", 3, "cp-3", "both"]);
    expect(first).toBe(same);
    expect(first).not.toBe(different);
    expect(first).toMatch(/^op-[0-9a-f]{8}$/);
  });
});

describe("security-gate: C10 migration 082 and the wiring", () => {
  const migration = readFileSync(join(ROOT, "packages", "workspace", "src", "migration-082.ts"), "utf8");
  const postgresStore = readFileSync(join(ROOT, "packages", "workspace", "src", "postgres-store.ts"), "utf8");

  it("creates exactly the four durable structures this step needs", () => {
    for (const table of ["code_session_heads", "code_run_recovery_notices", "code_session_rewinds", "code_session_forks"]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(migration).toContain("CONSTRAINT code_session_heads_session_unique UNIQUE (company_id, session_id)");
    expect(migration).toContain("CONSTRAINT code_session_rewinds_operation_unique UNIQUE (company_id, operation_id)");
    expect(migration).toContain("CONSTRAINT code_session_forks_operation_unique UNIQUE (company_id, operation_id)");
  });

  it("carries the established classification and retention vocabulary on every table", () => {
    const classificationChecks = migration.match(/CHECK \(data_classification IN \('public','internal','confidential','restricted'\)\)/g) ?? [];
    const retentionChecks = migration.match(/CHECK \(retention_class IN \('ephemeral','short','standard','extended','until_deleted'\)\)/g) ?? [];
    expect(classificationChecks).toHaveLength(4);
    expect(retentionChecks).toHaveLength(4);
    expect(migration).toContain("company_id text NOT NULL");
  });

  it("points its only foreign key at a table that exists, never at a future step's structure", () => {
    const references = migration.match(/REFERENCES\s+[a-z_]+/g) ?? [];
    expect(references).toEqual(["REFERENCES code_sessions"]);
    expect(migration).toContain("ON DELETE CASCADE");
  });

  it("makes the recovery notice append-only at the database level", () => {
    expect(migration).toContain("npati_code_run_recovery_notices_append_only");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON code_run_recovery_notices");
    expect(migration).toContain("insufficient_privilege");
    expect(migration).toContain("REVOKE UPDATE, DELETE, TRUNCATE ON code_run_recovery_notices FROM PUBLIC");
  });

  it("leaves the existing append-only guarantees untouched", () => {
    // C10 reads the recorded artifacts (the replay bundle and the context summaries) and never edits them; the
    // triggers that make editing impossible must therefore still be exactly where they were.
    const replayBundle = readFileSync(join(ROOT, "packages", "workspace", "src", "migration-078.ts"), "utf8");
    const contextSummaries = readFileSync(join(ROOT, "packages", "workspace", "src", "migration-079.ts"), "utf8");
    for (const source of [replayBundle, contextSummaries]) {
      expect(source).toContain("insufficient_privilege");
      expect(source).toContain("BEFORE UPDATE OR DELETE");
      expect(source).toContain("REVOKE UPDATE, DELETE, TRUNCATE");
    }
    expect(replayBundle).toContain("code_replay_bundles");
    expect(replayBundle).toContain("code_replay_bundle_steps");
    expect(contextSummaries).toContain("code_context_summaries");
  });

  it("is registered with the version-guarded import pattern every other migration uses", () => {
    expect(postgresStore).toContain("SELECT 1 FROM schema_migrations WHERE version='082_code_session_durability'");
    expect(postgresStore).toContain('await import("./migration-082")');
    expect(postgresStore).toContain("INSERT INTO schema_migrations(version) VALUES ('082_code_session_durability')");
  });

  it("exposes no update or delete path for the append-only artifacts a rewind must not touch", () => {
    const types = readFileSync(join(ROOT, "packages", "workspace", "src", "types.ts"), "utf8");
    for (const forbidden of [
      "updateReplayBundle", "deleteReplayBundle", "deleteReplayBundleStep",
      "updateCodeContextSummary", "deleteCodeContextSummary",
      "deleteCodeRunRecoveryNotice", "updateCodeRunRecoveryNotice",
    ]) {
      expect(types.includes(forbidden)).toBe(false);
    }
  });

  it("registers the three flags and the four actions instead of inventing a second vocabulary", () => {
    for (const key of [CODE_SESSION_DURABILITY_FLAGS.resume, CODE_SESSION_DURABILITY_FLAGS.rewind, CODE_SESSION_DURABILITY_FLAGS.fork]) {
      expect(isValidCodeFlagKey(key)).toBe(true);
    }
    expect(isValidCodeFlagKey("code.rewind.all")).toBe(false);

    const expected: Record<string, string> = {
      [CODE_SESSION_DURABILITY_ACTIONS.resume]: "workspace:write",
      [CODE_SESSION_DURABILITY_ACTIONS.rewind]: "workspace:write",
      [CODE_SESSION_DURABILITY_ACTIONS.fork]: "workspace:write",
      [CODE_SESSION_DURABILITY_ACTIONS.recoveryRead]: "workspace:read",
    };
    for (const [action, permission] of Object.entries(expected)) {
      expect(CODE_ACTION_PERMISSIONS[action]).toBe(permission);
      expect(requiredPermissionForAction(action)).toBe(permission);
    }
    // An unmapped action stays a refusal: the map is the allowlist, never a fallback.
    expect(requiredPermissionForAction("code.session.resume.all")).toBeNull();
  });

  it("keeps the durability services free of any write to an append-only artifact", () => {
    for (const file of [
      "code-session-durability.ts", "code-session-resume.ts", "code-session-rewind.ts",
      "code-session-fork.ts", "code-session-durability-routes.ts",
    ]) {
      const source = readFileSync(join(ROOT, "apps", "agent-api", "src", file), "utf8");
      for (const forbidden of [
        "updateReplayBundle", "deleteReplayBundle", "UPDATE code_replay_bundles", "DELETE FROM code_replay_bundles",
        "updateCodeContextSummary", "deleteCodeContextSummary",
        "UPDATE code_context_summaries", "DELETE FROM code_context_summaries",
        "updateExecutionSnapshot", "DELETE FROM execution_snapshots",
        "DELETE FROM code_run_recovery_notices", "UPDATE code_run_recovery_notices",
      ]) {
        expect(source.includes(forbidden)).toBe(false);
      }
    }
  });
});
