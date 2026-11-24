import type { ProjectCheckpoint } from "@npati/workspace";
import type { AuthContext } from "@npati/workspace";
import type { ProjectFileError } from "./project-workspace";

/**
 * C3: checkpoint, approval, turn-scoped change tracking and diff support for write tools.
 *
 * This module is the *only* place where the write runtime meets the existing Website Builder
 * mechanisms. Nothing is re-implemented:
 *
 * - checkpoints come from `ProjectGitService.createCheckpoint` / `restoreCheckpoint`, which already
 *   commit the dirty worktree, tag `refs/npati/checkpoints/<id>` and take a mandatory pre-restore
 *   safety checkpoint;
 * - approvals come from `CompanyApprovalsRepository.requestApproval` / `consumeApproved`, which already
 *   verify the payload hash, the acting run/agent/tool and the TTL when the approval is consumed.
 *
 * The runtime only orchestrates them (when to take a checkpoint, when to demand an approval) and keeps
 * the per-turn change log that `code.fs.diff` and `undo_last_turn` read.
 */

/** The subset of `ProjectGitService` the write runtime needs (structural, so tests can fake it). */
export interface CodeCheckpointGitPort {
  readCheckpointFile?(ctx: AuthContext, companyId: string, projectId: string, checkpointId: string, path: string): Promise<{ content: string | null }>;
  createCheckpoint(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    input: { name: string; description?: string; trigger?: "manual" | "pre_run" | "post_run" | "pre_restore"; runId?: string },
  ): Promise<ProjectCheckpoint>;
  restoreCheckpoint(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    checkpointId: string,
    options?: { approved?: boolean },
  ): Promise<{ restoredCheckpoint: ProjectCheckpoint; backupCheckpoint: ProjectCheckpoint }>;
  diff?(ctx: AuthContext, companyId: string, projectId: string, options?: { file?: string; staged?: boolean }): Promise<{ diff: string }>;
  isLargeChange?(ctx: AuthContext, companyId: string, projectId: string): Promise<{ isLarge: boolean; changedFiles: number; changedLines: number }>;
}

export interface CodeTurnCheckpoint {
  checkpointId: string;
  commitHash?: string | null;
  createdAt: string;
  /** True when the checkpoint came from a run-level trigger rather than a tool turn. */
  automatic: boolean;
}

/** Approval port backed by the existing `CompanyApprovalsRepository`. */
export interface CodeApprovalPort {
  request(input: {
    ctx: AuthContext;
    companyId: string;
    runId?: string;
    agentId?: string;
    toolName: string;
    actionSummary: string;
    inputPayload: Record<string, unknown>;
    ttlMs?: number;
    riskLevel?: "low" | "medium" | "high" | "critical";
  }): Promise<{ approvalId: string; expiresAt?: string | null }>;
  /** Consumes an approved request; must throw when the payload, run, agent or tool do not match. */
  consume(input: {
    ctx: AuthContext;
    companyId: string;
    approvalId: string;
    runId: string;
    agentId: string;
    toolName: string;
    inputPayload: Record<string, unknown>;
  }): Promise<void>;
  /**
   * True when the person already approved (and the run used) a database change in this run or one of its repair
   * passes (`<runId>:qa-repair:<n>`). One approval then covers the run's further ordinary database changes, so a
   * single request does not ask again for every table, policy and seed row. Irreversible changes still ask.
   */
  approvedDataChangeInRun?(input: { ctx: AuthContext; companyId: string; runId: string }): Promise<boolean>;
}

export interface CodeWriteChange {
  path: string;
  tool: string;
  sha256: string | null;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  at: string;
}

export interface CodeTurnSummary {
  sessionId: string;
  turnId: string;
  checkpointId: string | null;
  changes: CodeWriteChange[];
  files: number;
  linesAdded: number;
  linesRemoved: number;
}

const DEFAULT_TURN_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_TURNS = 200;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveTurnTrackingOptions(env: NodeJS.ProcessEnv = process.env): { ttlMs: number; maxTurns: number } {
  return {
    ttlMs: positiveInt(env.NPATI_CODE_TURN_TTL_MS, DEFAULT_TURN_TTL_MS),
    maxTurns: positiveInt(env.NPATI_CODE_TURN_MAX, DEFAULT_MAX_TURNS),
  };
}

/**
 * A tiny line diff used only as a fallback when no canonical diff provider is injected.
 *
 * It trims the common prefix/suffix and reports the changed middle, which is enough for the per-turn
 * summary and for the audit metadata (`+/-` counts). The canonical `code-tools-diff.ts` provider, when
 * wired, is used instead.
 */
export function simpleUnifiedDiff(before: string, after: string, path: string, contextLines = 2): { diff: string; linesAdded: number; linesRemoved: number } {
  if (before === after) return { diff: "", linesAdded: 0, linesRemoved: 0 };
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) { endOld -= 1; endNew -= 1; }
  const from = Math.max(0, start - contextLines);
  const header = `--- a/${path}\n+++ b/${path}\n@@ -${start + 1},${Math.max(0, endOld - start)} +${start + 1},${Math.max(0, endNew - start)} @@`;
  const body: string[] = [];
  for (let index = from; index < start; index += 1) body.push(` ${oldLines[index] ?? ""}`);
  for (let index = start; index < endOld; index += 1) body.push(`-${oldLines[index] ?? ""}`);
  for (let index = start; index < endNew; index += 1) body.push(`+${newLines[index] ?? ""}`);
  const tail = Math.min(oldLines.length, endOld + contextLines);
  for (let index = endOld; index < tail; index += 1) body.push(` ${oldLines[index] ?? ""}`);
  const linesAdded = Math.max(0, endNew - start);
  const linesRemoved = Math.max(0, endOld - start);
  return { diff: `${header}\n${body.join("\n")}`, linesAdded, linesRemoved };
}

/**
 * In-process registry of per-turn checkpoints and changes. Like the C2 read tracker this is deliberately
 * not persisted: C6a decides whether the evidence must survive a restart or be shared between replicas.
 */
export class CodeTurnTracker {
  private readonly turns = new Map<string, { at: number; checkpoint: CodeTurnCheckpoint | null; changes: CodeWriteChange[] }>();
  private readonly ttlMs: number;
  private readonly maxTurns: number;

  constructor(options: { ttlMs?: number; maxTurns?: number } = {}) {
    const resolved = resolveTurnTrackingOptions();
    this.ttlMs = options.ttlMs ?? resolved.ttlMs;
    this.maxTurns = options.maxTurns ?? resolved.maxTurns;
  }

  /** Stable key: a turn is always scoped to its session, so two sessions never share a checkpoint. */
  key(sessionId: string, turnId: string): string { return `${sessionId}:${turnId}`; }

  getCheckpoint(sessionId: string, turnId: string): CodeTurnCheckpoint | null {
    const entry = this.prune(this.turns.get(this.key(sessionId, turnId)));
    return entry?.checkpoint ?? null;
  }

  setCheckpoint(sessionId: string, turnId: string, checkpoint: CodeTurnCheckpoint): void {
    const key = this.key(sessionId, turnId);
    const entry = this.turns.get(key) ?? { at: Date.now(), checkpoint: null, changes: [] };
    entry.checkpoint = checkpoint;
    entry.at = Date.now();
    this.turns.set(key, entry);
    this.evict();
  }

  recordChange(sessionId: string, turnId: string, change: CodeWriteChange): void {
    const key = this.key(sessionId, turnId);
    const entry = this.turns.get(key) ?? { at: Date.now(), checkpoint: null, changes: [] };
    entry.changes.push(change);
    entry.at = Date.now();
    this.turns.set(key, entry);
    this.evict();
  }

  listChanges(sessionId: string, turnId: string): CodeWriteChange[] {
    return [...(this.prune(this.turns.get(this.key(sessionId, turnId)))?.changes ?? [])];
  }

  summary(sessionId: string, turnId: string): CodeTurnSummary {
    const checkpoint = this.getCheckpoint(sessionId, turnId);
    const changes = this.listChanges(sessionId, turnId);
    return {
      sessionId, turnId, checkpointId: checkpoint?.checkpointId ?? null, changes,
      files: new Set(changes.map((change) => change.path)).size,
      linesAdded: changes.reduce((total, change) => total + change.linesAdded, 0),
      linesRemoved: changes.reduce((total, change) => total + change.linesRemoved, 0),
    };
  }

  /** Step 7: trusted write evidence of a dedicated child session across Continue turns. */
  sessionChanges(sessionId: string): CodeWriteChange[] {
    const merged = new Map<string, CodeWriteChange>();
    for (const [key, entry] of this.turns) {
      if (!key.startsWith(`${sessionId}:`) || !this.prune(entry)) continue;
      for (const change of entry.changes) merged.set(change.path, { ...change });
    }
    return [...merged.values()];
  }

  clear(sessionId?: string, turnId?: string): void {
    if (sessionId === undefined) { this.turns.clear(); return; }
    if (turnId === undefined) {
      for (const key of [...this.turns.keys()]) if (key.startsWith(`${sessionId}:`)) this.turns.delete(key);
      return;
    }
    this.turns.delete(this.key(sessionId, turnId));
  }

  private prune<T extends { at: number } | undefined>(entry: T): T {
    if (!entry) return entry;
    if (Date.now() - entry.at > this.ttlMs) return undefined as T;
    return entry;
  }

  private evict(): void {
    if (this.turns.size <= this.maxTurns) return;
    const ordered = [...this.turns.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of ordered.slice(0, this.turns.size - this.maxTurns)) this.turns.delete(key);
  }
}

/** What the write runtime needs from the existing checkpoint mechanism. */
export interface CodeCheckpointPort {
  readFile?(input: { ctx: AuthContext; companyId: string; projectId: string; checkpointId: string; path: string }): Promise<{ content: string | null }>;
  /** Creates a turn checkpoint before the first write of a turn (git-backed, commits dirty state). */
  create(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    sessionId: string;
    turnId: string;
    runId?: string;
    label?: string;
  }): Promise<{ checkpointId: string; commitHash?: string | null }>;
  /** Restores a checkpoint; the git service adds its own mandatory pre-restore safety checkpoint. */
  restore(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    checkpointId: string;
  }): Promise<{ restoredCheckpointId: string; backupCheckpointId?: string | null }>;
  /** Whole-workspace diff, when the git service is available (used when `turnOnly` is false). */
  diff?(input: { ctx: AuthContext; companyId: string; projectId: string; file?: string }): Promise<{ diff: string }>;
  /** Workspace change size, used for the bulk-change approval rule when a call carries no file list. */
  isLargeChange?(input: { ctx: AuthContext; companyId: string; projectId: string }): Promise<{ isLarge: boolean; changedFiles: number; changedLines: number }>;
}

/** Checkpoint port backed by the existing `ProjectGitService` (no new storage format). */
export function codeCheckpointPortFromGit(git: CodeCheckpointGitPort): CodeCheckpointPort {
  return {
    ...(git.readCheckpointFile ? { readFile: (input: { ctx: AuthContext; companyId: string; projectId: string; checkpointId: string; path: string }) => git.readCheckpointFile!(input.ctx, input.companyId, input.projectId, input.checkpointId, input.path) } : {}),
    async create(input) {
      const label = input.label ?? `Code agent turn ${input.turnId}`;
      const checkpoint = await git.createCheckpoint(input.ctx, input.companyId, input.projectId, {
        name: label,
        description: `Automatic checkpoint before the first write of turn ${input.turnId} (session ${input.sessionId.slice(0, 12)})`,
        trigger: "pre_run",
        ...(input.runId ? { runId: input.runId } : {}),
      });
      return { checkpointId: checkpoint.id, commitHash: checkpoint.commitHash ?? null };
    },
    async restore(input) {
      const result = await git.restoreCheckpoint(input.ctx, input.companyId, input.projectId, input.checkpointId, { approved: true });
      return {
        restoredCheckpointId: result.restoredCheckpoint.id,
        backupCheckpointId: result.backupCheckpoint?.id ?? null,
      };
    },
    ...(git.diff ? { diff: (input: { ctx: AuthContext; companyId: string; projectId: string; file?: string }) => git.diff!(input.ctx, input.companyId, input.projectId, input.file ? { file: input.file } : undefined) } : {}),
    ...(git.isLargeChange ? { isLargeChange: (input: { ctx: AuthContext; companyId: string; projectId: string }) => git.isLargeChange!(input.ctx, input.companyId, input.projectId) } : {}),
  };
}

/** Approval port backed by the existing `CompanyApprovalsRepository`. */
export function approvalsBackedPort(repo: {
  requestApproval(ctx: AuthContext, companyId: string, input: {
    runId?: string; agentId?: string; toolName: string; riskLevel?: string; actionSummary: string;
    inputPayload?: Record<string, unknown>; ttlMs?: number;
  }): Promise<{ id: string; expiresAt?: string | null }>;
  consumeApproved(ctx: AuthContext, companyId: string, id: string, params: {
    runId: string; agentId: string; toolName: string; inputPayload: Record<string, unknown>;
  }): Promise<unknown>;
  hasApprovedDataChangeInRun?(ctx: AuthContext, companyId: string, runId: string): Promise<boolean>;
}, options: { defaultTtlMs?: number } = {}): CodeApprovalPort {
  const ttlMs = options.defaultTtlMs ?? positiveInt(process.env.NPATI_CODE_APPROVAL_TTL_MS, 30 * 60 * 1000);
  return {
    async request(input) {
      const created = await repo.requestApproval(input.ctx, input.companyId, {
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        toolName: input.toolName,
        ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}),
        actionSummary: input.actionSummary,
        inputPayload: input.inputPayload,
        ttlMs: input.ttlMs ?? ttlMs,
      });
      return { approvalId: created.id, expiresAt: created.expiresAt ?? null };
    },
    async consume(input) {
      await repo.consumeApproved(input.ctx, input.companyId, input.approvalId, {
        runId: input.runId, agentId: input.agentId, toolName: input.toolName, inputPayload: input.inputPayload,
      });
    },
    ...(repo.hasApprovedDataChangeInRun ? {
      approvedDataChangeInRun: (input: { ctx: AuthContext; companyId: string; runId: string }) =>
        repo.hasApprovedDataChangeInRun!(input.ctx, input.companyId, input.runId),
    } : {}),
  };
}

/**
 * Turns a `ProjectFileError` (workspace revision control) into the structured shape the runtime
 * reports: the current revision travels in `details` so the model can re-read and retry.
 */
export function revisionConflictDetails(error: unknown): { code: string; currentRevision: string | null; status: number } | null {
  const shaped = error as Partial<ProjectFileError> & { code?: string; status?: number; currentRevision?: string };
  if (!shaped || shaped.code !== "revision_conflict") return null;
  return { code: "revision_conflict", currentRevision: shaped.currentRevision ?? null, status: shaped.status ?? 409 };
}

/** Extracts `path`, `sha256` and diff statistics from whatever a write executor returned. */
export function extractWriteChange(tool: string, raw: unknown): Omit<CodeWriteChange, "at"> | null {
  const changes = extractWriteChanges(tool, raw);
  return changes[0] ?? null;
}

/**
 * Plural form: a patch may touch several files, and every one of them belongs in the turn log, in the
 * turn-scoped diff and in the audit metadata. Only paths, hashes and diff statistics are read from the
 * executor result — never the file content.
 */
export function extractWriteChanges(tool: string, raw: unknown): Array<Omit<CodeWriteChange, "at">> {
  if (!raw || typeof raw !== "object") return [];
  const envelope = raw as { data?: unknown; path?: unknown; sha256?: unknown };
  const data = (envelope.data && typeof envelope.data === "object" ? envelope.data : envelope) as Record<string, unknown>;
  const numberValue = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  // A dry run changes nothing, so it must not enter the turn's change log (and therefore not the diff).
  if (data.dryRun === true) return [];
  if (tool === "code.fs.write" && data.created === false && data.diff === "") return [];
  // The canonical patch engine reports per-file results as `applied[]`, together with the action taken.
  const entries = Array.isArray(data.files) ? data.files : Array.isArray(data.applied) ? data.applied : null;
  if (entries) {
    const changes: Array<Omit<CodeWriteChange, "at">> = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const path = typeof item.path === "string" ? item.path : null;
      if (!path) continue;
      changes.push({
        path,
        tool,
        sha256: typeof item.sha256 === "string" ? item.sha256 : null,
        linesAdded: numberValue(item.linesAdded),
        linesRemoved: numberValue(item.linesRemoved),
        diff: typeof item.diff === "string" ? item.diff : "",
      });
    }
    if (changes.length) return changes;
  }
  const path = typeof data.path === "string" ? data.path : typeof envelope.path === "string" ? envelope.path : null;
  if (!path) return [];
  return [{
    path,
    tool,
    sha256: typeof data.sha256 === "string" ? data.sha256 : typeof envelope.sha256 === "string" ? envelope.sha256 : null,
    linesAdded: numberValue(data.linesAdded),
    linesRemoved: numberValue(data.linesRemoved),
    diff: typeof data.diff === "string" ? data.diff : "",
  }];
}
