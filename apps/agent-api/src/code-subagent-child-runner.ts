import type { AuthContext, CodeSession } from "@npati/workspace";
import type {
  CodeSubagentChildOutcome,
  CodeSubagentChildRunRequest,
  CodeSubagentChildRunner,
} from "./code-agent-spawn-executor";

/**
 * C12: the one adapter that turns "run a coding sub-agent" into "call the existing `CodingAgentRunner`".
 *
 * There is deliberately nothing else in this file. The delegation executor validates, intersects capability
 * scopes and digests the answer; this adapter supplies the two things only the composition knows — how to load
 * a session, and how to start a run — and it is expressed as two injected functions so a test can drive the
 * whole delegation without a database, an engine or a sandbox.
 *
 * The prompt is built from the **task text and the declared scope only**. The child never sees the parent's
 * conversation, its plan or its earlier tool results: if the parent's context is not in the prompt, it cannot
 * leak back into the parent through the child's answer, and the child cannot be steered by an instruction the
 * parent happened to read in a file.
 *
 * The answer that becomes the parent's handoff digest is built from the run's own `CodingAgentRunSummary` —
 * files changed, checks that ran, scope warnings, self-review findings — which is already metadata. Nothing in
 * this adapter reads a file, a diff or a message body, so there is no path by which content could enter the
 * digest even if a later change to the runner put it in the summary.
 */

/** The subset of `CodingAgentRunSummary` this adapter reads. Structural, so a fake is trivial to write. */
export interface CodeSubagentRunSummaryLike {
  /** Paths only — the runner's summary already carries paths and counts, never file bodies. */
  filesChanged?: readonly string[];
  checksRun?: readonly string[];
  turns?: number;
  toolCalls?: number;
  verification?: {
    status?: unknown;
    failedChecks?: ReadonlyArray<{ tool?: unknown; code?: unknown }>;
  };
  scope?: {
    warnings?: ReadonlyArray<{ code?: unknown; message?: unknown; severity?: unknown; paths?: readonly unknown[] }>;
  };
  selfReview?: {
    status?: unknown;
    blocking?: number;
    unresolved?: number;
    findings?: ReadonlyArray<{ id?: unknown; title?: unknown; path?: unknown; severity?: unknown; category?: unknown }>;
  };
}

export interface CodeSubagentRunAgentResult {
  status: string;
  reason: string;
  message: string;
  /** Machine-readable refusal code when the reason alone is too coarse. */
  code?: string;
  summary: CodeSubagentRunSummaryLike;
}

export interface CodeSubagentChildRunnerDeps {
  /** Loads the session of the delegating run. Absent session → the child is refused, never invented. */
  loadSession(input: { ctx: AuthContext; companyId: string; sessionId: string }): Promise<CodeSession | null>;
  /** Starts the child run through the existing runner. */
  runAgent(input: {
    ctx: AuthContext;
    session: CodeSession;
    prompt: string;
    model?: string;
    runId: string;
    parentRunId: string;
    allowedTools: readonly string[];
    readOnlyIntent?: boolean;
    maxTurns: number;
    turnId?: string;
    /**
     * Step 5: the child run's lease identity and the durable facts its own run row must carry. Both travel to the
     * runner unchanged, so a detached child is a run of the same log as every other run — with a parent recorded
     * on it and a lease that the settlement of its operation can be fenced on.
     */
    runStateOwner?: string;
    runDetails?: Record<string, unknown>;
  }): Promise<CodeSubagentRunAgentResult>;
  /**
   * Step 5: the child's metadata-only outcome, reported **after** the run returns or throws.
   *
   * This is the detached path's settlement hook: the delegated run is produced by the existing runner, and this
   * adapter is the only place that sees the run's own summary before it becomes a tool result. It is optional, so
   * the blocking path (which reports the outcome in its tool result) is unchanged and a test need not supply it.
   */
  onSettled?(request: CodeSubagentChildRunRequest, outcome: CodeSubagentChildOutcome): void;
}

/** A single-line, bounded string from an unknown value, or `null`. Mirrors the digest's own rule. */
function line(value: unknown, maxLength = 180): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

/** The delegation prompt. Task text and scope; never the parent's transcript. */
export function buildCodeSubagentPrompt(request: CodeSubagentChildRunRequest): string {
  return [
    `You are a "${request.agentType}" coding sub-agent (capability profile: ${request.capabilityProfile}).`,
    "Work only on the task below. You do not see the requesting agent's conversation, so do not refer to it.",
    request.readOnly ? "This task is read-only: change no file." : `Write only inside: ${request.paths.join(", ") || "the scope you were given"}.`,
    `You have at most ${request.maxTurns} turns.`,
    "",
    "Task:",
    request.task,
    ...(request.paths.length ? ["", "Declared file scope:", ...request.paths.map((path) => `- ${path}`)] : []),
    "",
    "When you are done, answer with JSON only, in this shape:",
    '{"findings":[{"kind":"fact|file|symbol|risk|open_question","path":"relative/path/or null","name":"symbol or null","detail":"one short line"}],"files":["relative/path"],"symbols":[{"path":"relative/path","name":"symbol","kind":"function"}]}',
    "The detail of a finding is ONE line and at most 200 characters: never paste file content, a diff, a command line or terminal output.",
  ].join("\n");
}

/**
 * The structured answer the digest parses. Every field is a name, a path or a short claim taken from the run's
 * own summary — no file body has a route into it.
 */
export function buildCodeSubagentAnswer(result: CodeSubagentRunAgentResult): Record<string, unknown> {
  const findings: Array<Record<string, unknown>> = [];

  const verificationStatus = line(result.summary.verification?.status, 60);
  if (verificationStatus) {
    findings.push({ kind: "fact", path: null, name: null, detail: `verification: ${verificationStatus}` });
  }
  for (const check of result.summary.verification?.failedChecks ?? []) {
    const tool = line(check.tool, 80);
    if (!tool) continue;
    const code = line(check.code, 80);
    findings.push({ kind: "risk", path: null, name: null, detail: code ? `${tool} failed (${code})` : `${tool} failed` });
  }
  for (const warning of result.summary.scope?.warnings ?? []) {
    const code = line(warning.code, 80);
    if (!code) continue;
    findings.push({ kind: "risk", path: null, name: null, detail: `scope warning: ${code}` });
  }
  const reviewStatus = line(result.summary.selfReview?.status, 60);
  if (reviewStatus && reviewStatus !== "clean") {
    findings.push({ kind: "open_question", path: null, name: null, detail: `self-review: ${reviewStatus}` });
  }
  for (const finding of result.summary.selfReview?.findings ?? []) {
    // A finding's title is a claim; a running commentary is not carried. `line` collapses whitespace and
    // refuses anything longer than the digest's own bound, so a pasted excerpt is dropped by the digest rather
    // than truncated into something that reads like a summary.
    const detail = line(finding.title, 200) ?? line(finding.id, 120);
    if (!detail) continue;
    const path = line(finding.path, 1024);
    findings.push({ kind: "risk", path: path ?? null, name: line(finding.category, 80), detail });
  }

  return {
    findings,
    files: [...(result.summary.filesChanged ?? [])],
    symbols: [],
  };
}

/** The adapter. A child that cannot find its session is refused; a child that throws is reported, not rethrown. */
export function createCodeSubagentChildRunner(deps: CodeSubagentChildRunnerDeps): CodeSubagentChildRunner {
  return {
    async run(request: CodeSubagentChildRunRequest): Promise<CodeSubagentChildOutcome> {
      const session = await deps.loadSession({ ctx: request.ctx, companyId: request.companyId, sessionId: request.sessionId });
      if (!session) {
        const missing: CodeSubagentChildOutcome = {
          runId: request.runId,
          status: "failed",
          errorCode: "subagent_session_missing",
          errorMessage: `Session ${request.sessionId} is not available to this caller`,
        };
        deps.onSettled?.(request, missing);
        return missing;
      }
      let result: CodeSubagentRunAgentResult;
      try {
        result = await deps.runAgent({
          ctx: request.ctx,
          session,
          prompt: buildCodeSubagentPrompt(request),
          runId: request.runId,
          parentRunId: request.parentRunId,
          allowedTools: request.allowedTools,
          maxTurns: request.maxTurns,
          ...(request.model ? { model: request.model } : {}),
          ...(request.readOnly ? { readOnlyIntent: true } : {}),
          ...(request.runStateOwner ? { runStateOwner: request.runStateOwner } : {}),
          ...(request.runDetails ? { runDetails: request.runDetails } : {}),
        });
      } catch (error) {
        /**
         * Step 5: a child run that throws is still a settled delegation. The detached path would otherwise leave
         * the durable operation active forever, which keeps the parent's cleanup fence up and never produces the
         * completion the parent is waiting for. The outcome is metadata-only: a code, never the error's own text
         * beyond a bounded line.
         */
        const thrown: CodeSubagentChildOutcome = {
          runId: request.runId,
          status: "failed",
          errorCode: typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "subagent_run_failed",
          errorMessage: line(error instanceof Error ? error.message : null, 300) ?? "The sub-agent run failed",
        };
        deps.onSettled?.(request, thrown);
        return thrown;
      }
      const completed = result.status === "completed";
      const outcome: CodeSubagentChildOutcome = {
        runId: request.runId,
        status: completed ? "completed" : "failed",
        ...(completed ? {} : { errorCode: result.code ?? result.reason ?? "subagent_run_failed" }),
        ...(completed ? {} : { errorMessage: line(result.message, 300) ?? "The sub-agent run did not complete" }),
        answer: JSON.stringify(buildCodeSubagentAnswer(result)),
        filesChanged: result.summary.filesChanged ?? [],
        toolCalls: result.summary.toolCalls ?? 0,
        turns: result.summary.turns ?? 0,
      };
      deps.onSettled?.(request, outcome);
      return outcome;
    },
  };
}
