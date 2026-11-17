import type { AuthContext } from "@npati/workspace";
import type { CodeAgentLimits } from "./code-agent-config";
import type { CodeToolSchema } from "./code-tool-registry";
import type { FeatureFlagService } from "./feature-flags";
import type { AuditLogService } from "./audit-log";
import type { ReadTracker } from "./code-read-tracker";
import type { CodeApprovalPolicy } from "./code-edit-approval";
import type { CodeWorkspaceRevisionGuard, CodeWorkspaceRevisionSnapshot } from "./code-workspace-revision";
import type { CodeApprovalPort, CodeCheckpointPort, CodeTurnTracker } from "./code-workspace-checkpoint";
import type { CodeHooksPort } from "./code-hooks";
import type { CodeToolErrorCode } from "./code-tool-runtime-errors";

export interface CodeToolInvokeResult {
  ok: true;
  tool: string;
  toolVersion: number;
  schemaVersion: number;
  result: unknown;
  truncated: boolean;
  durationMs: number;
  cached?: boolean;
  /** Server metadata survives output budgeting; only canonical process executors populate it. */
  processReceipt?: { kind: string; processId: string };
  /** `code.image.view` / `code.preview.screenshot`: the image, kept out of `result` and delivered by the runner. */
  imageAttachment?: { mimeType: string; dataBase64: string; source: string; question?: string };
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
  signal?: AbortSignal;
  ctx: AuthContext;
  companyId: string;
  projectId: string;
  sessionId?: string;
  /** Canonical session mode resolved by the caller; policy still makes the final decision. */
  sessionMode?: "plan" | "edit" | "ask" | "auto" | "auto_edit" | "full_auto" | "full_auto_sandbox";
  /** C3: the turn this call belongs to, so executors can scope their output to it. */
  turnId?: string;
  /**
   * C9: the run this call belongs to. `code.ask_user` pauses that run, so a call with no run has nothing to
   * pause and the executor refuses it instead of pretending a question was asked.
   */
  runId?: string;
  leaseOwner?: string;
  /**
   * C9: the model's tool-call id. It is the idempotency key of a question (`company, run, tool_call_id` is
   * unique), so a replayed call finds the question it already asked instead of asking the user twice.
   */
  toolCallId?: string;
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
  /**
   * C11: the approval record a remote git write presents to the git boundary. It is not consumed by the
   * runtime for `code.git.push`, `code.git.pr.create` or `code.git.pr.comment`.
   */
  approvalId?: string;
  /** C11: the agent identity the approval record is matched against at the git boundary. */
  agentId?: string;
  /** C11 (owner decision 7): the canonical revision this call was authorised against. */
  workspaceRevision?: CodeWorkspaceRevisionSnapshot;
  /**
   * C12: the ExecutionSnapshot this call belongs to, forwarded from the invocation envelope.
   */
  snapshotId?: string;
}

/**
 * Read port implemented by `createProjectWorkspaceReadPort` (workspace files + sandbox search).
 */
export interface CodeReadPort {
  listDir(input: { ctx: AuthContext; companyId: string; projectId: string; path: string; depth?: number; limit?: number }): Promise<{ entries: Array<{ path: string; type: "file" | "directory"; size?: number; mtimeMs?: number | null; target?: string | null }> }>;
  readFile(input: { ctx: AuthContext; companyId: string; projectId: string; path: string; startLine?: number; endLine?: number; maxLines: number; maxBytes: number }): Promise<{ path: string; content: string; revision: string; sha256: string; totalLines: number; truncated: boolean; bytes?: number; mode?: number; encoding?: string; binary?: boolean; mimeGuess?: string | null }>;
  runSearch(input: { ctx: AuthContext; companyId: string; projectId: string; query: string; path?: string; maxResults: number; timeoutMs: number; glob?: string; type?: string; ignoreCase?: boolean; fixedStrings?: boolean; contextLines?: number }): Promise<{ matches: Array<{ path: string; line: number; text: string; context?: Array<{ line: number; text: string }> }>; truncated: boolean; engine?: "ripgrep" | "fallback" }>;
}

/** Minimal sandbox execution port (satisfied by `ProjectSandboxService.execute`). */
export interface SandboxExecPort {
  execute(ctx: AuthContext, companyId: string, request: { projectId: string; command: string; cwd?: string; timeoutMs?: number }): Promise<{ stdout?: string; output?: string; exitCode?: number }>;
  search?(
    ctx: AuthContext,
    companyId: string,
    request: {
      projectId: string;
      query: string;
      path?: string;
      maxResults?: number;
      timeoutMs?: number;
      glob?: string;
      type?: string;
      ignoreCase?: boolean;
      fixedStrings?: boolean;
      contextLines?: number;
    },
  ): Promise<{ matches: Array<{ path: string; line: number; text: string; context?: Array<{ line: number; text: string }> }>; truncated: boolean }>;
}

/**
 * C3: the write half of the workspace port. Implemented by `createProjectWorkspaceWritePort`.
 */
export interface CodeWritePort {
  applyPatchTransaction?(input: { ctx: AuthContext; companyId: string; projectId: string; plan: readonly import("./code-patch-transaction").PatchMutation[] }): Promise<Array<{ path: string; sha256?: string; revision?: string }>>;
  writeFile(input: { ctx: AuthContext; companyId: string; projectId: string; path: string; content: string; expectedRevision: string }): Promise<{ path: string; revision: string; sha256: string }>;
  createFile(input: { ctx: AuthContext; companyId: string; projectId: string; path: string; content: string; mode?: number }): Promise<{ path: string; revision: string; sha256: string }>;
  editFile(input: { ctx: AuthContext; companyId: string; projectId: string; path: string; find: string; replacement: string; expectedRevision: string }): Promise<{ path: string; revision: string; sha256: string }>;
  moveFile(input: { ctx: AuthContext; companyId: string; projectId: string; from: string; to: string; expectedRevision: string }): Promise<{ path: string; revision: string; sha256: string }>;
  deleteFile(input: { ctx: AuthContext; companyId: string; projectId: string; path: string; expectedRevision?: string }): Promise<void>;
}

export interface CodeToolActivityEvent {
  toolCallId?: string;
  turnId?: string;
  companyId: string;
  projectId: string;
  sessionId?: string;
  /** C6b: the run and its ExecutionSnapshot, so every Activity event can be explained after the fact. */
  runId?: string;
  snapshotId?: string;
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
  /**
   * C5: scoped approval rules (`session` | `project`).
   */
  /** Stops agent writes and commands while the shared disk is below its reserve (V6 step 17, O17-05). */
  diskSpace?: { assertRoom(): Promise<void> };
  /** The company setting that lets the agent change project databases without asking each time (off by default). */
  dataAutoAllow?: (ctx: AuthContext, companyId: string) => Promise<boolean>;
  approvalRules?: {
    findRule(ctx: AuthContext, query: {
      companyId: string; projectId?: string | null; sessionId?: string | null; action: string;
    }): Promise<{ id: string; scope: string; expiresAt?: string | null } | null>;
  };
  /**
   * C5: waits for a human decision on a requested approval.
   */
  approvalDecision?: {
    timeoutMs: number;
    wait(input: { ctx: AuthContext; companyId: string; approvalId: string; action: string; signal?: AbortSignal }):
      Promise<{ status: "approved" | "rejected" | "pending"; comment?: string | null } | null>;
    onTimeout?(input: { approvalId: string; waitedMs: number; action: string; ctx?: AuthContext; companyId?: string }): Promise<void> | void;
  };
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
  /**
   * C11 (owner decisions 2 and 3): the git-write pre-flight.
   */
  gitPolicy?: {
    evaluate(input: {
      ctx: AuthContext; companyId: string; projectId: string; sessionId?: string; tool: string;
      args: Record<string, unknown>; toolCallId: string; agentId?: string;
    }): Promise<{ decision: "allow" | "require_approval" | "deny"; code?: string; message?: string; status?: number; reasons?: string[] }>;
  };
  /**
   * C11 (owner decision 7): the canonical-revision guard.
   */
  revisions?: CodeWorkspaceRevisionGuard;
  /**
   * C11 (owner decision 13): the read-only repository state.
   */
  repositoryState?: {
    inspect(input: { ctx: AuthContext; companyId: string; projectId: string }): Promise<{ initialized: boolean } | null>;
  };
  /**
   * C11 (owner decision 10): the read-only intent's tool allowlist.
   */
  reviewScope?: { allows(tool: string): boolean };
  /**
   * C13 (owner decision 1): the project's lifecycle hooks.
   */
  hooks?: CodeHooksPort;
  /**
   * C13: the policy engine's own verdict for a call whose executor is where the engine is consulted.
   */
  preToolPolicy?: {
    evaluate(input: {
      ctx: AuthContext; companyId: string; projectId: string; sessionId?: string; tool: string;
      args: Record<string, unknown>; toolCallId: string; runId?: string; agentId?: string; leaseOwner?: string; approvalId?: string;
    }): Promise<{ decision: "allow" | "require_approval" | "deny"; code?: string }>;
  };
}
