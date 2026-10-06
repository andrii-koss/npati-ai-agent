import { randomUUID } from "node:crypto";
import type { DataClassification, RetentionClass } from "./types";

/**
 * C9: `code.ask_user` — the persistent structured question.
 *
 * A question is not a message in a transcript: it is a **state** the run waits in. That distinction is the whole
 * point of this module, and it is why the row (not the process) is the source of truth:
 *
 *   - the run moves to `waiting_for_user`, which is a valid non-terminal state — the reconciler must not treat
 *     it as a lease that expired, must not mark it failed, and must not replay the tool call that asked;
 *   - a pending question therefore survives a restart: the answer arrives later, from a different process, and
 *     finds the question by id;
 *   - the answer is accepted **once**. A repeat of the same submission is an idempotent no-op (the user's client
 *     retried, or two tabs raced); a *different* answer to an already-decided question is refused, because
 *     resuming twice would run the same turn against two different decisions.
 *
 * The rules live here, in one place shared by the Postgres and in-memory backends, for the same reason the goal
 * rules do: a rule that exists only in SQL silently stops applying on the fast path (tests, in-memory), and then
 * "the database guarantees it" means nothing.
 */

export const CODE_USER_QUESTION_STATUSES = ["pending", "answered", "expired", "cancelled"] as const;
export type CodeUserQuestionStatus = (typeof CODE_USER_QUESTION_STATUSES)[number];

/** A choice offered to the user. `id` is what comes back; the label is only ever displayed. */
export interface CodeUserQuestionChoice {
  id: string;
  label: string;
  description?: string;
}

export interface CodeUserQuestionAnswer {
  choiceId?: string;
  freeAnswer?: string;
}

export interface CodeUserQuestionRecord {
  id: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  /** The tool call that asked. Unique per run, which is what makes a repeated call idempotent. */
  toolCallId: string;
  prompt: string;
  choices: CodeUserQuestionChoice[];
  /** True when a free-form answer is accepted as well as (or instead of) the offered choices. */
  allowFreeAnswer: boolean;
  status: CodeUserQuestionStatus;
  answer: CodeUserQuestionAnswer | null;
  answeredBy: string | null;
  answeredAt: Date | null;
  revision: number;
  createdAt: Date;
  expiresAt: Date;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
}

export interface CreateCodeUserQuestionInput {
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  prompt: string;
  choices: CodeUserQuestionChoice[];
  allowFreeAnswer?: boolean;
  /** Time to live. Defaults to 24h; the caller may shorten it but never extend it past the maximum. */
  ttlMs?: number;
  createdBy?: string | null;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  now?: Date;
  id?: string;
}

export interface AnswerCodeUserQuestionInput {
  companyId: string;
  questionId: string;
  /** Optimistic concurrency: the revision the user was shown. */
  expectedRevision: number;
  choiceId?: string;
  freeAnswer?: string;
  answeredBy: string;
  now?: Date;
}

export const MAX_QUESTION_PROMPT_CHARS = 2000;
export const MAX_QUESTION_CHOICES = 10;
export const MAX_QUESTION_ANSWER_CHARS = 2000;
export const MAX_QUESTION_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_QUESTION_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_DATA_CLASSIFICATION: DataClassification = "confidential";
/** Shorter than a transcript: a question is operational, and once answered its value is the answer, not the ask. */
const DEFAULT_RETENTION_CLASS: RetentionClass = "short";

/** Raised for an unknown question, and for a question of another tenant (the two are indistinguishable). */
export class CodeUserQuestionNotFoundError extends Error {
  readonly code = "question_not_found";
  readonly httpStatus = 404;
  readonly retryable = false;
  readonly details: Record<string, unknown>;
  constructor(details: Record<string, unknown> = {}) {
    super("Question not found");
    this.name = "CodeUserQuestionNotFoundError";
    this.details = details;
  }
}

/** Raised when the question is no longer answerable (already answered with a different answer, expired, cancelled). */
export class CodeUserQuestionStateError extends Error {
  readonly code = "question_not_pending";
  readonly httpStatus = 409;
  readonly retryable = false;
  readonly details: Record<string, unknown>;
  constructor(reason: string, details: Record<string, unknown> = {}) {
    super(reason);
    this.name = "CodeUserQuestionStateError";
    this.details = { reason, ...details };
  }
}

/** Raised when the submitted answer is not one the server is willing to accept. */
export class CodeUserQuestionAnswerInvalidError extends Error {
  readonly code = "question_answer_invalid";
  readonly httpStatus = 400;
  readonly retryable = false;
  readonly details: Record<string, unknown>;
  constructor(reason: string, details: Record<string, unknown> = {}) {
    super(reason);
    this.name = "CodeUserQuestionAnswerInvalidError";
    this.details = { reason, ...details };
  }
}

export class CodeUserQuestionRevisionConflictError extends Error {
  readonly code = "question_revision_conflict";
  readonly httpStatus = 409;
  readonly retryable = true;
  readonly details: Record<string, unknown>;
  constructor(details: Record<string, unknown> = {}) {
    super("Question revision conflict");
    this.name = "CodeUserQuestionRevisionConflictError";
    this.details = details;
  }
}

/**
 * The server-side answer validation. The UI validates the same things, and that is exactly why this exists: a
 * client check is a convenience, never a boundary. In particular a `choiceId` that this question never offered
 * is refused — otherwise a stale or forged card could answer with an option nobody proposed, and the model would
 * act on a decision the user never made.
 */
export function validateQuestionAnswer(
  question: Pick<CodeUserQuestionRecord, "status" | "choices" | "allowFreeAnswer">,
  input: { choiceId?: string; freeAnswer?: string },
): CodeUserQuestionAnswer {
  if (question.status !== "pending") {
    throw new CodeUserQuestionStateError("Question is not pending", { status: question.status });
  }
  const hasChoice = input.choiceId !== undefined && input.choiceId !== null && input.choiceId !== "";
  const hasFree = input.freeAnswer !== undefined && input.freeAnswer !== null && input.freeAnswer.trim() !== "";
  if (hasChoice && hasFree) {
    throw new CodeUserQuestionAnswerInvalidError("Provide either a choice or a free answer, not both");
  }
  if (!hasChoice && !hasFree) {
    throw new CodeUserQuestionAnswerInvalidError("An answer is required");
  }
  if (hasChoice) {
    const offered = question.choices.some((choice) => choice.id === input.choiceId);
    if (!offered) {
      throw new CodeUserQuestionAnswerInvalidError("Choice was not offered by this question", {
        choiceId: input.choiceId,
        offered: question.choices.map((choice) => choice.id),
      });
    }
    return { choiceId: input.choiceId as string };
  }
  if (!question.allowFreeAnswer) {
    throw new CodeUserQuestionAnswerInvalidError("This question does not accept a free-form answer");
  }
  const trimmed = (input.freeAnswer as string).trim();
  if (trimmed.length > MAX_QUESTION_ANSWER_CHARS) {
    throw new CodeUserQuestionAnswerInvalidError("Free-form answer is too long", {
      length: trimmed.length,
      limit: MAX_QUESTION_ANSWER_CHARS,
    });
  }
  return { freeAnswer: trimmed };
}

/** Normalises and bounds what a tool call may ask, so a model cannot create an unbounded prompt. */
export function validateQuestionRequest(input: {
  prompt: string;
  choices: CodeUserQuestionChoice[];
  allowFreeAnswer?: boolean;
}): { prompt: string; choices: CodeUserQuestionChoice[]; allowFreeAnswer: boolean } {
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) throw new CodeUserQuestionAnswerInvalidError("A question prompt is required");
  if (prompt.length > MAX_QUESTION_PROMPT_CHARS) {
    throw new CodeUserQuestionAnswerInvalidError("Question prompt is too long", {
      length: prompt.length, limit: MAX_QUESTION_PROMPT_CHARS,
    });
  }
  const choices = Array.isArray(input.choices) ? input.choices : [];
  if (choices.length > MAX_QUESTION_CHOICES) {
    throw new CodeUserQuestionAnswerInvalidError("Too many choices", { count: choices.length, limit: MAX_QUESTION_CHOICES });
  }
  const seen = new Set<string>();
  const normalised = choices.map((choice) => {
    const id = String(choice?.id ?? "").trim();
    const label = String(choice?.label ?? "").trim();
    if (!id || !label) throw new CodeUserQuestionAnswerInvalidError("Every choice needs an id and a label");
    if (seen.has(id)) throw new CodeUserQuestionAnswerInvalidError("Duplicate choice id", { choiceId: id });
    seen.add(id);
    const description = choice.description === undefined ? undefined : String(choice.description);
    return { id, label, ...(description === undefined ? {} : { description }) };
  });
  const allowFreeAnswer = input.allowFreeAnswer === true;
  if (normalised.length === 0 && !allowFreeAnswer) {
    // A question nobody could answer is worse than no question: it would pause the run forever.
    throw new CodeUserQuestionAnswerInvalidError("A question needs at least one choice or a free-form answer");
  }
  return { prompt, choices: normalised, allowFreeAnswer };
}

export function questionTtlMs(input: number | undefined): number {
  if (input === undefined) return DEFAULT_QUESTION_TTL_MS;
  if (!Number.isFinite(input) || input <= 0) return DEFAULT_QUESTION_TTL_MS;
  return Math.min(Math.trunc(input), MAX_QUESTION_TTL_MS);
}

/** Sanity check used by both backends before an INSERT, so a bad row never reaches either store. */
export function prepareQuestionRow(input: CreateCodeUserQuestionInput): {
  record: Omit<CodeUserQuestionRecord, "answer" | "answeredBy" | "answeredAt">;
} {
  if (!input.companyId || !input.projectId || !input.sessionId || !input.runId || !input.toolCallId) {
    throw new CodeUserQuestionAnswerInvalidError("Question requires company, project, session, run and tool call");
  }
  const { prompt, choices, allowFreeAnswer } = validateQuestionRequest(input);
  const now = input.now ?? new Date();
  return {
    record: {
      id: input.id ?? randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      prompt,
      choices,
      allowFreeAnswer,
      status: "pending",
      revision: 1,
      createdAt: now,
      expiresAt: new Date(now.getTime() + questionTtlMs(input.ttlMs)),
      dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
      retentionClass: input.retentionClass ?? DEFAULT_RETENTION_CLASS,
    },
  };
}

/**
 * The decision procedure an answer goes through, shared by both backends.
 *
 * Idempotency is decided here, not by the caller: a repeat of the *same* answer by the *same* user returns the
 * existing record untouched (so a retrying client cannot resume a run twice), while a *different* answer to an
 * already-decided question is a conflict rather than a silent overwrite.
 */
export function resolveAnswerTransition(
  question: CodeUserQuestionRecord & { answer: CodeUserQuestionAnswer | null },
  input: AnswerCodeUserQuestionInput,
): { kind: "idempotent" } | { kind: "apply"; answer: CodeUserQuestionAnswer; now: Date } {
  const now = input.now ?? new Date();
  if (question.status === "pending") {
    if (input.expectedRevision !== question.revision) {
      throw new CodeUserQuestionRevisionConflictError({
        expectedRevision: input.expectedRevision, actualRevision: question.revision,
      });
    }
    if (question.expiresAt.getTime() <= now.getTime()) {
      // Never answer an expired question on the user's behalf: an expired question is a question the user did
      // not answer, and guessing on their behalf is the one outcome the owner forbade.
      throw new CodeUserQuestionStateError("Question has expired", { expiresAt: question.expiresAt.toISOString() });
    }
    const answer = validateQuestionAnswer(question, input);
    return { kind: "apply", answer, now };
  }
  if (question.status === "answered") {
    const sameChoice = (question.answer?.choiceId ?? null) === (input.choiceId ?? null);
    const sameFree = (question.answer?.freeAnswer ?? null) === (input.freeAnswer ?? null);
    const sameUser = (question.answeredBy ?? null) === input.answeredBy;
    if (sameChoice && sameFree) {
      if (!sameUser) {
        // The same answer from a different principal is still a second decision being recorded; the question is
        // already decided, so this is a conflict rather than an idempotent retry.
        throw new CodeUserQuestionStateError("Question was already answered by another user", { status: question.status });
      }
      return { kind: "idempotent" };
    }
    throw new CodeUserQuestionStateError("Question was already answered with a different answer", { status: question.status });
  }
  throw new CodeUserQuestionStateError("Question is not pending", { status: question.status });
}

interface QuestionRow {
  id: string; company_id: string; project_id: string; session_id: string; run_id: string; tool_call_id: string;
  prompt: string; choices: unknown; allow_free_answer: boolean; status: string; answer: unknown;
  answered_by: string | null; answered_at: Date | null; revision: number; created_at: Date; expires_at: Date;
  data_classification: string; retention_class: string;
}

function toQuestion(row: QuestionRow): CodeUserQuestionRecord {
  const choices = Array.isArray(row.choices) ? (row.choices as CodeUserQuestionChoice[]) : [];
  const answer = row.answer && typeof row.answer === "object" ? (row.answer as CodeUserQuestionAnswer) : null;
  return {
    id: row.id,
    companyId: row.company_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    prompt: row.prompt,
    choices,
    allowFreeAnswer: row.allow_free_answer === true,
    status: row.status as CodeUserQuestionStatus,
    answer,
    answeredBy: row.answered_by,
    answeredAt: row.answered_at,
    revision: row.revision,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    dataClassification: row.data_classification as DataClassification,
    retentionClass: row.retention_class as RetentionClass,
  };
}

const QUESTION_COLUMNS = `id, company_id, project_id, session_id, run_id, tool_call_id, prompt, choices,
  allow_free_answer, status, answer, answered_by, answered_at, revision, created_at, expires_at,
  data_classification, retention_class`;

export interface CodeQuestionQueryable {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export class PostgresCodeUserQuestionStore {
  constructor(private readonly pool: CodeQuestionQueryable) {}

  private async load(companyId: string, id: string, runId?: string): Promise<CodeUserQuestionRecord | null> {
    const values: unknown[] = [companyId, id];
    let clause = "company_id=$1 AND id=$2";
    if (runId !== undefined) { values.push(runId); clause += ` AND run_id=$${values.length}`; }
    const result = await this.pool.query<QuestionRow>(`SELECT ${QUESTION_COLUMNS} FROM code_user_questions WHERE ${clause}`, values);
    const row = result.rows[0];
    return row ? toQuestion(row) : null;
  }

  async getQuestion(companyId: string, id: string): Promise<CodeUserQuestionRecord | null> {
    return this.load(companyId, id);
  }

  async getPendingQuestionForRun(companyId: string, runId: string): Promise<CodeUserQuestionRecord | null> {
    const result = await this.pool.query<QuestionRow>(
      `SELECT ${QUESTION_COLUMNS} FROM code_user_questions
        WHERE company_id=$1 AND run_id=$2 AND status='pending' ORDER BY created_at ASC LIMIT 1`,
      [companyId, runId],
    );
    const row = result.rows[0];
    return row ? toQuestion(row) : null;
  }

  /**
   * Creates the question, or returns the one the same tool call already created. Idempotency by
   * `(company, run, tool_call_id)` is what makes the call safe for C6a recovery to repeat — although it is *not*
   * in the read-only set, so the reconciler never repeats it on its own.
   */
  async createQuestion(input: CreateCodeUserQuestionInput): Promise<CodeUserQuestionRecord> {
    const { record } = prepareQuestionRow(input);
    const inserted = await this.pool.query<QuestionRow>(
      `INSERT INTO code_user_questions (id, company_id, project_id, session_id, run_id, tool_call_id, prompt,
         choices, allow_free_answer, status, answer, answered_by, answered_at, revision, created_at, expires_at,
         data_classification, retention_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'pending',NULL,NULL,NULL,1,$10,$11,$12,$13)
       ON CONFLICT (company_id, run_id, tool_call_id) DO NOTHING
       RETURNING ${QUESTION_COLUMNS}`,
      [record.id, record.companyId, record.projectId, record.sessionId, record.runId, record.toolCallId,
        record.prompt, JSON.stringify(record.choices), record.allowFreeAnswer, record.createdAt, record.expiresAt,
        record.dataClassification, record.retentionClass],
    );
    const row = inserted.rows[0];
    if (row) return toQuestion(row);
    const existing = await this.pool.query<QuestionRow>(
      `SELECT ${QUESTION_COLUMNS} FROM code_user_questions WHERE company_id=$1 AND run_id=$2 AND tool_call_id=$3`,
      [record.companyId, record.runId, record.toolCallId],
    );
    const conflict = existing.rows[0];
    if (!conflict) throw new CodeUserQuestionNotFoundError({ toolCallId: record.toolCallId });
    return toQuestion(conflict);
  }

  async answerQuestion(input: AnswerCodeUserQuestionInput): Promise<CodeUserQuestionRecord> {
    const current = await this.load(input.companyId, input.questionId);
    if (!current) throw new CodeUserQuestionNotFoundError({ questionId: input.questionId });
    const transition = resolveAnswerTransition(current, input);
    if (transition.kind === "idempotent") return current;
    const updated = await this.pool.query<QuestionRow>(
      `UPDATE code_user_questions
          SET status='answered', answer=$4::jsonb, answered_by=$5, answered_at=$6, revision=revision+1
        WHERE company_id=$1 AND id=$2 AND status='pending' AND revision=$3
        RETURNING ${QUESTION_COLUMNS}`,
      [input.companyId, input.questionId, input.expectedRevision, JSON.stringify(transition.answer),
        input.answeredBy, transition.now],
    );
    const row = updated.rows[0];
    if (!row) throw new CodeUserQuestionRevisionConflictError({ questionId: input.questionId });
    return toQuestion(row);
  }

  /** Expires pending questions past their TTL. Returns how many moved, so the caller can report it honestly. */
  async expireQuestions(input: { now?: Date; companyId?: string; runId?: string } = {}): Promise<number> {
    const now = input.now ?? new Date();
    const values: unknown[] = [now];
    const clauses = ["status='pending'", "expires_at <= $1"];
    if (input.companyId) { values.push(input.companyId); clauses.push(`company_id=$${values.length}`); }
    if (input.runId) { values.push(input.runId); clauses.push(`run_id=$${values.length}`); }
    const result = await this.pool.query<{ id: string }>(
      `UPDATE code_user_questions SET status='expired', revision=revision+1
        WHERE ${clauses.join(" AND ")} RETURNING id`, values);
    return result.rows.length;
  }

  /**
   * The pending questions a given instant has already outlived. Ordered oldest-first and bounded, so a reaper
   * pass is deterministic and cannot be made unbounded by a backlog. Read-only: the caller decides what to do,
   * and expiring a question without releasing its run would leave a run waiting on a question that can no
   * longer be answered.
   */
  async listExpiredQuestions(input: { now?: Date; limit?: number } = {}): Promise<CodeUserQuestionRecord[]> {
    const now = input.now ?? new Date();
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 100;
    const result = await this.pool.query<QuestionRow>(
      `SELECT ${QUESTION_COLUMNS} FROM code_user_questions
        WHERE status='pending' AND expires_at <= $1
        ORDER BY expires_at ASC, id ASC LIMIT $2`,
      [now, limit],
    );
    return result.rows.map(toQuestion);
  }

  async cancelPendingQuestions(input: { companyId: string; runId: string; now?: Date }): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `UPDATE code_user_questions SET status='cancelled', revision=revision+1
        WHERE company_id=$1 AND run_id=$2 AND status='pending' RETURNING id`,
      [input.companyId, input.runId],
    );
    return result.rows.length;
  }
}

export class InMemoryCodeUserQuestionStore {
  private readonly rows = new Map<string, CodeUserQuestionRecord>();

  async getQuestion(companyId: string, id: string): Promise<CodeUserQuestionRecord | null> {
    const row = this.rows.get(id);
    return row && row.companyId === companyId ? { ...row } : null;
  }

  async getPendingQuestionForRun(companyId: string, runId: string): Promise<CodeUserQuestionRecord | null> {
    const found = [...this.rows.values()]
      .filter((row) => row.companyId === companyId && row.runId === runId && row.status === "pending")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    return found ? { ...found } : null;
  }

  async createQuestion(input: CreateCodeUserQuestionInput): Promise<CodeUserQuestionRecord> {
    const { record } = prepareQuestionRow(input);
    const existing = [...this.rows.values()].find((row) =>
      row.companyId === record.companyId && row.runId === record.runId && row.toolCallId === record.toolCallId);
    if (existing) return { ...existing };
    const full: CodeUserQuestionRecord = { ...record, answer: null, answeredBy: null, answeredAt: null };
    this.rows.set(full.id, full);
    return { ...full };
  }

  async answerQuestion(input: AnswerCodeUserQuestionInput): Promise<CodeUserQuestionRecord> {
    const current = await this.getQuestion(input.companyId, input.questionId);
    if (!current) throw new CodeUserQuestionNotFoundError({ questionId: input.questionId });
    const transition = resolveAnswerTransition(current, input);
    if (transition.kind === "idempotent") return current;
    const updated: CodeUserQuestionRecord = {
      ...current,
      status: "answered",
      answer: transition.answer,
      answeredBy: input.answeredBy,
      answeredAt: transition.now,
      revision: current.revision + 1,
    };
    this.rows.set(updated.id, updated);
    return { ...updated };
  }

  async expireQuestions(input: { now?: Date; companyId?: string; runId?: string } = {}): Promise<number> {
    const now = (input.now ?? new Date()).getTime();
    let moved = 0;
    for (const [id, row] of this.rows) {
      if (row.status !== "pending") continue;
      if (input.companyId && row.companyId !== input.companyId) continue;
      if (input.runId && row.runId !== input.runId) continue;
      if (row.expiresAt.getTime() > now) continue;
      this.rows.set(id, { ...row, status: "expired", revision: row.revision + 1 });
      moved += 1;
    }
    return moved;
  }

  async cancelPendingQuestions(input: { companyId: string; runId: string; now?: Date }): Promise<number> {
    let moved = 0;
    for (const [id, row] of this.rows) {
      if (row.status !== "pending" || row.companyId !== input.companyId || row.runId !== input.runId) continue;
      this.rows.set(id, { ...row, status: "cancelled", revision: row.revision + 1 });
      moved += 1;
    }
    return moved;
  }

  /** The same read the Postgres backend offers, with the same ordering and bound, so the reaper behaves alike. */
  async listExpiredQuestions(input: { now?: Date; limit?: number } = {}): Promise<CodeUserQuestionRecord[]> {
    const now = (input.now ?? new Date()).getTime();
    const limit = Number.isFinite(input.limit) && Number(input.limit) > 0 ? Math.trunc(Number(input.limit)) : 100;
    return [...this.rows.values()]
      .filter((row) => row.status === "pending" && row.expiresAt.getTime() <= now)
      .sort((a, b) => (a.expiresAt.getTime() - b.expiresAt.getTime()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }
}
