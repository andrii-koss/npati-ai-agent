import {
  type CodeSessionHeadRecord,
  type SetCodeSessionHeadInput,
  type CodeRunRecoveryNoticeRecord,
  type CreateCodeRunRecoveryNoticeInput,
  type CodeSessionRewindRecord,
  type CreateCodeSessionRewindInput,
  type CompleteCodeSessionRewindInput,
  type CodeSessionForkRecord,
  type CreateCodeSessionForkInput,
  type CompleteCodeSessionForkInput,
  CodeSessionHeadRevisionConflictError,
  CodeSessionOperationInProgressError,
  CodeSessionOperationNotFoundError,
  prepareHeadRow,
  prepareNoticeRow,
  prepareRewindRow,
  prepareForkRow,
  claimOperation,
} from "./code-session-durability-types";

export * from "./code-session-durability-types";
export * from "./code-session-durability-postgres";

/**
 * The in-memory backend. It enforces the same three rules the SQL enforces — one head per session, one row per
 * operation id, and a revision-checked update — so a rule cannot be true only in production.
 */
export class InMemoryCodeSessionDurabilityStore {
  private readonly heads = new Map<string, CodeSessionHeadRecord>();
  private readonly notices = new Map<string, CodeRunRecoveryNoticeRecord>();
  private readonly rewinds = new Map<string, CodeSessionRewindRecord>();
  private readonly forks = new Map<string, CodeSessionForkRecord>();

  private headKey(companyId: string, sessionId: string): string { return `${companyId}\u0000${sessionId}`; }
  private operationKey(companyId: string, operationId: string): string { return `${companyId}\u0000${operationId}`; }

  async getHead(companyId: string, sessionId: string): Promise<CodeSessionHeadRecord | null> {
    const row = this.heads.get(this.headKey(companyId, sessionId));
    return row ? { ...row } : null;
  }

  async setHead(input: SetCodeSessionHeadInput): Promise<CodeSessionHeadRecord> {
    const row = prepareHeadRow(input);
    const key = this.headKey(row.companyId, row.sessionId);
    const current = this.heads.get(key);
    if (current) {
      if (current.revision !== input.expectedRevision || current.projectId !== row.projectId) {
        throw new CodeSessionHeadRevisionConflictError({ sessionId: row.sessionId, expectedRevision: input.expectedRevision, currentRevision: current.revision });
      }
      const next: CodeSessionHeadRecord = {
        ...current,
        runId: row.runId ?? current.runId,
        turnIndex: row.turnIndex,
        reason: row.reason,
        operationId: row.operationId,
        revision: current.revision + 1,
        updatedAt: row.updatedAt,
        dataClassification: row.dataClassification,
        retentionClass: row.retentionClass,
      };
      this.heads.set(key, next);
      return { ...next };
    }
    if (input.expectedRevision !== 0) {
      throw new CodeSessionHeadRevisionConflictError({ sessionId: row.sessionId, expectedRevision: input.expectedRevision, currentRevision: 0 });
    }
    this.heads.set(key, row);
    return { ...row };
  }

  async createNotice(input: CreateCodeRunRecoveryNoticeInput): Promise<CodeRunRecoveryNoticeRecord> {
    const row = prepareNoticeRow(input);
    this.notices.set(row.id, row);
    return { ...row };
  }

  async getLatestNotice(companyId: string, runId: string): Promise<CodeRunRecoveryNoticeRecord | null> {
    const found = [...this.notices.values()]
      .filter((row) => row.companyId === companyId && row.runId === runId)
      .sort((a, b) => (b.createdAt.getTime() - a.createdAt.getTime()) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0];
    return found ? { ...found } : null;
  }

  async listNotices(input: { companyId: string; runId: string; limit?: number }): Promise<CodeRunRecoveryNoticeRecord[]> {
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 20;
    return [...this.notices.values()]
      .filter((row) => row.companyId === input.companyId && row.runId === input.runId)
      .sort((a, b) => (b.createdAt.getTime() - a.createdAt.getTime()) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, Math.min(limit, 200))
      .map((row) => ({ ...row }));
  }

  async createRewind(input: CreateCodeSessionRewindInput): Promise<{ record: CodeSessionRewindRecord; replayed: boolean }> {
    const row = prepareRewindRow(input);
    const key = this.operationKey(row.companyId, row.operationId);
    const existing = this.rewinds.get(key);
    if (existing) {
      if (existing.status === "pending") throw new CodeSessionOperationInProgressError(row.operationId);
      return { record: { ...existing }, replayed: true };
    }
    this.rewinds.set(key, row);
    return { record: { ...row }, replayed: false };
  }

  async getRewind(companyId: string, operationId: string): Promise<CodeSessionRewindRecord | null> {
    const row = this.rewinds.get(this.operationKey(companyId, operationId));
    return row ? { ...row } : null;
  }

  async completeRewind(input: CompleteCodeSessionRewindInput): Promise<CodeSessionRewindRecord> {
    const key = this.operationKey(input.companyId, input.operationId);
    const current = this.rewinds.get(key);
    if (!current) throw new CodeSessionOperationNotFoundError({ operationId: input.operationId });
    if (current.status !== "pending") return { ...current };
    const next: CodeSessionRewindRecord = {
      ...current,
      status: input.status,
      restoredCheckpointId: input.restoredCheckpointId ?? current.restoredCheckpointId,
      safetyCheckpointId: input.safetyCheckpointId ?? current.safetyCheckpointId,
      headTurn: input.headTurn ?? current.headTurn,
      failureReason: input.failureReason ?? null,
      finishedAt: input.now ?? new Date(),
    };
    this.rewinds.set(key, next);
    return { ...next };
  }

  async listRewinds(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionRewindRecord[]> {
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 20;
    return [...this.rewinds.values()]
      .filter((row) => row.companyId === input.companyId && row.sessionId === input.sessionId)
      .sort((a, b) => (b.createdAt.getTime() - a.createdAt.getTime()) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, Math.min(limit, 200))
      .map((row) => ({ ...row }));
  }

  /** Same rule as the Postgres backend: only a claim that provably changed nothing may be reopened. */
  async reopenRewind(input: {
    companyId: string;
    operationId: string;
    staleMs?: number;
    now?: Date;
  }): Promise<{ record: CodeSessionRewindRecord | null; reopened: boolean }> {
    const key = this.operationKey(input.companyId, input.operationId);
    const current = this.rewinds.get(key);
    if (!current) return { record: null, reopened: false };
    const untouched = current.safetyCheckpointId === null
      && current.restoredCheckpointId === null
      && current.headTurn === null;
    const now = (input.now ?? new Date()).getTime();
    const stale = current.status === "pending" && current.createdAt.getTime() < now - (input.staleMs ?? 0);
    if (!untouched || (current.status !== "failed" && !stale)) {
      return { record: { ...current }, reopened: false };
    }
    const next: CodeSessionRewindRecord = { ...current, status: "pending", failureReason: null, finishedAt: null };
    this.rewinds.set(key, next);
    return { record: { ...next }, reopened: true };
  }

  async createFork(input: CreateCodeSessionForkInput): Promise<{ record: CodeSessionForkRecord; replayed: boolean }> {
    const row = prepareForkRow(input);
    const key = this.operationKey(row.companyId, row.operationId);
    const existing = this.forks.get(key);
    if (existing) {
      if (existing.status === "pending") throw new CodeSessionOperationInProgressError(row.operationId);
      return { record: { ...existing }, replayed: true };
    }
    this.forks.set(key, row);
    return { record: { ...row }, replayed: false };
  }

  async getFork(companyId: string, operationId: string): Promise<CodeSessionForkRecord | null> {
    const row = this.forks.get(this.operationKey(companyId, operationId));
    return row ? { ...row } : null;
  }

  async completeFork(input: CompleteCodeSessionForkInput): Promise<CodeSessionForkRecord> {
    const key = this.operationKey(input.companyId, input.operationId);
    const current = this.forks.get(key);
    if (!current) throw new CodeSessionOperationNotFoundError({ operationId: input.operationId });
    if (current.status !== "pending") return { ...current };
    const next: CodeSessionForkRecord = {
      ...current,
      status: input.status,
      sessionId: input.sessionId ?? current.sessionId,
      copiedPlan: input.copiedPlan === true,
      copiedTodos: input.copiedTodos === true,
      copiedHead: input.copiedHead === true,
      copiedGoal: input.copiedGoal === true,
      planRevision: input.planRevision ?? null,
      todoCount: input.todoCount ?? 0,
      failureReason: input.failureReason ?? null,
      finishedAt: input.now ?? new Date(),
    };
    this.forks.set(key, next);
    return { ...next };
  }

  async listForks(input: { companyId: string; parentSessionId: string; limit?: number }): Promise<CodeSessionForkRecord[]> {
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 20;
    return [...this.forks.values()]
      .filter((row) => row.companyId === input.companyId && row.parentSessionId === input.parentSessionId)
      .sort((a, b) => (b.createdAt.getTime() - a.createdAt.getTime()) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, Math.min(limit, 200))
      .map((row) => ({ ...row }));
  }

  /** Same rule as the Postgres backend: only a claim that created no session may be reopened. */
  async reopenFork(input: {
    companyId: string;
    operationId: string;
    staleMs?: number;
    now?: Date;
  }): Promise<{ record: CodeSessionForkRecord | null; reopened: boolean }> {
    const key = this.operationKey(input.companyId, input.operationId);
    const current = this.forks.get(key);
    if (!current) return { record: null, reopened: false };
    const noSession = current.sessionId === null;
    const now = (input.now ?? new Date()).getTime();
    const stale = current.status === "pending" && current.createdAt.getTime() < now - (input.staleMs ?? 0);
    if (!noSession || (current.status !== "failed" && !stale)) {
      return { record: { ...current }, reopened: false };
    }
    const next: CodeSessionForkRecord = { ...current, status: "pending", failureReason: null, finishedAt: null };
    this.forks.set(key, next);
    return { record: { ...next }, reopened: true };
  }
}
