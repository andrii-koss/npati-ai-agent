/**
 * C11 — the **typed** git-write intent.
 *
 * The C5a protected-branch hard deny reads a branch name and an operation. Until C11 that pair could only
 * come from `detectGitWriteAttempts` (`code-shell-classifier.ts`), i.e. from the text of a shell command.
 * Two consequences were unacceptable and are what this module exists to remove:
 *
 *  1. a `git push` with **no refspec** yields `branch: ""` (the branch is a property of the checkout, not
 *     of the command line), so the protected-branch phase had nothing to compare against and the write
 *     fell through to the ordinary `approval` class;
 *  2. a git **tool** call has no `command` at all, so phase 4b never saw it: the whole git-tool surface
 *     was outside the protected-branch gate while looking covered.
 *
 * The intent below is the single, explicit shape a git write travels in — `gitOperation`, `sourceBranch`,
 * `targetBranch`, `remoteBranch`, `remote`, `force` and the credential reference. It is:
 *
 *  - **typed**, never parsed out of a command string, so the policy phase and the git-policy boundary
 *    decide on the same fields;
 *  - **structural** for a tool call (`gitWriteIntentFromToolInput` reads the tool's own typed arguments);
 *  - **the approval payload** (`gitApprovalPayload`): an approval for a remote write is bound to the
 *    branch, the remote, `force` and the credential reference, so "some push" can never be redeemed for a
 *    different target — and, since decision 13, to the fact that the write has to **create** the repository
 *    (`repositoryInitialized`), so an approval for "push into an existing repository" can never be redeemed
 *    for "create the repository and push";
 *  - **fail closed** in both directions: an intent without a branch is refused
 *    (`git_push_requires_resolved_branch`) rather than treated as "no branch to protect", and a git-write
 *    tool that carries no intent is refused (`git_write_intent_required`) rather than skipping the gate.
 *
 * This module is a leaf: it imports nothing, so the policy engine, the protected-branch service, the
 * git-policy boundary and the Company tool runtime can all share it without a cycle.
 */

export type GitWriteOperation = "push" | "force_push";

export interface GitWriteIntent {
  /** The operation itself. `force_push` means the write rewrites history. */
  gitOperation: GitWriteOperation;
  /**
   * The local branch the write reads from. `null` when the caller cannot name one (an unrefspec'd shell
   * push whose checkout is unknown) — never guessed.
   */
  sourceBranch: string | null;
  /**
   * The branch **on the remote** the write targets. This is the protected-branch policy's subject, so an
   * empty value is never a valid intent: it is `git_push_requires_resolved_branch`.
   */
  targetBranch: string;
  /** The remote branch named by an explicit refspec, when it differs from `targetBranch`. */
  remoteBranch: string | null;
  /** The remote (a name or a credential-free URL) the write goes to, when it is known. */
  remote: string | null;
  /** True when the write rewrites history. Must agree with `gitOperation === "force_push"`. */
  force: boolean;
  /** The credential reference the write will use, when the caller names one. */
  credentialId?: string | null;
  /**
   * C11 (owner decision 13, the last known issue): the state of the repository the write targets, as the
   * party that **inspected it read-only** found it. `false` means the write creates the repository as part
   * of the act — `ProjectGitService.ensureRepositoryInitialized()` will run `git init` behind the approval —
   * so the approval is bound to that fact (see `gitApprovalPayload`/`bindsRepositoryInitialization`).
   * `true` or absent means an ordinary write against a repository that already exists.
   *
   * It is deliberately **not** read from a caller's argument (`gitWriteIntentFromToolInput` never looks at
   * it): only an inspection can answer it, and a claim would be worth nothing. The boundary resolves it from
   * the repository itself and the request side resolves it through the same read-only inspector, so both
   * sides of the approval hash are computed from one implementation.
   */
  repositoryInitialized?: boolean | null;
}

/**
 * The tool ids whose call performs a **remote branch write**. `code.git.push` is the name the owner
 * decision uses; the set is the single insertion point for the git-workflow stream that publishes the
 * `code.git.*` capabilities (add the new id here and the protected-branch phase covers it).
 */
export const GIT_WRITE_TOOLS: readonly string[] = ["code.git.push", "code.git.force_push", "project.git.push"];

export function isGitWriteTool(tool: string): boolean {
  return GIT_WRITE_TOOLS.includes(String(tool ?? ""));
}

/** A shell push whose target branch could not be established. Never silently treated as unprotected. */
export const GIT_PUSH_REQUIRES_RESOLVED_BRANCH = "git_push_requires_resolved_branch";
/** A git-write tool that carries no typed intent: refused instead of skipping the protected-branch gate. */
export const GIT_WRITE_INTENT_REQUIRED = "git_write_intent_required";
/** A typed intent that is internally inconsistent or names no valid branch. */
export const GIT_WRITE_INTENT_INVALID = "git_write_intent_invalid";

/**
 * Branch normalisation shared by the intent and the protected-branch policy: `refs/heads/main`, `+main`
 * and `main` are the same branch, and surrounding whitespace is never part of a branch name.
 */
export function normalizeGitBranch(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^\+/, "")
    .replace(/^refs\/heads\//, "");
}

function optionalBranch(value: unknown): string | null {
  const branch = normalizeGitBranch(value);
  return branch ? branch : null;
}

function optionalText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function firstBranch(...values: unknown[]): string | null {
  for (const value of values) {
    const branch = optionalBranch(value);
    if (branch) return branch;
  }
  return null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = optionalText(value);
    if (text) return text;
  }
  return null;
}

function operationOf(value: unknown): GitWriteOperation | null {
  return value === "push" || value === "force_push" ? value : null;
}

/**
 * Validates an intent a caller supplies. Returns `null` for anything that is not a complete, consistent
 * intent — a caller must treat `null` as a refusal, never as "nothing to check".
 *
 * `force` and `gitOperation` cannot disagree: a write that carries `force: true` while claiming `push`
 * (or the reverse) is refused rather than resolved in either direction.
 */
export function normalizeGitWriteIntent(value: unknown): GitWriteIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const gitOperation = operationOf(record.gitOperation ?? record.operation);
  if (!gitOperation) return null;
  const targetBranch = firstBranch(record.targetBranch, record.branch, record.remoteBranch);
  if (!targetBranch) return null;
  const force = record.force === true;
  if (force !== (gitOperation === "force_push")) return null;
  return {
    gitOperation,
    sourceBranch: optionalBranch(record.sourceBranch) ?? targetBranch,
    targetBranch,
    remoteBranch: optionalBranch(record.remoteBranch) ?? targetBranch,
    remote: optionalText(record.remote),
    force,
    credentialId: optionalText(record.credentialId),
    // C11: the initialization fact survives normalisation — a shell path cannot produce it, but a caller that
    // inspected the repository (the request side of an approval) can, and dropping it here would make the two
    // sides of the approval hash disagree. Only a resolved `false` is carried; anything else means "existing
    // repository" (see `bindsRepositoryInitialization`).
    ...(record.repositoryInitialized === false ? { repositoryInitialized: false } : {}),
  };
}

/**
 * The **structural** detector for a git tool call: the operation, the branch, the remote and `force` come
 * from the tool's own typed arguments, never from a command line. Returns `null` when the call does not
 * name a target branch, which the caller must refuse (`git_push_requires_resolved_branch`) instead of
 * running a write whose target is unknown.
 */
export function gitWriteIntentFromToolInput(tool: string, input: Record<string, unknown> | null | undefined): GitWriteIntent | null {
  if (!isGitWriteTool(tool)) return null;
  const record = input ?? {};
  const targetBranch = firstBranch(record.targetBranch, record.branch, record.remoteBranch);
  if (!targetBranch) return null;
  const declared = operationOf(record.gitOperation ?? record.operation);
  const force = record.force === true || declared === "force_push";
  return {
    gitOperation: force ? "force_push" : "push",
    sourceBranch: optionalBranch(record.sourceBranch) ?? targetBranch,
    targetBranch,
    remoteBranch: optionalBranch(record.remoteBranch) ?? targetBranch,
    // Only a remote the caller *named* is recorded here. The repository a project pushes to is pinned by
    // the stored, credential-free `repositoryUrl` and is not choosable by a tool input, so inventing it
    // here would make the approval payload (built on both sides) disagree with itself for no gain.
    remote: firstText(record.remote),
    force,
    credentialId: optionalText(record.credentialId),
    // Deliberately no `repositoryInitialized`: whether the repository exists is a fact about the disk, not
    // something a caller may declare. The request side resolves it with `ProjectGitService.inspectRepository`
    // (read-only) and the boundary resolves it again immediately before the write.
  };
}

/**
 * A shell `git push` hint turned into an intent. `branch: ""` (no refspec) is resolved from
 * `resolvedBranch` — the branch the caller established for the checkout — and yields `null` when no
 * branch could be established, so the caller refuses with `git_push_requires_resolved_branch`.
 */
export function gitWriteIntentFromShellAttempt(
  attempt: { operation: GitWriteOperation; branch: string },
  resolvedBranch?: string | null,
): GitWriteIntent | null {
  const named = normalizeGitBranch(attempt.branch);
  const target = named || normalizeGitBranch(resolvedBranch);
  if (!target) return null;
  const source = named || target;
  return {
    gitOperation: attempt.operation,
    sourceBranch: source,
    targetBranch: target,
    remoteBranch: target,
    remote: null,
    force: attempt.operation === "force_push",
  };
}

/**
 * C11 (owner decision 13): does this write **create** the repository as part of the act?
 *
 * Exactly one value binds it — a resolved `false` — and that resolution comes from an inspection of the
 * repository, never from a caller's argument. The fact is therefore **additive and asymmetric on purpose**:
 *
 *  - an ordinary write (`true`, or nothing known) produces the payload this module produced before
 *    decision 13, byte for byte, so every approval hash that already exists keeps working;
 *  - a write that has to initialize produces a payload with `git.repositoryInitialized: false` — a different
 *    hash, so an approval granted for "push into an existing repository" cannot be redeemed for
 *    "create the repository and push", and an approval granted for the second cannot be redeemed for the
 *    first. That is the same binding the branch, the remote, `force` and the credential reference already
 *    have, and it is what makes the two acts non-interchangeable in **both** directions.
 *
 * Both hashers read the fact through this one function (`gitApprovalPayload` here and `payloadHashFor` in
 * `code-policy-engine.ts`), so they cannot drift into hashing different material.
 */
export function bindsRepositoryInitialization(intent: Pick<GitWriteIntent, "repositoryInitialized"> | null | undefined): boolean {
  return intent?.repositoryInitialized === false;
}

/**
 * The payload an approval for a remote git write is bound to. It is deliberately **not** the raw tool
 * input: the approval names the operation, the source and target branch, the remote, `force` and the
 * credential reference, so a one-shot approval cannot be replayed against another branch, another remote
 * or another credential. Both the request side (`company-runtime.ts`) and the consumption side
 * (`project-git-service.ts`, at the git-policy boundary) build it with this one function, which is what
 * makes the payload hashes comparable.
 */
export function gitApprovalPayload(input: { projectId: string; tool: string; intent: GitWriteIntent }): Record<string, unknown> {
  const intent = input.intent;
  return {
    projectId: String(input.projectId ?? ""),
    tool: String(input.tool ?? ""),
    git: {
      gitOperation: intent.gitOperation,
      sourceBranch: intent.sourceBranch,
      targetBranch: intent.targetBranch,
      remoteBranch: intent.remoteBranch,
      remote: intent.remote,
      force: intent.force,
      credentialId: intent.credentialId ?? null,
      // C11 (owner decision 13): present only when the write has to create the repository (see
      // `bindsRepositoryInitialization`). `true` is never written: absence means "an existing repository",
      // which is what keeps every pre-existing approval hash unchanged.
      ...(bindsRepositoryInitialization(intent) ? { repositoryInitialized: false } : {}),
    },
  };
}

/**
 * The same binding for opening a pull request. It is a separate function because a pull request writes no
 * branch: its target is the pair (`base`, `head`) it asks the human to review and merge. The protected
 * branch itself is only ever written by that human merge, which is the sanctioned pathway the
 * protected-branch service documents. The repository is identified by `projectId` (the stored URL is not
 * choosable by the caller), so the binding is the pair of branches plus the credential reference.
 */
export function pullRequestApprovalPayload(input: {
  projectId: string;
  tool: string;
  base: string;
  head: string;
  credentialId?: string | null;
}): Record<string, unknown> {
  return {
    projectId: String(input.projectId ?? ""),
    tool: String(input.tool ?? ""),
    pullRequest: {
      base: normalizeGitBranch(input.base),
      head: normalizeGitBranch(input.head),
      credentialId: optionalText(input.credentialId),
    },
  };
}
