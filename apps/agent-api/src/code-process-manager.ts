import { randomUUID } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import { CODE_AGENT_MASTER_FLAG } from "./feature-flags";
import type { FeatureFlagService } from "./feature-flags";
import type { AuditLogService } from "./audit-log";
import type { SecretLeaseProvider } from "./code-secret-lease";

/**
 * C4: background process manager for the coding agent.
 *
 * Every process runs inside the sandbox through the injected port (never on the application host) and
 * is scoped to a CodeSession: another session, project or company can never see, read or stop it.
 * A process that needs a secret requires its own approved lease — a lease issued for a foreground call
 * is never inherited.
 */

export interface CodeProcessSandboxPort {
  /** Existing providers return cumulative log snapshots; legacy injected ports may return deltas. */
  logsAreSnapshots?: boolean;
  start(input: {
    context: AuthContext; companyId: string; projectId: string; agentId: string; command: string;
    cwd?: string; runId?: string; approved?: boolean; leaseId?: string;
  }): Promise<{ processId: string; pid?: number; startedAt?: number }>;
  logs(input: { context: AuthContext; companyId: string; projectId: string; processId: string; agentId?: string }): Promise<{ output: string; eof?: boolean }>;
  status?(input: { context: AuthContext; companyId: string; projectId: string; processId: string; agentId?: string }): Promise<CodeProcessOutcome>;
  stop(input: { context: AuthContext; companyId: string; projectId: string; processId: string; agentId?: string }): Promise<{ exitCode: number | null; durationMs: number; state?: CodeProcessOutcome["state"] }>;
}

export interface CodeProcessOutcome {
  state: "running" | "completed" | "failed" | "stopped" | "timed_out" | "lost";
  exitCode: number | null;
}

export interface CodeProcessRecord {
  processId: string;
  sessionId: string;
  companyId: string;
  projectId: string;
  agentId?: string;
  commandDigest: string;
  pid?: number;
  state: CodeProcessOutcome["state"];
  startedAt: number;
  stoppedAt?: number;
  exitCode?: number | null;
  leaseId?: string;
  cursor: number;
}

export interface CodeProcessManagerOptions {
  sandbox?: CodeProcessSandboxPort;
  flags?: FeatureFlagService;
  audit?: Pick<AuditLogService, "record">;
  leases?: SecretLeaseProvider;
  /** Ring buffer size per process; older lines are dropped. */
  logLines?: number;
  outputChars?: number;
  /** Idle TTL after which a process record is dropped from memory. */
  ttlMs?: number;
  maxProcessesPerSession?: number;
  now?: () => number;
}

export class ProcessManagerError extends Error {
  readonly status = "error" as const;
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProcessManagerError";
  }
  toJSON(): Record<string, unknown> {
    return { status: this.status, code: this.code, message: this.message, httpStatus: this.httpStatus, retryable: this.retryable, details: this.details };
  }
}

export class CodeProcessManager {
  tracked?: import("./code-async-process").CodeAsyncProcessService;
  private readonly processes = new Map<string, CodeProcessRecord>();
  private readonly buffers = new Map<string, string[]>();
  private readonly bufferStarts = new Map<string, number>();
  private readonly providerOffsets = new Map<string, number>();
  private readonly outputBuffers = new Map<string, { text: string; earliest: number; next: number }>();
  private readonly refreshingLogs = new Map<string, Promise<void>>();
  private readonly starting = new Map<string, number>();
  private readonly logLines: number;
  private readonly outputChars: number;
  private readonly ttlMs: number;
  private readonly maxProcessesPerSession: number;
  private readonly now: () => number;

  constructor(private readonly options: CodeProcessManagerOptions = {}) {
    const positive = (value: number | undefined, fallback: number) => (Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback);
    this.logLines = positive(options.logLines, 2_000);
    this.outputChars = positive(options.outputChars, 64_000);
    this.ttlMs = positive(options.ttlMs, 12 * 60 * 60 * 1000);
    this.maxProcessesPerSession = positive(options.maxProcessesPerSession, 10);
    this.now = options.now ?? (() => Date.now());
  }

  async start(context: AuthContext, input: { companyId: string; projectId: string; sessionId: string; command: string; cwd?: string; agentId?: string; runId?: string; leaseId?: string; approved?: boolean }): Promise<CodeProcessRecord> {
    if (!this.options.sandbox) throw new ProcessManagerError("sandbox_unavailable", "Sandbox process execution is unavailable", 503, true);
    if (!input.command?.trim()) throw new ProcessManagerError("invalid_command", "A command is required", 400);
    if (this.options.flags) await this.options.flags.assertEnabled(context, CODE_AGENT_MASTER_FLAG, { companyId: input.companyId });
    else throw new ProcessManagerError("feature_disabled", "Coding agent flags are not configured", 403);
    if (this.options.flags) await this.options.flags.assertEnabled(context, "code.background_runs", { companyId: input.companyId });
    if (input.leaseId) {
      if (!this.options.leases) throw new ProcessManagerError("secret_lease_unavailable", "Secret leases are not configured", 503, true);
      if (input.approved !== true) throw new ProcessManagerError("approval_required", "A background process that uses a secret requires its own approval", 403);
      if (!input.runId) throw new ProcessManagerError("invalid_command", "A background process that uses a secret must belong to a run (no session inheritance)", 400);
      // A lease issued for a foreground call must never be reused by a background process.
      this.options.leases.assertNotInherited(input.leaseId, input.leaseId);
    }
    // Reserve synchronously before the provider await: concurrent starts cannot oversubscribe capacity.
    const reserved = this.starting.get(input.sessionId) ?? 0;
    if (this.runningForSession(input.sessionId).length + reserved >= this.maxProcessesPerSession) {
      throw new ProcessManagerError("process_limit", "Too many background processes for this session", 429, true);
    }
    this.starting.set(input.sessionId, reserved + 1);
    try {
      const started = await this.options.sandbox.start({
        context, companyId: input.companyId, projectId: input.projectId, agentId: input.agentId ?? "system",
        command: input.command, cwd: input.cwd, runId: input.runId, approved: input.approved === true, leaseId: input.leaseId,
      });
      if (!started.processId?.trim() || this.processes.has(started.processId)) {
        throw new ProcessManagerError("process_start_unknown_outcome", "Provider did not publish a unique process handle; reconcile before retrying", 502);
      }
      const record: CodeProcessRecord = {
        processId: started.processId, sessionId: input.sessionId, companyId: input.companyId, projectId: input.projectId,
        agentId: input.agentId ?? "system",
        commandDigest: digest(input.command), pid: started.pid, state: "running",
        startedAt: started.startedAt ?? this.now(), leaseId: input.leaseId, cursor: 0,
      };
      this.processes.set(record.processId, record);
      this.buffers.set(record.processId, []);
      this.outputBuffers.set(record.processId, { text: "", earliest: 0, next: 0 });
      await this.audit(context, input, "process.start", "allowed", { processId: record.processId, leaseId: input.leaseId ?? null });
      return { ...record };
    } finally {
      const remaining = (this.starting.get(input.sessionId) ?? 1) - 1;
      if (remaining) this.starting.set(input.sessionId, remaining);
      else this.starting.delete(input.sessionId);
    }
  }

  /** Lists the processes of one session only; records of other sessions are never returned. */
  list(sessionId: string): CodeProcessRecord[] {
    this.reapIdle();
    return [...this.processes.values()]
      .filter((process) => process.sessionId === sessionId)
      .map((process) => ({ ...process }));
  }

  /** Returns the process only when it belongs to the caller's session; otherwise `process_not_found`. */
  private owned(sessionId: string, processId: string): CodeProcessRecord {
    const process = this.processes.get(processId);
    if (!process || process.sessionId !== sessionId) throw new ProcessManagerError("process_not_found", "Unknown background process for this session", 404);
    return process;
  }

  /** Appends sandbox output to the ring buffer and returns new lines from `offset`. */
  appendOutput(processId: string, output: string): void {
    const buffer = this.buffers.get(processId);
    if (!buffer || !output) return;
    const chars = this.outputBuffers.get(processId)!;
    chars.text = (chars.text + output).slice(-this.outputChars);
    chars.next += output.length;
    chars.earliest = chars.next - chars.text.length;
    for (const line of output.split("\n")) buffer.push(line);
    if (buffer.length > this.logLines) {
      const dropped = buffer.length - this.logLines;
      buffer.splice(0, dropped);
      this.bufferStarts.set(processId, (this.bufferStarts.get(processId) ?? 0) + dropped);
    }
  }

  /** Absolute character cursors (UTF-16), independent of UI/model readers and ring-buffer eviction. */
  readOutput(sessionId: string, processId: string, offset = 0, limit = this.outputChars) {
    this.owned(sessionId, processId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new ProcessManagerError("invalid_output_cursor", "Output offset and limit must be nonnegative integers", 400);
    }
    const buffer = this.outputBuffers.get(processId)!;
    if (offset > buffer.next) throw new ProcessManagerError("invalid_output_cursor", "Output cursor is ahead of this process", 400);
    const start = Math.max(offset, buffer.earliest);
    const output = buffer.text.slice(start - buffer.earliest, start - buffer.earliest + Math.min(limit, this.outputChars));
    return { output, earliestOffset: buffer.earliest, nextOffset: start + output.length, total: buffer.next, truncated: offset < buffer.earliest };
  }

  /** A lifecycle exit is separate from cancellation; a missing exit code never becomes success. */
  async status(context: AuthContext, sessionId: string, processId: string): Promise<CodeProcessRecord> {
    const process = this.owned(sessionId, processId);
    if (process.state !== "running") return { ...process };
    if (!this.options.sandbox?.status) throw new ProcessManagerError("process_status_unavailable", "Provider has no terminal status capability", 503);
    const result = await this.options.sandbox.status({ context, companyId: process.companyId, projectId: process.projectId, processId, agentId: process.agentId });
    if (process.state === "running" && result.state !== "running") {
      if (["completed", "failed", "timed_out"].includes(result.state) && !Number.isInteger(result.exitCode)) {
        throw new ProcessManagerError("process_outcome_unknown", "Provider has no terminal exit code", 502);
      }
      if (result.state === "completed" && result.exitCode !== 0) throw new ProcessManagerError("process_outcome_unknown", "Provider completion disagrees with exit code", 502);
      process.state = result.state;
      process.exitCode = result.exitCode;
      process.stoppedAt = this.now();
    }
    return { ...process };
  }

  /** Bounded observation of the SAME handle. Timeout never stops or starts a process. */
  async wait(context: AuthContext, sessionId: string, processId: string, waitTimeoutMs: number): Promise<{ process: CodeProcessRecord; timedOut: boolean }> {
    const held = this.owned(sessionId, processId);
    if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 0 || waitTimeoutMs > 300_000) throw new ProcessManagerError("invalid_wait_timeout", "Wait timeout must be between 0 and 300000 ms", 400);
    if (!this.options.sandbox?.status) throw new ProcessManagerError("process_status_unavailable", "Provider has no terminal status capability", 503);
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tick: ReturnType<typeof setTimeout> | undefined;
    let wakeTick: (() => void) | undefined;
    const timeout = new Promise<{ process: CodeProcessRecord; timedOut: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ process: { ...held }, timedOut: held.state === "running" }), waitTimeoutMs);
    });
    const observe = async () => {
      while (!closed) {
        const process = await this.status(context, sessionId, processId);
        if (process.state !== "running") return { process, timedOut: false };
        if (!closed) await new Promise<void>((resolve) => { wakeTick = resolve; tick = setTimeout(resolve, 100); });
      }
      return { process: { ...held }, timedOut: held.state === "running" };
    };
    try { return await Promise.race([observe(), timeout]); }
    finally { closed = true; clearTimeout(timer); clearTimeout(tick); wakeTick?.(); }
  }

  async logs(sessionId: string, processId: string, options: { offset?: number; limit?: number } = {}): Promise<{ lines: string[]; nextOffset: number; eof: boolean; total: number }> {
    const process = this.owned(sessionId, processId);
    const buffer = this.buffers.get(processId) ?? [];
    const earliest = this.bufferStarts.get(processId) ?? 0;
    const absolute = Math.max(earliest, Math.min(options.offset ?? 0, earliest + buffer.length));
    const offset = absolute - earliest;
    const limit = Math.max(1, Math.min(options.limit ?? 200, this.logLines));
    const lines = buffer.slice(offset, offset + limit);
    return { lines, nextOffset: absolute + lines.length, eof: offset + lines.length >= buffer.length, total: earliest + buffer.length };
  }

  /** Refreshes the buffer from the sandbox and returns the newly available lines. */
  async fetchLogs(context: AuthContext, sessionId: string, processId: string, options: { limit?: number } = {}): Promise<{ lines: string[]; nextOffset: number; eof: boolean; total: number }> {
    const process = this.owned(sessionId, processId);
    if (!this.options.sandbox) throw new ProcessManagerError("sandbox_unavailable", "Sandbox process execution is unavailable", 503, true);
    let refresh = this.refreshingLogs.get(processId);
    if (!refresh) {
      refresh = (async () => {
        const fetched = await this.options.sandbox!.logs({ context, companyId: process.companyId, projectId: process.projectId, processId, agentId: process.agentId });
        const output = fetched.output ?? "";
        const previous = this.options.sandbox!.logsAreSnapshots ? this.providerOffsets.get(processId) ?? 0 : 0;
        if (output.length < previous) throw new ProcessManagerError("process_output_reset", "Provider output was truncated or replaced", 409);
        this.appendOutput(processId, output.slice(previous));
        if (this.options.sandbox!.logsAreSnapshots) this.providerOffsets.set(processId, output.length);
      })();
      this.refreshingLogs.set(processId, refresh);
    }
    try { await refresh; } finally { if (this.refreshingLogs.get(processId) === refresh) this.refreshingLogs.delete(processId); }
    return this.logs(sessionId, processId, options);
  }

  async stop(context: AuthContext, sessionId: string, processId: string): Promise<CodeProcessRecord> {
    const process = this.owned(sessionId, processId);
    if (process.state !== "running") return { ...process };
    if (!this.options.sandbox) throw new ProcessManagerError("sandbox_unavailable", "Sandbox process execution is unavailable", 503, true);
    const result = await this.options.sandbox.stop({ context, companyId: process.companyId, projectId: process.projectId, processId, agentId: process.agentId });
    if (process.state === "running") {
      if (result.state === "running" || result.state === "completed" && result.exitCode !== 0) {
        throw new ProcessManagerError("process_stop_unconfirmed", "Provider did not confirm cancellation or a terminal outcome", 502);
      }
      process.state = result.state ?? "stopped";
      process.exitCode = result.exitCode;
      process.stoppedAt = this.now();
    }
    await this.audit(context, { companyId: process.companyId, projectId: process.projectId, sessionId }, "process.stop", "allowed", { processId, exitCode: result.exitCode });
    return { ...process };
  }

  /** Stops every process of a session (used when a session ends or a kill switch fires). */
  async stopAll(context: AuthContext, sessionId: string): Promise<number> {
    this.reapIdle();
    const owned = [...this.processes.values()].filter((process) => process.sessionId === sessionId && process.state === "running");
    let stopped = 0;
    for (const process of owned) {
      try {
        await this.stop(context, sessionId, process.processId);
        stopped += 1;
      } catch {
        // Failed cancellation is not proof of settlement; retain ownership for reconciliation.
      }
    }
    return stopped;
  }

  /** Drops stopped processes and idle records; returns how many were forgotten. */
  reapIdle(): number {
    const now = this.now();
    let dropped = 0;
    for (const [processId, process] of this.processes) {
      if (process.state === "running" && now - process.startedAt < this.ttlMs) continue;
      if (process.state === "running") continue;
      if (process.stoppedAt && now - process.stoppedAt < this.ttlMs) continue;
      this.processes.delete(processId);
      this.buffers.delete(processId);
      this.bufferStarts.delete(processId);
      this.providerOffsets.delete(processId);
      this.outputBuffers.delete(processId);
      dropped += 1;
    }
    return dropped;
  }

  private runningForSession(sessionId: string): CodeProcessRecord[] {
    return [...this.processes.values()].filter((process) => process.sessionId === sessionId && process.state === "running");
  }

  private async audit(context: AuthContext, input: { companyId: string; projectId: string; sessionId: string; leaseId?: string }, action: string, decision: "allowed" | "denied", metadata: Record<string, unknown>): Promise<void> {
    const audit = this.options.audit;
    if (!audit) return;
    await audit.record(context, {
      companyId: input.companyId, actor: context.userId, actorRole: "agent", action,
      resourceType: "code_process", projectId: input.projectId, decision,
      payload: { action, sessionId: input.sessionId, leaseId: input.leaseId ?? null },
      metadata: { ...metadata, sessionId: input.sessionId, leaseId: input.leaseId ?? null },
    }).catch(() => undefined);
  }
}

function digest(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return `fnv:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Convenience factory used by the wiring layer; keeps the ids unique per manager instance. */
export function newProcessId(): string { return randomUUID(); }
