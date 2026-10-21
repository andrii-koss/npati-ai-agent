/**
 * C3: which tools mutate state, which sub-flag they need, and when a change needs a human approval.
 *
 * The approval itself is *not* implemented here: this module only decides "does this change require an
 * approval, and what exactly is being approved". The decision is recorded through the existing
 * `CompanyApprovalsRepository` (see `code-workspace-checkpoint.ts`), which already verifies the payload
 * hash on consumption, so a payload swapped between approval and execution is refused.
 */

/**
 * Tools that mutate the workspace (or expose a mutation) and therefore require `code.write` in addition
 * to the master flag. Kept in one place so the runtime can pick the sub-flag before it resolves the tool.
 */
export const CODE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "code.data.backend.create",
  "code.data.schema.apply",
  "code.data.schema.modify",
  "code.data.rows.transfer",
  "code.data.backend.attach",
  "code.fs.write",
  "code.fs.edit",
  "code.fs.move",
  "code.fs.delete",
  "code.fs.apply_patch",
  "code.fs.diff",
  "code.fs.undo_last_turn",
]);

/** Tools that are destructive enough to always need an approval. */
export const CODE_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  "code.fs.delete",
]);

export interface CodeApprovalPolicy {
  /** More changed files than this in one call requires an approval. */
  bulkFileThreshold: number;
  /** Writing to a file matched by the sensitive-file policy requires an approval (when not denied). */
  approveSensitiveWrites: boolean;
  /** Approval lifetime; the existing repository rejects a consumed or expired approval. */
  ttlMs: number;
}

export function resolveApprovalPolicy(env: NodeJS.ProcessEnv = process.env): CodeApprovalPolicy {
  const threshold = Number.parseInt(env.NPATI_CODE_APPROVAL_BULK_FILES ?? "", 10);
  const ttl = Number.parseInt(env.NPATI_CODE_APPROVAL_TTL_MS ?? "", 10);
  return {
    bulkFileThreshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 10,
    approveSensitiveWrites: env.NPATI_CODE_APPROVAL_SENSITIVE_WRITES !== "false",
    ttlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : 30 * 60 * 1000,
  };
}

export interface CodeApprovalTarget {
  path: string;
  /** Content hash the approval is bound to (the file as it will be written / deleted). */
  sha256?: string | null;
  sensitive?: boolean;
}

export interface CodeApprovalDecision {
  required: boolean;
  reason: "delete" | "bulk_change" | "sensitive_write" | null;
  summary: string;
}

/**
 * Decides whether the change needs an approval. Order matters only for the reported reason; the
 * strictest match wins so an operator sees the most severe justification.
 */
export function requiresApproval(input: {
  tool: string;
  targets: CodeApprovalTarget[];
  policy: CodeApprovalPolicy;
}): CodeApprovalDecision {
  const { tool, targets, policy } = input;
  if (CODE_APPROVAL_TOOLS.has(tool)) {
    return { required: true, reason: "delete", summary: describeAction(tool, targets) };
  }
  if (targets.length > policy.bulkFileThreshold) {
    return { required: true, reason: "bulk_change", summary: describeAction(tool, targets) };
  }
  if (policy.approveSensitiveWrites && targets.some((target) => target.sensitive)) {
    return { required: true, reason: "sensitive_write", summary: describeAction(tool, targets) };
  }
  return { required: false, reason: null, summary: describeAction(tool, targets) };
}

export function describeAction(tool: string, targets: CodeApprovalTarget[]): string {
  const paths = targets.map((target) => target.path).sort();
  const shown = paths.slice(0, 5).join(", ");
  const extra = paths.length > 5 ? ` (+${paths.length - 5} more)` : "";
  return `${tool} would change ${paths.length} file(s): ${shown}${extra}`;
}

/**
 * Deterministic approval payload: sorted paths and hashes, so both the request and the consumption
 * produce byte-identical input for the repository's payload hash. `turnId`/`sessionId` are included so
 * an approval cannot be replayed for a different turn, and no file content ever enters the payload.
 *
 * C11: `extra` carries the tools whose subject is **not** a path list — a git write names a branch, a
 * remote and a credential reference, a `code.git.restore` names the paths it discards. It is appended
 * verbatim under its own key, so the file-tool payload stays byte-identical for every existing caller while
 * a git write's approval binds the fields that actually decide what happens.
 */
export function buildApprovalPayload(input: {
  tool: string;
  toolVersion: number;
  turnId: string;
  sessionId?: string;
  targets: CodeApprovalTarget[];
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const targets = [...input.targets]
    .map((target) => ({ path: target.path, sha256: target.sha256 ?? null }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    tool: input.tool,
    toolVersion: input.toolVersion,
    turnId: input.turnId,
    sessionId: input.sessionId ?? null,
    targets,
    ...(input.extra && Object.keys(input.extra).length ? input.extra : {}),
  };
}
