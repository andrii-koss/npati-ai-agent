
import { randomUUID } from "node:crypto";
import type { AuthContext, Business, BusinessInput, BusinessOnboardingSession, BusinessToCompanyInput, Company, CompanyAgent, CompanyAgentEdge, CompanyAgentInput, CompanyAgentRun, CompanyAgentRunEvent, CompanyAgentRunStep, CompanyAgentToolAudit, CompanyInput, Project, ProjectCheckpoint, CreateCheckpointInput, ProjectDeployment, CreateDeploymentInput, ProjectQaReport, CreateProjectQaReportInput, ProjectInput, ProjectStatus, Conversation, ConversationMessage, Goal, GoalInput, MemoryInput, MemoryItem, OnboardingScenario, WorkspaceOverview, WorkspaceStore, CodeSession, CodeSessionInput, CodeSessionStatus, ProjectCodeSettings, DataClassification, RetentionClass, AuditEntry, AuditEntryInput, AuditAnchor, AuditChainState, AuditChainVerification, FeatureFlag, FeatureFlagInput, FeatureFlagHistoryEntry, CodeToolManifest, SandboxImage, SandboxImageInput, SandboxImageVariant, CodeSessionMode, ProjectCodeTrust, ProjectCodeTrustInput, ProjectMountedFolder, ProjectMountedFolderInput, CodeApprovalRule, CodeApprovalRuleInput, CodeApprovalRuleScope,
  CompanyMember, CompanyInvite, CompanyInviteInput, AcceptCompanyInviteInput, UpdateCompanyMemberRoleInput, RemoveCompanyMemberInput,
  ProviderDataPolicyRecord, UpsertProviderDataPolicyStoreInput, ProviderDataPolicyVersionRecord, ProjectDataPolicyRecord,
  UpsertProjectDataPolicyStoreInput, ProjectDataPolicyPathRule, ProviderHostedConsentRecord, ProviderContentType,
  CodeRunStateRecord, CodeRunStateStatus, CodeRunTurnRecord, CodeRunToolCallRecord, CreateCodeRunStateInput,
  ApplyCodeRunStateEventInput, UpsertCodeRunTurnInput, CodeRunStateScanInput, CodeRunTurnScanInput,
  ListCodeRunStatesInput,
  CodeRunScanPage, CreateExecutionSnapshotInput, ExecutionSnapshotRecord, ExecutionSnapshotDiff,
  ListExecutionSnapshotsInput, SnapshotConfigKind, SnapshotConfigVersionRecord,
  CreateSnapshotConfigVersionInput, CodeActivityEventRecord, CreateCodeActivityEventInput,
  ListCodeActivityEventsInput, ReplayBundleRecord, ReplayBundleStepRecord, CreateReplayBundleInput,
  CodeContextSummaryRecord, CreateCodeContextSummaryInput, ListCodeContextSummariesInput,
  ListReplayBundlesInput, CodeProjectRef, CodeProjectRefScanInput, CodeProjectRefScanPage, CodeRunRequestRecord } from "./types";
import { WorkspaceAccessError, WorkspaceNotFoundError, CompanyMembershipError, ProviderDataPolicyStoreError, CodeRunStateStoreError, ExecutionSnapshotImmutableError, isCompanyRole, isProviderDataPolicyKind, isProviderTrainingPolicy, isProviderContentType, isProviderRedactionKind, isExternalRetention, isClassificationAtLeast, DEFAULT_DATA_CLASSIFICATION, DEFAULT_RETENTION_CLASS, MANDATORY_PROVIDER_REDACTIONS, mergeCodeRunToolCalls, mergeCodeRunTurnOutcome, clampScanLimit, decodeCodeRunScanCursor, encodeCodeRunScanCursor, decodeCodeActivityCursor, codeRunRequestStatus } from "./types";
import { diffSnapshotPayloads, snapshotPayloadHash } from "./execution-snapshot-hash";

export class InMemoryCodeRunStore {
  constructor(
    private readonly codeRunStates = new Map<string, CodeRunStateRecord>(),
    private readonly codeRunRequests = new Map<string, CodeRunRequestRecord>(),
    private readonly codeRunTurns = new Map<string, CodeRunTurnRecord>(),
    private readonly executionSnapshots = new Map<string, ExecutionSnapshotRecord>(),
    private readonly snapshotConfigVersions = new Map<string, SnapshotConfigVersionRecord>(),
    private readonly codeContextSummaries = new Map<string, CodeContextSummaryRecord>(),
    private readonly codeActivityEvents = new Map<string, CodeActivityEventRecord>(),
    private readonly replayBundles = new Map<string, ReplayBundleRecord>(),
    private readonly replayBundleSteps = new Map<string, ReplayBundleStepRecord[]>(),
  ) {}

  async createCodeRunState(input: CreateCodeRunStateInput): Promise<CodeRunStateRecord> {
    const existing = await this.getCodeRunState(input.companyId, input.runId);

    if (existing) return existing;
    const record: CodeRunStateRecord = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      status: "running",
      turnIndex: 0,
      lastEventSeq: 1,
      leaseOwner: input.owner,
      leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
      heartbeatAt: input.now,
      startedAt: input.now,
      updatedAt: input.now,
      finishedAt: null,
      details: { ...(input.details ?? {}) },
      revision: 1,
    };
    this.codeRunStates.set(input.runId, record);
    const request = input.request ?? { status: "not_recorded" as const, text: null, sha256: null, truncated: false, recordedAt: null };
    this.codeRunRequests.set(input.runId, {
      runId: input.runId,
      companyId: input.companyId,
      status: codeRunRequestStatus(request.status),
      text: request.text,
      sha256: request.sha256,
      truncated: request.truncated === true,
      recordedAt: request.recordedAt,
      dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
      retentionClass: input.retentionClass ?? DEFAULT_RETENTION_CLASS,
    });
    return structuredClone(record);
  }

  async getCodeRunRequest(companyId: string, runId: string): Promise<CodeRunRequestRecord | null> {
    const record = this.codeRunRequests.get(runId);
    if (!record || record.companyId !== companyId) return null;
    return structuredClone(record);
  }

  async applyCodeRunStateEvent(input: ApplyCodeRunStateEventInput): Promise<CodeRunStateRecord> {
    const current = this.codeRunStates.get(input.runId);
    if (!current || current.companyId !== input.companyId) {
      throw new CodeRunStateStoreError("code_run_state_not_found", "No such run state", {
        httpStatus: 404, details: { runId: input.runId },
      });
    }

    if (current.lastEventSeq >= input.seq) return structuredClone(current);

    const now = input.lease?.now ?? new Date();
    const leaseTransitionAllowed = (() => {
      if (!input.lease) return false;
      if (input.lease.mode === "acquire") {
        return current.leaseOwner === null || current.leaseOwner === input.lease.owner
          || current.leaseExpiresAt === null || current.leaseExpiresAt.getTime() < input.lease.now.getTime();
      }
      return current.leaseOwner === input.lease.owner;
    })();

    const next: CodeRunStateRecord = {
      ...current,
      status: input.status ?? current.status,
      turnIndex: input.turnIndex ?? current.turnIndex,
      heartbeatAt: input.heartbeatAt ?? current.heartbeatAt,
      finishedAt: input.finishedAt !== undefined ? input.finishedAt : current.finishedAt,
      details: input.details !== undefined ? { ...input.details } : current.details,
      lastEventSeq: input.seq,
      revision: current.revision + 1,
      updatedAt: now,
    };
    if (input.lease && leaseTransitionAllowed) {
      next.leaseOwner = input.lease.mode === "release" ? null : input.lease.owner;
      next.leaseExpiresAt = input.lease.mode === "release"
        ? null
        : new Date(input.lease.now.getTime() + (input.lease.leaseMs ?? 0));
    }
    this.codeRunStates.set(input.runId, next);
    return structuredClone(next);
  }

  async getCodeRunState(companyId: string, runId: string): Promise<CodeRunStateRecord | null> {
    const record = this.codeRunStates.get(runId);

    if (!record || record.companyId !== companyId) return null;
    return structuredClone(record);
  }

  async listStaleCodeRunStates(input: { now: Date; limit: number }): Promise<CodeRunStateRecord[]> {
    return structuredClone([...this.codeRunStates.values()]
      .filter((record) => record.status === "running"
        && (record.leaseExpiresAt === null || record.leaseExpiresAt.getTime() < input.now.getTime()))
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .slice(0, Math.max(1, input.limit)));
  }

  async upsertCodeRunTurn(input: UpsertCodeRunTurnInput): Promise<CodeRunTurnRecord> {
    const key = `${input.runId}\u0000${input.turnIndex}`;
    const existing = this.codeRunTurns.get(key) ?? null;
    if (existing && existing.companyId !== input.companyId) {
      throw new CodeRunStateStoreError("code_run_state_not_found", "No such run turn", {
        httpStatus: 404, details: { runId: input.runId, turnIndex: input.turnIndex },
      });
    }
    const record: CodeRunTurnRecord = {
      runId: input.runId,
      companyId: input.companyId,
      turnIndex: input.turnIndex,

      status: input.status === "running" && existing && existing.status !== "running" ? existing.status : input.status,
      outcome: mergeCodeRunTurnOutcome(existing?.outcome ?? null, input.outcome ?? null),
      toolCalls: mergeCodeRunToolCalls(existing?.toolCalls ?? [], input.toolCalls ?? []),
      messages: structuredClone([...(input.messages ?? existing?.messages ?? [])]),
      results: structuredClone([...(input.results ?? existing?.results ?? [])]),
      checkpointId: input.checkpointId ?? existing?.checkpointId ?? null,
      startedAt: input.startedAt ?? existing?.startedAt ?? new Date(),
      finishedAt: input.finishedAt ?? existing?.finishedAt ?? null,
    };
    this.codeRunTurns.set(key, record);
    return structuredClone(record);
  }

  async getCodeRunTurn(companyId: string, runId: string, turnIndex: number): Promise<CodeRunTurnRecord | null> {
    const record = this.codeRunTurns.get(`${runId}\u0000${turnIndex}`);
    if (!record || record.companyId !== companyId) return null;
    return structuredClone(record);
  }

  async listCodeRunTurns(companyId: string, runId: string): Promise<CodeRunTurnRecord[]> {
    return structuredClone([...this.codeRunTurns.values()]
      .filter((record) => record.runId === runId && record.companyId === companyId)
      .sort((a, b) => a.turnIndex - b.turnIndex));
  }

  async listCodeRunStates(input: ListCodeRunStatesInput): Promise<CodeRunStateRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 500));
    const statuses = input.statuses ? new Set(input.statuses) : null;
    return structuredClone([...this.codeRunStates.values()]
      .filter((record) => record.companyId === input.companyId)
      .filter((record) => !statuses || statuses.has(record.status))
      .filter((record) => !input.startedAfter || record.startedAt.getTime() >= input.startedAfter.getTime())
      .filter((record) => !input.startedBefore || record.startedAt.getTime() < input.startedBefore.getTime())
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || a.runId.localeCompare(b.runId))
      .slice(0, limit));
  }

  async listCodeRunStatesForScan(input: CodeRunStateScanInput): Promise<CodeRunScanPage<CodeRunStateRecord>> {
    const limit = clampScanLimit(input.limit);
    const cursor = decodeCodeRunScanCursor(input.cursor);
    const matching = [...this.codeRunStates.values()]
      .filter((record) => record.status === "running"
        && (input.companyId === null || record.companyId === input.companyId)
        && record.startedAt.getTime() < input.startedBefore.getTime())
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.runId.localeCompare(b.runId));
    const afterCursor = cursor
      ? matching.filter((record) => record.startedAt.getTime() > Date.parse(cursor.startedAt)
        || (record.startedAt.getTime() === Date.parse(cursor.startedAt) && record.runId > cursor.runId))
      : matching;
    const page = afterCursor.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: structuredClone(page),
      nextCursor: afterCursor.length > limit && last
        ? encodeCodeRunScanCursor({ startedAt: last.startedAt.toISOString(), runId: last.runId, turnIndex: 0 })
        : null,
    };
  }

  async listCodeRunTurnsForScan(input: CodeRunTurnScanInput): Promise<CodeRunScanPage<CodeRunTurnRecord>> {
    const limit = clampScanLimit(input.limit);
    const cursor = decodeCodeRunScanCursor(input.cursor);
    const statuses = input.statuses ?? ["running"];
    const matching = [...this.codeRunTurns.values()]
      .filter((record) => statuses.includes(record.status)
        && (input.companyId === null || record.companyId === input.companyId)
        && record.startedAt.getTime() < input.startedBefore.getTime())
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()
        || a.runId.localeCompare(b.runId) || a.turnIndex - b.turnIndex);
    const afterCursor = cursor
      ? matching.filter((record) => {
        const at = record.startedAt.getTime();
        const cursorAt = Date.parse(cursor.startedAt);
        if (at !== cursorAt) return at > cursorAt;
        if (record.runId !== cursor.runId) return record.runId > cursor.runId;
        return record.turnIndex > cursor.turnIndex;
      })
      : matching;
    const page = afterCursor.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: structuredClone(page),
      nextCursor: afterCursor.length > limit && last
        ? encodeCodeRunScanCursor({
          startedAt: last.startedAt.toISOString(), runId: last.runId, turnIndex: last.turnIndex,
        })
        : null,
    };
  }

  async createExecutionSnapshot(input: CreateExecutionSnapshotInput): Promise<ExecutionSnapshotRecord> {
    const id = input.id ?? randomUUID();

    if (this.executionSnapshots.has(id)) throw new ExecutionSnapshotImmutableError(`create with existing id ${id}`);

    const previous = await this.getLatestSnapshotForSession(input.companyId, input.sessionId);
    const record: ExecutionSnapshotRecord = {
      id,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      snapshotVersion: (previous?.snapshotVersion ?? 0) + 1,
      payload: input.payload,
      payloadHash: snapshotPayloadHash(input.payload),
      prevSnapshotId: previous?.id ?? null,
      prevPayloadHash: previous?.payloadHash ?? null,
      trigger: input.trigger,
      legacy: input.legacy === true,
      createdAt: input.now ?? new Date(),
      createdBy: input.createdBy,
    };
    this.executionSnapshots.set(record.id, record);
    return record;
  }

  async getExecutionSnapshot(companyId: string, snapshotId: string): Promise<ExecutionSnapshotRecord | null> {
    const record = this.executionSnapshots.get(snapshotId);
    return record && record.companyId === companyId ? record : null;
  }

  async getLatestSnapshotForSession(companyId: string, sessionId: string): Promise<ExecutionSnapshotRecord | null> {
    const matching = [...this.executionSnapshots.values()]
      .filter((record) => record.companyId === companyId && record.sessionId === sessionId)
      .sort((a, b) => b.snapshotVersion - a.snapshotVersion);
    return matching[0] ?? null;
  }

  async getSnapshotForRun(companyId: string, runId: string): Promise<ExecutionSnapshotRecord | null> {
    const matching = [...this.executionSnapshots.values()]
      .filter((record) => record.companyId === companyId && record.runId === runId)
      .sort((a, b) => b.snapshotVersion - a.snapshotVersion);
    return matching[0] ?? null;
  }

  async listExecutionSnapshots(input: ListExecutionSnapshotsInput): Promise<ExecutionSnapshotRecord[]> {
    const limit = Math.min(Math.max(input.limit, 1), 500);
    return [...this.executionSnapshots.values()]
      .filter((record) => record.companyId === input.companyId
        && (!input.sessionId || record.sessionId === input.sessionId)
        && (!input.projectId || record.projectId === input.projectId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async createSnapshotConfigVersion(input: CreateSnapshotConfigVersionInput): Promise<SnapshotConfigVersionRecord> {
    const existing = await this.findSnapshotConfigVersionByHash(input.companyId, input.kind, input.contentHash);

    if (existing) return existing;
    const nextVersion = [...this.snapshotConfigVersions.values()]
      .filter((record) => record.companyId === input.companyId && record.kind === input.kind)
      .reduce((max, record) => Math.max(max, record.version), 0) + 1;
    const record: SnapshotConfigVersionRecord = {
      id: input.id ?? `scv_${randomUUID()}`,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      kind: input.kind,
      version: nextVersion,
      contentHash: input.contentHash,
      content: input.content,
      createdAt: input.now ?? new Date(),
      createdBy: input.createdBy,
    };
    this.snapshotConfigVersions.set(record.id, record);
    return record;
  }

  async getSnapshotConfigVersion(
    companyId: string, kind: SnapshotConfigKind, version: number,
  ): Promise<SnapshotConfigVersionRecord | null> {
    return [...this.snapshotConfigVersions.values()].find((record) => record.companyId === companyId
      && record.kind === kind && record.version === version) ?? null;
  }

  async findSnapshotConfigVersionByHash(
    companyId: string, kind: SnapshotConfigKind, contentHash: string,
  ): Promise<SnapshotConfigVersionRecord | null> {
    return [...this.snapshotConfigVersions.values()].find((record) => record.companyId === companyId
      && record.kind === kind && record.contentHash === contentHash) ?? null;
  }

  async listSnapshotConfigVersions(companyId: string, kind: SnapshotConfigKind): Promise<SnapshotConfigVersionRecord[]> {
    return [...this.snapshotConfigVersions.values()]
      .filter((record) => record.companyId === companyId && record.kind === kind)
      .sort((a, b) => b.version - a.version);
  }

  async createCodeContextSummary(input: CreateCodeContextSummaryInput): Promise<CodeContextSummaryRecord> {
    const record: CodeContextSummaryRecord = {
      id: input.id ?? randomUUID(),
      companyId: input.companyId,
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      snapshotId: input.snapshotId ?? null,
      turnIndex: input.turnIndex ?? 0,
      schemaVersion: input.schemaVersion,
      summary: input.summary,
      summaryText: input.summaryText,
      contentHash: input.contentHash,
      dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
      retentionClass: input.retentionClass ?? "short",
      createdAt: input.now ?? new Date(),
    };
    this.codeContextSummaries.set(record.id, record);
    return record;
  }

  async listCodeContextSummaries(input: ListCodeContextSummariesInput): Promise<CodeContextSummaryRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    return [...this.codeContextSummaries.values()]
      .filter((record) => record.companyId === input.companyId)
      .filter((record) => !input.sessionId || record.sessionId === input.sessionId)
      .filter((record) => !input.runId || record.runId === input.runId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, limit);
  }

  async createCodeActivityEvent(input: CreateCodeActivityEventInput): Promise<CodeActivityEventRecord> {
    const record: CodeActivityEventRecord = {
      id: input.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      snapshotId: input.snapshotId ?? null,
      parentRunId: input.parentRunId ?? null,
      parentToolCallId: input.parentToolCallId ?? null,
      parentEventId: input.parentEventId ?? null,
      kind: input.kind,
      payload: input.payload,
      dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
      retentionClass: input.retentionClass ?? DEFAULT_RETENTION_CLASS,
      createdAt: input.now ?? new Date(),
    };
    this.codeActivityEvents.set(record.id, record);
    return record;
  }

  async listCodeActivityEvents(input: ListCodeActivityEventsInput): Promise<CodeActivityEventRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
    const cursor = input.cursor ? decodeCodeActivityCursor(input.cursor) : null;
    return [...this.codeActivityEvents.values()]
      .filter((record) => record.companyId === input.companyId)
      .filter((record) => !input.sessionId || record.sessionId === input.sessionId)
      .filter((record) => !input.runId || record.runId === input.runId)
      .filter((record) => !input.snapshotId || record.snapshotId === input.snapshotId)

      .filter((record) => !input.parentRunId || record.parentRunId === input.parentRunId)
      .filter((record) => {
        if (!cursor) return true;

        const at = record.createdAt.getTime();
        const cursorAt = Date.parse(cursor.createdAt);
        return at < cursorAt || (at === cursorAt && record.id < cursor.id);
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, limit);
  }

  async createReplayBundle(input: CreateReplayBundleInput): Promise<ReplayBundleRecord> {
    const existing = await this.getReplayBundle(input.companyId, input.runId, input.bundleVersion);
    if (existing) return existing;
    const now = input.now ?? new Date();
    const record: ReplayBundleRecord = {
      id: input.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      runId: input.runId,
      executionSnapshotId: input.executionSnapshotId ?? null,
      bundleVersion: input.bundleVersion,
      runnerVersion: input.runnerVersion ?? null,
      systemPromptVersion: input.systemPromptVersion ?? null,
      systemPromptContentHash: input.systemPromptContentHash ?? null,
      modelProfileVersion: input.modelProfileVersion ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      replayMode: input.replayMode,
      sourceRunId: input.sourceRunId ?? null,
      sourceSnapshotId: input.sourceSnapshotId ?? null,
      terminalStatus: input.terminalStatus ?? null,
      terminalReason: input.terminalReason ?? null,
      payload: input.payload,
      payloadHash: input.payloadHash,
      replayInputHash: input.replayInputHash,
      dataClassification: input.dataClassification ?? DEFAULT_DATA_CLASSIFICATION,
      retentionClass: input.retentionClass ?? DEFAULT_RETENTION_CLASS,
      createdAt: now,
    };
    this.replayBundles.set(record.id, record);
    const steps: ReplayBundleStepRecord[] = [];
    let seq = 0;
    const seen = new Set<string>();
    for (const step of input.steps) {

      const identity = `${step.kind}:${step.turnIndex}:${step.toolCallId ?? ""}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      seq += 1;
      steps.push({
        id: step.id ?? randomUUID(),
        bundleId: record.id,
        companyId: input.companyId,
        seq,
        kind: step.kind,
        turnIndex: step.turnIndex,
        toolCallId: step.toolCallId ?? null,
        payload: step.payload,
        payloadHash: step.payloadHash,
        createdAt: step.createdAt ?? now,
      });
    }
    this.replayBundleSteps.set(record.id, steps);
    return record;
  }

  async getReplayBundle(companyId: string, runId: string, bundleVersion?: number): Promise<ReplayBundleRecord | null> {
    const matches = [...this.replayBundles.values()]
      .filter((bundle) => bundle.companyId === companyId && bundle.runId === runId)
      .filter((bundle) => bundleVersion === undefined || bundle.bundleVersion === bundleVersion)
      .sort((a, b) => b.bundleVersion - a.bundleVersion);
    return matches[0] ?? null;
  }

  async getReplayBundleById(companyId: string, bundleId: string): Promise<ReplayBundleRecord | null> {
    const bundle = this.replayBundles.get(bundleId);
    return bundle && bundle.companyId === companyId ? bundle : null;
  }

  async listReplayBundles(input: ListReplayBundlesInput): Promise<ReplayBundleRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    return [...this.replayBundles.values()]
      .filter((bundle) => bundle.companyId === input.companyId)
      .filter((bundle) => !input.runId || bundle.runId === input.runId)
      .filter((bundle) => !input.sessionId || bundle.sessionId === input.sessionId)
      .filter((bundle) => !input.executionSnapshotId || bundle.executionSnapshotId === input.executionSnapshotId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, limit);
  }

  async listReplayBundleSteps(companyId: string, bundleId: string): Promise<ReplayBundleStepRecord[]> {
    const steps = this.replayBundleSteps.get(bundleId) ?? [];
    return steps.filter((step) => step.companyId === companyId).slice().sort((a, b) => a.seq - b.seq);
  }

}
