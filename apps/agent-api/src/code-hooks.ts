import type { AuthContext } from "@npati/workspace";
import type { HookHandler, LifecycleHookName } from "./automation-lifecycle-and-reminders";
import { APPROVAL_DEFERRED_REASON, type PolicyRequest, type PolicyResult } from "./code-policy-engine";
import {
  CODE_HOOKS_FLAG,
  CODE_HOOKS_CONFIG_PATH,
  CODE_HOOK_EVENTS,
  type CodeHookEvent,
  CODE_HOOK_LIFECYCLE_NAMES,
  type CodeHookResultForm,
  HOOK_CONTEXT_TRUST,
  HOOK_CONTEXT_NOTE,
  type CodeHookErrorCode,
  CodeHookError,
  type CodeHookConfigEntry,
  parseCodeHookConfig,
  type CodeHookResult,
  parseCodeHookResult,
} from "./code-hooks-parser";

export * from "./code-hooks-parser";

/**
 * C13 (owner decisions 1, 2 and 9) — project lifecycle hooks.
 *
 * **One mechanism, reused.** There is no third event bus here. The four project-facing events are mapped
 * onto the lifecycle names the *existing* `AgentLifecycleHookManager` already defines
 * (`automation-lifecycle-and-reminders.ts`), this service registers itself on that manager as a hook
 * handler, and the run loop emits through `emitHook`.
 *
 * **What a hook may decide: nothing.** A hook is a *narrowing* signal from the repository or the user, and
 * the vocabulary is closed on purpose — the only accepted results are
 *   - `{ "block": true, "reason": "…" }`   — may refuse a tool call, never authorise one;
 *   - `{ "context": "…", "trust": "untrusted_data" }` — text for the model, labelled as data;
 *   - `{ "warnings": ["…"] }`              — advice shown with the tool result.
 *
 * **Trust before reading.** `.npati/hooks.json` is repository content, so it is not even *read* (let alone
 * parsed or executed) unless an owner/admin trust record says the repository's instructions may guide the
 * work (`isRepositoryInstructionsTrusted`).
 *
 * **Execution never touches the host.** A `command` hook runs in the sandbox through the existing
 * `SandboxExecPort` (`code-tool-runtime.ts:335`), and a `webhook` hook goes through the existing
 * SSRF-safe/webhook destination stack (`deliverWebhook`).
 */

// --- service --------------------------------------------------------------------------------------

/** The existing lifecycle bus, narrowed to the two calls this feature makes of it. */
export interface CodeHookBusPort {
  registerHook(hookName: LifecycleHookName, handler: HookHandler, priority?: number): void;
  emitHook(hookName: LifecycleHookName, context: Record<string, unknown>): Promise<void>;
}

export interface CodeHookDispatchInput {
  event: CodeHookEvent;
  ctx: AuthContext;
  companyId: string;
  projectId: string;
  sessionId?: string;
  runId?: string;
  snapshotId?: string | null;
  /** Set for the two tool events. */
  tool?: string;
  toolCallId?: string;
  /** Repository-relative paths the tool call touches. Metadata only — never file content. */
  paths?: readonly string[];
  /** Terminal run facts for `Stop`. */
  status?: string;
  reason?: string;
}

export type CodeHookSkip = "flag_disabled" | "project_untrusted" | "no_config" | "no_hooks_for_event";

export interface CodeHookOutcome {
  event: CodeHookEvent;
  /** True when at least one hook really ran. */
  executed: boolean;
  skipped: CodeHookSkip | null;
  blocked: boolean;
  blockedBy: string | null;
  blockReason: string | null;
  /** Model-visible context, already labelled `untrusted_data`. Never a policy input. */
  context: Array<{ hookId: string; trust: typeof HOOK_CONTEXT_TRUST; text: string }>;
  warnings: string[];
  /** How many hooks were invoked (a refusal still counts as an invocation). */
  invocations: number;
  /** Codes of the results that were refused (`hook_result_forbidden_field`, …). Never hook text. */
  refusals: string[];
}

export interface CodeHookActivityEvent {
  kind: "code_tool_activity" | "run_activity";
  companyId: string;
  projectId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  snapshotId?: string | null;
  [key: string]: unknown;
}

export interface CodeHooksDeps {
  /** The existing lifecycle hook manager. No second bus is created here. */
  bus: CodeHookBusPort;
  /** Server-side feature flag reader. Called on the execution path, before anything else. */
  flags: { isEnabled(ctx: AuthContext, flagKey: string, options?: { companyId?: string; userId?: string }): Promise<boolean> };
  /** `isRepositoryInstructionsTrusted`-shaped trust reader (fail closed when it cannot answer). */
  trust: { isTrusted(input: { ctx: AuthContext; companyId: string; projectId: string }): Promise<boolean> };
  /**
   * Reads and decodes the config. Called **only** after the flag and the trust gate have passed, so a
   * test can prove "not read" with a spy. Returning `null` means "this repository has no hooks".
   */
  readConfig(input: { ctx: AuthContext; companyId: string; projectId: string; path: string }): Promise<unknown>;
  /** The existing sandbox transport. Absent means a `command` hook is refused, never run on the host. */
  sandbox?: {
    execute(ctx: AuthContext, companyId: string, request: { projectId: string; command: string; timeoutMs?: number }):
      Promise<{ stdout?: string; output?: string; exitCode?: number }>;
  };
  /** The existing SSRF-safe webhook delivery. Absent means a `webhook` hook is refused. */
  webhook?: {
    deliver(input: { url: string; body: string; timeoutMs: number; companyId: string; projectId: string }):
      Promise<{ status: number; body: string }>;
  };
  /** Activity sink (metadata only). Absent records nothing; a failure never changes the outcome. */
  activity?: { record(event: CodeHookActivityEvent): Promise<unknown> | unknown };
  logger?: { warn(payload: Record<string, unknown>, message: string): void };
  now?: () => Date;
}

/** Result slots travel inside the emit context, so `emitHook`'s signature stays untouched. */
const DISPATCH_SLOT = "__codeHookDispatch";
/** Identifies *which* service is dispatching, so two instances on one bus cannot run each other's hooks. */
const DISPATCH_OWNER_SLOT = "__codeHookDispatchOwner";

interface DispatchHolder { outcome: CodeHookOutcome | null }

function skippedOutcome(event: CodeHookEvent, skipped: CodeHookSkip | null): CodeHookOutcome {
  return {
    event, executed: false, skipped, blocked: false, blockedBy: null, blockReason: null,
    context: [], warnings: [], invocations: 0, refusals: [],
  };
}

/** Shell-quotes one argument for the sandbox command line (single quotes, POSIX style). */
export function quoteHookArgument(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The project's hook executor.
 *
 * It is created once, registers itself on the **existing** lifecycle manager, and is then driven by
 * `dispatch`, which emits the mapped lifecycle event. Registering a handler (instead of calling the
 * project hooks directly) is what makes the reuse real: an operator who registered their own
 * `tool:before` handler through the admin route observes exactly the same event, in the same order, and
 * the run loop talks to one bus.
 */
export class CodeHooksService {
  /** Identity of this instance inside a dispatch context; see `attach` below. */
  private readonly ownerToken = Symbol("code-hooks-service");

  constructor(private readonly deps: CodeHooksDeps) {
    // One handler per mapped lifecycle event. A dispatch carries its own holder; an emit from anywhere else
    // (an operator's own emit, an unrelated caller) finds no holder and is left untouched — and a second
    // instance attached to the same bus recognises that the dispatch is not its own and stays out of it.
    for (const event of CODE_HOOK_EVENTS) {
      this.deps.bus.registerHook(CODE_HOOK_LIFECYCLE_NAMES[event], async (context: Record<string, unknown>) => {
        const holder = context[DISPATCH_SLOT] as DispatchHolder | undefined;
        if (!holder || context[DISPATCH_OWNER_SLOT] !== this.ownerToken) return;
        const input = context.__codeHookInput as CodeHookDispatchInput | undefined;
        if (!input || input.event !== event) return;
        holder.outcome = await this.runProjectHooks(input);
      });
    }
  }

  /** Emits one mapped lifecycle event on the existing bus and returns what the project's hooks said. */
  async dispatch(input: CodeHookDispatchInput): Promise<CodeHookOutcome> {
    const holder: DispatchHolder = { outcome: null };
    const context: Record<string, unknown> = {
      __codeHookInput: input,
      [DISPATCH_SLOT]: holder,
      [DISPATCH_OWNER_SLOT]: this.ownerToken,
    };
    try {
      await this.deps.bus.emitHook(CODE_HOOK_LIFECYCLE_NAMES[input.event], context);
    } catch {
      // An operator-registered handler that throws must not become a way to break the run loop. The project's
      // own hooks were already executed by our handler; only their result is lost, which is reported as such.
      this.log({ event: input.event, code: "hook_bus_emit_failed" }, "code_hook_bus_emit_failed");
    }
    return holder.outcome ?? skippedOutcome(input.event, "no_config");
  }

  /** `PreToolUse`: may block, may add context/warnings — never authorises. */
  preToolUse(input: Omit<CodeHookDispatchInput, "event">): Promise<CodeHookOutcome> {
    return this.dispatch({ ...input, event: "PreToolUse" });
  }

  /**
   * The flag-only pre-check `CodeToolRuntime` uses to keep a disabled feature off the hot path. A flag that
   * cannot be read is `false` (dark launch), and the real gate re-runs inside `runProjectHooks`.
   */
  async active(input: { ctx: AuthContext; companyId: string }): Promise<boolean> {
    try {
      return (await this.deps.flags.isEnabled(input.ctx, CODE_HOOKS_FLAG, {
        companyId: input.companyId,
        userId: input.ctx.userId,
      })) === true;
    } catch {
      return false;
    }
  }

  /** `PostToolUse`: observations only. A `block` here is refused by `parseCodeHookResult` (it is too late). */
  postToolUse(input: Omit<CodeHookDispatchInput, "event">): Promise<CodeHookOutcome> {
    return this.dispatch({ ...input, event: "PostToolUse" });
  }

  sessionStart(input: Omit<CodeHookDispatchInput, "event">): Promise<CodeHookOutcome> {
    return this.dispatch({ ...input, event: "SessionStart" });
  }

  stop(input: Omit<CodeHookDispatchInput, "event">): Promise<CodeHookOutcome> {
    return this.dispatch({ ...input, event: "Stop" });
  }

  /**
   * The gate order, fixed and each step load-bearing:
   *   1. feature flag (server-side, on the execution path) — off means the config is not even read;
   *   2. project trust — `isTrusted !== true` means **no read, no parse, no executor call**;
   *   3. read + parse the config (a malformed config runs nothing);
   *   4. execute the hooks of this event, one at a time, aggregating only narrowing results.
   */
  private async runProjectHooks(input: CodeHookDispatchInput): Promise<CodeHookOutcome> {
    const outcome = skippedOutcome(input.event, null);

    let enabled = false;
    try {
      enabled = (await this.deps.flags.isEnabled(input.ctx, CODE_HOOKS_FLAG, {
        companyId: input.companyId,
        userId: input.ctx.userId,
      })) === true;
    } catch {
      enabled = false;
    }
    if (!enabled) {
      outcome.skipped = "flag_disabled";
      await this.recordActivity(input, { result: "skipped", code: "hook_flag_disabled" });
      return outcome;
    }

    let trusted = false;
    try {
      trusted = (await this.deps.trust.isTrusted({
        ctx: input.ctx, companyId: input.companyId, projectId: input.projectId,
      })) === true;
    } catch {
      trusted = false;
    }
    if (!trusted) {
      // The config is repository content. Nothing below this line runs for an untrusted repository: no read,
      // no parse, and above all no call to the hook executor.
      outcome.skipped = "project_untrusted";
      await this.recordActivity(input, { result: "skipped", code: "hook_project_untrusted" });
      return outcome;
    }

    let raw: unknown;
    try {
      raw = await this.deps.readConfig({
        ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, path: CODE_HOOKS_CONFIG_PATH,
      });
    } catch {
      outcome.skipped = "no_config";
      await this.recordActivity(input, { result: "skipped", code: "hook_config_unreadable" });
      return outcome;
    }
    if (raw === null || raw === undefined) {
      outcome.skipped = "no_config";
      return outcome;
    }

    let entries: CodeHookConfigEntry[];
    try {
      entries = parseCodeHookConfig(raw);
    } catch (error) {
      const code = error instanceof CodeHookError ? error.code : "hook_config_invalid";
      outcome.skipped = "no_config";
      outcome.refusals.push(code);
      this.log({ event: input.event, code }, "code_hook_config_refused");
      await this.recordActivity(input, { result: "refused", code });
      return outcome;
    }

    const selected = entries.filter((entry) => entry.event === input.event);
    if (!selected.length) {
      outcome.skipped = "no_hooks_for_event";
      return outcome;
    }

    for (const entry of selected) {
      outcome.invocations += 1;
      const started = this.now().getTime();
      let printed: string;
      try {
        printed = await this.executeHook(entry, input);
      } catch (error) {
        const code = error instanceof CodeHookError ? error.code : "hook_executor_failed";
        outcome.refusals.push(code);
        this.log({ hookId: entry.id, event: input.event, transport: entry.transport, code }, "code_hook_execution_refused");
        await this.recordActivity(input, { hookId: entry.id, transport: entry.transport, result: "failed", code, durationMs: this.now().getTime() - started });
        continue;
      }

      let result: CodeHookResult;
      try {
        result = parseCodeHookResult(printed, input.event, entry.id);
      } catch (error) {
        const code = error instanceof CodeHookError ? error.code : "hook_result_invalid";
        outcome.refusals.push(code);
        this.log({ hookId: entry.id, event: input.event, transport: entry.transport, code }, "code_hook_result_refused");
        await this.recordActivity(input, { hookId: entry.id, transport: entry.transport, result: "refused", code, durationMs: this.now().getTime() - started });
        continue;
      }

      outcome.executed = true;
      outcome.warnings.push(...result.warnings);
      if (result.context) outcome.context.push(result.context);
      await this.recordActivity(input, {
        hookId: entry.id, transport: entry.transport,
        result: result.block ? "blocked" : "ok",
        warnings: result.warnings.length,
        contextChars: result.context?.text.length ?? 0,
        durationMs: this.now().getTime() - started,
      });

      if (result.block) {
        // A block stops the chain: the first refusal is the answer, and running the remaining hooks of a call
        // that will not happen would be work nobody asked for.
        outcome.blocked = true;
        outcome.blockedBy = result.block.hookId;
        outcome.blockReason = result.block.reason;
        return outcome;
      }
    }
    return outcome;
  }

  /** Runs one hook through its configured transport. No transport means a refusal, never a host-side fallback. */
  private async executeHook(entry: CodeHookConfigEntry, input: CodeHookDispatchInput): Promise<string> {
    const payload = hookEventPayload(entry.event, input);
    if (entry.transport === "command") {
      const sandbox = this.deps.sandbox;
      if (!sandbox) {
        throw new CodeHookError("hook_transport_unavailable", "A command hook requires the sandbox transport; nothing runs on the application host", 503, { hookId: entry.id });
      }
      const command = `${entry.command} ${quoteHookArgument(JSON.stringify(payload))}`;
      const result = await sandbox.execute(input.ctx, input.companyId, {
        projectId: input.projectId, command, timeoutMs: entry.timeoutMs,
      });
      const output = (result.stdout ?? result.output ?? "").trim();
      if (typeof result.exitCode === "number" && result.exitCode !== 0) {
        // A hook that failed printed no usable verdict. The failure is reported as its own code and never as
        // a block, so a broken formatter cannot refuse work.
        throw new CodeHookError("hook_executor_failed", `Hook ${entry.id} exited with code ${result.exitCode}`, 502, { hookId: entry.id, exitCode: result.exitCode });
      }
      return output;
    }

    const webhook = this.deps.webhook;
    if (!webhook) {
      throw new CodeHookError("hook_transport_unavailable", "A webhook hook requires the webhook transport (SSRF-safe delivery)", 503, { hookId: entry.id });
    }
    // The body is metadata only: no tool arguments, no file content, no config. The destination is validated
    // by the existing webhook stack on *every* delivery (redirects off), so this module needs no URL logic.
    const delivered = await webhook.deliver({
      url: entry.url!,
      body: JSON.stringify({ ...payload, hookId: entry.id }),
      timeoutMs: entry.timeoutMs,
      companyId: input.companyId,
      projectId: input.projectId,
    });
    if (delivered.status < 200 || delivered.status >= 300) {
      throw new CodeHookError("hook_executor_failed", `Hook ${entry.id} endpoint answered ${delivered.status}`, 502, { hookId: entry.id, status: delivered.status });
    }
    return delivered.body;
  }

  /**
   * Activity: **what happened**, never what was said. Hook ids, the event, the transport, a result code,
   * counts and durations — no config body, no command line, no hook output and therefore no secret can
   * reach the store. The `ActivityContentRejectedError` guard is what backs that claim up, and the
   * companion suite writes the events through the real sink to prove it.
   */
  private async recordActivity(input: CodeHookDispatchInput, extra: Record<string, unknown>): Promise<void> {
    const activity = this.deps.activity;
    if (!activity) return;
    const kind: CodeHookActivityEvent["kind"] = input.tool ? "code_tool_activity" : "run_activity";
    try {
      await activity.record({
        kind,
        companyId: input.companyId,
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        runId: input.runId ?? null,
        snapshotId: input.snapshotId ?? null,
        hookEvent: input.event,
        ...(input.tool ? { tool: input.tool } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        ...extra,
      });
    } catch {
      // Bookkeeping never changes a decision and never breaks a run.
    }
  }

  /** Logs carry codes and identifiers only; hook text is deliberately absent. */
  private log(payload: Record<string, unknown>, message: string): void {
    this.deps.logger?.warn({ ...payload, hookSubsystem: "code_hooks" }, message);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}

/**
 * The event payload a hook receives. It is deliberately **metadata only** and carries no argument values:
 * a hook is a program from the repository, and handing it the very bytes a tool is about to write would
 * turn "the repository may observe a call" into "the repository may read everything the agent reads".
 */
export function hookEventPayload(event: CodeHookEvent, input: CodeHookDispatchInput): Record<string, unknown> {
  return {
    event,
    schemaVersion: 1,
    hookEvent: event,
    companyId: input.companyId,
    projectId: input.projectId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.paths && input.paths.length ? { paths: [...input.paths].slice(0, 100) } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

export function createCodeHooksService(deps: CodeHooksDeps): CodeHooksService {
  return new CodeHooksService(deps);
}

/**
 * The narrow port `CodeToolRuntime` consumes. It is deliberately *only* the two tool events: the runtime
 * cannot reach `SessionStart`/`Stop` (the runner owns those) and cannot bypass the flag/trust/read gate,
 * because the gate lives inside the service, not at the call site.
 */
export interface CodeHookToolInput {
  ctx: AuthContext;
  companyId: string;
  projectId: string;
  sessionId?: string;
  runId?: string;
  snapshotId?: string | null;
  tool: string;
  toolCallId: string;
  /** Repository-relative paths this call touches (metadata only). */
  paths?: readonly string[];
}

export interface CodeHooksPort {
  /**
   * Cheap, side-effect-free pre-check: `false` means **no** hook can run, so the caller skips even its own
   * policy probe. It answers from the `code.hooks` flag alone (an in-memory, cached read) and is *not* a
   * security gate — the service re-reads the flag, the trust record and the config for itself on every
   * dispatch. Its only job is to keep a disabled feature off the hot path.
   */
  active(input: { ctx: AuthContext; companyId: string }): Promise<boolean>;
  preToolUse(input: CodeHookToolInput): Promise<CodeHookOutcome>;
  postToolUse(input: CodeHookToolInput): Promise<CodeHookOutcome>;
}

/** The code a withheld hook carries when this layer cannot prove the engine allowed the call. */
export const HOOK_PREFLIGHT_UNRESOLVED = "hook_preflight_unresolved";

export interface CodeHookPolicyPreflightDeps {
  /** The **same** engine instance the executor consults; a second engine would be a second answer. */
  evaluate(request: PolicyRequest): Promise<PolicyResult>;
  /** The migration-target configuration `CodeShellRuntime` resolves, so both requests describe one sandbox. */
  migrationTargets?: () => { productionUrls?: string[]; productionHosts?: string[]; devHosts?: string[] };
}

/**
 * The PreToolUse pre-flight, extracted so it can be tested against the **real** policy engine instead of
 * being an untestable three lines inside the composition root.
 *
 * Most tools need no probe: a `code.fs.*` call is judged by the runtime itself, and the hook runs after
 * the runtime's own approval phase. Two families do need one, because their verdict is made *inside* the
 * executor:
 *
 *   - `code.shell.exec` — `CodeShellRuntime.exec` calls the engine. The probe asks that same engine with the
 *     same inputs, but with `approvalDeferredByBoundary` set, because the approval phase would otherwise
 *     **create a second approval request** for the same command. The deferral leaves
 *     `APPROVAL_DEFERRED_REASON` in `reasons`, and reading that marker is what turns "an approval would be
 *     required" into a withheld hook — the owner's rule is that a hook never runs on an approval-required
 *     path either.
 *   - any other engine-evaluated tool (a dependency operation, process management) — its exact inputs live
 *     in a port this layer cannot reproduce, so the hook is withheld. "Not proven allowed" is the honest
 *     answer, and withholding a hook is always safe: it removes an observation, never a permission.
 *
 * A `deny` from this function **withholds the hook and nothing else**. It cannot refuse a call, cannot
 * approve one, and the executor still evaluates the engine for itself.
 */
export function createCodeHookPolicyPreflight(
  deps: CodeHookPolicyPreflightDeps,
): { evaluate(input: { ctx: AuthContext; companyId: string; projectId: string; sessionId?: string; tool: string; args: Record<string, unknown>; toolCallId: string; runId?: string; agentId?: string }): Promise<{ decision: "allow" | "deny"; code?: string }> } {
  return {
    async evaluate(input) {
      if (input.tool !== "code.shell.exec") {
        if (input.tool.startsWith("code.deps.") || input.tool.startsWith("code.shell.")) {
          return { decision: "deny", code: HOOK_PREFLIGHT_UNRESOLVED };
        }
        return { decision: "allow" };
      }
      const command = typeof input.args.command === "string" ? input.args.command
        : typeof input.args.cmd === "string" ? input.args.cmd
          : typeof input.args.commandLine === "string" ? input.args.commandLine : null;
      if (!command) return { decision: "deny", code: HOOK_PREFLIGHT_UNRESOLVED };
      const targets = deps.migrationTargets?.() ?? {};
      const decision = await deps.evaluate({
        ctx: input.ctx,
        companyId: input.companyId,
        projectId: input.projectId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        tool: "code.shell.exec",
        command,
        toolCallId: input.toolCallId,
        // Mirrors what the shell executor forwards, so both requests describe the same command.
        approved: input.args.approved === true,
        approvalDeferredByBoundary: true,
        migration: {
          sandboxEphemeral: true,
          target: {
            productionUrls: targets.productionUrls,
            productionHosts: targets.productionHosts,
            devHosts: targets.devHosts,
          },
        },
      });
      const approvalDeferred = (decision.reasons ?? []).includes(APPROVAL_DEFERRED_REASON);
      if (decision.decision === "allow" && !approvalDeferred) return { decision: "allow" };
      return { decision: "deny", ...(decision.code ? { code: decision.code } : { code: approvalDeferred ? "approval_required" : "policy_denied" }) };
    },
  };
}
