
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AppConfig } from "./app";
import { CodeShellSandboxPort } from "./code-shell-runtime";
import { createCoreServices } from "./core-services";
import { ProjectSandboxService } from "./project-sandbox-service";

export interface CreateShellSandboxPortWiringDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  agent: ReturnType<typeof createCoreServices>["agent"];
  projectSandbox: ProjectSandboxService | undefined;
}

export function createShellSandboxPortWiring(deps: CreateShellSandboxPortWiringDeps) {
  const { config, log, agent, projectSandbox } = deps;
  const shellSandboxPort: CodeShellSandboxPort | undefined = projectSandbox ? {
    execute: async (input) => {
      const started = Date.now();
      const result = await projectSandbox!.execute(input.context, input.companyId, {
        projectId: input.projectId,
        command: input.command,
        timeoutMs: input.timeoutMs,
        ...(input.runId ? { runId: input.runId } : {}),

        agentId: "system",
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.approved ? { approved: true } : {}),
        ...(input.environmentReferences ? { environmentReferences: input.environmentReferences } : {}),
      }) as { stdout?: string; stderr?: string; output?: string; exitCode?: number; durationMs?: number; status?: string; sandboxId?: string; riskLevel?: string };
      return {
        exitCode: typeof result?.exitCode === "number" ? result.exitCode : 1,
        stdout: result?.stdout ?? result?.output ?? "",
        stderr: result?.stderr ?? "",
        durationMs: typeof result?.durationMs === "number" ? result.durationMs : Date.now() - started,
        status: result?.status,
        sandboxId: result?.sandboxId,
        riskLevel: result?.riskLevel,
      };
    },
  } : undefined;

  return {
    shellSandboxPort,
  };
}
