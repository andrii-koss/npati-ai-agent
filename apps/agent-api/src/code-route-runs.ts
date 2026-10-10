/* Durability, background and CLI runs, queue, export and data-erasure routes, extracted from
 * code-route-wiring.ts (step 2c-5a of docs/refactoring/PLAN.md).
 *
 * Moved verbatim. The parent module's locals arrive as one flat input object; the wiring this
 * part creates is returned, because the parent both returns it and reads it from a callback
 * that was registered before this call.
 */
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
  /**
   * C7: the agent stream the Code Workspace renders (assistant text and tool calls, in order).
   *
   * The transcript comes from the C6b replay bundle because `code_run_turns.messages` is never written by the
   * runner — so a run without a bundle answers `streamUnavailable` rather than an empty stream. Its own
   * path-scoped context map, same mechanism as every other code surface.
   */
  const codeRunStreamContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (!/\/code\/runs\/[^/]+\/turns$/.test(path)) return;
    codeRunStreamContexts.set(request, await authProvider.authenticate(request));
  });
  registerCodeRunStreamRoutes(app, {
    store: workspaceStore,
    // Read-only surface: the existing `code.changes.read` action carries `workspace:read`, so a caller that
    // may read a run's diff may read its stream and no new permission is invented for the same data.
    authorize: async (ctx, companyId, input) => codeRbacForRun.authorize(ctx, companyId, input),
    getAuthContext: (request) => codeRunStreamContexts.get(request as object) ?? null,
    /**
     * C10: a rewind moves a cursor rather than deleting rows (the replay bundle and the context summaries are
     * append-only at the database level), so the reader has to apply it. The transcript therefore ends at the
     * cursor and the response says where — a shorter transcript without that field would look like lost history.
     */
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
  /**
   * C10: durable session operations — resume, rewind, fork — and the reconciler's recovery notice.
   *
   * The three services are constructed here, next to the objects they orchestrate, and every one of them is
   * injected rather than imported: the run-state log (the lease and the turn boundary), the session service (which
   * owns session creation, including the parent-session and tenant checks), the existing checkpoint service (whose
   * pre-restore safety checkpoint is what makes a rewind reversible), the process registry, the feature flags and
   * the shared C5a gate. Nothing in this step re-implements any of them.
   *
   * One path-scoped preHandler with its own context map — the same mechanism every other code surface uses, so
   * there is no second authentication path.
   */
  const codeDurabilityContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (!/\/code\/(?:sessions\/[^/]+\/(?:resume|rewind|fork)|runs\/[^/]+\/recovery)$/.test(path)) return;
    codeDurabilityContexts.set(request, await authProvider.authenticate(request));
  });
  const codeSessionResumeService = new CodeSessionResumeService({
    flags: featureFlagService,
    /**
     * N1: a resume takes the run's lease and returns the continuation prompt to its caller; it does not drive
     * the loop. Recording that the resumed run yielded the session is what keeps the inbox fence from refusing
     * the continuation it just prepared. `yieldTask` is the same transition the pause path uses, so there is one
     * spelling of "this run is not driving".
     */
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
      // C10: the run's own request, written when the run was created. This is what makes a resume able to quote
      // the user's original words instead of describing an objective derived from a plan.
      getCodeRunRequest: (companyId, runId) => workspaceStore.getCodeRunRequest(companyId, runId),
    },
    /**
     * The transcript is the C6b replay bundle, read through the same reader the run-stream route uses — never
     * `code_run_turns.messages`, which stays the metadata-only turn snapshot it was declared to be (the run's own
     * request travels on the run row, not in a turn).
     */
    transcript: async ({ companyId, runId }) => {
      const recording = await readReplayBundle({
        store: workspaceStore as unknown as ReplayBundleReadPort,
        companyId,
        runId,
      });
      return recording.kind === "bundle" ? { steps: recording.steps } : null;
    },
    /**
     * C10 (Question 2): the environment re-check. It reuses the C6b snapshot store for the read, the versioned
     * write and the content-safe diff, and the same environment readers the run snapshot uses — so a resumed run
     * is compared against exactly the facts that were recorded for it.
     *
     * Only the four families a resume can genuinely answer are re-read; the rest of the run snapshot describes a
     * process that no longer exists. The sandbox image gets its own reader because revocation is not a diff: it
     * is a verdict from the C1b admission policy, and it is what stops a continuation.
     */
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
          /**
           * The provider data policy is keyed by provider **and model**, so the comparison has to ask about the
           * model the run actually used — otherwise a resume would compare policy v3-for-model-A against
           * v3-for-model-B and report a phantom change. The model is read from the run's own recorded snapshot,
           * which is the only place it is named after the process that chose it is gone.
           */
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
            // The run recorded no image fact (a run that never reached sandbox admission). There is nothing to
            // revoke, and saying "unknown" is the honest answer rather than "fine".
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
    /**
     * A resume forfeits whatever the process-local registry still holds for the session. It is never the source of
     * truth for "what is lost" — after a restart the registry is empty, and the durable evidence (unknown-outcome
     * calls) is what names the lost work — but a process this host is still holding must not be inherited by a
     * resumed run that nobody is driving.
     */
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
    // The existing checkpoint service: a restore always creates its own mandatory pre-restore safety checkpoint.
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
        await workspaceStore.updateCodeSession(ctx, companyId, sessionId, { runId });
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
    /**
     * The existing checkpoint service, in the three directions a rewind needs. `restore` is the pre-restore route
     * (its mandatory safety checkpoint is the pre-rewind checkpoint for `code`/`both`), `create` is the explicit
     * pre-rewind checkpoint a conversation-only rewind takes, and `find` resolves an explicitly named checkpoint
     * **through the project**, so a checkpoint of another tenant is simply not found.
     */
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
      // Session creation goes through the service that already owns it: the project, the parent session, the agent
      // and the classification ceiling are all checked there, so a fork cannot bypass a rule a plain create obeys.
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
  /**
   * C10 (ТЗ item 6): the code-run queue. It bounds how many code runs one user and one Company may execute at the
   * same time and serves the waiting ones **fairly** (round-robin across Companies, FIFO inside one), so a busy
   * tenant cannot starve a quiet one. It is in-process on purpose — see `code-run-queue.ts` for why the Redis
   * Company-run stream is the wrong unit of work for a live code run — and every value comes from configuration,
   * clamped, so a typo cannot remove the limit.
   */
  const codeRunQueueLimits = resolveCodeRunQueueLimits(process.env);
  const codeRunQueue = new CodeRunQueue(codeRunQueueLimits);
  /**
   * R1 (section A, item 1): the **periodic** limit — how many runs one user and one Company may **start** per
   * window — and the one admission function both entry points below use. The limiter is a separate object from
   * `route-guard-tiers.ts` on purpose: that one is the Company/Chat HTTP limiter and must keep meaning what it
   * meant, while this one bounds sandbox-holding, budget-spending work. Configuration is
   * `NPATI_CODE_RUN_RATE_LIMIT_PER_USER_PER_PERIOD` / `…_PER_COMPANY_PER_PERIOD` / `…_PERIOD_MS`, clamped.
   */
  const codeRunRateLimits = resolveCodeRunRateLimits(process.env);
  const codeRunRateLimiter = new CodeRunRateLimiter(codeRunRateLimits);
  const codeRunAdmission = createCodeRunAdmission(codeRunQueue, codeRunRateLimiter);
  /**
   * C10 (ТЗ item 5): the background-run registry. A run registered here owns its **own** abort signal, so closing
   * the tab no longer kills it, and its events are buffered with a monotonic sequence so a reconnecting client can
   * be given the tail it missed instead of a gap.
   */
  const codeBackgroundRuns = new CodeBackgroundRunRegistry({
    logger: { warn: (payload, message) => { log.warn(payload as Record<string, unknown>, message ?? "code_background_run_warning"); } },
  });
  codeSessionInbox.setWakeTask(async (ctx, session, signal) => {
    // Admission and execution remain the existing C15 path; the inbox only reserves task identity.
    for (;;) {
      if (signal.aborted || !await codeSessionInbox.isEnabled(ctx, session.companyId)) return;
      // Recheck session mode/status for every queued task, rather than retaining an old grant.
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
        // A different user's queued task must not run using this caller's permissions.
        const task = await codeSessionInbox.transact(session, { kind: "take-task", authorId: ctx.userId });
        const message = task.messages[0];
        if (!message?.runId || signal.aborted) return;
        const sink = codeBackgroundRuns.start({ runId: message.runId, sessionId: session.id, companyId: session.companyId,
          projectId: session.projectId, userId: ctx.userId });
        const outcome = await codeSessionRunExecutor.execute({ ctx, session, prompt: message.text,
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
    /**
     * `code.background_runs` was in the flag schema, in the migration defaults and in the UI in eight locales —
     * and read by exactly one caller (`code-process-manager.ts`). A run that outlives its tab is precisely what
     * that key names, so this is where it becomes a live handle: off means the run keeps the old behaviour and is
     * aborted when the client goes away.
     */
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
  /**
   * C15 (owner decisions 2 and 3): the run-start surface a terminal (`npati code`) and, later, an IDE extension
   * call. It is wired **after** the background-run registry it registers into, because a run this route starts must
   * be readable and streamable through the existing `…/background` and `…/background-stream` routes — that is what
   * makes the CLI's follow-up subscription reuse an existing SSE surface instead of adding a fourth one.
   *
   * Three things are deliberately shared with the chat entry point rather than re-derived:
   *
   *  - the master kill switch (`codeService` reads it too, but a run over an *existing* session would otherwise
   *    bypass it, so it is asserted here as well);
   *  - the **existing** `CodeRunQueue`, so the CLI cannot run more concurrent work than the UI can;
   *  - the **existing** `codeSessionRunExecutor`, so the cancellation registration and the terminal-status
   *    normalisation are the same code the chat branch drives — one loop, one Stop path.
   */
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
    /**
     * R1 (section A, item 5): the CLI/IDE entry point takes its slot from the **same** admission function the
     * chat path uses, so the periodic limit, the two concurrency caps and the fair queue apply to it by
     * construction rather than by a second implementation that has to be kept in step.
     */
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
        // The same terminal hook the chat path uses: a run nobody is watching still says how it ended.
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
          // A read-only request is a narrowing the server enforces (`readOnlyIntent` reaches the tool runtime, which
          // refuses every write on that run), so it is passed through rather than treated as a display preference.
          ...(readOnlyIntent ? { readOnlyIntent: true } : {}),
          // The signal the run executes under is the registry's own, so the existing Stop route and the reconnect
          // surface reach the same run; `abort` routes an abort back through the registry rather than mutating a
          // controller this route owns.
          sink: {
            signal: registration.signal,
            // The events are already in the registry: `CodeSessionRunExecutor` emits its result and terminal state
            // through this same sink, so re-emitting here would put two `terminal` events in one run's buffer.
            emitResult: () => {},
            emitTerminal: () => {},
          },
          abort: (reason?: unknown) => { registration.abort(reason instanceof Error ? reason.message : undefined); },
          cancelRequested: () => codeRunCancellation.isSessionCancelled(session.id),
        });
      } finally {
        // The sandbox is released after the run on every path — success, failure and cancellation — exactly as the
        // chat entry point does. The project is re-read because the pre-run object's `sandboxId` is empty.
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
  /**
   * R1 (section A, item 3): the queue is **visible**. `CodeRunQueue.state()` existed with no caller, so "the run
   * did not start" and "the deployment is at capacity" were indistinguishable from outside. The route is
   * read-only, needs only `workspace:read`, and stays reachable while the feature flags are off — a status page
   * that requires the feature it reports on is useless exactly when it is needed. The answer is projected down
   * to the caller's own Company (`buildCodeQueueStatusView`), so exposing the state cannot leak another tenant's
   * session ids.
   */
  registerCodeQueueStatusRoutes(app, {
    auth: authProvider,
    queue: codeRunQueue,
    rateLimits: codeRunRateLimiter,
  });
  /**
   * C10 (ТЗ item 8): exporting a session to Markdown. The route reads the same transcript reader the Workspace
   * uses, applies the same turn/result bounds and refuses the whole document when either secret scanner finds a
   * credential — so the export cannot become a wider read path than the API it reuses.
   */
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
  /**
   * R1-C (item 13): the right to be forgotten.
   *
   * Export existed; erasure did not — `grep deleteCodeSession|purgeCodeSession|deleteSessionData|eraseSession`
   * returned zero matches, so a user could take their data out and had no way to have it removed. This is the
   * surface that closes it: one route family, two scopes (session, project), the existing RBAC gate with a
   * named action (`code.session.data_erase` → `business:manage`), and the journal written **before** anything
   * is deleted — an audit outage refuses the erasure instead of performing it unrecorded.
   *
   * The answer is the store's own measurement (`outstanding`, `preserved`, `verified`), so "nothing left" is
   * reported with evidence. The on-disk workspace is removed by the mechanism that already owns it — and only
   * for a whole-project erasure: erasing one session must never delete the project's shared directory, which
   * is why `removeWorkspace` is omitted for a session target rather than wired to the same call.
   */
  const codeErasureContexts = new WeakMap<object, AuthContext>();
  app.addHook("preHandler", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (!/\/code\/(?:sessions|projects)\/[^/]+\/data$/.test(path)) return;
    codeErasureContexts.set(request, await authProvider.authenticate(request));
  });
  const codeDataErasure = new CodeDataErasureService({
    store: {
      ...(workspaceStore.codeDataLifecycle ? { lifecycle: workspaceStore.codeDataLifecycle } : {}),
      // Both resolvers are required members of the port: without them the service could not scope the
      // project-scoped families honestly nor refuse a foreign project before the journal records anything.
      //
      // Each lookup is wrapped, and that is the idempotency contract rather than defensive style: a repeat
      // erasure asks for a session that no longer exists, and `CodeService.getSession` answers with an error.
      // Letting it escape would turn "erase twice" into a 500 — the opposite of what a repeatable erasure has
      // to be — so an unknown/foreign id resolves to `null`, which the service reports as `already_erased`.
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
    // Wired through the same preHandler-backed context every other surface uses, so the workspace removal is
    // authorised by the caller's own context rather than by a second authentication path.
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
