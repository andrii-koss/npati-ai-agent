import { randomUUID } from "node:crypto";
import { CodeInboxError, type AuthContext, type CodeSession, type CodeInboxScope, type CodeInboxStore, type CodeInboxCommand } from "@npati/workspace";
import type { FeatureFlagService } from "./feature-flags";
import { decideRunRequest } from "./code-run-state";

export class CodeSessionInboxService {
  private wakeTask?: (ctx: AuthContext, session: CodeSession, signal: AbortSignal) => Promise<void>;
  private completionRecovery?: (ctx: AuthContext, session: CodeSession) => Promise<void>;
  setCompletionRecovery(recover: NonNullable<CodeSessionInboxService["completionRecovery"]>) { this.completionRecovery = recover; }
  private readonly waking = new Set<string>();
  private readonly wakeRequested = new Set<string>();
  private readonly shutdown = new AbortController();
  private readonly idleWaiters = new Set<() => void>();
  private readonly observers = new Map<string, Set<(revision: number) => void>>();
  /** Live observation hint only. Authenticated GET is still the authority for content and recovery. */
  observe(companyId: string, sessionId: string, listener: (revision: number) => void) {
    const key = JSON.stringify([companyId, sessionId]);
    const listeners = this.observers.get(key) ?? new Set();
    let lastRevision = -1;
    const observer = (revision: number) => {
      if (revision <= lastRevision) return;
      lastRevision = revision; listener(revision);
    };
    listeners.add(observer); this.observers.set(key, listeners);
    return () => { listeners.delete(observer); if (!listeners.size) this.observers.delete(key); };
  }
  constructor(private readonly options: {
    store?: CodeInboxStore;
    flags: Pick<FeatureFlagService, "assertEnabled" | "isEnabled">;
    loadSession(ctx: AuthContext, companyId: string, sessionId: string): Promise<CodeSession | null>;
    audit(ctx: AuthContext, companyId: string, sessionId: string, kind: string): Promise<void>;
    loadRunState?(companyId: string, runId: string): Promise<{ status: string } | null>;
    ownsLocalRun?(sessionId: string): boolean;
    logger?: { warn(code: string): void };
  }) {}
  setWakeTask(task: (ctx: AuthContext, session: CodeSession, signal: AbortSignal) => Promise<void>) { this.wakeTask = task; }
  /** A losing admission must not release the winning driver's shared sandbox. */
  async mayCleanup(ctx: AuthContext, session: CodeSession, result: unknown) {
    try {
      if (!await this.isEnabled(ctx, session.companyId)) return true;
      const runId = (result as { runId?: string } | null)?.runId;
      if (!runId || !this.options.loadRunState) return false;
      const run = await this.options.loadRunState(session.companyId, runId);
      if (run?.status === "running") return false;
      const { state } = await this.transact(session, { kind: "read" });
      return state.runId === runId || state.phase === "idle" || state.phase === "settled";
    } catch { this.options.logger?.warn("inbox_cleanup_fence_unavailable"); return false; }
  }
  async close(cancel: (sessionId: string) => void) {
    this.shutdown.abort();
    this.observers.clear();
    for (const key of this.waking) cancel((JSON.parse(key) as [string, string])[1]);
    if (this.waking.size) await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }
  /** Called by transports only after their existing sandbox/queue cleanup has completed. */
  async settled(ctx: AuthContext, session: CodeSession, result: unknown) {
    if (!await this.isEnabled(ctx, session.companyId)) return;
    const run = result as { runId?: string; status?: string } | null;
    if (!run?.runId) return;
    await this.transact(session, { kind: "release-task", runId: run.runId });
    if (run.status === "completed") await this.wake(ctx, session.companyId, session.id);
  }
  /** A run stopped by a server restart never reports back, so its session stays taken and queued messages wait forever. */
  async releaseFinishedRun(ctx: AuthContext, companyId: string, sessionId: string, runId: string) {
    const session = await this.options.loadSession(ctx, companyId, sessionId);
    if (session) await this.settled(ctx, session, { runId, status: "completed" });
  }
  async wake(ctx: AuthContext, companyId: string, sessionId: string) {
    if (!this.wakeTask || !await this.isEnabled(ctx, companyId) || this.shutdown.signal.aborted) return;
    const key = JSON.stringify([companyId, sessionId]);
    if (this.waking.has(key)) { this.wakeRequested.add(key); return; }
    this.waking.add(key);
    let session: CodeSession | null = null;
    try {
      session = await this.options.loadSession(ctx, companyId, sessionId);
      if (session?.status === "active") await this.completionRecovery?.(ctx, session);
      if (session?.status === "active") await this.wakeTask(ctx, session, this.shutdown.signal);
    } catch {
      if (session && !this.shutdown.signal.aborted) {
        try { await this.transact(session, { kind: "dispatch-error" }); }
        catch { this.options.logger?.warn("inbox_error_record_failed"); }
      }
      this.options.logger?.warn("inbox_dispatch_failed");
    } finally {
      this.waking.delete(key);
      if (this.wakeRequested.delete(key)) await this.wake(ctx, companyId, sessionId);
      if (!this.waking.size) { for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear(); }
    }
  }
  async isEnabled(ctx: AuthContext, companyId: string) {
    return !!this.options.store && await this.options.flags.isEnabled(ctx, "code.async_inbox", { companyId });
  }
  /**
   * N1: records that a run holds the session's task without driving it — the pause path and a C10 resume both do
   * this. Resolves `false` when the durable inbox is off, so a caller can report "not recorded" instead of
   * assuming the marker exists. Never throws for a task that belongs to another run: the transition itself is
   * the fence.
   */
  async yieldTask(input: { ctx: AuthContext; companyId: string; sessionId: string; runId: string; owner: string }): Promise<boolean> {
    if (!await this.isEnabled(input.ctx, input.companyId)) return false;
    const session = await this.options.loadSession(input.ctx, input.companyId, input.sessionId).catch(() => null);
    if (!session) return false;
    await this.transact(session, { kind: "pause", runId: input.runId, owner: input.owner });
    return true;
  }
  async recoverTerminalTask(session: CodeSession) {
    if (this.options.ownsLocalRun?.(session.id)) return;
    const snapshot = await this.transact(session, { kind: "read" });
    if (!snapshot.state.runId || snapshot.state.phase === "idle" || !this.options.loadRunState) return;
    const run = await this.options.loadRunState(session.companyId, snapshot.state.runId);
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) await this.transact(session, { kind: "release-task", runId: snapshot.state.runId });
  }
  scope(session: CodeSession): CodeInboxScope {
    return { companyId: session.companyId, projectId: session.projectId, sessionId: session.id,
      dataClassification: session.dataClassification, retentionClass: session.retentionClass };
  }
  async transact(session: CodeSession, command: CodeInboxCommand) {
    if (!this.options.store) throw new CodeInboxError("inbox_unavailable", 503);
    const result = await this.options.store.transact(this.scope(session), command);
    if (command.kind !== "read") {
      for (const listener of this.observers.get(JSON.stringify([session.companyId, session.id])) ?? []) {
        try { listener(result.state.revision); } catch { this.options.logger?.warn("inbox_observer_failed"); }
      }
    }
    return result;
  }
  async execute(ctx: AuthContext, companyId: string, sessionId: string, command: CodeInboxCommand) {
    await this.options.flags.assertEnabled(ctx, "code.async_inbox", { companyId });
    const session = await this.options.loadSession(ctx, companyId, sessionId).catch(() => null);
    if (!session) throw new CodeInboxError("session_not_found", 404);
    if (session.status === "archived" || session.status === "suspended_by_flag") throw new CodeInboxError("session_unavailable");
    await this.completionRecovery?.(ctx, session);
    // Caller-owned content is never accepted as an internal lifecycle command.
    if (!["read", "submit", "edit", "discard"].includes(command.kind)) throw new CodeInboxError("invalid_arguments", 400);
    if (command.kind === "submit" || command.kind === "edit") {
      if (decideRunRequest({ request: command.text, now: new Date() }).status === "refused_credential") throw new CodeInboxError("inbox_credential_refused", 400);
    }
    await this.options.audit(ctx, companyId, sessionId, command.kind);
    return this.transact(session, command);
  }
  async submit(ctx: AuthContext, companyId: string, sessionId: string, input: {
    requestId: string; text: string; mode: "queue" | "steer"; expectedRevision?: number;
  }) {
    return this.execute(ctx, companyId, sessionId, { kind: "submit", id: randomUUID(), authorId: ctx.userId, ...input });
  }
}
