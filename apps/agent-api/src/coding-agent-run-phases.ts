import type { CodingAgentRunnerPorts } from "./coding-agent-runner-contracts";
import type { CodeAgentLimits } from "./code-agent-config";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { ModelRequestPressure } from "./code-context-budget";
import { CODE_AGENT_MASTER_FLAG } from "./feature-flags";
import { toPersistedSelfReview, type SelfReviewVerdict } from "./code-self-review";
import { CodingAgentStopReason, CodingAgentRunStatus, CodeRunReplayRecorderPort, CodingAgentRunInput, CodingAgentPendingApproval, CodingAgentRunSummary, CodingAgentRunResult, CODE_RUN_START_ACTION, CODE_RUN_START_PERMISSION, createCodeRunPolicyComposition } from "./coding-agent-runner-contracts";

export interface CodingAgentRunPhasesHost {
  ports: CodingAgentRunnerPorts;
  limits: CodeAgentLimits;
  now: () => number;
  selfReviewDiffChars: number;
}

export class CodingAgentRunPhases {
  constructor(private readonly host: CodingAgentRunPhasesHost) {}

  private get ports(): CodingAgentRunnerPorts { return this.host.ports; }
  private get limits(): CodeAgentLimits { return this.host.limits; }
  private get now(): () => number { return this.host.now; }
  private get selfReviewDiffChars(): number { return this.host.selfReviewDiffChars; }

  async admitRun(args: {
    ctx: AuthContext;
    input: CodingAgentRunInput;
    session: CodeSession;
    companyId: string;
    projectId: string;
    sessionId: string;
  }): Promise<
    | { admitted: true }
    | { admitted: false; status: CodingAgentRunStatus; reason: CodingAgentStopReason; message: string; code?: string }
  > {
    const { ctx, input, session, companyId, projectId, sessionId } = args;
    try {
      await this.ports.flags.assertEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId, userId: ctx.userId });

      await this.ports.rbac.authorize(ctx, companyId, {
        action: CODE_RUN_START_ACTION,
        permission: CODE_RUN_START_PERMISSION,
        projectId,
        sessionId,
        mode: session.mode,
      });

      if (this.ports.admissionGate) {
        let refusing = false;
        let code = "disk_pressure";
        try {
          refusing = this.ports.admissionGate.isRefusingNewRuns() === true;
          code = this.ports.admissionGate.refusalCode?.() ?? code;
        } catch {
          refusing = true;
          code = "admission_gate_unavailable";
        }
        if (refusing) {
          return {
            admitted: false,
            status: "failed",
            reason: "refused",
            message: `The deployment is refusing new runs (${code}); the run was not started.`,
            code,
          };
        }
      }

      if (input.imageReference) {
        if (!this.ports.imageAdmission) {
          return {
            admitted: false,
            status: "failed",
            reason: "refused",
            message: "Sandbox image admission policy is not configured; the run was not started.",
          };
        }
        const admitted = await this.ports.imageAdmission.admit(ctx, { companyId, reference: input.imageReference });

        this.ports.environment?.setSandboxImage({
          digest: admitted.digest ?? null,
          ...(admitted.sbomRef !== undefined ? { sbomRef: admitted.sbomRef } : {}),
        });
      }

      const readerInput = {
        ctx,
        companyId,
        projectId,
        ...(sessionId ? { sessionId } : {}),
        ...(input.model ? { model: input.model } : {}),
      };
      const readFact = async <T>(read: (() => Promise<T | null>) | undefined): Promise<T | null> => {
        if (!read) return null;
        try {
          return await read();
        } catch {
          return null;
        }
      };
      const policyComposition = await createCodeRunPolicyComposition({
        ctx,
        companyId,
        projectId,
        ...(sessionId ? { sessionId } : {}),
        ...(this.ports.policyCompositionSources ? { sources: this.ports.policyCompositionSources } : {}),
      });
      this.ports.environment?.setPolicyComposition(policyComposition);
      const factSources = this.ports.policyCompositionSources;
      this.ports.environment?.setFeatureFlags(
        await readFact(factSources?.featureFlags ? () => factSources.featureFlags!(readerInput) : undefined),
      );
      this.ports.environment?.setProviderDataPolicy(
        await readFact(
          factSources?.providerDataPolicy ? () => factSources.providerDataPolicy!(readerInput) : undefined,
        ),
      );
      this.ports.environment?.setBaseCommit(
        await readFact(
          factSources?.baseCommit
            ? () => factSources.baseCommit!({ ctx, companyId, projectId })
            : undefined,
        ),
      );
      this.ports.environment?.setToolchain(
        await readFact(
          factSources?.toolchain ? () => factSources.toolchain!({ ctx, companyId, projectId }) : undefined,
        ),
      );
      return { admitted: true };
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      return {
        admitted: false,
        status: "failed",
        reason: "refused",
        message: failure.message ?? `The run was refused (${failure.code ?? "refused"}).`,
      };
    }
  }

  async startRunState(args: {
    ctx: AuthContext;
    input: CodingAgentRunInput;
    session: CodeSession;
    companyId: string;
    projectId: string;
    sessionId: string;
    stateOwner: string;
    prompt: string;
    useInbox: boolean;
    finish: (
      status: CodingAgentRunStatus,
      reason: CodingAgentStopReason,
      message: string,
      code?: string,
    ) => CodingAgentRunResult;
  }): Promise<{ ok: true; runId: string } | { ok: false; result: CodingAgentRunResult }> {
    const { ctx, input, session, companyId, projectId, sessionId, stateOwner, prompt, useInbox, finish } = args;
    try {
      const startedState = await this.ports.runState!.startRun({
        ctx,
        companyId,
        projectId,
        sessionId,
        owner: stateOwner,
        ...(input.runDetails ? { details: input.runDetails } : {}),
        ...(input.runId ? { runId: input.runId } : {}),

        request: prompt,
        dataClassification: session.dataClassification,
        retentionClass: session.retentionClass,
      });
      if (useInbox && !(await this.ports.runState!.renewLease({ companyId, runId: startedState.runId, owner: stateOwner })).held) {
        return {
          ok: false,
          result: finish("interrupted", "interrupted", "Another worker already owns this run. No model or tool was dispatched."),
        };
      }
      const stateRunId = startedState.runId;

      if (this.ports.sessionRunLink && session.runId !== stateRunId) {
        try {
          const link = await this.ports.sessionRunLink({
            ctx, companyId, projectId, sessionId, runId: stateRunId,
          });
          if (!link.linked) {
            this.ports.logger?.warn("code_session_run_link_failed", {
              sessionId, runId: stateRunId, reason: link.reason ?? "unknown",
            });
          }
        } catch (error) {
          this.ports.logger?.warn("code_session_run_link_error", {
            sessionId, runId: stateRunId, reason: (error as Error).message,
          });
        }
      }
      return { ok: true, runId: stateRunId };
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      return {
        ok: false,
        result: finish(
          "failed",
          "refused",
          failure.message ?? `The run state could not be recorded (${failure.code ?? "state_unavailable"}).`,
        ),
      };
    }
  }

  async pauseForUserOnce(args: {
    ctx: AuthContext;
    session: CodeSession;
    companyId: string;
    steps: number;
    turnId: string;
    stateRunId: string | undefined;
    stateOwner: string;
    inboxOpened: boolean;
    summary: CodingAgentRunSummary;
    question: { questionId: string; toolCallId: string };
    waitingFor: "question" | "approval";
    writeState: (operation: () => Promise<unknown>) => Promise<void>;
    stopHeartbeat: () => void;
    turnCheckpointId: () => string | null;
    release: (reason: string) => Promise<void>;
    finish: (
      status: CodingAgentRunStatus,
      reason: CodingAgentStopReason,
      message: string,
      code?: string,
    ) => CodingAgentRunResult;
  }): Promise<{ result: CodingAgentRunResult; inboxOpened: boolean }> {
    const {
      ctx,
      session,
      companyId,
      steps,
      turnId,
      stateRunId,
      stateOwner,
      summary,
      question,
      waitingFor,
      writeState,
      stopHeartbeat,
      turnCheckpointId,
      release,
      finish,
    } = args;
    let inboxOpened = args.inboxOpened;
    if (stateRunId && this.ports.runState) {
      if (this.ports.runState.markWaitingForUser) {
        await writeState(() => this.ports.runState!.markWaitingForUser!({
          companyId, runId: stateRunId!, questionId: question.questionId, toolCallId: question.toolCallId,
        }));
      } else {

        this.ports.logger?.warn("run_state_pause_unsupported", {
          runId: stateRunId, questionId: question.questionId,
        });
      }
      await writeState(() => this.ports.runState!.appendTurn({
        companyId, runId: stateRunId!, turnIndex: steps, status: "finished", outcome: "ok",
        checkpointId: turnCheckpointId(),
      }));
    }
    stopHeartbeat();

    if (inboxOpened && stateRunId) {
      try {
        await this.ports.inbox!.transact(session, { kind: "pause", runId: stateRunId, owner: stateOwner });
        inboxOpened = false;
      } catch {
        this.ports.logger?.warn("inbox_pause_not_recorded");
      }
    }
    await release("waiting_for_user");
    await this.ports.runEvents?.append({
      eventKey: `code-run-waiting-for-user:${turnId}`,
      eventType: "waiting_for_user",
      runStatus: "waiting_for_user",
      message: waitingFor === "approval"
        ? "Coding Agent run is waiting for an approval decision"
        : "Coding Agent run is waiting for the user to answer a question",
    });
    summary.turns = steps;
    summary.remaining = waitingFor === "approval"
      ? "The run is waiting for an approval decision."
      : "The run is waiting for the user to answer a question.";
    return {
      result: finish(
        "waiting_for_user",
        "waiting_for_user",
        waitingFor === "approval"
          ? `Waiting for an approval decision on tool call ${question.toolCallId}.`
          : `Waiting for the user to answer question ${question.questionId}.`,
      ),
      inboxOpened,
    };
  }

  buildRunResult(args: {
    input: CodingAgentRunInput;
    summary: CodingAgentRunSummary;
    pendingApprovals: CodingAgentPendingApproval[];
    stopHeartbeat: () => void;
    status: CodingAgentRunStatus;
    reason: CodingAgentStopReason;
    message: string;
    code: string | undefined;
    unsettledChildren: boolean;
    snapshotId: string;
    startedAt: number;
    stateRunId: string | undefined;
    model: string | undefined;
    provider: string | undefined;
    lastBudget: ModelRequestPressure | null;
    compactionCount: number;
  }): CodingAgentRunResult {
    const {
      input,
      summary,
      pendingApprovals,
      stopHeartbeat,
      status,
      reason,
      message,
      code,
      unsettledChildren,
      snapshotId,
      startedAt,
      stateRunId,
      model,
      provider,
      lastBudget,
      compactionCount,
    } = args;
    stopHeartbeat();

    this.ports.environment?.setRunSummary(null);
    const finishedAt = this.now();

    const reportedStatus: CodingAgentRunStatus = unsettledChildren && status !== "waiting_for_user" ? "interrupted" : status;
    const reportedReason: CodingAgentStopReason = unsettledChildren && status !== "waiting_for_user"
      ? "active_subagent_unsettled"
      : reason;
    return {
      status: reportedStatus,
      reason: reportedReason,
      message: unsettledChildren && status !== "waiting_for_user"
        ? `The run ended while a delegated sub-agent was still required; its completion has not been collected (${message})`
        : message,
      summary,
      snapshotId,
      startedAt,
      finishedAt,
      ...(code ? { code } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(stateRunId ? { runId: stateRunId } : {}),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),

      ...(lastBudget
        ? {
            context: {
              currentTokens: lastBudget.currentTokens,
              maxContextTokens: lastBudget.maxContextTokens,
              utilizationRatio: lastBudget.utilizationRatio,
              compactions: compactionCount,
            },
          }
        : {}),

      ...(summary.verification ? { verification: summary.verification } : {}),
      ...(summary.scope ? { scope: summary.scope } : {}),

      ...(summary.selfReview ? { selfReview: summary.selfReview } : {}),

      ...(pendingApprovals.length ? { pendingApprovals: pendingApprovals.map((entry) => ({ ...entry })) } : {}),
    };
  }

  async stopRun(args: {
    ctx: AuthContext;
    input: CodingAgentRunInput;
    session: CodeSession;
    companyId: string;
    projectId: string;
    sessionId: string;
    status: Exclude<CodingAgentRunStatus, "waiting_for_user">;
    reason: CodingAgentStopReason;
    message: string;
    inboxOpened: boolean;
    stateRunId: string | undefined;
    stateOwner: string;
    summary: CodingAgentRunSummary;
    snapshotId: string;
    replayRecorder: CodeRunReplayRecorderPort | undefined;
    completionArtifacts: Record<string, unknown>[];
    compressionArtifacts: Record<string, unknown>[];
    commandProvenance: readonly Record<string, unknown>[];
    selfReviewVerdict: SelfReviewVerdict | null;
    unsettledChildren: boolean;
    writeState: (operation: () => Promise<unknown>) => Promise<void>;
    finish: (
      status: CodingAgentRunStatus,
      reason: CodingAgentStopReason,
      message: string,
      code?: string,
    ) => CodingAgentRunResult;
  }): Promise<{ result: CodingAgentRunResult; inboxOpened: boolean }> {
    const {
      ctx,
      input,
      session,
      companyId,
      projectId,
      sessionId,
      message,
      stateRunId,
      stateOwner,
      summary,
      snapshotId,
      replayRecorder,
      completionArtifacts,
      compressionArtifacts,
      commandProvenance,
      selfReviewVerdict,
      unsettledChildren,
      writeState,
      finish,
    } = args;
    let status = args.status;
    let reason = args.reason;
    let inboxOpened = args.inboxOpened;
    if (unsettledChildren) { status = "interrupted"; reason = "active_subagent_unsettled"; }
    if (inboxOpened && stateRunId) {
      try {
        if (this.ports.runState && !(await this.ports.runState.renewLease({ companyId, runId: stateRunId, owner: stateOwner })).held) {
          return { result: finish("interrupted", "interrupted", "The run lease changed before settlement. The replacement's state was not modified."), inboxOpened };
        }
        await this.ports.inbox!.transact(session, { kind: "close", runId: stateRunId, owner: stateOwner });
        inboxOpened = false;
      } catch {

        return { result: finish("interrupted", "interrupted", "Durable inbox settlement could not be confirmed. Pending input remains recoverable."), inboxOpened };
      }
    }

    if (replayRecorder) {
      try {
        await replayRecorder.finalize({
          ...(completionArtifacts.length ? { completionArtifacts } : {}),
          terminalStatus: status,
          terminalReason: reason,
          compressionArtifacts,

          commandExpansions: commandProvenance,
        });
      } catch (error) {
        this.ports.logger?.warn("replay_bundle_refused", {
          code: (error as { code?: string })?.code ?? "replay_bundle_error",
          runId: stateRunId ?? input.runId,
        });
      }
    }
    if (stateRunId && this.ports.runState) {

      const stateStatus = status === "cancelled"
        ? "cancelled"
        : status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "completed";
      if (status === "interrupted" && (input.detachedChildInbox || unsettledChildren || reason === "async_collect_unsettled")) {
        await writeState(() => this.ports.runState!.markInterrupted?.({ companyId, runId: stateRunId!, reason })
          ?? this.ports.runState!.markFinished({ companyId, runId: stateRunId!, status: "interrupted", reason }));
        await writeState(() => this.ports.runState!.releaseLease?.({ companyId, runId: stateRunId!, owner: stateOwner }) ?? Promise.resolve());
      } else await writeState(() => this.ports.runState!.markFinished({
        companyId, runId: stateRunId!, status: stateStatus, reason,

        estimate: {
          tokenCount: summary.tokens,
          costUsd: Number.isFinite(summary.costUsd) ? summary.costUsd : null,
          turns: summary.turns,
          toolCalls: summary.toolCalls,
          filesChanged: summary.filesChanged.length,
          diffStats: summary.diffStats,

          ...(summary.verification ? { verification: summary.verification } : {}),
          ...(summary.scope ? { scope: summary.scope } : {}),

          ...(selfReviewVerdict ? { selfReview: toPersistedSelfReview(selfReviewVerdict) } : {}),
        },
      }));
    }

    try {
      await this.ports.lifecycleHooks?.stop({
        ctx, companyId, projectId, sessionId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(stateRunId ? { runId: stateRunId } : {}),
        snapshotId: snapshotId ?? null,
        status,
        reason,
      });
    } catch {

    }
    return { result: finish(status, reason, message), inboxOpened };
  }

}
