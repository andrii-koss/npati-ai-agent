import { CodeToolError as CanonicalCodeToolError } from "./code-tools-path";

export type CodeToolErrorCode =
  | "project_data_error"
  | "image_unsupported_type" | "image_view_unsupported" | "visual_screenshot_unavailable"
  | "process_secret_promotion_denied" | "process_promotion_unavailable" | "process_output_cursor_lost"
  | "feature_disabled"
  | "company_access_denied"
  | "unknown_tool"
  | "unknown_tool_version"
  | "tool_deprecated"
  | "invalid_arguments"
  | "invalid_path"
  | "path_outside_workspace"
  | "symlink_escape"
  | "null_byte"
  | "sensitive_file_denied"
  | "secret_content"
  | "file_scope_denied"
  | "sandbox_unavailable"
  | "limit_exceeded"
  | "file_too_large"
  | "workspace_error"
  | "runtime_recovery_required"
  | "runtime_state_invalid"
  | "process_termination_unconfirmed"
  | "process_cleanup_failed"
  | "workspace_busy"
  | "workspace_lock_unavailable"
  | "tool_not_configured"
  | "project_not_found"
  | "not_a_file"
  | "not_a_directory"
  | "too_large"
  | "read_failed"
  | "search_failed"
  | "invalid_argument"
  | "tool_failed"
  // C3: write path
  | "read_before_write_required"
  | "revision_conflict"
  | "revision_conflict_exhausted"
  /** A whole-file write that would keep under a tenth of an existing file of 2 KB or more. */
  | "write_would_erase_file"
  | "checkpoint_unavailable"
  | "checkpoint_not_found"
  | "approval_required"
  | "approval_invalid"
  | "approval_unavailable"
  /**
   * C11: the two codes the durable approval store itself answers with
   * (`CompanyApprovalsRepository.consumeApproved`), preserved verbatim by the git boundary.
   */
  | "APPROVAL_INVALID"
  | "APPROVAL_ALREADY_USED"
  /** C5: the reviewer denied the change; details.comment carries the (redacted) reason for the model. */
  | "approval_denied"
  /** C5: no decision arrived before the timeout — the change was not applied and is not retryable as is. */
  | "approval_timeout"
  | "transaction_recovery_required"
  | "write_failed"
  | "delete_failed"
  | "move_failed"
  | "write_unavailable"
  | "unsupported_encoding"
  | "diff_unavailable"
  | "edit_no_match"
  | "edit_ambiguous"
  | "patch_conflict"
  // C4a: dependency path
  | "lockfile_required"
  | "package_not_found"
  | "typosquat_suspected"
  | "source_requires_approval"
  | "registry_change_requires_approval"
  | "audit_unavailable"
  | "audit_blocked"
  | "install_unavailable"
  | "secret_in_diff"
  | "network_isolation_unavailable"
  | "network_enforcement_unavailable"
  | "policy_engine_unavailable"
  | "policy_denied"
  | "command_hard_denied"
  | "interactive_command_not_supported"
  | "command_timeout"
  | "command_failed"
  | "command_not_found"
  | "install_failed"
  | "build_failed"
  | "process_not_found"
  /** C11: the session's resolved intent is read-only, so this tool cannot run (owner decision 10). */
  | "review_code_read_only"
  /**
   * C12: the run is a child (it was delegated), so it cannot delegate in turn. Depth 1 is structural.
   */
  | "subagent_depth_exceeded"
  /** C12: the tool is outside the capability scope the delegation recorded for this run. */
  | "subagent_tool_scope_denied"
  /**
   * C12: the delegation itself.
   */
  | "subagent_type_unknown"
  | "subagent_summary_required"
  | "subagent_path_outside_scope"
  | "subagent_tool_not_published"
  | "subagent_tool_not_delegable"
  | "subagent_parent_scope_unresolved"
  | "subagent_parallelism_exceeded"
  | "subagent_capability_scope_empty"
  | "subagent_handoff_content_rejected"
  | "subagent_handoff_refused_credential"
  /**
   * Step 5: detached delegations.
   */
  | "subagent_write_scope_conflict"
  | "subagent_detached_disabled"
  | "subagent_reserve_failed"
  | "subagent_control_unavailable"
  | "subagent_not_continuable"
  | "subagent_control_busy"
  | "subagent_unknown_outcome"
  | "subagent_session_missing"
  | "subagent_child_not_found"
  /**
   * C13: a PreToolUse project hook refused this call.
   */
  | "hook_blocked";

/** Codes thrown by the canonical modules; they are mapped onto the runtime's failure shape. */
export const CANONICAL_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "secret_content",
  "command_failed", "command_not_found", "command_timeout", "install_failed", "build_failed",
  "file_too_large",
  "runtime_recovery_required", "runtime_state_invalid", "process_termination_unconfirmed", "process_cleanup_failed", "workspace_busy", "workspace_lock_unavailable", "transaction_recovery_required", "invalid_path", "path_outside_workspace", "null_byte", "symlink_escape", "sensitive_file_denied",
  "not_a_file", "not_a_directory", "too_large", "read_failed", "search_failed", "invalid_argument",
  "sandbox_unavailable", "tool_not_configured", "project_not_found",
  "read_before_write_required", "revision_conflict", "revision_conflict_exhausted",
  "checkpoint_unavailable", "checkpoint_not_found", "approval_required", "approval_invalid",
  "approval_unavailable", "approval_denied", "approval_timeout", "write_failed", "delete_failed", "move_failed", "write_unavailable",
  "APPROVAL_INVALID", "APPROVAL_ALREADY_USED",
  "edit_no_match", "edit_ambiguous", "patch_conflict",
  "lockfile_required", "package_not_found", "typosquat_suspected", "source_requires_approval",
  "registry_change_requires_approval", "audit_unavailable", "audit_blocked", "install_unavailable",
  "secret_in_diff", "network_isolation_unavailable",
  "review_code_read_only",
  "git_write_intent_required", "git_write_intent_invalid", "git_approval_binding_undefined",
  "git_conflict_escalated", "git_branch_mismatch", "git_revision_mismatch", "git_session_branch_unavailable",
  "workspace_revision_mismatch", "git_protected_branch_write_denied",
  "GIT_CONFLICT", "GIT_CONFLICT_ESCALATED", "GIT_APPROVAL_REQUIRED", "GIT_APPROVAL_RECORD_REQUIRED",
  "GIT_APPROVAL_UNAVAILABLE", "GIT_APPROVAL_INVALID", "GIT_POLICY_UNAVAILABLE", "GIT_COMMAND_FAILED",
  "GIT_PUSH_FAILED", "GIT_PR_TARGET_REQUIRED", "GIT_PR_NUMBER_REQUIRED", "GIT_PR_COMMENT_BODY_REQUIRED",
  "GITHUB_PR_FAILED", "GITHUB_PR_COMMENT_FAILED", "FORCE_PUSH_NOT_SUPPORTED",
  "protected_branch_write_denied", "force_push_denied",
  "INVALID_BRANCH_NAME", "INVALID_REPOSITORY_URL", "REPOSITORY_NOT_CONNECTED", "CREDENTIAL_MISSING",
  "INVALID_IDENTIFIER", "INVALID_WORKSPACE", "INVALID_PATH", "PROTECTED_FILE", "FILES_REQUIRED",
  "DUPLICATE_PATHS", "TOO_MANY_FILES", "INVALID_COMMIT", "NO_CHECKPOINT", "CHECKPOINT_NO_COMMIT",
  "PROJECT_ACCESS_DENIED", "PROJECT_WRITE_DENIED", "PROJECT_ARCHIVED", "INVALID_AGENT_SLUG",
  "INVALID_WORKTREE_PATH",
  "subagent_control_unavailable", "subagent_not_continuable", "subagent_control_busy", "subagent_unknown_outcome", "subagent_session_missing", "subagent_child_not_found",
  "subagent_type_unknown", "subagent_summary_required", "subagent_path_outside_scope",
  "subagent_tool_not_published", "subagent_tool_not_delegable", "subagent_parent_scope_unresolved",
  "subagent_parallelism_exceeded", "subagent_capability_scope_empty",
  "subagent_handoff_content_rejected", "subagent_handoff_refused_credential",
  "subagent_write_scope_conflict", "subagent_detached_disabled", "subagent_reserve_failed",
]);

/** Recognises a canonical `CodeToolError` (different class, same contract) by shape. */
export function canonicalFailure(error: unknown): { code: CodeToolErrorCode; status: number; message: string; tool?: string; step?: string; retryable: boolean } | null {
  if (error instanceof CanonicalCodeToolError) {
    const shaped = error as CanonicalCodeToolError & { httpStatus?: number };
    return {
      code: error.code as CodeToolErrorCode,
      status: shaped.httpStatus ?? 400,
      message: error.message,
      tool: error.tool,
      step: error.step,
      retryable: error.retryable === true,
    };
  }
  const shaped = error as { code?: unknown; httpStatus?: unknown; status?: unknown; message?: unknown; tool?: unknown; step?: unknown; retryable?: unknown };
  if (shaped && typeof shaped.code === "string" && CANONICAL_ERROR_CODES.has(shaped.code)) {
    return {
      code: shaped.code as CodeToolErrorCode,
      // Structured port errors carry either `httpStatus` (canonical) or a numeric `status` (runtime-shaped).
      status: typeof shaped.httpStatus === "number" ? shaped.httpStatus : (typeof shaped.status === "number" ? shaped.status : 400),
      message: shaped.code === "secret_content"
        ? "Workspace content protection refused the operation. Remove hardcoded credentials introduced by this run; use runtime-generated test credentials or approved secret environment references. Protection remains enforced. This is not an approval request: user approval cannot override content protection. Do not offer an exception or suggest another tool to transfer the same protected content."
        : typeof shaped.message === "string" ? shaped.message : "Tool error",
      tool: typeof shaped.tool === "string" ? shaped.tool : undefined,
      step: typeof shaped.step === "string" ? shaped.step : undefined,
      retryable: shaped.retryable === true,
    };
  }
  return null;
}

export class CodeToolError extends Error {
  constructor(
    public readonly code: CodeToolErrorCode,
    message: string,
    public readonly status = 400,
    public readonly step = "validate",
    public readonly retryable = false,
    public readonly tool?: string,
    /** Structured context (current revision, approval id, reason); never file content or secrets. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CodeToolError";
  }

  toJSON() {
    return { code: this.code, status: this.status, message: this.message, step: this.step, retryable: this.retryable, tool: this.tool ?? null, details: this.details ?? null };
  }
}
