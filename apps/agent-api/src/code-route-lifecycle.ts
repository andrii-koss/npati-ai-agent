import { visionInferenceCandidates } from "./chat-inference-candidates";
import { rememberWebsiteEdit } from "./website-style-context";

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
  const { getCodeSessionResumeService, config, log, activeContextResolver, agent, aiPreferences, codePreferences, marketplace, authProvider, codeActivitySink, codePrivilegedAudit, codeService, featureFlagService, projectGitService, projectPreviewService, projectSandbox, projectService, projectWorkspace, readRuntimeMcpManifest, trackedProcesses, workspaceStore, codeRbacForRun, codeRunStateLog, codeSessionInbox, codeProcessCompletions, codingAgentRunner } = input;
  let codingAgentRunnerRefValue: CodingAgentRunner | undefined;
  let codeSubagentOperationsRefValue: (() => CodeSubagentOperationService) | undefined;
  let subagentChildRunnerWithAckValue: CodeSubagentDetachedRunner | undefined;

  codingAgentRunnerRefValue = codingAgentRunner;

  if (workspaceStore.codeProcesses && codeProcessCompletions) {

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

            ...(readOnlyIntent ? { readOnlyIntent: true } : {}),
            ...(runStateOwner ? { runStateOwner } : {}),
            ...(runDetails ? { runDetails } : {}),
            ...(signal ? { signal } : {}),
            ...(quotaSessionId ? { quotaSessionId } : {}),
            ...(detachedChildInbox ? { detachedChildInbox } : {}),
            ...(initialTurnIndex !== undefined ? { initialTurnIndex } : {}),
            ...(subagentWritePaths ? { subagentWritePaths } : {}),
          }),

        onSettled: (request, outcome) => {
          void codeSubagentOperationsRefValue?.()?.settleChild(request, request.runId, outcome)
            .catch(() => log.warn("code_subagent_settle_failed"));
        },
      }),

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

  const codeRunReconciler = new CodeRunReconciler({
    log: codeRunStateLog,
    activity: activitySinkForKind(codeActivitySink, "run_reconcile"),

    notices: {
      record: async (input) => {
        await workspaceStore.createCodeRunRecoveryNotice(input);
      },
    },
    logger: log,
  });
  // onReady in app.ts initializes the store. Start recovery only after those
  // hooks finish, so a fresh deployment cannot query tables before migrations.
  let codeRunReconcileTimer: ReturnType<typeof setInterval> | undefined;
  app.addHook("onListen", async () => {
    void codeRunReconciler.reconcileRuns().catch((error) => {
      log.warn({ err: error }, "code_run_reconcile_startup_failed");
    });
    codeRunReconcileTimer = setInterval(() => {
      void codeRunReconciler.reconcileRuns().catch((error) => {
        log.warn({ err: error }, "code_run_reconcile_failed");
      });
    }, config.codeAgentLimits?.reaperIntervalMs ?? DEFAULT_CODE_AGENT_LIMITS.reaperIntervalMs);
    codeRunReconcileTimer.unref?.();
  });
  app.addHook("onClose", async () => { if (codeRunReconcileTimer) clearInterval(codeRunReconcileTimer); });

  registerCodeIntentRoutes(app, authProvider, {
    runner: {
      run: async (invocation) => {
        const result = await codingAgentRunner.run({
          ctx: invocation.ctx,
          session: invocation.session as CodeSession,
          prompt: invocation.request,
          ...(invocation.sessionId ? { turnId: invocation.sessionId } : {}),
          ...(invocation.signal ? { signal: invocation.signal } : {}),

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

  const codeReplayContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    if (!/\/code\/(?:runs\/[^/]+\/replay|replay(?:\/|$))/.test(request.url.split("?")[0] ?? "")) return;
    codeReplayContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeReplayRoutes(app, {
    service: new CodeReplayService({
      authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
      loadRecording: async (_ctx, companyId, _projectId, runId) => {

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

      loadReplayById: async (_ctx, companyId, replayId) =>
        getReplayBundleById({ store: workspaceStore as unknown as ReplayBundleReadPort, companyId, replayId }),
      toolVersions: (toolName) => CODE_TOOL_SCHEMAS.find((schema) => schema.name === toolName)?.version ?? null,

      loadRuntimeMcpManifest: async (ctx, companyId) => {

        return readRuntimeMcpManifest({ workspaceId: ctx.workspaceId, companyId });
      },

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

  const codeSnapshotContexts = new WeakMap<object, AuthContext>();

  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    const isSnapshot = /\/code\/(?:runs\/[^/]+\/(?:snapshot|activity)|snapshots(?:\/[^/]+|\/compare))$/.test(path);
    const isSnapshotReplayMetadata = /\/code\/runs\/[^/]+\/replay$/.test(path);
    if (!isSnapshot && !isSnapshotReplayMetadata) return;
    codeSnapshotContexts.set(request, await authProvider.authenticate(request));
  });

  const codeRunCancellation = new CodeRunCancellationRegistry();

  const codeSessionRunExecutor = new CodeSessionRunExecutor({
    runner: codingAgentRunner,
    control: codeRunCancellation,
    resolveVerificationTools: async (input) => {
      const project = await projectService.get(input.ctx, input.session.companyId, input.session.projectId);
      if (!isCodeChatWebsite(project) || input.readOnlyIntent || input.session.mode === "plan") return undefined;
      return project.framework === "HTML/CSS" ? [] : ["build"];
    },
    afterRun: async (input, result) => {
      const finished = await finishCodeChatWebsite(input, result, {
        getProject: (ctx, companyId, projectId) => projectService.get(ctx, companyId, projectId),
        startPreview: async (ctx, companyId, projectId, signal, options) => {
          await featureFlagService.assertEnabled(ctx, "code.shell", { companyId });
          return projectPreviewService.startPreview(ctx, companyId, projectId, { signal, verifiedBuild: !options?.development });
        },
        markFailed: (ctx, companyId, projectId) => projectService.updatePreview(ctx, companyId, projectId, { status: "failed", lastBuildStatus: "failed" }),
        });
      if (input.websiteEdit && !input.noMemory) await rememberWebsiteEdit(workspaceStore, projectWorkspace, input.ctx, input.session, finished)
        .catch(error => log.warn({ err: error }, "website_edit_context_save_failed"));
      return finished;
    },
    resolveModel: async (ctx, input) => {
      const codePrefs = await codePreferences?.get(ctx).catch(() => null);
      if (input.images?.length) {
        const preferences = await aiPreferences.get(ctx);
        const candidates = visionInferenceCandidates([codePrefs?.activeModelId, preferences.routing.defaultModelId, config.omnirouteVisionModel], preferences.addedModels);
        for (const id of candidates) {
          const model = preferences.addedModels.find(item => item.id === id);
          if (model && (!marketplace || (await marketplace.provider(model.providerId).catch(() => null))?.connected)) return id;
        }
        throw new Error("Для роботи з фото потрібна підключена модель із підтримкою зображень. Оберіть її в налаштуваннях AI.");
      }
      if (codePrefs && codePrefs.activeAgentId && codePrefs.activeAgentId !== "npati") {
        const prov = await marketplace?.provider(codePrefs.activeAgentId).catch(() => null);
        if (!prov || !prov.connected) {
          throw new Error(
            `The selected coding agent "${codePrefs.activeAgentName || codePrefs.activeAgentId}" is not connected. Please connect it in Settings > Code or switch to NPATI Coding Agent.`
          );
        }
        if (codePrefs.activeModelId) return codePrefs.activeModelId;
        const provModels = (await marketplace?.models(codePrefs.activeAgentId).catch(() => [])) ?? [];
        const firstChat = provModels.find((m) => isChatCapableModel(m));
        if (firstChat) return firstChat.id;
        return codePrefs.activeAgentId;
      }
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

  const codeLifecycleContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    const isProjectLifecycle = /\/code\/projects\/[^/]+(?:\/(?:archive|unarchive|delete-plan|soft-delete|restore|hard-purge))?$/.test(path)
      || /\/companies\/[^/]+\/projects\/[^/]+\/(?:delete-plan|soft-delete|restore|hard-purge)$/.test(path);
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

      archive: async (ctx, companyId, projectId, expectedRevision) => projectService.archive(ctx, companyId, projectId, expectedRevision),
      delete: async (ctx, companyId, projectId) => { await projectService.delete(ctx, companyId, projectId); },
    },
    sessions: { list: async (ctx, companyId, projectId, options) => codeService.listSessions(ctx, companyId, projectId, options) },

    removeWorkspace: async (ctx, companyId, projectId) => projectWorkspace.removeProjectWorkspace(ctx, companyId, projectId),
    lifecycleService: input.lifecycleService,

    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
    authorize: async (ctx, companyId, inputAction) => codeRbacForRun.authorize(ctx, companyId, inputAction),
    getAuthContext: (request) => codeLifecycleContexts.get(request as object) ?? null,
    logger: log,
  });
  registerCodeSessionControlRoutes(app, {
    sessions: {
      get: async (ctx, companyId, sessionId) => codeService.getSession(ctx, companyId, sessionId),
      list: async (ctx, companyId, projectId, options) => codeService.listSessions(ctx, companyId, projectId, options),
    },
    cancellation: codeRunCancellation,

    runState: async (_ctx, companyId, runId) => {
      try {
        const state = await codeRunStateLog.loadRunState(companyId, runId);
        return state ? { status: state.status, startedAt: state.startedAt, heartbeatAt: state.heartbeatAt } : null;
      } catch {

        return null;
      }
    },

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

    usage: async (_ctx, { companyId, sessionId, runId }) => collectCodeSessionUsage(
      {
        listBundles: async (input) => workspaceStore.listReplayBundles({ companyId: input.companyId, sessionId: input.sessionId, limit: input.limit ?? 200 }),
        listSteps: async (tenant, bundleId) => workspaceStore.listReplayBundleSteps(tenant, bundleId),

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

      all: async (ctx, { companyId, projectId }) => {
        const checkpoints = await projectGitService.listCheckpoints(ctx, companyId, projectId, 50);
        const target = checkpoints.find((checkpoint) => checkpoint.trigger === "pre_run") ?? checkpoints[0];
        if (!target) return { restored: false, files: [], safetyCheckpointId: null, reason: "no_checkpoint_available" };
        const { backupCheckpoint } = await projectGitService.restoreCheckpoint(ctx, companyId, projectId, target.id);
        return { restored: true, files: [], safetyCheckpointId: backupCheckpoint?.id ?? null };
      },

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

    activeContextStore: {
      read: (ctx, companyId) => readCodeActiveContext(workspaceStore, ctx, companyId),
      write: (ctx, companyId, input) => writeCodeActiveContext(workspaceStore, ctx, companyId, input),
    },
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeLifecycleContexts.get(request as object) ?? null,
    logger: log,
  });

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

    store: workspaceStore,

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
