import { activeCodeProcess, type AuthContext, type CodeSession, type CodeCompletionNotice, type CodeProcessStore, type CodeInboxMessage, type DurableCodeProcess } from "@npati/workspace";
import type { CodeAsyncProcessService } from "./code-async-process";
import type { CodeSessionInboxService } from "./code-session-inbox";
import { wrapToolResult } from "./code-tools-fs";
import { canonicalizeSettledToolResult } from "./code-replay-bundle";

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
