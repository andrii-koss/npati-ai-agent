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
  start(input: {
    context: AuthContext; companyId: string; projectId: string; agentId: string; command: string;
    cwd?: string; runId?: string; approved?: boolean; leaseId?: string;
  }): Promise<{ processId: string; pid?: number; startedAt?: number }>;
  logs(input: { context: AuthContext; companyId: string; projectId: string; processId: string }): Promise<{ output: string; eof?: boolean }>;
  stop(input: { context: AuthContext; companyId: string; projectId: string; processId: string }): Promise<{ exitCode: number; durationMs: number }>;
}

export interface CodeProcessRecord {
  processId: string;
  sessionId: string;
  companyId: string;
  projectId: string;
  commandDigest: string;
  pid?: number;
  state: "running" | "stopped" | "failed";
  startedAt: number;
  stoppedAt?: number;
  exitCode?: number;
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
  private readonly processes = new Map<string, CodeProcessRecord>();
  private readonly buffers = new Map<string, string[]>();
  private readonly logLines: number;
  private readonly ttlMs: number;
  private readonly maxProcessesPerSession: number;
  private readonly now: () => number;

  constructor(private readonly options: CodeProcessManagerOptions = {}) {
    const positive = (value: number | undefined, fallback: number) => (Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback);
    this.logLines = positive(options.logLines, 2_000);
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
    if (this.runningForSession(input.sessionId).length >= this.maxProcessesPerSession) {
      throw new ProcessManagerError("process_limit", "Too many background processes for this session", 429, true);
    }
    if (input.leaseId) {
      if (!this.options.leases) throw new ProcessManagerError("secret_lease_unavailable", "Secret leases are not configured", 503, true);
      if (input.approved !== true) throw new ProcessManagerError("approval_required", "A background process that uses a secret requires its own approval", 403);
      if (!input.runId) throw new ProcessManagerError("invalid_command", "A background process that uses a secret must belong to a run (no session inheritance)", 400);
      // A lease issued for a foreground call must never be reused by a background process.
      this.options.leases.assertNotInherited(input.leaseId, input.leaseId);
    }
    const started = await this.options.sandbox.start({
      context, companyId: input.companyId, projectId: input.projectId, agentId: input.agentId ?? "code-process-manager",
      command: input.command, cwd: input.cwd, runId: input.runId, approved: input.approved === true, leaseId: input.leaseId,
    });
    const record: CodeProcessRecord = {
      processId: started.processId, sessionId: input.sessionId, companyId: input.companyId, projectId: input.projectId,
      commandDigest: digest(input.command), pid: started.pid, state: "running",
      startedAt: started.startedAt ?? this.now(), leaseId: input.leaseId, cursor: 0,
    };
    this.processes.set(record.processId, record);
    this.buffers.set(record.processId, []);
    await this.audit(context, input, "process.start", "allowed", { processId: record.processId, leaseId: input.leaseId ?? null });
    return { ...record };
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
    if (!buffer) return;
    for (const line of output.split("\n")) buffer.push(line);
    if (buffer.length > this.logLines) buffer.splice(0, buffer.length - this.logLines);
  }

  async logs(sessionId: string, processId: string, options: { offset?: number; limit?: number } = {}): Promise<{ lines: string[]; nextOffset: number; eof: boolean; total: number }> {
    const process = this.owned(sessionId, processId);
    const buffer = this.buffers.get(processId) ?? [];
    const offset = Math.max(0, Math.min(options.offset ?? 0, buffer.length));
    const limit = Math.max(1, Math.min(options.limit ?? 200, this.logLines));
    const lines = buffer.slice(offset, offset + limit);
    return { lines, nextOffset: offset + lines.length, eof: offset + lines.length >= buffer.length, total: buffer.length };
  }

  /** Refreshes the buffer from the sandbox and returns the newly available lines. */
  async fetchLogs(context: AuthContext, sessionId: string, processId: string, options: { limit?: number } = {}): Promise<{ lines: string[]; nextOffset: number; eof: boolean; total: number }> {
    const process = this.owned(sessionId, processId);
    if (!this.options.sandbox) throw new ProcessManagerError("sandbox_unavailable", "Sandbox process execution is unavailable", 503, true);
    const fetched = await this.options.sandbox.logs({ context, companyId: process.companyId, projectId: process.projectId, processId });
    this.appendOutput(processId, fetched.output ?? "");
    return this.logs(sessionId, processId, options);
  }

  async stop(context: AuthContext, sessionId: string, processId: string): Promise<CodeProcessRecord> {
    const process = this.owned(sessionId, processId);
    if (!this.options.sandbox) throw new ProcessManagerError("sandbox_unavailable", "Sandbox process execution is unavailable", 503, true);
    const result = await this.options.sandbox.stop({ context, companyId: process.companyId, projectId: process.projectId, processId });
    process.state = result.exitCode === 0 ? "stopped" : "failed";
    process.exitCode = result.exitCode;
    process.stoppedAt = this.now();
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
        // Best effort: a sandbox that already died still clears the local record.
        process.state = "failed";
        process.stoppedAt = this.now();
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
