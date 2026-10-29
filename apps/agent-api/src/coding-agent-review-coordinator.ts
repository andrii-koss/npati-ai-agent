import type { ChatMessage } from "@npati/omniroute-adapter";import type { AuthContext, CodeSession } from "@npati/workspace";import { sha256Hex, type CodeToolInvokeFailure, type CodeToolInvokeResult } from "./code-tool-runtime";import {  VERIFICATION_APPROVAL_REQUIRED,  VERIFICATION_REPAIR_EXHAUSTED,  VERIFICATION_UNAVAILABLE,  createVerificationLoop,  verificationChecks,  formatRepairInstruction,  type VerificationCheckReport,  type VerificationLoop,  type VerificationReport,} from "./code-verification-loop";import type { TestIntegrityVerdict } from "./code-test-integrity-guard";import type { ScopeGuardResult } from "./code-scope-guard";
import {
  planVerification,
  verificationFingerprint,  VERIFICATION_PLAN_VERSION,
  type VerificationPlan,
} from "./code-verification-plan";
import { decideSelfReview, type SelfReviewRiskDecision } from "./code-self-review-risk";
import { buildSelfReviewSummary, buildVerificationSummary } from "./code-review-summary";
import {
  createSelfReview,
  selfReviewStopMessage,
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
  type CodingAgentRunResult,
  DEFAULT_VERIFICATION_TOOLS,
  bounded,
  emitCodingActivity,
} from "./coding-agent-runner-contracts";
import type { CodingAgentReviewPhases } from "./coding-agent-review-phases";
import { CredentialMasker } from "./security-guardrails";

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

/**
 * How many verification results one run may remember. A run edits a handful of revisions; the cap exists so a
 * pathological edit/verify cycle cannot grow the map without bound.
 */
const VERIFICATION_CACHE_LIMIT = 4;

export class CodingAgentReviewCoordinator {
  private readonly runtimeReceipts: string[] = [];
  recordRuntimeResult(result: CodeToolInvokeResult): void {
    let receipt: unknown = result.result;
    if (result.tool === "code.shell.exec") {
      const data = (result.result as { data?: { exitCode?: number; stdout?: string; durationMs?: number; truncated?: boolean } })?.data;
      if (data?.exitCode !== 0) return;
      receipt = { exitCode: 0, stdout: CredentialMasker.mask(String(data.stdout ?? "")).slice(-3000), durationMs: data.durationMs, truncated: data.truncated || String(data.stdout ?? "").length > 3000 };
    } else if (result.tool !== "code.data.policies.apply") return;
    this.runtimeReceipts.push(JSON.stringify({ tool: result.tool, toolVersion: result.toolVersion, schemaVersion: result.schemaVersion, result: receipt }).slice(0, 4000));
    if (this.runtimeReceipts.length > 8) this.runtimeReceipts.shift();
  }
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
  /**
   * Step 2: successful **and** failed verification results, keyed by the fingerprint of their inputs. A cached
   * result is re-recorded into the loop instead of re-running the commands, so the repair budget and the decision
   * behave exactly as a fresh run would — only the sandbox work is saved. Capped: a run edits a handful of
   * revisions, and an unbounded map would be a leak.
   */
  private readonly verificationCache = new Map<string, { checks: VerificationCheckReport[]; revision: string }>();
  private lastVerificationPlan: VerificationPlan | null = null;
  private lastVerificationReused = false;
  /** How many recorded "runs" were replays of a cached result, so the summary can report real executions. */
  private verificationReuses = 0;
  /** Step 4: the adaptive risk decision for this run's change set, reported in the summary. */
  private selfReviewRisk: SelfReviewRiskDecision | null = null;

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

  /** The checks this change set actually needs. A pure decision: it reads the run's changed paths, nothing else. */
  verificationPlan(): VerificationPlan {
    return planVerification({
      requestedTools: this.verificationTools,
      changedPaths: this.runChanges().map((change) => change.path),
    });
  }

  /**
   * The identity a verification result is stored under. `null` means the workspace revision cannot be proven, and
   * an unprovable revision must never authorise reuse — the caller then simply runs the checks.
   *
   * `knownRevision` is passed by callers that have just read the revision (the model-verify observer): re-reading
   * it would add a second, racy read and could file the result under a revision that was never observed.
   */
  async verificationFingerprintFor(
    tools: readonly string[],
    knownRevision?: string | null,
  ): Promise<{ fingerprint: string; revision: string } | null> {
    const revision = knownRevision === undefined ? await this.readVerificationRevision() : knownRevision;
    if (!revision) return null;
    const sandboxImage = this.host.ports.environment?.sandboxImage?.()?.digest ?? null;
    return {
      revision,
      fingerprint: verificationFingerprint({
        revision,
        tools,
        sandboxImage,
        changeSignature: this.currentChangeSignature(),
      }),
    };
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

  /**
   * Maps the executor outcome to check reports **for the checks that actually ran**. Passing the requested list
   * here after a narrowed plan would mark every skipped check as `unavailable`, and an unavailable check is a
   * failure by construction — the summary must state what was proven, not what was wished for.
   */
  toCheckReports(
    outcome: CodeToolInvokeResult | CodeToolInvokeFailure,
    tools: readonly string[] = this.verificationTools,
  ): VerificationCheckReport[] {
    return verificationChecks(outcome, tools);
  }

  runVerification(steps: number, stateRunId?: string, tools: readonly string[] = this.verificationTools): Promise<void> {
    return this.host.reviewPhases.verifyOnce({
      ctx: this.host.ctx,
      input: this.host.input,
      companyId: this.host.companyId,
      projectId: this.host.projectId,
      sessionId: this.host.sessionId,
      stateRunId,
      steps,
      turnId: this.host.turnId,
      verificationTools: tools,
      capabilityScopeFields: this.host.capabilityScopeFields,
      verificationLoop: this.verificationLoop,
      toCheckReports: (outcome) => this.toCheckReports(outcome, tools),
      record: this.host.record,
    });
  }

  writeVerificationSummary(): void {
    if (this.verificationDisabled) return;
    const report: VerificationReport = this.verificationLoop.report();
    if (report.status === "not_run" && !this.testIntegrity) return;
    this.host.summary.verification = buildVerificationSummary({
      report,
      plan: this.lastVerificationPlan,
      reused: this.lastVerificationReused,
      reuses: this.verificationReuses,
      integrity: this.testIntegrity,
    });
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
    // runChanges intentionally keeps the latest metadata per path. A review needs
    // earlier patches too: a later body edit must not hide a prior title fix.
    const patches: Array<{ path: string; diff: string; source: string }> = [];
    for (const index of this.host.toolSteps) {
      try {
        const turn = this.host.ports.toolRuntime.turnSummary?.(this.host.sessionId, this.host.stepTurnKey(index));
        for (const change of turn?.changes ?? []) if (change.diff) {
          patches.push({ path: change.path, diff: change.diff, source: `turn ${index}` });
        }
      } catch { /* Retain the same unavailable-summary behavior as runChanges. */ }
    }
    const recorded = new Set(patches.map(change => change.path + "\0" + change.diff));
    for (const change of [...this.collectedChanges, ...this.runChanges()]) {
      if (!change.diff || recorded.has(change.path + "\0" + change.diff)) continue;
      patches.push({ path: change.path, diff: change.diff, source: "collected operation" });
      recorded.add(change.path + "\0" + change.diff);
    }
    const joined = patches.length ? "Recorded incremental patches; later turns apply to preceding file versions. Lines outside a hunk are not evidence of missing code.\n" +
      patches.map(change => `--- ${change.path} (${change.source})\n${change.diff}`).join("\n") : "";
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

  writeSelfReviewSummary(): void {
    const verdict = this.selfReviewVerdict;
    if (!verdict) return;
    this.host.summary.selfReview = buildSelfReviewSummary({ verdict, risk: this.selfReviewRisk?.risk ?? null });
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
      runtimeEvidence: this.runtimeReceipts.join("\n"),
      boundedDiff: (limit) => this.boundedDiff(limit),
      writeSelfReviewSummary: () => this.writeSelfReviewSummary(),
      setSelfReviewVerdict: (value) => { this.selfReviewVerdict = value; },
      record: this.host.record,
    });
    if (verdict) this.selfReviewVerdict = verdict;
  }

  /**
   * Step 4: the adaptive decision for this change set.
   *
   * It is computed from facts the run already holds — the changed paths and diffs, the verification verdict and its
   * repair history, the test-integrity verdict and the scope guard — never from the model. A change can only be
   * skipped when it is presentation-only, verified, unrepaired, integrity-clean and small.
   */
  selfReviewDecision(options: { previewVerifies?: boolean } = {}): SelfReviewRiskDecision {
    const status = this.verificationLoop.status();
    const totals = this.runChangeTotals();
    return decideSelfReview({
      changedFiles: this.runChanges(),
      verificationStatus: status === "passed" ? "passed" : status === "not_run" ? "not_run" : "failed",
      hadRepair: this.verificationLoop.attemptsUsed() > 0,
      testIntegrity: this.testIntegrity
        ? { flagged: this.testIntegrity.flagged, requiresJustification: this.testIntegrity.requiresJustification }
        : null,
      scopeExceeded: this.scopeGuard?.exceeded === true,
      totalLinesChanged: totals.linesAdded + totals.linesRemoved,
      adaptiveEnabled: this.host.ports.selfReview?.adaptive ?? this.host.limits.selfReviewAdaptive, previewVerifies: options.previewVerifies === true,
    });
  }

  beginSelfReviewState(skip?: { reason: "adaptive_low_risk_skip"; detail: string }): SelfReviewVerdict | null {
    if (this.selfReviewPasses > 0 && this.selfReviewState) return this.selfReviewState.report();
    this.selfReviewPasses += 1;
    this.selfReviewState = createSelfReview({
      input: { originalGoal: this.host.input.prompt, changedFiles: this.runChanges(), finalDiff: this.boundedDiff(this.host.selfReviewDiffChars), verification: this.verificationForReview(), testIntegrity: this.testIntegrityForReview() },
      ...(skip ? { skipReason: skip } : {}),
      ...(this.host.ports.selfReview?.maxFixIterations !== undefined
        ? { maxFixIterations: this.host.ports.selfReview.maxFixIterations }
        : { maxFixIterations: this.host.ports.limits?.selfReviewFixIterations ?? 2 }),
      ...(this.host.ports.selfReview?.enabled !== undefined ? { enabled: this.host.ports.selfReview.enabled } : {}),
    });
    return this.selfReviewState.report();
  }

  /**
   * Step 2: verification is skipped only when its **inputs** are provably unchanged.
   *
   * The fingerprint covers the canonical workspace revision (a content digest, so it moves when any file —
   * including `package.json` or a lockfile — changes), the checks that would run, the execution image and the
   * run's own change signature. A cached result is replayed through `record()`, which keeps the repair budget
   * and `decide()` semantics identical to a real run; only the sandbox commands are saved.
   */
  async verifyAndDecide(steps: number, stateRunId?: string): Promise<"passed" | "repair" | "approval_required" | "unavailable" | "exhausted"> {
    const plan = this.verificationPlan();
    this.lastVerificationPlan = plan;
    const identity = await this.verificationFingerprintFor(plan.tools);
    /**
     * A pass produced by the model against the **full** requested list is stronger evidence than the narrowed
     * plan, so it may satisfy a narrowed lookup too (same revision, strictly more checks). The reverse is never
     * allowed: a narrowed pass cannot be reused for a full check set.
     */
    const fullIdentity = plan.tools.length === this.verificationTools.length
      ? identity
      : await this.verificationFingerprintFor(this.verificationTools);
    const cached = (identity ? this.verificationCache.get(identity.fingerprint) : undefined)
      ?? (fullIdentity ? this.verificationCache.get(fullIdentity.fingerprint) : undefined);

    if (cached) {
      this.lastVerificationReused = true;
      this.verificationReuses += 1;
      this.verificationLoop.record(cached.checks);
      this.verifiedRevision = cached.revision;
      this.verifiedSignature = this.currentChangeSignature();
      await emitCodingActivity(this.host.input, {
        id: `${stateRunId ?? this.host.input.runId}:verify:reused:${steps}`,
        runId: stateRunId ?? this.host.input.runId,
        stage: "build",
        title: "Verification reused for the unchanged revision",
        tool: "code.verify.run",
        at: new Date().toISOString(),
        status: "completed",
        agentId: this.host.input.agentId ?? "NPATI Coding Agent",
      });
    } else {
      this.lastVerificationReused = false;
      await this.runVerification(steps, stateRunId, plan.tools);
      const report = this.verificationLoop.report();
      if (identity && report.checks.length) {
        this.cacheVerification(identity.fingerprint, report.checks, identity.revision);
        if (report.status === "passed") this.verifiedRevision = identity.revision;
      }
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

  async beginSelfReview(steps: number, prompt: string, decision?: SelfReviewRiskDecision): Promise<void> {
    this.selfReviewRisk = decision ?? this.selfReviewRisk;
    /**
     * Step 4: the adaptive skip. The pass is recorded as `not_run` with its own reason and **no model call is made**;
     * `afterSelfReview` then treats it as "nothing to decide" exactly like an empty change set, so completion is
     * unaffected — the run was already verified, and this only removes a second, model-based opinion.
     */
    if (decision?.decision === "skip") {
      this.selfReviewVerdict = this.beginSelfReviewState({
        reason: "adaptive_low_risk_skip",
        detail: `Skipped: ${decision.reason} (${decision.signals.join(", ")}).`,
      });
      this.writeSelfReviewSummary();
      await this.host.record({
        kind: "reminder",
        companyId: this.host.companyId,
        projectId: this.host.projectId,
        sessionId: this.host.sessionId,
        runId: this.host.input.runId,
        turn: steps,
        reason: "self_review_skipped",
      });
      return;
    }
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
        // A no-change run (inspect/test only) has no backend verification phase: summarize this proven pass (P025).
        this.lastVerificationPlan ??= { version: VERIFICATION_PLAN_VERSION, tools: checks.map((check) => check.tool), skipped: [], changeKinds: [], reason: "no_changes" }; this.writeVerificationSummary();
        /**
         * Step 2: a pass the model itself produced is evidence for exactly this revision. Remembering it lets the
         * backend decision reuse it instead of paying for the same build twice. Only the full requested set is
         * cached: a partial pass is not evidence for checks it did not run.
         */
        const identity = await this.verificationFingerprintFor(this.verificationTools, beforeVerification);
        if (identity) this.cacheVerification(identity.fingerprint, checks, identity.revision);
      }
    }
  }

  private cacheVerification(fingerprint: string, checks: readonly VerificationCheckReport[], revision: string): void {
    this.verificationCache.set(fingerprint, { checks: checks.map((check) => ({ ...check })), revision });
    while (this.verificationCache.size > VERIFICATION_CACHE_LIMIT) {
      const oldest = this.verificationCache.keys().next().value;
      if (oldest === undefined) break;
      this.verificationCache.delete(oldest);
    }
  }

  async handleCollectBarrier(args: {
    startedAt: number; stateRunId?: string; stateOwner: string;
    inboxOpened: boolean; cancelled: () => Promise<boolean>; admitInbox: () => Promise<boolean>;
  }): Promise<{ action: "ready" } | { action: "input_collected" } | { action: "stopped"; result: CodingAgentRunResult }> {
    const { startedAt, stateRunId, stateOwner, inboxOpened, cancelled, admitInbox } = args;
    const { ctx, companyId, session, ports, limits, input, release, stop } = this.host;

    /**
     * A visual-repair continuation is not a fresh run: it must not block on the async collect barrier (which
     * requires the inbox lease the chat transport holds) and it consumes no new user messages.
     */
    if (input.skipAsyncCollect) return { action: "ready" };
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

    const collectTimeoutMs = ports.asyncCollect.timeoutMs ?? 30_000;
    const remainingRunMs = limits.maxRunMinutes > 0 ? limits.maxRunMinutes * 60_000 - (Date.now() - startedAt) : collectTimeoutMs;
    const deadline = Date.now() + Math.max(0, Math.min(collectTimeoutMs, remainingRunMs));
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
      if (changeSet.length > 0) {
        let outcome;
        if (this.selfReviewFixPending) outcome = await this.afterSelfReviewFix(steps, stateRunId);
        else {
          await this.beginSelfReview(steps, prompt, this.selfReviewDecision({ previewVerifies: stylePreview }));
          outcome = await this.afterSelfReview(steps);
        }
        if (outcome.action === "continue") return { action: "continue" };
        if (outcome.action === "stop") {
          this.host.summary.remaining = outcome.reason;
          await this.host.release(outcome.reason);
          return { action: "stopped", result: await this.host.stop("stopped", outcome.reason, outcome.message) };
        }
      } else {
        this.selfReviewVerdict = this.beginSelfReviewState();
        this.writeSelfReviewSummary();
      }
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
      const riskDecision = this.selfReviewDecision();
      await this.beginSelfReview(steps, prompt, riskDecision);

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
