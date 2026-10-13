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
  CodeSessionOperationNotFoundError,
  prepareHeadRow,
  prepareNoticeRow,
  prepareRewindRow,
  prepareForkRow,
  claimOperation,
  HEAD_COLUMNS,
  NOTICE_COLUMNS,
  REWIND_COLUMNS,
  FORK_COLUMNS,
  type CodeSessionDurabilityQueryable,
} from "./code-session-durability-types";

export class PostgresCodeSessionDurabilityStore {
  constructor(private readonly pool: CodeSessionDurabilityQueryable) {}

  async getHead(companyId: string, sessionId: string): Promise<CodeSessionHeadRecord | null> {
    const result = await this.pool.query<CodeSessionHeadRecord>(
      `SELECT ${HEAD_COLUMNS} FROM code_session_heads WHERE company_id=$1 AND session_id=$2`,
      [companyId, sessionId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Writes the cursor. `expectedRevision: 0` means "no head yet": the insert wins if nothing is there, and the
   * conditional update is what makes two concurrent rewinds race *visibly* — the loser gets a revision conflict
   * instead of silently overwriting the winner.
   */
  async setHead(input: SetCodeSessionHeadInput): Promise<CodeSessionHeadRecord> {
    const row = prepareHeadRow(input);
    const updated = await this.pool.query<CodeSessionHeadRecord>(
      `UPDATE code_session_heads SET
         run_id=COALESCE($5, run_id), turn_index=$6, reason=$7, operation_id=$8,
         revision=revision+1, updated_at=$9, data_classification=$10, retention_class=$11
       WHERE company_id=$1 AND session_id=$2 AND revision=$3 AND project_id=$4
       RETURNING ${HEAD_COLUMNS}`,
      [row.companyId, row.sessionId, input.expectedRevision, row.projectId, row.runId, row.turnIndex, row.reason,
        row.operationId, row.updatedAt, row.dataClassification, row.retentionClass],
    );
    if (updated.rows[0]) return updated.rows[0];
    const current = await this.getHead(row.companyId, row.sessionId);
    if (current) throw new CodeSessionHeadRevisionConflictError({ sessionId: row.sessionId, expectedRevision: input.expectedRevision, currentRevision: current.revision });
    if (input.expectedRevision !== 0) {
      throw new CodeSessionHeadRevisionConflictError({ sessionId: row.sessionId, expectedRevision: input.expectedRevision, currentRevision: 0 });
    }
    const inserted = await this.pool.query<CodeSessionHeadRecord>(
      `INSERT INTO code_session_heads (id, company_id, project_id, session_id, run_id, turn_index, reason,
         operation_id, revision, created_by, created_at, updated_at, data_classification, retention_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$10,$11,$12)
       ON CONFLICT (company_id, session_id) DO NOTHING
       RETURNING ${HEAD_COLUMNS}`,
      [row.id, row.companyId, row.projectId, row.sessionId, row.runId, row.turnIndex, row.reason, row.operationId,
        row.createdBy, row.createdAt, row.dataClassification, row.retentionClass],
    );
    const created = inserted.rows[0];
    if (!created) throw new CodeSessionHeadRevisionConflictError({ sessionId: row.sessionId, expectedRevision: 0, currentRevision: 1 });
    return created;
  }

  async createNotice(input: CreateCodeRunRecoveryNoticeInput): Promise<CodeRunRecoveryNoticeRecord> {
    const row = prepareNoticeRow(input);
    const result = await this.pool.query<CodeRunRecoveryNoticeRecord>(
      `INSERT INTO code_run_recovery_notices (id, company_id, project_id, session_id, run_id, reason,
         last_finished_turn, replayed_read_only, unknown_outcome, workspace_diff, message_for_model, created_at,
         data_classification, retention_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14)
       RETURNING ${NOTICE_COLUMNS}`,
      [row.id, row.companyId, row.projectId, row.sessionId, row.runId, row.reason, row.lastFinishedTurn,
        JSON.stringify(row.replayedReadOnly), JSON.stringify(row.unknownOutcome),
        row.workspaceDiff === null ? null : JSON.stringify(row.workspaceDiff), row.messageForModel, row.createdAt,
        row.dataClassification, row.retentionClass],
    );
    return result.rows[0]!;
  }

  async getLatestNotice(companyId: string, runId: string): Promise<CodeRunRecoveryNoticeRecord | null> {
    const result = await this.pool.query<CodeRunRecoveryNoticeRecord>(
      `SELECT ${NOTICE_COLUMNS} FROM code_run_recovery_notices
        WHERE company_id=$1 AND run_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [companyId, runId],
    );
    return result.rows[0] ?? null;
  }

  async listNotices(input: { companyId: string; runId: string; limit?: number }): Promise<CodeRunRecoveryNoticeRecord[]> {
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 20;
    const result = await this.pool.query<CodeRunRecoveryNoticeRecord>(
      `SELECT ${NOTICE_COLUMNS} FROM code_run_recovery_notices
        WHERE company_id=$1 AND run_id=$2 ORDER BY created_at DESC, id DESC LIMIT $3`,
      [input.companyId, input.runId, Math.min(limit, 200)],
    );
    return result.rows;
  }

  async createRewind(input: CreateCodeSessionRewindInput): Promise<{ record: CodeSessionRewindRecord; replayed: boolean }> {
    const row = prepareRewindRow(input);
    return claimOperation<CodeSessionRewindRecord, CompleteCodeSessionRewindInput>(
      {
        insert: async (candidate) => {
          const result = await this.pool.query<CodeSessionRewindRecord>(
            `INSERT INTO code_session_rewinds (id, company_id, project_id, session_id, operation_id, target,
               run_id, turn_index, checkpoint_id, previous_head_turn, status, requested_by, created_at,
               data_classification, retention_class)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,$14)
             ON CONFLICT (company_id, operation_id) DO NOTHING
             RETURNING ${REWIND_COLUMNS}`,
            [candidate.id, candidate.companyId, candidate.projectId, candidate.sessionId, candidate.operationId,
              candidate.target, candidate.runId, candidate.turnIndex, candidate.checkpointId,
              candidate.previousHeadTurn, candidate.requestedBy, candidate.createdAt,
              candidate.dataClassification, candidate.retentionClass],
          );
          return result.rows[0] ?? null;
        },
        get: (companyId, operationId) => this.getRewind(companyId, operationId),
        complete: (input) => this.completeRewind(input),
      },
      row,
    );
  }

  async getRewind(companyId: string, operationId: string): Promise<CodeSessionRewindRecord | null> {
    const result = await this.pool.query<CodeSessionRewindRecord>(
      `SELECT ${REWIND_COLUMNS} FROM code_session_rewinds WHERE company_id=$1 AND operation_id=$2`,
      [companyId, operationId],
    );
    return result.rows[0] ?? null;
  }

  async completeRewind(input: CompleteCodeSessionRewindInput): Promise<CodeSessionRewindRecord> {
    const result = await this.pool.query<CodeSessionRewindRecord>(
      `UPDATE code_session_rewinds SET
         status=$3, restored_checkpoint_id=COALESCE($4, restored_checkpoint_id),
         safety_checkpoint_id=COALESCE($5, safety_checkpoint_id), head_turn=COALESCE($6, head_turn),
         failure_reason=$7, finished_at=$8
       WHERE company_id=$1 AND operation_id=$2 AND status='pending'
       RETURNING ${REWIND_COLUMNS}`,
      [input.companyId, input.operationId, input.status, input.restoredCheckpointId ?? null,
        input.safetyCheckpointId ?? null, input.headTurn ?? null, input.failureReason ?? null,
        input.now ?? new Date()],
    );
    const row = result.rows[0];
    if (row) return row;
    const current = await this.getRewind(input.companyId, input.operationId);
    if (!current) throw new CodeSessionOperationNotFoundError({ operationId: input.operationId });
    return current;
  }

  /**
   * Reopens a claim that provably changed nothing, so a retry can perform the operation.
   *
   * Two cases, and both are the residue of a process that died: a `failed` operation with no recorded effect, and
   * a `pending` claim older than the staleness window. The `safety_checkpoint_id IS NULL AND
   * restored_checkpoint_id IS NULL AND head_turn IS NULL` guard is what keeps this safe — an operation that
   * created a checkpoint or moved the cursor is never reopened, because reopening it is exactly how a retry would
   * create a second safety checkpoint.
   */
  async reopenRewind(input: {
    companyId: string;
    operationId: string;
    staleMs?: number;
    now?: Date;
  }): Promise<{ record: CodeSessionRewindRecord | null; reopened: boolean }> {
    const now = input.now ?? new Date();
    const staleBefore = new Date(now.getTime() - (input.staleMs ?? 0));
    const result = await this.pool.query<CodeSessionRewindRecord>(
      `UPDATE code_session_rewinds SET status='pending', failure_reason=NULL, finished_at=NULL
        WHERE company_id=$1 AND operation_id=$2
          AND safety_checkpoint_id IS NULL AND restored_checkpoint_id IS NULL AND head_turn IS NULL
          AND (status='failed' OR (status='pending' AND created_at < $3))
        RETURNING ${REWIND_COLUMNS}`,
      [input.companyId, input.operationId, staleBefore],
    );
    if (result.rows[0]) return { record: result.rows[0], reopened: true };
    return { record: await this.getRewind(input.companyId, input.operationId), reopened: false };
  }

  async listRewinds(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionRewindRecord[]> {
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 20;
    const result = await this.pool.query<CodeSessionRewindRecord>(
      `SELECT ${REWIND_COLUMNS} FROM code_session_rewinds
        WHERE company_id=$1 AND session_id=$2 ORDER BY created_at DESC, id DESC LIMIT $3`,
      [input.companyId, input.sessionId, Math.min(limit, 200)],
    );
    return result.rows;
  }

  async createFork(input: CreateCodeSessionForkInput): Promise<{ record: CodeSessionForkRecord; replayed: boolean }> {
    const row = prepareForkRow(input);
    return claimOperation<CodeSessionForkRecord, CompleteCodeSessionForkInput>(
      {
        insert: async (candidate) => {
          const result = await this.pool.query<CodeSessionForkRecord>(
            `INSERT INTO code_session_forks (id, company_id, project_id, parent_session_id, operation_id,
               run_id, turn_index, checkpoint_id, status, requested_by, created_at,
               data_classification, retention_class)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12)
             ON CONFLICT (company_id, operation_id) DO NOTHING
             RETURNING ${FORK_COLUMNS}`,
            [candidate.id, candidate.companyId, candidate.projectId, candidate.parentSessionId,
              candidate.operationId, candidate.runId, candidate.turnIndex, candidate.checkpointId,
              candidate.requestedBy, candidate.createdAt, candidate.dataClassification,
              candidate.retentionClass],
          );
          return result.rows[0] ?? null;
        },
        get: (companyId, operationId) => this.getFork(companyId, operationId),
        complete: (input) => this.completeFork(input),
      },
      row,
    );
  }

  async getFork(companyId: string, operationId: string): Promise<CodeSessionForkRecord | null> {
    const result = await this.pool.query<CodeSessionForkRecord>(
      `SELECT ${FORK_COLUMNS} FROM code_session_forks WHERE company_id=$1 AND operation_id=$2`,
      [companyId, operationId],
    );
    return result.rows[0] ?? null;
  }

  async completeFork(input: CompleteCodeSessionForkInput): Promise<CodeSessionForkRecord> {
    const result = await this.pool.query<CodeSessionForkRecord>(
      `UPDATE code_session_forks SET
         status=$3, session_id=COALESCE($4, session_id), copied_plan=$5, copied_todos=$6, copied_head=$7,
         copied_goal=$8, plan_revision=$9, todo_count=$10, failure_reason=$11, finished_at=$12
       WHERE company_id=$1 AND operation_id=$2 AND status='pending'
       RETURNING ${FORK_COLUMNS}`,
      [input.companyId, input.operationId, input.status, input.sessionId ?? null,
        input.copiedPlan === true, input.copiedTodos === true, input.copiedHead === true,
        input.copiedGoal === true, input.planRevision ?? null, input.todoCount ?? 0,
        input.failureReason ?? null, input.now ?? new Date()],
    );
    const row = result.rows[0];
    if (row) return row;
    const current = await this.getFork(input.companyId, input.operationId);
    if (!current) throw new CodeSessionOperationNotFoundError({ operationId: input.operationId });
    return current;
  }

  async listForks(input: { companyId: string; parentSessionId: string; limit?: number }): Promise<CodeSessionForkRecord[]> {
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 20;
    const result = await this.pool.query<CodeSessionForkRecord>(
      `SELECT ${FORK_COLUMNS} FROM code_session_forks
        WHERE company_id=$1 AND parent_session_id=$2 ORDER BY created_at DESC, id DESC LIMIT $3`,
      [input.companyId, input.parentSessionId, Math.min(limit, 200)],
    );
    return result.rows;
  }

  /**
   * Reopens a fork claim that provably created no session, so a retry can perform the fork. `session_id IS NULL` is
   * the guard that matters: a claim which already minted a session is never reopened, because reopening it is
   * exactly how a retry would create a second session.
   */
  async reopenFork(input: {
    companyId: string;
    operationId: string;
    staleMs?: number;
    now?: Date;
  }): Promise<{ record: CodeSessionForkRecord | null; reopened: boolean }> {
    const now = input.now ?? new Date();
    const staleBefore = new Date(now.getTime() - (input.staleMs ?? 0));
    const result = await this.pool.query<CodeSessionForkRecord>(
      `UPDATE code_session_forks SET status='pending', failure_reason=NULL, finished_at=NULL
        WHERE company_id=$1 AND operation_id=$2 AND session_id IS NULL
          AND (status='failed' OR (status='pending' AND created_at < $3))
        RETURNING ${FORK_COLUMNS}`,
      [input.companyId, input.operationId, staleBefore],
    );
    if (result.rows[0]) return { record: result.rows[0], reopened: true };
    return { record: await this.getFork(input.companyId, input.operationId), reopened: false };
  }
}
