import type { AuthContext } from "@npati/workspace";
import { canonicalJson } from "@npati/workspace";
import { resolveCodeAgentLimits, type CodeAgentLimits } from "./code-agent-config";
import { CODE_TOOL_SCHEMAS, type CodeToolSchema } from "./code-tool-registry";
import { CODE_AGENT_MASTER_FLAG } from "./feature-flags";
import { ReadTracker, resolveReadTrackerOptions, type ReadRecord } from "./code-read-tracker";
import { normalizeWorkspacePath } from "./code-tools-path";
import { decideSensitiveRead, resolveSensitivePolicy } from "./code-tools-sensitive";
import { wrapToolResult } from "./code-tools-fs";
import {
  CODE_WRITE_TOOLS, resolveApprovalPolicy, type CodeApprovalPolicy,
} from "./code-edit-approval";
import {
  GIT_APPROVAL_TOOLS,
  isCodeGitTool,
} from "./code-git-workflow";
import type { CodeWorkspaceRevisionSnapshot } from "./code-workspace-revision";
import { patchTargets } from "./code-tools-patch";
import {
  CodeTurnTracker, extractWriteChanges, resolveTurnTrackingOptions, revisionConflictDetails,
  type CodeWriteChange,
} from "./code-workspace-checkpoint";
import { HOOK_CONTEXT_NOTE } from "./code-hooks";

import {
  canonicalFailure,
  CodeToolError,
} from "./code-tool-runtime-errors";
import type {
  CodeReadPort,
  CodeToolExecutionContext,
  CodeToolInvokeFailure,
  CodeToolInvokeResult,
  CodeToolRuntimeOptions,
} from "./code-tool-runtime-ports";
import {
  codeSubFlagForTool,
  validateArguments,
  sha256Hex,
} from "./code-tool-runtime-guards";
import { CodeToolWriteGuard } from "./code-tool-runtime-write-guard";
import { CodeToolHooksCoordinator, toFailure } from "./code-tool-runtime-hooks";

export * from "./code-tool-runtime-errors";
export * from "./code-tool-runtime-ports";
export * from "./code-tool-runtime-guards";
export * from "./code-tool-runtime-workspace";

/**
 * C2: the runtime that executes read-only and write `code.*` tools.
 */
export class CodeToolRuntime {
  private readonly limits: CodeAgentLimits;
  private readonly schemas: readonly CodeToolSchema[];
  private readonly tracker: ReadTracker;
  private readonly idempotency = new Map<string, { at: number; signature: string; result: CodeToolInvokeResult }>();
  private readonly idempotencyTtlMs: number;
  private readonly executors: Record<string, (input: CodeToolExecutionContext) => Promise<unknown>>;
  private readonly writeTools: ReadonlySet<string>;
  private readonly approvalPolicy: CodeApprovalPolicy;
  private readonly turns: CodeTurnTracker;
  private readonly maxRevisionRetries: number;
  /** Revision-conflict attempts per `(session, path)`; a success resets the counter. */
  private readonly revisionAttempts = new Map<string, number>();

  private readonly writeGuard: CodeToolWriteGuard;
  private readonly hooksCoordinator: CodeToolHooksCoordinator;

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

    this.writeGuard = new CodeToolWriteGuard({
      options: this.options,
      tracker: this.tracker,
      turns: this.turns,
      approvalPolicy: this.approvalPolicy,
      maxRevisionRetries: this.maxRevisionRetries,
      revisionAttempts: this.revisionAttempts,
      limits: this.limits,
      guardPath: (raw) => this.guardPath(raw),
      guardSensitive: (path) => this.guardSensitive(path),
      portFor: (projectId) => this.portFor(projectId),
    });

    this.hooksCoordinator = new CodeToolHooksCoordinator(
      this.options,
      this.turns,
      this.writeTools,
    );
  }

  get readTracker(): ReadTracker { return this.tracker; }
  get turnTracker(): CodeTurnTracker { return this.turns; }

  /** True when the tool mutates the workspace and therefore needs `code.write` plus the C3 gates. */
  isWriteTool(tool: string): boolean {
    return this.writeTools.has(tool);
  }

  /** Turn-scoped summary used by `code.fs.diff` and by `GET …/code/diff`. */
  async verificationRevision(ctx: AuthContext, companyId: string, projectId: string, sessionId: string): Promise<string | null> {
    return this.options.revisions ? (await this.options.revisions.capture({ ctx, companyId, projectId, sessionId })).revision : null;
  }

  turnSummary(sessionId: string, turnId: string) {
    return this.turns.summary(sessionId, turnId);
  }

  /**
   * Public undo entry point used by `POST …/code/undo-last-turn`.
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
      await this.options.flags.executionModes?.assertToolAllowed(ctx, input.companyId, input.projectId, "code.fs.undo_last_turn");
      const checkpointId = await this.writeGuard.restoreTurn(ctx, { companyId: input.companyId, projectId: input.projectId, sessionId, turnId, tool: "code.fs.undo_last_turn" });
      const result: CodeToolInvokeResult = {
        ok: true, tool: "code.fs.undo_last_turn", toolVersion: 1, schemaVersion: 1,
        result: this.wrap("code.fs.undo_last_turn", { restored: true, checkpointId, turnId }),
        truncated: false, durationMs: Date.now() - started,
      };
      await this.hooksCoordinator.recordAudit(ctx, { companyId: input.companyId, projectId: input.projectId, sessionId, tool: "code.fs.undo_last_turn", toolCallId: input.toolCallId ?? `undo-${turnId}` }, undefined, "allowed", undefined, { checkpointId, turnId, action: "undo_last_turn" });
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
   * Single entry point for every `code.*` tool call.
   */
  async invoke(ctx: AuthContext, input: {
    companyId: string; projectId: string; sessionId?: string; tool: string; toolVersion?: number;
    args?: unknown; toolCallId: string;
    turnId?: string;
    approvalId?: string;
    runId?: string; agentId?: string; leaseOwner?: string;
    snapshotId?: string;
    readOnlyIntent?: boolean;
    parentRunId?: string;
    subagentWritePaths?: readonly string[];
    capabilityScope?: readonly string[];
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

      // (3b) C11: read-only intent
      if (input.readOnlyIntent === true && this.options.reviewScope && !this.options.reviewScope.allows(tool.name)) {
        throw new CodeToolError(
          "review_code_read_only",
          `This session's intent is read-only, so ${tool.name} cannot run: a review inspects the repository and writes nothing`,
          403,
          "policy",
          false,
          tool.name,
        );
      }

      // (3c) C12: delegation depth & capability scope
      if (input.parentRunId !== undefined && tool.name.startsWith("code.agent.")) {
        throw new CodeToolError(
          "subagent_depth_exceeded",
          `Run ${input.parentRunId} is itself a sub-agent run, so ${tool.name} cannot run: a coding sub-agent works, it does not delegate (depth 1)`,
          403,
          "policy",
          false,
          tool.name,
        );
      }
      if (input.capabilityScope !== undefined) {
        const scoped = new Set(input.capabilityScope.map((entry) => entry.trim().toLowerCase()));
        if (!scoped.has(tool.name.toLowerCase())) {
          throw new CodeToolError(
            "subagent_tool_scope_denied",
            `${tool.name} is outside this run's capability scope: a delegated run may use exactly the intersection its delegation recorded`,
            403,
            "policy",
            false,
            tool.name,
          );
        }
      }

      // (4) Sub-flag
      const write = this.isWriteTool(tool.name);
      const gitTool = isCodeGitTool(tool.name);
      const gitApprovalRequired = gitTool && GIT_APPROVAL_TOOLS.has(tool.name);
      await this.options.flags.assertEnabled(ctx, codeSubFlagForTool(tool.name, write), { companyId: input.companyId, userId: ctx.userId });

      // (5) Arguments
      const args = validateArguments(tool.inputSchema, input.args);
      if (input.subagentWritePaths) {
        const scopedFileTools = ["code.fs.edit", "code.fs.write", "code.fs.move", "code.fs.delete", "code.fs.apply_patch"];
        const unsafe = this.isWriteTool(tool.name) || /^(code\.shell\.(exec|exec_async|process\.start)|code\.verify\.run|code\.deps\.(add|install|update|remove)|code\.git\.(branch|stage|commit|restore|push|pr))/.test(tool.name);
        if (unsafe) {
          const paths = tool.name === "code.fs.apply_patch" ? patchTargets(String(args.patch ?? "")).map((file) => file.path)
            : [args.path, args.from, args.to].filter((value): value is string => typeof value === "string");
          if (!scopedFileTools.includes(tool.name) || !paths.length || paths.some((path) => {
            const normalized = this.guardPath(path);
            return !input.subagentWritePaths!.some((scope) => normalized === scope || normalized.startsWith(`${scope}/`));
          })) throw new CodeToolError("subagent_path_outside_scope", "The writing child must stay inside its recorded file scope", 403, "policy", false, tool.name);
        }
      }
      await this.options.flags.executionModes?.assertToolAllowed(ctx, input.companyId, input.projectId, tool.name, args);
      if (tool.name === "code.fs.undo_last_turn" && args.confirm !== true) {
        throw new CodeToolError("invalid_arguments", "code.fs.undo_last_turn requires confirm: true", 400, "validate_arguments", false, tool.name);
      }

      // (5b) C11: git-write policy pre-flight
      if (gitTool && this.options.gitPolicy) {
        const decision = await this.options.gitPolicy.evaluate({
          ctx, companyId: input.companyId, projectId: input.projectId,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          tool: tool.name, args, toolCallId: input.toolCallId,
          ...(input.agentId ? { agentId: input.agentId } : {}),
        });
        if (decision.decision === "deny") {
          throw Object.assign(
            new Error(decision.message ?? `The git operation is refused by policy (${decision.code ?? "policy_denied"})`),
            {
              code: decision.code ?? "policy_denied",
              httpStatus: decision.status ?? 403,
              tool: tool.name,
              step: "policy",
              retryable: false,
              details: { reasons: decision.reasons ?? [] },
            },
          );
        }
      }

      // (6) Idempotency
      const cacheKey = canonicalJson([ctx.workspaceId, ctx.userId, input.companyId, input.projectId, sessionId, input.toolCallId]);
      const signature = sha256Hex(canonicalJson({ tool: tool.name, version: tool.version, args }));
      for (const [key, entry] of this.idempotency) if (Date.now() - entry.at > this.idempotencyTtlMs) this.idempotency.delete(key);
      const cached = this.idempotency.get(cacheKey);
      if (cached && Date.now() - cached.at <= this.idempotencyTtlMs) {
        if (cached.signature !== signature) throw new CodeToolError("invalid_arguments", "Tool call identity was reused for different arguments", 409, "idempotency", false, tool.name);
        return { ...cached.result, cached: true };
      }

      // C11: canonical revision snapshot for git tools
      let revisionSnapshot: CodeWorkspaceRevisionSnapshot | null = null;
      if (this.options.revisions && gitTool) {
        revisionSnapshot = await this.options.revisions.capture({ ctx, companyId: input.companyId, projectId: input.projectId, sessionId });
      }

      // (7) Write pre-flight
      let checkpointId: string | null = null;
      let writeTargets: Array<{ path: string; exists: boolean }> = [];
      let approved = false;
      if (tool.name.startsWith("code.data.") && write) {
        if (tool.name === "code.data.backend.attach" && args.dryRun !== true && (typeof args.targetProjectId !== "string" || args.expectedTargetBackendId === undefined)) throw new CodeToolError("invalid_arguments", "Preview and select a target project and its current database attachment", 400, "arguments", false, tool.name);
        if (tool.name !== "code.data.schema.apply" && args.dryRun !== true) {
          if (!this.options.approvals) throw new CodeToolError("approval_unavailable", "Database changes require the approval system", 503, "approval", false, tool.name);
          const payload = { projectId: input.projectId, sessionId, turnId, tool: tool.name, toolVersion: tool.version, args };
          if (!input.approvalId) await this.writeGuard.requestApprovalDecision(ctx, input, tool, "delete", `${tool.name}: ${JSON.stringify(args)}`, payload);
          if (!input.approvalId) throw new CodeToolError("approval_invalid", "Database approval is missing", 403, "approval", false, tool.name);
          try {
            await this.options.approvals.consume({ ctx, companyId: input.companyId, approvalId: input.approvalId, runId: input.runId ?? "", agentId: input.agentId ?? "", toolName: tool.name, inputPayload: payload });
          } catch (error) {
            const shaped = error as { code?: string; message?: string };
            throw new CodeToolError(shaped.code === "approval_denied" || shaped.code === "approval_rejected" ? "approval_denied" : "approval_invalid", shaped.message ?? "Database approval does not match this operation", 403, "approval", false, tool.name);
          }
          approved = true;
        }
        await this.hooksCoordinator.recordAudit(ctx, { ...input, sessionId, tool: tool.name }, tool, "allowed", undefined, {
          turnId, action: "pre_schema_write", strict: true,
        });
      } else if (write) {
        if (tool.name === "code.fs.undo_last_turn") {
          const restoredCheckpointId = await this.writeGuard.restoreTurn(ctx, { companyId: input.companyId, projectId: input.projectId, sessionId, turnId, tool: tool.name });
          const payload = { restored: true, checkpointId: restoredCheckpointId, turnId };
          const result: CodeToolInvokeResult = {
            ok: true, tool: tool.name, toolVersion: tool.version, schemaVersion: tool.version,
            result: this.wrap(tool.name, payload), truncated: false, durationMs: Date.now() - started,
          };
          this.idempotency.set(cacheKey, { at: Date.now(), signature, result });
          await this.hooksCoordinator.recordActivity({ ...input, tool: tool.name, toolVersion: tool.version, durationMs: result.durationMs, bytes: 0, truncated: false, ok: true });
          await this.hooksCoordinator.recordAudit(ctx, { ...input, sessionId, tool: tool.name }, tool, "allowed", undefined, { checkpointId: restoredCheckpointId, turnId, action: "undo_last_turn" });
          return result;
        }
        if (tool.name === "code.fs.diff") {
          const turnScoped = await this.writeGuard.diffForTurn(ctx, input, tool, args, sessionId, turnId);
          const result: CodeToolInvokeResult = {
            ok: true, tool: tool.name, toolVersion: tool.version, schemaVersion: tool.version,
            result: this.wrap(tool.name, turnScoped), truncated: false, durationMs: Date.now() - started,
          };
          this.idempotency.set(cacheKey, { at: Date.now(), signature, result });
          await this.hooksCoordinator.recordActivity({ ...input, tool: tool.name, toolVersion: tool.version, durationMs: result.durationMs, bytes: 0, truncated: false, ok: true });
          await this.hooksCoordinator.recordAudit(ctx, { ...input, sessionId, tool: tool.name }, tool, "allowed");
          return result;
        }
        const targets = await this.writeGuard.collectWriteTargets(ctx, input, tool.name, args);
        writeTargets = targets;
        await this.writeGuard.assertReadBeforeWrite(ctx, input, sessionId, targets);
        const approval = await this.writeGuard.assertApproved(ctx, input, tool, targets, sessionId, turnId, undefined, args);
        approved = approval.approved;
        checkpointId = await this.writeGuard.ensureTurnCheckpoint(ctx, { companyId: input.companyId, projectId: input.projectId, sessionId, turnId, runId: input.runId, tool: tool.name });
        await this.hooksCoordinator.recordAudit(ctx, { ...input, sessionId, tool: tool.name }, tool, "allowed", undefined, {
          checkpointId, turnId, action: "pre_write", strict: true,
          ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
        });
      } else if (gitApprovalRequired) {
        const approval = await this.writeGuard.assertApproved(ctx, input, tool, [], sessionId, turnId, { args });
        approved = approval.approved;
        await this.hooksCoordinator.recordAudit(ctx, { ...input, sessionId, tool: tool.name }, tool, "allowed", undefined, {
          turnId, action: "pre_git_write", strict: true,
          ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
        });
      }

      // (8) Execution
      const executor = this.executors[tool.name];
      if (!executor) throw new CodeToolError("tool_not_configured", `Tool ${tool.name} has no canonical executor configured`, 503, "configure", false, tool.name);
      const port = this.portFor(input.projectId);
      turnChanges = this.turns.listChanges(sessionId, turnId);
      const expectedRevisions: Record<string, string> = {};
      if (write) {
        for (const target of writeTargets) {
          const record = this.tracker.get(sessionId, target.path);
          if (record?.revision) expectedRevisions[target.path] = record.revision;
        }
      }

      // (7c) PreToolUse hook
      let hookContext: Array<{ hookId: string; trust: "untrusted_data"; text: string }> = [];
      let hookWarnings: string[] = [];
      if (this.options.hooks && await this.options.hooks.active({ ctx, companyId: input.companyId })) {
        const engineAllows = await this.hooksCoordinator.preToolPolicyAllows(ctx, input, tool.name, args);
        if (engineAllows) {
          const outcome = await this.options.hooks.preToolUse({
            ctx, companyId: input.companyId, projectId: input.projectId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.runId ? { runId: input.runId } : {}),
            ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
            tool: tool.name,
            toolCallId: input.toolCallId,
            ...(writeTargets.length ? { paths: writeTargets.map((target) => target.path) } : {}),
          });
          hookContext = [...outcome.context];
          hookWarnings = [...outcome.warnings];
          if (outcome.blocked) {
            throw new CodeToolError(
              "hook_blocked",
              `A project hook blocked ${tool.name}`,
              403,
              "hook",
              false,
              tool.name,
              {
                reason: outcome.blockReason,
                hookId: outcome.blockedBy,
                trust: "untrusted_data",
                note: "A hook may only refuse a call; it cannot allow, approve or widen anything.",
              },
            );
          }
        }
      }

      let raw: unknown;
      try {
        raw = await executor({
          ctx, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId, turnId,
          ...(input.runId ? { runId: input.runId } : {}),
          toolCallId: input.toolCallId, leaseOwner: input.leaseOwner,
          tool, args, limits: this.limits, port,
          guards: { path: (value: unknown) => this.guardPath(value), sensitive: (value: string) => this.guardSensitive(value) },
          turnChanges: turnChanges.map((change) => ({ path: change.path, tool: change.tool, sha256: change.sha256, linesAdded: change.linesAdded, linesRemoved: change.linesRemoved })),
          expectedRevisions,
          writePort: this.options.writePort,
          approved,
          ...(input.approvalId ? { approvalId: input.approvalId } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(revisionSnapshot ? { workspaceRevision: revisionSnapshot } : {}),
          ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
        });
      } catch (error) {
        const conflict = revisionConflictDetails(error);
        if (conflict) throw this.writeGuard.recordRevisionConflict(sessionId, conflict.currentRevision, input, tool.name);
        throw error;
      }

      // (9) Write bookkeeping
      const warnings: string[] = [];
      if (write && tool.name !== "code.fs.diff" && tool.name !== "code.fs.undo_last_turn") {
        const changes = extractWriteChanges(tool.name, raw);
        for (const change of changes) {
          this.turns.recordChange(sessionId, turnId, { ...change, at: new Date().toISOString() });
          if (change.sha256) {
            this.tracker.record(sessionId, { path: change.path, sha256: change.sha256 });
          }
          this.revisionAttempts.delete(this.writeGuard.revisionKey(sessionId, change.path));
        }
        warnings.push(...await this.hooksCoordinator.runPostWriteHooks(ctx, input, tool.name, raw));
      }

      // (9b) PostToolUse hook
      if (this.options.hooks && await this.options.hooks.active({ ctx, companyId: input.companyId })) {
        const outcome = await this.options.hooks.postToolUse({
          ctx, companyId: input.companyId, projectId: input.projectId,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
          tool: tool.name,
          toolCallId: input.toolCallId,
          ...(writeTargets.length ? { paths: writeTargets.map((target) => target.path) } : {}),
        });
        hookContext = [...hookContext, ...outcome.context];
        hookWarnings = [...hookWarnings, ...outcome.warnings];
      }

      // (8b) Wrapping
      const serialized = JSON.stringify(raw ?? null);
      const truncated = serialized.length > this.limits.toolOutputChars;
      const payload = truncated ? serialized.slice(0, this.limits.toolOutputChars) : raw;
      const allWarnings = [...warnings, ...hookWarnings];
      const wrapped = this.wrap(tool.name, allWarnings.length || hookContext.length
        ? {
            result: payload,
            ...(allWarnings.length ? { warnings: allWarnings } : {}),
            ...(hookContext.length ? { hookContext, note: HOOK_CONTEXT_NOTE } : {}),
          }
        : payload);

      // (10) Read tracking
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
      if (["code.shell.exec_async", "code.shell.process.wait"].includes(tool.name) && raw && typeof raw === "object") {
        const receipt = raw as { kind?: unknown; processId?: unknown };
        if (typeof receipt.kind === "string" && typeof receipt.processId === "string") result.processReceipt = { kind: receipt.kind, processId: receipt.processId };
      }
      this.idempotency.set(cacheKey, { at: Date.now(), signature, result });
      await this.hooksCoordinator.recordActivity({ ...input, tool: tool.name, toolVersion: tool.version, durationMs: result.durationMs, bytes: serialized.length, truncated, ok: true });
      await this.hooksCoordinator.recordAudit(ctx, { ...input, sessionId, tool: tool.name }, tool, "allowed", undefined, { checkpointId, turnId, changes: write ? this.turns.listChanges(sessionId, turnId).length : 0, ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}) });
      return result;
    } catch (error) {
      const failure = this.toFailure(error, input.tool);
      await this.hooksCoordinator.recordActivity({ ...input, tool: input.tool, toolVersion: input.toolVersion ?? 0, durationMs: Date.now() - started, bytes: 0, truncated: false, ok: false, errorCode: failure.error.code });
      if (failure.error.code === "sandbox_unavailable" || failure.error.code.startsWith("sensitive") || failure.error.code.startsWith("path_") || failure.error.code === "invalid_path" || failure.error.code === "null_byte" || failure.error.code.startsWith("approval") || failure.error.code.startsWith("read_before") || failure.error.code.startsWith("checkpoint") || failure.error.code.startsWith("revision_")) {
        await this.hooksCoordinator.recordAudit(ctx, { ...input, sessionId, tool: input.tool }, undefined, "denied", failure.error.code);
      }
      return failure;
    }
  }

  private toFailure(error: unknown, tool: string): CodeToolInvokeFailure {
    return toFailure(error, tool);
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
    decideSensitiveRead(path, resolveSensitivePolicy(), "code.tool");
    return path;
  }

  private wrap(tool: string, payload: unknown): unknown {
    return this.options.wrap ? this.options.wrap(tool, payload) : wrapToolResult(tool, payload);
  }
}
