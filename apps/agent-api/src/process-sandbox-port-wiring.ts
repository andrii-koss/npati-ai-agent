
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { CodeProcessSandboxPort } from "./code-process-manager";
import { ProjectSandboxService } from "./project-sandbox-service";

export interface CreateProcessSandboxPortWiringDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  projectSandbox: ProjectSandboxService | undefined;
}

export function createProcessSandboxPortWiring(deps: CreateProcessSandboxPortWiringDeps) {
  const { config, log, projectSandbox } = deps;
  const processSandboxPort: CodeProcessSandboxPort | undefined = projectSandbox ? {
    logsAreSnapshots: true,
    start: async (input) => {
      const result = await projectSandbox!.process(input.context, input.companyId, {
        projectId: input.projectId, command: input.command, action: "start", agentId: "system",
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.approved ? { approved: true } : {}),
      }) as { processId?: string; pid?: number; startedAt?: string | number };
      const parsed = typeof result?.startedAt === "number" ? result.startedAt : result?.startedAt ? Date.parse(result.startedAt) : Date.now();
      return { processId: String(result?.processId ?? ""), pid: result?.pid, startedAt: Number.isFinite(parsed) ? parsed : Date.now() };
    },
    logs: async (input) => {
      const result = await projectSandbox!.process(input.context, input.companyId, {
        projectId: input.projectId, processId: input.processId, action: "logs", agentId: "system",
      }) as { output?: string; stdout?: string; eof?: boolean };
      return { output: String(result?.output ?? result?.stdout ?? ""), eof: result?.eof };
    },
    status: async (input) => {
      const result = await projectSandbox!.process(input.context, input.companyId, {
        projectId: input.projectId, processId: input.processId, action: "status", agentId: "system",
      }) as { status?: string; exitCode?: number | null };
      const state = result.status;
      if (state !== "running" && state !== "completed" && state !== "failed" && state !== "stopped" && state !== "timed_out" && state !== "lost") {
        throw new Error("process_status_unknown");
      }
      return { state, exitCode: result.exitCode ?? null };
    },
    stop: async (input) => {
      const started = Date.now();
      const result = await projectSandbox!.process(input.context, input.companyId, {
        projectId: input.projectId, processId: input.processId, action: "stop", agentId: "system",
      }) as { status?: string; exitCode?: number | null };
      const state = result.status;
      if (state !== "stopped" && state !== "completed" && state !== "failed" && state !== "timed_out") throw new Error("process_stop_unconfirmed");
      return { state, exitCode: result.exitCode ?? null, durationMs: Date.now() - started };
    },
  } : undefined;

  return {
    processSandboxPort,
  };
}
