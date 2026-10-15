import { WorkspaceAccessError } from "./errors";
import type { DataClassification, RetentionClass } from "./retention";

export type ReplayMode = "recorded" | "live_best_effort";

/** What a recorded step is. A tool-result step is the canonical, model-visible, settled result. */
export type ReplayStepKind = "model_step" | "tool_call";

export interface ReplayBundleStepRecord {
  id: string;
  bundleId: string;
  companyId: string;
  /** Monotonic per bundle; the recorded order is the executed order. */
  seq: number;
  kind: ReplayStepKind;
  turnIndex: number;
  /** Present for `tool_call` steps; `null` for model steps. */
  toolCallId: string | null;
  payload: Record<string, unknown>;
  /** Integrity of this step's payload; a rewritten step no longer matches. */
  payloadHash: string;
  createdAt: Date;
}

export interface ReplayBundleRecord {
  id: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  /** The ExecutionSnapshot this bundle belongs to, when the run had one. */
  executionSnapshotId: string | null;
  /** Version of the **bundle format** (rule 13), not of the run. */
  bundleVersion: number;
  runnerVersion: string | null;
  systemPromptVersion: number | null;
  systemPromptContentHash: string | null;
  modelProfileVersion: number | null;
  provider: string | null;
  model: string | null;
  replayMode: ReplayMode;
  /** Set for `live_best_effort` bundles: the recorded run they were re-issued from. */
  sourceRunId: string | null;
  sourceSnapshotId: string | null;
  terminalStatus: string | null;
  terminalReason: string | null;
  /** Summary: step counts, the replay-input hash and the environment the replay must match. No content. */
  payload: Record<string, unknown>;
  payloadHash: string;
  /** Hash of the replay **input** (steps, excluding non-input artifacts such as raw output references). */
  replayInputHash: string;
  dataClassification: DataClassification;
  retentionClass: RetentionClass;
  createdAt: Date;
}

export interface CreateReplayBundleStepInput {
  id?: string;
  kind: ReplayStepKind;
  turnIndex: number;
  toolCallId?: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  createdAt?: Date;
}

export interface CreateReplayBundleInput {
  id?: string;
  workspaceId: string;
  companyId: string;
  projectId: string;
  sessionId: string;
  runId: string;
  executionSnapshotId?: string | null;
  bundleVersion: number;
  runnerVersion?: string | null;
  systemPromptVersion?: number | null;
  systemPromptContentHash?: string | null;
  modelProfileVersion?: number | null;
  provider?: string | null;
  model?: string | null;
  replayMode: ReplayMode;
  sourceRunId?: string | null;
  sourceSnapshotId?: string | null;
  terminalStatus?: string | null;
  terminalReason?: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  replayInputHash: string;
  dataClassification?: DataClassification;
  retentionClass?: RetentionClass;
  /** Written with the header in one transaction, in this order. */
  steps: CreateReplayBundleStepInput[];
  now?: Date;
}

export interface ListReplayBundlesInput {
  companyId: string;
  runId?: string;
  sessionId?: string;
  executionSnapshotId?: string;
  limit?: number;
}

export function decodeCodeActivityCursor(cursor: string): { createdAt: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new WorkspaceAccessError("Invalid activity cursor");
  }
  const value = parsed as { t?: unknown; i?: unknown };
  if (typeof value?.t !== "string" || typeof value?.i !== "string" || Number.isNaN(Date.parse(value.t))) {
    throw new WorkspaceAccessError("Invalid activity cursor");
  }
  return { createdAt: value.t, id: value.i };
}

