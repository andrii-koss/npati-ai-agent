import { randomUUID } from "node:crypto";
import { codeChildSessionId } from "./code-child-session-id";
import type { AuthContext, CodeSession, CodeSessionInput, CodeSessionStatus, DataClassification, RetentionClass, CodeSessionMode, CodeApprovalRule, CodeApprovalRuleInput, CodeApprovalRuleScope, CodeRunStateRecord, CodeRunTurnRecord, CreateCodeRunStateInput, ApplyCodeRunStateEventInput, CodeRunStateScanInput, CodeRunTurnScanInput, ListCodeRunStatesInput, CodeRunScanPage, CodeActivityEventRecord, CreateCodeActivityEventInput, ListCodeActivityEventsInput, CodeContextSummaryRecord, CreateCodeContextSummaryInput, ListCodeContextSummariesInput, CodeProjectRef, CodeProjectRefScanInput, CodeProjectRefScanPage, CodeRunRequestRecord } from "./types";
import { WorkspaceAccessError, WorkspaceNotFoundError, isClassificationAtLeast, clampScanLimit, decodeCodeRunScanCursor, encodeCodeRunScanCursor } from "./types";
import type { CodeUserQuestionRecord, CreateCodeUserQuestionInput } from "./code-question-store";
import type { CodeRunRecoveryNoticeRecord, CodeSessionForkRecord, CodeSessionHeadRecord, CodeSessionRewindRecord, CreateCodeRunRecoveryNoticeInput, CreateCodeSessionForkInput, CreateCodeSessionRewindInput } from "./code-session-durability-store";
import type { CodeGoalRecord, CodeGoalWithCriteria, CodeSessionPlanRecord, CodeSessionTodoRecord, CreateCodeGoalInput, CreateCodeSessionPlanInput, UpdateCodeGoalInput } from "./types";
import { now } from "./in-memory-clock";
import { getProject } from "./in-memory-project-store";
import { listGoals, createGoal, updateGoal } from "./in-memory-goal-store";

export interface InMemoryCodeState {
  codeApprovalRules: any
  codeGoalState: any
  codeRunOps: any
  codeSessionDurabilityState: any
  codeSessions: any
  codeUserQuestionState: any
  companyAgents: any
  assertCompany: (context: AuthContext, companyId: string) => any
  getProject: (context: AuthContext, companyId: string, projectId: string) => any
}

export async function createCodeSession(host: InMemoryCodeState, context: AuthContext, companyId: string, projectId: string, input: CodeSessionInput): Promise<CodeSession> {
    const project = await host.getProject(context, companyId, projectId);
    if (input.agentId && !host.companyAgents.has(input.agentId)) throw new WorkspaceAccessError("Agent does not belong to this company");
    if (input.parentSessionId) {
      const parent = await getCodeSession(host, context, companyId, input.parentSessionId);
      if (parent.projectId !== projectId) throw new WorkspaceAccessError("Parent session belongs to another project");
    }
    const requested = input.dataClassification ?? project.dataClassification;
    if (!isClassificationAtLeast(requested, project.dataClassification)) {
      throw new WorkspaceAccessError("Session data classification cannot be lower than the project classification");
    }
    const id = input.childKey && input.parentSessionId
      ? codeChildSessionId(context, companyId, projectId, input.parentSessionId, input.childKey) : randomUUID();
    if (host.codeSessions.has(id)) return getCodeSession(host, context, companyId, id);
    const timestamp = now();
    const session: CodeSession = {
      id, workspaceId: context.workspaceId, companyId, projectId, userId: context.userId,
      agentId: input.agentId ?? null, mode: input.mode ?? "edit", modelProfile: input.modelProfile ?? null,
      status: "active", parentSessionId: input.parentSessionId ?? null, runId: null,
      summary: input.summary ?? null, dataClassification: requested,
      retentionClass: input.retentionClass ?? project.retentionClass, toolManifestVersion: null,
      revision: 1,
      createdAt: timestamp, updatedAt: timestamp,
    };
    host.codeSessions.set(session.id, session);
    return structuredClone(session);
  }

export async function getCodeSession(host: InMemoryCodeState, context: AuthContext, companyId: string, sessionId: string): Promise<CodeSession> {
    const session = host.codeSessions.get(sessionId);
    if (!session || session.workspaceId !== context.workspaceId || session.companyId !== companyId
      || session.userId !== context.userId) throw new WorkspaceNotFoundError("Code session not found");
    return structuredClone(session);
  }

export async function listCodeSessions(host: InMemoryCodeState, context: AuthContext, companyId: string, projectId?: string, options: { includeArchived?: boolean; limit?: number } = {}): Promise<CodeSession[]> {
    host.assertCompany(context, companyId);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    return structuredClone([...host.codeSessions.values()]
      .filter((session) => session.workspaceId === context.workspaceId && session.companyId === companyId
        && session.userId === context.userId
        && (!projectId || session.projectId === projectId)
        && (options.includeArchived === true || session.status !== "archived"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .slice(0, limit));
  }

export async function createCodeApprovalRule(host: InMemoryCodeState, context: AuthContext, companyId: string, input: CodeApprovalRuleInput): Promise<CodeApprovalRule> {
    host.assertCompany(context, companyId);
    if (input.scope === "session" && !input.sessionId) {
      throw new WorkspaceAccessError("A session-scoped approval rule must name its session");
    }
    if (!input.projectId) throw new WorkspaceAccessError("An approval rule must name its project");
    const key = `${context.workspaceId}|${companyId}|${input.projectId}|${input.sessionId ?? ""}|${input.scope}|${input.action}`;
    const existing = host.codeApprovalRules.get(key);
    const record: CodeApprovalRule = {
      id: existing?.id ?? randomUUID(), workspaceId: context.workspaceId, companyId,
      projectId: input.projectId, sessionId: input.sessionId ?? null, createdBy: context.userId,
      scope: input.scope, action: input.action, decision: "allow",
      reason: input.reason ?? null, expiresAt: input.expiresAt ?? null,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now(), updatedAt: now(),
    };
    host.codeApprovalRules.set(key, record);
    return structuredClone(record);
  }

export async function listCodeApprovalRules(host: InMemoryCodeState, context: AuthContext, companyId: string, filters: { projectId?: string; sessionId?: string; scope?: CodeApprovalRuleScope } = {}): Promise<CodeApprovalRule[]> {
    return structuredClone([...host.codeApprovalRules.values()]
      .filter((rule) => rule.workspaceId === context.workspaceId && rule.companyId === companyId)
      .filter((rule) => (filters.projectId ? rule.projectId === filters.projectId : true))
      .filter((rule) => (filters.sessionId ? rule.sessionId === filters.sessionId : true))
      .filter((rule) => (filters.scope ? rule.scope === filters.scope : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

export async function deleteCodeApprovalRule(host: InMemoryCodeState, context: AuthContext, companyId: string, ruleId: string): Promise<void> {
    host.assertCompany(context, companyId);
    for (const [key, rule] of host.codeApprovalRules) {
      if (rule.id === ruleId && rule.workspaceId === context.workspaceId && rule.companyId === companyId) {
        host.codeApprovalRules.delete(key);
      }
    }
  }

export async function updateCodeSession(host: InMemoryCodeState, context: AuthContext, companyId: string, sessionId: string, patch: { status?: CodeSessionStatus; summary?: string; runId?: string | null; modelProfile?: string; dataClassification?: DataClassification; retentionClass?: RetentionClass; toolManifestVersion?: number | null; mode?: CodeSessionMode; expectedRevision?: number }): Promise<CodeSession> {    const session = await getCodeSession(host, context, companyId, sessionId);
    if (patch.dataClassification && !isClassificationAtLeast(patch.dataClassification, session.dataClassification)) {
      throw new WorkspaceAccessError("Session data classification cannot be lowered through this endpoint");
    }
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== session.revision) {
      throw new WorkspaceAccessError("Code session changed by another request. Reload and try again.");
    }
    const next: CodeSession = {
      ...session,
      status: patch.status ?? session.status,
      summary: patch.summary ?? session.summary,
      runId: patch.runId === undefined ? session.runId : patch.runId,
      modelProfile: patch.modelProfile ?? session.modelProfile,
      dataClassification: patch.dataClassification ?? session.dataClassification,
      retentionClass: patch.retentionClass ?? session.retentionClass,
      toolManifestVersion: patch.toolManifestVersion === undefined ? session.toolManifestVersion : patch.toolManifestVersion,
      mode: patch.mode ?? session.mode,
      revision: session.revision + 1,
      updatedAt: now(),
    };
    host.codeSessions.set(sessionId, next);
    return structuredClone(next);
  }

export async function createCodeRunState(host: InMemoryCodeState, input: CreateCodeRunStateInput): Promise<CodeRunStateRecord> {
    return host.codeRunOps.createCodeRunState(input);
  }

export async function getCodeRunRequest(host: InMemoryCodeState, companyId: string, runId: string): Promise<CodeRunRequestRecord | null> {
    return host.codeRunOps.getCodeRunRequest(companyId, runId);
  }

export async function applyCodeRunStateEvent(host: InMemoryCodeState, input: ApplyCodeRunStateEventInput): Promise<CodeRunStateRecord> {
    return host.codeRunOps.applyCodeRunStateEvent(input);
  }

export async function getCodeRunState(host: InMemoryCodeState, companyId: string, runId: string): Promise<CodeRunStateRecord | null> {
    return host.codeRunOps.getCodeRunState(companyId, runId);
  }

export async function getCodeRunTurn(host: InMemoryCodeState, companyId: string, runId: string, turnIndex: number): Promise<CodeRunTurnRecord | null> {
    return host.codeRunOps.getCodeRunTurn(companyId, runId, turnIndex);
  }

export async function listCodeRunTurns(host: InMemoryCodeState, companyId: string, runId: string): Promise<CodeRunTurnRecord[]> {
    return host.codeRunOps.listCodeRunTurns(companyId, runId);
  }

export async function listCodeRunStates(host: InMemoryCodeState, input: ListCodeRunStatesInput): Promise<CodeRunStateRecord[]> {
    return host.codeRunOps.listCodeRunStates(input);
  }

export async function listCodeRunStatesForScan(host: InMemoryCodeState, input: CodeRunStateScanInput): Promise<CodeRunScanPage<CodeRunStateRecord>> {
    return host.codeRunOps.listCodeRunStatesForScan(input);
  }

export async function listCodeProjectRefs(host: InMemoryCodeState, input: CodeProjectRefScanInput): Promise<CodeProjectRefScanPage> {
    const limit = clampScanLimit(input.limit);
    const cursor = decodeCodeRunScanCursor(input.cursor);
    const newest = new Map<string, { companyId: string; projectId: string; lastSessionAt: string }>();
    for (const session of host.codeSessions.values()) {
      if (input.companyId !== null && session.companyId !== input.companyId) continue;
      const createdAt = typeof session.createdAt === "string" ? session.createdAt : new Date(String(session.createdAt)).toISOString();
      const key = `${session.companyId}:${session.projectId}`;
      const existing = newest.get(key);
      if (!existing || existing.lastSessionAt < createdAt) {
        newest.set(key, { companyId: session.companyId, projectId: session.projectId, lastSessionAt: createdAt });
      }
    }
    const ordered = [...newest.values()].sort((a, b) =>
      b.lastSessionAt.localeCompare(a.lastSessionAt) || a.projectId.localeCompare(b.projectId));
    const afterCursor = cursor
      ? ordered.filter((ref) => ref.lastSessionAt < cursor.startedAt
        || (ref.lastSessionAt === cursor.startedAt && ref.projectId > cursor.runId))
      : ordered;
    const page = afterCursor.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page as CodeProjectRef[],
      nextCursor: afterCursor.length > limit && last
        ? encodeCodeRunScanCursor({ startedAt: last.lastSessionAt, runId: last.projectId, turnIndex: 0 })
        : null,
    };
  }

export async function listCodeRunTurnsForScan(host: InMemoryCodeState, input: CodeRunTurnScanInput): Promise<CodeRunScanPage<CodeRunTurnRecord>> {
    return host.codeRunOps.listCodeRunTurnsForScan(input);
  }

export async function createCodeUserQuestion(host: InMemoryCodeState, input: CreateCodeUserQuestionInput): Promise<CodeUserQuestionRecord> {
    return host.codeUserQuestionState.createQuestion(input);
  }

export async function getCodeUserQuestion(host: InMemoryCodeState, companyId: string, questionId: string): Promise<CodeUserQuestionRecord | null> {
    return host.codeUserQuestionState.getQuestion(companyId, questionId);
  }

export async function getCodeSessionHead(host: InMemoryCodeState, companyId: string, sessionId: string): Promise<CodeSessionHeadRecord | null> {
    return host.codeSessionDurabilityState.getHead(companyId, sessionId);
  }

export async function createCodeRunRecoveryNotice(host: InMemoryCodeState, input: CreateCodeRunRecoveryNoticeInput): Promise<CodeRunRecoveryNoticeRecord> {
    return host.codeSessionDurabilityState.createNotice(input);
  }

export async function listCodeRunRecoveryNotices(host: InMemoryCodeState, input: { companyId: string; runId: string; limit?: number }): Promise<CodeRunRecoveryNoticeRecord[]> {
    return host.codeSessionDurabilityState.listNotices(input);
  }

export async function createCodeSessionRewind(host: InMemoryCodeState, input: CreateCodeSessionRewindInput): Promise<{ record: CodeSessionRewindRecord; replayed: boolean }> {
    return host.codeSessionDurabilityState.createRewind(input);
  }

export async function getCodeSessionRewind(host: InMemoryCodeState, companyId: string, operationId: string): Promise<CodeSessionRewindRecord | null> {
    return host.codeSessionDurabilityState.getRewind(companyId, operationId);
  }

export async function listCodeSessionRewinds(host: InMemoryCodeState, input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionRewindRecord[]> {
    return host.codeSessionDurabilityState.listRewinds(input);
  }

export async function createCodeSessionFork(host: InMemoryCodeState, input: CreateCodeSessionForkInput): Promise<{ record: CodeSessionForkRecord; replayed: boolean }> {
    return host.codeSessionDurabilityState.createFork(input);
  }

export async function getCodeSessionFork(host: InMemoryCodeState, companyId: string, operationId: string): Promise<CodeSessionForkRecord | null> {
    return host.codeSessionDurabilityState.getFork(companyId, operationId);
  }

export async function listCodeSessionForks(host: InMemoryCodeState, input: { companyId: string; parentSessionId: string; limit?: number }): Promise<CodeSessionForkRecord[]> {
    return host.codeSessionDurabilityState.listForks(input);
  }

export async function createCodeGoal(host: InMemoryCodeState, input: CreateCodeGoalInput): Promise<CodeGoalWithCriteria> {
    return host.codeGoalState.createGoal(input);
  }

export async function getCodeGoal(host: InMemoryCodeState, companyId: string, goalId: string): Promise<CodeGoalWithCriteria | null> {
    return host.codeGoalState.getGoal(companyId, goalId);
  }

export async function listCodeGoals(host: InMemoryCodeState, input: { companyId: string; sessionId?: string; projectId?: string; limit?: number }): Promise<CodeGoalRecord[]> {
    return host.codeGoalState.listGoals(input);
  }

export async function updateCodeGoal(host: InMemoryCodeState, input: UpdateCodeGoalInput): Promise<CodeGoalWithCriteria> {
    return host.codeGoalState.updateGoal(input);
  }

export async function createCodeSessionPlan(host: InMemoryCodeState, input: CreateCodeSessionPlanInput): Promise<CodeSessionPlanRecord> {
    return host.codeGoalState.createPlan(input);
  }

export async function listCodeSessionPlans(host: InMemoryCodeState, input: { companyId: string; sessionId: string; limit?: number }): Promise<CodeSessionPlanRecord[]> {
    return host.codeGoalState.listPlans(input);
  }

export async function listCodeSessionTodos(host: InMemoryCodeState, input: { companyId: string; sessionId: string }): Promise<CodeSessionTodoRecord[]> {
    return host.codeGoalState.listTodos(input.companyId, input.sessionId);
  }

export async function createCodeContextSummary(host: InMemoryCodeState, input: CreateCodeContextSummaryInput): Promise<CodeContextSummaryRecord> {
    return host.codeRunOps.createCodeContextSummary(input);
  }

export async function listCodeContextSummaries(host: InMemoryCodeState, input: ListCodeContextSummariesInput): Promise<CodeContextSummaryRecord[]> {
    return host.codeRunOps.listCodeContextSummaries(input);
  }

export async function createCodeActivityEvent(host: InMemoryCodeState, input: CreateCodeActivityEventInput): Promise<CodeActivityEventRecord> {
    return host.codeRunOps.createCodeActivityEvent(input);
  }

export async function listCodeActivityEvents(host: InMemoryCodeState, input: ListCodeActivityEventsInput): Promise<CodeActivityEventRecord[]> {
    return host.codeRunOps.listCodeActivityEvents(input);
  }

export async function findMatchingCodeApprovalRule(
  host: InMemoryCodeState,
  context: AuthContext,
  query: { companyId: string; projectId?: string | null; sessionId?: string | null; action: string },
): Promise<CodeApprovalRule | null> {
  host.assertCompany(context, query.companyId);
  const at = now();
  const matches = [...host.codeApprovalRules.values()].filter((rule: CodeApprovalRule) => {
    if (rule.workspaceId !== context.workspaceId || rule.companyId !== query.companyId) return false;
    if (rule.action !== query.action || rule.decision !== "allow") return false;
    if (rule.expiresAt && rule.expiresAt <= at) return false;

    if (rule.scope === "session") {
      return Boolean(query.sessionId) && rule.sessionId === query.sessionId
        && Boolean(query.projectId) && rule.projectId === query.projectId;
    }
    return Boolean(query.projectId) && rule.projectId === query.projectId;
  });
  matches.sort((a: CodeApprovalRule, b: CodeApprovalRule) => (a.scope === b.scope ? b.createdAt.localeCompare(a.createdAt) : a.scope === "session" ? -1 : 1));
  return matches[0] ? structuredClone(matches[0]) : null;
}


