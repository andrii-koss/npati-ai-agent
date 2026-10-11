import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { GIT_CONFLICT_ESCALATED, MAX_GIT_MERGE_ATTEMPTS } from "./code-git-workflow";
import { status } from "./project-git-repository-service";

export const execFileAsync = promisify(execFile);
export class GitError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    /**
     * C11 (owner decision 13): structured detail for a refusal a caller can act on — currently
     * `repository_not_initialized`, whose `requiresInitialization` tells a requester that this write is a
     * *different* act that needs its own approval. It travels to the tool layer unchanged (`rethrowGit` copies
     * it into the structured tool error), so the model learns *why* instead of parsing a message.
     *
     * The union with `string` is not new: `GitConflictEscalationError` has carried its escalation text in
     * `details` since the merge-conflict work, and a subclass property must stay assignable to this one.
     */
    public readonly details: Record<string, unknown> | string = {},
  ) {
    super(message);
    this.name = "GitError";
  }
}
export class GitConflictError extends GitError {
  constructor(
    public readonly conflictingFiles: string[],
    public readonly details: string,
  ) {
    super(
      "GIT_CONFLICT",
      `Git merge conflict detected in ${conflictingFiles.length} file(s): ${conflictingFiles.join(", ")}`,
      409,
    );
    this.name = "GitConflictError";
  }
}
export class GitConflictEscalationError extends GitError {
  constructor(
    public readonly conflictingFiles: string[],
    public readonly details: string,
    public readonly escalation?: {
      attempts: number;
      maxAttempts: number;
      sourceBranch: string;
      targetBranch: string;
      suggestedTool: "code.ask_user";
      question: string;
    },
  ) {
    const attempts = escalation?.attempts ?? 0;
    const maxAttempts = escalation?.maxAttempts ?? MAX_GIT_MERGE_ATTEMPTS;
    super(
      "GIT_CONFLICT_ESCALATED",
      `Git merge conflict in ${conflictingFiles.length} file(s) after ${attempts} of at most ${maxAttempts} automatic `
      + `attempt(s); escalating to user intervention for files: ${conflictingFiles.join(", ")}`,
      409,
    );
    this.name = "GitConflictEscalationError";
  }
}
export class GitApprovalRequiredError extends GitError {
  constructor(message = "External Git write operation requires explicit human approval") {
    super("GIT_APPROVAL_REQUIRED", message, 403);
    this.name = "GitApprovalRequiredError";
  }
}
export function validId(value: string) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}
export function redactSecrets(text: string): string {
  return text.replace(/https:\/\/[^@\s]+@/g, "https://***@")
    .replace(/(?:ghp_|github_pat_)[a-zA-Z0-9_]+/g, "***TOKEN***")
    // C11: the git credential is delivered as an `Authorization: Basic <base64>` extraheader. A failing
    // git command can echo the config it was given (`-c`/`GIT_CONFIG_VALUE_n` appear in some messages), and
    // the base64 blob would not match either pattern above, so the header is masked explicitly.
    .replace(/Authorization:\s*(?:Basic|Bearer)\s+[A-Za-z0-9+/=_-]+/gi, "Authorization: ***")
    .replace(/GIT_CONFIG_VALUE_\d+=\S*/g, "GIT_CONFIG_VALUE_***");
}
