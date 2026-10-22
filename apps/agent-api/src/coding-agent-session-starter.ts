import type { AuthContext, CodeSession } from "@npati/workspace";
import type { CodeAgentLimits } from "./code-agent-config";
import {
  resolveCodeRunCapabilityScope,
  subagentDepthForRun,
  type CodeRunCapabilityScope,
} from "./code-subagent-limits";
import { CODE_SUBAGENT_MAX_TURNS, clampCodeSubagentTurnLimit } from "./code-subagent-types";
import {
  type CodingAgentStopReason,
  type CodingAgentRunStatus,
  type CodeRunActivityEvent,
  type CodingAgentRunnerPorts,
  type CodingAgentRunInput,
  type CodingAgentRunResult,
} from "./coding-agent-runner-contracts";
import type { CodingAgentRunPhases } from "./coding-agent-run-phases";
import type { CodingAgentToolCatalog } from "./coding-agent-tool-catalog";

export interface StartSessionArgs {
  ctx: AuthContext;
  session: CodeSession;
  input: CodingAgentRunInput;
  ports: CodingAgentRunnerPorts;
  limits: CodeAgentLimits;
  runPhases: CodingAgentRunPhases;
  toolCatalog: CodingAgentToolCatalog;
  companyId: string;
  projectId: string;
  sessionId: string;
  turnId: string;
  stateOwner: string;
  prompt: string;
  snapshotId: string;
  record: (event: CodeRunActivityEvent) => Promise<void>;
  finish: (
    status: CodingAgentRunStatus,
    reason: CodingAgentStopReason,
    message: string,
    code?: string,
  ) => CodingAgentRunResult;
}

export interface StartedSessionState {
  stateRunId: string | undefined;
  heartbeatTimer: NodeJS.Timeout | null;
  leaseState: { lost: boolean };
  capabilityScope: CodeRunCapabilityScope;
  capabilityScopeFields: Record<string, unknown>;
  delegationDepth: number;
  runTurnLimit: number;
  useInbox: boolean;
  sessionBranch: { branch: string; created: boolean; switched: boolean; previousBranch: string | null } | null;
}

export type StartSessionResult =
  | { ok: false; result: CodingAgentRunResult }
  | { ok: true; state: StartedSessionState };

export async function startCodingAgentSession(args: StartSessionArgs): Promise<StartSessionResult> {
  const {
    ctx,
    session,
    input,
    ports,
    limits,
    runPhases,
    toolCatalog,
    companyId,
    projectId,
    sessionId,
    turnId,
    stateOwner,
    prompt,
    snapshotId,
    record,
    finish,
  } = args;

  const admission = await runPhases.admitRun({ ctx, input, session, companyId, projectId, sessionId });
  if (!admission.admitted) {
    return { ok: false, result: finish(admission.status, admission.reason, admission.message, admission.code) };
  }

  await ports.runEvents?.append({
    eventKey: `code-run-start:${turnId}`,
    eventType: "started",
    runStatus: "running",
    message: "Coding Agent run started",
  });
  await record({ kind: "run_started", companyId, projectId, sessionId, runId: input.runId, reason: session.mode });

  let stateRunId: string | undefined;
  try {
    await ports.lifecycleHooks?.sessionStart({
      ctx,
      companyId,
      projectId,
      sessionId,
      ...(input.runId ? { runId: input.runId } : {}),
      snapshotId: snapshotId || null,
    });
  } catch {
    // Session start lifecycle errors are non-fatal
  }

  const useInbox = input.useInbox !== false && (!input.subagentScope || input.detachedChildInbox === true) && !!ports.inbox && await ports.inbox.isEnabled(ctx, companyId);
  const leaseState = { lost: false };
  let heartbeatTimer: NodeJS.Timeout | null = null;

  if (ports.runState) {
    const started = await runPhases.startRunState({
      ctx,
      input,
      session,
      companyId,
      projectId,
      sessionId,
      stateOwner,
      prompt,
      useInbox,
      finish,
    });
    if (!started.ok) return { ok: false, result: started.result };
    stateRunId = started.runId;

    const heartbeatEveryMs = Math.max(1_000, limits.runHeartbeatMs);
    heartbeatTimer = setInterval(() => {
      if (!stateRunId || leaseState.lost) return;
      void ports.runState!.renewLease({ companyId, runId: stateRunId, owner: stateOwner })
        .then((verdict) => { if (!verdict.held) leaseState.lost = true; })
        .catch(() => undefined);
    }, heartbeatEveryMs);
    heartbeatTimer.unref?.();
  }

  const capabilityScope = resolveCodeRunCapabilityScope({
    parentRunId: input.subagentScope?.parentRunId ?? null,
    allowedTools: input.subagentScope?.allowedTools ?? null,
    canonicalTools: toolCatalog.publishedTools().map((tool) => tool.name),
    maxDepth: toolCatalog.subagentLimits.maxDepth,
  });
  if (capabilityScope.source === "subagent_scope_missing" || capabilityScope.source === "subagent_wildcard_unresolved") {
    const detail = capabilityScope.source === "subagent_scope_missing"
      ? "no capability scope was recorded for it"
      : "its recorded capability scope was a wildcard with no published tool universe to resolve against";
    return {
      ok: false,
      result: finish(
        "failed",
        "refused",
        `The delegated run was not started: ${detail}. A subagent run receives the intersection its delegation recorded, never its parent's full tool set.`,
      ),
    };
  }

  const capabilityScopeFields: Record<string, unknown> = {
    ...(input.subagentWritePaths ? { subagentWritePaths: input.subagentWritePaths } : {}),
    ...(capabilityScope.tools ? { capabilityScope: capabilityScope.tools } : {}),
    ...(capabilityScope.parentRunId ? { parentRunId: capabilityScope.parentRunId } : {}),
  };

  const delegationDepth = subagentDepthForRun(capabilityScope.parentRunId);

  const runTurnLimit = input.maxTurns === undefined
    ? Math.max(0, Math.trunc(limits.maxStepsPerRun))
    : clampCodeSubagentTurnLimit(input.maxTurns, limits.maxStepsPerRun > 0 ? limits.maxStepsPerRun : CODE_SUBAGENT_MAX_TURNS);

  let sessionBranch: { branch: string; created: boolean; switched: boolean; previousBranch: string | null } | null = null;
  if (ports.ensureSessionBranch && input.readOnlyIntent !== true) {
    try {
      sessionBranch = await ports.ensureSessionBranch({ ctx, companyId, projectId, sessionId });
      await record({
        kind: "session_branch",
        companyId,
        projectId,
        sessionId,
        ...(stateRunId ? { runId: stateRunId } : {}),
        branch: sessionBranch.branch,
        branchCreated: sessionBranch.created,
        branchSwitched: sessionBranch.switched,
        reason: sessionBranch.previousBranch ? `from:${sessionBranch.previousBranch}` : "from:none",
      });
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      return {
        ok: false,
        result: finish(
          "failed",
          "refused",
          `The session branch could not be established, so the run was not started (${failure.code ?? "branch_unavailable"}): ${failure.message ?? "unknown error"}`,
        ),
      };
    }
  }

  return {
    ok: true,
    state: {
      stateRunId,
      heartbeatTimer,
      leaseState,
      capabilityScope,
      capabilityScopeFields,
      delegationDepth,
      runTurnLimit,
      useInbox,
      sessionBranch,
    },
  };
}
