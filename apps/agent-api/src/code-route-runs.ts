import { DEVELOPMENT_PROCESS_SETTINGS_KEY, type DevelopmentProcess } from "@npati/shared";
import { resolveCodingConversationLanguage, codingChatResponseInstruction, chatLanguageInstruction } from "./company-chat-i18n";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { CodeRouteDeps } from "./code-route-wiring";
import { CodeBackgroundRunRegistry } from "./code-background-run-registry";
import { registerCodeBackgroundRunRoutes } from "./code-background-run-routes";
import { hasCodeChatPreview, isCodeChatWebsite } from "./code-chat-website";
import { registerCodeCliRunRoutes } from "./code-cli-run-routes";
import { CodeDataErasureService } from "./code-data-erasure";
import { registerCodeQueueStatusRoutes } from "./code-queue-status-routes";
import { ReplayBundleReadPort, readReplayBundle } from "./code-replay-bundle";
import { activitySinkForKind } from "./code-run-activity-sink";
import { createCodeRunAdmission } from "./code-run-admission";
import { CodeRunQueue, resolveCodeRunQueueLimits } from "./code-run-queue";
import { CodeRunRateLimiter, resolveCodeRunRateLimits } from "./code-run-rate-limit";
import { registerCodeRunStreamRoutes } from "./code-run-stream-routes";
import { CodeService } from "./code-service";
import { registerCodeSessionDurabilityRoutes } from "./code-session-durability-routes";
import { registerCodeSessionExportRoutes } from "./code-session-export-routes";
import { CodeSessionForkService } from "./code-session-fork";
import { CodeSessionResumeService } from "./code-session-resume";
import { CodeSessionRewindService } from "./code-session-rewind";
import { CodeSessionRunExecutor } from "./code-session-run-executor";
import { createCodeRunPolicyComposition } from "./coding-agent-runner";
import { createResumeEnvironmentAdmission } from "./execution-snapshot";
import { CODE_AGENT_MASTER_FLAG } from "./feature-flags";
import { AuthContext } from "@npati/workspace";
import type { CodeRbac } from "./code-rbac";
import type { CodeRunCancellationRegistry } from "./code-run-cancellation";
import type { CodeRunPolicyCompositionSources } from "./coding-agent-runner";
import type { CodeRunStateLog } from "./code-run-state";
import type { CodeSessionInboxService } from "./code-session-inbox";
import { CodeProcessCompletionService } from "./code-process-completions";

export interface RegisterCodeRunRoutesInput extends CodeRouteDeps {
  codeRbacForRun: CodeRbac;
  codeRunStateLog: CodeRunStateLog;
  codeRunPolicySources: CodeRunPolicyCompositionSources;
  codeSessionInbox: CodeSessionInboxService;
  codeProcessCompletions: CodeProcessCompletionService | undefined;
  codeRunCancellation: CodeRunCancellationRegistry;
  codeSessionRunExecutor: CodeSessionRunExecutor;
}

export interface RegisterCodeRunRoutesOutputs {
  codeRunQueueLimits: ReturnType<typeof resolveCodeRunQueueLimits>;
  codeRunAdmission: ReturnType<typeof createCodeRunAdmission>;
  codeBackgroundRuns: CodeBackgroundRunRegistry;
  codeErasureContexts: WeakMap<object, AuthContext>;
  codeDataErasure: CodeDataErasureService;
  codeSessionResumeService: CodeSessionResumeService;
}

export function registerCodeRunRoutes(app: FastifyInstance, input: RegisterCodeRunRoutesInput): RegisterCodeRunRoutesOutputs {
  const { log, agent, authProvider, codeActivitySink, codePrivilegedAudit, codeProcessManager, codeService, featureFlagService, notifyMessagingConnections, projectGitService, projectPreviewService, projectSandbox, projectService, projectWorkspace, sandboxImagePolicy, workspaceStore, codeRbacForRun, codeRunStateLog, codeRunPolicySources, codeSessionInbox, codeProcessCompletions, codeRunCancellation, codeSessionRunExecutor } = input;

  const codeRunStreamContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (!/\/code\/runs\/[^/]+\/turns$/.test(path)) return;
    codeRunStreamContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeRunStreamRoutes(app, {
    store: workspaceStore,

    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeRunStreamContexts.get(request as object) ?? null,

    conversationHead: async (companyId, sessionId) => {
      try {
        const head = await workspaceStore.getCodeSessionHead(companyId, sessionId);
        return head ? { runId: head.runId, turnIndex: head.turnIndex } : null;
      } catch {
        return null;
      }
    },
    logger: log,
  });

  const codeDurabilityContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (!/\/code\/(?:sessions\/[^/]+\/(?:resume|rewind|fork)|runs\/[^/]+\/recovery)$/.test(path)) return;
    codeDurabilityContexts.set(request, await authProvider.authenticate(request));
  });
  const codeSessionResumeService = new CodeSessionResumeService({
    flags: featureFlagService,

    inbox: {
      yieldTask: async ({ ctx, companyId, sessionId, runId, owner }) => {
        await codeSessionInbox.yieldTask({ ctx, companyId, sessionId, runId, owner });
      },
    },
    sessions: { get: async (ctx, companyId, sessionId) => codeService.getSession(ctx, companyId, sessionId) },
    runState: codeRunStateLog,
    store: {
      getCodeSessionHead: (companyId, sessionId) => workspaceStore.getCodeSessionHead(companyId, sessionId),
      setCodeSessionHead: (input) => workspaceStore.setCodeSessionHead(input),
      getLatestCodeRunRecoveryNotice: (companyId, runId) => workspaceStore.getLatestCodeRunRecoveryNotice(companyId, runId),
      listCodeContextSummaries: (input) => workspaceStore.listCodeContextSummaries(input),
      listCodeGoals: (input) => workspaceStore.listCodeGoals(input),
      getLatestCodeSessionPlan: (companyId, sessionId) => workspaceStore.getLatestCodeSessionPlan(companyId, sessionId),
      listCodeSessionTodos: (input) => workspaceStore.listCodeSessionTodos(input),
      listCodeRunTurns: (companyId, runId) => workspaceStore.listCodeRunTurns(companyId, runId),

      getCodeRunRequest: (companyId, runId) => workspaceStore.getCodeRunRequest(companyId, runId),
    },

    transcript: async ({ companyId, runId }) => {
      const recording = await readReplayBundle({
        store: workspaceStore as unknown as ReplayBundleReadPort,
        companyId,
        runId,
      });
      return recording.kind === "bundle" ? { steps: recording.steps } : null;
    },

    environment: createResumeEnvironmentAdmission({
      store: workspaceStore,
      sources: {
        featureFlags: async ({ ctx, companyId, projectId, sessionId }) =>
          codeRunPolicySources.featureFlags
            ? codeRunPolicySources.featureFlags({ ctx, companyId, projectId, sessionId })
            : null,
        policyComposition: async ({ ctx, companyId, projectId, sessionId }) =>
          createCodeRunPolicyComposition({ ctx, companyId, projectId, sessionId, sources: codeRunPolicySources }),
        providerDataPolicy: async ({ ctx, companyId, projectId, sessionId, recorded }) => {

          const selection = recorded && typeof recorded.modelSelection === "object" && recorded.modelSelection
            ? (recorded.modelSelection as Record<string, unknown>)
            : null;
          const model = selection && typeof selection.model === "string" ? selection.model : undefined;
          return codeRunPolicySources.providerDataPolicy
            ? codeRunPolicySources.providerDataPolicy({ ctx, companyId, projectId, sessionId, ...(model ? { model } : {}) })
            : null;
        },
        sandboxImage: async ({ ctx, companyId, recorded }) => {
          const recordedImage = recorded && typeof recorded.sandboxImage === "object" && recorded.sandboxImage
            ? (recorded.sandboxImage as Record<string, unknown>)
            : null;
          const recordedDigest = recordedImage && typeof recordedImage.digest === "string" ? recordedImage.digest : null;
          if (!recordedDigest) {

            return { recordedDigest: null, status: "unknown" as const, replacement: null, reason: "no_recorded_image" };
          }
          try {
            const images = await workspaceStore.listSandboxImages(ctx);
            const match = images.find((image) => image.digest === recordedDigest) ?? null;
            if (!match) {
              return { recordedDigest, status: "unknown" as const, replacement: null, reason: "image_not_in_catalogue" };
            }
            if (match.status === "revoked") {
              const replacement = await sandboxImagePolicy
                .selectForRollout(ctx, { companyId, variant: match.variant, currentReference: match.reference })
                .catch(() => null);
              return {
                recordedDigest,
                status: "revoked" as const,
                replacement: replacement?.reference ?? null,
                reason: "image_revoked",
              };
            }
            return { recordedDigest, status: "admitted" as const, replacement: null, reason: `status_${match.status}` };
          } catch {
            return { recordedDigest, status: "unknown" as const, replacement: null, reason: "image_check_failed" };
          }
        },
      },
      resolveRole: async () => null,
    }),
    questions: {
      get: async (companyId, questionId) => {
        const question = await workspaceStore.getCodeUserQuestion(companyId, questionId);
        if (!question) return null;
        return {
          questionId: question.id,
          sessionId: question.sessionId,
          runId: question.runId,
          status: question.status,
          answer: question.answer,
          answeredBy: question.answeredBy,
        };
      },
    },

    processes: {
      forfeit: async ({ ctx, sessionId }) => {
        const held = codeProcessManager.list(sessionId).filter((process) => process.state === "running");
        const forfeited: string[] = [];
        const failed: Array<{ processId: string; reason: string }> = [];
        for (const process of held) {
          try {
            const stopped = await codeProcessManager.stop(ctx, sessionId, process.processId);
            if (stopped.state !== "running") forfeited.push(process.processId);
            else failed.push({ processId: process.processId, reason: `still_${stopped.state}` });
          } catch (error) {
            failed.push({ processId: process.processId, reason: error instanceof Error ? error.message : "stop_failed" });
          }
        }
        return { forfeited, failed };
      },
    },

    checkpoints: {
      restore: async ({ ctx, companyId, projectId, checkpointId }) => {
        const outcome = await projectGitService.restoreCheckpoint(ctx, companyId, projectId, checkpointId);
        return {
          restoredCheckpointId: outcome.restoredCheckpoint.id,
          safetyCheckpointId: outcome.backupCheckpoint?.id ?? null,
        };
      },
    },
    linkRun: async ({ ctx, companyId, sessionId, runId }) => {
      try {
        await workspaceStore.updateCodeSession(ctx, companyId, sessionId, { runId, status: "active" });
        return { linked: true };
      } catch (error) {
        return { linked: false, reason: error instanceof Error ? error.message : "session_run_link_failed" };
      }
    },
    activity: activitySinkForKind(codeActivitySink, "run_reconcile"),
    owner: `resume-${process.pid}`,
  });
  const codeSessionRewindService = new CodeSessionRewindService({
    flags: featureFlagService,
    sessions: { get: async (ctx, companyId, sessionId) => codeService.getSession(ctx, companyId, sessionId) },
    store: {
      getCodeSessionHead: (companyId, sessionId) => workspaceStore.getCodeSessionHead(companyId, sessionId),
      setCodeSessionHead: (input) => workspaceStore.setCodeSessionHead(input),
      listCodeRunTurns: (companyId, runId) => workspaceStore.listCodeRunTurns(companyId, runId),
      createCodeSessionRewind: (input) => workspaceStore.createCodeSessionRewind(input),
      reopenCodeSessionRewind: (input) => workspaceStore.reopenCodeSessionRewind(input),
      completeCodeSessionRewind: (input) => workspaceStore.completeCodeSessionRewind(input),
    },

    checkpoints: {
      create: async ({ ctx, companyId, projectId, sessionId, label, runId }) => {
        const checkpoint = await projectGitService.createCheckpoint(ctx, companyId, projectId, {
          name: label,
          description: `Session ${sessionId.slice(0, 12)}: state before a rewind`,
          trigger: "pre_restore",
          ...(runId ? { runId } : {}),
        });
        return { checkpointId: checkpoint.id, commitHash: checkpoint.commitHash ?? null };
      },
      restore: async ({ ctx, companyId, projectId, checkpointId }) => {
        const outcome = await projectGitService.restoreCheckpoint(ctx, companyId, projectId, checkpointId);
        return {
          restoredCheckpointId: outcome.restoredCheckpoint.id,
          safetyCheckpointId: outcome.backupCheckpoint?.id ?? null,
        };
      },
      find: async ({ ctx, companyId, projectId, checkpointId }) => {
        try {
          const checkpoint = await projectGitService.getCheckpoint(ctx, companyId, projectId, checkpointId);
          return { checkpointId: checkpoint.id, runId: checkpoint.runId ?? null };
        } catch {
          return null;
        }
      },
    },
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
  });
  const codeSessionForkService = new CodeSessionForkService({
    flags: featureFlagService,
    sessions: {
      get: async (ctx, companyId, sessionId) => codeService.getSession(ctx, companyId, sessionId),

      create: async (ctx, companyId, projectId, input) => codeService.createSession(ctx, companyId, projectId, input),
    },
    store: {
      getCodeSessionHead: (companyId, sessionId) => workspaceStore.getCodeSessionHead(companyId, sessionId),
      setCodeSessionHead: (input) => workspaceStore.setCodeSessionHead(input),
      getLatestCodeSessionPlan: (companyId, sessionId) => workspaceStore.getLatestCodeSessionPlan(companyId, sessionId),
      createCodeSessionPlan: (input) => workspaceStore.createCodeSessionPlan(input),
      listCodeSessionTodos: (input) => workspaceStore.listCodeSessionTodos(input),
      replaceCodeSessionTodos: (input) => workspaceStore.replaceCodeSessionTodos(input),
      createCodeSessionFork: (input) => workspaceStore.createCodeSessionFork(input),
      reopenCodeSessionFork: (input) => workspaceStore.reopenCodeSessionFork(input),
      completeCodeSessionFork: (input) => workspaceStore.completeCodeSessionFork(input),
    },
    checkpoints: {
      find: async ({ ctx, companyId, projectId, checkpointId }) => {
        try {
          const checkpoint = await projectGitService.getCheckpoint(ctx, companyId, projectId, checkpointId);
          return { checkpointId: checkpoint.id, runId: checkpoint.runId ?? null };
        } catch {
          return null;
        }
      },
    },
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),
  });
  registerCodeSessionDurabilityRoutes(app, {
    resume: codeSessionResumeService,
    rewind: codeSessionRewindService,
    fork: codeSessionForkService,
    recovery: {
      runExists: async (companyId, runId) => (await codeRunStateLog.loadRunState(companyId, runId)) !== null,
      loadNotice: async (companyId, runId) => workspaceStore.getLatestCodeRunRecoveryNotice(companyId, runId),
      countNotices: async (companyId, runId) => {
        const notices = await workspaceStore.listCodeRunRecoveryNotices({ companyId, runId, limit: 200 });
        return notices.length;
      },
    },
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeDurabilityContexts.get(request as object) ?? null,
    logger: log,
  });

  const codeRunQueueLimits = resolveCodeRunQueueLimits(process.env);
  const codeRunQueue = new CodeRunQueue(codeRunQueueLimits);

  const codeRunRateLimits = resolveCodeRunRateLimits(process.env);
  const codeRunRateLimiter = new CodeRunRateLimiter(codeRunRateLimits);
  const codeRunAdmission = createCodeRunAdmission(codeRunQueue, codeRunRateLimiter);

  const codeBackgroundRuns = new CodeBackgroundRunRegistry({
    logger: { warn: (payload, message) => { log.warn(payload as Record<string, unknown>, message ?? "code_background_run_warning"); } },
  });
  codeSessionInbox.setWakeTask(async (ctx, session, signal) => {

    for (;;) {
      if (signal.aborted || !await codeSessionInbox.isEnabled(ctx, session.companyId)) return;

      session = await codeService.getSession(ctx, session.companyId, session.id);
      if (session.status !== "active") return;
      await codeProcessCompletions?.recover(ctx, session);
      await codeSessionInbox.recoverTerminalTask(session);
      const snapshot = await codeSessionInbox.transact(session, { kind: "read" });
      if (snapshot.state.phase === "settled" && snapshot.state.runId) {
        if (codeRunCancellation.hasLiveRun(session.id)) return;
        const state = await codeRunStateLog.loadRunState(session.companyId, snapshot.state.runId);
        if (!state || !["completed", "failed", "cancelled"].includes(state.status)) return;
        if (projectSandbox && projectPreviewService.getSession(session.projectId)?.status !== "running") {
          const project = await projectService.get(ctx, session.companyId, session.projectId);
          if (!(isCodeChatWebsite(project) && project.status === "previewing" && project.previewUrl)) await projectSandbox.releaseAfterRun(ctx, project);
        }
        await codeSessionInbox.transact(session, { kind: "release-task", runId: state.runId });
        continue;
      }
      if (!["idle", "reserved"].includes(snapshot.state.phase) || !snapshot.state.messages.some((m) => m.status === "pending" || m.status === "claimed")) return;
      await codeRbacForRun.authorize(ctx, session.companyId, { action: "code.run.start", permission: "workspace:write", sessionId: session.id });
      const lease = await codeRunAdmission.admit({ workspaceId: ctx.workspaceId, userId: ctx.userId,
        companyId: session.companyId, sessionId: session.id }, { signal, timeoutMs: codeRunQueueLimits.queueTimeoutMs });
      try {

        const task = await codeSessionInbox.transact(session, { kind: "take-task", authorId: ctx.userId });
        const message = task.messages[0];
        if (!message?.runId || signal.aborted) return;
        const sink = codeBackgroundRuns.start({ runId: message.runId, sessionId: session.id, companyId: session.companyId,
          projectId: session.projectId, userId: ctx.userId });
        const projectForLanguage = await projectService.get(ctx, session.companyId, session.projectId);
        const savedBindings = (await workspaceStore.getUserSetting(ctx,DEVELOPMENT_PROCESS_SETTINGS_KEY))?.value;
        const binding = Array.isArray(savedBindings) ? (savedBindings as DevelopmentProcess[]).find(item=>item.companyId===session.companyId && item.sessionId===session.id) : undefined;
        const chatHistory = binding?.conversationId ? (await workspaceStore.getNeutralConversation(ctx,binding.conversationId).catch(()=>({messages:[]}))).messages : [];
        const priorMessages = [...chatHistory.filter(item=>item.role==="user" && Date.parse(item.createdAt)<Date.parse(message.createdAt)), ...snapshot.state.messages.filter(item => !item.completion && item.authorId === ctx.userId && item.createdAt < message.createdAt).map(item=>({role:"user",content:item.text,createdAt:item.createdAt}))].sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt));
        const languageHistory = [{role:"user",content:projectForLanguage.description ?? ""}, ...priorMessages];
        const responseLanguage = resolveCodingConversationLanguage(message.text, languageHistory);
        const outcome = await codeSessionRunExecutor.execute({ ctx, session, prompt: message.text + chatLanguageInstruction(message.text, languageHistory, responseLanguage) + codingChatResponseInstruction(),
          runId: message.runId, initialInboxMessageId: message.id,
          sink: { signal: sink.signal, emitResult: (result) => sink.emit("result", { routed: "code_runner", runId: message.runId, run: result }),
            emitTerminal: (status, reason) => sink.finish(status, reason) },
          abort: (reason) => codeBackgroundRuns.abort(message.runId!, String(reason ?? "Stopped")),
          cancelRequested: () => codeRunCancellation.isSessionCancelled(session.id) });
        if (!await codeSessionInbox.mayCleanup(ctx, session, outcome.result)) return;
        if (projectSandbox && !hasCodeChatPreview(outcome.result) && projectPreviewService.getSession(session.projectId)?.status !== "running") {
          const project = await projectService.get(ctx, session.companyId, session.projectId);
          await projectSandbox.releaseAfterRun(ctx, project);
        }
        await codeSessionInbox.transact(session, { kind: "release-task", runId: message.runId });
        if (outcome.terminalStatus !== "completed") return;
      } finally { lease.release(); }
    }
  });
  app.addHook("onClose", async () => { await codeSessionInbox.close((sessionId) => { codeRunCancellation.abortLiveRuns(sessionId); }); });
  const codeBackgroundRunContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (!/\/code\/runs\/[^/]+\/background(?:-stream|\/abort)?$/.test(path)) return;
    codeBackgroundRunContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeBackgroundRunRoutes(app, {
    registry: codeBackgroundRuns,
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeBackgroundRunContexts.get(request as object) ?? null,

    isBackgroundRunsEnabled: async (ctx, companyId) => {
      try {
        await featureFlagService.assertEnabled(ctx, "code.background_runs", { companyId, userId: ctx.userId });
        return true;
      } catch {
        return false;
      }
    },
    logger: log,
  });

  registerCodeCliRunRoutes(app, {
    auth: authProvider,
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    isCodeRunsEnabled: async (ctx, companyId) => {
      try {
        await featureFlagService.assertEnabled(ctx, CODE_AGENT_MASTER_FLAG, { companyId, userId: ctx.userId });
        return true;
      } catch {
        return false;
      }
    },
    loadProject: async (ctx, companyId, projectId) => {
      const project = await projectService.get(ctx, companyId, projectId).catch(() => null);
      return project ? { id: project.id, type: project.type } : null;
    },
    loadSession: async (ctx, companyId, sessionId) => {
      const session = await codeService.getSession(ctx, companyId, sessionId).catch(() => null);
      return session && session.status !== "archived" ? session : null;
    },
    createSession: async (ctx, companyId, projectId) => codeService.createSession(ctx, companyId, projectId, { mode: "edit" }),

    admit: async (ctx, companyId, sessionId) => codeRunAdmission.admit({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      companyId,
      sessionId,
    }, { timeoutMs: codeRunQueueLimits.queueTimeoutMs }),
    registerRun: ({ runId, ctx, companyId, sessionId, projectId }) => {
      const sink = codeBackgroundRuns.start({
        runId,
        sessionId,
        companyId,
        userId: ctx.userId,
        projectId,

        onTerminal: async (snapshot) => {
          const detail = snapshot.status === "completed"
            ? `Run ${snapshot.runId} finished successfully.`
            : `Run ${snapshot.runId} ended with status ${snapshot.status}${snapshot.reason ? `: ${snapshot.reason}` : "."}`;
          await notifyMessagingConnections({
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            companyId,
            kind: "background_run",
            title: snapshot.status === "completed" ? "Code run completed" : "Code run needs your attention",
            detail,
          }).catch((error) => { log.warn({ err: error, runId }, "code_cli_run_notify_failed"); });
        },
      });
      return {
        signal: sink.signal,
        emitResult: (result) => sink.emit("result", { routed: "code_runner", runId, run: result }),
        emitTerminal: (status, reason) => sink.finish(status, reason),
        abort: (reason?: string) => codeBackgroundRuns.abort(runId, reason ?? "Stopped by an explicit request"),
      };
    },
    execute: async ({ ctx, companyId, projectId, session, prompt, readOnlyIntent, registration, onSettled }) => {
      let outcome: Awaited<ReturnType<CodeSessionRunExecutor["execute"]>> | null = null;
      try {
        outcome = await codeSessionRunExecutor.execute({
          ctx,
          session,
          prompt,

          ...(readOnlyIntent ? { readOnlyIntent: true } : {}),

          sink: {
            signal: registration.signal,

            emitResult: () => {},
            emitTerminal: () => {},
          },
          abort: (reason?: unknown) => { registration.abort(reason instanceof Error ? reason.message : undefined); },
          cancelRequested: () => codeRunCancellation.isSessionCancelled(session.id),
        });
      } finally {

        if (projectSandbox && !hasCodeChatPreview(outcome?.result) && projectPreviewService.getSession(projectId)?.status !== "running" && await codeSessionInbox.mayCleanup(ctx, session, outcome?.result)) {
          try {
            const current = await projectService.get(ctx, companyId, projectId);
            await projectSandbox.releaseAfterRun(ctx, current);
          } catch (error) {
            log.warn({ err: error, projectId }, "code_cli_run_sandbox_release_failed");
          }
        }
        await onSettled({
          terminalStatus: outcome?.terminalStatus ?? "failed",
          reason: outcome?.reason ?? null,
          needsApproval: outcome?.needsApproval ?? false,
        });
        if (outcome) void codeSessionInbox.settled(ctx, session, outcome.result)
          .catch((error) => log.warn({ err: error }, "code_inbox_wake_failed"));
      }
    },
    logger: log,
  });

  registerCodeQueueStatusRoutes(app, {
    auth: authProvider,
    queue: codeRunQueue,
    rateLimits: codeRunRateLimiter,
  });

  const codeExportContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (!/\/code\/runs\/[^/]+\/export$/.test(path)) return;
    codeExportContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeSessionExportRoutes(app, {
    store: workspaceStore,
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeExportContexts.get(request as object) ?? null,
    isExportEnabled: async (ctx, companyId) => {
      try {
        // History export remains available after rollout disablement; ownership/RBAC and secret scanning still apply.
        if (!await featureFlagService.isEnabled(ctx, "coding_agent.enabled", { companyId, userId: ctx.userId })) return true;
        await featureFlagService.assertEnabled(ctx, "code.export", { companyId, userId: ctx.userId });
        return true;
      } catch {
        return false;
      }
    },
    conversationHead: async (companyId, sessionId) => {
      try {
        const head = await workspaceStore.getCodeSessionHead(companyId, sessionId);
        return head ? { runId: head.runId, turnIndex: head.turnIndex } : null;
      } catch {
        return null;
      }
    },
    logger: log,
  });

  const codeErasureContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (!/\/code\/(?:sessions|projects)\/[^/]+\/data$/.test(path)) return;
    codeErasureContexts.set(request, await authProvider.authenticate(request));
  });
  const codeDataErasure = new CodeDataErasureService({
    store: {
      ...(workspaceStore.codeDataLifecycle ? { lifecycle: workspaceStore.codeDataLifecycle } : {}),

      resolveSession: async ({ ctx, companyId, sessionId }) => {
        try {
          const session = await codeService.getSession(ctx, companyId, sessionId);
          return { projectId: session.projectId };
        } catch {
          return null;
        }
      },
      resolveProject: async ({ ctx, companyId, projectId }) => {
        try {
          const project = await projectService.get(ctx, companyId, projectId);
          return { type: project.type };
        } catch {
          return null;
        }
      },
    },
    ...(codePrivilegedAudit ? { audit: codePrivilegedAudit } : {}),

    removeWorkspace: async ({ ctx, companyId, projectId }) => {
      return projectWorkspace.removeProjectWorkspace(ctx, companyId, projectId);
    },
    logger: log,
  });

  return {
    codeRunQueueLimits,
    codeRunAdmission,
    codeBackgroundRuns,
    codeErasureContexts,
    codeDataErasure,
    codeSessionResumeService,
  };
}
