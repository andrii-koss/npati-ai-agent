import { codeDataExecutors, type CodeDataToolOptions } from "./code-data-tools";
import { canonicalCodeAgentControlExecutors } from "./code-agent-controls";
import type { CodeSubagentOperationService } from "./code-subagent-operations";
import {
  codeToolLimits, grepFiles, listFiles, readFileLines, symbolsOutline, treeOverview,
  type CodeSearchRequest,
} from "./code-tools-fs";
import { projectInfo, type ProjectInfoResult } from "./code-tools-project";
import { CodeToolError, type CodeToolExecutionContext } from "./code-tool-runtime";
import { canonicalGitExecutors, type CanonicalGitExecutorOptions } from "./code-tool-git-executors";
import {
  createCodeAgentSpawnExecutor,
  type CodeAgentSpawnExecutorOptions,
  type CodeSubagentActivityRecorder,
  type CodeSubagentChildRunner,
  type CodeSubagentDetachedPort,
} from "./code-agent-spawn-executor";
import {
  type CanonicalExecutorOptions,
  toCanonicalPort,
} from "./code-tool-executors-common";
import {
  canonicalWriteExecutors,
  type CanonicalWriteExecutorOptions,
} from "./code-tool-executors-write";
import {
  canonicalShellExecutors,
  type CanonicalShellExecutorOptions,
} from "./code-tool-executors-shell";
import {
  canonicalDepsExecutors,
  type CanonicalDepsExecutorOptions,
} from "./code-tool-executors-deps";
import {
  canonicalPlanExecutors,
  type CanonicalPlanExecutorOptions,
} from "./code-tool-executors-plan";
import {
  canonicalAskUserExecutors,
  type CanonicalAskUserExecutorOptions,
} from "./code-tool-executors-ask-user";

export * from "./code-tool-executors-common";
export * from "./code-tool-executors-write";
export * from "./code-tool-executors-shell";
export * from "./code-tool-executors-deps";
export * from "./code-tool-executors-plan";
export * from "./code-tool-executors-ask-user";
export * from "./code-tool-executors-post-write";

/**
 * C12: the delegation executor. One entry, and it is an **adapter**: the type table, the capability
 * intersection, the child runner and the handoff digest all live in their own modules, so this is the single
 * place that binds them to the runtime.
 *
 * Without `childRunner` the tool fails closed with `tool_not_configured` — a published tool with no wiring is
 * the `runCtags` defect class, and claiming to have delegated when nothing ran would be worse.
 */
export interface CanonicalSubagentExecutorOptions {
  subagentControls?: () => CodeSubagentOperationService | undefined;
  /** Late-bound because the composition builds the executors before the runner exists. */
  subagentChildRunner?: () => CodeSubagentChildRunner | undefined;
  /**
   * Step 5: the detached delegation port. Absent, or its `isEnabled` false, means `code.agent.spawn` keeps the C12
   * blocking behaviour; present and enabled, the same executor returns an accepted receipt instead of the child's
   * outcome. The port carries no policy of its own — every validation, scope and limit stays in the executor.
   */
  subagentDetached?: CodeSubagentDetachedPort;
  /** The published registry (`CodeToolRuntime.listTools()`), i.e. the canonical tool universe. */
  subagentCanonicalTools?: () => readonly string[];
  /** The C6b Activity sink, so the delegation is recorded as a nested event with its snapshot. */
  subagentActivity?: CodeSubagentActivityRecorder;
  subagentModelProfiles?: CodeAgentSpawnExecutorOptions["modelProfiles"];
  subagentEnv?: NodeJS.ProcessEnv;
}

export function canonicalSubagentExecutors(
  options: CanonicalSubagentExecutorOptions = {},
): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  return {
    ...canonicalCodeAgentControlExecutors(options.subagentControls),
    "code.agent.spawn": createCodeAgentSpawnExecutor({
      ...(options.subagentChildRunner ? { childRunner: options.subagentChildRunner } : {}),
      ...(options.subagentCanonicalTools ? { canonicalTools: options.subagentCanonicalTools } : {}),
      ...(options.subagentActivity ? { activity: options.subagentActivity } : {}),
      ...(options.subagentModelProfiles ? { modelProfiles: options.subagentModelProfiles } : {}),
      ...(options.subagentEnv ? { env: options.subagentEnv } : {}),
    }),
    "code.agent.spawn_async": async (input) => {
      if (!options.subagentDetached || !await options.subagentDetached.isEnabled({ ctx: input.ctx, companyId: input.companyId })) {
        throw new CodeToolError("subagent_detached_disabled", "Detached sub-agents are disabled", 409, "policy", false, input.tool.name);
      }
      return createCodeAgentSpawnExecutor({
        childRunner: options.subagentChildRunner,
        detached: { ...options.subagentDetached, isEnabled: async () => true },
        canonicalTools: options.subagentCanonicalTools,
        activity: options.subagentActivity,
        modelProfiles: options.subagentModelProfiles,
        env: options.subagentEnv,
      })(input);
    },
  };
}

/**
 * Read-only, write, sandbox, git and delegation executors merged, which is what the application wires into the
 * runtime.
 *
 * C11: the `code.git.*` bodies come from `canonicalGitExecutors`, which delegates to the existing
 * `ProjectGitService` — there is no second git implementation anywhere under `apps/agent-api/src`, and the
 * git executors contain no git command of their own.
 *
 * C12: `code.agent.spawn` comes from `createCodeAgentSpawnExecutor`, which delegates the child run to the
 * existing `CodingAgentRunner` through a narrow port. There is likewise **no second orchestration engine**:
 * the executor validates, intersects capabilities with the existing `SubagentToolPolicyGuard` and forwards.
 */
export function allCanonicalExecutors(
  options: CanonicalAskUserExecutorOptions & CanonicalGitExecutorOptions & CanonicalSubagentExecutorOptions & CodeDataToolOptions = {},
): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  return {
    ...canonicalExecutors(options),
    ...canonicalWriteExecutors(options),
    ...canonicalShellExecutors(options),
    ...canonicalDepsExecutors(options),
    ...canonicalPlanExecutors(options),
    ...canonicalAskUserExecutors(options),
    ...canonicalGitExecutors(options),
    ...canonicalSubagentExecutors(options),
    ...codeDataExecutors(options),
  };
}

/**
 * The canonical executors, keyed by tool name exactly as the registry publishes them. Each one calls
 * the pure implementation with the adapted port and the configured limits; nothing is re-implemented.
 */
export function canonicalExecutors(options: CanonicalExecutorOptions = {}): Record<string, (input: CodeToolExecutionContext) => Promise<unknown>> {
  return {
    "code.fs.list": async (input) => {
      const args = input.args as { dir?: string; glob?: string; respectGitignore?: boolean; sortByMtime?: boolean; limit?: number };
      return listFiles({
        port: toCanonicalPort(input, options),
        dir: args.dir ?? ".",
        ...(args.glob !== undefined ? { glob: args.glob } : {}),
        ...(args.respectGitignore !== undefined ? { respectGitignore: args.respectGitignore } : {}),
        ...(args.sortByMtime !== undefined ? { sortByMtime: args.sortByMtime } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        limits: codeToolLimits(input.limits),
        tool: input.tool.name,
      });
    },
    "code.fs.read": async (input) => {
      const args = input.args as { path: string; offset?: number; limit?: number; maxLineLength?: number };
      return readFileLines({
        port: toCanonicalPort(input, options),
        path: args.path,
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.maxLineLength !== undefined ? { maxLineLength: args.maxLineLength } : {}),
        limits: codeToolLimits(input.limits),
        tool: input.tool.name,
      });
    },
    "code.fs.grep": async (input) => {
      const args = input.args as { pattern: string; mode?: CodeSearchRequest["mode"]; glob?: string; type?: string; contextLines?: number; maxResults?: number; ignoreCase?: boolean; fixedStrings?: boolean; path?: string };
      return grepFiles({
        port: toCanonicalPort(input, options),
        pattern: args.pattern,
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(args.glob !== undefined ? { glob: args.glob } : {}),
        ...(args.type !== undefined ? { type: args.type } : {}),
        ...(args.contextLines !== undefined ? { contextLines: args.contextLines } : {}),
        ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {}),
        ...(args.ignoreCase !== undefined ? { ignoreCase: args.ignoreCase } : {}),
        ...(args.fixedStrings !== undefined ? { fixedStrings: args.fixedStrings } : {}),
        ...(args.path !== undefined ? { path: args.path } : {}),
        limits: codeToolLimits(input.limits),
        tool: input.tool.name,
      });
    },
    "code.fs.tree": async (input) => {
      const args = input.args as { dir?: string; maxDepth?: number; maxEntries?: number };
      return treeOverview({
        port: toCanonicalPort(input, options),
        ...(args.dir !== undefined ? { dir: args.dir } : {}),
        ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
        ...(args.maxEntries !== undefined ? { maxEntries: args.maxEntries } : {}),
        limits: codeToolLimits(input.limits),
        tool: input.tool.name,
      });
    },
    "code.symbols.outline": async (input) => {
      const args = input.args as { path: string; limit?: number };
      return symbolsOutline({
        port: toCanonicalPort(input, options),
        path: args.path,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        tool: input.tool.name,
      });
    },
    "code.project.info": async (input): Promise<ProjectInfoResult> => {
      if (!options.projectLoader) {
        // Runtime-shaped error so the HTTP layer reports 503 (tool_not_configured) rather than guessing.
        throw new CodeToolError(
          "tool_not_configured",
          "code.project.info has no project loader configured",
          503,
          "configure",
          false,
          input.tool.name,
        );
      }
      const args = input.args as { includeToolchain?: boolean; includeVerifyCommands?: boolean };
      const project = await options.projectLoader({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId });
      if (!project) {
        throw new CodeToolError("project_not_found", `Project ${input.projectId} is not available`, 404, "resolve", false, input.tool.name);
      }
      return projectInfo({
        project,
        ...(args.includeToolchain !== undefined ? { includeToolchain: args.includeToolchain } : {}),
        ...(args.includeVerifyCommands !== undefined ? { includeVerifyCommands: args.includeVerifyCommands } : {}),
      });
    },
  };
}
