import { createHash } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import { resolveCodeAgentLimits, type CodeAgentLimits } from "./code-agent-config";
import { CODE_TOOL_SCHEMAS, currentToolManifest, type CodeToolSchema } from "./code-tool-registry";
import type { FeatureFlagService } from "./feature-flags";
import { CODE_AGENT_MASTER_FLAG } from "./feature-flags";
import type { AuditLogService } from "./audit-log";
import { ReadTracker, resolveReadTrackerOptions, type ReadRecord } from "./code-read-tracker";
import { CodeToolError as CanonicalCodeToolError, normalizeWorkspacePath } from "./code-tools-path";
import { decideSensitiveRead, isSensitivePath, resolveSensitivePolicy } from "./code-tools-sensitive";
import { wrapToolResult } from "./code-tools-fs";
import {
  CODE_WRITE_TOOLS, buildApprovalPayload, requiresApproval, resolveApprovalPolicy, type CodeApprovalPolicy,
} from "./code-edit-approval";
import {
  CodeTurnTracker, extractWriteChanges, resolveTurnTrackingOptions, revisionConflictDetails, simpleUnifiedDiff,
  type CodeApprovalPort, type CodeCheckpointPort, type CodeWriteChange,
} from "./code-workspace-checkpoint";

/**
 * C2: the runtime that executes read-only `code.*` tools.
 *
 * All pure tool logic lives in `code-tools-*.ts` and this runtime delegates to it: path safety comes
 * from `normalizeWorkspacePath`, the sensitive-file policy from `decideSensitiveRead`, the untrusted
 * data envelope from `wrapToolResult`, and the tool bodies from `canonicalExecutors()`
 * (`code-tool-executors.ts`). There are no second implementations here on purpose — if a canonical
 * function is not wired in, a call fails closed with `tool_not_configured` instead of falling back to
 * a lookalike policy.
 *
 * Nothing here ever executes project code on the NPATI host: `listDir` and `readFile` go through the
 * existing `ProjectWorkspace` file API, while text search (`runSearch`) requires a sandbox execution
 * port and otherwise fails with `sandbox_unavailable`.
 */

export type CodeToolErrorCode =
  | "feature_disabled"
  | "company_access_denied"
  | "unknown_tool"
  | "unknown_tool_version"
  | "tool_deprecated"
  | "invalid_arguments"
  | "invalid_path"
  | "path_outside_workspace"
  | "symlink_escape"
  | "null_byte"
  | "sensitive_file_denied"
  | "sandbox_unavailable"
  | "limit_exceeded"
  | "workspace_error"
  | "tool_not_configured"
  | "project_not_found"
  | "not_a_file"
  | "not_a_directory"
  | "too_large"
  | "read_failed"
  | "search_failed"
  | "invalid_argument"
  | "tool_failed"
  // C3: write path
  | "read_before_write_required"
  | "revision_conflict"
  | "revision_conflict_exhausted"
  | "checkpoint_unavailable"
  | "checkpoint_not_found"
  | "approval_required"
  | "approval_invalid"
  | "approval_unavailable"
  | "write_failed"
  | "delete_failed"
  | "move_failed"
  | "write_unavailable"
  | "edit_no_match"
  | "edit_ambiguous"
  | "patch_conflict";

/** Codes thrown by the canonical modules; they are mapped onto the runtime's failure shape. */
const CANONICAL_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "invalid_path", "path_outside_workspace", "null_byte", "symlink_escape", "sensitive_file_denied",
  "not_a_file", "not_a_directory", "too_large", "read_failed", "search_failed", "invalid_argument",
  "sandbox_unavailable", "tool_not_configured", "project_not_found",
  "read_before_write_required", "revision_conflict", "revision_conflict_exhausted",
  "checkpoint_unavailable", "checkpoint_not_found", "approval_required", "approval_invalid",
  "approval_unavailable", "write_failed", "delete_failed", "move_failed", "write_unavailable",
  "edit_no_match", "edit_ambiguous", "patch_conflict",
]);

/** Recognises a canonical `CodeToolError` (different class, same contract) by shape. */
function canonicalFailure(error: unknown): { code: CodeToolErrorCode; status: number; message: string; tool?: string; step?: string; retryable: boolean } | null {
  if (error instanceof CanonicalCodeToolError) {
    const shaped = error as CanonicalCodeToolError & { httpStatus?: number };
    return {
      code: error.code as CodeToolErrorCode,
      status: shaped.httpStatus ?? 400,
      message: error.message,
      tool: error.tool,
      step: error.step,
      retryable: error.retryable === true,
    };
  }
  const shaped = error as { code?: unknown; httpStatus?: unknown; status?: unknown; message?: unknown; tool?: unknown; step?: unknown; retryable?: unknown };
  if (shaped && typeof shaped.code === "string" && CANONICAL_ERROR_CODES.has(shaped.code)) {
    return {
      code: shaped.code as CodeToolErrorCode,
      // Structured port errors carry either `httpStatus` (canonical) or a numeric `status` (runtime-shaped).
      status: typeof shaped.httpStatus === "number" ? shaped.httpStatus : (typeof shaped.status === "number" ? shaped.status : 400),
      message: typeof shaped.message === "string" ? shaped.message : "Tool error",
      tool: typeof shaped.tool === "string" ? shaped.tool : undefined,
      step: typeof shaped.step === "string" ? shaped.step : undefined,
      retryable: shaped.retryable === true,
    };
  }
  return null;
}

export class CodeToolError extends Error {
  constructor(
    public readonly code: CodeToolErrorCode,
    message: string,
    public readonly status = 400,
    public readonly step = "validate",
    public readonly retryable = false,
    public readonly tool?: string,
    /** Structured context (current revision, approval id, reason); never file content or secrets. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CodeToolError";
  }

  toJSON() {
    return { code: this.code, status: this.status, message: this.message, step: this.step, retryable: this.retryable, tool: this.tool ?? null, details: this.details ?? null };
  }
}

export interface CodeToolInvokeResult {
  ok: true;
  tool: string;
  toolVersion: number;
  schemaVersion: number;
  result: unknown;
  truncated: boolean;
  durationMs: number;
  cached?: boolean;
}

export interface CodeToolInvokeFailure {
  ok: false;
  error: {
    code: CodeToolErrorCode;
    status: number;
    message: string;
    tool: string | null;
    step: string;
    retryable: boolean;
    /** Structured context for the caller: current revision, approval id, checkpoint id, reason. */
    details?: Record<string, unknown>;
  };
}

export interface CodeToolExecutionContext {
  ctx: AuthContext;
  companyId: string;
  projectId: string;
  sessionId?: string;
  /** C3: the turn this call belongs to, so executors can scope their output to it. */
  turnId?: string;
  tool: CodeToolSchema;
  args: Record<string, unknown>;
  limits: CodeAgentLimits;
  port: CodeReadPort;
  /**
   * Canonical guard hooks for executors that take raw paths: `path` normalises and rejects traversal,
   * `sensitive` applies the sensitive-file policy. Both delegate to `code-tools-*.ts`.
   */
  guards?: { path(raw: unknown): string; sensitive(path: string): string };
  /** C3: changes already made in this turn (path, hash, diff stats) — no file contents. */
  turnChanges?: readonly { path: string; tool: string; sha256: string | null; linesAdded: number; linesRemoved: number }[];
  /** C3: revisions recorded by the read tracker for the paths this call touches (lost-update guard). */
  expectedRevisions?: Readonly<Record<string, string>>;
  /** C3: write port. Absent means this deployment cannot apply changes (executors fail closed). */
  writePort?: CodeWritePort;
  /**
   * C3: true when the runtime granted (or did not need) approval for this call. Executors pass it to
   * the canonical write engine, which only allows a `.git`/sensitive/recursive/mass change with it.
   */
  approved?: boolean;
}

/**
 * Read port implemented by `createProjectWorkspaceReadPort` (workspace files + sandbox search).
 *
 * The optional fields are contracts the canonical port uses when an implementation supports them; an
 * implementation that ignores them keeps working, and `code-tool-executors.ts` derives the grep modes
 * from line matches in that case.
 */
export interface CodeReadPort {
  listDir(input: { ctx: AuthContext; companyId: string; projectId: string; path: string; depth?: number; limit?: number }): Promise<{ entries: Array<{ path: string; type: "file" | "directory"; size?: number; mtimeMs?: number | null; target?: string | null }> }>;
  readFile(input: { ctx: AuthContext; companyId: string; projectId: string; path: string; startLine?: number; endLine?: number; maxLines: number; maxBytes: number }): Promise<{ path: string; content: string; revision: string; sha256: string; totalLines: number; truncated: boolean; encoding?: string; binary?: boolean; mimeGuess?: string | null }>;
  runSearch(input: { ctx: AuthContext; companyId: string; projectId: string; query: string; path?: string; maxResults: number; timeoutMs: number; glob?: string; type?: string; ignoreCase?: boolean; fixedStrings?: boolean; contextLines?: number }): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean; engine?: "ripgrep" | "fallback" }>;
}

/** Minimal sandbox execution port (satisfied by `ProjectSandboxService.execute`). */
export interface SandboxExecPort {
  execute(ctx: AuthContext, companyId: string, request: { projectId: string; command: string; cwd?: string; timeoutMs?: number }): Promise<{ stdout?: string; output?: string; exitCode?: number }>;
}

/**
 * C3: the write half of the workspace port. Implemented by `createProjectWorkspaceWritePort`, which
 * delegates to the existing `ProjectWorkspace` file API — every write carries the revision the caller
 * read, so the workspace itself refuses a lost update with `revision_conflict`.
 */
export interface CodeWritePort {
  writeFile(input: { ctx: AuthContext; companyId: string; projectId: string; path: string; content: string; expectedRevision: string }): Promise<{ path: string; revision: string; sha256: string }>;
  createFile(input: { ctx: AuthContext; companyId: string; projectId: string; path: string; content: string }): Promise<{ path: string; revision: string; sha256: string }>;
  editFile(input: { ctx: AuthContext; companyId: string; projectId: string; path: string; find: string; replacement: string; expectedRevision: string }): Promise<{ path: string; revision: string; sha256: string }>;
  moveFile(input: { ctx: AuthContext; companyId: string; projectId: string; from: string; to: string; expectedRevision: string }): Promise<{ path: string; revision: string; sha256: string }>;
  deleteFile(input: { ctx: AuthContext; companyId: string; projectId: string; path: string }): Promise<void>;
}

export interface CodeToolActivityEvent {
  companyId: string;
  projectId: string;
  sessionId?: string;
  tool: string;
  toolVersion: number;
  schemaVersion: number;
  durationMs: number;
  bytes: number;
  truncated: boolean;
  ok: boolean;
  errorCode?: string;
}

export interface CodeToolRuntimeOptions {
  flags?: FeatureFlagService;
  /** Ownership check (step 1): satisfy with the workspace store used by the code routes. */
  store?: { getCompany(ctx: AuthContext, companyId: string): Promise<unknown> };
  audit?: AuditLogService;
  tracker?: ReadTracker;
  limits?: Partial<CodeAgentLimits>;
  /** Tool schemas; defaults to the published registry (`code-tool-registry.ts`). */
  schemas?: readonly CodeToolSchema[];
  /**
   * Tool bodies. Defaults to none: a tool without a configured executor fails closed with
   * `tool_not_configured`. Applications wire `canonicalExecutors()` from `code-tool-executors.ts`.
   */
  executors?: Record<string, (input: CodeToolExecutionContext) => Promise<unknown>>;
  activity?: { record(event: CodeToolActivityEvent): Promise<void> };
  toPort?: (projectId: string) => CodeReadPort;
  /** Adapter hooks for the C2 tool modules; the defaults are intentionally strict. */
  pathGuard?: (rawPath: unknown) => string;
  sensitiveGuard?: (path: string) => void;
  wrap?: (tool: string, payload: unknown) => unknown;
  /** Idempotency window for `toolCallId`; defaults to the read-tracking TTL. */
  idempotencyTtlMs?: number;
  // --- C3: write path -------------------------------------------------------------------------
  /** Existing Website Builder checkpoint mechanism (`ProjectGitService`); absent → writes refuse. */
  checkpoints?: CodeCheckpointPort;
  /** Existing approval system (`CompanyApprovalsRepository`); absent → approvals refuse. */
  approvals?: CodeApprovalPort;
  /** Per-turn checkpoint and change log (in-process; C6a decides persistence). */
  turns?: CodeTurnTracker;
  /** C3: write port (`createProjectWorkspaceWritePort`). Absent means changes cannot be applied. */
  writePort?: CodeWritePort;
  /** Overrides the write-tool classification (`code-edit-approval.ts` is the default). */
  writeTools?: ReadonlySet<string>;
  approvalPolicy?: CodeApprovalPolicy;
  /** Revision retries allowed per `(session, path)` before `revision_conflict_exhausted`. Default 2. */
  maxRevisionRetries?: number;
  /** Canonical diff provider; the fallback is a bounded prefix/suffix diff (`simpleUnifiedDiff`). */
  diffProvider?: (input: { path: string; before: string; after: string }) => { diff: string; linesAdded: number; linesRemoved: number } | null;
  /** Non-blocking post-write hooks (formatter, syntax check); results are warnings, never failures. */
  postWriteHooks?: {
    format?(input: { ctx: AuthContext; companyId: string; projectId: string; paths: string[] }): Promise<string[] | void>;
    checkSyntax?(input: { ctx: AuthContext; companyId: string; projectId: string; paths: string[] }): Promise<string[] | void>;
  };
}

/** True when a path is denied by the canonical sensitive-file policy (single source of truth). */
export function isSensitiveWorkspacePath(path: string): boolean {
  return isSensitivePath(path);
}

/**
 * Workspace-relative path validation: delegates to the canonical `normalizeWorkspacePath`, so this
 * module can never drift from the policy the tool implementations use.
 */
export function assertSafeWorkspacePath(rawPath: unknown): string {
  return normalizeWorkspacePath(rawPath, { tool: "code.tool", allowEmpty: false });
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Every tool payload is data, never instructions (rule: file content is DATA). */
export function wrapUntrustedResult(tool: string, payload: unknown): unknown {
  return wrapToolResult(tool, payload);
}

/** Minimal JSON Schema validation: enough for the tool contracts, no new dependencies. */
export function validateArguments(schema: Record<string, unknown>, args: unknown): Record<string, unknown> {
  if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
    throw new CodeToolError("invalid_arguments", "Arguments must be an object", 400);
  }
  const value = (args ?? {}) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  for (const key of required) {
    if (value[key] === undefined) throw new CodeToolError("invalid_arguments", `Missing required argument: ${key}`, 400);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) throw new CodeToolError("invalid_arguments", `Unknown argument: ${key}`, 400);
    }
  }
  for (const [key, raw] of Object.entries(value)) {
    const rule = properties[key];
    if (!rule) continue;
    if (raw === undefined || raw === null) {
      if (required.includes(key)) throw new CodeToolError("invalid_arguments", `Argument ${key} must not be null`, 400);
      continue;
    }
    const type = rule.type as string | undefined;
    if (type === "string" && typeof raw !== "string") throw new CodeToolError("invalid_arguments", `Argument ${key} must be a string`, 400);
    if (type === "number" && typeof raw !== "number") throw new CodeToolError("invalid_arguments", `Argument ${key} must be a number`, 400);
    if (type === "integer" && (!Number.isInteger(raw))) throw new CodeToolError("invalid_arguments", `Argument ${key} must be an integer`, 400);
    if (type === "boolean" && typeof raw !== "boolean") throw new CodeToolError("invalid_arguments", `Argument ${key} must be a boolean`, 400);
    if (type === "array" && !Array.isArray(raw)) throw new CodeToolError("invalid_arguments", `Argument ${key} must be an array`, 400);
    if (Array.isArray(rule.enum) && !(rule.enum as unknown[]).includes(raw)) {
      throw new CodeToolError("invalid_arguments", `Argument ${key} must be one of: ${(rule.enum as unknown[]).join(", ")}`, 400);
    }
    if (typeof raw === "string") {
      if (typeof rule.maxLength === "number" && raw.length > rule.maxLength) throw new CodeToolError("invalid_arguments", `Argument ${key} exceeds maxLength`, 400);
      if (typeof rule.minLength === "number" && raw.length < rule.minLength) throw new CodeToolError("invalid_arguments", `Argument ${key} is shorter than minLength`, 400);
      if (typeof rule.pattern === "string" && !new RegExp(rule.pattern).test(raw)) throw new CodeToolError("invalid_arguments", `Argument ${key} does not match the expected pattern`, 400);
    }
    if (typeof raw === "number") {
      if (typeof rule.maximum === "number" && raw > rule.maximum) throw new CodeToolError("invalid_arguments", `Argument ${key} exceeds the maximum`, 400);
      if (typeof rule.minimum === "number" && raw < rule.minimum) throw new CodeToolError("invalid_arguments", `Argument ${key} is below the minimum`, 400);
    }
    if (Array.isArray(raw) && rule.items) {
      const items = rule.items as Record<string, unknown>;
      for (const item of raw) {
        if (items.type === "string" && typeof item !== "string") throw new CodeToolError("invalid_arguments", `Argument ${key} must contain strings only`, 400);
      }
    }
  }
  return value;
}

/**
 * Default read port: directory listing and file reads use the sanctioned workspace API, text search
 * needs the sandbox (`rg`), because no project code may run on the NPATI host.
 */
export function createProjectWorkspaceReadPort(
  workspace: { getFileTree(ctx: AuthContext, companyId: string, projectId: string): Promise<Array<{ path: string; type: string; size?: number }>>; readFile(ctx: AuthContext, companyId: string, projectId: string, path: string): Promise<{ path: string; content: string; size: number; revision: string }> },
  sandbox?: SandboxExecPort,
): CodeReadPort {
  return {
    async listDir({ ctx, companyId, projectId, path, limit }) {
      const entries = await workspace.getFileTree(ctx, companyId, projectId);
      const prefix = path && path !== "." ? `${path.replace(/\/$/, "")}/` : "";
      const filtered = entries
        .filter((entry) => entry.path.startsWith(prefix))
        .filter((entry) => {
          const rest = entry.path.slice(prefix.length);
          return rest.length > 0 && !rest.includes("/");
        })
        .map((entry) => ({ path: entry.path, type: entry.type === "directory" ? "directory" as const : "file" as const, size: entry.size }));
      return { entries: typeof limit === "number" ? filtered.slice(0, limit) : filtered };
    },
    async readFile({ ctx, companyId, projectId, path, startLine, endLine, maxLines, maxBytes }) {
      const file = await workspace.readFile(ctx, companyId, projectId, path);
      const content = file.content ?? "";
      const lines = content.split("\n");
      const from = Math.max(0, (startLine ?? 1) - 1);
      const to = endLine ? Math.min(lines.length, endLine) : lines.length;
      let body = lines.slice(from, to);
      let truncated = false;
      if (body.length > maxLines) { body = body.slice(0, maxLines); truncated = true; }
      let text = body.join("\n");
      if (Buffer.byteLength(text, "utf8") > maxBytes) {
        text = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
        truncated = true;
      }
      return { path: file.path, content: text, revision: file.revision, sha256: sha256Hex(content), totalLines: lines.length, truncated };
    },
    async runSearch({ ctx, companyId, projectId, query, path, maxResults, timeoutMs }) {
      if (!sandbox) {
        throw new CodeToolError("sandbox_unavailable", "Text search requires the sandbox runner; it is not available in this deployment", 503, "execute", true);
      }
      const target = path && path !== "." ? `./${path}` : ".";
      const escaped = query.replace(/'/g, "'\\''");
      const result = await sandbox.execute(ctx, companyId, {
        projectId,
        command: `rg --line-number --no-heading --color=never --max-count ${maxResults} -e '${escaped}' ${target}`,
        timeoutMs,
      });
      const stdout = result.stdout ?? result.output ?? "";
      const matches = stdout.split("\n").filter(Boolean).slice(0, maxResults).map((line) => {
        const [file, lineNumber, ...rest] = line.split(":");
        return { path: file ?? "", line: Number.parseInt(lineNumber ?? "0", 10) || 0, text: rest.join(":").slice(0, 500) };
      });
      return { matches, truncated: matches.length >= maxResults };
    },
  };
}

/**
 * C3: write port over the existing `ProjectWorkspace` file API.
 *
 * Every call passes the revision the caller read (`expected_revision`), so the workspace itself is the
 * authority on lost updates: it answers `revision_conflict` with the current revision, which the runtime
 * turns into a structured retryable error. Creating a file is a separate path (`createFile`) because a
 * new file has no revision to match.
 */
export function createProjectWorkspaceWritePort(
  workspace: {
    writeFile(ctx: AuthContext, companyId: string, projectId: string, path: string, content: string, expectedRevision: string): Promise<{ path: string; revision: string }>;
    createFile(ctx: AuthContext, companyId: string, projectId: string, path: string, content: string): Promise<{ path: string; revision: string }>;
    editFile(ctx: AuthContext, companyId: string, projectId: string, path: string, find: string, replacement: string, expectedRevision: string): Promise<{ path: string; revision: string }>;
    moveFile(ctx: AuthContext, companyId: string, projectId: string, from: string, to: string, expectedRevision: string): Promise<{ path: string; revision: string }>;
    deleteFile(ctx: AuthContext, companyId: string, projectId: string, path: string): Promise<void>;
  },
): CodeWritePort {
  const hashed = (file: { path: string; revision: string }) => ({ path: file.path, revision: file.revision, sha256: file.revision });
  return {
    async writeFile(input) {
      return hashed(await workspace.writeFile(input.ctx, input.companyId, input.projectId, input.path, input.content, input.expectedRevision));
    },
    async createFile(input) {
      return hashed(await workspace.createFile(input.ctx, input.companyId, input.projectId, input.path, input.content));
    },
    async editFile(input) {
      return hashed(await workspace.editFile(input.ctx, input.companyId, input.projectId, input.path, input.find, input.replacement, input.expectedRevision));
    },
    async moveFile(input) {
      return hashed(await workspace.moveFile(input.ctx, input.companyId, input.projectId, input.from, input.to, input.expectedRevision));
    },
    async deleteFile(input) {
      await workspace.deleteFile(input.ctx, input.companyId, input.projectId, input.path);
    },
  };
}

export class CodeToolRuntime {
  private readonly limits: CodeAgentLimits;
  private readonly schemas: readonly CodeToolSchema[];
  private readonly tracker: ReadTracker;
  private readonly idempotency = new Map<string, { at: number; result: CodeToolInvokeResult }>();
  private readonly idempotencyTtlMs: number;
  private readonly executors: Record<string, (input: CodeToolExecutionContext) => Promise<unknown>>;
  private readonly writeTools: ReadonlySet<string>;
  private readonly approvalPolicy: CodeApprovalPolicy;
  private readonly turns: CodeTurnTracker;
  private readonly maxRevisionRetries: number;
  /** Revision-conflict attempts per `(session, path)`; a success resets the counter. */
  private readonly revisionAttempts = new Map<string, number>();

  constructor(private readonly options: CodeToolRuntimeOptions = {}) {
    this.limits = { ...resolveCodeAgentLimits(), ...options.limits };
    this.schemas = options.schemas ?? CODE_TOOL_SCHEMAS;
    this.tracker = options.tracker ?? new ReadTracker(resolveReadTrackerOptions());
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? resolveReadTrackerOptions().ttlMs;
    this.executors = options.executors ?? {};
    this.writeTools = options.writeTools ?? CODE_WRITE_TOOLS;
    this.approvalPolicy = options.approvalPolicy ?? resolveApprovalPolicy();
    this.turns = options.turns ?? new CodeTurnTracker(resolveTurnTrackingOptions());
    this.maxRevisionRetries = options.maxRevisionRetries ?? 2;
  }

  get readTracker(): ReadTracker { return this.tracker; }
  get turnTracker(): CodeTurnTracker { return this.turns; }

  /** True when the tool mutates the workspace and therefore needs `code.write` plus the C3 gates. */
  isWriteTool(tool: string): boolean {
    return this.writeTools.has(tool);
  }

  /** Turn-scoped summary used by `code.fs.diff` and by `GET …/code/diff`. */
  turnSummary(sessionId: string, turnId: string) {
    return this.turns.summary(sessionId, turnId);
  }

  /**
   * Public undo entry point used by `POST …/code/undo-last-turn`. It enforces the same flags as a tool
   * call (master + `code.write`), restores the turn checkpoint and records the action; it never touches
   * the workspace when the turn has no checkpoint.
   */
  async undoTurn(ctx: AuthContext, input: { companyId: string; projectId: string; sessionId?: string; turnId?: string; runId?: string; toolCallId?: string }): Promise<CodeToolInvokeResult | CodeToolInvokeFailure> {
    const started = Date.now();
    const sessionId = input.sessionId ?? `project:${input.projectId}`;
    const turnId = input.turnId ?? `auto-${new Date().toISOString().slice(0, 13)}`;
    try {
      if (this.options.store) {
        try { await this.options.store.getCompany(ctx, input.companyId); }
        catch { throw new CodeToolError("company_access_denied", "Company is not available to this user", 403, "authorize", false, "code.fs.undo_last_turn"); }
      }
      if (!this.options.flags) throw new CodeToolError("feature_disabled", "Coding Agent is unavailable: feature flags are not configured", 403, "flags", false, "code.fs.undo_last_turn");
      await this.options.flags.assertEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId: input.companyId, userId: ctx.userId });
      await this.options.flags.assertEnabled(ctx, "code.write", { companyId: input.companyId, userId: ctx.userId });
      const checkpointId = await this.restoreTurn(ctx, { companyId: input.companyId, projectId: input.projectId, sessionId, turnId, tool: "code.fs.undo_last_turn" });
      const result: CodeToolInvokeResult = {
        ok: true, tool: "code.fs.undo_last_turn", toolVersion: 1, schemaVersion: 1,
        result: this.wrap("code.fs.undo_last_turn", { restored: true, checkpointId, turnId }),
        truncated: false, durationMs: Date.now() - started,
      };
      await this.recordAudit(ctx, { companyId: input.companyId, projectId: input.projectId, sessionId, tool: "code.fs.undo_last_turn", toolCallId: input.toolCallId ?? `undo-${turnId}` }, undefined, "allowed", undefined, { checkpointId, turnId, action: "undo_last_turn" });
      return result;
    } catch (error) {
      return this.toFailure(error, "code.fs.undo_last_turn");
    }
  }

  listTools() {
    return this.schemas.map((tool) => ({
      name: tool.name, version: tool.version, status: tool.status, description: tool.description,
      deprecatedAt: tool.deprecatedAt ?? null,
      write: this.isWriteTool(tool.name),
      limits: (tool as { limits?: Record<string, unknown> }).limits ?? null,
    }));
  }

  listReads(sessionId: string): ReadRecord[] {
    return this.tracker.list(sessionId);
  }

  /**
   * Single entry point for every `code.*` tool call. The check order is fixed and each step is a hard
   * gate: ownership, master flag, tool resolution, sub-flag (`code.write` for mutating tools),
   * argument validation, idempotency, write pre-flight (read-before-write, approval, turn checkpoint),
   * execution, data wrapping, per-turn change log, Activity and audit.
   */
  async invoke(ctx: AuthContext, input: {
    companyId: string; projectId: string; sessionId?: string; tool: string; toolVersion?: number;
    args?: unknown; toolCallId: string;
    /** C3: turn the call belongs to (defaults to a per-hour bucket so a call without one is still safe). */
    turnId?: string;
    /** C3: an approval obtained for this exact payload; consumed before the change is applied. */
    approvalId?: string;
    /** C3: existing run/agent identity, required by the approval system when consuming. */
    runId?: string; agentId?: string;
  }): Promise<CodeToolInvokeResult | CodeToolInvokeFailure> {
    const started = Date.now();
    const sessionId = input.sessionId ?? `project:${input.projectId}`;
    const turnId = input.turnId ?? `auto-${new Date().toISOString().slice(0, 13)}`;
    let turnChanges: CodeWriteChange[] = [];
    try {
      // (1) Tenant isolation: the company must belong to the caller's workspace and user.
      if (this.options.store) {
        try {
          await this.options.store.getCompany(ctx, input.companyId);
        } catch {
          throw new CodeToolError("company_access_denied", "Company is not available to this user", 403, "authorize", false, input.tool);
        }
      }

      // (2) Feature flags: the master kill switch gates everything, deny by default when unconfigured.
      if (!this.options.flags) throw new CodeToolError("feature_disabled", "Coding Agent is unavailable: feature flags are not configured", 403, "flags", false, input.tool);
      await this.options.flags.assertEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId: input.companyId, userId: ctx.userId });

      // (3) Tool resolution and version pinning.
      const candidates = this.schemas.filter((tool) => tool.name === input.tool);
      if (!candidates.length) throw new CodeToolError("unknown_tool", `Unknown tool: ${input.tool}`, 404, "resolve", false, input.tool);
      const tool = input.toolVersion === undefined
        ? candidates.find((candidate) => candidate.status === "active") ?? candidates[0]!
        : candidates.find((candidate) => candidate.version === input.toolVersion);
      if (!tool) throw new CodeToolError("unknown_tool_version", `Unknown version ${input.toolVersion} for ${input.tool}`, 404, "resolve", false, input.tool);
      if (tool.status !== "active") throw new CodeToolError("tool_deprecated", `Tool ${input.tool}@${tool.version} is deprecated`, 409, "resolve", false, input.tool);

      // (4) Sub-flag: mutating tools require `code.write`, read-only tools `code.read`.
      const write = this.isWriteTool(tool.name);
      await this.options.flags.assertEnabled(ctx, write ? "code.write" : "code.read", { companyId: input.companyId, userId: ctx.userId });

      // (5) Arguments.
      const args = validateArguments(tool.inputSchema, input.args);
      if (tool.name === "code.fs.undo_last_turn" && args.confirm !== true) {
        throw new CodeToolError("invalid_arguments", "code.fs.undo_last_turn requires confirm: true", 400, "validate_arguments", false, tool.name);
      }

      // (6) Idempotency: the same (session, toolCallId) never executes twice.
      const cacheKey = `${sessionId}:${input.toolCallId}`;
      const cached = this.idempotency.get(cacheKey);
      if (cached && Date.now() - cached.at <= this.idempotencyTtlMs) {
        return { ...cached.result, cached: true };
      }

      // (7) Write pre-flight: read-before-write, approval and the per-turn checkpoint. All three run
      // before the executor, so a refused change never reaches the workspace.
      let checkpointId: string | null = null;
      let writeTargets: Array<{ path: string; exists: boolean }> = [];
      let approved = false;
      if (write) {
        if (tool.name === "code.fs.undo_last_turn") {
          // Undo restores the turn checkpoint and returns immediately; it never reaches an executor.
          const restoredCheckpointId = await this.restoreTurn(ctx, { companyId: input.companyId, projectId: input.projectId, sessionId, turnId, tool: tool.name });
          const payload = { restored: true, checkpointId: restoredCheckpointId, turnId };
          const result: CodeToolInvokeResult = {
            ok: true, tool: tool.name, toolVersion: tool.version, schemaVersion: tool.version,
            result: this.wrap(tool.name, payload), truncated: false, durationMs: Date.now() - started,
          };
          this.idempotency.set(cacheKey, { at: Date.now(), result });
          await this.recordActivity({ ...input, tool: tool.name, toolVersion: tool.version, durationMs: result.durationMs, bytes: 0, truncated: false, ok: true });
          await this.recordAudit(ctx, { ...input, sessionId, tool: tool.name }, tool, "allowed", undefined, { checkpointId: restoredCheckpointId, turnId, action: "undo_last_turn" });
          return result;
        }
        if (tool.name === "code.fs.diff") {
          // `code.fs.diff` only reads state (it is a write tool because it exposes mutations), so it
          // needs neither a checkpoint nor an approval.
          const turnScoped = await this.diffForTurn(ctx, input, tool, args, sessionId, turnId);
          const result: CodeToolInvokeResult = {
            ok: true, tool: tool.name, toolVersion: tool.version, schemaVersion: tool.version,
            result: this.wrap(tool.name, turnScoped), truncated: false, durationMs: Date.now() - started,
          };
          this.idempotency.set(cacheKey, { at: Date.now(), result });
          await this.recordActivity({ ...input, tool: tool.name, toolVersion: tool.version, durationMs: result.durationMs, bytes: 0, truncated: false, ok: true });
          await this.recordAudit(ctx, { ...input, sessionId, tool: tool.name }, tool, "allowed");
          return result;
        }
        const targets = await this.collectWriteTargets(ctx, input, tool.name, args);
        writeTargets = targets;
        await this.assertReadBeforeWrite(ctx, input, sessionId, targets);
        const approval = await this.assertApproved(ctx, input, tool, targets, sessionId, turnId);
        approved = approval.approved;
        checkpointId = await this.ensureTurnCheckpoint(ctx, { companyId: input.companyId, projectId: input.projectId, sessionId, turnId, runId: input.runId, tool: tool.name });
        // Privileged write: the journal entry is written *before* the change, so an audit outage refuses
        // the change instead of applying it without a record (rule 23, fail closed).
        await this.recordAudit(ctx, { ...input, sessionId, tool: tool.name }, tool, "allowed", undefined, {
          checkpointId, turnId, action: "pre_write", strict: true,
        });
      }

      // (8) Execution. Path policy runs inside the executors through the guards below.
      const executor = this.executors[tool.name];
      if (!executor) throw new CodeToolError("tool_not_configured", `Tool ${tool.name} has no canonical executor configured`, 503, "configure", false, tool.name);
      const port = this.portFor(input.projectId);
      turnChanges = this.turns.listChanges(sessionId, turnId);
      const expectedRevisions: Record<string, string> = {};
      if (write) {
        // The revision the caller read is what the workspace expects back; a mismatch there is a lost
        // update and surfaces as `revision_conflict` from the workspace itself.
        for (const target of writeTargets) {
          const record = this.tracker.get(sessionId, target.path);
          if (record?.revision) expectedRevisions[target.path] = record.revision;
        }
      }
      let raw: unknown;
      try {
        raw = await executor({
          ctx, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId, turnId,
          tool, args, limits: this.limits, port,
          guards: { path: (value: unknown) => this.guardPath(value), sensitive: (value: string) => this.guardSensitive(value) },
          turnChanges: turnChanges.map((change) => ({ path: change.path, tool: change.tool, sha256: change.sha256, linesAdded: change.linesAdded, linesRemoved: change.linesRemoved })),
          expectedRevisions,
          writePort: this.options.writePort,
          approved,
        });
      } catch (error) {
        const conflict = revisionConflictDetails(error);
        if (conflict) throw this.recordRevisionConflict(sessionId, conflict.currentRevision, input, tool.name);
        throw error;
      }

      // (9) Write bookkeeping: per-turn change log, read-tracking refresh, non-blocking hooks.
      const warnings: string[] = [];
      if (write && tool.name !== "code.fs.diff" && tool.name !== "code.fs.undo_last_turn") {
        const changes = extractWriteChanges(tool.name, raw);
        for (const change of changes) {
          this.turns.recordChange(sessionId, turnId, { ...change, at: new Date().toISOString() });
          if (change.sha256) {
            // Refresh the tracker so the model can keep editing the file it just wrote without a
            // second read, and so the freshness check stays true for the very revision on disk.
            this.tracker.record(sessionId, { path: change.path, sha256: change.sha256 });
          }
          this.revisionAttempts.delete(this.revisionKey(sessionId, change.path));
        }
        warnings.push(...await this.runPostWriteHooks(ctx, input, tool.name, raw));
      }

      // (8b) Wrapping: results are data, quote them as such.
      const serialized = JSON.stringify(raw ?? null);
      const truncated = serialized.length > this.limits.toolOutputChars;
      const payload = truncated ? serialized.slice(0, this.limits.toolOutputChars) : raw;
      const wrapped = this.wrap(tool.name, warnings.length ? { result: payload, warnings } : payload);

      // (10) Read tracking for read-before-write (C3).
      if (tool.name === "code.fs.read" && raw && typeof raw === "object") {
        const record = raw as { path?: string; sha256?: string; revision?: string };
        if (typeof record.path === "string" && typeof record.sha256 === "string") {
          this.tracker.record(sessionId, { path: record.path, sha256: record.sha256, revision: record.revision });
        }
      }

      const result: CodeToolInvokeResult = {
        ok: true, tool: tool.name, toolVersion: tool.version, schemaVersion: tool.version,
        result: wrapped, truncated, durationMs: Date.now() - started,
      };
      this.idempotency.set(cacheKey, { at: Date.now(), result });
      await this.recordActivity({ ...input, tool: tool.name, toolVersion: tool.version, durationMs: result.durationMs, bytes: serialized.length, truncated, ok: true });
      await this.recordAudit(ctx, { ...input, sessionId, tool: tool.name }, tool, "allowed", undefined, { checkpointId, turnId, changes: write ? this.turns.listChanges(sessionId, turnId).length : 0 });
      return result;
    } catch (error) {
      const failure = this.toFailure(error, input.tool);
      await this.recordActivity({ ...input, tool: input.tool, toolVersion: input.toolVersion ?? 0, durationMs: Date.now() - started, bytes: 0, truncated: false, ok: false, errorCode: failure.error.code });
      if (failure.error.code === "sandbox_unavailable" || failure.error.code.startsWith("sensitive") || failure.error.code.startsWith("path_") || failure.error.code === "invalid_path" || failure.error.code === "null_byte" || failure.error.code.startsWith("approval") || failure.error.code.startsWith("read_before") || failure.error.code.startsWith("checkpoint") || failure.error.code.startsWith("revision_")) {
        await this.recordAudit(ctx, { ...input, sessionId, tool: input.tool }, undefined, "denied", failure.error.code);
      }
      return failure;
    }
  }

  // --- C3 write helpers ---------------------------------------------------------------------

  private revisionKey(sessionId: string, path: string): string { return `${sessionId}:${path}`; }

  /**
   * Paths a write tool intends to touch. New files need no prior read (there is nothing to clobber),
   * existing files do — that is the read-before-write contract. `code.fs.undo_last_turn` and
   * `code.fs.diff` are handled before this runs.
   */
  private async collectWriteTargets(ctx: AuthContext, input: { companyId: string; projectId: string }, tool: string, args: Record<string, unknown>): Promise<Array<{ path: string; exists: boolean }>> {
    const candidates = new Set<string>();
    const add = (value: unknown) => {
      if (typeof value !== "string" || !value) return;
      try { candidates.add(this.guardPath(value)); } catch { /* the guard reports its own error later */ }
    };
    add(args.path);
    add(args.file);
    add(args.filePath);
    add(args.from);
    add(args.to && args.from ? undefined : args.to);
    for (const key of ["files", "paths", "edits", "updates", "changes"]) {
      const list = args[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (typeof item === "string") add(item);
        else if (item && typeof item === "object") {
          const entry = item as Record<string, unknown>;
          add(entry.path ?? entry.file ?? entry.filePath);
          add(entry.to ?? entry.newPath);
        }
      }
    }
    const port = this.portFor(input.projectId);
    const targets: Array<{ path: string; exists: boolean }> = [];
    for (const path of candidates) {
      let exists = true;
      try {
        await port.readFile({ ctx, companyId: input.companyId, projectId: input.projectId, path, maxLines: 1, maxBytes: 1 });
      } catch (error) {
        const shaped = error as { code?: string; status?: number };
        const missing = shaped?.code === "not_a_file" || shaped?.code === "ENOENT" || shaped?.code === "not_found" || shaped?.status === 404;
        exists = !missing;
      }
      targets.push({ path, exists });
    }
    return targets;
  }

  /** Read-before-write: the file must have been read in this session and be unchanged since. */
  private async assertReadBeforeWrite(ctx: AuthContext, input: { companyId: string; projectId: string }, sessionId: string, targets: Array<{ path: string; exists: boolean }>): Promise<void> {
    const existing = targets.filter((target) => target.exists);
    if (!existing.length) return;
    const port = this.portFor(input.projectId);
    for (const target of existing) {
      this.guardSensitive(target.path);
      const known = this.tracker.get(sessionId, target.path);
      if (!known) {
        throw new CodeToolError("read_before_write_required", `Read ${target.path} before changing it (read-before-write)`, 409, "read_before_write", false, undefined, { reason: "not_read", path: target.path });
      }
      const current = await port.readFile({ ctx, companyId: input.companyId, projectId: input.projectId, path: target.path, maxLines: Number.MAX_SAFE_INTEGER, maxBytes: this.limits.readFileBytes });
      if (current.sha256 !== known.sha256) {
        throw new CodeToolError("read_before_write_required", `${target.path} changed since it was read; read it again`, 409, "read_before_write", false, undefined, { reason: "changed", path: target.path, currentRevision: current.revision });
      }
    }
  }

  /** Approval gate: delete, bulk changes and sensitive writes need an approved request. */
  private async assertApproved(
    ctx: AuthContext,
    input: { companyId: string; projectId: string; approvalId?: string; runId?: string; agentId?: string },
    tool: CodeToolSchema,
    targets: Array<{ path: string; exists: boolean }>,
    sessionId: string,
    turnId: string,
  ): Promise<{ required: boolean; approved: boolean }> {
    const decision = requiresApproval({
      tool: tool.name,
      targets: targets.map((target) => ({ path: target.path, sensitive: isSensitivePath(target.path) })),
      policy: this.approvalPolicy,
    });
    if (!decision.required) return { required: false, approved: false };
    const payload = buildApprovalPayload({ tool: tool.name, toolVersion: tool.version, turnId, sessionId, targets });
    if (!this.options.approvals) {
      throw new CodeToolError("approval_unavailable", "This change requires an approval, but the approval system is not configured", 503, "approval", false, tool.name, { reason: decision.reason });
    }
    if (!input.approvalId) {
      const created = await this.options.approvals.request({
        ctx, companyId: input.companyId, runId: input.runId, agentId: input.agentId,
        toolName: tool.name, actionSummary: decision.summary, inputPayload: payload,
        ttlMs: this.approvalPolicy.ttlMs, riskLevel: decision.reason === "delete" ? "high" : "medium",
      });
      throw new CodeToolError("approval_required", `Approval required for ${tool.name}`, 403, "approval", false, tool.name, { approvalId: created.approvalId, reason: decision.reason, expiresAt: created.expiresAt ?? null });
    }
    try {
      await this.options.approvals.consume({
        ctx, companyId: input.companyId, approvalId: input.approvalId,
        runId: input.runId ?? "", agentId: input.agentId ?? "", toolName: tool.name, inputPayload: payload,
      });
    } catch (error) {
      const shaped = error as { code?: string; status?: number; message?: string };
      throw new CodeToolError("approval_invalid", shaped?.message ?? "Approval is not valid for this change", shaped?.status ?? 409, "approval", false, tool.name, { approvalId: input.approvalId, reason: decision.reason, upstream: shaped?.code ?? null });
    }
    // The approval was consumed for exactly this payload, so the executors may perform the change.
    return { required: true, approved: true };
  }

  /** Creates the per-turn checkpoint on the first write of the turn (never writes without one). */
  private async ensureTurnCheckpoint(ctx: AuthContext, input: { companyId: string; projectId: string; sessionId: string; turnId: string; runId?: string; tool: string }): Promise<string> {
    const existing = this.turns.getCheckpoint(input.sessionId, input.turnId);
    if (existing) return existing.checkpointId;
    if (!this.options.checkpoints) {
      throw new CodeToolError("checkpoint_unavailable", "Writing requires the checkpoint mechanism, which is not configured", 503, "checkpoint", false, input.tool);
    }
    try {
      const created = await this.options.checkpoints.create({
        ctx, companyId: input.companyId, projectId: input.projectId,
        sessionId: input.sessionId, turnId: input.turnId, runId: input.runId,
        label: `Code agent turn ${input.turnId}`,
      });
      this.turns.setCheckpoint(input.sessionId, input.turnId, {
        checkpointId: created.checkpointId, commitHash: created.commitHash ?? null, createdAt: new Date().toISOString(), automatic: true,
      });
      return created.checkpointId;
    } catch (error) {
      if (error instanceof CodeToolError) throw error;
      throw new CodeToolError("checkpoint_unavailable", "Could not create a checkpoint; the change was not applied", 503, "checkpoint", true, input.tool);
    }
  }

  /** `code.fs.undo_last_turn`: restores the turn checkpoint (the git service adds a safety checkpoint). */
  private async restoreTurn(ctx: AuthContext, input: { companyId: string; projectId: string; sessionId: string; turnId: string; tool: string }): Promise<string> {
    const checkpoint = this.turns.getCheckpoint(input.sessionId, input.turnId);
    if (!checkpoint) {
      throw new CodeToolError("checkpoint_not_found", `No checkpoint recorded for turn ${input.turnId}; nothing to undo`, 409, "checkpoint", false, input.tool, { turnId: input.turnId });
    }
    if (!this.options.checkpoints) {
      throw new CodeToolError("checkpoint_unavailable", "Undo requires the checkpoint mechanism, which is not configured", 503, "checkpoint", false, input.tool);
    }
    const result = await this.options.checkpoints.restore({ ctx, companyId: input.companyId, projectId: input.projectId, checkpointId: checkpoint.checkpointId });
    this.turns.clear(input.sessionId, input.turnId);
    return result.restoredCheckpointId;
  }

  /** Turn-scoped diff: the change log this runtime kept for the turn (no git round trip needed). */
  private async diffForTurn(
    ctx: AuthContext,
    input: { companyId: string; projectId: string },
    tool: CodeToolSchema,
    args: Record<string, unknown>,
    sessionId: string,
    turnId: string,
  ) {
    const summary = this.turns.summary(sessionId, turnId);
    const turnOnly = args.turnOnly !== false;
    const maxFiles = typeof args.maxFiles === "number" && Number.isFinite(args.maxFiles)
      ? Math.max(1, Math.min(200, Math.trunc(args.maxFiles)))
      : 50;
    const pathFilter = typeof args.path === "string" && args.path ? this.guardPath(args.path) : null;
    if (turnOnly) {
      // Canonical output shape (`files[].diff`, `stats.files/additions/deletions`) so the model reads the
      // same field names the schema promises, with `maxFiles` bounding the answer.
      const changes = summary.changes.filter((change) => !pathFilter || change.path === pathFilter);
      const selected = changes.slice(0, maxFiles);
      return {
        scope: "turn" as const, turnId, sessionId,
        files: selected.map((change) => ({ path: change.path, tool: change.tool, sha256: change.sha256, linesAdded: change.linesAdded, linesRemoved: change.linesRemoved, diff: change.diff ?? "" })),
        stats: {
          files: selected.length,
          additions: selected.reduce((total, change) => total + change.linesAdded, 0),
          deletions: selected.reduce((total, change) => total + change.linesRemoved, 0),
          // Kept alongside the canonical names so older callers (and the run UI) keep working.
          linesAdded: selected.reduce((total, change) => total + change.linesAdded, 0),
          linesRemoved: selected.reduce((total, change) => total + change.linesRemoved, 0),
        },
        truncated: selected.length < changes.length,
        diff: selected.map((change) => change.diff).filter(Boolean).join("\n"),
      };
    }
    if (!this.options.checkpoints?.diff) {
      throw new CodeToolError("tool_not_configured", "A whole-workspace diff requires the git checkpoint port", 503, "configure", false, tool.name);
    }
    const result = await this.options.checkpoints.diff({ ctx, companyId: input.companyId, projectId: input.projectId, ...(typeof args.path === "string" && args.path ? { file: args.path } : {}) });
    return { scope: "workspace" as const, turnId, sessionId, files: [], stats: { files: summary.files, linesAdded: summary.linesAdded, linesRemoved: summary.linesRemoved }, diff: result.diff };
  }

  /** Counts the revision conflict and refuses once the retry budget for `(session, path)` is spent. */
  private recordRevisionConflict(sessionId: string, currentRevision: string | null, input: { tool: string }, tool: string): CodeToolError {
    const key = this.revisionKey(sessionId, input.tool);
    const attempts = (this.revisionAttempts.get(key) ?? 0) + 1;
    this.revisionAttempts.set(key, attempts);
    if (attempts > this.maxRevisionRetries) {
      return new CodeToolError("revision_conflict_exhausted", `Revision conflict retry budget spent for ${input.tool}; re-read the file`, 409, "revision", false, tool, { currentRevision, attempts });
    }
    return new CodeToolError("revision_conflict", `File changed on disk; re-read ${input.tool} and retry`, 409, "revision", true, tool, { currentRevision, attempts, retriesLeft: this.maxRevisionRetries - attempts + 1 });
  }

  /** Formatter/syntax hooks: warnings only, never a failure and never a silent content change. */
  private async runPostWriteHooks(ctx: AuthContext, input: { companyId: string; projectId: string }, tool: string, raw: unknown): Promise<string[]> {
    const hooks = this.options.postWriteHooks;
    if (!hooks || (!hooks.format && !hooks.checkSyntax)) return [];
    const changes = extractWriteChanges(tool, raw);
    const paths = [...new Set(changes.map((change) => change.path))];
    if (!paths.length) return [];
    const warnings: string[] = [];
    for (const [name, hook] of [["format", hooks.format], ["checkSyntax", hooks.checkSyntax]] as const) {
      if (!hook) continue;
      try {
        const result = await hook({ ctx, companyId: input.companyId, projectId: input.projectId, paths });
        if (Array.isArray(result)) warnings.push(...result.map((line) => `${name}: ${line}`));
      } catch (error) {
        warnings.push(`${name}: ${error instanceof Error ? error.message : "hook failed"}`);
      }
    }
    return warnings;
  }

  private toFailure(error: unknown, tool: string): CodeToolInvokeFailure {
    if (error instanceof CodeToolError) {
      return { ok: false, error: { code: error.code, status: error.status, message: error.message, tool: error.tool ?? tool, step: error.step, retryable: error.retryable, ...(error.details ? { details: error.details } : {}) } };
    }
    const canonical = canonicalFailure(error);
    if (canonical) {
      const shaped = error as { details?: Record<string, unknown> };
      return { ok: false, error: { code: canonical.code, status: canonical.status, message: canonical.message, tool: canonical.tool ?? tool, step: canonical.step ?? "execute", retryable: canonical.retryable, ...(shaped?.details ? { details: shaped.details } : {}) } };
    }
    // Workspace revision control: the current revision travels back so the model can re-read and retry.
    const conflict = revisionConflictDetails(error);
    if (conflict) {
      return { ok: false, error: { code: "revision_conflict", status: conflict.status, message: "File changed on disk; re-read it and retry", tool, step: "revision", retryable: true, details: { currentRevision: conflict.currentRevision } } };
    }
    const flags = error as { code?: string; status?: number; flagKey?: string; message?: string };
    if (flags?.code === "feature_disabled") {
      return { ok: false, error: { code: "feature_disabled", status: flags.status ?? 403, message: flags.message ?? `Feature disabled: ${flags.flagKey ?? "unknown"}`, tool, step: "flags", retryable: false } };
    }
    return { ok: false, error: { code: "tool_failed", status: 500, message: "Tool execution failed", tool, step: "execute", retryable: true } };
  }

  private portFor(projectId: string): CodeReadPort {
    if (this.options.toPort) return this.options.toPort(projectId);
    throw new CodeToolError("tool_failed", "No workspace read port is configured", 500, "execute", false);
  }

  private guardPath(rawPath: unknown): string {
    if (this.options.pathGuard) {
      try {
        return this.options.pathGuard(rawPath);
      } catch (error) {
        const canonical = canonicalFailure(error);
        if (canonical) throw error;
        if (error instanceof CodeToolError) throw error;
        throw new CodeToolError("invalid_path", error instanceof Error ? error.message : "Invalid path", 400, "validate_path");
      }
    }
    // Canonical policy (code-tools-path.ts) — never a second implementation.
    return normalizeWorkspacePath(rawPath, { tool: "code.tool", allowEmpty: true });
  }

  private guardSensitive(path: string): string {
    if (this.options.sensitiveGuard) {
      try {
        this.options.sensitiveGuard(path);
      } catch (error) {
        const canonical = canonicalFailure(error);
        if (canonical) throw error;
        if (error instanceof CodeToolError) throw error;
        throw new CodeToolError("sensitive_file_denied", "Access to this file is denied by policy", 403, "validate_path");
      }
      return path;
    }
    // `decideSensitiveRead` throws in `deny` mode and returns `redact` otherwise; the canonical
    // readers apply the redaction themselves, so a returned decision needs no action here.
    decideSensitiveRead(path, resolveSensitivePolicy(), "code.tool");
    return path;
  }

  private wrap(tool: string, payload: unknown): unknown {
    return this.options.wrap ? this.options.wrap(tool, payload) : wrapToolResult(tool, payload);
  }

  private async recordActivity(input: { companyId: string; projectId: string; sessionId?: string; tool: string; toolVersion: number; durationMs: number; bytes: number; truncated: boolean; ok: boolean; errorCode?: string }): Promise<void> {
    if (!this.options.activity) return;
    try {
      await this.options.activity.record({
        companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId,
        tool: input.tool, toolVersion: input.toolVersion, schemaVersion: input.toolVersion,
        durationMs: input.durationMs, bytes: input.bytes, truncated: input.truncated, ok: input.ok, errorCode: input.errorCode,
      });
    } catch {
      // Activity must never break a tool call; the audit journal below is the compliance record.
    }
  }

  private async recordAudit(
    ctx: AuthContext,
    input: { companyId: string; projectId: string; sessionId?: string; tool: string; toolCallId: string },
    tool: CodeToolSchema | undefined,
    decision: "allowed" | "denied",
    errorCode?: string,
    extra?: { checkpointId?: string | null; turnId?: string; changes?: number; action?: string; strict?: boolean },
  ): Promise<void> {
    if (!this.options.audit) return;
    try {
      const turn = extra?.turnId ? this.turns.summary(input.sessionId ?? `project:${input.projectId}`, extra.turnId) : null;
      await this.options.audit.record(ctx, {
        companyId: input.companyId, actor: ctx.userId, actorRole: "agent",
        action: decision === "allowed" ? (this.writeTools.has(input.tool) ? input.tool : "code.tool.invoke") : "code.tool.denied",
        resourceType: "code_tool", resourceId: input.tool, projectId: input.projectId,
        decision,
        payload: { tool: input.tool, toolVersion: tool?.version ?? null, toolCallId: input.toolCallId, errorCode: errorCode ?? null },
        // No file content, no secrets: paths, hashes and diff statistics only.
        metadata: {
          sessionId: input.sessionId ?? null, errorCode: errorCode ?? null,
          checkpointId: extra?.checkpointId ?? null, turnId: extra?.turnId ?? null,
          action: extra?.action ?? null,
          files: turn?.files ?? extra?.changes ?? 0,
          linesAdded: turn?.linesAdded ?? 0, linesRemoved: turn?.linesRemoved ?? 0,
          paths: turn?.changes.slice(0, 20).map((change) => change.path) ?? [],
        },
      });
    } catch (error) {
      // Write tools are audited *before* they run (strict), so an outage refuses the change instead of
      // losing the record. Everything else is best-effort and C6 makes the run itself fail closed.
      if (extra?.strict) throw error;
    }
  }
}

/** Published manifest version, so a caller can pin the tools a session was created with. */
export function currentManifestVersion(): number {
  return currentToolManifest().version;
}
