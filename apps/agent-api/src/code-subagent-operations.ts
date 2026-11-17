import { CodeSubagentWriteScopeRegistry } from "./code-subagent-write-scopes";
export { CodeSubagentWriteScopeRegistry } from "./code-subagent-write-scopes";
import type { AuthContext, CodeProcessStore, CodeRunStateRecord, CodeSession, DurableCodeProcess } from "@npati/workspace";
import { activeCodeProcess, WorkspaceNotFoundError } from "@npati/workspace";
import { CodeToolError } from "./code-tool-runtime";
import type { CodeSubagentRunSummaryLike } from "./code-subagent-child-runner";
import type { CodeSubagentChildOutcome, CodeSubagentChildRunRequest, CodeSubagentChildRunner } from "./code-agent-spawn-executor";
import type { CodeRunStateLog } from "./code-run-state";
import { randomUUID } from "node:crypto";
import type { CodeSessionInboxService } from "./code-session-inbox";

export class CodeAgentControlError extends Error {
  constructor(readonly code: string, readonly httpStatus = 409) { super(code); }
}
export interface CodeAgentControlTarget {
  ctx: AuthContext; companyId: string; sessionId: string; parentRunId: string; childRunId: string;
}

/** What the durable record of a delegation has to keep, so recovery can re-enter it faithfully. */
export interface CodeSubagentDelegationRecord {
  agentType: string;
  capabilityProfile: string;
  task: string;
  paths: readonly string[];
  model: string | null;
  maxTurns: number;
  readOnly: boolean;
  summaryOnly: boolean;
  allowedTools: readonly string[];
  toolCallingMode: string;
}

/** Everything the reserve needs, all of it a server fact the C12 executor already resolved. */
export interface CodeSubagentDetachedSpawnInput extends CodeSubagentDelegationRecord {
  ctx: AuthContext;
  companyId: string;
  projectId: string;
  sessionId: string;
  parentRunId: string;
  parentOwner: string;
  toolCallId: string;
  childRunId: string;
  snapshotId?: string | null;
  maxParallelism?: number;
}

export type CodeSubagentDetachedStart =
  | { status: "accepted"; childRunId: string; operationId: string; duplicate: boolean }
  | { status: "refused"; code: string; message: string };

export interface CodeSubagentDetachedRunner extends CodeSubagentChildRunner {
  /**
   * The child was handed to the runner. Optional, and deliberately not load-bearing: a runner that cannot
   * acknowledge must not make the parent's receipt less true than it is.
   */
  ack?(request: CodeSubagentChildRunRequest): void;
}

export interface CodeSubagentOperationServiceOptions {
  store: CodeProcessStore;
  runState: Pick<CodeRunStateLog, "loadRunState" | "startRun" | "markInterrupted" | "markFinished">;
  /** The same adapter the blocking path uses. A child starts through the one runner there is. */
  childRunner: () => CodeSubagentDetachedRunner | undefined;
  loadSession(input: { ctx: AuthContext; companyId: string; sessionId: string }): Promise<CodeSession | null>;
  /** The detached path is only reachable while its own flag is on. */
  enabled(input: { ctx: AuthContext; companyId: string }): Promise<boolean>;
  controlsEnabled?(input: { ctx: AuthContext; companyId: string }): Promise<boolean>;
  inbox?: CodeSessionInboxService;
  ensureChildSession?(input: { ctx: AuthContext; parent: CodeSession; childRunId: string }): Promise<CodeSession>;
  resumeChild?(input: { ctx: AuthContext; companyId: string; sessionId: string; runId: string; owner: string }): Promise<{ prompt: string; turnIndex: number; unknownCalls: number }>;
  /**
   * `code.agent.spawn` cannot be delegated, so the allow-list a child receives must not contain it; C12's
   * executor already removes it. Passed in so the check lives where the delegation record is read.
   */
  spawnTool: string;
  writeScopes?: CodeSubagentWriteScopeRegistry;
  /**
   * Reported after a background child settles. The completion outbox already recovers on its own schedule; this
   * hook is what lets a deployment deliver the completion immediately instead of up to a tick later.
   */
  onSettled?(event: { ctx: AuthContext; companyId: string; projectId: string; sessionId: string; parentRunId: string; childRunId: string }): void;
  logger?: { warn(code: string): void };
  now?: () => number;
}

/** The deterministic operation id of one delegation, derived from the same join key as the run id. */
export function codeSubagentOperationId(parentRunId: string, toolCallId: string): string {
  return `subagent-op-${parentRunId}-${toolCallId}`;
}

/**
 * The lease identity the child's **own** run is started under, derived from its run id so the same delegation is
 * always one owner and a restarted process cannot invent a second one.
 *
 * It is exported because the two writers of the child's run have to agree about it: the launch stamps it on the
 * child's run row (through the runner's `runStateOwner`), and the settlement is fenced by it in the process store
 * ("only the owner of the child run may report its result"). One function, so a rename cannot make settlement
 * impossible — which is exactly the failure an owner-mismatch leaves behind: the operation would stay active
 * forever with its completion undelivered.
 */
export function codeSubagentRunOwner(childRunId: string): string {
  return `subagent-${childRunId}`;
}

type CodeProcessScopeLike = {
  companyId: string;
  projectId: string;
  sessionId: string;
  dataClassification: CodeSession["dataClassification"];
  retentionClass: CodeSession["retentionClass"];
};

/**
 * The child's outcome, rebuilt from its **durable terminal run state**.
 *
 * This is the whole of "an unknown outcome is never replayed blindly": a child whose run reached a terminal state
 * is settled from that state, with no model call and no tool call at all. The content the plan forbids
 * (transcript, file bodies) is not reachable here by construction — a run state carries counts, paths and a
 * reason — so the digest the parent eventually reads is metadata-only whether the child was observed live or
 * recovered after a restart.
 */
export function recoverCodeSubagentChildOutcome(state: CodeRunStateRecord | null): CodeSubagentChildOutcome {
  const estimate = state?.details?.estimate && typeof state.details.estimate === "object" && !Array.isArray(state.details.estimate)
    ? state.details.estimate as Record<string, unknown>
    : {};
  const status = state?.status === "completed" ? "completed" : "failed";
  const reason = typeof state?.details?.stopReason === "string" ? state.details.stopReason : null;
  return {
    runId: state?.runId ?? null,
    status,
    ...(status === "completed" ? {} : { errorCode: reason ?? (state ? "subagent_run_interrupted" : "subagent_run_missing") }),
    ...(Array.isArray(estimate.filesChanged) ? { filesChanged: estimate.filesChanged as string[] } : {}),
    toolCalls: typeof estimate.toolCalls === "number" ? estimate.toolCalls : 0,
    turns: typeof estimate.turns === "number" ? estimate.turns : 0,
  };
}

/**
 * The metadata-only answer the child runner reports after its run.
 *
 * It is built from the run's own summary — verification status, failed checks, scope warnings, self-review
 * findings, changed paths, counts — and never from a file, a diff or a message body. The digest builder that
 * finally parses it (`buildCodeSubagentHandoffDigest`) refuses content and credentials on top, so this function
 * is the first of two independent bounds rather than the only one.
 */
export function summarizeCodeSubagentRun(result: { summary: CodeSubagentRunSummaryLike }): {
  answer: string;
  filesChanged: string[];
  toolCalls: number;
  turns: number;
} {
  const findings: Array<Record<string, unknown>> = [];
  const verificationStatus = typeof result.summary.verification?.status === "string" ? result.summary.verification.status : null;
  if (verificationStatus) findings.push({ kind: "fact", path: null, name: null, detail: `verification: ${verificationStatus}`.slice(0, 200) });
  for (const check of result.summary.verification?.failedChecks ?? []) {
    const tool = typeof check.tool === "string" ? check.tool.slice(0, 80) : null;
    if (!tool) continue;
    const code = typeof check.code === "string" ? check.code.slice(0, 80) : null;
    findings.push({ kind: "risk", path: null, name: null, detail: (code ? `${tool} failed (${code})` : `${tool} failed`).slice(0, 200) });
  }
  for (const warning of result.summary.scope?.warnings ?? []) {
    const code = typeof warning.code === "string" ? warning.code.slice(0, 80) : null;
    if (!code) continue;
    findings.push({ kind: "risk", path: null, name: null, detail: `scope warning: ${code}`.slice(0, 200) });
  }
  const reviewStatus = typeof result.summary.selfReview?.status === "string" ? result.summary.selfReview.status : null;
  if (reviewStatus && reviewStatus !== "clean") {
    findings.push({ kind: "open_question", path: null, name: null, detail: `self-review: ${reviewStatus}`.slice(0, 200) });
  }
  for (const finding of result.summary.selfReview?.findings ?? []) {
    const detail = typeof finding.title === "string"
      ? finding.title.slice(0, 200)
      : typeof finding.id === "string" ? finding.id.slice(0, 120) : null;
    if (!detail) continue;
    findings.push({
      kind: "risk",
      path: typeof finding.path === "string" ? finding.path : null,
      name: typeof finding.category === "string" ? finding.category.slice(0, 80) : null,
      detail,
    });
  }
  return {
    answer: JSON.stringify({ findings, files: [...(result.summary.filesChanged ?? [])], symbols: [] }),
    filesChanged: [...(result.summary.filesChanged ?? [])],
    toolCalls: result.summary.toolCalls ?? 0,
    turns: result.summary.turns ?? 0,
  };
}

export class CodeSubagentOperationService {
  private readonly running = new Map<string, { controller: AbortController; parentRunId: string; operationId: string; companyId: string; sessionId: string; timer?: ReturnType<typeof setInterval> }>();
  private readonly writeScopes: CodeSubagentWriteScopeRegistry;
  private closed = false;

  constructor(private readonly options: CodeSubagentOperationServiceOptions) {
    this.writeScopes = options.writeScopes ?? new CodeSubagentWriteScopeRegistry();
  }

  /** The live children of one parent run, for that parent's terminal/cleanup fence. */
  activeChildRuns(parentRunId: string): string[] {
    return [...this.running.entries()]
      .filter(([, entry]) => entry.parentRunId === parentRunId)
      .map(([childRunId]) => childRunId);
  }

  /** True while a child of this parent is genuinely in flight **in this process**. */
  hasActiveChild(parentRunId: string): boolean {
    return this.activeChildRuns(parentRunId).length > 0;
  }

  /**
   * The parent's cleanup fence, asked precisely: is a child of this run still **required**, i.e. started and not
   * settled?
   *
   * Two halves, and both are needed. The durable half is the authority — an operation in an active state is a child
   * that has been accepted and has not settled, whoever started it and whether or not this process still exists —
   * and it is the same `activeCodeProcess` accounting the sandbox cleanup guard already reads, which is why a
   * detached child inherits the process fence instead of needing one of its own. The in-memory half covers the
   * window between "handed to the runner" and "the operation was observed as running", so a parent that ends
   * immediately after delegating still sees its child.
   */
  async hasRequiredChild(input: { ctx: AuthContext; companyId: string; sessionId: string; parentRunId: string }): Promise<boolean> {
    if (this.hasActiveChild(input.parentRunId)) return true;
    /**
     * The durable half. A session that cannot be read is **not** turned into "a child is required": refusing every
     * run's cleanup because one lookup failed would leak sandboxes for runs that never delegated at all, while the
     * in-memory map already answers for every child this process started. The safe direction here is the honest
     * one — the answer is only `true` when an active child record (or a live delegation of this process) was
     * actually found.
     */
    const session = await this.readableSession({ ctx: input.ctx, companyId: input.companyId, sessionId: input.sessionId });
    if (!session) return false;
    const children = await this.listChildren(this.scopeFor(session), input.parentRunId);
    return children.some((op) => activeCodeProcess(op));
  }

  /** A session lookup that fails (a 404 is thrown, not returned) counts as "no session", the same as a null. */
  private async readableSession(input: { ctx: AuthContext; companyId: string; sessionId: string }) {
    try { return await this.options.loadSession(input); } catch { return null; }
  }

  writeScopeOf(parentRunId: string): string[] {
    return this.writeScopes.scope(parentRunId);
  }

  /**
   * Reserves the delegation durably, hands the child to the existing runner and returns at once.
   *
   * The order is the safety property: **reserve, then start**. A crash between the two leaves a durable
   * `accepted` operation and no child, which recovery re-enters under the same run id — whereas starting first and
   * recording afterwards would leave a child nobody can join to a tool call.
   */
  async startDetached(input: CodeSubagentDetachedSpawnInput): Promise<CodeSubagentDetachedStart> {
    if (this.closed) return { status: "refused", code: "subagent_detached_disabled", message: "The child operation service is shutting down" };
    if (!await this.options.enabled({ ctx: input.ctx, companyId: input.companyId })) {
      return { status: "refused", code: "subagent_detached_disabled", message: "Detached sub-agents are not enabled for this company" };
    }
    const runner = this.options.childRunner?.();
    if (!runner) {
      return { status: "refused", code: "tool_not_configured", message: "code.agent.spawn has no sub-agent runner configured" };
    }
    if (input.allowedTools.some((tool) => tool.startsWith("code.agent."))) {
      return {
        status: "refused", code: "subagent_tool_not_delegable",
        message: `${this.options.spawnTool} cannot be delegated: depth 1 means a sub-agent works, it does not delegate`,
      };
    }
    const operationId = codeSubagentOperationId(input.parentRunId, input.toolCallId);
    // Parallelism and write conflicts are checked atomically by reserve-child, across hosts.
    const session = await this.options.loadSession({ ctx: input.ctx, companyId: input.companyId, sessionId: input.sessionId });
    if (!session) {
      return { status: "refused", code: "subagent_session_missing", message: `Session ${input.sessionId} is not available to this caller` };
    }
    if (session.companyId !== input.companyId || session.projectId !== input.projectId || session.id !== input.sessionId) {
      return { status: "refused", code: "subagent_session_missing", message: "The delegation does not match the requested session" };
    }
    const parentState = await this.options.runState.loadRunState(input.companyId, input.parentRunId);
    if (parentState?.details?.parentRunId) return { status: "refused", code: "subagent_depth_exceeded", message: "A child run cannot delegate another child" };
    const scope = this.scopeFor(session);
    const delegation: CodeSubagentDelegationRecord = {
      agentType: input.agentType,
      capabilityProfile: input.capabilityProfile,
      task: input.task,
      paths: [...input.paths],
      model: input.model,
      maxTurns: input.maxTurns,
      readOnly: input.readOnly,
      summaryOnly: input.summaryOnly,
      allowedTools: [...input.allowedTools],
      toolCallingMode: input.toolCallingMode,
    };
    /**
     * The reserve **is** the join key: idempotent by the deterministic child run id, so a retried tool call
     * re-reads the delegation it already created. A refused reserve (a dead parent lease, the cleanup fence, the
     * operation ceiling) is reported as a refusal, never as an accepted delegation.
     */
    let created = false;
    try {
      const reservation = await this.options.store.transact(scope, {
        kind: "reserve-child", operationId, childRunId: input.childRunId, toolCallId: input.toolCallId,
        agentType: input.agentType, runId: input.parentRunId, owner: input.parentOwner, delegation: { ...delegation },
        maxParallelism: input.maxParallelism,
      });
      /**
       * "Did **this** call create the delegation?" is the question that decides whether a child is started, and the
       * store answers it directly. Reading the row back instead would be wrong: a reservation made by an earlier
       * call can still be in its `accepted` state — recorded but not yet observed as running — and a retry must
       * adopt that child rather than start a second one beside it.
       */
      created = reservation.reserved;
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "subagent_reserve_failed";
      return { status: "refused", code, message: `The delegation could not be recorded durably (${code})` };
    }

    if (created) {
      if (this.options.ensureChildSession) {
        const childSession = await this.options.ensureChildSession({ ctx: input.ctx, parent: session, childRunId: input.childRunId });
        if (childSession.parentSessionId !== session.id || childSession.companyId !== session.companyId || childSession.projectId !== session.projectId) throw new CodeAgentControlError("subagent_session_missing", 404);
        await this.options.store.transact(scope, { kind: "bind-child-session", childRunId: input.childRunId, childSessionId: childSession.id });
      }
      const claim = await this.options.store.transact(scope, {
        kind: "update-child", childRunId: input.childRunId, owner: input.parentOwner, state: "running",
      });
      if (claim.claimed) this.launch(input.ctx, scope, delegation, input.childRunId, input.parentRunId, input.parentOwner, input.toolCallId, input.snapshotId ?? null, runner, claim.operations.find((op) => op.child?.runId === input.childRunId)?.child?.sessionId);
    }
    if (!input.readOnly && input.paths.length) {
      this.writeScopes.claim(input.parentRunId, { operationId, childRunId: input.childRunId, paths: [...input.paths] });
    }
    return {
      status: "accepted", childRunId: input.childRunId, operationId,
      // A retry adopts the delegation it already made; only a delegation this call created is a new one.
      duplicate: !created,
    };
  }

  /**
   * The detached path's settlement entry point: the adapter that ran the child reports its metadata-only outcome
   * here, and this is where the durable operation reaches a terminal state. The session is resolved from the
   * request the child ran under — a server fact, passed straight through — never from caller input.
   */
  async settleChild(
    request: { ctx: AuthContext; companyId: string; projectId: string; sessionId: string; parentSessionId?: string; runStateOwner?: string },
    childRunId: string,
    outcome: CodeSubagentChildOutcome,
  ): Promise<void> {
    const session = await this.options.loadSession({ ctx: request.ctx, companyId: request.companyId, sessionId: request.parentSessionId ?? request.sessionId });
    if (!session) return;
    await this.settle(request.ctx, this.scopeFor(session), childRunId, outcome, request.runStateOwner);
  }

  /** Starts (or restarts) one child under its deterministic run id. Never awaited by the parent's tool call. */
  private launch(
    ctx: AuthContext,
    scope: CodeProcessScopeLike,
    delegation: CodeSubagentDelegationRecord,
    childRunId: string,
    parentRunId: string,
    parentOwner: string,
    toolCallId: string,
    snapshotId: string | null,
    runner: CodeSubagentDetachedRunner,
    childSessionId?: string,
    continuation?: CodeSubagentChildRunRequest["continuation"],
  ): void {
    const controller = new AbortController();
    const operationId = codeSubagentOperationId(parentRunId, toolCallId);
    this.running.set(childRunId, { controller, parentRunId, operationId, companyId: scope.companyId, sessionId: scope.sessionId });
    const request: CodeSubagentChildRunRequest = {
      ctx,
      companyId: scope.companyId,
      projectId: scope.projectId,
      sessionId: childSessionId ?? scope.sessionId,
      ...(childSessionId ? { parentSessionId: scope.sessionId } : {}),
      ...(continuation ? { continuation } : {}),
      parentRunId,
      toolCallId,
      runId: childRunId,
      agentType: delegation.agentType as CodeSubagentChildRunRequest["agentType"],
      capabilityProfile: delegation.capabilityProfile,
      task: delegation.task,
      paths: [...delegation.paths],
      model: delegation.model,
      maxTurns: delegation.maxTurns,
      readOnly: delegation.readOnly,
      summaryOnly: delegation.summaryOnly,
      allowedTools: [...delegation.allowedTools],
      snapshotId,
      toolCallingMode: delegation.toolCallingMode,
      /** The child run's own lease identity, derived from its run id so the same delegation is always one owner. */
      runStateOwner: continuation?.owner ?? codeSubagentRunOwner(childRunId),
      signal: controller.signal,
      /**
       * The durable parent link of this child run. It is written with the run row by the runner, in the same
       * `startRun` that creates the child: "which run delegated this one, and under which tool call" is then a
       * fact of the run itself, not a convention of the process that started it.
       */
      runDetails: { parentRunId, parentToolCallId: toolCallId, agentType: delegation.agentType, detached: true },
    };
    try {
      runner.ack?.(request);
    } catch {
      this.options.logger?.warn("subagent_detached_ack_failed");
    }
    /**
     * The child is handed to the runner **synchronously**, before `startDetached` returns, so "accepted" means "a
     * producer is working on this" and not "a background task may start a tick later": a receipt that could be
     * followed by a crash before anything ran would be a lie, and every reader of the receipt — the retry, the
     * parent's cleanup fence, recovery — is written against the child being in flight. The returned promise is
     * deliberately **not awaited**: that, and only that, is "the parent is not awaited".
     *
     * The rejection handler is attached in the same tick, so a runner that throws synchronously (or returns a
     * rejected promise) becomes the child's own failed outcome — never an unhandled rejection and never a parent
     * failure. A child that throws is a child that failed.
     */
    const ran: Promise<CodeSubagentChildOutcome> = (() => {
      try {
        return Promise.resolve(runner.run(request));
      } catch (error) {
        return Promise.reject(error);
      }
    })();
    const childOutcome: Promise<CodeSubagentChildOutcome> = ran.catch((error) => ({
      runId: childRunId,
      status: "failed" as const,
      errorCode: typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "subagent_run_failed",
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : "The sub-agent run failed",
    }));
    void (async () => {
      // Poll durable cancel intent while THIS service owns a live child. This only delivers a signal;
      // execution ownership and state stay in the existing runner/run log.
      const timer = setInterval(() => {
        void this.readOperation(scope, childRunId).then((op) => {
          if (op?.cancelRequested) controller.abort(Object.assign(new Error("Sub-agent interrupted"), { code: "subagent_interrupt" }));
        }).catch(() => controller.abort(new Error("Child control state unavailable")));
      }, 100);
      timer.unref?.();
      const live = this.running.get(childRunId); if (live) live.timer = timer;
      // The durable dispatch claim was committed before launch; only settlement remains asynchronous.
      try {
        const outcome = await childOutcome;
        await this.settle(ctx, scope, childRunId, outcome, request.runStateOwner).catch(() => this.options.logger?.warn("subagent_detached_settle_failed"));
      } finally { clearInterval(timer); }
    })();
  }

  /**
   * The one settlement. It writes the terminal operation state **and** the child's metadata-only outcome into the
   * same slot, and the store produces the completion notice in the same transaction — so the parent's Step-4
   * collector delivers it with no second channel and no second outbox. The operation is the join key between the
   * child's run and the parent's inbox.
   *
   * The write is fenced by the **child run's own** lease identity (`codeSubagentRunOwner`), which is the identity
   * the launch started that run under: the store refuses a terminal transition while a *different* owner holds a
   * live lease on the child run, and accepts it when the child's run is over or never existed (a child whose run
   * row is gone is settled from the durable record, which is what recovery after a crash has to be able to do).
   */
  private async settle(
    ctx: AuthContext,
    scope: CodeProcessScopeLike,
    childRunId: string,
    outcome: CodeSubagentChildOutcome,
    owner?: string,
  ): Promise<void> {
    const operation = await this.readOperation(scope, childRunId);
    if (!operation) return;
    if (operation.state === "completed" || operation.state === "failed") return;
    const completed = outcome.status === "completed";
    try {
      await this.options.store.transact(scope, {
        kind: "update-child", childRunId, owner: owner ?? operation.child?.owner ?? codeSubagentRunOwner(childRunId),
        state: outcome.status === "interrupted" ? "interrupted" : completed ? "completed" : "failed",
        errorCode: completed ? null : outcome.errorCode ?? "subagent_run_failed",
        outcome: {
          answer: outcome.answer ?? null,
          filesChanged: outcome.filesChanged ? [...outcome.filesChanged] : [],
          toolCalls: outcome.toolCalls ?? 0,
          turns: outcome.turns ?? 0,
        },
      });
    } catch (error) {
      /**
       * A declined settlement (the child's lease moved on, or the operation was never reserved) leaves the
       * operation active. That is the safe direction: an in-flight child keeps the cleanup fence up rather than
       * being reported finished by a process that no longer owns it, and the operation stays recoverable.
       */
      const code = typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "unknown";
      this.options.logger?.warn(`subagent_settle_refused:${code}`);
      return;
    }
    this.running.delete(childRunId);
    this.writeScopes.release(operation.runId, operation.operationId);
    if (outcome.status !== "interrupted") this.options.onSettled?.({
      ctx, companyId: scope.companyId, projectId: scope.projectId, sessionId: scope.sessionId,
      parentRunId: operation.runId, childRunId,
    });
  }

  private scopeFor(session: CodeSession): CodeProcessScopeLike {
    return {
      companyId: session.companyId,
      projectId: session.projectId,
      sessionId: session.id,
      dataClassification: session.dataClassification,
      retentionClass: session.retentionClass,
    };
  }

  /**
   * One operation read, by the child run id.
   *
   * The read is scoped to the session and then filtered by the child's own run id rather than by an operation id
   * the child runner does not know. `kind === "subagent"` is checked as well, so a process operation that happens
   * to share an id can never be mistaken for a delegation.
   */
  private async readOperation(scope: CodeProcessScopeLike, childRunId: string): Promise<DurableCodeProcess | null> {
    const listed = await this.options.store.transact(scope, { kind: "read" });
    return listed?.operations.find((op) => op.kind === "subagent" && op.child?.runId === childRunId && op.sessionId === scope.sessionId) ?? null;
  }
  /** The children of one session, newest first, as recovery and the cleanup fence read them. */
  async listChildren(scope: CodeProcessScopeLike, parentRunId?: string | null): Promise<DurableCodeProcess[]> {
    const listed = await this.options.store.transact(scope, { kind: "read" });
    return (listed?.operations ?? []).filter((op) => op.kind === "subagent" && op.sessionId === scope.sessionId
      && (!parentRunId || op.runId === parentRunId));
  }

  /**
   * Recovery: every unfinished delegation of one session, brought forward **without replaying anything blindly**.
   *
   * The child's own C6a run state is the oracle, and the outcomes are exhaustive:
   *
   *  - `completed` / `failed` / `cancelled` / `waiting_for_user` — the child is not driving anything any more, so
   *    the operation is settled **from that state**, with no model call and no tool call. (A delegated run cannot
   *    ask a question — the question tool is not in a child's scope — so `waiting_for_user` is not a live pause.)
   *  - `running` with a live lease — some worker owns it; left completely alone.
   *  - An accepted reservation without a run row is claimed atomically before launch.
   *  - A dispatched child with missing, interrupted or expired run state stays fenced for explicit C10 recovery.
   */
  async recover(input: { ctx: AuthContext; companyId: string; sessionId: string; parentRunId?: string | null }): Promise<{ recovered: number; settled: number; skipped: number }> {
    if (this.closed) return { recovered: 0, settled: 0, skipped: 0 };
    if (!await this.options.enabled({ ctx: input.ctx, companyId: input.companyId })) return { recovered: 0, settled: 0, skipped: 0 };
    const session = await this.options.loadSession({ ctx: input.ctx, companyId: input.companyId, sessionId: input.sessionId });
    if (!session) return { recovered: 0, settled: 0, skipped: 0 };
    const scope = this.scopeFor(session);
    const children = await this.listChildren(scope, input.parentRunId ?? null);
    let recovered = 0, settled = 0, skipped = 0;
    for (const operation of children) {
      const child = operation.child;
      if (!child) continue;
      if (operation.state === "completed" || operation.state === "failed") { skipped += 1; continue; }
      if (this.running.has(child.runId)) { skipped += 1; continue; }
      const state = await this.options.runState.loadRunState(session.companyId, child.runId);
      const live = state?.status === "running" && state.leaseExpiresAt !== null && state.leaseExpiresAt.getTime() > (this.options.now?.() ?? Date.now());
      if (live) { skipped += 1; continue; }
      if (state && ["completed", "failed", "cancelled", "waiting_for_user"].includes(state.status)) {
        await this.settle(input.ctx, scope, child.runId, recoverCodeSubagentChildOutcome(state))
          .catch(() => this.options.logger?.warn("subagent_recovery_settle_failed"));
        settled += 1;
        continue;
      }
      const runner = this.options.childRunner?.();
      if (!runner) { skipped += 1; continue; }
      // Only a reservation that has never crossed the durable dispatch boundary can be launched.
      // An expired/interrupted child needs C10 continuation, never a fresh run of its original prompt.
      if (state || operation.state !== "accepted") { skipped += 1; continue; }
      if (operation.cancelRequested) {
        await this.settle(input.ctx, scope, child.runId, { status: "failed", errorCode: "subagent_cancelled" });
        settled += 1;
        continue;
      }
      if (!child.sessionId && this.options.ensureChildSession) {
        const childSession = await this.options.ensureChildSession({ ctx: input.ctx, parent: session, childRunId: child.runId });
        await this.options.store.transact(scope, { kind: "bind-child-session", childRunId: child.runId, childSessionId: childSession.id });
        child.sessionId = childSession.id;
      }
      const claim = await this.options.store.transact(scope, {
        kind: "update-child", childRunId: child.runId, owner: operation.owner, state: "running",
      });
      if (!claim.claimed) { skipped += 1; continue; }
      const delegation = readDelegation(operation);
      recovered += 1;
      this.launch(input.ctx, scope, delegation, child.runId, operation.runId, operation.owner, child.toolCallId, null, runner, child.sessionId);
    }
    return { recovered, settled, skipped };
  }

  /** Step 6 foundation: durable cancel intent, then cooperative interruption of the SAME live child.
   * A remote owner is reported as pending; this method never claims it stopped or releases its fence.
   */
  private async target(input: CodeAgentControlTarget, drain = false) {
    if (this.closed) throw new CodeAgentControlError("subagent_control_unavailable", 503);
    if (!drain && (!await this.options.enabled(input) || !await this.options.controlsEnabled?.(input))) throw new CodeToolError("subagent_detached_disabled", "Async agent controls are disabled", 409, "policy", false, this.options.spawnTool);
    const session = await this.options.loadSession(input).catch((error) => {
      if (error instanceof WorkspaceNotFoundError) throw new CodeAgentControlError("subagent_session_missing", 404);
      throw error;
    });
    if (!session || session.companyId !== input.companyId || session.id !== input.sessionId) throw new CodeAgentControlError("subagent_session_missing", 404);
    const scope = this.scopeFor(session);
    const op = await this.readOperation(scope, input.childRunId);
    if (!op || op.runId !== input.parentRunId) throw new CodeAgentControlError("subagent_child_not_found", 404);
    return { session, scope, op };
  }

  async interrupt(input: CodeAgentControlTarget): Promise<"requested" | "settled" | "pending_remote"> {
    // After rollback, existing delegated work may still be drained. Never launch work here.
    const { scope, op } = await this.target(input, true);
    if (!activeCodeProcess(op)) return "settled";
    await this.options.store.transact(scope, { kind: "cancel", operationId: op.operationId });
    const live = this.running.get(input.childRunId);
    if (!live || live.companyId !== input.companyId || live.sessionId !== input.sessionId || live.parentRunId !== input.parentRunId) return "pending_remote";
    live.controller.abort(Object.assign(new Error("Sub-agent interrupted"), { code: "subagent_interrupt" }));
    return "requested";
  }

  async sendMessage(input: CodeAgentControlTarget & { requestId: string; text: string }) {
    const { op } = await this.target(input);
    if (!op.child?.sessionId || !this.options.inbox) throw new CodeAgentControlError("subagent_control_unavailable", 503);
    if (!activeCodeProcess(op) || op.child.stopRequested) throw new CodeAgentControlError("subagent_not_continuable");
    const result = await this.options.inbox.submit(input.ctx, input.companyId, op.child.sessionId, {
      requestId: input.requestId, text: input.text, mode: "steer",
    });
    const message = result.messages[0];
    return { schemaVersion: 1, childRunId: input.childRunId, childSessionId: op.child.sessionId,
      status: "accepted", messageId: message?.id, target: message?.target, revision: result.state.revision };
  }

  async continueChild(input: CodeAgentControlTarget & { requestId: string }) {
    const { scope, op } = await this.target(input);
    if (!input.requestId || input.requestId.length > 200) throw new CodeAgentControlError("invalid_arguments", 400);
    if (op.child?.continueRequestId === input.requestId || op.child?.continueRequestIds?.includes(input.requestId)) return { schemaVersion: 1, status: "accepted", childRunId: input.childRunId, duplicate: true };
    if (!activeCodeProcess(op) || op.child?.stopRequested) throw new CodeAgentControlError("subagent_not_continuable");
    if (!op.child?.sessionId || !this.options.resumeChild) throw new CodeAgentControlError("subagent_control_unavailable", 503);
    if (this.running.has(input.childRunId)) throw new CodeAgentControlError("subagent_control_busy");
    const state = await this.options.runState.loadRunState(input.companyId, input.childRunId);
    if (!state || state.sessionId !== op.child.sessionId || !["interrupted", "running"].includes(state.status)) throw new CodeAgentControlError("subagent_not_continuable");
    if (state.status === "running" && state.leaseExpiresAt && state.leaseExpiresAt.getTime() > (this.options.now?.() ?? Date.now())) throw new CodeAgentControlError("subagent_control_busy");
    const runner = this.options.childRunner();
    if (!runner) throw new CodeAgentControlError("subagent_control_unavailable", 503);
    const owner = `subagent-resume-${randomUUID()}`;
    const continuation = await this.options.resumeChild({ ctx: input.ctx, companyId: input.companyId, sessionId: op.child.sessionId, runId: input.childRunId, owner });
    if (continuation.unknownCalls) throw new CodeAgentControlError("subagent_unknown_outcome");
    const claimed = await this.options.store.transact(scope, { kind: "continue-child", childRunId: input.childRunId, requestId: input.requestId, owner }).catch(async (error) => {
      await this.options.runState.markInterrupted({ companyId: input.companyId, runId: input.childRunId, reason: "subagent_continue_refused", owner });
      throw error;
    });
    if (claimed.claimed && this.options.inbox) {
      const session = await this.options.loadSession({ ctx: input.ctx, companyId: input.companyId, sessionId: op.child.sessionId });
      if (!session || session.parentSessionId !== input.sessionId) throw new CodeAgentControlError("subagent_session_missing", 404);
      await this.options.inbox.transact(session, { kind: "resume-inputs", runId: input.childRunId, owner });
    }
    if (claimed.claimed) this.launch(input.ctx, scope, readDelegation(op), input.childRunId, op.runId, op.owner, op.child.toolCallId, null, runner,
      op.child.sessionId, { prompt: continuation.prompt, owner, turnIndex: continuation.turnIndex });
    return { schemaVersion: 1, status: "accepted", childRunId: input.childRunId, duplicate: !claimed.claimed };
  }

  /** Parent terminal fence: wait, or explicitly cancel and settle before allowing cleanup. */
  async settleChildren(input: Omit<CodeAgentControlTarget, "childRunId"> & { cancel: boolean; timeoutMs?: number }): Promise<boolean> {
    // As in hasRequiredChild: a session that cannot be read is not "a child is still running"; this process's own children
    // still answer for themselves.
    const session = await this.readableSession(input); if (!session) return !this.hasActiveChild(input.parentRunId);
    const scope = this.scopeFor(session);
    const deadline = Date.now() + (input.timeoutMs ?? 30_000);
    do {
      const children = (await this.listChildren(scope, input.parentRunId)).filter(activeCodeProcess);
      if (!children.length) return true;
      if (input.cancel) for (const child of children) {
        if (!child.child) continue;
        await this.options.store.transact(scope, { kind: "cancel", operationId: child.operationId, terminal: true });
        const state = await this.options.runState.loadRunState(input.companyId, child.child.runId);
        const live = this.running.get(child.child.runId);
        if (live) live.controller.abort(new Error("Parent run stopped"));
        else if (!state || state.status !== "running" || !state.leaseExpiresAt || state.leaseExpiresAt.getTime() <= Date.now()) {
          // A dispatched missing/expired run can have a tool still alive; do not infer settlement.
          if (child.state === "accepted" || state?.status === "interrupted" || (state && ["completed", "failed", "cancelled"].includes(state.status))) {
            if (state?.status === "interrupted") await this.options.runState.markFinished({ companyId: input.companyId, runId: child.child.runId, status: "cancelled", reason: "parent_cancelled" });
            await this.settle(input.ctx, scope, child.child.runId, { status: "failed", errorCode: "parent_cancelled" });
          }
        } else await this.options.store.transact(scope, { kind: "cancel", operationId: child.operationId });
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (true);
  }

  /** Stops every in-flight child of this process. Called on shutdown, beside the existing registries. */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.running.values()) { if (entry.timer) clearInterval(entry.timer); entry.controller.abort(new Error("Server shutting down")); }
    this.running.clear();
  }
}

/**
 * The delegation as the durable record kept it.
 *
 * A recovered child is re-entered with the **same** resolved delegation — task, scopes, tool intersection,
 * read-only intent, turn ceiling — because the record is the delegation. If the record cannot be read (an
 * operation written by a build that predates it) recovery refuses to invent one: the child is re-entered as a
 * read-only, one-turn, no-tool delegation, which can only ever answer with an empty digest. That is the
 * fail-closed direction for "we no longer know what this child was allowed to do".
 */
export function readDelegation(operation: DurableCodeProcess): CodeSubagentDelegationRecord {
  const raw = operation.delegation;
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    agentType: typeof raw?.agentType === "string" ? raw.agentType : operation.child?.agentType ?? "explore",
    capabilityProfile: typeof raw?.capabilityProfile === "string" ? raw.capabilityProfile : "unknown",
    task: typeof raw?.task === "string" ? raw.task : "Continue the delegated task recorded for this sub-agent.",
    paths: strings(raw?.paths),
    model: typeof raw?.model === "string" ? raw.model : null,
    maxTurns: typeof raw?.maxTurns === "number" && Number.isInteger(raw.maxTurns) && raw.maxTurns > 0 ? raw.maxTurns : 1,
    readOnly: raw?.readOnly !== false,
    summaryOnly: raw?.summaryOnly !== false,
    allowedTools: strings(raw?.allowedTools),
    toolCallingMode: typeof raw?.toolCallingMode === "string" ? raw.toolCallingMode : "text",
  };
}
