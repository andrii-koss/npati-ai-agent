import type { ChatMessage } from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession } from "@npati/workspace";
import { sha256Hex, type CodeToolInvokeFailure, type CodeToolInvokeResult } from "./code-tool-runtime";
import {
  VERIFICATION_APPROVAL_REQUIRED,
  VERIFICATION_REPAIR_EXHAUSTED,
  VERIFICATION_UNAVAILABLE,
  createVerificationLoop,
  verificationChecks,
  formatRepairInstruction,
  type VerificationCheckReport,
  type VerificationLoop,
  type VerificationReport,
} from "./code-verification-loop";
import type { TestIntegrityVerdict } from "./code-test-integrity-guard";
import type { ScopeGuardResult } from "./code-scope-guard";
import {
  SELF_REVIEW_SCHEMA_VERSION,
  createSelfReview,
  selfReviewStopMessage,
  type SelfReviewFinding,
  type SelfReviewState,
  type SelfReviewVerdict,
} from "./code-self-review";
import {
  type CodingAgentStopReason,
  type CodingAgentRunStatus,
  type CodeRunActivityEvent,
  type CodingAgentRunnerPorts,
  type CodingAgentRunInput,
  type CodingAgentRunSummary,
  type CodingAgentSelfReviewFinding,
  type CodingAgentRunResult,
  DEFAULT_VERIFICATION_TOOLS,
  bounded,
} from "./coding-agent-runner-contracts";
import type { CodingAgentReviewPhases } from "./coding-agent-review-phases";

import type { CodeAgentLimits } from "./code-agent-config";

export interface ReviewCoordinatorHost {
  ports: CodingAgentRunnerPorts;
  limits: CodeAgentLimits;
  reviewPhases: CodingAgentReviewPhases;
  selfReviewDiffChars: number;
  input: CodingAgentRunInput;
  ctx: AuthContext;
  session: CodeSession;
  companyId: string;
  projectId: string;
  sessionId: string;
  turnId: string;
  stepTurnKey: (index: number) => string;
  toolSteps: number[];
  capabilityScopeFields: Record<string, unknown>;
  summary: CodingAgentRunSummary;
  messages: ChatMessage[];
  record: (event: CodeRunActivityEvent) => Promise<void>;
  release: (reason: string) => Promise<void>;
  stop: (
    status: Exclude<CodingAgentRunStatus, "waiting_for_user">,
    reason: CodingAgentStopReason,
    message: string,
  ) => Promise<CodingAgentRunResult>;
}

export class CodingAgentReviewCoordinator {
  private readonly verificationTools: readonly string[];
  private readonly verificationLoop: VerificationLoop;
  readonly verificationDisabled: boolean;

  private testIntegrity: TestIntegrityVerdict | null = null;
  private scopeGuard: ScopeGuardResult | null = null;

  private selfReviewState: SelfReviewState | null = null;
  private selfReviewVerdict: SelfReviewVerdict | null = null;
  private selfReviewPasses = 0;
  private verifiedSignature: string | null = null;
  private verifiedRevision: string | null = null;
  private selfReviewFixPending = false;
  private lastCheckpointId: string | null = null;
  collectedChanges: Array<{ path: string; tool: string; status?: string; diff?: string }> = [];

  constructor(private readonly host: ReviewCoordinatorHost) {
    this.verificationTools = Object.freeze([...(host.input.verificationTools ?? DEFAULT_VERIFICATION_TOOLS)]);
    this.verificationLoop = createVerificationLoop({
      maxRepairAttempts: host.ports.limits?.repairLoopAttempts ?? 3,
      requestedTools: this.verificationTools,
    });
    this.verificationDisabled = this.verificationTools.length === 0;
  }

  get verdict(): SelfReviewVerdict | null {
    return this.selfReviewVerdict;
  }

  readVerificationRevision(): Promise<string | null> {
    return this.host.ports.toolRuntime.verificationRevision?.(
      this.host.ctx,
      this.host.companyId,
      this.host.projectId,
      this.host.sessionId,
    ).catch(() => null) ?? Promise.resolve(null);
  }

  turnCheckpointId(steps: number): string | null {
    if (this.host.ports.toolRuntime.turnSummary) {
      try {
        const current = this.host.ports.toolRuntime.turnSummary(
          this.host.sessionId,
          this.host.stepTurnKey(steps),
        ).checkpointId ?? null;
        if (current) this.lastCheckpointId = current;
      } catch {
        // Ignored
      }
    }
    return this.lastCheckpointId;
  }

  runChanges(): Array<{ path: string; tool: string; status?: string; diff?: string }> {
    const merged = new Map(this.collectedChanges.map((change) => [change.path, change]));
    if (!this.host.ports.toolRuntime.turnSummary) return [...merged.values()];
    for (const index of this.host.toolSteps) {
      try {
        const summaryForTurn = this.host.ports.toolRuntime.turnSummary(this.host.sessionId, this.host.stepTurnKey(index));
        for (const change of summaryForTurn?.changes ?? []) {
          merged.set(change.path, {
            path: change.path,
            tool: change.tool,
            ...(change.status !== undefined ? { status: change.status } : {}),
            ...(change.diff !== undefined ? { diff: change.diff } : {}),
          });
        }
      } catch {
        // Ignored
      }
    }
    return [...merged.values()];
  }

  runChangeTotals(): { files: number; linesAdded: number; linesRemoved: number } {
    const paths = new Set<string>();
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const change of this.collectedChanges) {
      paths.add(change.path);
      for (const line of (change.diff ?? "").split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) linesAdded++;
        if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++;
      }
    }
    if (!this.host.ports.toolRuntime.turnSummary) return { files: paths.size, linesAdded, linesRemoved };
    for (const index of this.host.toolSteps) {
      try {
        const summaryForTurn = this.host.ports.toolRuntime.turnSummary(this.host.sessionId, this.host.stepTurnKey(index));
        for (const change of summaryForTurn?.changes ?? []) paths.add(change.path);
        linesAdded += summaryForTurn?.linesAdded ?? 0;
        linesRemoved += summaryForTurn?.linesRemoved ?? 0;
      } catch {
        // Ignored
      }
    }
    return { files: paths.size, linesAdded, linesRemoved };
  }

  applyTurnSummary(): void {
    const changes = this.runChanges();
    const totals = this.runChangeTotals();
    this.host.summary.filesChanged = [...new Set(changes.map((change) => change.path))];
    this.host.summary.diffStats = { files: totals.files, linesAdded: totals.linesAdded, linesRemoved: totals.linesRemoved };
  }

  async evaluateChangeSet(steps: number, prompt: string): Promise<void> {
    const evaluated = await this.host.reviewPhases.evaluateChangeSet({
      input: this.host.input,
      companyId: this.host.companyId,
      projectId: this.host.projectId,
      sessionId: this.host.sessionId,
      steps,
      prompt,
      summary: this.host.summary,
      runChanges: () => this.runChanges(),
      record: this.host.record,
    });
    if (!evaluated) return;
    this.testIntegrity = evaluated.testIntegrity;
    this.scopeGuard = evaluated.scopeGuard;
  }

  toCheckReports(outcome: CodeToolInvokeResult | CodeToolInvokeFailure): VerificationCheckReport[] {
    return verificationChecks(outcome, this.verificationTools);
  }

  runVerification(steps: number, stateRunId?: string): Promise<void> {
    return this.host.reviewPhases.verifyOnce({
      ctx: this.host.ctx,
      input: this.host.input,
      companyId: this.host.companyId,
      projectId: this.host.projectId,
      sessionId: this.host.sessionId,
      stateRunId,
      steps,
      turnId: this.host.turnId,
      verificationTools: this.verificationTools,
      capabilityScopeFields: this.host.capabilityScopeFields,
      verificationLoop: this.verificationLoop,
      toCheckReports: (outcome) => this.toCheckReports(outcome),
      record: this.host.record,
    });
  }

  writeVerificationSummary(): void {
    if (this.verificationDisabled) return;
    const report: VerificationReport = this.verificationLoop.report();
    if (report.status === "not_run" && !this.testIntegrity) return;
    const integrity = this.testIntegrity;
    const unjustified = integrity?.requiresJustification === true && report.status === "passed";
    this.host.summary.verification = {
      schemaVersion: report.schemaVersion,
      status: unjustified ? "passed_with_unjustified_test_changes" : report.status,
      attemptsUsed: report.attemptsUsed,
      maxAttempts: report.maxAttempts,
      verificationRuns: report.verificationRuns,
      requestedTools: [...report.requestedTools],
      failedChecks: report.failedChecks.map((check) => ({ tool: check.tool, ...(check.code ? { code: check.code } : {}) })),
      ...(integrity ? {
        testIntegrity: {
          flagged: integrity.flagged,
          requiresJustification: integrity.requiresJustification,
          justificationProvided: false,
          findings: integrity.findings.map((f) => ({ path: f.path, kind: f.kind, detail: f.detail })),
          testFilesTouched: [...integrity.testFilesTouched],
          testFilesDeleted: [...integrity.testFilesDeleted],
        },
      } : {}),
    };
  }

  verificationStopMessage(): string {
    const failed = this.verificationLoop.report().failedChecks;
    const detail = failed.length
      ? failed.map((check) => `${check.tool}${check.code ? ` (${check.code})` : ""}`).join(", ")
      : "verification did not run";
    return `Stopped: verification still fails after ${this.verificationLoop.attemptsUsed()} repair attempt(s): ${detail}.`;
  }

  currentChangeSignature(): string {
    const changes = this.runChanges().slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return changes.map((change) => `${change.path}:${change.status ?? ""}:${sha256Hex(change.diff ?? "")}`).join("|");
  }

  boundedDiff(limit: number): string {
    const parts = this.runChanges()
      .filter((change) => typeof change.diff === "string" && change.diff.length > 0)
      .map((change) => `--- ${change.path}\n${change.diff ?? ""}`);
    const joined = parts.join("\n");
    const bound = bounded(joined, limit);
    return bound.truncated ? `${bound.text}\n[the diff shown to this review was truncated at ${limit} characters]` : bound.text;
  }

  async loadApprovedPlan(): Promise<string | null> {
    const port = this.host.ports.sessionPlan;
    if (!port) return null;
    try {
      const plan = await port.load({
        ctx: this.host.ctx,
        companyId: this.host.companyId,
        projectId: this.host.projectId,
        sessionId: this.host.sessionId,
      });
      if (!plan) return null;
      const lines = [
        `revision: ${plan.revision} (status: ${plan.status})`,
        `execution mode chosen by the user: ${plan.executionMode ?? "not recorded"}`,
        "files:",
        ...(plan.plan.files.length ? plan.plan.files.map((file) => `- ${file}`) : ["- (none listed)"]),
        "steps:",
        ...(plan.plan.steps.length ? plan.plan.steps.map((step, index) => `${index + 1}. ${step}`) : ["(none listed)"]),
        "risks:",
        ...(plan.plan.risks.length ? plan.plan.risks.map((risk) => `- ${risk}`) : ["- (none listed)"]),
        `test strategy: ${plan.plan.testStrategy || "(not stated)"}`,
      ];
      return lines.join("\n");
    } catch {
      return null;
    }
  }

  verificationForReview(): string {
    const report = this.verificationLoop.report();
    if (!this.host.summary.verification && report.verificationRuns === 0) return "verification did not run for this change";
    const status = this.host.summary.verification?.status ?? report.status;
    const failed = report.failedChecks.map((check) => `${check.tool}${check.code ? ` (${check.code})` : ""}`);
    return [
      `status: ${status}`,
      `verification runs: ${report.verificationRuns}`,
      `repair attempts used: ${report.attemptsUsed} of ${report.maxAttempts}`,
      `requested checks: ${report.requestedTools.join(", ") || "(none)"}`,
      `failing checks: ${failed.join(", ") || "(none)"}`,
    ].join("\n");
  }

  testIntegrityForReview(): string {
    const integrity = this.testIntegrity;
    if (!integrity) return "test integrity did not run (no change set was inspected)";
    return [
      `flagged: ${integrity.flagged}`,
      `requires justification: ${integrity.requiresJustification}`,
      `test files touched: ${integrity.testFilesTouched.join(", ") || "(none)"}`,
      `test files deleted: ${integrity.testFilesDeleted.join(", ") || "(none)"}`,
      `findings: ${integrity.findings.map((finding) => `${finding.path}:${finding.kind}`).join(", ") || "(none)"}`,
    ].join("\n");
  }

  toFindingSummary(finding: SelfReviewFinding): CodingAgentSelfReviewFinding {
    return {
      id: finding.id,
      category: finding.category,
      severity: finding.severity,
      file: finding.file,
      reason: finding.reason,
      suggestedFix: finding.suggested_fix,
      blocking: finding.blocking,
    };
  }

  writeSelfReviewSummary(): void {
    const verdict = this.selfReviewVerdict;
    if (!verdict) return;
    this.host.summary.selfReview = {
      schemaVersion: SELF_REVIEW_SCHEMA_VERSION,
      status: verdict.status,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(verdict.detail ? { detail: verdict.detail } : {}),
      ran: verdict.ran, reviewRuns: verdict.reviewRuns,
      iterationsUsed: verdict.iterationsUsed, maxIterations: verdict.maxIterations,
      fixApplied: verdict.fixApplied, findingsCount: verdict.findings.length,
      blocking: verdict.blocking, unresolved: verdict.unresolved.length,
      findings: verdict.findings.map((f) => this.toFindingSummary(f)),
      inputs: verdict.inputs, reviewHash: verdict.reviewHash,
    };
  }

  async runSelfReview(steps: number, prompt: string): Promise<void> {
    const verdict = await this.host.reviewPhases.runSelfReviewOnce({
      input: this.host.input,
      session: this.host.session,
      companyId: this.host.companyId,
      projectId: this.host.projectId,
      sessionId: this.host.sessionId,
      steps,
      prompt,
      selfReviewState: this.selfReviewState,
      loadApprovedPlan: () => this.loadApprovedPlan(),
      runChanges: () => this.runChanges(),
      verificationForReview: () => this.verificationForReview(),
      testIntegrityForReview: () => this.testIntegrityForReview(),
      boundedDiff: (limit) => this.boundedDiff(limit),
      writeSelfReviewSummary: () => this.writeSelfReviewSummary(),
      setSelfReviewVerdict: (value) => { this.selfReviewVerdict = value; },
      record: this.host.record,
    });
    if (verdict) this.selfReviewVerdict = verdict;
  }

  beginSelfReviewState(): SelfReviewVerdict | null {
    if (this.selfReviewPasses > 0 && this.selfReviewState) return this.selfReviewState.report();
    this.selfReviewPasses += 1;
    this.selfReviewState = createSelfReview({
      input: { finalDiff: this.boundedDiff(this.host.selfReviewDiffChars) },
      ...(this.host.ports.selfReview?.maxFixIterations !== undefined
        ? { maxFixIterations: this.host.ports.selfReview.maxFixIterations }
        : { maxFixIterations: this.host.ports.limits?.selfReviewFixIterations ?? 2 }),
      ...(this.host.ports.selfReview?.enabled !== undefined ? { enabled: this.host.ports.selfReview.enabled } : {}),
    });
    return this.selfReviewState.report();
  }

  async verifyAndDecide(steps: number, stateRunId?: string): Promise<"passed" | "repair" | "approval_required" | "unavailable" | "exhausted"> {
    const revision = this.verifiedRevision ? await this.readVerificationRevision() : null;
    if (!revision || revision !== this.verifiedRevision || this.verificationLoop.status() !== "passed" || this.verifiedSignature !== this.currentChangeSignature()) {
      await this.runVerification(steps, stateRunId);
    }

    this.verifiedSignature = this.currentChangeSignature();
    this.writeVerificationSummary();
    const decision = this.verificationLoop.decide();
    if (decision.decision === "repair") {
      this.host.messages.push({ role: "system", content: formatRepairInstruction(this.verificationLoop.report()) });
      await this.host.record({
        kind: "reminder",
        companyId: this.host.companyId,
        projectId: this.host.projectId,
        sessionId: this.host.sessionId,
        runId: this.host.input.runId,
        turn: steps,
        reason: "verification_repair",
      });
      return "repair";
    }
    if (decision.decision === "complete") return "passed";
    if (decision.code === VERIFICATION_APPROVAL_REQUIRED) return "approval_required";
    if (decision.code === VERIFICATION_UNAVAILABLE) return "unavailable";
    return "exhausted";
  }

  async beginSelfReview(steps: number, prompt: string): Promise<void> {
    this.beginSelfReviewState();
    await this.runSelfReview(steps, prompt);
  }

  async afterSelfReview(steps: number): Promise<{ action: "complete" } | { action: "stop"; reason: CodingAgentStopReason; message: string } | { action: "continue" }> {
    const verdict = this.selfReviewVerdict;
    if (!verdict) return { action: "complete" };

    if (verdict.status === "unavailable") {
      return { action: "stop", reason: "self_review_unavailable", message: selfReviewStopMessage(verdict) };
    }

    if (verdict.status === "findings") {
      const instruction = this.selfReviewState?.applyFix() ?? null;
      if (instruction) {
        this.host.messages.push({ role: "system", content: instruction });
        this.selfReviewFixPending = true;
        await this.host.record({
          kind: "reminder",
          companyId: this.host.companyId,
          projectId: this.host.projectId,
          sessionId: this.host.sessionId,
          runId: this.host.input.runId,
          turn: steps,
          reason: "self_review_fix",
        });
        return { action: "continue" };
      }

      const blocking = verdict.findings.filter((finding) => finding.blocking);
      if (blocking.length) {
        this.selfReviewState?.noteFixOutcome(false);
        this.selfReviewVerdict = this.selfReviewState?.report() ?? verdict;
        this.writeSelfReviewSummary();
        return { action: "stop", reason: "self_review_unresolved", message: selfReviewStopMessage(this.selfReviewVerdict) };
      }
      return { action: "complete" };
    }

    if (verdict.status === "unresolved") {
      return { action: "stop", reason: "self_review_unresolved", message: selfReviewStopMessage(verdict) };
    }

    return { action: "complete" };
  }

  async afterSelfReviewFix(steps: number, stateRunId?: string): Promise<{ action: "complete" } | { action: "stop"; reason: CodingAgentStopReason; message: string }> {
    return this.host.reviewPhases.afterSelfReviewFixOnce({
      ctx: this.host.ctx,
      input: this.host.input,
      companyId: this.host.companyId,
      projectId: this.host.projectId,
      sessionId: this.host.sessionId,
      steps,
      turnId: this.host.turnId,
      stateRunId,
      verificationTools: this.verificationTools,
      capabilityScopeFields: this.host.capabilityScopeFields,
      selfReviewState: this.selfReviewState,
      verificationLoop: this.verificationLoop,
      verifiedSignature: this.verifiedSignature,
      currentChangeSignature: () => this.currentChangeSignature(),
      getSelfReviewVerdict: () => this.selfReviewVerdict,
      setSelfReviewVerdict: (verdict) => { this.selfReviewVerdict = verdict; },
      setSelfReviewFixPending: (pending) => { this.selfReviewFixPending = pending; },
      writeSelfReviewSummary: () => this.writeSelfReviewSummary(),
      writeVerificationSummary: () => this.writeVerificationSummary(),
      toCheckReports: (outcome) => this.toCheckReports(outcome),
      record: this.host.record,
    });
  }

  async onVerifyToolExecuted(
    beforeVerification: string | null,
    result: CodeToolInvokeResult,
  ): Promise<void> {
    if (beforeVerification && beforeVerification === await this.readVerificationRevision()) {
      const checks = this.toCheckReports(result);
      if (checks.length && checks.every((check) => check.state === "passed")) {
        this.verificationLoop.record(checks);
        this.verifiedSignature = this.currentChangeSignature();
        this.verifiedRevision = beforeVerification;
      }
    }
  }

  async handleCollectBarrier(args: {
    startedAt: number; stateRunId?: string; stateOwner: string;
    inboxOpened: boolean; cancelled: () => Promise<boolean>; admitInbox: () => Promise<boolean>;
  }): Promise<{ action: "ready" } | { action: "input_collected" } | { action: "stopped"; result: CodingAgentRunResult }> {
    const { startedAt, stateRunId, stateOwner, inboxOpened, cancelled, admitInbox } = args;
    const { ctx, companyId, session, ports, limits, input, release, stop } = this.host;

    let useCollectBarrier = false;
    try {
      useCollectBarrier = !input.subagentScope && !!ports.asyncCollect && await ports.asyncCollect.enabled(ctx, companyId);
    } catch {
      return { action: "stopped", result: await stop("interrupted", "async_collect_unsettled", "The collect barrier flag could not be resolved. Verification has not run.") };
    }
    if (!useCollectBarrier || !ports.asyncCollect) return { action: "ready" };

    if (!inboxOpened || !stateRunId || !ports.completions) {
      return { action: "stopped", result: await stop("interrupted", "async_collect_unsettled", "The collect barrier requires a durable inbox and completion collector.") };
    }

    const deadline = Date.now() + Math.max(0, Math.min(ports.asyncCollect.timeoutMs ?? 30_000, limits.maxRunMinutes * 60_000 - (Date.now() - startedAt)));
    let collectedInput = false;
    try {
      for (;;) {
        if (await cancelled()) {
          await release("cancelled");
          return { action: "stopped", result: await stop("cancelled", "cancelled", "The run was cancelled during result collection.") };
        }
        if (!await ports.asyncCollect.enabled(ctx, companyId)) throw new Error("collect_barrier_disabled");
        if (ports.runState && !(await ports.runState.renewLease({ companyId, runId: stateRunId, owner: stateOwner })).held) {
          throw new Error("collect_barrier_lease_lost");
        }
        await ports.completions.barrier(ctx, session, stateRunId, stateOwner);
        await ports.inbox!.transact(session, { kind: "collect-completions", runId: stateRunId, owner: stateOwner });
        collectedInput = await admitInbox() || collectedInput;
        const barrier = await ports.completions.barrier(ctx, session, stateRunId, stateOwner);
        if (barrier.ready) {
          this.collectedChanges = await ports.asyncCollect.changes(ctx, session, barrier.operations);
          this.applyTurnSummary();
          break;
        }
        if (barrier.blocked || Date.now() >= deadline) throw new Error("collect_barrier_pending");
        await new Promise<void>((r) => setTimeout(r, 250));
      }
    } catch {
      return { action: "stopped", result: await stop("interrupted", "async_collect_unsettled", "Result collection is incomplete. Verification and self-review have not run; the same run can be continued.") };
    }
    return collectedInput ? { action: "input_collected" } : { action: "ready" };
  }

  async finalizeOrReviewTurn(args: {
    steps: number; prompt: string; assistantText: string; stateRunId?: string;
  }): Promise<
    | { action: "completed"; result: CodingAgentRunResult }
    | { action: "stopped"; result: CodingAgentRunResult }
    | { action: "continue" }
  > {
    const { steps, prompt, assistantText, stateRunId } = args;
    await this.evaluateChangeSet(steps, prompt);
    const changeSet = this.runChanges();

    const stylePreview = this.host.input.allowStylePreview && !this.host.input.requireImplementation
      && this.host.session.mode !== "plan" && !this.host.input.readOnlyIntent
      && this.verificationTools.length === 1 && this.verificationTools[0] === "build"
      && changeSet.every(change => /\.css$/i.test(change.path));
    if (stylePreview) this.host.summary.stylePreview = true;
    if (stylePreview || this.verificationDisabled || (changeSet.length === 0 && !this.host.input.forceVerification)) {
      this.selfReviewVerdict = this.beginSelfReviewState();
      this.writeSelfReviewSummary();
      await this.host.release("completed");
      await this.host.ports.runEvents?.append({
        eventKey: `code-run-completed:${this.host.turnId}`, eventType: "completed",
        runStatus: "completed", message: "Coding Agent run completed",
      });
      this.host.summary.remaining = "The model finished without further tool calls.";
      return { action: "completed", result: await this.host.stop("completed", "completed", assistantText || "The run finished.") };
    }

    let verificationExhausted = false;
    if (this.selfReviewFixPending) {
      const outcome = await this.afterSelfReviewFix(steps, stateRunId);
      if (outcome.action === "stop") {
        this.host.summary.remaining = outcome.reason;
        this.host.summary.turns = steps;
        await this.host.release(outcome.reason);
        return { action: "stopped", result: await this.host.stop("stopped", outcome.reason, outcome.message) };
      }
    } else {
      const failing = await this.verifyAndDecide(steps, stateRunId);
      if (failing === "repair") {
        await this.host.release("verification_repair");
        return { action: "continue" };
      }
      if (failing === "approval_required") {
        this.host.summary.remaining = VERIFICATION_APPROVAL_REQUIRED;
        this.host.summary.turns = steps;
        await this.host.release(VERIFICATION_APPROVAL_REQUIRED);
        return { action: "stopped", result: await this.host.stop("stopped", "verification_failed", this.verificationStopMessage()) };
      }
      if (failing === "unavailable") {
        this.host.summary.remaining = VERIFICATION_UNAVAILABLE;
        this.host.summary.turns = steps;
        await this.host.release(VERIFICATION_UNAVAILABLE);
        return { action: "stopped", result: await this.host.stop("stopped", "verification_failed", this.verificationStopMessage()) };
      }

      verificationExhausted = failing === "exhausted";
      if (verificationExhausted) this.host.summary.remaining = VERIFICATION_REPAIR_EXHAUSTED;
      await this.beginSelfReview(steps, prompt);

      const outcome = await this.afterSelfReview(steps);
      if (outcome.action === "stop") {
        this.host.summary.remaining = outcome.reason;
        this.host.summary.turns = steps;
        await this.host.release(outcome.reason);
        return { action: "stopped", result: await this.host.stop("stopped", outcome.reason, outcome.message) };
      }
      if (outcome.action === "continue") return { action: "continue" };
    }

    if (verificationExhausted) {
      this.host.summary.turns = steps;
      await this.host.release("verification_failed");
      return { action: "stopped", result: await this.host.stop("stopped", "verification_failed", this.verificationStopMessage()) };
    }

    await this.host.release("completed");
    await this.host.ports.runEvents?.append({
      eventKey: `code-run-completed:${this.host.turnId}`, eventType: "completed",
      runStatus: "completed", message: "Coding Agent run completed",
    });
    this.host.summary.remaining = "The model finished without further tool calls.";
    return { action: "completed", result: await this.host.stop("completed", "completed", assistantText || "The run finished.") };
  }
}
