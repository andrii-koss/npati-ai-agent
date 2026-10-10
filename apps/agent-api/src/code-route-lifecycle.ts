/* Replay, lifecycle, session-control, metrics and snapshot routes, extracted from
 * code-route-wiring.ts (step 2c-5b of docs/refactoring/PLAN.md).
 *
 * Moved verbatim, with two documented exceptions: the three late-bound refs are declared here
 * and returned (their assignment happens in this region), and codeSessionResumeService - which
 * the runs part assigns only after this call - is read through a getter, because the only use
 * is inside a callback that runs long afterwards.
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { CodeRouteDeps } from "./code-route-wiring";
import { readCodeActiveContext, writeCodeActiveContext } from "./code-active-context-store";
import { DEFAULT_CODE_AGENT_LIMITS } from "./code-agent-config";
import { registerCodeAgentControlRoutes } from "./code-agent-controls";
import { CodeAsyncWorkspaceService, registerCodeAsyncWorkspaceRoutes } from "./code-async-workspace";
import { finishCodeChatWebsite, isCodeChatWebsite } from "./code-chat-website";
import { registerCodeIntentRoutes } from "./code-intent-routing";
import { collectCodeMetrics } from "./code-metrics";
import { registerCodeMetricsRoutes } from "./code-metrics-routes";
import { registerCodeProjectLifecycleRoutes } from "./code-project-lifecycle-routes";
import { ReplayBundleReadPort, getReplayBundleById, readReplayBundle } from "./code-replay-bundle";
import { CodeReplayService, registerCodeReplayRoutes } from "./code-replay-routes";
import { activitySinkForKind } from "./code-run-activity-sink";
import { CodeRunCancellationRegistry } from "./code-run-cancellation";
import { CodeRunReconciler } from "./code-run-reconciler";
import { readRunEstimate } from "./code-run-state";
import { registerCodeSessionControlRoutes } from "./code-session-control-routes";
import { CodeSessionRunExecutor } from "./code-session-run-executor";
import { collectCodeSessionUsage } from "./code-session-usage";
import { registerCodeSnapshotRoutes } from "./code-snapshot-routes";
import { createCodeSubagentChildRunner } from "./code-subagent-child-runner";
import { CodeSubagentOperationService } from "./code-subagent-operations";
import { CODE_TOOL_SCHEMAS } from "./code-tool-registry";
import { CodingAgentRunner } from "./coding-agent-runner";
import { CODE_AGENT_MASTER_FLAG } from "./feature-flags";
import { ProjectService } from "./project-service";
import { isChatCapableModel, isNonChatSpecialtyModel } from "@npati/omniroute-adapter";
import { codeIntentIsReadOnly } from "@npati/shared";
import { AuthContext, CodeSession } from "@npati/workspace";
import type { CodeRbac } from "./code-rbac";
import type { CodeRunStateLog } from "./code-run-state";
import type { CodeSessionInboxService } from "./code-session-inbox";
import type { CodeSubagentDetachedRunner } from "./code-subagent-operations";
import type { CodeSessionResumeService } from "./code-session-resume";

export interface RegisterCodeLifecycleRoutesInput extends CodeRouteDeps {
  codeRbacForRun: CodeRbac;
  codeRunStateLog: CodeRunStateLog;
  codeSessionInbox: CodeSessionInboxService;
  codeProcessCompletions: unknown;
  codingAgentRunner: CodingAgentRunner;
  getCodeSessionResumeService: () => CodeSessionResumeService;
}

export interface RegisterCodeLifecycleRoutesOutputs {
  codeRunCancellation: CodeRunCancellationRegistry;
  codeSessionRunExecutor: CodeSessionRunExecutor;
  codingAgentRunnerRefValue: CodingAgentRunner | undefined;
  codeSubagentOperationsRefValue: (() => CodeSubagentOperationService) | undefined;
  subagentChildRunnerWithAckValue: CodeSubagentDetachedRunner | undefined;
}

export function registerCodeLifecycleRoutes(app: FastifyInstance, input: RegisterCodeLifecycleRoutesInput): RegisterCodeLifecycleRoutesOutputs {
  const { getCodeSessionResumeService, config, log, activeContextResolver, agent, aiPreferences, authProvider, codeActivitySink, codePrivilegedAudit, codeService, featureFlagService, projectGitService, projectPreviewService, projectSandbox, projectService, projectWorkspace, readRuntimeMcpManifest, trackedProcesses, workspaceStore, codeRbacForRun, codeRunStateLog, codeSessionInbox, codeProcessCompletions, codingAgentRunner } = input;
  let codingAgentRunnerRefValue: CodingAgentRunner | undefined;
  let codeSubagentOperationsRefValue: (() => CodeSubagentOperationService) | undefined;
  let subagentChildRunnerWithAckValue: CodeSubagentDetachedRunner | undefined;
  // C12: the delegation can now reach the runner. Same instance, no second loop.
  codingAgentRunnerRefValue = codingAgentRunner;
  /**
   * Step 5: the delegation service is built **here**, once. It owns no loop, no queue and no channel of its own —
   * the child is run by `codingAgentRunner`, the delegation is one operation in `workspaceStore.codeProcesses`, and
   * the completion travels through `codeProcessCompletions` and the session inbox — and it is built at this line
   * because this is the first point at which every one of those exists.
   */
  if (workspaceStore.codeProcesses && codeProcessCompletions) {
    /**
     * The one child-runner adapter. `runAgent` is the **same** `CodingAgentRunner` instance every other run uses,
     * reached through the late ref because the tool runtime that dispatches `code.agent.spawn` was built above it.
     * The detached path adds two facts to the child's own durable run row (its parent and its lease identity); the
     * blocking path passes neither, so it behaves exactly as C12 left it.
     */
    subagentChildRunnerWithAckValue = {
      ...createCodeSubagentChildRunner({
        loadSession: async ({ ctx, companyId, sessionId }) => codeService.getSession(ctx, companyId, sessionId),
        runAgent: async ({ ctx, session, prompt, model, runId, parentRunId, allowedTools, readOnlyIntent, maxTurns, runStateOwner, runDetails, signal, quotaSessionId, detachedChildInbox, initialTurnIndex, subagentWritePaths }) =>
          codingAgentRunnerRefValue!.run({
            ctx,
            session,
            prompt,
            runId,
            maxTurns,
            subagentScope: { parentRunId, allowedTools: [...allowedTools] },
            ...(model ? { model } : {}),
            // A read-only type (explore/plan/review) travels as the session's own read-only intent, so the runner
            // offers only the review-safe tools and the runtime refuses anything else on the server.
            ...(readOnlyIntent ? { readOnlyIntent: true } : {}),
            ...(runStateOwner ? { runStateOwner } : {}),
            ...(runDetails ? { runDetails } : {}),
            ...(signal ? { signal } : {}),
            ...(quotaSessionId ? { quotaSessionId } : {}),
            ...(detachedChildInbox ? { detachedChildInbox } : {}),
            ...(initialTurnIndex !== undefined ? { initialTurnIndex } : {}),
            ...(subagentWritePaths ? { subagentWritePaths } : {}),
          }),
        /**
         * The detached path's settlement: the adapter is the only place that sees the child run's own summary, and
         * the service turns it into the durable operation's terminal state — which is what releases the parent's
         * cleanup fence and produces the completion the parent collects.
         */
        onSettled: (request, outcome) => {
          void codeSubagentOperationsRefValue?.()?.settleChild(request, request.runId, outcome)
            .catch(() => log.warn("code_subagent_settle_failed"));
        },
      }),
      /**
       * The acknowledgement. It writes one Activity event so a detached child is observably started under its
       * parent; it is best effort by design and never a gate, because the accepted receipt the parent already holds
       * rests on the durable reserve, not on this.
       */
      ack: (request) => {
        void codeActivitySink.record(
          {
            kind: "run_activity", companyId: request.companyId, projectId: request.projectId, sessionId: request.sessionId,
            runId: request.runId, parentRunId: request.parentRunId, parentToolCallId: request.toolCallId,
          },
          { action: "subagent_started", agentType: request.agentType, readOnly: request.readOnly, maxTurns: request.maxTurns },
        ).catch(() => undefined);
      },
    };
    const operations = new CodeSubagentOperationService({
      store: workspaceStore.codeProcesses,
      runState: codeRunStateLog,
      childRunner: () => subagentChildRunnerWithAckValue,
      loadSession: async ({ ctx, companyId, sessionId }) => codeService.getSession(ctx, companyId, sessionId),
      enabled: async ({ ctx, companyId }) => await featureFlagService.isEnabled(ctx, "code.async_subagents", { companyId })
        && !!trackedProcesses && await featureFlagService.isEnabled(ctx, "code.subagents", { companyId })
        && await featureFlagService.isEnabled(ctx, "code.async_processes", { companyId }) && await codeSessionInbox.isEnabled(ctx, companyId),
      controlsEnabled: async ({ ctx, companyId }) => await featureFlagService.isEnabled(ctx, "code.async_agent_control", { companyId }),
      inbox: codeSessionInbox,
      ensureChildSession: async ({ ctx, parent, childRunId }) => codeService.createSession(ctx, parent.companyId, parent.projectId, {
        childKey: childRunId, parentSessionId: parent.id, mode: parent.mode,
        dataClassification: parent.dataClassification, retentionClass: parent.retentionClass,
      }),
      resumeChild: async ({ ctx, companyId, sessionId, runId, owner }) => {
        const boundary = await codeRunStateLog.loadTurnBoundary(companyId, runId);
        if (!boundary) throw Object.assign(new Error("subagent_run_missing"), { code: "subagent_control_unavailable", httpStatus: 409 });
        if (boundary.unknownOutcomeToolCalls.length) return { prompt: "", turnIndex: boundary.lastFinishedTurn, unknownCalls: boundary.unknownOutcomeToolCalls.length };
        const resumed = await getCodeSessionResumeService().resume({ ctx, companyId, sessionId, runId, owner });
        return { prompt: resumed.resumePrompt, turnIndex: Math.max(boundary.lastFinishedTurn, boundary.incompleteTurn?.turnIndex ?? 0), unknownCalls: resumed.unknownOutcomeToolCalls.length };
      },
      spawnTool: "code.agent.spawn",
      /**
       * The completion is delivered through the **existing** Step-4 path: waking the session inbox runs its
       * completion recovery and then its wake task, the same sequence the process outbox already relies on. There is
       * no second delivery channel, and a deployment whose inbox is off simply recovers on the outbox's own timer.
       */
      onSettled: (event) => {
        void codeSessionInbox.wake(event.ctx, event.companyId, event.sessionId)
          .catch(() => log.warn("code_subagent_completion_wake_failed"));
      },
      logger: { warn: (code) => log.warn({ code }, "code_subagent_operation_warning") },
    });
    codeSubagentOperationsRefValue = () => operations;
    app.addHook("onClose", async () => { await operations.close(); });
    registerCodeAgentControlRoutes(app, { service: () => operations, auth: authProvider,
      authorize: (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input) });
  }
  if (workspaceStore.codeProcesses) registerCodeAsyncWorkspaceRoutes(app, {
    service: new CodeAsyncWorkspaceService({ store: workspaceStore.codeProcesses, flags: featureFlagService,
      session: (ctx, companyId, sessionId) => codeService.getSession(ctx, companyId, sessionId) }),
    auth: authProvider, authorize: (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
  });
  // C6a: reconcile runs whose process died. A run that still claims to be running with an expired lease is
  // moved to `interrupted`; read-only calls with an unknown result may be replayed, mutating calls are reported
  // as a doubt and never replayed. This is what turns a crash into a recoverable state instead of a mystery.
  const codeRunReconciler = new CodeRunReconciler({
    log: codeRunStateLog,
    activity: activitySinkForKind(codeActivitySink, "run_reconcile"),
    /**
     * C10: the notice is **persisted** instead of discarded. Until C10 it lived only inside the reconciliation
     * report, and the two call sites below threw the value away with a `.catch()` that logged the error: the one
     * component that knows why a run stopped and which calls are in doubt produced information nobody could read.
     * It is now an append-only row (migration 082) that the recovery route serves and a resume reads.
     */
    notices: {
      record: async (input) => {
        await workspaceStore.createCodeRunRecoveryNotice(input);
      },
    },
    logger: log,
  });
  {
    void codeRunReconciler.reconcileRuns().catch((error) => {
      log.warn({ err: error }, "code_run_reconcile_startup_failed");
    });
    const codeRunReconcileTimer = setInterval(() => {
      void codeRunReconciler.reconcileRuns().catch((error) => {
        log.warn({ err: error }, "code_run_reconcile_failed");
      });
    }, config.codeAgentLimits?.reaperIntervalMs ?? DEFAULT_CODE_AGENT_LIMITS.reaperIntervalMs);
    codeRunReconcileTimer.unref?.();
    app.addHook("onClose", async () => { clearInterval(codeRunReconcileTimer); });
  }
  // C6: the chat entry point for code intents. Additive on purpose — it never intercepts the existing chat
  // stream, so plain chat and Run Company are untouched; a non-code message comes back as `routed: "chat"`.
  // The active project is supplied by the caller (chat UI selection lands in C7); without it the bridge asks
  // the user which project to use instead of guessing.
  registerCodeIntentRoutes(app, authProvider, {
    runner: {
      run: async (invocation) => {
        const result = await codingAgentRunner.run({
          ctx: invocation.ctx,
          session: invocation.session as CodeSession,
          prompt: invocation.request,
          ...(invocation.sessionId ? { turnId: invocation.sessionId } : {}),
          ...(invocation.signal ? { signal: invocation.signal } : {}),
          /**
           * C11 (owner decision 10): the resolved intent decides whether this run may write. The value comes
           * from the same `codeIntentIsReadOnly` predicate the routing decision carries, so a `REVIEW_CODE`
           * run is read-only on the server as well as in the prompt.
           */
          ...(codeIntentIsReadOnly(invocation.intent) ? { readOnlyIntent: true } : {}),
        });
        if (invocation.session && await codeSessionInbox.isEnabled(invocation.ctx, invocation.session.companyId)) {
          if (projectSandbox && await codeSessionInbox.mayCleanup(invocation.ctx, invocation.session as CodeSession, result)) await projectSandbox.releaseAfterRun(invocation.ctx,
            await projectService.get(invocation.ctx, invocation.session.companyId, invocation.session.projectId));
          void codeSessionInbox.settled(invocation.ctx, invocation.session as CodeSession, result)
            .catch((error) => log.warn({ err: error }, "code_inbox_wake_failed"));
        }
        return { status: result.status, reason: result.reason, summary: result.summary };
      },
    },
    isEnabled: async (ctx, companyId) => {
      try {
        await featureFlagService.assertEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId, userId: ctx.userId });
        return true;
      } catch {
        // A disabled (or unavailable) Coding Agent must leave chat behaviour unchanged.
        return false;
      }
    },
    resolveProject: async (ctx, companyId, projectId) => {
      const project = await projectService.get(ctx, companyId, projectId);
      if (!project || (project as { type?: string }).type !== "code_project") return null;
      return { projectId, kind: "code_project" };
    },
    loadSession: async (ctx, companyId, projectId, sessionId) => {
      if (sessionId) return codeService.getSession(ctx, companyId, sessionId);
      const sessions = await codeService.listSessions(ctx, companyId, projectId, { limit: 1 });
      return sessions[0] ?? null;
    },
    logger: log,
  });
  /**
   * C6b: replay routes.
   *
   * A replay is authorized by the shared gate with its own named action (`code.replay.run`), so the permission
   * is derived from the action rather than trusted from the caller. Deterministic replay verifies the recorded
   * bundle and makes **no** provider call and runs **no** tool — the engine has no live port at all, so that is
   * structural. Live replay starts a new run and carries the best-effort notice.
   *
   * The recorded bundle is owned by `code-replay-bundle.ts` (migration 078): its reader and its recorded
   * hashes are used directly, so no canonicalisation is re-implemented here.
   */
  const codeReplayContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    if (!/\/code\/(?:runs\/[^/]+\/replay|replay(?:\/|$))/.test(request.url.split("?")[0] ?? "")) return;
    codeReplayContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeReplayRoutes(app, {
    service: new CodeReplayService({
      authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
      loadRecording: async (_ctx, companyId, _projectId, runId) => {
        // The store implements the bundle read port, so the recorded steps, their canonical hashes and the
        // stored `replayInputHash` all come from the one recording implementation.
        const store = workspaceStore as unknown as ReplayBundleReadPort;
        const [recording, header] = await Promise.all([
          readReplayBundle({ store, companyId, runId }),
          store.getReplayBundle(companyId, runId),
        ]);
        return {
          recording,
          bundleVersion: header?.bundleVersion ?? null,
          terminalStatus: header?.terminalStatus ?? null,
        };
      },
      loadSession: async (ctx, companyId, _projectId, sessionId) =>
        sessionId ? codeService.getSession(ctx, companyId, sessionId) : null,
      // The status route reads by replay id through the bundle module's by-id reader: tenant-scoped in the
      // store, and an unknown or foreign id answers `no_bundle` (the route then returns one identical 404, so
      // it cannot be used to probe another company's replay ids).
      loadReplayById: async (_ctx, companyId, replayId) =>
        getReplayBundleById({ store: workspaceStore as unknown as ReplayBundleReadPort, companyId, replayId }),
      toolVersions: (toolName) => CODE_TOOL_SCHEMAS.find((schema) => schema.name === toolName)?.version ?? null,
      /**
       * C13 (owner decision 6, corrected): the runtime MCP manifest this deployment discovers **now**, read by
       * the **live** replay mode only.
       *
       * Deterministic replay never calls this port: it verifies the run against the manifest the run's own
       * bundle recorded, which is the only value that describes the tool set that run saw and the only one that
       * works in a fresh process. It also means the in-process overlay being empty (a restart, or simply no run
       * of this tenant having discovered anything yet) cannot refuse a replay that is perfectly reproducible.
       *
       * Live replay really discovers: `null` here is then a refusal (`replay_runtime_mcp_manifest_changed`),
       * because "we could not tell" is not "unchanged".
       */
      loadRuntimeMcpManifest: async (ctx, companyId) => {
        // The tenant is the caller's own workspace plus the company, which is exactly the key the overlay was
        // published under — a live replay of another workspace's run cannot resolve this one's manifest.
        return readRuntimeMcpManifest({ workspaceId: ctx.workspaceId, companyId });
      },
      // The status route reads a replay record by id. No such record store exists yet: the bundle read port is
      // keyed by run id and exposes no by-id accessor, and live replay returns its record in the POST response.
      // Until a replay-record store exists the route answers `replay_not_found` — fail-closed and honest,
      // rather than a second store bolted on here.
      live: {
        loadSourceRun: async (ctx, companyId, runId) => {
          const state = await codeRunStateLog.loadRunState(companyId, runId);
          if (!state) return null;
          const snapshot = await workspaceStore.getSnapshotForRun(companyId, runId);
          return {
            projectId: state.projectId,
            sessionId: state.sessionId,
            snapshotId: snapshot?.id ?? null,
            prompt: null,
          };
        },
        // A live replay is a **new** run: no `runId` is passed, so the source run keeps its own identity and
        // the new one gets its own. It really calls the model and the tools through the real runner.
        startRun: async (input) => {
          const result = await codingAgentRunner.run({
            ctx: input.ctx,
            session: input.session,
            prompt: input.prompt,
          });
          if (await codeSessionInbox.isEnabled(input.ctx, input.session.companyId)) {
            if (projectSandbox && await codeSessionInbox.mayCleanup(input.ctx, input.session, result)) await projectSandbox.releaseAfterRun(input.ctx,
              await projectService.get(input.ctx, input.session.companyId, input.session.projectId));
            void codeSessionInbox.settled(input.ctx, input.session, result)
              .catch((error) => log.warn({ err: error }, "code_inbox_wake_failed"));
          }
          return {
            runId: result.runId ?? `${input.sourceRunId}:live`,
            snapshotId: result.snapshotId ? result.snapshotId : null,
            status: result.status,
            ...(result.reason ? { reason: result.reason } : {}),
          };
        },
      },
      onActivity: async (event) => {
        log.info(event, "code_replay_activity");
      },
    }),
    getAuthContext: (request) => codeReplayContexts.get(request as object) ?? null,
  });
  /**
   * C6b: read-only snapshot and Activity surface behind Run Trace.
   *
   * One path-scoped preHandler with its own context map — the same mechanism the session-mode, production,
   * membership, data-policy and replay surfaces use, so there is no second auth path. `/code/runs/:runId/replay`
   * is matched by both this hook and the replay hook above (this module serves the GET metadata route, the
   * replay module serves POST and its own status route), so that one path authenticates twice; that is the
   * cost of keeping both surfaces' contexts independent, and it is a read-only path.
   */
  const codeSnapshotContexts = new WeakMap<object, AuthContext>();
  /**
   * C10 (defect fix): the snapshot map had **no writer**. `registerCodeSnapshotRoutes` was handed a
   * `getAuthContext` that read the map, and nothing ever put a context into it, so every snapshot/compare/
   * Activity/GET-replay request authenticated as `null` and answered 401 — in the built application only,
   * because the suite for this surface builds the routes with its own deps. The hook below is the writer, and
   * `tests/coding-agent-c10-route-auth-wiring.test.ts` fails if it (or any other surface's) is ever dropped.
   *
   * `/code/runs/:runId/replay` is served twice on purpose: this module answers the GET metadata route and the
   * replay module answers POST plus its own status route, so that one read-only path authenticates twice.
   */
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    const isSnapshot = /\/code\/(?:runs\/[^/]+\/(?:snapshot|activity)|snapshots(?:\/[^/]+|\/compare))$/.test(path);
    const isSnapshotReplayMetadata = /\/code\/runs\/[^/]+\/replay$/.test(path);
    if (!isSnapshot && !isSnapshotReplayMetadata) return;
    codeSnapshotContexts.set(request, await authProvider.authenticate(request));
  });
  /**
   * C7: the cancellation registry the Stop route writes to and the agent loop reads from. It is created here,
   * next to the runner it serves, because both the route and the loop must observe the same object; a second
   * registry would make Stop silently ineffective.
   */
  const codeRunCancellation = new CodeRunCancellationRegistry();
  /**
   * C15: the one driver of a code session. Both entry points use this instance — the chat branch of `/chat/stream`
   * and the CLI/IDE run-start route — so the cancellation registration and the terminal-status normalisation are
   * literally the same code, not two copies that agree today. It is built here, next to the cancellation registry
   * it writes to and the runner it drives, because all three must be the same objects the Stop route already uses.
   */
  const codeSessionRunExecutor = new CodeSessionRunExecutor({
    runner: codingAgentRunner,
    control: codeRunCancellation,
    resolveVerificationTools: async (input) => {
      const project = await projectService.get(input.ctx, input.session.companyId, input.session.projectId);
      if (!isCodeChatWebsite(project) || input.readOnlyIntent || input.session.mode === "plan") return undefined;
      return project.framework === "HTML/CSS" ? [] : ["build"];
    },
    afterRun: (input, result) => finishCodeChatWebsite(input, result, {
      getProject: (ctx, companyId, projectId) => projectService.get(ctx, companyId, projectId),
      startPreview: async (ctx, companyId, projectId, signal) => {
        await featureFlagService.assertEnabled(ctx, "code.shell", { companyId });
        return projectPreviewService.startPreview(ctx, companyId, projectId, { signal });
      },
      markFailed: (ctx, companyId, projectId) => projectService.updatePreview(ctx, companyId, projectId, { status: "failed", lastBuildStatus: "failed" }),
    }),
    resolveModel: async (ctx) => {
      const preferences = await aiPreferences.get(ctx);
      const modelId = preferences.routing.defaultModelId;
      if (!modelId) return undefined;
      const model = preferences.addedModels.find((item) => item.id === modelId);
      if (model ? !isChatCapableModel(model) : isNonChatSpecialtyModel({ id: modelId })) {
        throw new Error("The default AI model cannot run coding tasks. Choose a chat model in AI Settings.");
      }
      return modelId;
    },
    logger: { warn: (payload, message) => { log.warn(payload as Record<string, unknown>, message ?? "code_session_run_warning"); } },
  });
  /**
   * C7: the project lifecycle and session-control surfaces.
   *
   * One path-scoped preHandler with its own context map — the same mechanism the session-mode, production,
   * membership, data-policy, snapshot and replay surfaces use, so there is no second auth path.
   */
  const codeLifecycleContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    const isProjectLifecycle = /\/code\/projects\/[^/]+(?:\/(?:archive|unarchive))?$/.test(path);
    const isSessionControl = /\/code\/(?:active-context|sessions\/[^/]+\/(?:stop|usage|changes|changes\/revert))$/.test(path)
      || /\/projects\/[^/]+\/code\/sessions$/.test(path);
    if (!isProjectLifecycle && !isSessionControl) return;
    codeLifecycleContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeProjectLifecycleRoutes(app, {
    projects: {
      list: async (ctx, companyId, includeArchived) => projectService.list(ctx, companyId, includeArchived),
      get: async (ctx, companyId, projectId) => projectService.get(ctx, companyId, projectId),
      rename: async (ctx, companyId, projectId, name, expectedRevision) => projectService.rename(ctx, companyId, projectId, name, expectedRevision),
      // `ProjectService.archive`/`delete` already run their `beforeRemove` hook, which destroys the sandbox and
      // detaches DataBackend artifacts — so the route must not repeat that cleanup.
      archive: async (ctx, companyId, projectId, expectedRevision) => projectService.archive(ctx, companyId, projectId, expectedRevision),
      delete: async (ctx, companyId, projectId) => { await projectService.delete(ctx, companyId, projectId); },
    },
    sessions: { list: async (ctx, companyId, projectId, options) => codeService.listSessions(ctx, companyId, projectId, options) },
    // C7: the on-disk workspace is removed by the service that owns the workspace root, not by this file. The port
    // stays optional in the route, so a deployment without that service still reports `partial` honestly.
    removeWorkspace: async (ctx, companyId, projectId) => projectWorkspace.removeProjectWorkspace(ctx, companyId, projectId),
    // Unarchive has no supported store path today: `updateProject` carries only `{ name?, expectedRevision, code? }`
    // and there is no `unarchiveProject`, so forcing `{ status: "ready" }` would not compile and inventing a store
    // method is outside this step. The hook is therefore left unwired on purpose and the route answers 503
    // `project_unarchive_unavailable` with `unarchive_not_configured` rather than pretending to unarchive.
    // No existing mechanism removes the on-disk workspace (the sandbox hook removes containers only), so it is
    // deliberately left unwired: the delete route then reports `partial` with `workspace_removal_not_configured`
    // instead of claiming bytes were removed.
    // The audit port is one-argument while `AuditLogService.record` takes a context, so the shared
    // `codePrivilegedAudit` adapter is reused here: passing the service directly does not satisfy the port, and a
    // second adapter would be a second way to write the same journal.
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeLifecycleContexts.get(request as object) ?? null,
    logger: log,
  });
  registerCodeSessionControlRoutes(app, {
    sessions: {
      get: async (ctx, companyId, sessionId) => codeService.getSession(ctx, companyId, sessionId),
      list: async (ctx, companyId, projectId, options) => codeService.listSessions(ctx, companyId, projectId, options),
    },
    cancellation: codeRunCancellation,
    // The run a session points at is C6a's durable state, read through the same log the loop writes.
    runState: async (_ctx, companyId, runId) => {
      try {
        const state = await codeRunStateLog.loadRunState(companyId, runId);
        return state ? { status: state.status, startedAt: state.startedAt, heartbeatAt: state.heartbeatAt } : null;
      } catch {
        // A run lookup failure must not hide the session itself.
        return null;
      }
    },
    // The C6 sandbox release path: the project record owns the sandbox id, and `destroy` is idempotent.
    releaseSandbox: async (ctx, { companyId, projectId }) => {
      if (!projectSandbox) return { released: false, reason: "sandbox_runner_not_configured" };
      try {
        const project = await projectService.get(ctx, companyId, projectId);
        if (!project.sandboxId) return { released: true, reason: "no_sandbox" };
        await projectSandbox.releaseAfterRun(ctx, project);
        return { released: true };
      } catch (error) {
        return { released: false, reason: error instanceof Error ? error.message : "sandbox_release_failed" };
      }
    },
    // Usage has two sources, and the answer says which one produced it. Provider-measured tokens come from the C6b
    // replay bundle (the only place per-model-step provider usage is persisted); when no provider reported usage,
    // the runner's own summary is used and marked `estimated: true`. Price is never inferred from tokens, so an
    // unknown cost is `null` with a reason rather than a `0` a dashboard would read as "this run was free".
    usage: async (_ctx, { companyId, sessionId, runId }) => collectCodeSessionUsage(
      {
        listBundles: async (input) => workspaceStore.listReplayBundles({ companyId: input.companyId, sessionId: input.sessionId, limit: input.limit ?? 200 }),
        listSteps: async (tenant, bundleId) => workspaceStore.listReplayBundleSteps(tenant, bundleId),
        // The estimate is persisted with the terminal run state by the runner, so it survives the HTTP response.
        loadRunEstimate: async (tenant, targetRunId) => {
          try {
            const state = await codeRunStateLog.loadRunState(tenant, targetRunId);
            return readRunEstimate(state?.details ?? null);
          } catch {
            return null;
          }
        },
      },
      { companyId, sessionId, runId },
    ),
    // Changes come from the existing workspace reader, reduced to **statistics**: the reader also returns the
    // diff body, and forwarding it here would turn this surface into a new content-egress path. Callers that
    // need the body already have the turn-diff route.
    changes: async (ctx, { companyId, projectId }) => {
      const result = await projectWorkspace.getChanges(ctx, companyId, projectId);
      return {
        summary: result.summary,
        changes: result.changes.map((change) => {
          const lines = change.diff.split(/\r?\n/);
          return {
            path: change.path,
            status: change.status,
            added: lines.filter((line) => /^\+(?!\+)/.test(line)).length,
            removed: lines.filter((line) => /^-(?!--)/.test(line)).length,
          };
        }),
      };
    },
    revert: {
      // Revert brings the workspace back to the newest `pre_run` checkpoint, through the existing checkpoint
      // service — whose mandatory pre-restore safety checkpoint is what makes the action itself reversible.
      all: async (ctx, { companyId, projectId }) => {
        const checkpoints = await projectGitService.listCheckpoints(ctx, companyId, projectId, 50);
        const target = checkpoints.find((checkpoint) => checkpoint.trigger === "pre_run") ?? checkpoints[0];
        if (!target) return { restored: false, files: [], safetyCheckpointId: null, reason: "no_checkpoint_available" };
        const { backupCheckpoint } = await projectGitService.restoreCheckpoint(ctx, companyId, projectId, target.id);
        return { restored: true, files: [], safetyCheckpointId: backupCheckpoint?.id ?? null };
      },
      // Per-file revert makes the named paths match the **checkpoint** state: what existed there is restored and what
      // was created afterwards is removed. It never issues the workspace-wide `reset --hard` + `clean -fd` that `all`
      // uses, because reverting one file must not discard unrelated work.
      files: async (ctx, { companyId, projectId, files }) => {
        const outcome = await projectGitService.restorePaths(ctx, companyId, projectId, { files });
        const revertedAll = outcome.failed.length === 0 && (outcome.restored.length > 0 || outcome.removed.length > 0);
        return {
          restored: revertedAll,
          files: [...outcome.restored, ...outcome.removed],
          removed: outcome.removed,
          safetyCheckpointId: outcome.safetyCheckpointId,
          ...(revertedAll ? {} : { reason: outcome.failed.length > 0 ? `restore_failed:${outcome.failed[0]!.path}` : "no_paths_reverted" }),
        };
      },
    },
    activeContext: {
      resolve: async (ctx, requested) => {
        const resolved = await activeContextResolver.resolve(ctx, requested);
        return {
          contextType: String(resolved.context.contextType),
          companyId: (resolved.context.companyId as string | null | undefined) ?? null,
          projectId: (resolved.context.projectId as string | null | undefined) ?? null,
          projectStatus: resolved.project?.status ?? null,
        };
      },
    },
    // C7: the active code context lives in the EXISTING per-user settings store — the same one the chat project
    // cards use — so "continue in the active project" survives a reload without a second settings system.
    activeContextStore: {
      read: (ctx, companyId) => readCodeActiveContext(workspaceStore, ctx, companyId),
      write: (ctx, companyId, input) => writeCodeActiveContext(workspaceStore, ctx, companyId, input),
    },
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeLifecycleContexts.get(request as object) ?? null,
    logger: log,
  });
  /**
   * C14 (owner decision 3): the metrics surface.
   *
   * One path-scoped preHandler with its own context map — the same mechanism every other code surface uses, so
   * there is no second auth path (and the C10 wiring guard sees this map written).
   *
   * The aggregation reads the two existing readers: the tenant-scoped run rows (`listCodeRunStates`, the C14
   * read over `code_run_states`) and the durable Activity rows (`listCodeActivityEvents`, the same reader the
   * snapshot/Activity surface uses). Nothing is duplicated: `status` is the run's outcome the reaper and the
   * resume already trust, and `details.estimate` is the runner's own summary that `collectCodeSessionUsage`
   * reads back for a single session. A metric the data cannot support answers `null` with a reason — the route
   * forwards that, so the UI shows "unavailable: <reason>" and never a fabricated zero.
   */
  const codeMetricsContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (!/\/code\/metrics$/.test(path)) return;
    codeMetricsContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeMetricsRoutes(app, {
    metrics: async (_ctx, { companyId, since, runLimit, eventLimit }) => collectCodeMetrics(
      {
        listRuns: (input) => workspaceStore.listCodeRunStates({
          companyId: input.companyId,
          ...(input.statuses ? { statuses: input.statuses } : {}),
          ...(input.startedAfter ? { startedAfter: input.startedAfter } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        }),
        listActivityEvents: (input) => workspaceStore.listCodeActivityEvents({
          companyId: input.companyId,
          limit: input.limit ?? 500,
        }),
      },
      {
        companyId,
        since: since ?? null,
        runLimit: runLimit ?? 500,
        eventLimit: eventLimit ?? 500,
      },
    ),
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeMetricsContexts.get(request as object) ?? null,
    logger: log,
  });
  registerCodeSnapshotRoutes(app, {
    // Reads go through the same store the writer uses, so a run's snapshot and its Activity can never be
    // read from a different source than the one that was written.
    store: workspaceStore,
    // The shared C5a gate with named actions (`code.snapshot.read`, `code.activity.read`,
    // `code.replay.read`): the permission is derived from the action, so a read cannot be authorized by
    // handing in a convenient label.
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeSnapshotContexts.get(request as object) ?? null,
    logger: log,
  });

  return {
    codeRunCancellation,
    codeSessionRunExecutor,
    codingAgentRunnerRefValue,
    codeSubagentOperationsRefValue,
    subagentChildRunnerWithAckValue,
  };
}
