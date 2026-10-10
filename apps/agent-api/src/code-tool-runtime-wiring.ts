/* The code tool runtime of app.ts - the tool runtime the coding agent calls - extracted in
 * step 2c-6c of docs/refactoring/PLAN.md.
 *
 * Moved verbatim inside a factory: the closure locals arrive as one deps object and the runtime is
 * returned, because the rest of app.ts and the code route wiring still use it.
 */
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "./app";
import { CompanyApprovalsRepository } from "./approvals-repository";
import { createAuditServices } from "./audit-services";
import { CodeApprovalScopeService, resolveApprovalTimeoutMs } from "./code-approval-scope";
import { createCodeAskUserService } from "./code-ask-user-service";
import { CodeAsyncProcessService } from "./code-async-process";
import { isCodeChatWebsite } from "./code-chat-website";
import { gitWriteIntentForTool, sessionBranchName } from "./code-git-workflow";
import { createCodeHookPolicyPreflight, createCodeHooksService } from "./code-hooks";
import { proposePlan, updateSessionTodos } from "./code-plan-tool";
import { PolicyEngine, isReviewSafeTool } from "./code-policy-engine";
import { CodeProtectedBranchService } from "./code-protected-branches";
import { ReadTracker } from "./code-read-tracker";
import { activitySinkForKind, createCodeRunActivitySink } from "./code-run-activity-sink";
import { CodeService } from "./code-service";
import { CodeShellRuntime, resolveMigrationTargetConfig } from "./code-shell-runtime";
import { CodeSubagentDetachedRunner, CodeSubagentOperationService } from "./code-subagent-operations";
import { CodeVerifyRunnerPort, allCanonicalExecutors, runSandboxPostWriteHook } from "./code-tool-executors";
import { CODE_TOOL_SCHEMAS } from "./code-tool-registry";
import { CodeToolRuntime, createProjectWorkspaceReadPort, createProjectWorkspaceWritePort } from "./code-tool-runtime";
import { CodeTurnTracker, codeCheckpointPortFromGit } from "./code-workspace-checkpoint";
import { CodeWorkspaceRevisionGuard } from "./code-workspace-revision";
import { CodingAgentRunner } from "./coding-agent-runner";
import { createCoreServices } from "./core-services";
import { FeatureFlagService } from "./feature-flags";
import { MountedWorkspaceProvider } from "./mounted-workspace-provider";
import { ProjectGitService } from "./project-git-service";
import { ProjectService } from "./project-service";
import { CodeShellRuntimePort } from "./code-tool-executors";
import { CodeApprovalPort } from "./code-workspace-checkpoint";
import { createCodeToolWiring } from "./code-tool-wiring";
import { AuthContext } from "@npati/workspace";

export interface CodeToolRuntimeWiringDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  approvalsRepo: CompanyApprovalsRepository | undefined;
  auditLogService: ReturnType<typeof createAuditServices>["auditLogService"];
  codeActivitySink: ReturnType<typeof createCodeRunActivitySink>;
  codeApprovalPort: CodeApprovalPort | undefined;
  codeApprovalScope: CodeApprovalScopeService;
  codeCheckpointPort: ReturnType<typeof codeCheckpointPortFromGit>;
  codeDepsPort: ReturnType<typeof createCodeToolWiring>["codeDepsPort"];
  codeHooksService: ReturnType<typeof createCodeHooksService>;
  codeProjectWorkspaceWritePort: ReturnType<typeof createProjectWorkspaceWritePort>;
  codeProtectedBranches: CodeProtectedBranchService;
  codeReadTracker: ReadTracker;
  codeSandboxExecPort: { execute: (ctx: AuthContext, companyId: string, request: { projectId: string; command: string; cwd?: string | undefined; timeoutMs?: number | undefined }) => Promise<{ stdout: string; exitCode: number | undefined }> } | undefined;
  codeService: CodeService;
  codeShellRuntimePort: CodeShellRuntimePort | undefined;
  codeSubagentOperationsRef: (() => CodeSubagentOperationService) | undefined;
  codeToolRuntimeRef: CodeToolRuntime | undefined;
  codeTurnTracker: CodeTurnTracker;
  codeVerifyRunnerPort: CodeVerifyRunnerPort | undefined;
  codeWorkspaceRevisions: CodeWorkspaceRevisionGuard;
  describeCodeRunForPullRequest: ReturnType<typeof createCodeToolWiring>["describeCodeRunForPullRequest"];
  enrichedPolicyEngine: PolicyEngine;
  featureFlagService: FeatureFlagService;
  projectGitService: ProjectGitService;
  projectService: ProjectService;
  projectWorkspace: MountedWorkspaceProvider;
  subagentChildRunnerWithAck: CodeSubagentDetachedRunner | undefined;
  trackedProcesses: CodeAsyncProcessService | undefined;
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
}

export function createCodeToolRuntimeWiring(deps: CodeToolRuntimeWiringDeps) {
  const { log, approvalsRepo, auditLogService, codeActivitySink, codeApprovalPort, codeApprovalScope, codeCheckpointPort, codeDepsPort, codeHooksService, codeProjectWorkspaceWritePort, codeProtectedBranches, codeReadTracker, codeSandboxExecPort, codeService, codeShellRuntimePort, codeSubagentOperationsRef, codeToolRuntimeRef, codeTurnTracker, codeVerifyRunnerPort, codeWorkspaceRevisions, config, describeCodeRunForPullRequest, enrichedPolicyEngine, featureFlagService, projectGitService, projectService, projectWorkspace, subagentChildRunnerWithAck, trackedProcesses, workspaceStore } = deps;
  const codeToolRuntime = new CodeToolRuntime({
    flags: featureFlagService,
    store: workspaceStore,
    audit: auditLogService,
    tracker: codeReadTracker,
    limits: config.codeAgentLimits,
    // C2/C3: the canonical implementations are the only executor path; path safety, the sensitive-file
    // policy and the untrusted-data envelope come from `code-tools-*.ts` (no second policy exists).
    executors: allCanonicalExecutors({
      projectLoader: async ({ ctx, companyId, projectId }) => {
        const project = await projectService.get(ctx, companyId, projectId);
        return project && (project.type === "code_project" || isCodeChatWebsite(project)) ? project as never : null;
      },
      // C4: shell/process/verify execution is injected; without these ports those tools fail closed.
      shellRuntime: codeShellRuntimePort,
      verifyRunner: codeVerifyRunnerPort,
      // C4a: dependency inspection/audit/install go through the dependency port, which itself runs the
      // audit and the install through the shell runtime above (so the PolicyEngine still decides).
      deps: codeDepsPort,
      /**
       * C9: `code.ask_user`. This instance is built over the **store only**: it persists the question (and is
       * idempotent per tool call), while the transition to `waiting_for_user` is written by the runner, which
       * owns the run state, the lease and the loop. The split is deliberate — the run-state log is created later
       * in this composition, and a tool service that could not see it would leave a paused question attached to a
       * run that still claimed to be running. The route service below *does* take the run state, because
       * answering and expiring are what resume or release a run.
       *
       * Without this port the tool would be published and dead — the `runCtags` defect class: visible in the
       * Capability Inspector, impossible to run. A missing service fails closed with `tool_not_configured`.
       */
      codeAskUserService: createCodeAskUserService({ store: workspaceStore }),
      /**
       * C9: the planning tools. They change **session metadata** (a plan draft, the todo list) and never the
       * workspace, which is why the policy layer classifies them read-only and why they stay reachable in
       * `plan` mode. The classification is also why they must be idempotent: C6a recovery repeats read-only
       * tool calls, so `proposePlan` de-duplicates by content hash and `updateSessionTodos` replaces the whole
       * list. Classification and retention come from the session itself rather than being invented here, so a
       * stored plan or todo carries the same data class as the session it belongs to (rule 18).
       *
       * Without this port both tools fail closed with `tool_not_configured`: a published tool that cannot run
       * is a defect, and saying so is better than appearing to work.
       */
      planTool: {
        propose: async ({ ctx, companyId, projectId, sessionId, plan, createdBy }) => {
          const session = await codeService.getSession(ctx, companyId, sessionId);
          return proposePlan(workspaceStore, {
            companyId,
            projectId,
            sessionId,
            plan,
            createdBy: createdBy ?? null,
            dataClassification: session.dataClassification,
            retentionClass: session.retentionClass,
          });
        },
        updateTodos: async ({ ctx, companyId, projectId, sessionId, tasks }) => {
          const session = await codeService.getSession(ctx, companyId, sessionId);
          return updateSessionTodos(workspaceStore, {
            companyId,
            projectId,
            sessionId,
            tasks,
            dataClassification: session.dataClassification,
            retentionClass: session.retentionClass,
          });
        },
      },
      /**
       * C8: `code.symbols.outline` runs `ctags` **inside the sandbox**, through the same single transport every
       * other command uses (`codeSandboxExecPort`) — never on the host, because the rule is that code AI executes
       * only in the sandbox, and a host-side `ctags` would read the repository outside every confinement.
       *
       * Until this wiring existed the port was declared, threaded and implemented, but connected to nothing, so
       * the tool always answered `symbols_unavailable`: it was in the registry, visible in the Capability
       * Inspector, and could never work — the same defect class as an unreaped lease.
       *
       * A missing `ctags` in the image is a **normal** state, not a failure: both command forms are attempted and
       * an absent tool returns `null`, which the executor already reports as the structured
       * `symbols_unavailable` so the model simply continues without an outline.
       */
      runCtags: async (input, path) => {
        if (!codeSandboxExecPort) return null;
        const quoted = `'${String(path).replace(/'/g, "'\\''")}'`;
        const attempts = [
          // Universal-ctags JSON form first; the classic form is the fallback for older builds.
          `ctags -f - --output-format=json --fields=+n --sort=no -- ${quoted}`,
          `ctags -f - --fields=+n -n -- ${quoted}`,
        ];
        for (const command of attempts) {
          try {
            const result = await codeSandboxExecPort.execute(input.ctx, input.companyId, {
              projectId: input.projectId,
              command,
            });
            if (result.exitCode === 0 && result.stdout.trim().length > 0) return result.stdout;
          } catch {
            // Try the next form; if both fail the caller reports structured unavailability.
          }
        }
        return null;
      },
      /**
       * C11 (owner decision 2): the `code.git.*` executors. They are **adapters over the existing
       * `ProjectGitService`** — the service is passed as-is, so there is no wrapping layer that could grow a
       * second git implementation, and every rule (the protected-branch hard deny, the approval record bound
       * to the payload hash of the write, the one-operation credential lease) stays where C11 put it.
       *
       * `assertProtectedBranch` and `sessionBranch` are the preconditions: the first is the same decision
       * phase 4b and the git boundary make, the second is the branch the session is supposed to be on.
       */
      git: projectGitService,
      revisions: codeWorkspaceRevisions,
      assertProtectedBranch: async ({ ctx, companyId, intent }) => {
        const decision = await codeProtectedBranches.evaluateGitWrite(ctx, companyId, intent);
        return {
          allowed: decision.allowed,
          branch: decision.branch,
          ...(decision.code ? { code: decision.code } : {}),
          ...(decision.reason ? { reason: decision.reason } : {}),
        };
      },
      sessionBranch: async ({ sessionId }) => (sessionId ? sessionBranchName(sessionId) : null),
      describeRun: describeCodeRunForPullRequest,
      /**
       * C12: the delegation ports.
       *
       *  - `subagentCanonicalTools` is the **published** registry (`listTools()`) — the only universe a parent's
       *    wildcard grant may expand into. It reads through the late holder above so it always reflects the very
       *    runtime these tool calls go through, rather than a copy that could drift from it.
       *  - `subagentChildRunner` delegates the child run to the **same** `CodingAgentRunner` (again through the
       *    late holder, because the runner is built over this runtime). There is no second loop: the executor
       *    validates and intersects, the runner runs. The `subagentScope` it passes is the one interface the
       *    runner already reads for a delegated run, and a child without it is refused rather than widened.
       *  - `subagentActivity` is the same C6b sink every other Activity family writes through, so a delegation
       *    is one more event in the one Activity stream — with its `snapshot_id` and its parent run.
       */
      subagentCanonicalTools: () => codeToolRuntimeRef?.listTools().map((entry) => entry.name) ?? CODE_TOOL_SCHEMAS.map((entry) => entry.name),
      subagentChildRunner: () => subagentChildRunnerWithAck,
      /**
       * Step 5: the detached delegation port. Off by default: `isEnabled` reads `code.async_subagents`, so a
       * deployment that has not enabled it keeps the C12 blocking behaviour with no code path change. The port is
       * a thin adapter over `CodeSubagentOperationService` — the executor keeps every validation and policy
       * decision, the service only reserves durably and starts the child in the background.
       */
      subagentDetached: {
        isEnabled: async ({ ctx, companyId }) => await featureFlagService.isEnabled(ctx, "code.async_subagents", { companyId })
          && !!trackedProcesses && !!workspaceStore.codeProcesses,
        start: async (request) => {
          if (!trackedProcesses || !workspaceStore.codeProcesses) {
            return { status: "refused" as const, code: "tool_not_configured", message: "Detached sub-agents need the durable process store" };
          }
          return codeSubagentOperationsRef!().startDetached({
            ctx: request.ctx,
            companyId: request.companyId,
            projectId: request.projectId,
            sessionId: request.sessionId,
            parentRunId: request.parentRunId,
            parentOwner: request.parentOwner,
            toolCallId: request.toolCallId,
            childRunId: request.childRunId,
            snapshotId: request.snapshotId ?? null,
            agentType: request.resolution.type,
            capabilityProfile: request.resolution.capabilityProfile,
            task: request.task,
            paths: [...request.paths],
            model: request.resolution.model,
            maxTurns: request.resolution.maxTurns,
            maxParallelism: request.resolution.maxParallelism,
            readOnly: request.resolution.readOnly,
            summaryOnly: request.resolution.summaryOnly,
            allowedTools: [...request.allowedTools],
            toolCallingMode: request.resolution.toolCallingMode,
          });
        },
      },
      subagentControls: () => codeSubagentOperationsRef?.(),
      subagentActivity: codeActivitySink,
    }),
    checkpoints: codeCheckpointPort,
    approvals: codeApprovalPort,
    // C5: a standing `session`/`project` rule replaces the one-shot request; `once` keeps the existing
    // payload-bound behaviour. Rules are consulted only after every prohibition has passed.
    approvalRules: { findRule: async (ctx, query) => codeApprovalScope.findRule(ctx, query) },
    // C5: bounded wait for a human decision. No decision inside the window → `approval_timeout` (504)
    // and the change is not applied; the timeout is recorded as an Activity/run event.
    approvalDecision: approvalsRepo ? {
      timeoutMs: resolveApprovalTimeoutMs(process.env),
      wait: async ({ ctx, companyId, approvalId }) => {
        const report = await approvalsRepo!.get(ctx, companyId, approvalId).catch(() => null);
        if (!report) return null;
        if (report.status === "approved") return { status: "approved" as const };
        if (report.status === "rejected") return { status: "rejected" as const, comment: report.decisionNotes ?? null };
        return { status: "pending" as const };
      },
      onTimeout: async ({ approvalId, waitedMs, action }) => {
        await codeApprovalScope.recordTimeout(approvalId, waitedMs);
        log.warn({ approvalId, waitedMs, action, kind: "approval_timeout" }, "code_approval_timeout");
      },
    } : undefined,
    turns: codeTurnTracker,
    writePort: codeProjectWorkspaceWritePort,
    /**
     * C11 (owner decision 13): the read-only repository state for the **approval request** of a git write.
     *
     * "This push would create the repository" is part of what a human approves, so it has to be in the payload
     * the request is created with — and it has to come from the repository, not from the model's arguments.
     * This is the git service's own `inspectRepository` (`lstat` plus two read-only `rev-parse` probes, no
     * `git init`, no write); the git boundary asks the same method again immediately before the write, so both
     * sides of the approval hash are computed from one implementation. A call that fails is treated by the
     * runtime as "state unknown", which claims nothing: a write that really needs initialization is then
     * refused at the boundary as a payload mismatch, never approved.
     */
    repositoryState: {
      inspect: async ({ ctx, companyId, projectId }) => {
        const state = await projectGitService.inspectRepository(ctx, companyId, projectId);
        return { initialized: state.initialized };
      },
    },
    // Formatter/syntax hooks run in the sandbox and only when the deployment configures them; their
    // output is a warning on the tool result and never blocks (or silently rewrites) a change.
    postWriteHooks: codeSandboxExecPort ? {
      format: async ({ ctx, companyId, projectId, paths }) => runSandboxPostWriteHook(codeSandboxExecPort, ctx, companyId, projectId, process.env.NPATI_CODE_FORMAT_COMMAND, paths),
      checkSyntax: async ({ ctx, companyId, projectId, paths }) => runSandboxPostWriteHook(codeSandboxExecPort, ctx, companyId, projectId, process.env.NPATI_CODE_SYNTAX_COMMAND, paths),
    } : undefined,
    toPort: () => createProjectWorkspaceReadPort(projectWorkspace, codeSandboxExecPort),
    activity: activitySinkForKind(codeActivitySink, "code_tool_activity"),
    /**
     * C11 (owner decisions 3 and 10): the two ports the runtime needs to authorise a git tool.
     *
     * `gitPolicy` is the call site where a git **tool** hands its typed intent
     * (`gitWriteIntentFromToolInput`) to the policy engine, so phase 4b judges the protected-branch policy on
     * the same fields the git boundary will write. `approvalDeferredByBoundary` is stated here because this
     * path's approval is enforced with a stronger binding at that boundary — it consumes the record against
     * the payload hash of the exact write. The deferral cannot lift a hard deny: the hard-deny phases have
     * already returned by the time it is read.
     *
     * `reviewScope` is the read-only intent's allowlist, taken from the engine's own `isReviewSafeTool` so
     * "read-only" has exactly one definition.
     */
    gitPolicy: {
      evaluate: async ({ ctx, companyId, projectId, sessionId, tool, args, toolCallId, agentId }) => {
        const intent = gitWriteIntentForTool(tool, args);
        const result = await enrichedPolicyEngine.evaluate({
          ctx, companyId, projectId,
          ...(sessionId ? { sessionId } : {}),
          ...(agentId ? { agentId } : {}),
          tool,
          toolCallId,
          git: intent,
          approvalDeferredByBoundary: true,
        });
        return {
          decision: result.decision === "deny" ? "deny" : result.decision === "require_approval" ? "require_approval" : "allow",
          ...(result.code ? { code: result.code } : {}),
          ...(result.reasons ? { reasons: result.reasons } : {}),
          status: result.status ?? 200,
        };
      },
    },
    reviewScope: { allows: (tool: string) => isReviewSafeTool(tool) },
    revisions: codeWorkspaceRevisions,
    /**
     * C13 (owner decision 1): `PreToolUse`/`PostToolUse` for the canonical tool path. The service owns the
     * flag, trust and config gates, so the runtime cannot dispatch a hook for an untrusted repository even if
     * it wanted to.
     */
    hooks: codeHooksService,
    /**
     * C13: the policy pre-flight that keeps a hook off a denied path when the engine's verdict is made
     * *inside* the executor (`code.shell.exec` consults the engine in `CodeShellRuntime`). The factory lives
     * in `code-hooks.ts` so the ordering claim is tested against this same, real engine rather than against
     * a copy of the logic. It is advisory in one direction only: `deny` withholds the hook, `allow`
     * authorises nothing, and the executor still asks the engine for itself.
     */
    preToolPolicy: createCodeHookPolicyPreflight({
      evaluate: (request) => enrichedPolicyEngine.evaluate(request),
      migrationTargets: () => resolveMigrationTargetConfig(),
    }),
  });

  return {
    codeToolRuntime,
  };
}
