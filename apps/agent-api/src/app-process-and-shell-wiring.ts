import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { WorkspaceStore } from "@npati/workspace";
import type { AppConfig } from "./app";
import type { AuditLogService } from "./audit-log";
import type { PolicyEngine } from "./code-policy-engine";
import type { FeatureFlagService } from "./feature-flags";
import type { ProjectSandboxService } from "./project-sandbox-service";
import type { SecretLeaseProvider } from "./code-secret-lease";
import type { createCoreServices } from "./core-services";
import { CodeAsyncProcessService } from "./code-async-process";
import { CodeProcessManager } from "./code-process-manager";
import { CodeShellRuntime } from "./code-shell-runtime";
import { createProcessSandboxPortWiring } from "./process-sandbox-port-wiring";
import { createShellSandboxPortWiring } from "./shell-sandbox-port-wiring";

export interface AppProcessAndShellWiringDeps {
  app: FastifyInstance;
  config: AppConfig;
  log: FastifyBaseLogger;
  agent: ReturnType<typeof createCoreServices>["agent"];
  projectSandbox?: ProjectSandboxService;
  workspaceStore: WorkspaceStore;
  featureFlagService: FeatureFlagService;
  enrichedPolicyEngine: PolicyEngine;
  auditLogService?: AuditLogService;
  secretLeases: SecretLeaseProvider;
}

export function createAppProcessAndShellWiring(deps: AppProcessAndShellWiringDeps) {
  const {
    app,
    config,
    log,
    agent,
    projectSandbox,
    workspaceStore,
    featureFlagService,
    enrichedPolicyEngine,
    auditLogService,
    secretLeases,
  } = deps;

  const shellSandboxPortWiring = createShellSandboxPortWiring({
    config,
    log,
    agent,
    projectSandbox,
  });
  const { shellSandboxPort } = shellSandboxPortWiring;

  const processSandboxPortWiring = createProcessSandboxPortWiring({
    config,
    log,
    projectSandbox,
  });
  const { processSandboxPort } = processSandboxPortWiring;

  const trackedProcesses =
    projectSandbox && workspaceStore.codeProcesses
      ? new CodeAsyncProcessService({
          store: workspaceStore.codeProcesses,
          flags: featureFlagService,
          session: (ctx, companyId, sessionId) => workspaceStore.getCodeSession(ctx, companyId, sessionId),
          run: (companyId, runId) => workspaceStore.getCodeRunState(companyId, runId),
          port: {
            supported: (ctx, companyId, projectId) =>
              projectSandbox.supportsTrackedProcesses(ctx, companyId, projectId),
            start: async (ctx, input, op, beforeStart) =>
              projectSandbox.startTrackedProcess(
                ctx,
                input.companyId,
                { ...input, agentId: "system", processId: op.processId },
                beforeStart,
                await featureFlagService.isEnabled(ctx, "code.async_collect_barrier", {
                  companyId: input.companyId,
                }),
              ),
            status: async (ctx, op) =>
              (await projectSandbox.process(ctx, op.companyId, {
                projectId: op.projectId,
                sandboxId: op.sandboxId ?? undefined,
                agentId: "system",
                processId: op.processId,
                action: "status",
              })) as { status: string; exitCode: number | null },
            stop: async (ctx, op) =>
              (await projectSandbox.process(ctx, op.companyId, {
                projectId: op.projectId,
                sandboxId: op.sandboxId ?? undefined,
                agentId: "system",
                processId: op.processId,
                action: "stop",
              })) as { status: string; exitCode: number | null },
            output: (ctx, op, offset) =>
              projectSandbox.trackedOutput(
                ctx,
                op.companyId,
                {
                  projectId: op.projectId,
                  sandboxId: op.sandboxId ?? undefined,
                  agentId: "system",
                  processId: op.processId,
                },
                offset,
              ),
            sync: (ctx, op) => projectSandbox.syncTrackedProcess(ctx, op),
          },
        })
      : undefined;

  if (trackedProcesses) {
    projectSandbox!.setProcessCleanupGuard({
      acquire: (_ctx, project) => trackedProcesses.cleanupGuard(project.companyId, project.id),
      prepare: (ctx, project) => trackedProcesses.legacyPreparationGuard(ctx, project.companyId, project.id),
    });
    app.addHook("onClose", async () => {
      await trackedProcesses.close();
    });
  }

  const codeProcessManager = new CodeProcessManager({
    sandbox: processSandboxPort,
    flags: featureFlagService,
    audit: auditLogService,
    leases: secretLeases,
  });
  codeProcessManager.tracked = trackedProcesses;

  const codeShellRuntime = new CodeShellRuntime({
    processes: codeProcessManager,
    sandbox: shellSandboxPort,
    flags: featureFlagService,
    audit: auditLogService,
    leases: secretLeases,
    limits: config.codeAgentLimits,
    policy: enrichedPolicyEngine,
  });

  return {
    shellSandboxPort,
    processSandboxPort,
    trackedProcesses,
    codeProcessManager,
    codeShellRuntime,
  };
}
