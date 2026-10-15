import { CodeToolError, type CodeToolExecutionContext } from "./code-tool-runtime";
import type { CanonicalWriteExecutorOptions } from "./code-tool-executors-write";
import {
  envArg,
  rethrowCanonical,
  stringArg,
  stringListArg,
  toolNotConfigured,
} from "./code-tool-executors-common";

/**
 * C4: the sandbox execution port. It is implemented by the shell runtime (command classification,
 * approval hand-off, secret leases, process table) which itself drives the admitted sandbox. The
 * executors below never run a command themselves: without this port a shell tool fails closed with
 * `tool_not_configured` (503) instead of executing anything on the API host.
 */
export interface CodeShellRuntimePort {
  execAsync?(input: {
    ctx: CodeToolExecutionContext["ctx"]; companyId: string; projectId: string; sessionId: string;
    runId: string; leaseOwner: string; toolCallId: string; agentId?: string;
    command: string; cwd?: string; env?: Record<string, string>; timeoutMs: number;
    waitTimeoutMs: number; background: boolean; secretRefs?: string[]; approved: boolean;
  }): Promise<import("./code-async-process").AsyncProcessReceipt>;
  waitProcess?(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId: string;
    processId: string;
    waitTimeoutMs: number;
    offset: number;
    leaseOwner?: string;
  }): Promise<import("./code-async-process").AsyncProcessReceipt>;
  exec(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId?: string;
    turnId?: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    secretRefs?: string[];
    approved: boolean;
  }): Promise<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number; truncated?: boolean; risk?: "low" | "medium" | "high" }>;
  startProcess?(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId?: string;
    agentId?: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    approved: boolean;
  }): Promise<{ processId: string; startedAt: string }>;
  listProcesses?(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId?: string;
  }): Promise<{ processes: Array<{ processId: string; command: string; status: "running" | "stopped" | "failed"; startedAt?: string | null; exitCode?: number | null }> }>;
  processLogs?(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId?: string;
    processId: string;
    offset: number;
    limit: number;
  }): Promise<{ lines: string[]; nextOffset: number; eof: boolean }>;
  stopProcess?(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId?: string;
    processId: string;
  }): Promise<{ processId: string; stopped: boolean }>;
}

/**
 * C4: verification runner. It replays the project's configured verify commands (from the C1 toolchain)
 * in the sandbox; it never invents a command. Absent → `verify_unavailable` (503).
 */
export interface CodeVerifyRunnerPort {
  run(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    sessionId?: string;
    turnId?: string;
    tools: Array<"lint" | "typecheck" | "test" | "build">;
    changedOnly: boolean;
    timeoutMs: number;
  }): Promise<{
    results: Array<{ tool: "lint" | "typecheck" | "test" | "build"; ok: boolean; summary: string; findings: string[]; raw?: string }>;
    stats: { tools: number; passed: number; failed: number; durationMs: number };
  }>;
}

export interface CanonicalShellExecutorOptions extends CanonicalWriteExecutorOptions {
  /** Sandbox command execution, classification, approvals and secret leases. */
  shellRuntime?: CodeShellRuntimePort;
  /** Verification runner built on the project's configured verify commands. */
  verifyRunner?: CodeVerifyRunnerPort;
}

/**
 * C4: sandbox execution tools. Every call goes through the injected shell runtime, which owns command
 * classification, the approval hand-off, secret leases and output redaction; `approved` is forwarded so
 * the runtime can prove the approval covers *this* command. No port → fail closed.
 */
export function canonicalShellExecutors(options: CanonicalShellExecutorOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  const shell = () => {
    if (!options.shellRuntime) toolNotConfigured("code.shell", "the sandbox shell runtime");
    return options.shellRuntime;
  };

  return {
    "code.shell.exec_async": async (input) => {
      const runtime = shell();
      if (!runtime.execAsync) toolNotConfigured(input.tool.name, "tracked execution");
      try {
        return await runtime.execAsync({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId: input.sessionId ?? "",
          runId: input.runId ?? "",
          leaseOwner: input.leaseOwner ?? "",
          toolCallId: input.toolCallId ?? "",
          agentId: input.agentId,
          command: stringArg(input.args, ["command"]) ?? "",
          cwd: stringArg(input.args, ["cwd"]) ?? undefined,
          env: envArg(input.args.env),
          timeoutMs: typeof input.args.timeoutMs === "number" ? input.args.timeoutMs : input.limits.commandTimeoutMs,
          waitTimeoutMs: typeof input.args.waitTimeoutMs === "number" ? input.args.waitTimeoutMs : 1000,
          background: input.args.background === true,
          secretRefs: stringListArg(input.args.secretRefs),
          approved: input.approved === true,
        });
      } catch (error) { rethrowCanonical(error); }
    },
    "code.shell.process.wait": async (input) => {
      const runtime = shell();
      if (!runtime.waitProcess) toolNotConfigured(input.tool.name, "tracked process collection");
      try {
        return await runtime.waitProcess({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId: input.sessionId ?? "",
          processId: stringArg(input.args, ["processId"]) ?? "",
          leaseOwner: input.leaseOwner,
          waitTimeoutMs: typeof input.args.waitTimeoutMs === "number" ? input.args.waitTimeoutMs : 1000,
          offset: typeof input.args.offset === "number" ? input.args.offset : 0,
        });
      } catch (error) { rethrowCanonical(error); }
    },
    "code.shell.exec": async (input) => {
      const command = stringArg(input.args, ["command", "cmd", "commandLine"]);
      if (!command) throw new CodeToolError("invalid_arguments", "code.shell.exec requires a command", 400, "validate_arguments", false, input.tool.name);
      const runtime = shell();
      try {
        const result = await runtime.exec({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          command,
          cwd: stringArg(input.args, ["cwd", "workingDirectory"]) ?? undefined,
          env: envArg(input.args.env),
          timeoutMs: typeof input.args.timeoutMs === "number" ? input.args.timeoutMs : input.limits.commandTimeoutMs,
          secretRefs: stringListArg(input.args.secretRefs),
          approved: input.approved === true || input.args.approved === true,
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          truncated: result.truncated === true,
          risk: result.risk ?? "medium",
        };
      } catch (error) { rethrowCanonical(error); }
    },

    "code.shell.process.start": async (input) => {
      const command = stringArg(input.args, ["command", "cmd", "commandLine"]);
      if (!command) throw new CodeToolError("invalid_arguments", "code.shell.process.start requires a command", 400, "validate_arguments", false, input.tool.name);
      const runtime = shell();
      if (!runtime.startProcess) toolNotConfigured(input.tool.name, "process management");
      try {
        return await runtime.startProcess({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          agentId: input.agentId,
          command,
          cwd: stringArg(input.args, ["cwd", "workingDirectory"]) ?? undefined,
          env: envArg(input.args.env),
          approved: input.approved === true || input.args.approved === true,
        });
      } catch (error) { rethrowCanonical(error); }
    },

    "code.shell.process.list": async (input) => {
      const runtime = shell();
      if (!runtime.listProcesses) toolNotConfigured(input.tool.name, "process management");
      try {
        return await runtime.listProcesses({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId });
      } catch (error) { rethrowCanonical(error); }
    },

    "code.shell.process.logs": async (input) => {
      const processId = stringArg(input.args, ["processId", "id"]);
      if (!processId) throw new CodeToolError("invalid_arguments", "code.shell.process.logs requires a processId", 400, "validate_arguments", false, input.tool.name);
      const runtime = shell();
      if (!runtime.processLogs) toolNotConfigured(input.tool.name, "process management");
      try {
        return await runtime.processLogs({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          processId,
          sessionId: input.sessionId,
          offset: typeof input.args.offset === "number" ? input.args.offset : 0,
          limit: typeof input.args.limit === "number" ? input.args.limit : 200,
        });
      } catch (error) { rethrowCanonical(error); }
    },

    "code.shell.process.stop": async (input) => {
      const processId = stringArg(input.args, ["processId", "id"]);
      if (!processId) throw new CodeToolError("invalid_arguments", "code.shell.process.stop requires a processId", 400, "validate_arguments", false, input.tool.name);
      const runtime = shell();
      if (!runtime.stopProcess) toolNotConfigured(input.tool.name, "process management");
      try {
        return await runtime.stopProcess({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, sessionId: input.sessionId, processId });
      } catch (error) { rethrowCanonical(error); }
    },

    "code.verify.run": async (input) => {
      if (!options.verifyRunner) toolNotConfigured(input.tool.name, "the verification runner");
      const requested = stringListArg(input.args.tools) ?? [];
      const tools = requested.filter((tool): tool is "lint" | "typecheck" | "test" | "build" =>
        ["lint", "typecheck", "test", "build"].includes(tool));
      if (!tools.length) throw new CodeToolError("invalid_arguments", "code.verify.run requires at least one of lint, typecheck, test, build", 400, "validate_arguments", false, input.tool.name);
      try {
        return await options.verifyRunner.run({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          tools,
          changedOnly: input.args.changedOnly === true,
          timeoutMs: typeof input.args.timeoutMs === "number" ? input.args.timeoutMs : input.limits.installBuildTimeoutMs,
        });
      } catch (error) { rethrowCanonical(error); }
    },
  };
}
