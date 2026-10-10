import type { CodeShellRuntimePort } from "./code-tool-executors";
import { CodeToolError } from "./code-tool-runtime";
import type { CodeProcessManager } from "./code-process-manager";

export interface CodeProcessScope { sessionId: string; companyId: string; projectId: string }

/** Canonical process controls share the execution session, including after process settlement. */
export function createCodeProcessControls(manager: CodeProcessManager, registry: Map<string, CodeProcessScope>) {
  const sessionFor = (input: { companyId: string; projectId: string; sessionId?: string }) => input.sessionId ?? `${input.companyId}:${input.projectId}`;
  const owned = (input: { companyId: string; projectId: string; sessionId?: string; processId: string }) => {
    const sessionId = sessionFor(input);
    const scope = registry.get(input.processId);
    if (!scope || scope.companyId !== input.companyId || scope.projectId !== input.projectId || scope.sessionId !== sessionId) {
      throw new CodeToolError("process_not_found", "Unknown process for this session", 404, "execute", false);
    }
    return sessionId;
  };
  return {
    listProcesses: async (input: Parameters<NonNullable<CodeShellRuntimePort["listProcesses"]>>[0]) => {
      const sessionId = sessionFor(input);
      const processes = [];
      for (const record of manager.list(sessionId)) {
        const scope = registry.get(record.processId);
        if (!scope || scope.companyId !== input.companyId || scope.projectId !== input.projectId) continue;
        const current = await manager.status(input.ctx, sessionId, record.processId);
        // Preserve the published C4 list vocabulary; new status/wait consumers use full lifecycle state.
        const status = current.state === "running" ? "running" as const
          : current.state === "completed" || current.state === "stopped" ? "stopped" as const : "failed" as const;
        processes.push({ processId: current.processId, command: current.commandDigest, status,
          startedAt: new Date(current.startedAt).toISOString(), exitCode: current.exitCode ?? null });
      }
      if (manager.tracked && input.sessionId) for (const op of await manager.tracked.list(input.ctx, { ...input, sessionId })) {
        if (op.kind === "subagent") continue;
        if (!op.startedAt) continue;
        const current = await manager.tracked.wait(input.ctx, { ...input, sessionId, processId: op.processId, waitTimeoutMs: 0 });
        const status = ["running", "dispatching", "unknown_outcome"].includes(current.state) ? "running" as const
          : ["completed", "stopped"].includes(current.state) ? "stopped" as const : "failed" as const;
        processes.push({ processId: op.processId, command: op.payloadHash, status, startedAt: op.startedAt ?? op.createdAt, exitCode: current.exitCode });
      }
      return { processes };
    },
    processLogs: async (input: Parameters<NonNullable<CodeShellRuntimePort["processLogs"]>>[0]) => {
      if (!registry.has(input.processId) && manager.tracked && input.sessionId) {
        const result = await manager.tracked.wait(input.ctx, { ...input, sessionId: input.sessionId, waitTimeoutMs: 10, offset: 0 });
        if (result.earliestOffset > 0) throw new CodeToolError("process_output_cursor_lost", "Retained output lost line offsets; collect with code.shell.process.wait and its absolute cursor", 409, "execute", false);
        const available = result.output ? result.output.split("\n") : [];
        const lines = available.slice(input.offset, input.offset + input.limit);
        return { lines, nextOffset: input.offset + lines.length, eof: input.offset + lines.length >= available.length };
      }
      const sessionId = owned(input);
      await manager.fetchLogs(input.ctx, sessionId, input.processId);
      const result = await manager.logs(sessionId, input.processId, { offset: input.offset, limit: input.limit });
      return { lines: result.lines, nextOffset: result.nextOffset, eof: result.eof };
    },
    stopProcess: async (input: Parameters<NonNullable<CodeShellRuntimePort["stopProcess"]>>[0]) => {
      if (!registry.has(input.processId) && manager.tracked && input.sessionId) {
        const op = await manager.tracked.cancel(input.ctx, { ...input, sessionId: input.sessionId });
        return { processId: op.processId, stopped: !["accepted", "preparing", "dispatching", "running", "unknown_outcome"].includes(op.state) };
      }
      const sessionId = owned(input);
      await manager.stop(input.ctx, sessionId, input.processId);
      // Keep the scope so terminal output remains collectable after cancellation.
      return { processId: input.processId, stopped: true };
    },
  } satisfies Pick<CodeShellRuntimePort, "listProcesses" | "processLogs" | "stopProcess">;
}
