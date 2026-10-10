/* The chat stream endpoint, extracted from app.ts (step 2c-7c-a of docs/refactoring/PLAN.md).
 *
 * Moved verbatim; the only edits are the closure locals that became deps
 * (app.log -> log) and the module imports for the code that moved with it.
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { AuthenticationError } from "./auth";
import { ChatAttachmentInput } from "./chat-attachments";
import { conversationTitle, isShortAffirmativeReply, requestsCompositeCompanyDeletionIntent } from "./chat-intent-helpers";
import { publicChatError, publicCompanyRunMessage } from "./chat-public-errors";
import { explicitlyRequestsWebResearch } from "./chat-text-directives";
import { readCodeActiveContext } from "./code-active-context-store";
import { CodeBackgroundRunRegistry } from "./code-background-run-registry";
import { hasCodeChatPreview, isCodeChatWebsite } from "./code-chat-website";
import { resolveChatCodeIntent } from "./code-intent-routing";
import { createCodeRunAdmission } from "./code-run-admission";
import { CodeRunQueue, CodeRunRefusedError, resolveCodeRunQueueLimits } from "./code-run-queue";
import { CodeRunRateLimitedError } from "./code-run-rate-limit";
import { CodeService } from "./code-service";
import { CodeSessionInboxService } from "./code-session-inbox";
import { CodingAgentRunResult } from "./coding-agent-runner";
import { CompanyChatActions } from "./company-chat-actions";
import { CompanyDelegationRuntime, companyRunTelemetryHeaders } from "./company-runtime";
import { createCoreServices } from "./core-services";
import { ActiveSessionLease, ActiveSessionRegistry } from "./distributed-session-registry";
import { EmailChatActions } from "./email-chat-actions";
import { NoMemoryEvaluationResult, PerRequestNoMemoryGate } from "./ephemeral-no-memory-and-rtk";
import { CODE_AGENT_MASTER_FLAG, FeatureFlagService } from "./feature-flags";
import { getLatestChatProjectCard, saveChatProjectCard } from "./project-chat-cards";
import { ProjectOrchestrationError, ProjectOrchestrator, extractCleanProjectName } from "./project-orchestrator";
import { ProjectPreviewService } from "./project-preview-service";
import { ProjectSandboxService } from "./project-sandbox-service";
import { ProjectService } from "./project-service";
import { AdmissionError } from "./resilience-admission-queue";
import { SecurityPolicyViolation } from "./security-guardrails";
import { StorageRateLimitError } from "./storage-protection";
import { WorkspaceChatActions } from "./workspace-chat-actions";
import { ContextValidationError, PROJECT_CARD_DATA_VERSION, ProjectCardData, codeIntentIsReadOnly, defaultHybridRouter } from "@npati/shared";
import { ResearchProgressEvent, ResearchProgressListener } from "@npati/web-research";
import { AuthContext, CodeSession, WorkspaceAccessError, WorkspaceNotFoundError } from "@npati/workspace";
import type { CodeRunCancellationRegistry } from "./code-run-cancellation";
import type { CodeSessionRunExecutor } from "./code-session-run-executor";

export interface ChatStreamRouteDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  activeChatStreams: Map<string,{controller:AbortController;workspaceId:string;userId:string}>;
  activeContextResolver: ReturnType<typeof createCoreServices>["activeContextResolver"];
  activeSessionRegistry: ActiveSessionRegistry;
  agent: ReturnType<typeof createCoreServices>["agent"];
  aiPreferences: ReturnType<typeof createCoreServices>["aiPreferences"];
  authProvider: ReturnType<typeof createCoreServices>["authProvider"];
  codeBackgroundRuns: CodeBackgroundRunRegistry;
  codeRunAdmission: ReturnType<typeof createCodeRunAdmission>;
  codeRunCancellation: CodeRunCancellationRegistry;
  codeRunQueueLimits: ReturnType<typeof resolveCodeRunQueueLimits>;
  codeService: CodeService;
  codeSessionInbox: CodeSessionInboxService;
  codeSessionRunExecutor: CodeSessionRunExecutor;
  companyRuntime: CompanyDelegationRuntime;
  featureFlagService: FeatureFlagService;
  getAIContext: (auth: AuthContext) => Promise<{ model: string }>;
  marketplace: ReturnType<typeof createCoreServices>["marketplace"];
  notifyMessagingConnections: (input: { workspaceId: string; userId: string; companyId: string; agentId?: string | null; kind: "automation" | "background_run" | "approval"; title: string; detail: string }) => Promise<void>;
  persistAutomaticCompanyMemory: (auth: AuthContext, companyId: string, runId: string, prompt: string, runStatus: string, noMemory: boolean) => Promise<unknown>;
  projectOrchestrator: ProjectOrchestrator;
  projectPreviewService: ProjectPreviewService;
  projectSandbox: ProjectSandboxService | undefined;
  projectService: ProjectService;
  runBusinessMessage: (auth: AuthContext, businessId: string, message: string, conversationId: string | undefined, log: { warn(value: unknown, message?: string): void }, progress?: ResearchProgressListener, attachments?: ChatAttachmentInput[], memoryPolicy?: NoMemoryEvaluationResult, signal?: AbortSignal) => Promise<{ message: string; companyAction?: { companyId: string; action: string } }>;
  runNeutralMessage: (auth: AuthContext, message: string, conversationId: string | undefined, attachments?: ChatAttachmentInput[], progress?: ResearchProgressListener, memoryPolicy?: NoMemoryEvaluationResult, onDelta?: (chunk: string) => void, signal?: AbortSignal, managementCompany?: { id: string; name: string }) => Promise<{ message: string; companyAction?: { companyId: string; action: string } }>;
  workspaceStore: ReturnType<typeof createCoreServices>["workspaceStore"];
  boundedResponseChunks: (value: string, maxCharacters?: number) => Iterable<string>;
}

export function registerChatStreamRoutes(app: FastifyInstance, deps: ChatStreamRouteDeps): void {
  const { activeChatStreams, activeContextResolver, activeSessionRegistry, agent, aiPreferences, authProvider, codeBackgroundRuns, codeRunAdmission, codeRunCancellation, codeRunQueueLimits, codeService, codeSessionInbox, codeSessionRunExecutor, companyRuntime, featureFlagService, getAIContext, marketplace, notifyMessagingConnections, persistAutomaticCompanyMemory, projectOrchestrator, projectPreviewService, projectSandbox, projectService, runBusinessMessage, runNeutralMessage, workspaceStore, boundedResponseChunks } = deps;
  app.post<{ Body: {
    message?: string;
    streamId?:string;
    conversationId?: string;
    attachments?: ChatAttachmentInput[];
    contextType?: "none" | "business" | "company" | "project";
    businessId?: string;
    companyId?: string;
    projectId?: string;
    noMemory?: boolean;
    ephemeral?: boolean;
  } }>("/chat/stream", async (request, reply) => {
    /**
     * C10 (ТЗ item 6): the code-run slot for **this** request, taken here — before `reply.hijack()` — so a run
     * that cannot be admitted at all gets an honest HTTP answer instead of a status line that already said 200.
     *
     * The alternative (acquiring inside the code branch) was rejected for exactly that reason: the SSE headers are
     * written before the branch is reached, so a `queue_full`/`queue_timeout` refusal would have had to be
     * smuggled into the event stream while the protocol said the request succeeded.
     *
     * Cost of acquiring before the code intent is known: a request that turns out to be plain chat briefly holds
     * a slot and releases it in the `finally` below. That is why the slot is only taken when the caller named a
     * company **and** a project — the same two facts a code intent requires — so a request that provably cannot
     * start a code run never touches the queue.
     */
    let reservedCodeRunSlot: { lease: Awaited<ReturnType<CodeRunQueue["acquire"]>>; background: boolean } | null = null;
    try {
      const auth = await authProvider.authenticate(request);
      const streamId=request.body.streamId?.trim();
      if(streamId&&!/^[A-Za-z0-9._:-]{8,100}$/.test(streamId))return reply.code(400).send({error:{code:"INVALID_STREAM_ID",message:"Invalid chat stream identifier."}});
      const memoryPolicy = PerRequestNoMemoryGate.evaluate(request.headers, request.body);
      let hasConnectedProviders = true;
      try {
        const connected = await marketplace.marketplace({ tab: "connected", limit: 1 });
        hasConnectedProviders = connected.overview.connectedProviders > 0;
      } catch (err) {
        request.log.warn({ err }, "Marketplace check failed, checking AI preferences fallback");
        const prefs = await aiPreferences.get(auth).catch(() => null);
        hasConnectedProviders = Boolean(prefs?.addedModels?.length);
      }
      if (!hasConnectedProviders) {
        return reply.code(409).send({ error: { code: "AI_PROVIDER_REQUIRED", message: "Connect an AI provider to start using NPATI Agent." } });
      }
      const message = request.body.message?.trim() ?? "";
      if (!message && !request.body.attachments?.length) return reply.code(400).send({ error: { code: "MESSAGE_REQUIRED", message: "Enter a message or attach a photo or voice message." } });

      const overview = await workspaceStore.overview(auth);
      const requestedContext = {
        contextType: request.body.contextType ?? (request.body.projectId ? "project" : request.body.companyId ? "company" : "business"),
        businessId: request.body.businessId ?? ((request.body.contextType === "none" || request.body.contextType === "company" || request.body.contextType === "project" || request.body.companyId || request.body.projectId) ? null : overview.currentBusiness?.id ?? null),
        companyId: request.body.companyId ?? null,
        projectId: request.body.projectId ?? null,
      };

      const resolved = await activeContextResolver.resolveChat(auth, requestedContext, message);

      let activeProjectId = resolved.project?.id ?? null;
      let activeCompanyId = request.body.companyId ?? resolved.company?.id ?? resolved.project?.companyId ?? null;
      const projectIntent = defaultHybridRouter.classifyProject({
        message,
        activeCompanyId,
        activeProjectId,
        hasWorkspace: Boolean(overview.currentBusiness || resolved.company || resolved.project),
      });
      const creatingChatWebsite = (projectIntent.intent === "CREATE_WEBSITE" || projectIntent.intent === "CREATE_PROJECT")
        && projectIntent.targetDetails?.projectType !== "mobile_app";
      // Resolve the conversation binding before admission. Never borrow another conversation's project.
      const boundCard = !creatingChatWebsite && request.body.conversationId && !memoryPolicy.noMemoryActive
        ? await getLatestChatProjectCard(workspaceStore, auth, request.body.conversationId, resolved.business?.id) : null;
      if (boundCard && !request.body.projectId) {
        activeCompanyId = boundCard.companyId;
        activeProjectId = boundCard.projectId ?? boundCard.id;
        await projectService.get(auth, activeCompanyId, activeProjectId);
      }
      if (creatingChatWebsite && !activeCompanyId) {
        const companies = (await workspaceStore.listCompanies(auth)).items;
        if (companies.length === 1) activeCompanyId = companies[0]!.id;
      }
      let preparedChatSession: CodeSession | null = null;
      const chatCodingEnabled = activeCompanyId
        ? await featureFlagService.isEnabled(auth, CODE_AGENT_MASTER_FLAG, { companyId: activeCompanyId, userId: auth.userId }) : false;
      if (chatCodingEnabled && activeCompanyId) {
        if (creatingChatWebsite && !projectIntent.needsClarification && !projectIntent.unsupportedIntentMessage) {
          let project = await codeService.createProject(auth, activeCompanyId,
            { name: extractCleanProjectName(message, projectIntent.targetDetails?.entityName), description: message },
            `chat-website:${auth.userId}:${request.headers["idempotency-key"] ?? streamId ?? crypto.randomUUID()}`);
          const framework = projectIntent.targetDetails?.framework === "HTML/CSS" ? "HTML/CSS" : "Next.js";
          project = await projectOrchestrator.prepareCodingWebsite(auth, project, message, framework);
          await codeService.detectAndPersist(auth, activeCompanyId, project.id);
          activeProjectId = project.id;
          preparedChatSession = await codeService.createSession(auth, activeCompanyId, project.id, { mode: "auto" });
        } else if (activeProjectId) {
          const project = await projectService.get(auth, activeCompanyId, activeProjectId);
          if (isCodeChatWebsite(project) || project.type === "code_project") {
            if (boundCard?.sessionId && (boundCard.projectId ?? boundCard.id) === project.id && boundCard.companyId === activeCompanyId) {
              const session = await codeService.getSession(auth, activeCompanyId, boundCard.sessionId);
              if (session.projectId === project.id && session.status !== "archived") preparedChatSession = session;
            }
            preparedChatSession ??= (await codeService.listSessions(auth, activeCompanyId, project.id, { limit: 1 }))[0] ?? null;
            if (!preparedChatSession && isCodeChatWebsite(project)) {
              await codeService.detectAndPersist(auth, activeCompanyId, project.id);
              preparedChatSession = await codeService.createSession(auth, activeCompanyId, project.id, { mode: "auto" });
            }
          }
        }
      }
      if (!preparedChatSession && projectIntent.intent === "CHAT" && resolved.context.contextType === "business" && !resolved.business) {
        return reply.code(409).send({ error: { code: "BUSINESS_REQUIRED", message: "Complete business setup before starting a streamed research chat." } });
      }

      /**
       * C10 (ТЗ item 6): take the code-run slot now, while an honest HTTP refusal is still possible. The
       * `code.background_runs` flag decides whether this request may keep its run alive after the client goes
       * away; it does **not** decide whether the limit applies, because the limit is a property of the deployment.
       */
      if (activeCompanyId && activeProjectId) {
        let backgroundAllowed = false;
        try {
          await featureFlagService.assertEnabled(auth, "code.background_runs", { companyId: activeCompanyId, userId: auth.userId });
          backgroundAllowed = true;
        } catch {
          backgroundAllowed = false;
        }
        const waitController = new AbortController();
        const abandonWait = () => waitController.abort(new Error("Client disconnected while queued"));
        request.raw.once("close", abandonWait);
        let lease: Awaited<ReturnType<CodeRunQueue["acquire"]>>;
        try {
          /**
           * R1 (section A, item 1): the periodic limit and the queue are entered through the **one** admission
           * function, so the Workspace stream cannot start a run that the CLI would have been refused. Its
           * refusal (`CodeRunRateLimitedError`, a `CodeRunRefusedError`) is handled below with the window's own
           * retry-after.
           */
          lease = await codeRunAdmission.admit(
            {
              workspaceId: auth.workspaceId,
              userId: auth.userId,
              companyId: activeCompanyId,
              sessionId: request.body.conversationId ?? `${activeCompanyId}:${activeProjectId}`,
            },
            { timeoutMs: codeRunQueueLimits.queueTimeoutMs, signal: waitController.signal },
          );
        } finally {
          // The wait is over either way; the listener exists only to cancel a ticket nobody is waiting for.
          request.raw.off("close", abandonWait);
        }
        reservedCodeRunSlot = { background: backgroundAllowed, lease };
      }

      const streamController=new AbortController();
      let distributedChatLease:ActiveSessionLease|undefined;
      if(streamId){
        if(activeChatStreams.has(streamId))return reply.code(409).send({error:{code:"STREAM_ALREADY_ACTIVE",message:"This chat stream is already active."}});
        distributedChatLease = await activeSessionRegistry.acquire(auth.workspaceId, auth.userId, `chat:${streamId}`, 45).catch((err) => {
          request.log.warn({ err }, "Distributed chat lease acquisition failed; proceeding with local lock");
          return undefined;
        });
        if(!distributedChatLease && activeChatStreams.has(streamId))return reply.code(409).send({error:{code:"STREAM_ALREADY_ACTIVE",message:"This chat stream is already active on another API replica."}});
        activeChatStreams.set(streamId,{controller:streamController,workspaceId:auth.workspaceId,userId:auth.userId});
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      });
      reply.raw.flushHeaders();
      let sequence = 0;
      /**
       * C10 (ТЗ item 5): the client's own transport controller. Its signal still reaches the *streaming* work
       * (`runNeutralMessage`, `companyRuntime.execute`) so a disconnect stops writing deltas — but it is **not**
       * the signal a background code run executes under. See the code branch below for who owns that one.
       */
      let codeBackgroundRunId: string | null = null;
      reply.raw.once("close",()=>{
        if(reply.raw.writableEnded)return;
        streamController.abort(new Error("Client disconnected"));
        // A background run owns its own AbortController and its own queue slot, so a closed tab only detaches the
        // viewer. Aborting here would be exactly the defect this step removes: a long task dying mid-write because
        // somebody closed a tab. Stopping it is an explicit act (`/background/abort` or the Stop route), and the
        // run's own `finally` below releases the slot either way.
        if(codeBackgroundRunId) request.log.info({ runId: codeBackgroundRunId }, "code_background_run_detached");
      });
      const send = (event: "progress" | "delta" | "result" | "error" | "code_session" | "code_inbox", data: unknown) => {
        if (reply.raw.destroyed) return;
        sequence += 1;
        reply.raw.write(`id: ${sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
        if(distributedChatLease)void activeSessionRegistry.renew(auth.workspaceId,auth.userId,distributedChatLease,45);
      }, 15_000);

      // C6: end-to-end chat path for CODE intents. It runs the real agent loop over the SAME stream (no
      // second SSE endpoint, no second cancellation mechanism) and only when ALL of these hold: the operator
      // enabled the Coding Agent, a company+project were resolved, the project is a code project, and the
      // classifier recognises a code intent. Every other case — flag off, plain chat, website/mobile
      // project, Run Company, email — falls through to the existing pipeline completely unchanged.
      try {
        const codingEnabled = activeCompanyId
          ? await featureFlagService.isEnabled(auth, CODE_AGENT_MASTER_FLAG, { companyId: activeCompanyId, userId: auth.userId }).catch(() => false)
          : false;
        // C7: "continue this conversation in the active project". When the request names no project, the active
        // context the user persisted (PUT /code/active-context) decides — that is what makes chat resume in the
        // workspace they were last in instead of asking again. An explicit body projectId always wins, and a
        // stored context that no longer validates (archived project, revoked access) is dropped rather than used.
        const storedActiveContext = codingEnabled && activeCompanyId && !activeProjectId
          ? await readCodeActiveContext(workspaceStore, auth, activeCompanyId).catch(() => null)
          : null;
        const effectiveProjectId = activeProjectId ?? storedActiveContext?.projectId ?? null;
        const effectiveSessionId = activeProjectId ? undefined : storedActiveContext?.sessionId ?? undefined;
        const codeProject = codingEnabled && activeCompanyId && effectiveProjectId
          ? await projectService.get(auth, activeCompanyId, effectiveProjectId).catch(() => null)
          : null;
        const codeProjectKind = codeProject ? ((codeProject as { type?: string }).type === "code_project" ? "code_project" : "website") : null;
        const codeDecision = resolveChatCodeIntent({
          message,
          codingEnabled,
          companyId: activeCompanyId,
          projectId: codeProject ? effectiveProjectId : null,
          projectKind: codeProjectKind,
          sessionBound: !!preparedChatSession,
        });
        if (codeDecision.mode === "clarify") {
          send("result", { routed: "clarify", intent: codeDecision.intent, message: codeDecision.message });
          clearInterval(heartbeat);
          if (!reply.raw.writableEnded) reply.raw.end();
          return;
        }
        if (codeDecision.mode === "run" && codeProject) {
          const codeSessions = await codeService.listSessions(auth, activeCompanyId!, effectiveProjectId!, { limit: 1 });
          const storedSession = effectiveSessionId
            ? await codeService.getSession(auth, activeCompanyId!, effectiveSessionId).catch(() => null)
            : null;
          // The stored session is used only when it still belongs to the resolved project and is not archived;
          // otherwise the newest session of that project is used, exactly as before.
          const codeSession = preparedChatSession ?? (storedSession && storedSession.status !== "archived" && storedSession.projectId === effectiveProjectId
            ? storedSession
            : codeSessions[0] ?? null);
          if (!codeSession) {
            send("result", { routed: "clarify", intent: codeDecision.intent, message: "Which project should I work in? Create or select a code session first." });
          } else {
            const runKey = `${codeSession.id}:${Date.now().toString(36)}`;
            if (await codeSessionInbox.isEnabled(auth, codeSession.companyId)) await codeSessionInbox.recoverTerminalTask(codeSession);
            /**
             * C10 (ТЗ items 5–6): the two gates that turn "a code run" into "a code run that survives the tab".
             *
             *  1. `code.background_runs` — the existing sub-flag, read at reservation time above. Off means
             *     nothing about today's behaviour changes.
             *  2. The run queue — one user and one Company may execute a bounded number of code runs at once, and
             *     the waiting ones are served fairly. The slot was taken before the response was hijacked, so a
             *     run that could not be admitted was refused with an HTTP status instead of an event.
             */
            const reserved = reservedCodeRunSlot;
            reservedCodeRunSlot = null;
            const backgroundEnabled = reserved
              ? reserved.background
              : await featureFlagService.assertEnabled(auth, "code.background_runs", { companyId: activeCompanyId!, userId: auth.userId })
                .then(() => true).catch(() => false);
            /**
             * The slot is normally the one taken before `reply.hijack()`, where a refusal can still be an HTTP
             * status. The fallback refuses with the queue's own code instead of waiting: this path is past the point
             * where a 429 could be sent, so holding the request would promise something the transport can no longer
             * report.
             */
            const lease = reserved
              ? reserved.lease
              : codeRunAdmission.canAdmit({ userId: auth.userId, companyId: activeCompanyId! })
                ? await codeRunAdmission.admit({
                  workspaceId: auth.workspaceId, userId: auth.userId, companyId: activeCompanyId!, sessionId: codeSession.id,
                })
                : (() => { throw new CodeRunRefusedError("queue_timeout", "The code run queue is full for this user or Company; the run was not started."); })();
            const backgroundSink = backgroundEnabled
              ? codeBackgroundRuns.start({
                  runId: runKey,
                  sessionId: codeSession.id,
                  companyId: activeCompanyId!,
                  userId: auth.userId,
                  projectId: effectiveProjectId ?? null,
                  /**
                   * ТЗ item 5: completion, failure and an approval request are sent through the **existing**
                   * Integrations channels. The terminal hook is where a run that nobody is watching says so.
                   */
                  onTerminal: async (snapshot) => {
                    const detail = snapshot.status === "completed"
                      ? `Run ${snapshot.runId} finished successfully.`
                      : `Run ${snapshot.runId} ended with status ${snapshot.status}${snapshot.reason ? `: ${snapshot.reason}` : "."}`;
                    await notifyMessagingConnections({
                      workspaceId: auth.workspaceId,
                      userId: auth.userId,
                      companyId: activeCompanyId!,
                      kind: "background_run",
                      title: snapshot.status === "completed" ? "Code run completed" : "Code run needs your attention",
                      detail,
                    }).catch((error) => { request.log.warn({ err: error }, "code_background_run_notify_failed"); });
                  },
                })
              : null;
            const isBackground = backgroundSink !== null;
            if (isBackground) codeBackgroundRunId = runKey;
            send("progress", { routed: "code_runner", intent: codeDecision.intent, projectId: effectiveProjectId, background: isBackground, runId: isBackground ? runKey : null });
            const chatInboxEnabled = !memoryPolicy.noMemoryActive && await codeSessionInbox.isEnabled(auth, activeCompanyId!).catch(() => false);
            if (chatInboxEnabled) send("code_session", { companyId: activeCompanyId, projectId: effectiveProjectId,
              sessionId: codeSession.id, inboxEnabled: true });
            let runResult: unknown;
            /**
             * C15: the loop itself, the cancellation registration and the terminal-status normalisation live in
             * `code-session-run-executor.ts`, because the CLI/IDE run-start route drives the same loop and a second
             * copy of "register the controller, clear a stale Stop, unregister in `finally`" is how a Stop ends up
             * reaching one entry point and not the other. Only the transport differs: this branch adapts the chat
             * SSE writer (`send`) onto the executor's sink, the run-start route passes the background registry's.
             *
             * The sink re-emits the same two chat events the branch emitted before the extraction, in the same
             * order: `result` with the runner's own result (the `result` carrying the project card is still sent
             * below it, once the card exists), then the background run's terminal state.
             */
            const stopInboxObservation = chatInboxEnabled
              ? codeSessionInbox.observe(activeCompanyId!, codeSession.id, (revision) => send("code_inbox", { sessionId: codeSession.id, revision }))
              : () => {};
            const executed = await codeSessionRunExecutor.execute({
              ctx: auth,
              session: codeSession,
              prompt: isCodeChatWebsite(codeProject)
                ? `${message}\n\nWork in this existing website workspace. Start with package.json, the main page and its styles; implement the requested visible website before exploring unrelated files. Read files before editing; preserve working pages and the attached database/auth SDK (lib/project-client.ts). Do not re-scaffold or run create-next-app. Use code.deps.install for dependency installation, not compound shell setup commands. Do not start a dev server yourself. Once the requested edits are made, finish your response: the system runs the production build and starts Live Preview.`
                : message,
              // C11 (owner decision 10): `REVIEW_CODE` is a read-only intent, and this is the flag the runtime
              // refuses writes on. It is derived from the routing decision, never from the message.
              ...(codeIntentIsReadOnly(codeDecision.intent) ? { readOnlyIntent: true } : {}),
              sink: {
                signal: isBackground ? backgroundSink!.signal : streamController.signal,
                emitResult: (result) => { send("result", { routed: "code_runner", intent: codeDecision.intent, run: result }); },
                emitTerminal: (status, reason) => { backgroundSink?.finish(status, reason); },
              },
              abort: isBackground
                ? (reason?: unknown) => { codeBackgroundRuns.abort(runKey, reason instanceof Error ? reason.message : "Stopped by request"); }
                : (reason?: unknown) => { streamController.abort(reason instanceof Error ? reason : new Error("Client disconnected")); },
              cancelRequested: () => codeRunCancellation.isSessionCancelled(codeSession.id),
            }).finally(stopInboxObservation);
            runResult = executed.result;
            if (chatInboxEnabled) {
              try {
                const { state } = await codeSessionInbox.transact(codeSession, { kind: "read" });
                send("code_inbox", { sessionId: codeSession.id, revision: state.revision });
              } catch { request.log.warn("code_inbox_chat_snapshot_unavailable"); }
            }
            const runTerminalStatus = executed.terminalStatus;
            const runReason = executed.reason;
            const needsApproval = executed.needsApproval;
            /**
             * ТЗ item 5: an approval request is pushed over the **existing** Integrations channels, because a run
             * that stopped for a human decision and told nobody is a run that never continues. The detection is
             * structural rather than guessed: the run's own status (`waiting_for_user`), the verification
             * summary's `remaining` code, or the run's machine-readable refusal code.
             *
             * It is sent whenever there is a decision to make, also when the run is not a background run — an
             * approval needs an answer either way, and the connection's own `notifications` switches decide
             * whether anything is delivered at all.
             */
            if (needsApproval) {
              try {
                await notifyMessagingConnections({
                  workspaceId: auth.workspaceId,
                  userId: auth.userId,
                  companyId: activeCompanyId!,
                  kind: "approval",
                  title: "Code run needs your approval",
                  detail: `Run ${runKey} in "${codeProject?.name ?? "the project"}" is waiting for a decision${runReason ? ` (${runReason})` : ""}. Open the Code Workspace to approve or deny it.`,
                });
              } catch (error) {
                request.log.warn({ err: error }, "code_run_approval_notify_failed");
              }
            }
            // C6/C10: release the sandbox after the run — on success, failure and cancellation. The project
            // object that `destroy` needs is read **fresh**: `codeProject` above was loaded before the run, so
            // its `sandboxId` is the pre-run value and is normally empty (the run creates the sandbox), which
            // made this a no-op that leaked a live sandbox on every code run. Re-reading is what makes the
            // release real, and it is asserted in `tests/coding-agent-c10-sandbox-retention.test.ts`.
            if (projectSandbox && !hasCodeChatPreview(runResult) && projectPreviewService.getSession(effectiveProjectId!)?.status !== "running" && await codeSessionInbox.mayCleanup(auth, codeSession, runResult)) {
              try {
                const current = await projectService.get(auth, activeCompanyId!, effectiveProjectId!);
                await projectSandbox.releaseAfterRun(auth, current);
              } catch (error) {
                request.log.warn({ err: error }, "code_run_sandbox_release_failed");
              }
            } else {
              request.log.warn({ projectId: activeProjectId }, "code_run_sandbox_release_unavailable");
            }
            lease.release();
            void codeSessionInbox.settled(auth, codeSession, runResult)
              .catch((error) => request.log.warn({ err: error }, "code_inbox_wake_failed"));
            // C7: the chat answer carries a card for the code project/session, so the conversation offers
            // "Open Workspace" and "Changes" without the user hunting for the project. It is built from what the
            // run actually reported (never from a guess) and persisted through the existing chat-card store.
            const finishedRun = runResult && typeof runResult === "object" ? (runResult as Partial<CodingAgentRunResult>) : null;
            const finishedProject = await projectService.get(auth, activeCompanyId!, effectiveProjectId!);
            const runStatus = typeof finishedRun?.status === "string" ? finishedRun.status : "unknown";
            const changedFiles = Array.isArray(finishedRun?.summary?.filesChanged) ? finishedRun.summary.filesChanged.length : undefined;
            const codeCard: ProjectCardData = {
              id: codeSession.id,
              projectId: effectiveProjectId ?? undefined,
              companyId: activeCompanyId!,
              name: codeProject?.name ?? "Code project",
              status: runStatus,
              cardVersion: PROJECT_CARD_DATA_VERSION,
              kind: "code_project",
              framework: finishedProject.framework ?? undefined,
              previewUrl: hasCodeChatPreview(runResult) ? finishedProject.previewUrl ?? undefined : undefined,
              lastBuildStatus: finishedProject.lastBuildStatus ?? undefined,
              sessionId: codeSession.id,
              codeMode: codeSession.mode,
              ...(typeof changedFiles === "number" ? { changesCount: changedFiles } : {}),
              ...(typeof finishedRun?.runId === "string" ? { runId: finishedRun.runId } : {}),
            };
            let cardConversationId: string | undefined;
            if (memoryPolicy.writeAllowed) {
              try {
                const conversation = request.body.conversationId
                  ? (await workspaceStore.getNeutralConversation(auth, request.body.conversationId)).conversation
                  : await workspaceStore.createNeutralConversation(auth, conversationTitle(message));
                if (conversation) {
                  cardConversationId = conversation.id;
                  await workspaceStore.appendNeutralMessage(auth, conversation.id, "user", message);
                  const summary = typeof finishedRun?.message === "string" && finishedRun.message
                    ? finishedRun.message
                    : `The code agent finished with status ${runStatus}.`;
                  const assistantMessage = await workspaceStore.appendNeutralMessage(auth, conversation.id, "assistant", summary);
                  await saveChatProjectCard(workspaceStore, auth, conversation.id, assistantMessage.id, codeCard);
                }
              } catch (error) {
                // A card is a convenience: failing to store it must not turn a completed run into a chat error.
                request.log.warn({ err: error }, "code_chat_card_store_failed");
              }
            }
            send("result", {
              routed: "code_runner",
              intent: codeDecision.intent,
              run: runResult,
              projectCard: codeCard,
              message: finishedRun?.message ?? `The code agent finished with status ${runStatus}.`,
              activeContext: { contextType: "project", companyId: activeCompanyId, projectId: effectiveProjectId, businessId: null },
              ...(cardConversationId ? { conversationId: cardConversationId } : {}),
            });
          }
          clearInterval(heartbeat);
          if (!reply.raw.writableEnded) reply.raw.end();
          return;
        }
      } catch (error) {
        request.log.warn({ err: error }, "code_intent_chat_branch_failed");
        send("error", { error: { code: "code_chat_failed", message: error instanceof Error ? error.message : "Coding Agent failed" } });
        clearInterval(heartbeat);
        if (!reply.raw.writableEnded) reply.raw.end();
        return;
      }

      const progress = (event: ResearchProgressEvent) => send("progress", { ...event, timestamp: new Date().toISOString() });
      try {
        if (projectIntent.intent !== "CHAT") {
          let projectResponse;
          if (projectIntent.unsupportedIntentMessage || projectIntent.needsClarification) {
            projectResponse = {
              message: projectIntent.unsupportedIntentMessage ?? projectIntent.clarificationPrompt ?? "Select an active Project.",
              suggestedActions: [],
              activeContext: resolved.context,
            };
          } else {
            let targetCompanyId = activeCompanyId;
            if (!targetCompanyId) {
              const companies = (await workspaceStore.listCompanies(auth)).items;
              if (companies.length === 1) targetCompanyId = companies[0]!.id;
              else if (companies.length === 0) {
                projectResponse = {
                  message: "Select an active Company before creating a website.",
                  suggestedActions: ["Create a Company"],
                  activeContext: resolved.context,
                };
              } else {
                projectResponse = {
                  message: `Select an active Company before creating or editing a website. Available companies: ${companies.map((company) => company.name).join(", ")}.`,
                  suggestedActions: companies.slice(0, 3).map((company) => `Company: ${company.name}`),
                  activeContext: resolved.context,
                };
              }
            }
            if (targetCompanyId) {
              const executed = await projectOrchestrator.executeWebsiteTask(auth, {
                companyId: targetCompanyId,
                onProgress: (event) => send("progress", { ...event, timestamp: new Date().toISOString() }),
                projectId: projectIntent.intent === "CREATE_PROJECT" || projectIntent.intent === "CREATE_WEBSITE" ? undefined : activeProjectId ?? undefined,
                intentDecision: projectIntent,
                prompt: message,
                idempotencyKey: (request.headers["idempotency-key"] as string) || `website-${Date.now()}`,
              });
              const conversation = memoryPolicy.writeAllowed
                ? request.body.conversationId
                  ? (await workspaceStore.getNeutralConversation(auth, request.body.conversationId)).conversation
                  : await workspaceStore.createNeutralConversation(auth, conversationTitle(message))
                : undefined;
              if (conversation) {
                await workspaceStore.appendNeutralMessage(auth, conversation.id, "user", message);
                const assistantMessage = await workspaceStore.appendNeutralMessage(auth, conversation.id, "assistant", executed.responseMessage);
                await saveChatProjectCard(workspaceStore, auth, conversation.id, assistantMessage.id, executed.projectCard);
              }
              projectResponse = {
                message: executed.responseMessage,
                suggestedActions: [...(executed.previewUrl ? [`Preview: ${executed.project.name}`] : []), `Open: ${executed.project.name}`],
                conversationId: conversation?.id,
                activeContext: {
                  contextType: "project" as const,
                  companyId: executed.project.companyId,
                  projectId: executed.project.id,
                  workspaceId: auth.workspaceId,
                  businessId: null,
                },
                companyRunId: executed.runDetails.run.id,
                projectCard: executed.projectCard,
                projectAction: executed.projectAction,
              };
            }
          }
          send("result", projectResponse);
        } else if (resolved.context.contextType === "project") {
          const result = await runNeutralMessage(auth, message, request.body.conversationId, request.body.attachments, progress, memoryPolicy, (delta) => send("delta", { delta }), streamController.signal);
          send("result", { ...result, activeContext: resolved.context });
        } else if (resolved.context.contextType === "none") {
          const result = await runNeutralMessage(auth, message, request.body.conversationId, request.body.attachments, progress, memoryPolicy,(delta)=>send("delta",{delta}),streamController.signal);
          send("result", { ...result, activeContext: resolved.context });
        } else if (resolved.context.contextType === "company") {
          const company = resolved.company!;
          const managementRequest = isShortAffirmativeReply(message) || requestsCompositeCompanyDeletionIntent(message) || EmailChatActions.isManagementRequest(message) || CompanyChatActions.isManagementRequest(message) || CompanyChatActions.isPotentialMutationRequest(message) || WorkspaceChatActions.isManagementRequest(message) || WorkspaceChatActions.isPotentialMutationRequest(message);
          const explicitCoreWebRequest = explicitlyRequestsWebResearch(message);
          const runnableMainAgent = company.mainAgentId
            ? await workspaceStore.getCompanyAgent(auth, company.id, company.mainAgentId).then((agent) => agent.isActive).catch(() => false)
            : false;
          if (managementRequest || explicitCoreWebRequest || !runnableMainAgent) {
            const result = await runNeutralMessage(auth, message, request.body.conversationId, request.body.attachments, progress, memoryPolicy, (delta) => send("delta", { delta }), streamController.signal, { id: resolved.company!.id, name: resolved.company!.name });
            send("result", { ...result, activeContext: resolved.context });
          } else {
          const conversation = memoryPolicy.writeAllowed
            ? request.body.conversationId
              ? (await workspaceStore.getNeutralConversation(auth, request.body.conversationId)).conversation
              : await workspaceStore.createNeutralConversation(auth, conversationTitle(message))
            : undefined;
          if (conversation) await workspaceStore.appendNeutralMessage(auth, conversation.id, "user", message);
          progress({ type: "final_generation_started" });
          const runResult = await companyRuntime.execute(
            auth,
            resolved.company!.id,
            { task: message, noMemory: memoryPolicy.noMemoryActive, memoryScope:{sessionId:conversation?.id} },
            (request.headers["idempotency-key"] as string) || `stream-${Date.now()}`,
            streamController.signal,
          );
          if(runResult.run.errorCode==="SECURITY_GUARDRAIL_BLOCKED"){
            send("error",{error:{code:runResult.run.errorCode,message:runResult.run.errorMessage}});
          }else{
            progress({ type: "final_generation_completed" });
            const automaticMemory = await persistAutomaticCompanyMemory(
              auth,
              resolved.company!.id,
              runResult.run.id,
              message,
              runResult.run.status,
              memoryPolicy.noMemoryActive,
            );
            const responseMessage=publicCompanyRunMessage(runResult.run.result, runResult.run.errorMessage, message);
            if (conversation) await workspaceStore.appendNeutralMessage(auth, conversation.id, "assistant", responseMessage);
            for(const delta of boundedResponseChunks(responseMessage))send("delta",{delta});
            send("result", {
              message: responseMessage,
              suggestedActions: [],
              conversationId: conversation?.id,
              activeContext: resolved.context,
              companyRunId: runResult.run.id,
              telemetry: companyRunTelemetryHeaders(runResult),
              automaticMemory,
            });
          }
          }
        } else {
          const result = await runBusinessMessage(
            auth,
            resolved.business!.id,
            message,
            request.body.conversationId,
            request.log,
            progress,
            request.body.attachments,
            memoryPolicy,
            streamController.signal,
          );
          for(const delta of boundedResponseChunks(result.message))send("delta",{delta});
          send("result", { ...result, activeContext: resolved.context });
        }
      } catch (error) {
        request.log.error(error);
        const expected = error instanceof WorkspaceAccessError || error instanceof StorageRateLimitError || error instanceof ContextValidationError || error instanceof SecurityPolicyViolation || error instanceof AdmissionError || error instanceof ProjectOrchestrationError;
        const route = expected ? undefined : await getAIContext(auth).then((ai) => ai.model).catch(() => undefined);
        const detail = expected ? error.message : publicChatError(error, route);
        progress({ type: "final_generation_failed", error: detail });
        send("error", { error: { code: expected ? (error as any).code ?? "ERROR" : "AGENT_UNAVAILABLE", message: detail } });
      } finally {
        if(streamId&&activeChatStreams.get(streamId)?.controller===streamController)activeChatStreams.delete(streamId);
        if(distributedChatLease)await activeSessionRegistry.release(auth.workspaceId,auth.userId,distributedChatLease).catch(()=>false);
        // C10 (ТЗ item 6): a slot that was reserved for a code run this request did not start must not stay
        // occupied — the reservation is released here for every path that did not hand it to the run.
        reservedCodeRunSlot?.lease.release();
        reservedCodeRunSlot = null;
        clearInterval(heartbeat);
        reply.raw.end();
      }
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      }
      /**
       * R1 (section A, item 1): the **periodic** refusal is reported before the queue's own, because it is a
       * subclass of the queue's error and it can say something the queue cannot — *when* the allowance returns.
       * The `retry-after` is the window's own estimate rather than the queue timeout, which is the honest
       * answer to "how long until I may start another run".
       */
      if (error instanceof CodeRunRateLimitedError) {
        request.log.warn({ code: error.code, scope: error.scope }, "code_run_rate_limited");
        return reply
          .header("retry-after", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))))
          .code(429)
          .send({
            error: {
              code: "CODE_RUN_RATE_LIMITED",
              message: error.message,
              scope: error.scope,
              limit: error.limit,
              used: error.used,
              retryable: true,
            },
          });
      }
      /**
       * C10 (ТЗ item 6): the queue refused this run before anything was written. 429 with `retry-after` is the
       * honest answer (the same shape the existing admission and storage limits use), and it is reachable only
       * here — before `reply.hijack()` — which is exactly why the slot is taken this early.
       */
      if (error instanceof CodeRunRefusedError) {
        request.log.warn({ code: error.code }, "code_run_queue_refused");
        return reply
          .header("retry-after", String(Math.max(1, Math.ceil(codeRunQueueLimits.queueTimeoutMs / 1000))))
          .code(429)
          .send({ error: { code: error.code === "queue_cancelled" ? "CODE_RUN_QUEUE_CANCELLED" : "CODE_RUN_QUEUE_FULL", message: error.message, retryable: true } });
      }
      if (error instanceof ContextValidationError) {
        return reply.code(400).send({ error: { code: "INVALID_CONTEXT", message: error.message } });
      }
      if (error instanceof WorkspaceAccessError) {
        return reply.code(403).send({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof WorkspaceNotFoundError) {
        return reply.code(404).send({ error: { code: (error as any).code ?? "WORKSPACE_NOT_FOUND", message: error.message } });
      }
      if (!reply.sent) {
        request.log.error(error);
        const errorMessage = error instanceof Error ? error.message : "Could not start the chat stream.";
        return reply.code(500).send({ error: { code: "STREAM_UNAVAILABLE", message: errorMessage } });
      }
    }
  });
}
