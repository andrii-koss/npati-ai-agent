
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "./app";
import { CompanyApprovalsRepository } from "./approvals-repository";
import { globalLifecycleHookManager } from "./automations-routes";
import { DEFAULT_CODE_AGENT_LIMITS } from "./code-agent-config";
import { createCodeUserQuestionReaperPort } from "./code-ask-user-reaper";
import { CodeAsyncProcessService } from "./code-async-process";
import { CodeDataRetention } from "./code-data-retention";
import { CodeHookError, createCodeHooksService } from "./code-hooks";
import { createCodeInstructionsLoader } from "./code-instructions-loader";
import { PolicyEngine } from "./code-policy-engine";
import { CodeProcessManager } from "./code-process-manager";
import { createCodeProcessControls } from "./code-process-runtime";
import { CodeProjectTrustService, isRepositoryInstructionsTrusted } from "./code-project-trust";
import { CodeReaper, asStaleApprovalReaper } from "./code-reaper";
import { activitySinkForKind, createCodeRunActivitySink } from "./code-run-activity-sink";
import { SecretLeaseProvider } from "./code-secret-lease";
import { CodeShellRuntime } from "./code-shell-runtime";
import { CodeVerifyRunnerPort } from "./code-tool-executors";
import { CodeToolError } from "./code-tool-runtime";
import { detectVerifyTool, parseVerifyOutput } from "./code-verify-parser";
import { FeatureFlagService } from "./feature-flags";
import { mcpApprovalRunIdOf } from "./mcp-approval";
import { MountedWorkspaceProvider } from "./mounted-workspace-provider";
import { assertOutboundAllowed } from "./outbound-exfiltration-guard";
import { ProjectSandboxService } from "./project-sandbox-service";
import { ProjectService } from "./project-service";
import { defaultResolver as ssrfDefaultResolver } from "./ssrf-safe-http";
import { deliverWebhook } from "./webhook-destination-policy";
import { AuthContext } from "@npati/workspace";
import type { McpApprovalReleaseReason } from "./mcp-approval";

export interface CreateCodePortsWiringDeps {
  config: AppConfig;
  log: FastifyBaseLogger;
  approvalsRepo: CompanyApprovalsRepository | undefined;
  codeActivitySink: ReturnType<typeof createCodeRunActivitySink>;
  codeDataRetention: CodeDataRetention;
  codeProcessManager: CodeProcessManager;
  codeProjectTrust: CodeProjectTrustService;
  codeSandboxExecPort: { execute: (ctx: AuthContext, companyId: string, request: { projectId: string; command: string; cwd?: string | undefined; timeoutMs?: number | undefined }) => Promise<{ stdout: string; exitCode: number | undefined }> } | undefined;
  codeShellRuntime: CodeShellRuntime;
  codeUserQuestionReaperPort: ReturnType<typeof createCodeUserQuestionReaperPort> | null;
  featureFlagService: FeatureFlagService;
  mcpApprovalPauseRelease: ((input: { companyId: string; runId: string; approvalId: string; reason: McpApprovalReleaseReason; answeredBy?: string }) => Promise<unknown>) | null;
  projectSandbox: ProjectSandboxService | undefined;
  projectService: ProjectService;
  projectWorkspace: MountedWorkspaceProvider;
  secretLeases: SecretLeaseProvider;
  trackedProcesses: CodeAsyncProcessService | undefined;
}

export function createCodePortsWiring(deps: CreateCodePortsWiringDeps) {
  const { config, log, approvalsRepo, codeActivitySink, codeDataRetention, codeProcessManager, codeProjectTrust, codeSandboxExecPort, codeShellRuntime, codeUserQuestionReaperPort, featureFlagService, mcpApprovalPauseRelease, projectSandbox, projectService, projectWorkspace, secretLeases, trackedProcesses } = deps;
  const codeReaper = new CodeReaper({
    intervalMs: config.codeAgentLimits?.reaperIntervalMs ?? DEFAULT_CODE_AGENT_LIMITS.reaperIntervalMs,
    toolCallNoProgressMs: config.codeAgentLimits?.toolCallNoProgressMs ?? DEFAULT_CODE_AGENT_LIMITS.toolCallNoProgressMs,
    maxRunMinutes: config.codeAgentLimits?.maxRunMinutes ?? DEFAULT_CODE_AGENT_LIMITS.maxRunMinutes,
    secretLeases: {
      preview: async () => {
        const now = Date.now();
        return secretLeases.list({ state: "active" }).filter((lease) => lease.state === "active" && lease.expiresAt <= now).length;
      },
      reap: () => secretLeases.reap(),
    },
    processRecords: { reapIdle: () => codeProcessManager.reapIdle() },
    shellSessions: { reap: () => codeShellRuntime.reap() },

    staleApprovals: asStaleApprovalReaper(
      approvalsRepo
        ? {
            expireStaleApprovals: async (input: { now: number }) => {
              const expired = await approvalsRepo!.expireStaleApprovalsDetailed({ now: input.now });
              if (mcpApprovalPauseRelease) {
                for (const row of expired.rows) {
                  const runId = mcpApprovalRunIdOf(row.inputPayload);
                  if (!runId) continue;
                  try {
                    await mcpApprovalPauseRelease({
                      companyId: row.companyId,
                      runId,
                      approvalId: row.id,
                      reason: "expired",
                    });
                  } catch (error) {
                    log.warn({ err: error, approvalId: row.id, kind: "approval_timeout" }, "mcp_approval_pause_release_failed");
                  }
                }
              }
              return expired.expired;
            },
          }
        : null,
    ),

    userQuestions: {
      previewCodeUserQuestions: async (input) => {
        if (!codeUserQuestionReaperPort) throw new Error("code_ask_user_reaper_not_ready");
        return codeUserQuestionReaperPort.previewCodeUserQuestions(input);
      },
      expireCodeUserQuestions: async (input) => {
        if (!codeUserQuestionReaperPort) throw new Error("code_ask_user_reaper_not_ready");
        return codeUserQuestionReaperPort.expireCodeUserQuestions(input);
      },
    },
    disk: {
      usage: async () => {
        const { statfs } = await import("node:fs/promises");
        const stats = await statfs(process.cwd());

        return { freeBytes: Number(stats.bavail) * Number(stats.bsize), ...(stats.files > 0 ? { freeInodes: Number(stats.ffree) } : {}) };
      },
    },

    dataRetention: {
      preview: (input) => codeDataRetention.preview(input),
      apply: (input) => codeDataRetention.apply(input),
    },
    activity: { record: (event) => { log.info(event, "code_reaper"); } },
    logger: { warn: (payload, message) => { log.warn(payload, message ?? "code_reaper_warning"); }, info: () => undefined },
  });

  const codeProcessSessions = new Map<string, { sessionId: string; companyId: string; projectId: string }>();

  const fnv1a = (value: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  const codeShellRuntimePort = projectSandbox ? {
    execAsync: async (input: Parameters<NonNullable<import("./code-tool-executors").CodeShellRuntimePort["execAsync"]>>[0]) => {
      if (input.secretRefs?.length) throw new CodeToolError("process_secret_promotion_denied", "Foreground secrets cannot be promoted", 403, "execute", false);
      return codeShellRuntime.execAsync(input.ctx, input);
    },
    waitProcess: async (input: Parameters<NonNullable<import("./code-tool-executors").CodeShellRuntimePort["waitProcess"]>>[0]) => {
      if (!trackedProcesses) throw new CodeToolError("process_promotion_unavailable", "Tracked processes are unavailable", 503, "execute", false);
      return trackedProcesses.wait(input.ctx, input);
    },
    exec: async (input: {
      ctx: AuthContext; companyId: string; projectId: string; sessionId?: string; turnId?: string;
      command: string; cwd?: string;
      env?: Record<string, string>; timeoutMs: number; secretRefs?: string[]; approved: boolean;
    }) => {
      const sessionId = input.sessionId ?? `${input.companyId}:${input.projectId}`;

      const toolCallId = `${sessionId}:${input.turnId ?? "no-turn"}:${fnv1a(`code.shell.exec:${input.command}`)}`;

      const leaseIds: string[] = [];
      try {
        for (const [index, reference] of (input.secretRefs ?? []).entries()) {
          const [id, field] = reference.split(":");
          const lease = await secretLeases.issue(input.ctx, {
            companyId: input.companyId, projectId: input.projectId, sessionId, purpose: "code.shell.exec",
            toolCallId, variableName: `NPATI_SECRET_${index + 1}`, credentialId: id ?? reference, field: field || "value",
          });
          leaseIds.push(lease.leaseId);
        }
        const result = await codeShellRuntime.exec(input.ctx, {
          companyId: input.companyId, projectId: input.projectId, sessionId, command: input.command,
          cwd: input.cwd, env: input.env, timeoutMs: input.timeoutMs, secretLeaseIds: leaseIds,
          toolCallId, approved: input.approved,
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          truncated: result.truncated,
          risk: result.risk === "safe" ? "low" as const : result.risk === "hard_deny" || result.risk === "approval" ? "high" as const : "medium" as const,
        };
      } finally {
        for (const leaseId of leaseIds) await secretLeases.revoke(leaseId, "call_finished").catch(() => undefined);
      }
    },
    startProcess: async (input: {
      ctx: AuthContext; companyId: string; projectId: string; sessionId?: string; agentId?: string;
      command: string; cwd?: string; env?: Record<string, string>; approved: boolean;
    }) => {
      const sessionId = input.sessionId ?? `${input.companyId}:${input.projectId}`;
      const record = await codeProcessManager.start(input.ctx, {
        companyId: input.companyId, projectId: input.projectId, sessionId,
        command: input.command, cwd: input.cwd, agentId: input.agentId ?? "system", approved: input.approved,
      });
      codeProcessSessions.set(record.processId, { sessionId, companyId: input.companyId, projectId: input.projectId });
      return { processId: record.processId, startedAt: new Date(record.startedAt).toISOString() };
    },
    ...createCodeProcessControls(codeProcessManager, codeProcessSessions),
  } : undefined;

  const codeVerifyRunnerPort: CodeVerifyRunnerPort | undefined = projectSandbox ? {
    run: async (input: {
      ctx: AuthContext; companyId: string; projectId: string;
      tools: Array<"lint" | "typecheck" | "test" | "build">; changedOnly: boolean; timeoutMs: number;
    }) => {
      const project = (await projectService.get(input.ctx, input.companyId, input.projectId)) as
        { toolchain?: { verifyCommands?: Record<string, string | undefined> } | null } | null;
      const commands = project?.toolchain?.verifyCommands ?? {};
      const startedAll = Date.now();
      const results: Array<{ tool: "lint" | "typecheck" | "test" | "build"; ok: boolean; summary: string; findings: string[]; raw?: string }> = [];
      for (const tool of input.tools) {
        const command = commands[tool];
        if (!command) {
          results.push({ tool, ok: false, summary: `No ${tool} command is configured for this project`, findings: [] });
          continue;
        }
        const result = await projectSandbox!.execute(input.ctx, input.companyId, {
          projectId: input.projectId, command, agentId: "system",
        }) as { stdout?: string; stderr?: string; output?: string; exitCode?: number };
        const output = `${result?.stdout ?? result?.output ?? ""}${result?.stderr ? `\n${result.stderr}` : ""}`.trim();
        const exitCode = typeof result?.exitCode === "number" ? result.exitCode : 1;
        const parsed = parseVerifyOutput(detectVerifyTool(output, command), output, exitCode);
        const findings = parsed.findings
          .slice(0, 50)
          .map((finding) => `${finding.file ?? ""}${finding.line ? `:${finding.line}` : ""}${finding.column ? `:${finding.column}` : ""} ${finding.severity}: ${finding.message}`.trim());
        const summary = parsed.ok
          ? `${tool} passed${parsed.summary.tests ? ` (${parsed.summary.passed}/${parsed.summary.tests} tests)` : ""}`
          : `${tool} failed with exit code ${exitCode}`
            + (parsed.summary.errors ? ` — ${parsed.summary.errors} error(s)` : "")
            + (parsed.summary.failed ? `, ${parsed.summary.failed} failing test(s)` : "");
        results.push({ tool, ok: parsed.ok, summary, findings, raw: parsed.raw ?? output.slice(0, 4000) });
      }
      return {
        results,
        stats: {
          tools: results.length,
          passed: results.filter((entry) => entry.ok).length,
          failed: results.filter((entry) => !entry.ok).length,
          durationMs: Date.now() - startedAll,
        },
      };
    },
  } : undefined;

  const CODE_DEPS_MANIFESTS: ReadonlyArray<{ manager: string; manifest: string; lockfile: string | null }> = [
    { manager: "pnpm", manifest: "package.json", lockfile: "pnpm-lock.yaml" },
    { manager: "yarn", manifest: "package.json", lockfile: "yarn.lock" },
    { manager: "npm", manifest: "package.json", lockfile: "package-lock.json" },
    { manager: "uv", manifest: "pyproject.toml", lockfile: "uv.lock" },
    { manager: "poetry", manifest: "pyproject.toml", lockfile: "poetry.lock" },
    { manager: "pip", manifest: "requirements.txt", lockfile: null },
    { manager: "go", manifest: "go.mod", lockfile: "go.sum" },
    { manager: "cargo", manifest: "Cargo.toml", lockfile: "Cargo.lock" },
    { manager: "composer", manifest: "composer.json", lockfile: "composer.lock" },
  ];
  const readWorkspaceText = async (ctx: AuthContext, companyId: string, projectId: string, file: string): Promise<string | null> => {
    try {
      const result = await projectWorkspace.readFile(ctx, companyId, projectId, file);
      if (typeof result === "string") return result;
      return (result as { content?: string } | null)?.content ?? null;
    } catch { return null; }
  };

  const codeInstructionsLoader = createCodeInstructionsLoader({
    readFile: async ({ ctx, companyId, projectId, path }) => readWorkspaceText(ctx, companyId, projectId, path),
    isTrusted: async ({ ctx, companyId, projectId }) =>
      isRepositoryInstructionsTrusted(codeProjectTrust, ctx, companyId, projectId),
    draftFacts: async ({ ctx, companyId, projectId }) => {
      try {
        const project = await projectService.get(ctx, companyId, projectId);
        const toolchain = (project as { toolchain?: { languages?: string[]; packageManagers?: string[]; verifyCommands?: Record<string, string> } } | null)?.toolchain;
        return {
          projectName: String((project as { name?: unknown } | null)?.name ?? projectId),
          ...(toolchain === undefined ? {} : { toolchain }),
        };
      } catch {
        return { projectName: projectId };
      }
    },
  });

  const codeHooksService = createCodeHooksService({
    bus: globalLifecycleHookManager,
    flags: featureFlagService,
    trust: {
      isTrusted: async ({ ctx, companyId, projectId }) =>
        isRepositoryInstructionsTrusted(codeProjectTrust, ctx, companyId, projectId),
    },
    readConfig: async ({ ctx, companyId, projectId, path }) => {

      const text = await readWorkspaceText(ctx, companyId, projectId, path);
      if (text === null) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {

        throw new CodeHookError("hook_config_invalid", "The hooks config is not valid JSON");
      }
    },
    sandbox: codeSandboxExecPort,
    webhook: {
      deliver: async ({ url, body, timeoutMs, companyId, projectId }) => {

        const delivered = await deliverWebhook(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          timeoutMs,
          maxBytes: 64 * 1024,
          storedEndpoints: [url],
          requireStoredEndpoint: true,
          allowInsecureHttp: false,
          resolve: ssrfDefaultResolver(),
          policyContext: { companyId, projectId },
        });
        return { status: delivered.status, body: delivered.body.toString("utf8") };
      },
    },
    activity: {
      record: async (event) => {
        const sink = event.kind === "run_activity"
          ? activitySinkForKind(codeActivitySink, "run_activity")
          : activitySinkForKind(codeActivitySink, "code_tool_activity");
        await sink.record(event);
      },
    },
    logger: { warn: (payload, message) => { log.warn(payload, message); } },
  });

  return {
    codeReaper,
    codeShellRuntimePort,
    codeVerifyRunnerPort,
    CODE_DEPS_MANIFESTS,
    readWorkspaceText,
    codeInstructionsLoader,
    codeHooksService,
  };
}
