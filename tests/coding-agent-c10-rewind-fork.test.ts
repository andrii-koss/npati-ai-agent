import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, WorkspaceNotFoundError } from "@npati/workspace";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { CodeRunStateLog, type CodeRunStateStorePort } from "../apps/agent-api/src/code-run-state";
import {
  CodeSessionRewindService,
  type CodeRewindCheckpointPort,
  type CodeSessionRewindDeps,
} from "../apps/agent-api/src/code-session-rewind";
import { CodeSessionForkService, type CodeSessionForkDeps } from "../apps/agent-api/src/code-session-fork";
import {
  CodeSessionDurabilityError,
  CODE_SESSION_DURABILITY_FLAGS,
} from "../apps/agent-api/src/code-session-durability";
import {
  REPLAY_BUNDLE_FORMAT_VERSION,
  ReplayBundleRecorder,
  replayInputHash,
} from "../apps/agent-api/src/code-replay-bundle";

/**
 * C10 security-gate suite: **rewind** (all three variants) and **fork**.
 *
 * The properties under test are the ones that make these operations safe to expose:
 *
 *  1. **A conversation rewind is a pointer.** The replay bundle and the context summaries are append-only in the
 *     database, so the test asserts the durable writes the services make are exactly the cursor and the ledger —
 *     nothing that would rewrite or delete recorded evidence — and that the replay-input hash and the bundle
 *     format version are untouched by this step.
 *  2. **Rewind takes exactly one pre-rewind checkpoint, even when it is retried.** For `code`/`both` that is the
 *     safety checkpoint the existing restore already creates; for `conversation` it is an explicit one. The
 *     double call is the test that matters: a second call must not create a second checkpoint, a second session or
 *     a second audit entry.
 *  3. **`both` reports partial success honestly** — a restored workspace whose cursor could not move is
 *     `rewound_partial`, with the safety checkpoint named, never "rewound".
 *  4. **Fork is a lineage, not a copy of a session.** `parent_session_id` is filled, the plan is copied as a
 *     *draft* (approval is a decision about a session, not a property of a plan body), the todo list is copied and
 *     the goal deliberately is not — and the same operation id never produces a second session.
 *  5. **No existence oracle.** A foreign session, run or checkpoint is one identical 404 with no ids.
 */

const COMPANY = "company-1";
const PROJECT = "project-1";
const SESSION = "session-1";
const RUN = "run-1";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

const ctx: AuthContext = { userId: "user-1", workspaceId: "ws-1", permissions: ["workspace:write"] };

function session(overrides: Partial<CodeSession> = {}): CodeSession {
  return {
    id: SESSION,
    workspaceId: "ws-1",
    companyId: COMPANY,
    projectId: PROJECT,
    userId: "user-1",
    mode: "auto",
    modelProfile: "profile-a",
    status: "active",
    runId: RUN,
    dataClassification: "confidential",
    retentionClass: "standard",
    revision: 4,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

interface RewindHarnessOptions {
  headTurn?: number;
  headRevision?: number;
  flagsEnabled?: boolean;
  auditThrows?: boolean;
  headConflict?: boolean;
}

async function rewindHarness(options: RewindHarnessOptions = {}) {
  const store = new InMemoryWorkspaceStore();
  const log = new CodeRunStateLog({
    store: store as unknown as CodeRunStateStorePort,
    now: () => T0,
  });
  await log.startRun({
    ctx, companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, owner: "worker-a", runId: RUN,
  });
  // Turn 1 and turn 3 wrote (each with its own checkpoint); turn 2 wrote nothing, which is the case a rewind must
  // not silently approximate.
  await log.appendTurn({ companyId: COMPANY, runId: RUN, turnIndex: 1, status: "finished", outcome: "ok", checkpointId: "cp-1" });
  await log.appendTurn({ companyId: COMPANY, runId: RUN, turnIndex: 2, status: "finished", outcome: "ok" });
  await log.appendTurn({ companyId: COMPANY, runId: RUN, turnIndex: 3, status: "finished", outcome: "ok", checkpointId: "cp-3" });
  await log.markFinished({ companyId: COMPANY, runId: RUN, status: "completed", reason: "completed" });

  if (options.headTurn !== undefined) {
    await store.setCodeSessionHead({
      companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, runId: RUN,
      turnIndex: options.headTurn, reason: "rewind", operationId: "op-earlier", expectedRevision: 0,
    });
    if ((options.headRevision ?? 1) > 1) {
      await store.setCodeSessionHead({
        companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, runId: RUN,
        turnIndex: options.headTurn, reason: "rewind", operationId: "op-earlier-2", expectedRevision: 1,
      });
    }
  }

  const restores: Array<Record<string, unknown>> = [];
  const creates: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const checkpoints: CodeRewindCheckpointPort = {
    create: async (input) => {
      creates.push(input as unknown as Record<string, unknown>);
      return { checkpointId: "cp-pre-rewind", commitHash: "deadbeef" };
    },
    restore: async (input) => {
      restores.push(input as unknown as Record<string, unknown>);
      return { restoredCheckpointId: input.checkpointId, safetyCheckpointId: "cp-safety" };
    },
    find: async ({ projectId, checkpointId }) => {
      if (projectId !== PROJECT) return null;
      if (checkpointId === "cp-3" || checkpointId === "cp-1") return { checkpointId, runId: RUN };
      if (checkpointId === "cp-standalone") return { checkpointId, runId: null };
      // A checkpoint of another project/tenant is not found, exactly like one that never existed.
      return null;
    },
  };

  const deps: CodeSessionRewindDeps = {
    flags: {
      assertEnabled: async () => {
        if (options.flagsEnabled === false) throw Object.assign(new Error("disabled"), { code: "feature_disabled" });
        return true;
      },
    },
    sessions: {
      get: async (_ctx, companyId, sessionId) => {
        if (companyId !== COMPANY || sessionId !== SESSION) throw new WorkspaceNotFoundError("Code session not found");
        return session();
      },
    },
    store: {
      getCodeSessionHead: async (companyId, sessionId) => {
        if (options.headConflict) return null;
        return store.getCodeSessionHead(companyId, sessionId);
      },
      setCodeSessionHead: async (input) => {
        if (options.headConflict) {
          throw Object.assign(new Error("head revision conflict"), { code: "session_head_revision_conflict" });
        }
        return store.setCodeSessionHead(input);
      },
      listCodeRunTurns: (companyId, runId) => store.listCodeRunTurns(companyId, runId),
      createCodeSessionRewind: (input) => store.createCodeSessionRewind(input),
      reopenCodeSessionRewind: (input) => store.reopenCodeSessionRewind(input),
      completeCodeSessionRewind: (input) => store.completeCodeSessionRewind(input),
    },
    checkpoints,
    audit: {
      record: async (input) => {
        if (options.auditThrows) throw new Error("journal down");
        audits.push(input as unknown as Record<string, unknown>);
      },
    },
  };

  return {
    store,
    restores,
    creates,
    audits,
    rewinds: (input: unknown, extra: Record<string, unknown> = {}) =>
      new CodeSessionRewindService(deps).rewind({ ctx, companyId: COMPANY, sessionId: SESSION, body: input, ...extra }),
  };
}

describe("security-gate: C10 rewind — three variants, one pre-rewind checkpoint", () => {
  it("rewinds only the code by restoring the turn's checkpoint, and does not touch the conversation", async () => {
    const h = await rewindHarness();
    const outcome = await h.rewinds({ target: "code", turnIndex: 3 });
    expect(outcome.status).toBe("rewound");
    expect(outcome.target).toBe("code");
    expect(outcome.checkpointId).toBe("cp-3");
    expect(outcome.restoredCheckpointId).toBe("cp-3");
    expect(outcome.safetyCheckpointId).toBe("cp-safety");
    expect(outcome.code.restored).toBe(true);
    expect(outcome.conversation.moved).toBe(false);
    expect(h.restores).toHaveLength(1);
    // No explicit pre-rewind checkpoint: the restore already took one.
    expect(h.creates).toHaveLength(0);
    expect(await h.store.getCodeSessionHead(COMPANY, SESSION)).toBeNull();
  });

  it("rewinds only the conversation by moving the cursor, taking its own pre-rewind checkpoint", async () => {
    const h = await rewindHarness();
    const outcome = await h.rewinds({ target: "conversation", turnIndex: 1 });
    expect(outcome.status).toBe("rewound");
    expect(outcome.target).toBe("conversation");
    expect(outcome.code.restored).toBe(false);
    expect(outcome.conversation.moved).toBe(true);
    expect(outcome.conversation.headTurn).toBe(1);
    expect(outcome.conversation.headRevision).toBe(1);
    // The rewind changed no file, and it still names the checkpoint that makes it reviewable.
    expect(outcome.safetyCheckpointId).toBe("cp-pre-rewind");
    expect(h.creates).toHaveLength(1);
    expect(h.restores).toHaveLength(0);

    const head = await h.store.getCodeSessionHead(COMPANY, SESSION);
    expect(head?.turnIndex).toBe(1);
    expect(head?.reason).toBe("rewind");
    // The transcript itself is untouched: the append-only recording is not what a rewind edits.
    expect((await h.store.listCodeRunTurns(COMPANY, RUN)).map((turn) => turn.turnIndex)).toEqual([1, 2, 3]);
  });

  it("rewinds both as one operation, with the restore's own safety checkpoint", async () => {
    const h = await rewindHarness({ headTurn: 3 });
    const outcome = await h.rewinds({ target: "both", turnIndex: 1 });
    expect(outcome.status).toBe("rewound");
    expect(outcome.code.restored).toBe(true);
    expect(outcome.conversation.moved).toBe(true);
    expect(outcome.conversation.previousHeadTurn).toBe(3);
    expect(outcome.conversation.headTurn).toBe(1);
    expect(outcome.safetyCheckpointId).toBe("cp-safety");
    expect(h.restores).toHaveLength(1);
    expect(h.creates).toHaveLength(0);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ action: "code.rewind", resourceType: "code_session", resourceId: SESSION });
  });

  it("reports partial success when the code was restored but the cursor could not move", async () => {
    const h = await rewindHarness({ headConflict: true });
    const outcome = await h.rewinds({ target: "both", turnIndex: 3 });
    expect(outcome.status).toBe("rewound_partial");
    expect(outcome.code.restored).toBe(true);
    expect(outcome.conversation.moved).toBe(false);
    // The safety checkpoint is named, so the operator can finish or undo deliberately.
    expect(outcome.safetyCheckpointId).toBe("cp-safety");
    expect(outcome.failureReason).toContain("revision conflict");

    const stored = await h.store.getCodeSessionRewind(COMPANY, outcome.operationId);
    expect(stored?.status).toBe("partial");
  });

  it("refuses a turn that has no checkpoint of its own, naming the nearest earlier one", async () => {
    const h = await rewindHarness();
    await expect(h.rewinds({ target: "both", turnIndex: 2 })).rejects.toMatchObject({
      code: "turn_has_no_checkpoint",
      httpStatus: 409,
    });
    // Nothing happened: no restore, no cursor, no ledger effect.
    expect(h.restores).toHaveLength(0);
    expect(await h.store.getCodeSessionHead(COMPANY, SESSION)).toBeNull();
  });

  it("accepts an explicitly named checkpoint, and refuses one from another project like a missing one", async () => {
    const h = await rewindHarness();
    const outcome = await h.rewinds({ target: "code", checkpointId: "cp-standalone" });
    expect(outcome.checkpointId).toBe("cp-standalone");
    expect(outcome.turnIndex).toBeNull();
    expect(outcome.code.restored).toBe(true);

    const foreign = h.rewinds({ target: "code", checkpointId: "cp-of-another-tenant" });
    await expect(foreign).rejects.toMatchObject({ code: "checkpoint_not_found", httpStatus: 404, details: {} });
  });

  it("requires a turn for a conversation rewind, because a cursor cannot be invented", async () => {
    const h = await rewindHarness();
    await expect(h.rewinds({ target: "conversation", checkpointId: "cp-standalone" }))
      .rejects.toMatchObject({ code: "turn_index_required", httpStatus: 400 });
  });

  it("never creates a second checkpoint, session or audit entry when the same operation is repeated", async () => {
    const h = await rewindHarness();
    const first = await h.rewinds({ target: "conversation", turnIndex: 1, operationId: "op-fixed" });
    expect(first.status).toBe("rewound");
    expect(first.idempotentReplay).toBe(false);

    const second = await h.rewinds({ target: "conversation", turnIndex: 1, operationId: "op-fixed" });
    expect(second.status).toBe("already_rewound");
    expect(second.idempotentReplay).toBe(true);
    expect(second.safetyCheckpointId).toBe(first.safetyCheckpointId);
    expect(second.operationId).toBe("op-fixed");
    // The two facts the idempotency exists for.
    expect(h.creates).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
    // And the cursor did not move twice.
    expect((await h.store.getCodeSessionHead(COMPANY, SESSION))?.revision).toBe(1);
  });

  it("derives the same operation id from the same target, so a retried request is idempotent by default", async () => {
    const h = await rewindHarness();
    const first = await h.rewinds({ target: "conversation", turnIndex: 1 });
    const second = await h.rewinds({ target: "conversation", turnIndex: 1 });
    expect(second.operationId).toBe(first.operationId);
    expect(second.status).toBe("already_rewound");
    expect(h.creates).toHaveLength(1);
  });

  it("does not claim a conversation move when replaying a code-only rewind", async () => {
    const h = await rewindHarness();
    const first = await h.rewinds({ target: "code", turnIndex: 3, operationId: "op-code-only" });
    expect(first.conversation.moved).toBe(false);
    const replay = await h.rewinds({ target: "code", turnIndex: 3, operationId: "op-code-only" });
    expect(replay.status).toBe("already_rewound");
    // The ledger row of a code-only rewind carries no cursor position, so its replay cannot report a move.
    expect(replay.conversation.moved).toBe(false);
    expect(replay.conversation.headTurn).toBeNull();
  });

  it("refuses the rewind when the journal is unavailable, and allows a retry afterwards", async () => {
    const failing = await rewindHarness({ auditThrows: true });
    await expect(failing.rewinds({ target: "conversation", turnIndex: 1, operationId: "op-audit" }))
      .rejects.toMatchObject({ code: "audit_unavailable", httpStatus: 503 });
    // Nothing was touched: no checkpoint, no cursor.
    expect(failing.creates).toHaveLength(0);
    expect(await failing.store.getCodeSessionHead(COMPANY, SESSION)).toBeNull();

    // The claim is a provably effect-free failure, so the same operation id can be retried.
    const healthy = await rewindHarness();
    await healthy.store.createCodeSessionRewind({
      companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, operationId: "op-audit",
      target: "conversation", runId: RUN, turnIndex: 1, checkpointId: "cp-1", previousHeadTurn: null,
    });
    await healthy.store.completeCodeSessionRewind({
      companyId: COMPANY, operationId: "op-audit", status: "failed", failureReason: "audit_unavailable",
    });
    const retried = await healthy.rewinds({ target: "conversation", turnIndex: 1, operationId: "op-audit" });
    expect(retried.status).toBe("rewound");
    expect(healthy.creates).toHaveLength(1);
    expect(healthy.audits).toHaveLength(1);
  });

  it("is refused when its feature flag is off, before any checkpoint is taken", async () => {
    const h = await rewindHarness({ flagsEnabled: false });
    await expect(h.rewinds({ target: "code", turnIndex: 3 })).rejects.toMatchObject({ code: "feature_disabled" });
    expect(h.restores).toHaveLength(0);
    expect(CODE_SESSION_DURABILITY_FLAGS.rewind).toBe("code.rewind");
  });

  it("validates the request before it claims anything", async () => {
    const h = await rewindHarness();
    await expect(h.rewinds({ target: "everything", turnIndex: 1 })).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(h.rewinds({ target: "code" })).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(h.rewinds({ target: "code", turnIndex: -1 })).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("answers a session of another tenant with the same 404 as a session that does not exist", async () => {
    const h = await rewindHarness();
    // The harness's session service is tenant-scoped, so a foreign session id is a plain "not found" — the same
    // answer an id that never existed gets, with no ids in the error.
    await expect(h.rewinds({ target: "code", turnIndex: 1 }, { sessionId: "session-foreign" }))
      .rejects.toBeInstanceOf(WorkspaceNotFoundError);
    expect(h.audits).toHaveLength(0);
  });
});

async function forkHarness(options: { flagsEnabled?: boolean; checkpointForeign?: boolean } = {}) {
  const store = new InMemoryWorkspaceStore();
  const created: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];

  const source = session();
  const deps: CodeSessionForkDeps = {
    flags: {
      assertEnabled: async () => {
        if (options.flagsEnabled === false) throw Object.assign(new Error("disabled"), { code: "feature_disabled" });
        return true;
      },
    },
    sessions: {
      get: async (_ctx, companyId, sessionId) => {
        if (companyId !== COMPANY || sessionId !== SESSION) throw new WorkspaceNotFoundError("Code session not found");
        return source;
      },
      create: async (_ctx, companyId, projectId, input) => {
        created.push({ companyId, projectId, input: input as unknown as Record<string, unknown> });
        return session({
          id: `session-fork-${created.length}`,
          parentSessionId: source.id,
          runId: null,
          mode: input.mode ?? "auto",
        });
      },
    },
    store: {
      getCodeSessionHead: (companyId, sessionId) => store.getCodeSessionHead(companyId, sessionId),
      setCodeSessionHead: (input) => store.setCodeSessionHead(input),
      getLatestCodeSessionPlan: (companyId, sessionId) => store.getLatestCodeSessionPlan(companyId, sessionId),
      createCodeSessionPlan: (input) => store.createCodeSessionPlan(input),
      listCodeSessionTodos: (input) => store.listCodeSessionTodos(input),
      replaceCodeSessionTodos: (input) => store.replaceCodeSessionTodos(input),
      createCodeSessionFork: (input) => store.createCodeSessionFork(input),
      reopenCodeSessionFork: (input) => store.reopenCodeSessionFork(input),
      completeCodeSessionFork: (input) => store.completeCodeSessionFork(input),
    },
    checkpoints: {
      find: async ({ projectId, checkpointId }) => {
        if (options.checkpointForeign || projectId !== PROJECT) return null;
        return checkpointId === "cp-1" ? { checkpointId, runId: RUN } : null;
      },
    },
    audit: {
      record: async (input) => {
        audits.push(input as unknown as Record<string, unknown>);
      },
    },
  };

  // The source session's state: a cursor at turn 2, an approved plan and a task list.
  await store.setCodeSessionHead({
    companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, runId: RUN,
    turnIndex: 2, reason: "rewind", operationId: "op-rewind", expectedRevision: 0,
  });
  await store.createCodeSessionPlan({
    companyId: COMPANY, projectId: PROJECT, sessionId: SESSION,
    plan: { files: ["src/a.ts"], steps: ["change a"], risks: ["low"], testStrategy: "npm test" },
    createdBy: "user-1",
  });
  await store.replaceCodeSessionTodos({
    companyId: COMPANY, projectId: PROJECT, sessionId: SESSION,
    tasks: [
      { taskId: "t1", content: "update the parser", status: "completed" },
      { taskId: "t2", content: "add a test", status: "in_progress" },
    ],
  });
  await store.createCodeGoal({
    companyId: COMPANY, projectId: PROJECT, sessionId: SESSION,
    objective: "make the parser test pass", criteria: ["suite green"], createdBy: "user-1",
  });

  return {
    store,
    created,
    audits,
    forks: (input: unknown, extra: Record<string, unknown> = {}) =>
      new CodeSessionForkService(deps).fork({ ctx, companyId: COMPANY, sessionId: SESSION, body: input, ...extra }),
  };
}

describe("security-gate: C10 fork — a branch, not a copy", () => {
  it("creates the new session with parent_session_id and copies the plan as a draft, the todos and the cursor", async () => {
    const h = await forkHarness();
    const outcome = await h.forks({});
    expect(outcome.status).toBe("forked");
    expect(outcome.parentSessionId).toBe(SESSION);
    expect(outcome.sessionId).toBe("session-fork-1");
    expect(outcome.checkpointId).toBeNull();
    expect(outcome.copied).toEqual({
      plan: true, planRevision: 1, todos: true, todoCount: 2, conversationHead: true, goal: false,
    });
    expect(outcome.goalCopyReason).toContain("execution record");

    // The session-creation rules still apply: the parent is passed to the service that owns session creation.
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ companyId: COMPANY, projectId: PROJECT });
    expect((h.created[0]!.input as { parentSessionId?: string }).parentSessionId).toBe(SESSION);
    expect((h.created[0]!.input as { mode?: string }).mode).toBe("auto");
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ action: "code.session.fork", resourceId: SESSION });

    // The plan body travelled, the decision did not: approving is a decision about a session.
    const plan = await h.store.getLatestCodeSessionPlan(COMPANY, "session-fork-1");
    expect(plan?.status).toBe("draft");
    expect(plan?.executionMode).toBeNull();
    expect(plan?.plan.steps).toEqual(["change a"]);

    const todos = await h.store.listCodeSessionTodos({ companyId: COMPANY, sessionId: "session-fork-1" });
    expect(todos.map((todo) => `${todo.taskId}:${todo.status}`)).toEqual(["t1:completed", "t2:in_progress"]);

    const head = await h.store.getCodeSessionHead(COMPANY, "session-fork-1");
    expect(head?.turnIndex).toBe(2);
    expect(head?.reason).toBe("fork");
    expect(head?.runId).toBe(RUN);

    // The lineage is durable and tenant-scoped.
    const forks = await h.store.listCodeSessionForks({ companyId: COMPANY, parentSessionId: SESSION });
    expect(forks).toHaveLength(1);
    expect(forks[0]!.sessionId).toBe("session-fork-1");
    expect(await h.store.listCodeSessionForks({ companyId: "company-2", parentSessionId: SESSION })).toHaveLength(0);
  });

  it("is idempotent by operation id: a repeated fork never creates a second session", async () => {
    const h = await forkHarness();
    const first = await h.forks({ operationId: "fork-fixed" });
    expect(first.status).toBe("forked");
    const second = await h.forks({ operationId: "fork-fixed" });
    expect(second.status).toBe("already_forked");
    expect(second.idempotentReplay).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(h.created).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it("derives the same operation id from the same branch point, so a retry needs no key", async () => {
    const h = await forkHarness();
    const first = await h.forks({});
    const second = await h.forks({});
    expect(second.operationId).toBe(first.operationId);
    expect(second.status).toBe("already_forked");
    expect(h.created).toHaveLength(1);
  });

  it("refuses a checkpoint of another project like a missing one", async () => {
    const h = await forkHarness({ checkpointForeign: true });
    await expect(h.forks({ checkpointId: "cp-1" })).rejects.toMatchObject({
      code: "checkpoint_not_found", httpStatus: 404, details: {},
    });
    expect(h.created).toHaveLength(0);
  });

  it("refuses a stale session revision before creating anything", async () => {
    const h = await forkHarness();
    await expect(h.forks({ expectedRevision: 99 })).rejects.toMatchObject({
      code: "session_revision_conflict", httpStatus: 409, retryable: true,
    });
    expect(h.created).toHaveLength(0);
  });

  it("is refused when its feature flag is off, and answers a foreign session with the same 404", async () => {
    const h = await forkHarness({ flagsEnabled: false });
    await expect(h.forks({})).rejects.toMatchObject({ code: "feature_disabled" });
    expect(h.created).toHaveLength(0);
    expect(CODE_SESSION_DURABILITY_FLAGS.fork).toBe("code.session_fork");

    const foreign = await forkHarness();
    await expect(foreign.forks({}, { sessionId: "session-foreign" }))
      .rejects.toBeInstanceOf(WorkspaceNotFoundError);
    expect(foreign.created).toHaveLength(0);
  });
});

describe("security-gate: C10 — the append-only recording is not what a rewind edits", () => {
  it("keeps the replay bundle format version and the replay-input hash unchanged", async () => {
    const store = new InMemoryWorkspaceStore();
    const recorder = new ReplayBundleRecorder({
      store: store as unknown as never,
      context: {
        workspaceId: "ws-1", companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, runId: RUN,
        executionSnapshotId: null, runnerVersion: "runner-1", systemPromptVersion: 1,
        systemPromptContentHash: "sha256:prompt", modelProfileVersion: 1, provider: "provider-a", model: "model-a",
        replayMode: "recorded", dataClassification: "confidential", retentionClass: "standard",
      },
      toolOutputChars: 4_000,
      now: () => new Date(T0),
    });
    recorder.recordModelStep({
      turnIndex: 1,
      request: {
        model: "model-a", messageCount: 2, toolNames: ["code.fs.edit"],
        idempotencyKey: "session-1:run-1:1", dataClassification: "confidential",
      },
      response: {
        content: "hello", finishReason: "tool_calls", model: "model-a", provider: "provider-a",
        usage: { totalTokens: 5, promptTokens: 3, completionTokens: 2 },
        toolCalls: [{ id: "call-1", name: "code.fs.edit", argumentsHash: "sha256:args" }],
      },
    });
    recorder.recordToolCall({
      turnIndex: 1, toolCallId: "call-1", tool: "code.fs.edit", toolVersion: 1,
      argumentsHash: "sha256:args", settledResult: '{"ok":true,"tool":"code.fs.edit"}',
      outcome: "ok", truncated: false, durationMs: 3,
    });
    expect(await recorder.finalize({ terminalStatus: "completed", terminalReason: "completed" }))
      .toMatchObject({ written: true });

    // Pinned: C10 does not touch the recording, so the format version and the derived hash of this exact exchange
    // are byte-for-byte what they were before this step.
    expect(REPLAY_BUNDLE_FORMAT_VERSION).toBe(3);
    const bundle = await store.getReplayBundle(COMPANY, RUN);
    expect(bundle?.replayInputHash).toBe("sha256:579374f118457967140d5f0cadb61f1a9bb004b8fa8fe7656938ea6e6d8fab17");

    const steps = await store.listReplayBundleSteps(COMPANY, bundle!.id);
    const payloads = steps.map((step) => step.payload);
    expect(replayInputHash(payloads as never)).toBe(bundle?.replayInputHash);

    // A raw artifact is excluded from the hash input, so an untruncated payload cannot influence a replay.
    const withArtifact = [{ ...(payloads[0] as Record<string, unknown>), rawArtifact: "VERY LONG RAW OUTPUT" }];
    expect(replayInputHash(withArtifact as never)).toBe(replayInputHash([payloads[0]] as never));
  });

  it("keeps both ledgers and the cursor as the only durable writes a rewind makes", async () => {
    const h = await rewindHarness();
    await h.rewinds({ target: "both", turnIndex: 3 });
    // What a rewind wrote: the cursor, the ledger row. The run's turns and the session are untouched, and there is
    // no API on the store that could rewrite a replay bundle, a snapshot, an Activity event or a summary.
    const head = await h.store.getCodeSessionHead(COMPANY, SESSION);
    expect(head?.turnIndex).toBe(3);
    const turns = await h.store.listCodeRunTurns(COMPANY, RUN);
    expect(turns.map((turn) => turn.checkpointId)).toEqual(["cp-1", null, "cp-3"]);
    expect(typeof (h.store as unknown as { updateCodeContextSummary?: unknown }).updateCodeContextSummary).toBe("undefined");
    expect(typeof (h.store as unknown as { deleteCodeContextSummary?: unknown }).deleteCodeContextSummary).toBe("undefined");
    expect(typeof (h.store as unknown as { updateReplayBundle?: unknown }).updateReplayBundle).toBe("undefined");
    expect(typeof (h.store as unknown as { deleteCodeRunRecoveryNotice?: unknown }).deleteCodeRunRecoveryNotice).toBe("undefined");
  });

  it("exposes the durability refusals as structured errors a route can map", () => {
    const error = new CodeSessionDurabilityError("turn_has_no_checkpoint", "no checkpoint", 409, { turnIndex: 2 });
    expect(error.code).toBe("turn_has_no_checkpoint");
    expect(error.httpStatus).toBe(409);
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ turnIndex: 2 });
  });
});
