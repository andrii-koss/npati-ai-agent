/**
 * C7: presentation types for the Code Workspace.
 *
 * These types are deliberately transport-agnostic: the presentational layer renders them and the page
 * layer (a separate stream) fetches them. Keeping them free of fetch/auth concerns is what makes the
 * components testable in a plain Node environment and what keeps the UI from being able to widen an
 * agent's permissions by itself.
 */

/** Session modes exactly as the server names them (C5/C5a); `full_auto` is the legacy alias. */
export type CodeSessionMode = "plan" | "ask" | "auto_edit" | "full_auto_sandbox";

export const CODE_SESSION_MODES: readonly CodeSessionMode[] = ["plan", "ask", "auto_edit", "full_auto_sandbox"];

/** The four answers a human can give to an approval card. */
export type ApprovalScope = "once" | "session" | "project" | "deny";

export const APPROVAL_SCOPES: readonly ApprovalScope[] = ["once", "session", "project", "deny"];

/** What the approver is looking at: a diff, or a command with the directory it runs in. */
export interface ApprovalCardData {
  approvalId: string;
  /** Tool or action the approval is for, e.g. `code.shell.exec:npm:test`. */
  action: string;
  riskLevel?: string;
  command?: string;
  cwd?: string;
  diff?: string;
  /** Paths the diff touches — rendered as text, never interpreted. */
  filePaths?: readonly string[];
  expiresAt?: string;
}

/** A single HTTP request the UI intends to make. Kept as data so it can be asserted in tests. */
export interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}

export interface ApprovalDecisionPlan {
  /** Always present: the decision on the pending approval. */
  decide: ApiRequest;
  /**
   * Present for `session`/`project`: the standing rule that makes this approval repeatable inside that
   * scope. `once` and `deny` never create a rule.
   */
  rule?: ApiRequest;
  /** What the UI should tell the user happened. */
  summary: string;
}

export type ToolCallStatus = "ok" | "failed" | "denied" | "pending";

export interface AgentMessageItem {
  kind: "message";
  role: "user" | "assistant" | "system";
  text: string;
  at?: string;
}

export interface AgentToolCallItem {
  kind: "tool_call";
  toolCallId: string;
  tool: string;
  toolVersion?: number;
  /** File the call operated on, if any. Rendered as text. */
  file?: string;
  command?: string;
  cwd?: string;
  result?: string;
  status: ToolCallStatus;
  truncated?: boolean;
  durationMs?: number;
  errorCode?: string;
}

export interface AgentPlanItem {
  kind: "plan";
  title?: string;
  steps: readonly { text: string; done?: boolean }[];
}

export interface AgentChangedFilesItem {
  kind: "changed_files";
  files: readonly ChangedFile[];
}

export type AgentStreamItem =
  | AgentMessageItem
  | AgentToolCallItem
  | AgentPlanItem
  | AgentChangedFilesItem;

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  /** Unified diff, rendered inside a `<pre>` as text. */
  diff?: string;
}

/** Which read-only view a blocked workspace shows. `forbidden` and `not_found` must look identical. */
export type AccessDeniedKind = "forbidden" | "not_found";

export interface UsageView {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  /** Set when the server has no accounting for this session yet — never rendered as zero. */
  unavailable?: string;
}
