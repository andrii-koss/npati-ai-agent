import type { CompanyChatLanguage } from "./company-chat-i18n";
import { sanitizeExecutionTrace } from "@npati/shared";
import type { DevelopmentProcessProgressItem } from "@npati/shared";

import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatToolCall,
  ChatToolDefinition,
} from "@npati/omniroute-adapter";
import type { AuthContext, CodeSession, CodeInboxMessage, DataClassification, RetentionClass } from "@npati/workspace";
import { resolveCodeAgentLimits, type CodeAgentLimits } from "./code-agent-config";
import { clampCodeSubagentTurnLimit } from "./code-subagent-types";
import {
  executableToolCalls,
  normalizeToolCalls,
  planToolCallWaves,
  toolCallFeedback,
  type KnownTool,
  type NormalizeToolCallsResult,
  type NormalizedToolCall,
} from "./code-tool-call-adapter";
import {
  modelProfileFallbackTrace,
  resolveEffectiveToolCallingMode,
  resolveModelProfile,
  type CodeModelProfile,
  type CodeModelProfileFallbackReason,
  type CodeModelProfileFallbackTrace,
} from "./code-model-profiles";
import {
  COMPACTION_SCHEMA_VERSION,
  assertNoLeaseValuesInSummary,
  compactConversation,
  renderSummaryMessage,
  type CompactionSummary,
} from "./code-conversation-compaction";
import { MODE_RISK_MATRIX, isPlanSafeTool } from "./code-policy-engine";
import { DEFAULT_CODE_SESSION_MODE_MATRIX } from "./code-rbac";
import { sha256Hex, validateArguments, type CodeToolInvokeFailure, type CodeToolInvokeResult } from "./code-tool-runtime";
import {
  VERIFICATION_APPROVAL_REQUIRED,
  VERIFICATION_REPAIR_EXHAUSTED,
  VERIFICATION_UNAVAILABLE,
  createVerificationLoop,
  formatRepairInstruction,
  type VerificationCheckReport,
  type VerificationLoop,
  type VerificationReport,
  type VerificationStatus,
} from "./code-verification-loop";
import {
  SELF_REVIEW_SCHEMA_VERSION,
  createSelfReview,
  describeSelfReview,
  selfReviewStopMessage,
  toPersistedSelfReview,
  type SelfReviewFinding,
  type SelfReviewPersisted,
  type SelfReviewState,
  type SelfReviewStatus,
  type SelfReviewVerdict,
} from "./code-self-review";
import {
  EMPTY_SNAPSHOT_ID,
  resolveExecutionSnapshotProvider,
  type ExecutionSnapshotProvider,
} from "./execution-snapshot";

export type CodingAgentStopReason =
  | "completed"
  | "step_limit"
  | "time_limit"
  | "budget_exhausted"
  | "cancelled"
  | "loop_detected"
  | "invalid_arguments_exhausted"
  | "feature_disabled"
  | "provider_error"
  | "tool_failure"

  | "interrupted"

  | "verification_failed"

  | "self_review_unresolved"

  | "self_review_unavailable"

  | "waiting_for_user"

  | "active_subagent_unsettled"
  | "async_collect_unsettled"
  | "refused";

export type CodingAgentRunStatus = "suspended_by_flag" | "completed" | "stopped" | "failed" | "cancelled" | "interrupted" | "waiting_for_user";

export const CODE_ASK_USER_TOOL = "code.ask_user";



export * from "./coding-agent-runner-ports";
export * from "./coding-agent-runner-prompt";

export interface CodingAgentRunInput {
  responseLanguage?: CompanyChatLanguage;
  /**
   * `false` starts the run without the session inbox lease. Used by the automatic visual-repair continuation,
   * which runs while the chat transport still owns that lease and consumes no new user messages.
   */
  useInbox?: boolean;
  /** `true` for the visual-repair continuation: it must not wait on the async collect barrier. */
  skipAsyncCollect?: boolean;
  noMemory?: boolean;
  websiteEdit?: boolean;
  allowStylePreview?: boolean;
  onActivity?: (event: DevelopmentProcessProgressItem) => Promise<void>;
  /**
   * Step 5: assistant prose as the provider streams it, for the chat transport. Only answer text is delivered —
   * never reasoning or tool-call arguments — and the callback is presentation-only: it cannot change the run.
   */
  onTextDelta?: (text: string) => void;

  initialInboxMessageId?: string;
  ctx: AuthContext;
  session: CodeSession;
  prompt: string;
  model?: string;
  fallbackModel?: string;
  turnId?: string;
  runId?: string;
  agentId?: string;
  imageReference?: string;
  images?: ReadonlyArray<{ mimeType: string; dataBase64: string }>;
  signal?: AbortSignal;

  cancelRequested?: () => boolean | Promise<boolean>;

  runStateOwner?: string;
  runDetails?: Record<string, unknown>;
  quotaSessionId?: string;
  detachedChildInbox?: boolean;
  subagentWritePaths?: readonly string[];
  initialTurnIndex?: number;

  extraSystemPromptLines?: readonly string[];

  verificationTools?: readonly string[];
  /** Trusted command discovery after generated manifests have been saved; only adds checks. */
  refreshVerificationTools?: () => Promise<readonly string[] | undefined>;

  forceVerification?: boolean;

  requireImplementation?: boolean;

  /** Trusted creation context; never set for existing-project edits. */

  emptyHtmlWorkspace?: boolean;

  readOnlyIntent?: boolean;

  /**
   * Trusted signals for choosing which tools the model is offered (see `code-tool-visibility.ts`). The user's
   * own message is used for keyword matching because `prompt` also carries system guidance; absent → `prompt`.
   */
  toolContext?: CodingAgentToolContext;

  subagentScope?: CodingAgentSubagentScopeInput;

  maxTurns?: number;

  approvedToolCalls?: readonly CodingAgentApprovedToolCall[];
}

export interface CodingAgentToolContext {
  userMessage?: string;
  /** The project has a Data Studio backend attached (`project.dataBackendId`). */
  dataBackendAttached?: boolean;
}

export interface CodingAgentApprovedToolCall {

  approvalId: string;

  toolCallId: string;

  tool: string;

  args: Record<string, unknown>;
}

export interface CodingAgentPendingApproval {
  approvalId: string;
  toolCallId: string;
  tool: string;
  connectionId: string | null;
  toolName: string | null;
  schemaHash: string | null;
  argsHash: string | null;
}

export interface CodingAgentSubagentScopeInput {

  parentRunId: string;

  allowedTools?: readonly string[];
}

export interface CodingAgentRunSummary {
  stylePreview?: boolean;
  filesChanged: string[];
  diffStats: { files: number; linesAdded: number; linesRemoved: number };
  checksRun: string[];
  turns: number;
  toolCalls: number;
  tokens: number;
  costUsd: number;
  remaining: string;

  verification?: CodingAgentVerificationSummary;

  scope?: CodingAgentScopeSummary;

  selfReview?: CodingAgentSelfReviewSummary;
}

export interface CodingAgentSelfReviewSummary {
  schemaVersion: number;

  status: SelfReviewStatus;

  reason?: string;

  /** Step 4: the risk level the adaptive rule assigned to this change set. */
  risk?: "low" | "elevated" | "high";
  /** Step 4: true when the review was deliberately skipped by the adaptive rule rather than by config. */
  adaptiveSkip?: boolean;

  detail?: string;
  ran: boolean;

  reviewRuns: number;

  iterationsUsed: number;
  maxIterations: number;
  fixApplied: boolean;

  findingsCount: number;
  blocking: number;

  unresolved: number;

  findings: CodingAgentSelfReviewFinding[];
  inputs: SelfReviewVerdict["inputs"];
  reviewHash: string;
}

export interface CodingAgentSelfReviewFinding {
  id: string;
  category: SelfReviewFinding["category"];
  severity: SelfReviewFinding["severity"];
  file: string | null;
  reason: string;
  suggestedFix: string | null;
  blocking: boolean;
}

export interface CodingAgentVerificationSummary {
  schemaVersion: number;

  status: VerificationStatus | "passed_with_unjustified_test_changes";
  attemptsUsed: number;
  maxAttempts: number;
  verificationRuns: number;
  requestedTools: string[];
  /**
   * Step 2: the checks the last verification actually executed. `requestedTools` stays the run's configured list
   * (the Live Preview gate reads it), while this states what was proven. `build` is never omitted when requested.
   */
  executedTools?: string[];
  /** Step 2: requested checks deliberately not run for this change set, with a machine-readable reason. */
  skippedChecks?: Array<{ tool: string; reason: string }>;
  /** Step 2: true when the result was reused because the revision and every verification input were unchanged. */
  reused?: boolean;

  failedChecks: Array<{ tool: string; code?: string }>;

  testIntegrity?: {
    flagged: boolean;
    requiresJustification: boolean;
    justificationProvided: boolean;
    findings: Array<{ path: string; kind: string; detail: string }>;
    testFilesTouched: string[];
    testFilesDeleted: string[];
  };
}

export interface CodingAgentScopeSummary {
  changedFiles: number;
  limit: number;
  exceeded: boolean;
  severity: "info" | "warn" | "critical";
  unrelatedPaths: string[];

  relatednessUnknown: boolean;
  warnings: Array<{ code: string; message: string; severity: string; paths: string[] }>;
}

export interface CodingAgentRunResult {
  status: CodingAgentRunStatus;
  reason: CodingAgentStopReason;
  message: string;
  summary: CodingAgentRunSummary;
  snapshotId: string;

  code?: string;

  runId?: string;
  model?: string;
  provider?: string;

  context?: {
    currentTokens: number;
    maxContextTokens: number;
    utilizationRatio: number;
    compactions: number;
  };
  startedAt: number;
  finishedAt: number;

  verification?: CodingAgentVerificationSummary;
  scope?: CodingAgentScopeSummary;

  selfReview?: CodingAgentSelfReviewSummary;

  pendingApprovals?: CodingAgentPendingApproval[];
}


/** Best-effort presentation, never a policy decision or an execution prerequisite. */
export async function emitCodingActivity(input: { onActivity?: CodingAgentRunInput["onActivity"] }, event: DevelopmentProcessProgressItem) {
  if (!input.onActivity) return;
  const safe = { ...event };
  for (const key of ["title", "command", "file", "cwd", "result", "stdout", "stderr", "error", "diff"] as const) if (typeof safe[key] === "string") safe[key] = sanitizeExecutionTrace(safe[key]!);
  try { await input.onActivity(safe); } catch { /* The existing durable Run/Replay remains authoritative. */ }
}
