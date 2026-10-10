import { activeCodeProcess, type AuthContext, type CodeSession, type CodeCompletionNotice, type CodeProcessStore, type CodeInboxMessage, type DurableCodeProcess } from "@npati/workspace";
import type { CodeAsyncProcessService } from "./code-async-process";
import type { CodeSessionInboxService } from "./code-session-inbox";
import { wrapToolResult } from "./code-tools-fs";
import { canonicalizeSettledToolResult } from "./code-replay-bundle";
import {
  buildCodeSubagentHandoffDigest,
  CodeSubagentHandoffError,
  emptyCodeSubagentHandoffDigest,
  type CodeSubagentHandoffDigest,
} from "./code-subagent-handoff";

/**
 * Step 5: the durable form of a detached child's outcome, as the operation's `output` slot stores it.
 *
 * It is JSON — the answer the digest builder parses, the changed paths, the counts and the failure code — written
 * by `applyCodeProcess`'s own `serializeChildOutcome`, so the collector rebuilds the parent's handoff through the
 * **same** digest builder the blocking path uses. Anything that is not that JSON (an operation written before the
 * field existed, or a child that died before reporting) reads as "the child produced nothing", which is an honest
 * empty digest rather than a fabricated answer.
 */
interface StoredCodeSubagentChildOutcome {
  answer?: unknown;
  filesChanged?: readonly unknown[];
  toolCalls?: unknown;
  turns?: unknown;
  errorCode?: string | null;
}

export function parseStoredCodeSubagentChildOutcome(raw: string): StoredCodeSubagentChildOutcome {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as StoredCodeSubagentChildOutcome
      : {};
  } catch {
    return {};
  }
}

/** Delivery/recovery only. Producer execution remains in the existing process/sandbox path. */
export class CodeProcessCompletionService {
  private readonly sessions = new Map<string, { ctx: AuthContext; session: CodeSession }>();
  private readonly flushing = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private readonly options: {
    store: CodeProcessStore; processes: CodeAsyncProcessService; inbox: CodeSessionInboxService;
    loadSession(ctx: AuthContext, companyId: string, sessionId: string): Promise<CodeSession>;
    enabled(ctx: AuthContext, companyId: string): Promise<boolean>;
    progress(scope: { companyId: string; sessionId: string; userId: string }, notice: CodeCompletionNotice): void;
    /**
     * Step 5: the recovery of detached delegations, run on the same schedule as the process outbox.
     *
     * A child operation is reconciled by the **child's own** run state — terminal means "settle it from that
     * state", a live lease means "leave it alone", `interrupted` means "re-enter the same run id" — so this hook is
     * only a trigger. Without it a delegation whose process died would sit active forever, which would keep the
     * parent's cleanup fence up and never produce the completion the parent is waiting for.
     */
    subagents?(ctx: AuthContext, session: CodeSession): Promise<unknown>;
    warn(code: string): void;
  }) {}
  private key(session: CodeSession) { return JSON.stringify([session.companyId, session.id]); }
  async settled(ctx: AuthContext, op: DurableCodeProcess) {
    const session = await this.options.loadSession(ctx, op.companyId, op.sessionId);
    await this.recover(ctx, session);
  }
  async recover(ctx: AuthContext, session: CodeSession) {
    if (this.closed || session.userId !== ctx.userId || !await this.options.enabled(ctx, session.companyId)) return;
    const key = this.key(session);
    if (this.sessions.size >= 200 && !this.sessions.has(key)) throw new Error("completion_recovery_capacity");
    this.sessions.set(key, { ctx, session });
    this.schedule();
    await this.flush(ctx, session);
  }
  private schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void Promise.allSettled([...this.sessions.values()].map(({ ctx, session }) => this.flush(ctx, session)))
        .then(() => { if (this.sessions.size) this.schedule(); });
    }, 1000);
    this.timer.unref();
  }
  private async flush(ctx: AuthContext, session: CodeSession) {
    const key = this.key(session), pending = this.flushing.get(key); if (pending) return pending;
    const task = (async () => {
      if (!await this.options.enabled(ctx, session.companyId)) return;
      await this.options.inbox.recoverTerminalTask(session);
      // Step 5: delegated children are reconciled before the completion sweep, so a child that settles here has its
      // notice produced in time to be delivered by the same pass.
      try { await this.options.subagents?.(ctx, session); }
      catch { this.options.warn("completion_subagent_recovery_pending"); }
      const scope = { companyId: session.companyId, projectId: session.projectId, sessionId: session.id };
      const before = await this.options.processes.list(ctx, scope);
      for (const op of before.filter(activeCodeProcess)) {
        // Reattach observation after restart through the SAME process manager, never start a producer.
        try { await this.options.processes.wait(ctx, { ...scope, processId: op.processId, waitTimeoutMs: 1 }); }
        catch { this.options.warn("completion_process_reconciliation_pending"); }
      }
      const operations = await this.options.processes.list(ctx, scope);
      let delivered = false;
      for (const op of operations) {
        const completion = op.completion; if (!completion) continue;
        const notice = completion.notice;
        if (completion.admission) {
          await this.options.inbox.transact(session, { kind: "completion-consume", eventId: notice.eventId });
        } else if (!completion.deliveredAt) {
          // At-least-once insertion; inbox dedup is event identity, not RAM lifetime.
          await this.options.inbox.transact(session, { kind: "completion-submit", notice, authorId: session.userId });
          delivered = true;
        }
        if (!completion.deliveredAt) {
          await this.options.store.transact(this.options.inbox.scope(session), { kind: "completion-delivered", operationId: op.operationId, eventId: notice.eventId, generation: notice.generation });
          if (!completion.admission) {
            try { this.options.progress({ companyId: session.companyId, sessionId: session.id, userId: session.userId }, notice); }
            catch { this.options.warn("completion_progress_observer_failed"); }
          }
        }
      }
      if (delivered) void this.options.inbox.wake(ctx, session.companyId, session.id).catch(() => this.options.warn("completion_wake_failed"));
      if (!operations.some(activeCodeProcess) && operations.every((op) => !op.completion || op.completion.deliveredAt)) this.sessions.delete(key);
    })();
    this.flushing.set(key, task);
    try { await task; } finally { if (this.flushing.get(key) === task) this.flushing.delete(key); }
  }
  async collect(ctx: AuthContext, session: CodeSession, message: CodeInboxMessage, runId: string) {
    const notice = message.completion; if (!notice) return null;
    const operations = await this.options.processes.list(ctx, { companyId: session.companyId, projectId: session.projectId, sessionId: session.id });
    const op = operations.find((op) => op.operationId === notice.operationId), completion = op?.completion;
    if (!completion || completion.notice.eventId !== notice.eventId || op!.generation !== notice.generation) throw new Error("completion_stale");
    if (completion.admission) {
      if (completion.admission.kind === "wait" || completion.admission.runId !== runId) return null;
      return { notice, text: completion.admission.canonicalResult };
    }
    /**
     * Step 5: a delegated child settles through the **same** notice, admission and collection path as a process
     * completion; only the result shape differs. A child has no terminal output to hand over — what it produced is
     * the metadata-only handoff digest the delegation built — so the stored slot carries that child outcome as
     * JSON and the envelope is rebuilt through the **same** digest builder that refuses content and credentials.
     * Nothing here reads the child's transcript, and its failure reason is a code, never a message body.
     */
    if (notice.type === "subagent" || op!.kind === "subagent") {
      const outcome = parseStoredCodeSubagentChildOutcome(completion.result.output);
      const completed = completion.result.state === "completed";
      let digest: CodeSubagentHandoffDigest;
      let handoffErrorCode: string | null = null;
      try {
        digest = buildCodeSubagentHandoffDigest({
          answer: outcome.answer,
          files: outcome.filesChanged,
          toolCalls: outcome.toolCalls,
          turns: outcome.turns,
        });
      } catch (error) {
        // A handoff that would have to carry content or a credential is a refusal, reported as the child's
        // failure — exactly the rule the blocking path applies — never a scrubbed digest.
        handoffErrorCode = error instanceof CodeSubagentHandoffError ? error.code : "subagent_handoff_content_rejected";
        digest = emptyCodeSubagentHandoffDigest();
      }
      const errorCode = handoffErrorCode ?? (completed ? outcome.errorCode : outcome.errorCode ?? "subagent_run_failed");
      const envelope = wrapToolResult("code.agent.spawn", {
        status: completed && !handoffErrorCode ? "completed" : "failed",
        runId: notice.childRunId ?? op!.child?.runId ?? null,
        errorCode: errorCode ?? null,
        detached: true,
        handoff: digest,
      }, { maxChars: 16000 });
      const text = canonicalizeSettledToolResult({ ok: true, tool: "code.agent.spawn", result: envelope, limit: 20000 });
      return { notice, text };
    }
    const result = completion.result;
    // Preserve the reference and absolute cursors even when only a small digest enters context.
    const output = result.output.slice(-8000);
    const envelope = wrapToolResult("code.shell.process.wait", { ...result, output, resultRef: notice.resultRef,
      operationId: notice.operationId, processId: notice.processId, generation: notice.generation,
      truncated: result.earliestOffset > 0 || output.length < result.output.length }, { maxChars: 16000 });
    const text = canonicalizeSettledToolResult({ ok: true, tool: "code.shell.process.wait", result: envelope, limit: 20000 });
    return { notice, text };
  }
  async admitted(session: CodeSession, notice: CodeCompletionNotice, input: { runId: string; owner: string; turnIndex: number; text: string; source: "wait" | "inbox" }) {
    await this.options.store.transact(this.options.inbox.scope(session), { kind: "completion-admit", operationId: notice.operationId, eventId: notice.eventId,
      generation: notice.generation, runId: input.runId, owner: input.owner, turnIndex: input.turnIndex, canonicalResult: input.text, source: input.source });
    await this.options.inbox.transact(session, { kind: "completion-consume", eventId: notice.eventId });
  }
  async admittedTool(ctx: AuthContext, session: CodeSession, result: unknown, input: { runId: string; owner: string; turnIndex: number; text: string }, receipt?: { kind: string; processId: string }) {
    if (!await this.options.enabled(ctx, session.companyId)) return;
    const envelope = result as { data?: { processId?: string; kind?: string } };
    const data = receipt ?? envelope?.data;
    if (data?.kind !== "foreground-result" || !data.processId) return;
    const operations = await this.options.processes.list(ctx, { companyId: session.companyId, projectId: session.projectId, sessionId: session.id });
    const completion = operations.find((op) => op.processId === data.processId)?.completion;
    if (!completion || completion.admission) return;
    await this.admitted(session, completion.notice, { ...input, source: "wait" });
    return completion.notice;
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); this.sessions.clear();
    await Promise.allSettled([...this.flushing.values()]);
  }
}
