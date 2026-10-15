/**
 * C6 — bridge between the existing chat intent routing and the coding agent runner.
 *
 * Why a bridge instead of a second router: `defaultHybridRouter` (packages/shared) already classifies the
 * message and the active project; this module only decides what the chat entry point must DO with a code
 * intent. It never re-classifies the message, never writes to the database and never executes a tool by
 * itself: the runner does that under PolicyEngine/RBAC.
 *
 * The runner is a forward dependency (C6 is the step that introduces it): the port below is the contract.
 * When no runner is wired the bridge does NOT silently fall back to plain chat — that would hide a
 * configuration error behind a plausible answer. It returns an explicit `unavailable` decision instead.
 */

import type { AuthContext, CodeSession } from "@npati/workspace";
import { classifyCodeIntent, codeIntentIsReadOnly, type CodeIntent, type CodeIntentDecision, type CodeProjectKind } from "@npati/shared";

export interface CodeRunnerInvocation {
  ctx: AuthContext;
  companyId: string;
  projectId: string;
  sessionId?: string;
  /**
   * The loaded session the loop runs in; resolved by the entry point before handing over (the runner
   * refuses to start without a session, so an absent session is reported as `code_session_required`).
   */
  session?: CodeSession;
  /** The user's original message, verbatim. Never rewritten — the runner builds its own prompt. */
  request: string;
  intent: CodeIntent;
  /** Correlation id for Activity/Run Trace and audit. */
  correlationId: string;
  /** Cancellation is passed down so the runner can stop tools and release the sandbox. */
  signal?: AbortSignal;
}

export interface CodeRunnerOutcome {
  status: string;
  reason?: string;
  summary?: unknown;
}

/** The contract the runner must satisfy. Kept minimal on purpose: everything else is the runner's business. */
export interface CodeRunnerPort {
  run(invocation: CodeRunnerInvocation): Promise<CodeRunnerOutcome>;
}

export interface CodeIntentRoutingDeps {
  /** Master kill switch check. When it fails, routing must be byte-for-byte the old chat behaviour. */
  isCodingAgentEnabled(ctx: AuthContext, companyId: string): Promise<boolean>;
  /** Active code project for this conversation, if any. Ownership must already be validated by the caller. */
  resolveActiveProject(ctx: AuthContext, companyId: string): Promise<{ projectId: string; sessionId?: string; kind: CodeProjectKind; session?: CodeSession } | null>;
  runner?: CodeRunnerPort | null;
  logger?: { info(event: Record<string, unknown>, message?: string): void; warn(event: Record<string, unknown>, message?: string): void };
}

export interface CodeIntentRoutingInput {
  ctx: AuthContext;
  companyId: string;
  message: string;
  projectIntent?: Parameters<typeof classifyCodeIntent>[0]["projectIntent"];
  correlationId: string;
  signal?: AbortSignal;
}

export type CodeIntentRoutingDecision =
  | { kind: "chat"; reason: string; classification: CodeIntentDecision }
  | { kind: "clarify"; reason: string; intent: CodeIntent; message: string; classification: CodeIntentDecision }
  | { kind: "unavailable"; reason: string; intent: CodeIntent; code: "code_runner_unavailable" }
  | { kind: "code_runner"; reason: string; intent: CodeIntent; readOnly: boolean; invocation: CodeRunnerInvocation };

/**
 * Decides what the chat entry point does with a message. Order is fixed and deliberate:
 * (1) master flag — a disabled Coding Agent must not change chat at all;
 * (2) code intent classification on the ACTIVE project;
 * (3) missing project → ask, never guess;
 * (4) missing runner → explicit unavailable;
 * (5) otherwise hand over to the runner.
 */
export async function routeCodeIntent(input: CodeIntentRoutingInput, deps: CodeIntentRoutingDeps): Promise<CodeIntentRoutingDecision> {
  const log = (event: Record<string, unknown>) => {
    try {
      deps.logger?.info({ ...event, correlationId: input.correlationId }, "code_intent_routing");
    } catch {
      // Logging must never change routing.
    }
  };

  let enabled = false;
  try {
    enabled = await deps.isCodingAgentEnabled(input.ctx, input.companyId);
  } catch {
    // A failing flag lookup is "off": chat keeps working exactly as before.
    enabled = false;
  }
  if (!enabled) {
    const classification = emptyClassification("coding_agent_disabled");
    log({ decision: "chat", reason: "coding_agent_disabled" });
    return { kind: "chat", reason: "coding_agent_disabled", classification };
  }

  const active = await deps.resolveActiveProject(input.ctx, input.companyId);
  const classification = classifyCodeIntent({
    message: input.message,
    activeProjectId: active?.projectId ?? null,
    activeSessionId: active?.sessionId ?? null,
    projectKind: active?.kind ?? null,
    projectIntent: input.projectIntent ?? null,
  });

  if (classification.intent === "CHAT") {
    log({ decision: "chat", reason: classification.reason });
    return { kind: "chat", reason: classification.reason, classification };
  }

  if (classification.needsProjectSelection) {
    log({ decision: "clarify", intent: classification.intent, reason: classification.reason });
    return {
      kind: "clarify",
      reason: "no_active_code_project",
      intent: classification.intent,
      message: classification.clarificationMessage ?? "Which project should I work in?",
      classification,
    };
  }

  if (!active) {
    // Only reachable for the project-optional intent that already collapsed to CHAT; kept as a guard.
    log({ decision: "chat", reason: "no_active_project_optional" });
    return { kind: "chat", reason: "no_active_project_optional", classification };
  }

  if (!deps.runner) {
    log({ decision: "unavailable", intent: classification.intent, reason: "code_runner_unavailable" });
    return { kind: "unavailable", reason: "code_runner_unavailable", intent: classification.intent, code: "code_runner_unavailable" };
  }

  const invocation: CodeRunnerInvocation = {
    ctx: input.ctx,
    companyId: input.companyId,
    projectId: active.projectId,
    sessionId: active.sessionId,
    session: active.session,
    request: input.message,
    intent: classification.intent,
    correlationId: input.correlationId,
    signal: input.signal,
  };
  log({ decision: "code_runner", intent: classification.intent, projectId: active.projectId, readOnly: codeIntentIsReadOnly(classification.intent) });
  return {
    kind: "code_runner",
    reason: classification.reason,
    intent: classification.intent,
    readOnly: codeIntentIsReadOnly(classification.intent),
    invocation,
  };
}

function emptyClassification(reason: string): CodeIntentDecision {
  return { intent: "CHAT", confidence: 0, reason, needsProjectSelection: false, projectOptional: false };
}

/**
 * Decision used by the CHAT entry point (not by the standalone endpoint): given the already-resolved chat
 * context, should this message go to the agent loop, ask for a project, or stay ordinary chat?
 *
 * Kept pure and exported so both sides are testable without booting Fastify: the chat route is then a thin
 * adapter over this function, which is what makes the "chat did not change" regression claim checkable.
 */
export function resolveChatCodeIntent(input: {
  message: string;
  projectIntent?: Parameters<typeof classifyCodeIntent>[0]["projectIntent"];
  codingEnabled: boolean;
  companyId?: string | null;
  projectId?: string | null;
  projectKind?: CodeProjectKind | null;
  /** A validated conversation/project binding keeps natural-language follow-ups in the same runner. */
  sessionBound?: boolean;
}): { mode: "chat" } | { mode: "clarify"; intent: CodeIntent; message: string } | { mode: "run"; intent: CodeIntent; readOnly: boolean } {
  // Flag off (or unreadable) → byte-for-byte the previous chat behaviour.
  if (!input.codingEnabled) return { mode: "chat" };
  if (!input.companyId) return { mode: "chat" };
  // A semantic CHAT decision (e.g. a question or negated request) must not be
  // reinterpreted as execution by incidental code keywords or a session binding.
  if (input.projectIntent === "CHAT") return { mode: "chat" };
  if (!input.projectId && (input.projectIntent === "CREATE_WEBSITE" || input.projectIntent === "CREATE_PROJECT")) return { mode: "chat" };
  // A website/mobile project is handled by the existing project pipeline, never by the agent loop.
  if (input.projectKind && input.projectKind !== "code_project" && !input.sessionBound) return { mode: "chat" };

  const classification = classifyCodeIntent({
    message: input.message,
    activeProjectId: input.projectId ?? null,
    projectKind: input.projectId ? "code_project" : "unknown",
    projectIntent: input.projectIntent,
  });
  if (classification.intent === "CHAT") {
    return input.sessionBound && input.projectId
      ? { mode: "run", intent: "EDIT_CODE", readOnly: false }
      : { mode: "chat" };
  }
  // A code request with no project at all must ASK (plan requirement), not be answered as ordinary chat.
  if (classification.needsProjectSelection) {
    return { mode: "clarify", intent: classification.intent, message: classification.clarificationMessage ?? "Which project should I work in?" };
  }
  if (!input.projectId) return { mode: "chat" };
  /**
   * C11 (owner decision 10): `readOnly` travels with the decision.
   *
   * `READ_ONLY_CODE_INTENTS` and `codeIntentIsReadOnly` existed and this function computed neither, so the
   * read-only property of a review was carried by nothing at all: the chat entry point could not pass it to
   * the runner even if it wanted to. It is now part of the returned decision, and the entry point feeds it
   * into `CodingAgentRunInput.readOnlyIntent`, which the tool runtime enforces on the server.
   */
  return { mode: "run", intent: classification.intent, readOnly: codeIntentIsReadOnly(classification.intent) };
}

/**
 * C6 entry point registration. This is deliberately ADDITIVE: it exposes the routing + run path as its own
 * versioned endpoint and never intercepts the existing chat stream, so plain chat and Run Company keep their
 * current behaviour byte for byte. The chat UI (C7) can call it for a code intent, and a non-code message
 * comes back as `{ routed: "chat" }` for the caller to handle exactly as before.
 */
export interface CodeIntentRouteOptions {
  runner: CodeRunnerPort | null;
  /** Master kill-switch check; a failing lookup counts as disabled. */
  isEnabled(ctx: AuthContext, companyId: string): Promise<boolean>;
  /** Loads the project named by the request (ownership enforced by the store), when it is a code project. */
  resolveProject(ctx: AuthContext, companyId: string, projectId: string): Promise<{ projectId: string; sessionId?: string; kind: CodeProjectKind } | null>;
  /** Loads the session a run may use; `null` makes the entry point answer `code_session_required`. */
  loadSession(ctx: AuthContext, companyId: string, projectId: string, sessionId?: string): Promise<CodeSession | null>;
  logger?: { info(event: Record<string, unknown>, message?: string): void; warn(event: Record<string, unknown>, message?: string): void };
}

export interface CodeIntentRouteApp {
  post(path: string, options: Record<string, unknown>, handler: (request: unknown, reply: unknown) => Promise<unknown>): unknown;
}

export function registerCodeIntentRoutes(
  app: CodeIntentRouteApp,
  auth: { authenticate(request: unknown): Promise<AuthContext> },
  options: CodeIntentRouteOptions,
): void {
  app.post("/companies/:companyId/code/intents/run", { config: { apiVersion: "v1" } }, async (request: unknown, reply: unknown) => {
    const req = request as { params: { companyId: string }; body?: { message?: string; projectId?: string; sessionId?: string; projectIntent?: string }; headers?: Record<string, string | undefined> };
    const res = reply as { code(status: number): { send(body: unknown): unknown } };
    const ctx = await auth.authenticate(request);
    const message = typeof req.body?.message === "string" ? req.body.message : "";
    const projectId = typeof req.body?.projectId === "string" && req.body.projectId ? req.body.projectId : null;
    const sessionId = typeof req.body?.sessionId === "string" && req.body.sessionId ? req.body.sessionId : undefined;
    if (!message.trim()) return res.code(400).send({ apiVersion: "v1", error: { code: "invalid_arguments", message: "message is required" } });

    // The session is resolved per request: the runner cannot start without one, and silently inventing a
    // session would hide a broken client.
    const session = projectId ? await options.loadSession(ctx, req.params.companyId, projectId, sessionId) : null;
    const deps: CodeIntentRoutingDeps = {
      isCodingAgentEnabled: options.isEnabled,
      // The active project is supplied by the caller (chat UI selection lands in C7); without it the bridge
      // asks the user instead of guessing which repository to touch.
      resolveActiveProject: async (innerCtx, companyId) => {
        const project = projectId ? await options.resolveProject(innerCtx, companyId, projectId) : null;
        return project ? { ...project, session: (session ?? undefined) as CodeSession | undefined } : null;
      },
      runner: options.runner,
      ...(options.logger ? { logger: options.logger } : {}),
    };

    const correlationId = req.headers?.["x-request-id"] ?? `code-intent:${Date.now().toString(36)}`;
    const decision = await routeCodeIntent(
      {
        ctx,
        companyId: req.params.companyId,
        message,
        projectIntent: (req.body?.projectIntent ?? null) as CodeIntentRoutingInput["projectIntent"],
        correlationId,
      },
      deps,
    );

    if (decision.kind === "chat") return res.code(200).send({ apiVersion: "v1", routed: "chat", reason: decision.reason });
    if (decision.kind === "clarify") return res.code(200).send({ apiVersion: "v1", routed: "clarify", intent: decision.intent, message: decision.message });
    if (decision.kind === "unavailable") return res.code(503).send({ apiVersion: "v1", error: { code: decision.code, message: "The coding agent runner is not available", intent: decision.intent } });
    if (!session) return res.code(409).send({ apiVersion: "v1", error: { code: "code_session_required", message: "Create or select a code session before starting a run", intent: decision.intent } });

    const outcome = await options.runner!.run(decision.invocation);
    return res.code(200).send({ apiVersion: "v1", routed: "code_runner", intent: decision.intent, run: outcome });
  });
}
