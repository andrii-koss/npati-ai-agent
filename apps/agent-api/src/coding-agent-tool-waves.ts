import type { ModelTurnUsage } from "@npati/shared";
import type { ChatMessage } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { CodeAgentLimits } from "./code-agent-config";
import {
  planToolCallWaves,
  toolCallFeedback,
  type NormalizedToolCall,
  type NormalizeToolCallsResult,
} from "./code-tool-call-adapter";
import type { CodeModelProfile } from "./code-model-profiles";
import {
  type CodeToolInvokeFailure,
  type CodeToolInvokeResult,
} from "./code-tool-runtime";
import {
  canonicalizeSettledToolResult,
  boundText,
  replayArgumentsHash,
} from "./code-replay-bundle";
import {
  type CodingAgentStopReason,
  type CodingAgentRunStatus,
  type CodeRunRuntimeToolDescriptor,
  type CodeRunActivityEvent,
  type CodeRunReplayRecorderPort,
  type CodingAgentRunnerPorts,
  type CodingAgentRunInput,
  type CodingAgentPendingApproval,
  type CodingAgentRunSummary,
  type CodingAgentRunResult,
  CODE_ASK_USER_TOOL,
  CHECK_TOOL_PREFIXES,
  LOOP_REPEAT_THRESHOLD,
  MAX_ARGUMENT_CORRECTIONS,
  REMINDER_MESSAGE,
  isReadOnlyRunTool,
  toolCallSignature,
  emitCodingActivity,
} from "./coding-agent-runner-contracts";
import type { CodingAgentReviewCoordinator } from "./coding-agent-review-coordinator";
import { compactWriteReceipt, recordWrittenFiles } from "./code-write-receipt";

export interface ToolWavesExecutionHost {
  ports: CodingAgentRunnerPorts;
  limits: CodeAgentLimits;
  now: () => number;
  input: CodingAgentRunInput;
  ctx: AuthContext;
  session: CodeSession;
  companyId: string;
  projectId: string;
  sessionId: string;
  turnId: string;
  stepTurnKey: (index: number) => string;
  stateRunId: string | undefined;
  stateOwner: string;
  toolSteps: number[];
  capabilityScopeFields: Record<string, unknown>;
  summary: CodingAgentRunSummary;
  messages: ChatMessage[];
  runtimeToolByName: Map<string, CodeRunRuntimeToolDescriptor>;
  toolVersionByName: Map<string, number>;
  completionArtifacts: Record<string, unknown>[];
  replayRecorder: CodeRunReplayRecorderPort | undefined;
  pendingApprovals: CodingAgentPendingApproval[];
  modelUsage?: ModelTurnUsage;
  reviewCoordinator: CodingAgentReviewCoordinator;
  record: (event: CodeRunActivityEvent) => Promise<void>;
  release: (reason: string) => Promise<void>;
  writeState: (operation: () => Promise<unknown>) => Promise<void>;
  stop: (
    status: Exclude<CodingAgentRunStatus, "waiting_for_user">,
    reason: CodingAgentStopReason,
    message: string,
  ) => Promise<CodingAgentRunResult>;
  pauseForUser: (
    question: { questionId: string; toolCallId: string },
    waitingFor?: "question" | "approval",
  ) => Promise<CodingAgentRunResult>;
}

export function approvalPauseFrom(
  outcome: { call: NormalizedToolCall; result: CodeToolInvokeResult | CodeToolInvokeFailure },
): CodingAgentPendingApproval | null {
  if (outcome.result.ok) return null;
  const error = outcome.result.error as { code?: string; details?: Record<string, unknown> };
  if (error.code !== "approval_required") return null;
  const details = error.details ?? {};
  if (details.pauseForApproval !== true) return null;
  const approvalId = details.approvalId;
  if (typeof approvalId !== "string" || approvalId.length === 0) return null;
  const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
  return {
    approvalId,
    toolCallId: outcome.call.id,
    tool: outcome.call.name,
    connectionId: asString(details.connectionId),
    toolName: asString(details.toolName),
    schemaHash: asString(details.schemaHash),
    argsHash: asString(details.argsHash),
  };
}

export function questionIdFrom(
  outcome: { call: NormalizedToolCall; result: CodeToolInvokeResult | CodeToolInvokeFailure },
): { questionId: string; toolCallId: string } | null {
  if (outcome.call.name !== CODE_ASK_USER_TOOL || !outcome.result.ok) return null;
  const envelope = outcome.result.result;
  if (!envelope || typeof envelope !== "object") return null;
  const data = (envelope as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const questionId = (data as { questionId?: unknown }).questionId;
  if (typeof questionId !== "string" || questionId.length === 0) return null;
  return { questionId, toolCallId: outcome.call.id };
}

export class CodingAgentToolWaves {
  private readonly repeatedSignatures: string[] = [];
  private readonly repeatedErrors: string[] = [];
  private readonly argumentCorrections = new Map<string, number>();
  private readonly zeroDiffEdits: string[] = [];
  private readonly verificationFailures: string[] = [];
  private readonly turnPatterns: string[] = [];
  private loopReminded = false;
  private errorReminded = false;
  private cycleReminded = false;
  private zeroDiffReminded = false;
  private verificationLoopReminded = false;

  constructor(private readonly host: ToolWavesExecutionHost) {}

  async executeTurnTools(args: {
    steps: number;
    normalized: NormalizeToolCallsResult;
    callsToRun: NormalizedToolCall[];
    profile: CodeModelProfile;
    modelUsage?: ModelTurnUsage;
  }): Promise<
    | { action: "continue" }
    | { action: "paused"; result: CodingAgentRunResult }
    | { action: "stopped"; result: CodingAgentRunResult }
  > {
    const { steps, normalized, callsToRun, profile, modelUsage } = args;
    const {
      ports,
      limits,
      now,
      input,
      ctx,
      session,
      companyId,
      projectId,
      sessionId,
      stateRunId,
      stateOwner,
      toolSteps,
      capabilityScopeFields,
      summary,
      messages,
      runtimeToolByName,
      toolVersionByName,
      completionArtifacts,
      replayRecorder,
      pendingApprovals,
      reviewCoordinator,
      record,
      release,
      writeState,
      stop,
      pauseForUser,
    } = this.host;

    for (const rejected of normalized.rejected) {
      const key = `${rejected.name ?? "unknown"}:${rejected.code}`;
      const count = (this.argumentCorrections.get(key) ?? 0) + 1;
      this.argumentCorrections.set(key, count);
      if (count > MAX_ARGUMENT_CORRECTIONS) {
        await release("invalid_arguments_exhausted");
        const res = await stop(
          "stopped",
          "invalid_arguments_exhausted",
          `Stopped: the model kept sending unusable arguments for ${rejected.name ?? "a tool"} (${rejected.code}).`,
        );
        return { action: "stopped", result: res };
      }
      messages.push({
        role: "tool",
        tool_call_id: rejected.id ?? `rejected:${messages.length}`,
        content: JSON.stringify({
          ...toolCallFeedback(rejected),
          hint: `Fix the arguments and retry (attempt ${count} of ${MAX_ARGUMENT_CORRECTIONS}).`,
        }),
      });
      await record({
        kind: "tool_call",
        companyId,
        projectId,
        sessionId,
        runId: input.runId,
        turn: steps,
        tool: rejected.name,
        toolCallId: rejected.id,
        ok: false,
        errorCode: rejected.code,
      });
    }

    if (!callsToRun.length) return { action: "continue" };

    const signatures = callsToRun.map(toolCallSignature);
    this.repeatedSignatures.push(...signatures);
    while (this.repeatedSignatures.length > LOOP_REPEAT_THRESHOLD) this.repeatedSignatures.shift();
    if (this.repeatedSignatures.length === LOOP_REPEAT_THRESHOLD && new Set(this.repeatedSignatures).size === 1) {
      if (this.loopReminded) {
        await release("loop_detected");
        const res = await stop("stopped", "loop_detected", `Stopped: the same tool call (${callsToRun[0]?.name ?? "unknown"}) was repeated without progress.`);
        return { action: "stopped", result: res };
      }
      this.loopReminded = true;
      messages.push({ role: "system", content: REMINDER_MESSAGE });
      await record({ kind: "reminder", companyId, projectId, sessionId, runId: input.runId, turn: steps, reason: "repeated_call" });
    }

    const turnSig = callsToRun.map((c) => {
      const p = (c.arguments as Record<string, unknown>)?.path;
      return p && typeof p === "string" ? `${c.name}:${p}` : c.name;
    }).join(";");
    this.turnPatterns.push(turnSig);
    while (this.turnPatterns.length > 12) this.turnPatterns.shift();
    for (const period of [2, 3]) {
      if (this.turnPatterns.length >= period * 3) {
        const c1 = this.turnPatterns.slice(-period).join("->");
        const c2 = this.turnPatterns.slice(-period * 2, -period).join("->");
        const c3 = this.turnPatterns.slice(-period * 3, -period * 2).join("->");
        if (c1 === c2 && c2 === c3) {
          if (this.cycleReminded) {
            await release("loop_detected");
            const res = await stop("stopped", "loop_detected", `Stopped: repeating cycle of tool calls [${c1}] was detected without progress.`);
            return { action: "stopped", result: res };
          }
          this.cycleReminded = true;
          messages.push({
            role: "system",
            content: `Warning: A repeating pattern of tool calls [${c1}] was repeated 3 times without progress. Change your approach or step back.`,
          });
          await record({ kind: "reminder", companyId, projectId, sessionId, runId: input.runId, turn: steps, reason: "cycle_detected" });
          break;
        }
      }
    }

    const publishActivity = async (event: import("@npati/shared").DevelopmentProcessProgressItem) => {
      await emitCodingActivity(input, event);
    };

    const execute = async (call: NormalizedToolCall): Promise<{ call: NormalizedToolCall; result: CodeToolInvokeResult | CodeToolInvokeFailure }> => {
      const startedCall = now();
      const readOnlyCall = isReadOnlyRunTool(call.name);

      if (stateRunId && ports.runState) {
        await writeState(() => ports.runState!.appendToolCall({
          companyId, runId: stateRunId!, turnIndex: steps,
          toolCallId: call.id, tool: call.name, readOnly: readOnlyCall,
          outcome: "unknown_outcome", startedAt: new Date(startedCall), finishedAt: null,
        }));
      }
      const activityStart = {
        id: `${stateRunId ?? input.runId}:${call.id}`,
        runId: stateRunId ?? input.runId,
        sequence: steps * 1000 + callsToRun.indexOf(call) + 1,
        stage: "tool" as const,
        ...(modelUsage ? { modelUsage } : {}),
        title: call.name,
        tool: call.name,
        at: new Date(startedCall).toISOString(),
        command: typeof call.arguments.command === "string" ? call.arguments.command : undefined,
        file: typeof call.arguments.path === "string" ? call.arguments.path : undefined,
        cwd: typeof call.arguments.cwd === "string" ? call.arguments.cwd : undefined,
        agentId: input.agentId ?? "NPATI Coding Agent",
      };
      await publishActivity({ ...activityStart, status: "running" });
      const invokeInput = {
        leaseOwner: stateOwner,
        companyId,
        projectId,
        sessionId,
        tool: call.name,
        toolVersion: toolVersionByName.get(call.name),
        args: call.arguments,
        toolCallId: call.id,
        turnId: this.host.stepTurnKey(steps),
        runScopeId: this.host.turnId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(stateRunId ? { runId: stateRunId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.readOnlyIntent === true ? { readOnlyIntent: true } : {}),
        ...capabilityScopeFields,
      };
      const beforeVerification = call.name === "code.verify.run" ? await reviewCoordinator.readVerificationRevision() : null;
      let result: CodeToolInvokeResult | CodeToolInvokeFailure;
      try {
        const runtimeTool = runtimeToolByName.get(call.name);
        result = runtimeTool && ports.runtimeCapabilities
          ? await ports.runtimeCapabilities.invoke({
              ctx,
              companyId,
              projectId,
              ...(sessionId ? { sessionId } : {}),
              ...(stateRunId ?? input.runId ? { runId: stateRunId ?? input.runId } : {}),
              ...(input.agentId ? { agentId: input.agentId } : {}),
              ...(input.signal ? { signal: input.signal } : {}),
              ...(input.readOnlyIntent === true ? { readOnlyIntent: true } : {}),
              tool: call.name,
              args: call.arguments,
              toolCallId: call.id,
            })
          : await ports.toolRuntime.invoke(ctx, invokeInput);
      } catch (error) {
        const failure = error as { code?: string; message?: string; status?: number; retryable?: boolean; step?: string; details?: Record<string, unknown> };
        result = {
          ok: false,
          error: {
            code: (failure.code ?? "tool_error") as CodeToolInvokeFailure["error"]["code"],
            status: failure.status ?? 500,
            message: failure.message ?? "Tool execution failed",
            tool: call.name,
            step: failure.step ?? "execute",
            retryable: failure.retryable ?? false,
            ...(failure.details ? { details: failure.details } : {}),
          },
        };
      }

      if (stateRunId && ports.runState) {
        await writeState(() => ports.runState!.appendToolCall({
          companyId, runId: stateRunId!, turnIndex: steps,
          toolCallId: call.id, tool: call.name, readOnly: readOnlyCall,
          outcome: result.ok ? "ok" : "failed",
          ...(result.ok ? {} : { errorCode: result.error.code }),
          startedAt: new Date(startedCall), finishedAt: new Date(now()),
        }));
      }

      if (call.name === "code.verify.run" && result.ok) {
        await reviewCoordinator.onVerifyToolExecuted(beforeVerification, result);
        const envelope = (result.result as Record<string, unknown>)?.data ?? (result.result as Record<string, unknown>);
        const results = Array.isArray((envelope as Record<string, unknown>)?.results)
          ? ((envelope as Record<string, unknown>).results as Array<{ tool: string; ok: boolean; summary?: string }>)
          : [];
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
          const findingsKey = failed.map((f) => `${f.tool}:${f.summary ?? ""}`).sort().join(" | ");
          this.verificationFailures.push(findingsKey);
          while (this.verificationFailures.length > 4) this.verificationFailures.shift();
          if (this.verificationFailures.length >= 3 && this.verificationFailures.slice(-3).every((k) => k === findingsKey)) {
            if (!this.verificationLoopReminded) {
              this.verificationLoopReminded = true;
              messages.push({
                role: "system",
                content: `Warning: Verification checks failed with the exact same error 3 times in a row (${failed[0]?.tool}: ${failed[0]?.summary?.slice(0, 160)}). Your previous edits did not fix the problem. Stop repeating similar edits and diagnose the underlying cause.`,
              });
              await record({ kind: "reminder", companyId, projectId, sessionId, runId: input.runId, turn: steps, reason: "repeated_verify_failure" });
            }
          }
        } else {
          this.verificationFailures.length = 0;
          this.verificationLoopReminded = false;
        }
      }

      await publishActivity({
        ...activityStart,
        status: result.ok ? "completed" : result.error.code === "approval_required" ? "awaiting_approval" : input.signal?.aborted ? "cancelled" : "failed",
        durationMs: now() - startedCall,
        result: JSON.stringify(result.ok ? result.result : result.error),
        ...(result.ok ? { resultTruncated: result.truncated } : { error: result.error.message, errorCode: result.error.code }),
      });
      summary.toolCalls += 1;
      if (result.ok && call.arguments.dryRun !== true) {
        recordWrittenFiles(summary, call.name, result.result);
        if (["code.fs.write", "code.fs.edit", "code.fs.apply_patch"].includes(call.name)) {
          const envelope = ((result.result as Record<string, unknown>)?.data ?? (result.result as Record<string, unknown>)?.result ?? result.result) as Record<string, unknown> | undefined;
          const writePath = typeof envelope?.path === "string" ? envelope.path : String(call.arguments.path ?? "");
          const isZeroDiff = envelope?.linesAdded === 0 && envelope?.linesRemoved === 0 && envelope?.created === false;
          if (isZeroDiff && writePath) {
            this.zeroDiffEdits.push(writePath);
            while (this.zeroDiffEdits.length > 3) this.zeroDiffEdits.shift();
            if (this.zeroDiffEdits.length >= 2 && this.zeroDiffEdits.slice(-2).every((p) => p === writePath)) {
              if (!this.zeroDiffReminded) {
                this.zeroDiffReminded = true;
                messages.push({
                  role: "system",
                  content: `Warning: Writing to "${writePath}" produced 0 line changes (diff was empty). Do not write the exact same file content again without modifications.`,
                });
                await record({ kind: "reminder", companyId, projectId, sessionId, runId: input.runId, turn: steps, reason: "zero_diff_write" });
              }
            }
          } else {
            this.zeroDiffEdits.length = 0;
            this.zeroDiffReminded = false;
          }
        }
      }
      if (CHECK_TOOL_PREFIXES.some((prefix) => call.name.startsWith(prefix)) && result.ok) {
        if (!summary.checksRun.includes(call.name)) summary.checksRun.push(call.name);
      }
      if (result.ok) {
        for (const key of this.argumentCorrections.keys()) {
          if (key.startsWith(`${call.name}:`)) {
            this.argumentCorrections.delete(key);
          }
        }
      }
      await record({
        kind: "tool_call",
        companyId,
        projectId,
        sessionId,
        runId: input.runId,
        turn: steps,
        tool: call.name,
        toolCallId: call.id,
        ok: result.ok,
        ...(result.ok ? {} : { errorCode: result.error.code }),
        durationMs: now() - startedCall,
      });
      return { call, result };
    };

    const waveLimit = Math.max(1, Math.min(profile.maxParallelToolCalls, limits.parallelReadOnlyCalls));
    let turnHadFailure = false;

    const appendToolResult = async (outcome: { call: NormalizedToolCall; result: CodeToolInvokeResult | CodeToolInvokeFailure }): Promise<void> => {
      const text = canonicalizeSettledToolResult({
        ok: outcome.result.ok,
        tool: outcome.call.name,
        ...(outcome.result.ok ? { result: outcome.result.result } : {}),
        ...(outcome.result.ok ? { truncated: outcome.result.truncated } : {}),
        ...(outcome.result.ok ? {} : { error: outcome.result.error }),
        limit: limits.toolOutputChars,
      });
      const modelText = outcome.result.ok ? boundText(compactWriteReceipt(outcome.call.name, JSON.stringify({
        ok:true,tool:outcome.call.name,result:outcome.result.result,truncated:outcome.result.truncated === true,
      })), limits.toolOutputChars) : text;
      replayRecorder?.recordToolCall({
        turnIndex: steps,
        toolCallId: outcome.call.id,
        tool: outcome.call.name,
        toolVersion: toolVersionByName.get(outcome.call.name) ?? null,
        argumentsHash: replayArgumentsHash(outcome.call.arguments),
        settledResult: modelText,
        outcome: outcome.result.ok ? "ok" : "failed",
        ...(outcome.result.ok ? {} : { errorCode: outcome.result.error.code }),
        ...(outcome.result.ok ? { truncated: outcome.result.truncated === true } : {}),
      });
      messages.push({ role: "tool", tool_call_id: outcome.call.id, name: outcome.call.name, content: modelText });
      if (outcome.result.ok && stateRunId && ["code.shell.exec_async", "code.shell.process.wait"].includes(outcome.call.name)) {
        const notice = await ports.completions?.admittedTool(
          ctx,
          session,
          outcome.result.result,
          { runId: stateRunId, owner: stateOwner, turnIndex: steps, text },
          outcome.result.processReceipt,
        );
        if (notice) {
          const metadataText = "Asynchronous result reference (metadata only): " + JSON.stringify(notice);
          messages.push({ role: "user", content: metadataText });
          completionArtifacts.push({ turnIndex: steps + 1, notice, source: "wait", metadataText });
        }
      }
      if (!outcome.result.ok) {
        turnHadFailure = true;
        this.repeatedErrors.push(`${outcome.call.name}:${outcome.result.error.code}`);
        while (this.repeatedErrors.length > LOOP_REPEAT_THRESHOLD) this.repeatedErrors.shift();
      } else {
        this.repeatedErrors.length = 0;
      }
    };

    if (toolSteps[toolSteps.length - 1] !== steps) toolSteps.push(steps);

    const pending = [...callsToRun];
    const cancelled = async () => {
      if (input.signal?.aborted) return true;
      try { return await input.cancelRequested?.() ?? false; } catch { return false; }
    };
    while (pending.length) {
      if (await cancelled()) {
        if (input.detachedChildInbox && (input.signal?.reason as { code?: string } | undefined)?.code === "subagent_interrupt") return { action: "stopped", result: await stop("interrupted", "interrupted", "The child was interrupted between tool calls and can be continued.") };
        await release("cancelled");
        await ports.runEvents?.append({ eventKey: `code-run-cancelled:${this.host.turnId}`, eventType: "cancelled", runStatus: "cancelled", message: "Coding Agent run cancelled between tool calls" });
        return { action: "stopped", result: await stop("cancelled", "cancelled", "The run was cancelled between tool calls. Remaining calls were not executed.") };
      }
      const head = pending.shift();
      if (!head) break;
      if (isReadOnlyRunTool(head.name)) {
        const group: NormalizedToolCall[] = [head];
        while (pending[0] && isReadOnlyRunTool(pending[0].name)) {
          group.push(pending.shift() as NormalizedToolCall);
        }
        for (const wave of planToolCallWaves(group, waveLimit)) {
          const waveOutcomes = await Promise.all(wave.map((call) => execute(call)));
          for (const outcome of waveOutcomes) {
            await appendToolResult(outcome);
            const asked = questionIdFrom(outcome);
            if (asked) {
              const res = await pauseForUser(asked);
              return { action: "paused", result: res };
            }
          }
        }
      } else {
        if (pendingApprovals.length && !runtimeToolByName.has(head.name)) {
          await appendToolResult({
            call: head,
            result: {
              ok: false,
              error: {
                code: "tool_failed", status: 409, tool: head.name, step: "execute", retryable: true,
                message: "Not executed: the run paused to ask a human to approve a runtime MCP tool call.",
              },
            },
          });
          continue;
        }
        const outcome = await execute(head);
        await appendToolResult(outcome);

        const approvalPause = approvalPauseFrom(outcome);
        if (approvalPause) {
          if (stateRunId && ports.runState?.markWaitingForUser) {
            pendingApprovals.push(approvalPause);
            continue;
          }
          ports.logger?.warn("approval_pause_unsupported", {
            runId: stateRunId,
            tool: outcome.call.name,
            approvalId: approvalPause.approvalId,
          });
        }

        if (outcome.call.name === CODE_ASK_USER_TOOL && outcome.result.ok) {
          const asked = questionIdFrom(outcome);
          if (!asked) {
            await release("tool_failure");
            const res = await stop("failed", "tool_failure", "Stopped: code.ask_user reported success without a question id, so the run could not be paused safely.");
            return { action: "stopped", result: res };
          }

          for (const rest of pending) {
            await appendToolResult({
              call: rest,
              result: {
                ok: false,
                error: {
                  code: "tool_failed", status: 409, tool: rest.name, step: "execute", retryable: true,
                  message: "Not executed: the run paused to ask the user a question.",
                },
              },
            });
          }
          pending.length = 0;
          const res = await pauseForUser(asked);
          return { action: "paused", result: res };
        }
      }

      if (this.repeatedErrors.length === LOOP_REPEAT_THRESHOLD && new Set(this.repeatedErrors).size === 1) {
        if (this.errorReminded) {
          await release("loop_detected");
          const res = await stop("stopped", "loop_detected", `Stopped: the same error (${this.repeatedErrors[0] ?? "unknown"}) kept repeating.`);
          return { action: "stopped", result: res };
        }
        this.errorReminded = true;
        messages.push({ role: "system", content: REMINDER_MESSAGE });
        await record({ kind: "reminder", companyId, projectId, sessionId, runId: input.runId, turn: steps, reason: "repeated_error" });
      }

      if (this.verificationFailures.length >= 4 && this.verificationFailures.slice(-4).every((k) => k === this.verificationFailures[this.verificationFailures.length - 1])) {
        await release("loop_detected");
        const res = await stop("stopped", "loop_detected", `Stopped: the same verification failure (${this.verificationFailures[0]?.split(":")[0] ?? "check"}) kept repeating across 4 attempts without progress.`);
        return { action: "stopped", result: res };
      }

      if (this.zeroDiffEdits.length >= 3 && this.zeroDiffEdits.slice(-3).every((p) => p === this.zeroDiffEdits[this.zeroDiffEdits.length - 1])) {
        await release("loop_detected");
        const res = await stop("stopped", "loop_detected", `Stopped: repeated zero-diff edits on "${this.zeroDiffEdits[0]}" without progress.`);
        return { action: "stopped", result: res };
      }
    }

    if (pendingApprovals.length) {
      const res = await pauseForUser(
        { questionId: pendingApprovals[0]!.approvalId, toolCallId: pendingApprovals[0]!.toolCallId },
        "approval",
      );
      return { action: "paused", result: res };
    }

    if (stateRunId && ports.runState) {
      await writeState(() => ports.runState!.appendTurn({
        companyId,
        runId: stateRunId!,
        turnIndex: steps,
        status: "finished",
        outcome: turnHadFailure ? "failed" : "ok",
        checkpointId: reviewCoordinator.turnCheckpointId(steps),
      }));
    }

    return { action: "continue" };
  }
}
