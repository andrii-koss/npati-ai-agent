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
  | "tool_failed";

/** Codes thrown by the canonical modules; they are mapped onto the runtime's failure shape. */
const CANONICAL_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "invalid_path", "path_outside_workspace", "null_byte", "symlink_escape", "sensitive_file_denied",
  "not_a_file", "not_a_directory", "too_large", "read_failed", "search_failed", "invalid_argument",
  "sandbox_unavailable", "tool_not_configured", "project_not_found",
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
  ) {
    super(message);
    this.name = "CodeToolError";
  }

  toJSON() {
    return { code: this.code, status: this.status, message: this.message, step: this.step, retryable: this.retryable, tool: this.tool ?? null };
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
  error: { code: CodeToolErrorCode; status: number; message: string; tool: string | null; step: string; retryable: boolean };
}

export interface CodeToolExecutionContext {
  ctx: AuthContext;
  companyId: string;
  projectId: string;
  sessionId?: string;
  tool: CodeToolSchema;
  args: Record<string, unknown>;
  limits: CodeAgentLimits;
  port: CodeReadPort;
  /**
   * Canonical guard hooks for executors that take raw paths: `path` normalises and rejects traversal,
   * `sensitive` applies the sensitive-file policy. Both delegate to `code-tools-*.ts`.
   */
  guards?: { path(raw: unknown): string; sensitive(path: string): string };
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

export class CodeToolRuntime {
  private readonly limits: CodeAgentLimits;
  private readonly schemas: readonly CodeToolSchema[];
  private readonly tracker: ReadTracker;
  private readonly idempotency = new Map<string, { at: number; result: CodeToolInvokeResult }>();
  private readonly idempotencyTtlMs: number;
  private readonly executors: Record<string, (input: CodeToolExecutionContext) => Promise<unknown>>;

  constructor(private readonly options: CodeToolRuntimeOptions = {}) {
    this.limits = { ...resolveCodeAgentLimits(), ...options.limits };
    this.schemas = options.schemas ?? CODE_TOOL_SCHEMAS;
    this.tracker = options.tracker ?? new ReadTracker(resolveReadTrackerOptions());
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? resolveReadTrackerOptions().ttlMs;
    this.executors = options.executors ?? {};
  }

  get readTracker(): ReadTracker { return this.tracker; }

  listTools() {
    return this.schemas.map((tool) => ({
      name: tool.name, version: tool.version, status: tool.status, description: tool.description,
      deprecatedAt: tool.deprecatedAt ?? null,
      limits: (tool as { limits?: Record<string, unknown> }).limits ?? null,
    }));
  }

  listReads(sessionId: string): ReadRecord[] {
    return this.tracker.list(sessionId);
  }

  /**
   * Single entry point for every `code.*` tool call. The check order is fixed and each step is a hard
   * gate: ownership, flags, tool resolution, argument validation, path/sensitive policy, idempotency,
   * execution, data wrapping, Activity, read tracking.
   */
  async invoke(ctx: AuthContext, input: { companyId: string; projectId: string; sessionId?: string; tool: string; toolVersion?: number; args?: unknown; toolCallId: string }): Promise<CodeToolInvokeResult | CodeToolInvokeFailure> {
    const started = Date.now();
    const sessionId = input.sessionId ?? `project:${input.projectId}`;
    try {
      // (1) Tenant isolation: the company must belong to the caller's workspace and user.
      if (this.options.store) {
        try {
          await this.options.store.getCompany(ctx, input.companyId);
        } catch {
          throw new CodeToolError("company_access_denied", "Company is not available to this user", 403, "authorize", false, input.tool);
        }
      }

      // (2) Feature flags: master + code.read, deny by default when the service is missing.
      if (!this.options.flags) throw new CodeToolError("feature_disabled", "Coding Agent is unavailable: feature flags are not configured", 403, "flags", false, input.tool);
      await this.options.flags.assertEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId: input.companyId, userId: ctx.userId });
      await this.options.flags.assertEnabled(ctx, "code.read", { companyId: input.companyId, userId: ctx.userId });

      // (3) Tool resolution and version pinning.
      const candidates = this.schemas.filter((tool) => tool.name === input.tool);
      if (!candidates.length) throw new CodeToolError("unknown_tool", `Unknown tool: ${input.tool}`, 404, "resolve", false, input.tool);
      const tool = input.toolVersion === undefined
        ? candidates.find((candidate) => candidate.status === "active") ?? candidates[0]!
        : candidates.find((candidate) => candidate.version === input.toolVersion);
      if (!tool) throw new CodeToolError("unknown_tool_version", `Unknown version ${input.toolVersion} for ${input.tool}`, 404, "resolve", false, input.tool);
      if (tool.status !== "active") throw new CodeToolError("tool_deprecated", `Tool ${input.tool}@${tool.version} is deprecated`, 409, "resolve", false, input.tool);

      // (4) Arguments.
      const args = validateArguments(tool.inputSchema, input.args);

      // (6) Idempotency: the same (session, toolCallId) never executes twice.
      const cacheKey = `${sessionId}:${input.toolCallId}`;
      const cached = this.idempotency.get(cacheKey);
      if (cached && Date.now() - cached.at <= this.idempotencyTtlMs) {
        return { ...cached.result, cached: true };
      }

      // (7) Execution. Path policy runs inside the executors through the guards below.
      const executor = this.executors[tool.name];
      if (!executor) throw new CodeToolError("tool_not_configured", `Tool ${tool.name} has no canonical executor configured`, 503, "configure", false, tool.name);
      const port = this.portFor(input.projectId);
      const raw = await executor({
        ctx, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId,
        tool, args, limits: this.limits, port,
        guards: { path: (value: unknown) => this.guardPath(value), sensitive: (value: string) => this.guardSensitive(value) },
      });

      // (8) Wrapping: results are data, quote them as such.
      const serialized = JSON.stringify(raw ?? null);
      const truncated = serialized.length > this.limits.toolOutputChars;
      const payload = truncated ? `${serialized.slice(0, this.limits.toolOutputChars)}` : raw;
      const wrapped = this.wrap(tool.name, payload);

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
      await this.recordAudit(ctx, input, tool, "allowed");
      return result;
    } catch (error) {
      const failure = this.toFailure(error, input.tool);
      await this.recordActivity({ ...input, tool: input.tool, toolVersion: input.toolVersion ?? 0, durationMs: Date.now() - started, bytes: 0, truncated: false, ok: false, errorCode: failure.error.code });
      if (failure.error.code === "sandbox_unavailable" || failure.error.code.startsWith("sensitive") || failure.error.code.startsWith("path_") || failure.error.code === "invalid_path" || failure.error.code === "null_byte") {
        await this.recordAudit(ctx, input, undefined, "denied", failure.error.code);
      }
      return failure;
    }
  }

  private toFailure(error: unknown, tool: string): CodeToolInvokeFailure {
    if (error instanceof CodeToolError) {
      return { ok: false, error: { code: error.code, status: error.status, message: error.message, tool: error.tool ?? tool, step: error.step, retryable: error.retryable } };
    }
    const canonical = canonicalFailure(error);
    if (canonical) {
      return { ok: false, error: { code: canonical.code, status: canonical.status, message: canonical.message, tool: canonical.tool ?? tool, step: canonical.step ?? "execute", retryable: canonical.retryable } };
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

  private async recordAudit(ctx: AuthContext, input: { companyId: string; projectId: string; sessionId?: string; tool: string; toolCallId: string }, tool: CodeToolSchema | undefined, decision: "allowed" | "denied", errorCode?: string): Promise<void> {
    if (!this.options.audit) return;
    try {
      await this.options.audit.record(ctx, {
        companyId: input.companyId, actor: ctx.userId, actorRole: "agent",
        action: decision === "allowed" ? "code.tool.invoke" : "code.tool.denied",
        resourceType: "code_tool", resourceId: input.tool, projectId: input.projectId,
        decision, payload: { tool: input.tool, toolVersion: tool?.version ?? null, toolCallId: input.toolCallId, errorCode: errorCode ?? null },
        metadata: { sessionId: input.sessionId ?? null, errorCode: errorCode ?? null },
      });
    } catch {
      // Fail-closed for privileged actions lives in the callers; a read-only tool call is recorded
      // best-effort here and C6 makes the run itself fail closed.
    }
  }
}

/** Published manifest version, so a caller can pin the tools a session was created with. */
export function currentManifestVersion(): number {
  return currentToolManifest().version;
}
