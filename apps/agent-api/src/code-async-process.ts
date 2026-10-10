import { createHash, randomUUID } from "node:crypto";
import { activeCodeProcess, CodeProcessStoreError, type AuthContext, type CodeProcessScope, type CodeProcessStore, type DurableCodeProcess, type DurableProcessState, type CodeSession } from "@npati/workspace";
import type { FeatureFlagService } from "./feature-flags";
import type { ProcessWorkspaceSnapshot } from "./project-sandbox-service";

export interface TrackedProcessPort {
  supported(ctx: AuthContext, companyId: string, projectId: string): Promise<boolean>;
  start(ctx: AuthContext, input: AsyncProcessStart, op: DurableCodeProcess, beforeStart: (snapshot: ProcessWorkspaceSnapshot) => Promise<void>): Promise<{ processId?: string; status: string; exitCode: number | null }>;
  status(ctx: AuthContext, op: DurableCodeProcess): Promise<{ status: string; exitCode: number | null }>;
  stop(ctx: AuthContext, op: DurableCodeProcess): Promise<{ status: string; exitCode: number | null }>;
  output(ctx: AuthContext, op: DurableCodeProcess, offset: number): Promise<{ output: string; offset: number; lossy: boolean }>;
  sync(ctx: AuthContext, op: DurableCodeProcess): Promise<void>;
}
export interface AsyncProcessStart {
  companyId: string; projectId: string; sessionId: string; runId: string; leaseOwner: string;
  toolCallId: string; agentId?: string; command: string; cwd?: string; timeoutMs: number; approved?: boolean;
  preparationTimeoutMs?: number;
}
export type AsyncProcessReceipt = {
  kind: "foreground-result" | "running-process-receipt"; version: 1;
  operationId: string; processId: string; generation: number; state: DurableProcessState; exitCode: number | null;
  output: string; earliestOffset: number; nextOffset: number; truncated: boolean; lossy: boolean;
};

/** Durable admission/reconciliation adapter for the existing manager and sandbox process path. */
export class CodeAsyncProcessService {
  private readonly starts = new Map<string, Promise<DurableCodeProcess>>();
  private readonly observing = new Map<string, Promise<DurableCodeProcess>>();
  private readonly listeners = new Map<string, Set<(op: DurableCodeProcess) => void>>();
  private readonly monitors = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private settlementObserver?: (ctx: AuthContext, op: DurableCodeProcess) => Promise<void>;
  setSettlementObserver(observer: NonNullable<CodeAsyncProcessService["settlementObserver"]>) { this.settlementObserver = observer; }
  constructor(private readonly options: {
    store: CodeProcessStore; port: TrackedProcessPort;
    flags: Pick<FeatureFlagService, "assertEnabled">;
    session(ctx: AuthContext, companyId: string, sessionId: string): Promise<CodeSession>;
    run(companyId: string, runId: string): Promise<{ leaseOwner: string | null; status: string } | null>;
  }) {}
  private async scope(ctx: AuthContext, input: { companyId: string; projectId: string; sessionId: string }) {
    const session = await this.options.session(ctx, input.companyId, input.sessionId);
    if (session.projectId !== input.projectId || session.userId !== ctx.userId) throw new CodeProcessStoreError("process_not_found", 404);
    return { companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId,
      dataClassification: session.dataClassification, retentionClass: session.retentionClass };
  }
  private async update(scope: CodeProcessScope, op: DurableCodeProcess, patch: Omit<Extract<import("@npati/workspace").CodeProcessCommand, { kind: "update" }>, "kind" | "operationId" | "owner" | "generation">) {
    const result = await this.options.store.transact(scope, { kind: "update", operationId: op.operationId, owner: op.owner, generation: op.generation, ...patch });
    const next = result.operations.find((item) => item.operationId === op.operationId)!;
    for (const listener of this.listeners.get(op.operationId) ?? []) { try { listener(next); } catch { /* Observers cannot undo committed state. */ } }
    return next;
  }
  subscribe(operationId: string, listener: (op: DurableCodeProcess) => void) {
    const set = this.listeners.get(operationId) ?? new Set(); set.add(listener); this.listeners.set(operationId, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(operationId); };
  }
  async start(ctx: AuthContext, input: AsyncProcessStart) {
    if (this.closed) throw new CodeProcessStoreError("process_manager_closed", 503);
    await this.options.flags.assertEnabled(ctx, "code.async_processes", { companyId: input.companyId });
    await this.options.flags.assertEnabled(ctx, "code.background_runs", { companyId: input.companyId });
    const scope = await this.scope(ctx, input);
    if (!input.runId || !input.leaseOwner || !input.toolCallId || !input.command.trim()) throw new CodeProcessStoreError("process_run_identity_required", 400);
    if (!await this.options.port.supported(ctx, input.companyId, input.projectId)) throw new CodeProcessStoreError("process_promotion_unavailable", 503);
    const executionKey = JSON.stringify([scope.companyId, scope.projectId, scope.sessionId, input.runId, input.toolCallId]);
    const payloadHash = createHash("sha256").update(JSON.stringify([input.command, input.cwd ?? "", input.timeoutMs, input.agentId ?? "system"])).digest("hex");
    const session = await this.options.session(ctx, input.companyId, input.sessionId);
    if (["archived", "suspended_by_flag"].includes(session.status)) throw new CodeProcessStoreError("process_session_inactive", 409);
    const reserved = await this.options.store.transact(scope, { kind: "reserve", operationId: randomUUID(), processId: randomUUID(), executionKey, payloadHash,
      runId: input.runId, owner: input.leaseOwner, agentId: input.agentId ?? "system", startedRevision: session.revision });
    let op = reserved.operations.find((item) => item.executionKey === executionKey)!;
    if (op.owner !== input.leaseOwner) {
      op = (await this.options.store.transact(scope, { kind: "adopt", operationId: op.operationId, owner: input.leaseOwner })).operations.find((item) => item.operationId === op.operationId)!;
    }
    if (this.starts.has(op.operationId) && op.owner === input.leaseOwner && op.generation === 1) return this.starts.get(op.operationId)!;
    if (op.state !== "accepted") return this.reconcile(ctx, scope, op);
    const claim = await this.options.store.transact(scope, { kind: "claim", operationId: op.operationId, owner: input.leaseOwner }).catch(async (error) => {
      if ((error as { code?: string }).code === "process_workspace_busy") await this.options.store.transact(scope, { kind: "cancel", operationId: op.operationId });
      throw error;
    });
    op = claim.operations.find((item) => item.operationId === op.operationId)!;
    if (!claim.claimed) throw new CodeProcessStoreError("process_start_pending");
    const initial = op;
    const execution = (async () => {
      let current = initial;
      try {
        const result = await this.options.port.start(ctx, input, current, async (snapshot) => {
          current = await this.get(scope, current.operationId);
          if (current.cancelRequested || this.closed) throw new CodeProcessStoreError("process_cancelled_before_start");
          current = await this.update(scope, initial, { sandboxId: snapshot.sandboxId, workspaceSnapshot: snapshot, state: "dispatching" });
        });
        if (result.processId !== current.processId) throw new CodeProcessStoreError("process_start_unknown_outcome");
        current = await this.update(scope, current, { state: "running" });
        if ((await this.get(scope, current.operationId)).cancelRequested) current = await this.cancelOwned(ctx, scope, current);
        else current = await this.reconcile(ctx, scope, current);
        this.monitor(ctx, scope, current); await this.notifySettlement(ctx, current); return current;
      } catch (error) {
        const stored = await this.get(scope, initial.operationId);
        if (stored.owner === initial.owner && stored.generation === initial.generation) {
          if (stored.state === "preparing") await this.update(scope, stored, { state: "stopped" });
          else if (activeCodeProcess(stored)) await this.update(scope, stored, { state: "unknown_outcome" });
        }
        throw error;
      } finally { this.starts.delete(initial.operationId); }
    })();
    this.starts.set(initial.operationId, execution);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const preparationTimeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void this.options.store.transact(scope, { kind: "cancel", operationId: initial.operationId }).then(() => {
          reject(new CodeProcessStoreError("process_preparation_timeout", 504));
        }, reject);
      }, input.preparationTimeoutMs ?? 30000);
    });
    try { return await Promise.race([execution, preparationTimeout]); } finally { clearTimeout(timer); }
  }
  private async get(scope: CodeProcessScope, operationId: string) { return (await this.options.store.transact(scope, { kind: "read", operationId })).operations[0]!; }
  private async notifySettlement(ctx: AuthContext, op: DurableCodeProcess) {
    if (op.completion && this.settlementObserver) {
      void this.settlementObserver(ctx, op).catch(() => { /* Persisted outbox remains recoverable. */ });
    }
  }
  private monitor(ctx: AuthContext, scope: CodeProcessScope, op: DurableCodeProcess) {
    if (this.closed || !activeCodeProcess(op) || this.monitors.has(op.operationId)) return;
    const timer = setTimeout(() => {
      this.monitors.delete(op.operationId);
      void this.reconcile(ctx, scope, op).then((next) => this.monitor(ctx, scope, next), () => { /* Durable intent remains for authenticated recovery. */ });
    }, 250);
    timer.unref(); this.monitors.set(op.operationId, timer);
  }
  private async reconcile(ctx: AuthContext, scope: CodeProcessScope, op: DurableCodeProcess): Promise<DurableCodeProcess> {
    if (!activeCodeProcess(op)) return op;
    const pending = this.observing.get(op.operationId); if (pending) return pending;
    const task = (async () => {
      let current = await this.get(scope, op.operationId);
      if (current.state === "accepted" || current.state === "preparing") {
        // Never resume preparation without the original owned call. No producer exists before dispatching.
        if (!this.starts.has(current.operationId)) current = await this.update(scope, current, { state: "lost" });
        return current;
      }
      try {
        let status = await this.options.port.status(ctx, current);
        if (current.cancelRequested && status.status === "running") return this.cancelOwned(ctx, scope, current);
        const output = await this.options.port.output(ctx, current, current.output.next);
        current = await this.update(scope, current, { output: output.output, outputOffset: output.offset, lossy: output.lossy });
        if (status.status !== "running") {
          if (status.status !== "stopped") await this.options.port.sync(ctx, current);
          const state = status.status as DurableProcessState;
          if (!["completed", "failed", "timed_out", "stopped"].includes(state)) throw new CodeProcessStoreError("process_outcome_unknown");
          current = await this.update(scope, current, { state, exitCode: status.exitCode });
        } else if (current.state !== "running") current = await this.update(scope, current, { state: "running" });
        return current;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (["process_not_found", "sandbox_not_found"].includes(code ?? "")) {
          // Install a provider tombstone before treating a missing start as lost. A late dispatch cannot spawn.
          if (current.sandboxId) {
            try { await this.options.port.stop(ctx, current); }
            catch (stopError) { if ((stopError as { code?: string }).code !== "sandbox_not_found") throw stopError; }
          }
          return this.update(scope, current, { state: "lost" });
        }
        throw error;
      }
    })();
    this.observing.set(op.operationId, task);
    try { const next = await task; await this.notifySettlement(ctx, next); return next; } finally { if (this.observing.get(op.operationId) === task) this.observing.delete(op.operationId); }
  }
  async list(ctx: AuthContext, input: { companyId: string; projectId: string; sessionId: string }) {
    const scope = await this.scope(ctx, input);
    return (await this.options.store.transact(scope, { kind: "read" })).operations;
  }
  async wait(ctx: AuthContext, input: { companyId: string; projectId: string; sessionId: string; processId: string; waitTimeoutMs: number; offset?: number; leaseOwner?: string }) {
    if (!Number.isSafeInteger(input.waitTimeoutMs) || input.waitTimeoutMs < 0 || input.waitTimeoutMs > 300000) throw new CodeProcessStoreError("invalid_wait_timeout", 400);
    const scope = await this.scope(ctx, input);
    let op = (await this.options.store.transact(scope, { kind: "read", processId: input.processId })).operations[0]!;
    if (op.kind === "subagent") throw new CodeProcessStoreError("process_not_found", 404);
    const run = await this.options.run(op.companyId, op.runId);
    if (run?.status === "running" && input.leaseOwner && run.leaseOwner === input.leaseOwner && op.owner !== input.leaseOwner) {
      op = (await this.options.store.transact(scope, { kind: "adopt", operationId: op.operationId, owner: input.leaseOwner })).operations.find((item) => item.operationId === op.operationId)!;
    }
    let release!: () => void, timer: ReturnType<typeof setTimeout> | undefined;
    const settled = new Promise<void>((resolve) => { release = resolve; });
    // Subscribe BEFORE the authoritative read/reconciliation: completion cannot fall in the gap.
    const unsubscribe = this.subscribe(op.operationId, (next) => { op = next; if (!activeCodeProcess(next)) release(); });
    try {
      const reconcile = this.reconcile(ctx, scope, op).then((next) => { op = next; this.monitor(ctx, scope, next); if (!activeCodeProcess(next)) release(); });
      const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, input.waitTimeoutMs); });
      await Promise.race([reconcile.then(() => activeCodeProcess(op) ? settled : undefined), timeout]);
      op = await this.get(scope, op.operationId);
      return this.receipt(op, input.offset ?? 0);
    } finally { unsubscribe(); clearTimeout(timer); }
  }
  receipt(op: DurableCodeProcess, offset = 0): AsyncProcessReceipt {
    if (["accepted", "preparing"].includes(op.state)) throw new CodeProcessStoreError("process_start_pending");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > op.output.next) throw new CodeProcessStoreError("invalid_output_cursor", 400);
    const start = Math.max(offset, op.output.earliest);
    return { kind: activeCodeProcess(op) ? "running-process-receipt" : "foreground-result", version: 1,
      operationId: op.operationId, processId: op.processId, generation: op.generation, state: op.state, exitCode: op.exitCode,
      output: op.output.text.slice(start - op.output.earliest), earliestOffset: op.output.earliest, nextOffset: op.output.next,
      truncated: offset < op.output.earliest, lossy: op.output.lossy };
  }
  async promote(ctx: AuthContext, input: { companyId: string; projectId: string; sessionId: string }, op: DurableCodeProcess) {
    return this.update(await this.scope(ctx, input), op, { promoted: true });
  }
  private async cancelOwned(ctx: AuthContext, scope: CodeProcessScope, op: DurableCodeProcess) {
    if (op.state === "accepted" || op.state === "preparing") return op;
    const result = await this.options.port.stop(ctx, op);
    if (!["stopped", "completed", "failed", "timed_out"].includes(result.status)) throw new CodeProcessStoreError("process_stop_unconfirmed");
    const output = await this.options.port.output(ctx, op, op.output.next);
    op = await this.update(scope, op, { output: output.output, outputOffset: output.offset, lossy: output.lossy });
    if (result.status !== "stopped") await this.options.port.sync(ctx, op);
    // Cancellation is a lifecycle outcome, never a successful verification exit.
    const next = await this.update(scope, op, { state: result.status as DurableProcessState, exitCode: result.exitCode });
    await this.notifySettlement(ctx, next); return next;
  }
  async cancel(ctx: AuthContext, input: { companyId: string; projectId: string; sessionId: string; processId: string }) {
    const scope = await this.scope(ctx, input);
    let op = (await this.options.store.transact(scope, { kind: "read", processId: input.processId })).operations[0]!;
    if (op.kind === "subagent") throw new CodeProcessStoreError("process_not_found", 404);
    op = (await this.options.store.transact(scope, { kind: "cancel", operationId: op.operationId })).operations.find((item) => item.operationId === op.operationId)!;
    if (activeCodeProcess(op)) op = await this.cancelOwned(ctx, scope, op);
    return op;
  }
  async cleanupGuard(companyId: string, projectId: string, purpose?: "prepare") {
    const scope: CodeProcessScope = { companyId, projectId, sessionId: "sandbox-cleanup", dataClassification: "public", retentionClass: "ephemeral" };
    const token = randomUUID();
    if (!(await this.options.store.transact(scope, { kind: "cleanup-acquire", token, purpose })).cleanupAcquired) return null;
    return async () => { await this.options.store.transact(scope, { kind: "cleanup-release", token }); };
  }
  async legacyPreparationGuard(ctx: AuthContext, companyId: string, projectId: string) {
    let enabled = true;
    try { await this.options.flags.assertEnabled(ctx, "code.async_processes", { companyId }); } catch { enabled = false; }
    if (enabled) return this.cleanupGuard(companyId, projectId, "prepare");
    const scope: CodeProcessScope = { companyId, projectId, sessionId: "sandbox-cleanup", dataClassification: "public", retentionClass: "ephemeral" };
    return (await this.options.store.transact(scope, { kind: "idle-check" })).cleanupAcquired ? async () => {} : null;
  }
  async close() {
    this.closed = true;
    for (const timer of this.monitors.values()) clearTimeout(timer); this.monitors.clear();
    // Durable descriptors/provider execution remain owned after an API host exits. Do not restart or fake-stop.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled([...this.starts.values(), ...this.observing.values()]), new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]);
    } finally { clearTimeout(timer); this.listeners.clear(); }
  }
}
