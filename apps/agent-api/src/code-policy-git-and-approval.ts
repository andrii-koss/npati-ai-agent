import { createHash } from "node:crypto";
import { canonicalJson } from "@npati/workspace";
import type {
  PolicyRequest,
  PolicyResult,
  PolicyEngineDeps,
  PolicyRisk,
  PolicyPhase,
} from "./code-policy-engine";
import { APPROVAL_DEFERRED_REASON } from "./code-policy-tools";
import { detectGitWriteAttempts } from "./code-shell-classifier";
import { approvalActionFor, redactDenyComment } from "./code-approval-scope";
import { CredentialMasker } from "./security-guardrails";
import {
  MCP_APPROVAL_TTL_MS,
  mcpApprovalPayloadFor,
} from "./mcp-approval";
import {
  GIT_PUSH_REQUIRES_RESOLVED_BRANCH,
  GIT_WRITE_INTENT_INVALID,
  GIT_WRITE_INTENT_REQUIRED,
  bindsRepositoryInitialization,
  gitWriteIntentFromShellAttempt,
  isGitWriteTool,
  normalizeGitBranch,
  normalizeGitWriteIntent,
  type GitWriteIntent,
} from "./code-git-write-policy";

export function denyPolicyResult(
  code: string,
  message: string,
  status: number,
  phase: PolicyPhase,
  retryable = false,
): PolicyResult {
  return { decision: "deny", phase, reasons: [message], code, status, retryable };
}

/**
 * C11 (owner decision 3): every git write this request performs, as a typed intent.
 *
 * Three sources, and a refusal is always preferred over a guess:
 *  - `request.git` — the typed intent a git tool supplies. It must be complete and internally
 *    consistent, otherwise `git_write_intent_invalid` (a `force: true` "push", or no branch at all, is
 *    not something to resolve in either direction);
 *  - `request.command` — the shell path. A refspec names its branch; a push with **no** refspec gets its
 *    branch from `gitBranchResolver` and is refused with `git_push_requires_resolved_branch` when the
 *    resolver is absent, throws or answers with nothing. `branch: ""` therefore never reaches a decision;
 *  - a git-write **tool** that supplies neither is refused with `git_write_intent_required`, because a
 *    tool call has no command line and must not slip past the protected-branch phase.
 *
 * A command and a declared intent are both evaluated when both are present: a caller cannot declare a
 * harmless target while the command line writes to another one.
 */
export async function evaluateGitWriteIntents(
  deps: PolicyEngineDeps,
  request: PolicyRequest,
): Promise<{ intents: GitWriteIntent[] } | { refusal: PolicyResult }> {
  const intents: GitWriteIntent[] = [];
  if (request.git) {
    const declared = normalizeGitWriteIntent(request.git);
    if (!declared) {
      return {
        refusal: {
          ...denyPolicyResult(
            GIT_WRITE_INTENT_INVALID,
            "The git write request is incomplete or inconsistent (operation, target branch and force must agree)",
            403,
            "hard_deny",
          ),
          risk: "hard_deny",
        },
      };
    }
    intents.push(declared);
  }
  if (request.command !== undefined) {
    for (const attempt of detectGitWriteAttempts(request.command)) {
      let resolved: string | null = null;
      if (!normalizeGitBranch(attempt.branch)) {
        try {
          resolved = normalizeGitBranch((await deps.gitBranchResolver?.(request)) ?? "");
        } catch (error) {
          // A resolver that fails is not evidence that the branch is unprotected.
          deps.logger?.warn({ err: error, companyId: request.companyId }, "policy_git_branch_resolution_failed");
          resolved = "";
        }
      }
      const intent = gitWriteIntentFromShellAttempt(attempt, resolved);
      if (!intent) {
        return {
          refusal: {
            ...denyPolicyResult(
              GIT_PUSH_REQUIRES_RESOLVED_BRANCH,
              "A git push without a refspec writes to the branch of the checkout; that branch could not be " +
                "resolved, so the write is refused rather than assumed to be unprotected",
              403,
              "hard_deny",
            ),
            risk: "hard_deny",
          },
        };
      }
      intents.push(intent);
    }
  }
  if (!intents.length && isGitWriteTool(request.tool)) {
    return {
      refusal: {
        ...denyPolicyResult(
          GIT_WRITE_INTENT_REQUIRED,
          `Tool ${request.tool} performs a remote git write, so it must carry the typed git intent ` +
            "(operation, target branch, remote, force); without it the write cannot be checked against the " +
            "protected-branch policy",
          403,
          "hard_deny",
        ),
        risk: "hard_deny",
      },
    };
  }
  return { intents };
}

/**
 * C5: turns a rejected approval into a structured `approval_denied` result carrying the reviewer's
 * comment. Returns null when the approval was not actually rejected, so every other consumption
 * failure keeps its existing code and status.
 */
export async function describePolicyRejection(
  deps: PolicyEngineDeps,
  request: PolicyRequest,
  code: string,
): Promise<PolicyResult | null> {
  if (!deps.getApproval) return null;
  const approvalId = String(request.approvalId ?? request.toolCallId ?? "");
  const approval = await deps.getApproval(request.ctx, request.companyId, approvalId).catch(() => null);
  const status = String(approval?.status ?? "").toLowerCase();
  if (status !== "rejected" && code !== "approval_rejected") return null;
  const comment = redactDenyComment(approval?.comment ?? approval?.notes);
  return {
    decision: "deny", phase: "approval", status: 403, retryable: false,
    code: "approval_denied",
    reasons: ["approval:rejected", ...(comment ? [`approval:comment:${comment}`] : [])],
  };
}

export async function evaluatePolicyApproval(
  deps: PolicyEngineDeps,
  request: PolicyRequest,
  reasons: string[],
  risk: PolicyRisk | undefined,
  phase: PolicyPhase,
  details?: Record<string, unknown>,
): Promise<PolicyResult> {
  const approvals = deps.approvals;
  /**
   * C11 (owner decision 5): the approval is deferred to a boundary that binds it more strongly than this
   * phase can. The git boundary rebuilds the payload from the branch it is about to write and consumes the
   * record with that hash, so creating a record here (or spending the caller's) would be strictly worse:
   * it would either add a second, weaker approval or leave the boundary with nothing to verify.
   *
   * The check sits **after** every hard-deny phase, so a deferred approval can never turn a refusal into an
   * allow; and it sits before the missing-port refusal, because a deployment whose approval gateway is not
   * wired here may still have a fully wired git boundary.
   */
  if (request.approvalDeferredByBoundary === true) {
    return {
      decision: "allow", phase, risk, status: 200,
      reasons: [...reasons, APPROVAL_DEFERRED_REASON],
    };
  }
  if (!approvals) return denyPolicyResult("approval_unavailable", "Approval system is not configured", 503, phase);
  /**
   * C13 (owner blocker 1): the approval **material** of a runtime MCP call.
   *
   * `mcpApprovalPayloadFor` is the one builder both sides use (see `mcp-approval.ts` for why that is the whole
   * point). Two consequences are deliberate:
   *
   *  - the material is handed to the durable approval store as its `inputPayload`, so the row's own
   *    `payload_hash` is the hash of *this* call — the same value the run path will present when it redeems
   *    the record. Without it the store would hash an empty payload and no runtime MCP approval could ever be
   *    consumed;
   *  - the repo-shaped fields (`toolName`, `actionSummary`, `runId`, `agentId`, `riskLevel`, `ttlMs`) travel
   *    with it, because `CompanyApprovalsRepository.requestApproval` is the real implementation behind this
   *    port and it needs exactly those to write the row. A deployment whose approval gateway is the store
   *    therefore creates a real, redeemable, one-shot approval for an MCP call.
   */
  // A `PolicyRequest` structurally satisfies `McpApprovalSubject`, which is what lets the run path and this
  // phase build the material from the same values with the same function.
  const mcpPayload = mcpApprovalPayloadFor(request);
  // The person deciding sees the command and folder it approves (V6 step 17: the card said only "run a terminal
  // command"); secrets in the command are masked, and the environment stays in the hash only.
  const shellCommand = request.tool === "code.shell.exec" ? approvalVisibleCommand(request.command) : null;
  const shellPayload = request.tool === "code.shell.exec" ? {
    tool: request.tool, projectId: request.projectId ?? null, sessionId: request.sessionId ?? null,
    command: shellCommand, cwd: request.shellExecution?.cwd ?? null,
    executionHash: createHash("sha256").update(canonicalJson({ command: request.command ?? null,
      cwd: request.shellExecution?.cwd ?? null, env: request.shellExecution?.env ?? {} })).digest("hex"),
  } : null;
  // The durable store must receive the same canonical material and identity when requesting and redeeming.
  const boundPayload = mcpPayload ?? shellPayload;
  const runtimeApprovalFields = boundPayload
    ? {
        toolName: request.tool,
        actionSummary: mcpPayload ? `Runtime MCP tool ${request.tool} requires an approval for this exact call`
          : shellCommand ? `Run in the project terminal: ${shellCommand.slice(0, 300)}`
          : `${request.tool} requires an approval for this exact call`,
        inputPayload: boundPayload,
        runId: request.runId ?? "",
        agentId: request.agentId ?? "",
        riskLevel: "high" as const,
        // A paused run can outlive a tab and a process restart, so the window is the store's own maximum.
        ttlMs: MCP_APPROVAL_TTL_MS,
      }
    : {};
  if (request.approved === true || request.approvalId) {
    const expected = payloadHashFor(request);
    try {
      await approvals.consumeApproved(request.ctx, request.companyId, String(request.approvalId ?? request.toolCallId ?? ""), {
        ...(boundPayload
          ? {
              // The consuming side of the same material: `run_id`, `agent_id`, `tool_name` and the payload
              // hash are all matched by the store's own atomic statement.
              runId: request.runId ?? "",
              agentId: request.agentId ?? "",
              toolName: request.tool,
              inputPayload: boundPayload,
            }
          : {}),
        payloadHash: expected, tool: request.tool, toolCallId: request.toolCallId,
      });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "approval_invalid";
      // A rejection is not a failure to consume: the reviewer's comment (redacted, capped, and
      // explicitly marked as data) is what the model needs in order to change its approach.
      const rejection = await describePolicyRejection(deps, request, code);
      if (rejection) return rejection;
      return denyPolicyResult(code, error instanceof Error ? error.message : "Approval could not be consumed", 409, phase);
    }
    return { decision: "allow", phase, reasons: [...reasons, "approval:consumed"], risk, status: 200 };
  }
  // The company chose to let its agents act without asking. A git write still asks: its approval is consumed again at the
  // git boundary, and publishing code is the one action the setting does not cover.
  if (deps.companyAutoAllow && phase !== "project_rules" && !request.git && !isGitWriteTool(request.tool) && !writesGitFromShell(request.command)
      && await deps.companyAutoAllow(request.ctx, request.companyId).catch(() => false)) {
    return { decision: "allow", phase, risk, status: 200, reasons: [...reasons, "approval:company_setting", `approval:action:${approvalActionFor(request)}`] };
  }
  // C5: a standing rule for this action short-circuits the request. Never consulted for an approval
  // raised in the `project_rules` phase, because that phase precedes the network enforcement gate.
  if (deps.approvalRules && phase !== "project_rules") {
    const action = approvalActionFor(request);
    const rule = await deps.approvalRules
      .findRule(request.ctx, {
        companyId: request.companyId, projectId: request.projectId ?? null,
        sessionId: request.sessionId ?? null, action,
      })
      .catch(() => null);
    if (rule) {
      request.ruleRef = { scope: rule.scope, id: rule.id };
      return {
        decision: "allow", phase, risk, status: 200,
        reasons: [...reasons, `approval:rule:${rule.scope}`, `approval:rule_id:${rule.id}`, `approval:action:${action}`],
      };
    }
  }
  try {
    const created = await approvals.requestApproval(request.ctx, request.companyId, {
      tool: request.tool,
      payloadHash: payloadHashFor(request),
      toolCallId: request.toolCallId,
      // The scope a caller asks for is recorded on the request; `once` (the default) creates no rule.
      approvalScope: request.approvalScope ?? "once",
      approvalTimeoutMs: request.approvalTimeoutMs ?? null,
      digest: digestOf(request.command ?? request.paths?.join(",") ?? request.tool),
      // C6a: what a migration would do (target, destructive, snapshot, plan). Metadata only — no SQL,
      // no connection string and no credentials.
      ...(details ? { migration: details } : {}),
      // C13: the durable store's own fields plus the canonical MCP material, for a runtime MCP call.
      ...runtimeApprovalFields,
    });
    return {
      decision: "require_approval", phase, reasons: [...reasons, "approval:required"],
      code: "approval_required", status: 403, risk, approvalId: created.id,
    };
  } catch (error) {
    deps.logger?.warn({ err: error }, "policy_approval_request_failed");
    return denyPolicyResult("approval_unavailable", "Approval request could not be created", 503, phase);
  }
}

/** A shell command that writes to git (push, commit, reset...): the company setting does not cover it, like a git tool. */
/** A shell command as the approver sees it: known secret shapes and secret-named values masked, length bounded. */
export function approvalVisibleCommand(command: string | null | undefined): string | null {
  if (typeof command !== "string") return null;
  return CredentialMasker.mask(command)
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(/((?:--?|\b)[A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth)[A-Za-z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi, "$1[REDACTED]")
    .replace(/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, "$1[REDACTED]@")
    .slice(0, 2000);
}

export function writesGitFromShell(command: string | null | undefined): boolean {
  if (typeof command !== "string" || !command) return false;
  return detectGitWriteAttempts(command).length > 0
    || /\bgit\s+(?:-\S+\s+)*(push|commit|merge|rebase|reset|tag|cherry-pick|am|apply|remote|config|clean|checkout|restore|branch\s+-[dD])\b/i.test(command);
}

/**
 * Deterministic payload hash: an approval must be consumed with exactly the payload that was
 * approved, so substituting the command or paths between approval and execution is detected.
 *
 * C11: when the request is a git write, the **typed target** is part of the material — `gitOperation`,
 * `sourceBranch`, `targetBranch`, `remoteBranch`, `remote`, `force` and the credential reference. Before
 * C11 a branch or a remote was not in the hash at all, so an approval granted for one push could be
 * consumed for a push to a different branch of the same repository. The key is added only when a git
 * intent is present, so every non-git request keeps its previous hash.
 *
 * C11 (owner decision 13): the same material carries the **repository initialization** fact, and only when
 * the write has to create the repository (`bindsRepositoryInitialization`, shared with
 * `gitApprovalPayload` so the two hashers cannot drift). An approval granted for "push into an existing
 * repository" therefore hashes differently from one granted for "create the repository and push", while
 * every write against an existing repository keeps the exact bytes — and the exact hash — it had before.
 *
 * C13 (owner blocker 1): a **runtime MCP call** adds the tool's runtime identity — `providerId`,
 * `connectionId`, `toolName`, the schema hash and the hash of the exact (normalised) arguments. An approval
 * for one MCP call therefore cannot be spent on another: a different tool, a server that changed its input
 * schema, or different arguments all move the hash. The key is added only when the request carries
 * `runtimeMcp`, so every other request keeps the exact bytes — and the exact hash — it had before.
 */
export function payloadHashFor(request: PolicyRequest): string {
  const material = JSON.stringify({
    tool: request.tool,
    command: request.command ?? null,
    paths: [...(request.paths ?? [])].sort(),
    projectId: request.projectId ?? null,
    sessionId: request.sessionId ?? null,
    ...(request.git
      ? {
          git: {
            gitOperation: request.git.gitOperation,
            sourceBranch: request.git.sourceBranch ?? null,
            targetBranch: request.git.targetBranch ?? null,
            remoteBranch: request.git.remoteBranch ?? null,
            remote: request.git.remote ?? null,
            force: request.git.force === true,
            credentialId: request.git.credentialId ?? null,
            ...(bindsRepositoryInitialization(request.git) ? { repositoryInitialized: false } : {}),
          },
        }
      : {}),
    ...(request.runtimeMcp
      ? {
          runtimeMcp: {
            providerId: request.runtimeMcp.providerId,
            connectionId: request.runtimeMcp.connectionId,
            toolName: request.runtimeMcp.toolName,
            schemaHash: request.runtimeMcp.schemaHash,
            argsHash: request.runtimeMcp.argsHash,
          },
        }
      : {}),
  });
  return fnv1a(material);
}

/** Non-cryptographic digest used only for logs (never for security decisions). */
export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function digestOf(value: string): string { return fnv1a(value); }

/**
 * C5: the canonical action a scoped rule is keyed by. The implementation lives in
 * `code-approval-scope.ts` so the grant path and this enforcement path cannot drift apart; it is
 * re-exported here because the policy surface is where callers look for it.
 */
export { approvalActionFor } from "./code-approval-scope";
