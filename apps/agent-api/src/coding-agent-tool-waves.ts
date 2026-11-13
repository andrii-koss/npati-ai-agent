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
import { toolImageMessage } from "./coding-agent-image-delivery";
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
  LOOP_STOP_REPEATS,
  REMINDER_MESSAGE,
  TRUNCATED_TOOL_CALL_HINT,
  isReadOnlyRunTool,
  toolCallSignature,
  emitCodingActivity,
} from "./coding-agent-runner-contracts";
import type { CodingAgentReviewCoordinator } from "./coding-agent-review-coordinator";
import { compactWriteReceipt, recordWrittenFiles } from "./code-write-receipt";
import { protectedMoveStopMessage } from "./code-protected-move-stop";

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
    question: { questionId: string; toolCallId: string; prompt?: string; choices?: string[] },
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
): { questionId: string; toolCallId: string; prompt?: string; choices?: string[] } | null {
  if (outcome.call.name !== CODE_ASK_USER_TOOL || !outcome.result.ok) return null;
  const envelope = outcome.result.result;
  if (!envelope || typeof envelope !== "object") return null;
  const data = (envelope as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const questionId = (data as { questionId?: unknown }).questionId;
  if (typeof questionId !== "string" || questionId.length === 0) return null;
  // The question itself goes into the reply: "Waiting for the user to answer question <id>" left the person unable to answer.
  const args = outcome.call.arguments ?? {};
  const prompt = typeof args.prompt === "string" ? args.prompt : typeof args.question === "string" ? args.question : undefined;
  const choices = Array.isArray(args.choices) ? args.choices.map(choice => typeof choice === "string" ? choice : choice && typeof choice === "object" && typeof (choice as { label?: unknown }).label === "string" ? (choice as { label: string }).label : "").filter(Boolean) : undefined;
  return { questionId, toolCallId: outcome.call.id, ...(prompt ? { prompt } : {}), ...(choices?.length ? { choices } : {}) };
}

export class CodingAgentToolWaves {
  /** Successful writes in this run, and the write count each screenshot (page@viewport) was taken at. */
  private writesInRun = 0;
  private readonly screenshotAtWrite = new Map<string, number>();
  private readonly repeatedSignatures: string[] = [];
  private readonly repeatedErrors: string[] = [];
  private readonly argumentCorrections = new Map<string, number>();
  private readonly zeroDiffEdits: string[] = [];
  private readonly verificationFailures: string[] = [];
  private readonly turnPatterns: string[] = [];
  private identicalRepeats = 0;
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
    const { steps, normalized, callsToRun, modelUsage } = args;
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

    // Finish the assistant tool-call batch before inserting ordinary conversation messages.
    const deferredMessages: ChatMessage[] = [];
    /** A turn whose calls were all rejected did not do any work, so it must not be recorded as a clean turn. */
    let turnHadFailure = false;
    try {
    const correctionKeys = new Set<string>();
    const rejectedSignatures: string[] = [];
    for (const rejected of normalized.rejected) {
      const key = `${rejected.name ?? "unknown"}:${rejected.code}`;
      /**
       * A truncated call has no arguments to correct: the provider stopped mid-JSON. Counting it as an
       * argument mistake would stop the run before the model can switch to a smaller write, so it is bounded by
       * the repeat detector below instead. Every other rejection keeps the existing correction budget.
       */
      const truncated = rejected.code === "partial_tool_call";
      let count = 0;
      if (!truncated) {
        // A batch is one opportunity to correct a class of errors on the next turn.
        count = (this.argumentCorrections.get(key) ?? 0) + (correctionKeys.has(key) ? 0 : 1);
        correctionKeys.add(key);
        this.argumentCorrections.set(key, count);
      }
      rejectedSignatures.push(`rejected:${key}`);
      turnHadFailure = true;
      const hint = truncated
        ? TRUNCATED_TOOL_CALL_HINT
        : `Retry only this rejected call with corrected arguments. Use the other tool results in this batch; do not repeat successful writes or restart saved changes.`;
      messages.push({
        role: "tool",
        tool_call_id: rejected.id ?? `rejected:${messages.length}`,
        content: JSON.stringify({
          ...toolCallFeedback(rejected),
          hint,
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

    /**
     * Rejections are fed into the same repeat detector as executed calls, so an identical truncated or refused
     * call cannot be retried forever: the third identical signature produces the existing corrective reminder,
     * and only `LOOP_STOP_REPEATS` in a row stop the run with `loop_detected`. Signatures are namespaced (`rejected:`) so a
     * rejection can never be confused with a successful call, and distinct tools keep distinct signatures —
     * normal work therefore cannot trip the detector.
     */
    const signatures = [...callsToRun.map(toolCallSignature), ...rejectedSignatures];
    if (signatures.length) {
      this.repeatedSignatures.push(...signatures);
      while (this.repeatedSignatures.length > LOOP_REPEAT_THRESHOLD) this.repeatedSignatures.shift();
      if (this.repeatedSignatures.length === LOOP_REPEAT_THRESHOLD && new Set(this.repeatedSignatures).size === 1) {
        this.identicalRepeats += 1;
        if (this.identicalRepeats + LOOP_REPEAT_THRESHOLD - 1 >= LOOP_STOP_REPEATS) {
          await release("loop_detected");
          const repeated = callsToRun[0]?.name ?? normalized.rejected[0]?.name ?? "unknown";
          const res = await stop("stopped", "loop_detected", `Stopped: the same tool call (${repeated}) was repeated without progress.`);
          return { action: "stopped", result: res };
        }
        if (!this.loopReminded) {
          this.loopReminded = true;
          deferredMessages.push({ role: "system", content: REMINDER_MESSAGE });
          await record({ kind: "reminder", companyId, projectId, sessionId, runId: input.runId, turn: steps, reason: "repeated_call" });
        }
      } else {
        this.identicalRepeats = 0;
      }
    }

    if (!callsToRun.length) return { action: "continue" };

    const turnSig = callsToRun.map((c) => {
      const args = c.arguments as Record<string, unknown> | undefined;
      const p = args?.path;
      if (p && typeof p === "string") return `${c.name}:${p}`;
      // Data tools carry no path: creating categories, products and orders is three different steps, not a cycle.
      const op = args?.operation as Record<string, unknown> | undefined;
      const target = [args?.collection, op?.kind, op?.collection, (op?.field as Record<string, unknown> | undefined)?.name].filter((v) => typeof v === "string").join(":");
      if (target) return `${c.name}:${target}`;
      // Shell commands and other path-less tools are told apart by their arguments: "python -m venv .venv", "pip install"
      // and "ls" were all just "code.shell.exec", so six different steps of real progress stopped the run as a "cycle"
      // (V6 step 10). The same call repeated still has the same signature.
      const command = typeof args?.command === "string" ? args.command : JSON.stringify(args ?? {});
      return `${c.name}:${command.slice(0, 300)}`;
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
          deferredMessages.push({
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
      ports.logger?.info?.("code_settlement_boundary", { runId: stateRunId, stage: "tool_projection_started", tool: call.name });
      await publishActivity({ ...activityStart, status: "running" });
      ports.logger?.info?.("code_settlement_boundary", { runId: stateRunId, stage: "tool_projection_finished", tool: call.name });
      const invokeInput = {
        onApprovalRequested: async ({ approvalId }: { approvalId: string }) => {
          await publishActivity({ ...activityStart, stage: "approval", status: "awaiting_approval", result: JSON.stringify({ approvalId, companyId, projectId, runId: stateRunId, toolName: call.name }) });
        },
        signal: input.signal,
        leaseOwner: stateOwner,
        companyId,
        projectId,
        sessionId,
        sessionMode: session.mode,
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
      // A screenshot of the same page and viewport with no file written since the previous one would be identical:
      // answer from the run's own state instead of rebuilding and capturing again (nothing is executed).
      const screenshotKey = call.name === "code.preview.screenshot"
        ? `${typeof call.arguments.path === "string" ? call.arguments.path : "/"}@${typeof call.arguments.viewport === "string" ? call.arguments.viewport : "desktop"}` : null;
      if (screenshotKey && this.screenshotAtWrite.get(screenshotKey) === this.writesInRun) {
        const data = { unchangedSinceLastScreenshot: true, note: "No file changed in this run since the previous screenshot of this page and viewport, so it would be identical. Change files first, or finish: the system screenshots and compares the result after you finish." };
        result = { ok: true, tool: call.name, toolVersion: toolVersionByName.get(call.name) ?? 1, schemaVersion: 1, truncated: false, durationMs: 0,
          result: { kind: "code_tool_result", tool: call.name, toolVersion: 1, schemaVersion: 1, trust: "untrusted_data", note: "Run state, not a new capture.", data } };
      } else try {
        const runtimeTool = runtimeToolByName.get(call.name);
        result = runtimeTool && ports.runtimeCapabilities
          ? await ports.runtimeCapabilities.invoke({
              ctx,
              companyId,
              projectId,
              ...(sessionId ? { sessionId } : {}),
              ...(session.mode ? { sessionMode: session.mode } : {}),
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
      if (result.ok && /^code\.fs\.(write|edit|apply_patch|move|delete)$|^code\.deps\.add$/.test(call.name) && call.arguments.dryRun !== true) this.writesInRun += 1;
      if (screenshotKey && result.ok) this.screenshotAtWrite.set(screenshotKey, this.writesInRun);

      if (stateRunId && ports.runState) {
        await writeState(() => ports.runState!.appendToolCall({
          companyId, runId: stateRunId!, turnIndex: steps,
          toolCallId: call.id, tool: call.name, readOnly: readOnlyCall,
          outcome: result.ok ? "ok" : "failed",
          ...(result.ok ? {} : { errorCode: result.error.code }),
          startedAt: new Date(startedCall), finishedAt: new Date(now()),
        }));
      }

      if (result.ok && call.arguments.dryRun !== true) reviewCoordinator.recordRuntimeResult(result, call.arguments);
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
              deferredMessages.push({
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
      if (!result.ok && ["patch_conflict", "edit_no_match", "edit_ambiguous"].includes(result.error.code)) {
        deferredMessages.push({ role: "system", content: "The last file operation did not apply. Keep earlier successful edits. Re-read only the affected current range, then submit one corrected patch with exact unique context or one precise literal edit. Do not reuse stale text, guess line numbers, repeat the same failed patch, or restart the task. A successful dryRun is not a saved edit." });
      }
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
                deferredMessages.push({
                  role: "system",
                  content: `Warning: Writing to "${writePath}" produced 0 line changes (diff was empty). Do not write the exact same file content again without modifications.`,
                });
                await record({ kind: "reminder", companyId, projectId, sessionId, runId: input.runId, turn: steps, reason: "zero_diff_write" });
              }
            }
          } else {
            this.repeatedSignatures.length = 0;
            this.turnPatterns.length = 0;
            this.loopReminded = false;
            this.identicalRepeats = 0;
            this.cycleReminded = false;
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
        // The chat row names the file while the run is live; replay steps carrying it are only written when the run ends.
        ...(typeof call.arguments?.path === "string" ? { path: call.arguments.path } : {}),
        ...(result.ok ? {} : { errorCode: result.error.code }),
        durationMs: now() - startedCall,
      });
      return { call, result };
    };

    // Read-only calls the model already emitted run concurrently up to the read-only limit (default 8): the profile's
    // maxParallelToolCalls governs how many calls a model may emit and still bounds anything that writes.
    const waveLimit = Math.max(1, Math.min(8, limits.parallelReadOnlyCalls));

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
      if (outcome.result.ok && outcome.result.imageAttachment) {
        deferredMessages.push(await toolImageMessage({ vision: ports.vision, ctx, model: input.model, tool: outcome.call.name, attachment: outcome.result.imageAttachment }));
      }
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
          deferredMessages.push({ role: "user", content: metadataText });
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

        const protectedMove = protectedMoveStopMessage(outcome.call.name, outcome.result, input.responseLanguage, input.prompt, input.requireImplementation);
        if (protectedMove) {
          summary.remaining = "secret_content";
          await release("protected_move_refused");
          return { action: "stopped", result: await stop("stopped", "refused", protectedMove) };
        }

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
        deferredMessages.push({ role: "system", content: REMINDER_MESSAGE });
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
    } finally {
      messages.push(...deferredMessages);
    }
  }
}
