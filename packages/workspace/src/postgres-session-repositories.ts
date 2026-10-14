import type { Pool } from "pg";
import { PostgresCodeUserQuestionStore } from "./code-question-store.js";
import { PostgresCodeSessionDurabilityStore } from "./code-session-durability-postgres.js";
import { PostgresCodeGoalStore } from "./code-goal-store.js";
import type {
  AnswerCodeUserQuestionInput,
  CodeGoalRecord,
  CodeGoalWithCriteria,
  CodeRunRecoveryNoticeRecord,
  CodeSessionForkRecord,
  CodeSessionHeadRecord,
  CodeSessionPlanRecord,
  CodeSessionRewindRecord,
  CodeSessionTodoRecord,
  CodeUserQuestionRecord,
  CompleteCodeSessionForkInput,
  CompleteCodeSessionRewindInput,
  CreateCodeGoalInput,
  CreateCodeRunRecoveryNoticeInput,
  CreateCodeSessionForkInput,
  CreateCodeSessionPlanInput,
  CreateCodeSessionRewindInput,
  CreateCodeUserQuestionInput,
  DecideCodeSessionPlanInput,
  ReplaceCodeSessionTodosInput,
  SetCodeGoalCriterionStatusInput,
  SetCodeSessionHeadInput,
  UpdateCodeGoalInput,
} from "./types.js";

export class PostgresSessionRepositories {
  private questionsInstance?: PostgresCodeUserQuestionStore;
  private durabilityInstance?: PostgresCodeSessionDurabilityStore;
  private goalsInstance?: PostgresCodeGoalStore;

  constructor(private readonly pool: Pool) {}

  private questions(): PostgresCodeUserQuestionStore {
    return this.questionsInstance ??= new PostgresCodeUserQuestionStore(this.pool);
  }

  private durability(): PostgresCodeSessionDurabilityStore {
    return this.durabilityInstance ??= new PostgresCodeSessionDurabilityStore(this.pool);
  }

  private goals(): PostgresCodeGoalStore {
    return this.goalsInstance ??= new PostgresCodeGoalStore(this.pool);
  }

  createCodeUserQuestion(input: CreateCodeUserQuestionInput): Promise<CodeUserQuestionRecord> {
    return this.questions().createQuestion(input);
  }

  getCodeUserQuestion(companyId: string, questionId: string): Promise<CodeUserQuestionRecord | null> {
    return this.questions().getQuestion(companyId, questionId);
  }

  getPendingCodeUserQuestionForRun(companyId: string, runId: string): Promise<CodeUserQuestionRecord | null> {
    return this.questions().getPendingQuestionForRun(companyId, runId);
  }

  answerCodeUserQuestion(input: AnswerCodeUserQuestionInput): Promise<CodeUserQuestionRecord> {
    return this.questions().answerQuestion(input);
  }

  expireCodeUserQuestions(input: { now?: Date; companyId?: string; runId?: string } = {}): Promise<number> {
    return this.questions().expireQuestions(input);
  }

  listExpiredCodeUserQuestions(input: { now?: Date; limit?: number } = {}): Promise<CodeUserQuestionRecord[]> {
    return this.questions().listExpiredQuestions(input);
  }

  cancelPendingCodeUserQuestions(input: { companyId: string; runId: string; now?: Date }): Promise<number> {
    return this.questions().cancelPendingQuestions(input);
  }

  getCodeSessionHead(companyId: string, sessionId: string): Promise<CodeSessionHeadRecord | null> {
    return this.durability().getHead(companyId, sessionId);
  }

  setCodeSessionHead(input: SetCodeSessionHeadInput): Promise<CodeSessionHeadRecord> {
    return this.durability().setHead(input);
  }

  createCodeRunRecoveryNotice(input: CreateCodeRunRecoveryNoticeInput): Promise<CodeRunRecoveryNoticeRecord> {
    return this.durability().createNotice(input);
  }

  getLatestCodeRunRecoveryNotice(companyId: string, runId: string): Promise<CodeRunRecoveryNoticeRecord | null> {
    return this.durability().getLatestNotice(companyId, runId);
  }

  listCodeRunRecoveryNotices(input: { companyId: string; runId: string; limit?: number }): Promise<CodeRunRecoveryNoticeRecord[]> {
    return this.durability().listNotices(input);
  }

  createCodeSessionRewind(input: CreateCodeSessionRewindInput): Promise<{ record: CodeSessionRewindRecord; replayed: boolean }> {
    return this.durability().createRewind(input);
  }

  getCodeSessionRewind(companyId: string, operationId: string): Promise<CodeSessionRewindRecord | null> {
    return this.durability().getRewind(companyId, operationId);
  }

  reopenCodeSessionRewind(input: { companyId: string; operationId: string; staleMs?: number; now?: Date }): Promise<{ record: CodeSessionRewindRecord | null; reopened: boolean }> {
    return this.durability().reopenRewind(input);
  }

  completeCodeSessionRewind(input: CompleteCodeSessionRewindInput): Promise<CodeSessionRewindRecord> {
    return this.durability().completeRewind(input);
  }

  listCodeSessionRewinds(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionRewindRecord[]> {
    return this.durability().listRewinds(input);
  }

  createCodeSessionFork(input: CreateCodeSessionForkInput): Promise<{ record: CodeSessionForkRecord; replayed: boolean }> {
    return this.durability().createFork(input);
  }

  getCodeSessionFork(companyId: string, operationId: string): Promise<CodeSessionForkRecord | null> {
    return this.durability().getFork(companyId, operationId);
  }

  completeCodeSessionFork(input: CompleteCodeSessionForkInput): Promise<CodeSessionForkRecord> {
    return this.durability().completeFork(input);
  }

  listCodeSessionForks(input: { companyId: string; parentSessionId: string; limit?: number }): Promise<CodeSessionForkRecord[]> {
    return this.durability().listForks(input);
  }

  reopenCodeSessionFork(input: { companyId: string; operationId: string; staleMs?: number; now?: Date }): Promise<{ record: CodeSessionForkRecord | null; reopened: boolean }> {
    return this.durability().reopenFork(input);
  }

  createCodeGoal(input: CreateCodeGoalInput): Promise<CodeGoalWithCriteria> {
    return this.goals().createGoal(input);
  }

  getCodeGoal(companyId: string, goalId: string): Promise<CodeGoalWithCriteria | null> {
    return this.goals().getGoal(companyId, goalId);
  }

  listCodeGoals(input: { companyId: string; sessionId?: string; projectId?: string; limit?: number }): Promise<CodeGoalRecord[]> {
    return this.goals().listGoals(input);
  }

  updateCodeGoal(input: UpdateCodeGoalInput): Promise<CodeGoalWithCriteria> {
    return this.goals().updateGoal(input);
  }

  setCodeGoalCriterionStatus(input: SetCodeGoalCriterionStatusInput): Promise<CodeGoalWithCriteria> {
    return this.goals().setCriterionStatus(input);
  }

  createCodeSessionPlan(input: CreateCodeSessionPlanInput): Promise<CodeSessionPlanRecord> {
    return this.goals().createPlan(input);
  }

  getLatestCodeSessionPlan(companyId: string, sessionId: string): Promise<CodeSessionPlanRecord | null> {
    return this.goals().getLatestPlan(companyId, sessionId);
  }

  listCodeSessionPlans(input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionPlanRecord[]> {
    return this.goals().listPlans(input);
  }

  decideCodeSessionPlan(input: DecideCodeSessionPlanInput): Promise<CodeSessionPlanRecord> {
    return this.goals().decidePlan(input);
  }

  replaceCodeSessionTodos(input: ReplaceCodeSessionTodosInput): Promise<CodeSessionTodoRecord[]> {
    return this.goals().replaceTodos(input);
  }

  listCodeSessionTodos(input: { companyId: string; sessionId: string }): Promise<CodeSessionTodoRecord[]> {
    return this.goals().listTodos(input.companyId, input.sessionId);
  }
}
