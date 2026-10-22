import { emitCodingActivity, withCodingReferenceImages } from "./coding-agent-runner-contracts";
import type { CodingAgentRunnerPorts } from "./coding-agent-runner-contracts";
import type { CodeAgentLimits } from "./code-agent-config";
import type { ChatMessage } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import type { CodeToolInvokeFailure, CodeToolInvokeResult } from "./code-tool-runtime";
import type { VerificationCheckReport, VerificationLoop } from "./code-verification-loop";
import { analyzeTestIntegrity, type TestIntegrityVerdict } from "./code-test-integrity-guard";
import { evaluateScopeGuard, type ScopeGuardResult } from "./code-scope-guard";
import { describeSelfReview, selfReviewStopMessage, type SelfReviewState, type SelfReviewVerdict } from "./code-self-review";
import { canonicalizeSettledToolResult, replayArgumentsHash } from "./code-replay-bundle";
import { CodingAgentStopReason, CodeRunActivityEvent, CodeRunReplayRecorderPort, CodingAgentRunInput, CodingAgentRunSummary, APPROVED_TOOL_CALLS_RESULT_HEADER } from "./coding-agent-runner-contracts";

export interface CodingAgentReviewPhasesHost {
  ports: CodingAgentRunnerPorts;
  limits: CodeAgentLimits;
  now: () => number;
  selfReviewDiffChars: number;
}

export class CodingAgentReviewPhases {
  constructor(private readonly host: CodingAgentReviewPhasesHost) {}

  private get ports(): CodingAgentRunnerPorts { return this.host.ports; }
  private get limits(): CodeAgentLimits { return this.host.limits; }
  private get now(): () => number { return this.host.now; }
  private get selfReviewDiffChars(): number { return this.host.selfReviewDiffChars; }

  async replayApprovedToolCalls(args: {
    ctx: AuthContext;
    input: CodingAgentRunInput;
    companyId: string;
    projectId: string;
    sessionId: string;
    stateRunId: string | undefined;
    steps: number;
    runtimeToolByName: { has(name: string): boolean };
    toolVersionByName: { get(name: string): number | undefined };
    messages: ChatMessage[];
    summary: CodingAgentRunSummary;
    replayRecorder: CodeRunReplayRecorderPort | undefined;
    writeState: (operation: () => Promise<unknown>) => Promise<void>;
    record: (event: CodeRunActivityEvent) => Promise<void>;
  }): Promise<void> {
    const {
      ctx,
      input,
      companyId,
      projectId,
      sessionId,
      stateRunId,
      steps,
      runtimeToolByName,
      toolVersionByName,
      messages,
      summary,
      replayRecorder,
      writeState,
      record,
    } = args;
    if (!input.approvedToolCalls?.length) return;
    const approvedLines: string[] = [];
    for (const approved of input.approvedToolCalls) {
      const startedCall = this.now();
      if (stateRunId && this.ports.runState) {
        await writeState(() => this.ports.runState!.appendToolCall({
          companyId, runId: stateRunId!, turnIndex: steps,
          toolCallId: approved.toolCallId, tool: approved.tool, readOnly: false,
          outcome: "unknown_outcome", startedAt: new Date(startedCall), finishedAt: null,
        }));
      }
      let outcome: CodeToolInvokeResult | CodeToolInvokeFailure;
      if (!runtimeToolByName.has(approved.tool) || !this.ports.runtimeCapabilities) {

        outcome = {
          ok: false,
          error: {
            code: "unknown_tool", status: 404, step: "resolve", retryable: false,
            message: `The approved call names a runtime MCP tool this run does not offer: ${approved.tool}`,
            tool: approved.tool,
          },
        };
      } else {
        try {
          outcome = await this.ports.runtimeCapabilities.invoke({
            ctx,
            companyId,
            projectId,
            ...(sessionId ? { sessionId } : {}),
            ...(stateRunId ?? input.runId ? { runId: stateRunId ?? input.runId } : {}),
            ...(input.agentId ? { agentId: input.agentId } : {}),
            ...(input.readOnlyIntent === true ? { readOnlyIntent: true } : {}),
            tool: approved.tool,
            args: approved.args,
            toolCallId: approved.toolCallId,
            approvalId: approved.approvalId,
          });
        } catch (error) {
          const failure = error as { code?: string; message?: string; status?: number; step?: string; details?: Record<string, unknown> };
          outcome = {
            ok: false,
            error: {
              code: (failure.code ?? "tool_error") as CodeToolInvokeFailure["error"]["code"],
              status: failure.status ?? 500,
              message: failure.message ?? "The approved runtime MCP call failed",
              tool: approved.tool,
              step: failure.step ?? "execute",
              retryable: false,
              ...(failure.details ? { details: failure.details } : {}),
            },
          };
        }
      }
      if (stateRunId && this.ports.runState) {
        await writeState(() => this.ports.runState!.appendToolCall({
          companyId, runId: stateRunId!, turnIndex: steps,
          toolCallId: approved.toolCallId, tool: approved.tool, readOnly: false,
          outcome: outcome.ok ? "ok" : "failed",
          ...(outcome.ok ? {} : { errorCode: outcome.error.code }),
          startedAt: new Date(startedCall), finishedAt: new Date(this.now()),
        }));
      }
      summary.toolCalls += 1;
      const text = canonicalizeSettledToolResult({
        ok: outcome.ok,
        tool: approved.tool,
        ...(outcome.ok ? { result: outcome.result } : {}),
        ...(outcome.ok ? { truncated: outcome.truncated } : {}),
        ...(outcome.ok ? {} : { error: outcome.error }),
        limit: this.limits.toolOutputChars,
      });

      replayRecorder?.recordToolCall({
        turnIndex: steps,
        toolCallId: approved.toolCallId,
        tool: approved.tool,
        toolVersion: toolVersionByName.get(approved.tool) ?? null,

        argumentsHash: replayArgumentsHash(approved.args),
        settledResult: text,
        outcome: outcome.ok ? "ok" : "failed",
        ...(outcome.ok ? {} : { errorCode: outcome.error.code }),
        ...(outcome.ok ? { truncated: outcome.truncated === true } : {}),
      });
      await record({
        kind: "tool_call",
        companyId,
        projectId,
        sessionId,
        runId: input.runId,
        turn: steps,
        tool: approved.tool,
        toolCallId: approved.toolCallId,
        ok: outcome.ok,
        ...(outcome.ok ? {} : { errorCode: outcome.error.code }),
        durationMs: this.now() - startedCall,
      });
      approvedLines.push(text);
    }
    if (approvedLines.length) {
      messages.push({ role: "system", content: `${APPROVED_TOOL_CALLS_RESULT_HEADER}\n${approvedLines.join("\n")}` });
    }
  }

  async verifyOnce(args: {
    ctx: AuthContext;
    input: CodingAgentRunInput;
    companyId: string;
    projectId: string;
    sessionId: string;
    stateRunId: string | undefined;
    steps: number;
    turnId: string;
    verificationTools: readonly string[];
    capabilityScopeFields: {
      subagentWritePaths?: CodingAgentRunInput["subagentWritePaths"];
      capabilityScope?: readonly string[];
      parentRunId?: string;
    };
    verificationLoop: VerificationLoop;
    toCheckReports: (outcome: CodeToolInvokeResult | CodeToolInvokeFailure, tools: readonly string[]) => VerificationCheckReport[];
    record: (event: CodeRunActivityEvent) => Promise<void>;
  }): Promise<void> {
    const {
      ctx,
      input,
      companyId,
      projectId,
      sessionId,
      stateRunId,
      steps,
      turnId,
      verificationTools,
      capabilityScopeFields,
      verificationLoop,
      toCheckReports,
      record,
    } = args;
    const attempt = verificationLoop.report().verificationRuns + 1;
    const activity = { id: `${stateRunId ?? input.runId}:verify:${turnId}:${attempt}`, runId: stateRunId ?? input.runId, stage: "build", title: "Verifying build and checks", tool: "code.verify.run", at: new Date(this.now()).toISOString(), agentId: input.agentId ?? "NPATI Coding Agent" };
    await emitCodingActivity(input, { ...activity, status: "running" });
    let outcome: CodeToolInvokeResult | CodeToolInvokeFailure;
    try {
      outcome = await this.ports.toolRuntime.invoke(ctx, {
        companyId,
        projectId,
        sessionId,
        tool: "code.verify.run",
        args: { tools: [...verificationTools], changedOnly: true },
        toolCallId: `verify:${turnId}:${attempt}`,
        turnId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(stateRunId ? { runId: stateRunId } : {}),
        ...(input.readOnlyIntent === true ? { readOnlyIntent: true } : {}),
        ...capabilityScopeFields,
      });
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      outcome = {
        ok: false,
        error: {
          code: (failure.code ?? "verify_error") as CodeToolInvokeFailure["error"]["code"],
          status: 500,
          message: failure.message ?? "Verification failed to run",
          tool: "code.verify.run",
          step: "execute",
          retryable: false,
        },
      };
    }
    const checks = toCheckReports(outcome, verificationTools);
    await emitCodingActivity(input, { ...activity, status: checks.some(check => check.state === "approval_required") ? "awaiting_approval" : checks.every(check => check.state === "passed") ? "completed" : "failed", result: JSON.stringify(outcome.ok ? outcome.result : outcome.error), durationMs: this.now() - Date.parse(activity.at) });
    verificationLoop.record(checks);
    await record({
      kind: "tool_call",
      companyId, projectId, sessionId,
      runId: input.runId,
      turn: steps,
      tool: "code.verify.run",
      toolCallId: `verify:${turnId}:${attempt}`,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { errorCode: String(outcome.error.code) }),
    });
  }

  async evaluateChangeSet(args: {
    input: CodingAgentRunInput;
    companyId: string;
    projectId: string;
    sessionId: string;
    steps: number;
    prompt: string;
    summary: CodingAgentRunSummary;
    runChanges: () => Array<{ path: string; tool: string; status?: string; diff?: string }>;
    record: (event: CodeRunActivityEvent) => Promise<void>;
  }): Promise<{ testIntegrity: TestIntegrityVerdict | null; scopeGuard: ScopeGuardResult | null } | null> {
    const { input, companyId, projectId, sessionId, steps, prompt, summary, runChanges, record } = args;
    const changes = runChanges();
    if (!changes.length) return null;
    const testIntegrity = analyzeTestIntegrity(changes);
    const scopeGuard = evaluateScopeGuard({
      changedPaths: changes.map((change) => change.path),
      requestText: prompt,
      maxChangedFiles: this.limits.maxChangedFiles,
    });
    summary.scope = {
      changedFiles: scopeGuard.changedFiles,
      limit: scopeGuard.limit,
      exceeded: scopeGuard.exceeded,
      severity: scopeGuard.severity,
      unrelatedPaths: scopeGuard.unrelatedPaths,
      relatednessUnknown: scopeGuard.relatednessUnknown,
      warnings: scopeGuard.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
        severity: warning.severity,
        paths: warning.paths,
      })),
    };
    for (const warning of scopeGuard.warnings) {

      await record({
        kind: "turn",
        companyId, projectId, sessionId,
        runId: input.runId,
        turn: steps,
        ok: warning.severity !== "critical",
        reason: warning.code,
      });
    }
    if (testIntegrity.flagged) {
      await record({
        kind: "turn",
        companyId, projectId, sessionId,
        runId: input.runId,
        turn: steps,
        ok: false,
        reason: "test_integrity_flagged",
      });
    }
    return { testIntegrity, scopeGuard };
  }

  async runSelfReviewOnce(args: {
    input: CodingAgentRunInput;
    session: CodeSession;
    companyId: string;
    projectId: string;
    sessionId: string;
    steps: number;
    prompt: string;
    selfReviewState: SelfReviewState | null;
    loadApprovedPlan: () => Promise<string | null>;
    runChanges: () => Array<{ path: string; tool: string; status?: string; diff?: string }>;
    verificationForReview: () => string;
    testIntegrityForReview: () => string;
    boundedDiff: (limit: number) => string;
    writeSelfReviewSummary: () => void;
    setSelfReviewVerdict: (verdict: SelfReviewVerdict) => void;
    record: (event: CodeRunActivityEvent) => Promise<void>;
  }): Promise<SelfReviewVerdict | null> {
    const {
      input,
      session,
      companyId,
      projectId,
      sessionId,
      steps,
      prompt,
      selfReviewState,
      loadApprovedPlan,
      runChanges,
      verificationForReview,
      testIntegrityForReview,
      boundedDiff,
      writeSelfReviewSummary,
      setSelfReviewVerdict,
      record,
    } = args;
    const state = selfReviewState;
    if (!state) return null;
    const verdict = await state.execute({
      input: {
        originalGoal: [prompt, ...(input.extraSystemPromptLines ?? [])].join("\n\n"),
        approvedPlan: await loadApprovedPlan(),
        finalDiff: boundedDiff(this.selfReviewDiffChars),
        changedFiles: runChanges().map((change) => ({
          path: change.path,
          tool: change.tool,
          ...(change.status !== undefined ? { status: change.status } : {}),
        })),
        verification: verificationForReview(),
        testIntegrity: testIntegrityForReview(),
      },
      reviewRequest: state.request(),
      chat: async (request) => {
        const started=this.now();
        const metadata={kind:"model_call" as const,companyId,projectId,sessionId,turn:steps,modelPurpose:"self_review" as const,model:input.model};
        const activity={id:`${input.runId ?? sessionId}:self-review:${steps}`,runId:input.runId,stage:"planning",title:"Reviewing implementation",at:new Date(started).toISOString()};
        await record({...metadata,phase:"started"});
        await emitCodingActivity(input,{...activity,status:"running"});
        let attempt=0;
        try {
          const result = await this.ports.engine.chat({
            onProviderAttempt:async(event)=>{if(event.phase==="started") attempt++;await record({...metadata,attempt,...event});},
            messages: withCodingReferenceImages(request.messages, input.images),

            model: input.model,
            ...(input.fallbackModel ? { fallbackModel: input.fallbackModel } : {}),
            signal: input.signal,
            idempotencyKey: request.idempotencyKey,
            policyContext: {
              companyId,
              projectId,
              sessionId,
              dataClassification: session.dataClassification,
            },
          });
          await record({...metadata,phase:"completed",model:result.model ?? input.model,provider:result.telemetry?.provider,durationMs:this.now()-started});
          await emitCodingActivity(input,{...activity,status:"completed",durationMs:this.now()-started,modelUsage:{id:activity.id,turn:steps,model:result.model ?? input.model,provider:result.telemetry?.provider,totalTokens:result.usage?.totalTokens,inputTokens:result.usage?.promptTokens,outputTokens:result.usage?.completionTokens,toolCallIds:[]}});
          return { ok: true as const, content: result.content ?? "" };
        } catch (error) {
          const failure = error as { code?: string; message?: string };
          await record({...metadata,phase:"failed",errorCode:failure.code ?? "review_call_failed",durationMs:this.now()-started});
          await emitCodingActivity(input,{...activity,status:"failed",error:failure.message,errorCode:failure.code ?? "review_call_failed",durationMs:this.now()-started});
          return { ok: false as const, code: failure.code ?? "review_call_failed", message: failure.message };
        }
      },

      ...(this.ports.providerDataGuard
        ? {
            guardPrompt: async (text: string) => {
              await this.ports.providerDataGuard!.guardProviderBoundText(text, {
                model: input.model,
                policyContext: {
                  companyId,
                  projectId,
                  sessionId,
                  dataClassification: session.dataClassification,
                },
              });
            },
          }
        : {}),
    });
    setSelfReviewVerdict(verdict);
    writeSelfReviewSummary();
    await record({
      kind: "turn",
      companyId, projectId, sessionId,
      runId: input.runId,
      turn: steps,

      ok: verdict.status === "clean" || verdict.status === "repaired",
      reason: `${describeSelfReview(verdict)} profile=${this.ports.selfReview?.profileId ?? "run-default"}`,
    });
    return verdict;
  }

  async afterSelfReviewFixOnce(args: {
    ctx: AuthContext;
    input: CodingAgentRunInput;
    companyId: string;
    projectId: string;
    sessionId: string;
    steps: number;
    turnId: string;
    stateRunId: string | undefined;
    verificationTools: readonly string[];
    capabilityScopeFields: {
      subagentWritePaths?: CodingAgentRunInput["subagentWritePaths"];
      capabilityScope?: readonly string[];
      parentRunId?: string;
    };
    selfReviewState: SelfReviewState | null;
    verificationLoop: VerificationLoop;
    verifiedSignature: string | null;
    currentChangeSignature: () => string;
    getSelfReviewVerdict: () => SelfReviewVerdict | null;
    setSelfReviewVerdict: (verdict: SelfReviewVerdict | null) => void;
    setSelfReviewFixPending: (pending: boolean) => void;
    writeSelfReviewSummary: () => void;
    writeVerificationSummary: () => void;
    toCheckReports: (outcome: CodeToolInvokeResult | CodeToolInvokeFailure, tools: readonly string[]) => VerificationCheckReport[];
    record: (event: CodeRunActivityEvent) => Promise<void>;
  }): Promise<{ action: "complete" } | { action: "stop"; reason: CodingAgentStopReason; message: string }> {
    const {
      ctx,
      input,
      companyId,
      projectId,
      sessionId,
      steps,
      turnId,
      stateRunId,
      verificationTools,
      capabilityScopeFields,
      selfReviewState,
      verificationLoop,
      verifiedSignature,
      currentChangeSignature,
      getSelfReviewVerdict,
      setSelfReviewVerdict,
      setSelfReviewFixPending,
      writeSelfReviewSummary,
      writeVerificationSummary,
      toCheckReports,
      record,
    } = args;
    const changed = currentChangeSignature() !== verifiedSignature;
    setSelfReviewFixPending(false);
    if (!changed || verificationTools.length === 0) {

      selfReviewState?.noteFixOutcome(false);
      setSelfReviewVerdict(selfReviewState?.report() ?? getSelfReviewVerdict());
      writeSelfReviewSummary();
      const outstanding = (getSelfReviewVerdict()?.unresolved ?? []).filter((finding) => finding.blocking);
      if (outstanding.length) {
        return { action: "stop", reason: "self_review_unresolved", message: selfReviewStopMessage(getSelfReviewVerdict() ?? undefined) };
      }
      return { action: "complete" };
    }

    const runAttempt = verificationLoop.report().verificationRuns + 1;
    const activity = { id: `${stateRunId ?? input.runId}:verify:self-review:${turnId}:${runAttempt}`, runId: stateRunId ?? input.runId, stage: "build", title: "Verifying build and checks", tool: "code.verify.run", at: new Date(this.now()).toISOString(), agentId: input.agentId ?? "NPATI Coding Agent" };
    await emitCodingActivity(input, { ...activity, status: "running" });
    let outcome: CodeToolInvokeResult | CodeToolInvokeFailure;
    try {
      outcome = await this.ports.toolRuntime.invoke(ctx, {
        companyId,
        projectId,
        sessionId,
        tool: "code.verify.run",
        args: { tools: [...verificationTools], changedOnly: true },
        toolCallId: `verify:self-review:${turnId}:${runAttempt}`,
        turnId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(stateRunId ? { runId: stateRunId } : {}),
        ...(input.readOnlyIntent === true ? { readOnlyIntent: true } : {}),
        ...capabilityScopeFields,
      });
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      outcome = {
        ok: false,
        error: {
          code: (failure.code ?? "verify_error") as CodeToolInvokeFailure["error"]["code"],
          status: 500,
          message: failure.message ?? "Verification failed to run",
          tool: "code.verify.run",
          step: "execute",
          retryable: false,
        },
      };
    }
    const checks = toCheckReports(outcome, verificationTools);
    await emitCodingActivity(input, { ...activity, status: checks.some(check => check.state === "approval_required") ? "awaiting_approval" : checks.every(check => check.state === "passed") ? "completed" : "failed", result: JSON.stringify(outcome.ok ? outcome.result : outcome.error), durationMs: this.now() - Date.parse(activity.at) });
    verificationLoop.record(checks);
    verificationLoop.blockFurtherRepairs();
    writeVerificationSummary();
    await record({
      kind: "tool_call",
      companyId, projectId, sessionId,
      runId: input.runId,
      turn: steps,
      tool: "code.verify.run",
      toolCallId: `verify:self-review:${turnId}:${runAttempt}`,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { errorCode: String(outcome.error.code) }),
      reason: "self_review_reverify",
    });

    const failed = checks.filter((check) => check.state !== "passed");
    if (failed.length) {

      selfReviewState?.noteFixOutcome(false);
      setSelfReviewVerdict(selfReviewState?.report() ?? getSelfReviewVerdict());
      writeSelfReviewSummary();
      return {
        action: "stop",
        reason: "verification_failed",
        message: `Stopped: the checks still fail after the self-review fix (${failed.map((check) => check.tool).join(", ")}).`,
      };
    }

    selfReviewState?.noteFixOutcome(true);
    setSelfReviewVerdict(selfReviewState?.report() ?? getSelfReviewVerdict());
    writeSelfReviewSummary();
    return { action: "complete" };
  }

}
