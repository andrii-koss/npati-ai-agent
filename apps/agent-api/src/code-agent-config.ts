/**
 * C1: configuration for the Coding Agent.
 *
 * The plan fixes a default limits table; those limits live here as configuration (env-overridable),
 * never as literals scattered through the code. C1a adds the feature flags on top; until then every
 * code path stays behind the existing "off by default" behaviour described in this file.
 */

import { selfReviewFixIterationsFromEnv } from "./code-self-review";

export interface CodeAgentLimits {
  /** Model turns inside one code run. */
  maxStepsPerRun: number;
  maxRunMinutes: number;
  /** Tool output kept for the model (the head and the tail are preserved). */
  toolOutputChars: number;
  readFileLines: number;
  readFileBytes: number;
  commandTimeoutMs: number;
  installBuildTimeoutMs: number;
  parallelReadOnlyCalls: number;
  editRepairAttempts: number;
  repairLoopAttempts: number;
  contextCompressionRatio: number;
  subagentDepth: number;
  subagentParallelism: number;
  flagPropagationSeconds: number;
  runHeartbeatMs: number;
  runLeaseMs: number;
  toolCallNoProgressMs: number;
  reaperIntervalMs: number;
  minPackageAgeDays: number;
  maxSandboxImageAgeDays: number;
  maxRedirects: number;
  toolResultRetentionDays: number;
  transcriptRetentionDays: number;
  /**
   * C9: how many files one run may change before the scope guard warns. A warning, never a block: a rename
   * legitimately touches many files, and an approval on the *count* of files would be satisfied by one click
   * while saying nothing about risk.
   */
  maxChangedFiles: number;
  /**
   * C9 (owner requirement 4): fix iterations allowed after the single self-review pass. The owner's rule is
   * "at most one", so this value is **clamped** to 1 by `resolveSelfReviewFixIterations` — configuration may
   * turn the fix iteration off (0) but never add a second one. The self-review itself is never optional in the
   * sense of being skippable-by-configuration *and* reported as clean: `not_run` says so.
   */
  selfReviewFixIterations: number;
}

export const DEFAULT_CODE_AGENT_LIMITS: CodeAgentLimits = {
  maxStepsPerRun: 40,
  maxRunMinutes: 30,
  toolOutputChars: 30_000,
  readFileLines: 2_000,
  readFileBytes: 1_048_576,
  commandTimeoutMs: 120_000,
  installBuildTimeoutMs: 600_000,
  parallelReadOnlyCalls: 8,
  editRepairAttempts: 2,
  repairLoopAttempts: 3,
  contextCompressionRatio: 0.75,
  subagentDepth: 1,
  subagentParallelism: 4,
  flagPropagationSeconds: 30,
  runHeartbeatMs: 15_000,
  runLeaseMs: 60_000,
  toolCallNoProgressMs: 300_000,
  reaperIntervalMs: 60_000,
  minPackageAgeDays: 7,
  maxSandboxImageAgeDays: 14,
  maxRedirects: 5,
  toolResultRetentionDays: 30,
  transcriptRetentionDays: 90,
  maxChangedFiles: 25,
  selfReviewFixIterations: 1,
};

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads the limits from the environment, falling back to the plan defaults. */
export function resolveCodeAgentLimits(env: NodeJS.ProcessEnv = process.env): CodeAgentLimits {
  return {
    maxStepsPerRun: positiveInt(env.NPATI_CODE_MAX_STEPS, DEFAULT_CODE_AGENT_LIMITS.maxStepsPerRun),
    maxRunMinutes: positiveInt(env.NPATI_CODE_MAX_RUN_MINUTES, DEFAULT_CODE_AGENT_LIMITS.maxRunMinutes),
    toolOutputChars: positiveInt(env.NPATI_CODE_TOOL_OUTPUT_CHARS, DEFAULT_CODE_AGENT_LIMITS.toolOutputChars),
    readFileLines: positiveInt(env.NPATI_CODE_READ_FILE_LINES, DEFAULT_CODE_AGENT_LIMITS.readFileLines),
    readFileBytes: positiveInt(env.NPATI_CODE_READ_FILE_BYTES, DEFAULT_CODE_AGENT_LIMITS.readFileBytes),
    commandTimeoutMs: positiveInt(env.NPATI_CODE_COMMAND_TIMEOUT_MS, DEFAULT_CODE_AGENT_LIMITS.commandTimeoutMs),
    installBuildTimeoutMs: positiveInt(env.NPATI_CODE_INSTALL_TIMEOUT_MS, DEFAULT_CODE_AGENT_LIMITS.installBuildTimeoutMs),
    parallelReadOnlyCalls: positiveInt(env.NPATI_CODE_PARALLEL_READONLY, DEFAULT_CODE_AGENT_LIMITS.parallelReadOnlyCalls),
    editRepairAttempts: positiveInt(env.NPATI_CODE_EDIT_REPAIR_ATTEMPTS, DEFAULT_CODE_AGENT_LIMITS.editRepairAttempts),
    repairLoopAttempts: positiveInt(env.NPATI_CODE_REPAIR_LOOP, DEFAULT_CODE_AGENT_LIMITS.repairLoopAttempts),
    contextCompressionRatio: positiveFloat(env.NPATI_CODE_CONTEXT_COMPRESSION_RATIO, DEFAULT_CODE_AGENT_LIMITS.contextCompressionRatio),
    subagentDepth: positiveInt(env.NPATI_CODE_SUBAGENT_DEPTH, DEFAULT_CODE_AGENT_LIMITS.subagentDepth),
    subagentParallelism: positiveInt(env.NPATI_CODE_SUBAGENT_PARALLELISM, DEFAULT_CODE_AGENT_LIMITS.subagentParallelism),
    flagPropagationSeconds: positiveInt(env.NPATI_CODE_FLAG_PROPAGATION_SECONDS, DEFAULT_CODE_AGENT_LIMITS.flagPropagationSeconds),
    runHeartbeatMs: positiveInt(env.NPATI_CODE_RUN_HEARTBEAT_MS, DEFAULT_CODE_AGENT_LIMITS.runHeartbeatMs),
    runLeaseMs: positiveInt(env.NPATI_CODE_RUN_LEASE_MS, DEFAULT_CODE_AGENT_LIMITS.runLeaseMs),
    toolCallNoProgressMs: positiveInt(env.NPATI_CODE_TOOL_NO_PROGRESS_MS, DEFAULT_CODE_AGENT_LIMITS.toolCallNoProgressMs),
    reaperIntervalMs: positiveInt(env.NPATI_CODE_REAPER_INTERVAL_MS, DEFAULT_CODE_AGENT_LIMITS.reaperIntervalMs),
    minPackageAgeDays: positiveInt(env.NPATI_CODE_MIN_PACKAGE_AGE_DAYS, DEFAULT_CODE_AGENT_LIMITS.minPackageAgeDays),
    maxSandboxImageAgeDays: positiveInt(env.NPATI_CODE_MAX_IMAGE_AGE_DAYS, DEFAULT_CODE_AGENT_LIMITS.maxSandboxImageAgeDays),
    maxRedirects: positiveInt(env.NPATI_CODE_MAX_REDIRECTS, DEFAULT_CODE_AGENT_LIMITS.maxRedirects),
    toolResultRetentionDays: positiveInt(env.NPATI_CODE_TOOL_RESULT_RETENTION_DAYS, DEFAULT_CODE_AGENT_LIMITS.toolResultRetentionDays),
    transcriptRetentionDays: positiveInt(env.NPATI_CODE_TRANSCRIPT_RETENTION_DAYS, DEFAULT_CODE_AGENT_LIMITS.transcriptRetentionDays),
    maxChangedFiles: positiveInt(env.NPATI_CODE_MAX_CHANGED_FILES, DEFAULT_CODE_AGENT_LIMITS.maxChangedFiles),
    // The dedicated reader parses the raw value itself (0 is legal here, and `positiveInt` would treat it as
    // unset), and the result is clamped by the module that owns the cap: the environment can turn the fix
    // iteration off, never add a second one.
    selfReviewFixIterations: selfReviewFixIterationsFromEnv(env),
  };
}

/**
 * C1 is dark by default: the coding agent is not enabled here. C1a introduces the flag service and
 * replaces this constant with a real, audited lookup; until then every code entry point must treat
 * the feature as disabled.
 */
export const CODE_AGENT_ENABLED_BY_DEFAULT = false;
