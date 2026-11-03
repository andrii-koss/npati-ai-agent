import { CodeToolError, type CodeToolExecutionContext } from "./code-tool-runtime";
import type { CanonicalShellExecutorOptions } from "./code-tool-executors-shell";
import {
  rethrowCanonical,
  stringArg,
  toolNotConfigured,
} from "./code-tool-executors-common";

/**
 * C4a: dependency port. It is implemented by the dependency modules (policy, guard, audit) and the
 * sandbox, so the executors below never install anything themselves: without the port a dependency tool
 * fails closed with `tool_not_configured` (503).
 */
export interface CodeDepsPort {
  inspect(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    path?: string;
    manager?: string;
  }): Promise<{ manager: string; lockfile: string | null; declared: Array<{ name: string; version?: string | null; scope?: string; source?: string | null }>; metadata?: Record<string, unknown> }>;
  audit(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    manager?: string;
    lockfilePath?: string;
    blockOn?: string[];
    sessionId?: string;
    sessionMode?: string;
  }): Promise<{ report: { critical: number; high: number; moderate: number; low: number; advisories: Array<Record<string, unknown>> }; blocked: boolean; reason?: string }>;
  add(input: {
    ctx: CodeToolExecutionContext["ctx"];
    companyId: string;
    projectId: string;
    name: string;
    version?: string;
    manager?: string;
    dev?: boolean;
    source?: string;
    approved: boolean;
    toolCallId?: string;
    sessionId?: string;
  }): Promise<{ manager: string; name: string; version: string | null; source: string; verdict: "added" | "require_approval" | "denied"; reasons: string[]; metadata?: Record<string, unknown>; approvalId?: string | null }>;
}

export interface CanonicalDepsExecutorOptions extends CanonicalShellExecutorOptions {
  /** Dependency inspection, audit and install; absent → the dependency tools fail closed. */
  deps?: CodeDepsPort;
}

/**
 * C4a: dependency tools. Inspection is pure reading, the audit runs the ecosystem's audit command in the
 * sandbox through the injected runner, and adding a dependency goes through the dependency guard so the
 * verdict (allow / require approval / deny) and the reasons come from one place.
 */
export function canonicalDepsExecutors(options: CanonicalDepsExecutorOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  const deps = (tool: string) => {
    if (!options.deps) toolNotConfigured(tool, "the dependency policy/guard/audit wiring");
    return options.deps;
  };

  return {
    "code.deps.inspect": async (input) => {
      const port = deps(input.tool.name);
      try {
        return await port.inspect({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          ...(typeof input.args.path === "string" ? { path: input.args.path } : {}),
          ...(typeof input.args.manager === "string" ? { manager: input.args.manager } : {}),
        });
      } catch (error) { rethrowCanonical(error); }
    },

    "code.deps.audit": async (input) => {
      const port = deps(input.tool.name);
      const blockOn = Array.isArray(input.args.blockOn)
        ? input.args.blockOn.filter((value): value is string => typeof value === "string")
        : undefined;
      try {
        return await port.audit({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          ...(typeof input.args.manager === "string" ? { manager: input.args.manager } : {}),
          ...(typeof input.args.lockfilePath === "string" ? { lockfilePath: input.args.lockfilePath } : {}),
          ...(blockOn?.length ? { blockOn } : {}),
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
        });
      } catch (error) { rethrowCanonical(error); }
    },

    "code.deps.add": async (input) => {
      const port = deps(input.tool.name);
      const name = stringArg(input.args, ["name", "package", "packageName"]);
      if (!name) throw new CodeToolError("invalid_arguments", "code.deps.add requires a package name", 400, "validate_arguments", false, input.tool.name);
      try {
        return await port.add({
          ctx: input.ctx,
          companyId: input.companyId,
          projectId: input.projectId,
          name,
          sessionId: input.sessionId,
          ...(typeof input.args.version === "string" ? { version: input.args.version } : {}),
          ...(typeof input.args.manager === "string" ? { manager: input.args.manager } : {}),
          ...(typeof input.args.dev === "boolean" ? { dev: input.args.dev } : {}),
          ...(typeof input.args.source === "string" ? { source: input.args.source } : {}),
          approved: input.approved === true || input.args.approved === true,
        });
      } catch (error) { rethrowCanonical(error); }
    },
  };
}
