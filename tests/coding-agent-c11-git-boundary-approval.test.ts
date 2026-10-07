import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthContext, Project, WorkspaceStore } from "@npati/workspace";
import { RiskApprovalService } from "../packages/shared/src/risk-approval";
import { approvalPayloadForHash } from "../apps/agent-api/src/approvals-repository";
import {
  CodeToolRuntime,
  type CodeToolInvokeFailure,
  type CodeToolInvokeResult,
} from "../apps/agent-api/src/code-tool-runtime";
import { CODE_TOOL_SCHEMAS } from "../apps/agent-api/src/code-tool-registry";
import { canonicalGitExecutors } from "../apps/agent-api/src/code-tool-git-executors";
import { gitToolApprovalPayload, sessionBranchName } from "../apps/agent-api/src/code-git-workflow";
import { CodeProtectedBranchRepository, CodeProtectedBranchService } from "../apps/agent-api/src/code-protected-branches";
import { ProjectGitService, type ProjectGitBoundary } from "../apps/agent-api/src/project-git-service";

/**
 * C11 (owner decision 5, corrected): an approval for a `code.git.*` write is **redeemed**, not merely required.
 *
 * The defect these tests pin shut: the code path created the approval record with
 * `buildApprovalPayload({ …, extra: { git: gitToolApprovalPayload(…) } })`, while the git boundary consumed it
 * with `gitApprovalPayload({ projectId, tool, intent })` under a different tool id. Two different objects, two
 * different `payload_hash`es, so `CompanyApprovalsRepository.consumeApproved` matched no row and threw
 * `APPROVAL_INVALID`: a `code.git.push` could be requested, approved by a human, and still never be redeemed.
 * The "push only after a confirmation" rule held formally and not functionally.
 *
 * Everything below is driven through the **real** `CodeToolRuntime` and the **real** `ProjectGitService` — the
 * git process, the durable approval table and the credential lease are the only injected parts, and the
 * approval table is a faithful stand-in for `consumeApproved` (status, single use, expiry, `tool_name`,
 * `run_id`, `agent_id` and the canonical payload hash). What is therefore asserted is that the two sides of
 * the hash **agree**, not that two objects look alike in the source.
 */

const COMPANY = "company-1";
const PROJECT = "project-1";
const SESSION = "session-1";
const TURN = "turn-1";
const RUN = "run-1";
const AGENT = "agent-1";
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "ghp_C11BOUNDARYAPPROVALSECRET0123456789";
const REPOSITORY_URL = "https://github.com/example/site.git";
const SESSION_BRANCH = sessionBranchName(SESSION);
const PUSH = "code.git.push";
const PR_CREATE = "code.git.pr.create";
const PR_COMMENT = "code.git.pr.comment";

function owner(): AuthContext {
  return {
    workspaceId: "ws-1",
    companyId: COMPANY,
    userId: "u-owner",
    permissions: ["workspace:read", "workspace:write", "admin:all"],
  } as unknown as AuthContext;
}

function project(): Project {
  return {
    id: PROJECT, companyId: COMPANY, workspaceId: "ws-1", status: "ready",
    repositoryProvider: "github", repositoryUrl: REPOSITORY_URL, repositoryBranch: "main",
  } as unknown as Project;
}

/**
 * The durable approval table, with the behaviour of `CompanyApprovalsRepository`: a record is stored with the
 * hash of its payload, and it is consumed **atomically** against status, single use, expiry, context and hash.
 * The mirroring is deliberate — a stand-in that accepted any payload would make this suite prove nothing.
 */
class DurableApprovals {
  private readonly risk = new RiskApprovalService("c11-boundary-approval-secret");
  private readonly rows = new Map<string, {
    id: string; runId: string | null; agentId: string | null; toolName: string;
    payloadHash: string; status: "approved" | "rejected" | "pending"; expiresAt: number; consumedAt: number | null;
  }>();
  private sequence = 0;
  /** Every record the **request side** created, with the hash it will be matched against. */
  readonly requested: Array<{ id: string; toolName: string; inputPayload: Record<string, unknown>; payloadHash: string }> = [];
  /** Every consumption attempt the **boundary** made, with the hash it presented. */
  readonly consumes: Array<{ id: string; toolName: string; payloadHash: string }> = [];
  readonly refusals: string[] = [];
  readonly order: string[] = [];
  /** What the human answers. Flipped to `rejected` to prove that a refusal has no side effect. */
  decision: "approved" | "rejected" = "approved";

  private hash(payload: Record<string, unknown>): string {
    return this.risk.computePayloadHash(approvalPayloadForHash(payload));
  }

  /** Whether a record was spent (single use is the property the boundary relies on). */
  isConsumed(id: string): boolean {
    return this.rows.get(id)?.consumedAt !== null && this.rows.get(id)?.consumedAt !== undefined;
  }

  requestApproval(_ctx: AuthContext, _companyId: string, input: {
    runId?: string; agentId?: string; toolName: string; actionSummary: string;
    inputPayload?: Record<string, unknown>; ttlMs?: number;
  }): { id: string; expiresAt: string } {
    const id = `approval-${++this.sequence}`;
    const payload = input.inputPayload ?? {};
    const payloadHash = this.hash(payload);
    this.rows.set(id, {
      id,
      runId: input.runId || null,
      agentId: input.agentId || null,
      toolName: input.toolName,
      payloadHash,
      status: this.decision === "rejected" ? "rejected" : "approved",
      expiresAt: Date.now() + (input.ttlMs ?? 30 * 60 * 1000),
      consumedAt: null,
    });
    this.requested.push({ id, toolName: input.toolName, inputPayload: payload, payloadHash });
    this.order.push(`approval:request:${input.toolName}`);
    return { id, expiresAt: new Date(Date.now() + 1000).toISOString() };
  }

  consumeApproved(_ctx: AuthContext, _companyId: string, id: string, params: {
    runId: string; agentId: string; toolName: string; inputPayload: Record<string, unknown>;
  }): { id: string } {
    const row = this.rows.get(id);
    const payloadHash = this.hash(params.inputPayload);
    this.consumes.push({ id, toolName: params.toolName, payloadHash });
    const matches = Boolean(row)
      && row!.status === "approved"
      && row!.consumedAt === null
      && row!.expiresAt > Date.now()
      && row!.toolName === params.toolName
      && row!.runId === (params.runId || null)
      && row!.agentId === (params.agentId || null)
      && row!.payloadHash === payloadHash;
    if (matches) {
      row!.consumedAt = Date.now();
      this.order.push("approval:consume");
      return { id };
    }
    const reason = row?.consumedAt ? "Approval has already been consumed"
      : row && row.expiresAt <= Date.now() ? "Approval request has expired"
        : row && row.status !== "approved" ? `Approval is not approved (status: ${row.status})`
          : "Approval context or payload does not match";
    this.refusals.push(reason);
    throw Object.assign(new Error(reason), { status: 409, code: row?.consumedAt ? "APPROVAL_ALREADY_USED" : "APPROVAL_INVALID" });
  }
}

interface Harness {
  runtime: CodeToolRuntime;
  approvals: DurableApprovals;
  /** The argv of every `git push` the boundary really issued. */
  pushes: string[];
  /** Every git invocation, in order. */
  calls: string[][];
  /** Tool-call ids of every credential lease issued. */
  leases: string[];
  /** Pull requests opened / comments posted through the injected HTTP layer. */
  http: Array<{ url: string; body: Record<string, unknown> }>;
  dir: string;
  invoke(tool: string, args: Record<string, unknown>, extra?: { approvalId?: string; toolCallId?: string }): Promise<CodeToolInvokeResult | CodeToolInvokeFailure>;
  cleanup(): Promise<void>;
}

async function harness(options: { initialized?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "npati-c11-boundary-"));
  const dir = path.join(root, COMPANY, PROJECT);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), "<h1>site</h1>\n", "utf8");
  if (options.initialized !== false) await mkdir(path.join(dir, ".git"), { recursive: true });

  const calls: string[][] = [];
  const pushes: string[] = [];
  const leases: string[] = [];
  const http: Array<{ url: string; body: Record<string, unknown> }> = [];
  const approvals = new DurableApprovals();

  /**
   * The git process. It records argv, emulates `init` (so `ensureRepositoryInitialized` is observable as a
   * real change of state), answers the read-only probes and never touches a network.
   */
  const runGit = async (calledDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.push([...args]);
    approvals.order.push(`git:${args.join(" ")}`);
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: `${calledDir}\n`, stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: `${SESSION_BRANCH}\n`, stderr: "" };
    if (args[0] === "status") return { stdout: existsSync(path.join(calledDir, ".git")) ? `## ${SESSION_BRANCH}\n` : "", stderr: "" };
    if (args[0] === "init") {
      await mkdir(path.join(calledDir, ".git"), { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "push") {
      pushes.push(args.join(" "));
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };

  const boundary: ProjectGitBoundary = {
    assertGitWriteAllowed: (ctx, companyId, intent) => protectedBranchService().assertGitWriteAllowed(ctx, companyId, intent),
    approvals: {
      consumeApproved: async (ctx, companyId, id, params) => approvals.consumeApproved(ctx, companyId, id, params),
    },
    credentials: {
      acquire: async (input) => {
        leases.push(input.toolCallId);
        return { leaseId: `lease-${input.toolCallId}`, value: TOKEN };
      },
      revoke: async () => undefined,
    },
  };

  const store = { createProjectCheckpoint: async () => ({ id: "cp-1" }), listProjectCheckpoints: async () => [] } as unknown as WorkspaceStore;
  const service = new ProjectGitService(store, { get: async () => project() }, root, undefined, undefined, runGit, boundary);

  const executors = canonicalGitExecutors({
    git: service,
    sessionBranch: async ({ sessionId }) => (sessionId ? sessionBranchName(sessionId) : null),
    assertProtectedBranch: async ({ ctx, companyId, intent }) => {
      const decision = await protectedBranchService().evaluateGitWrite(ctx, companyId, intent);
      return {
        allowed: decision.allowed,
        branch: decision.branch,
        ...(decision.code ? { code: decision.code } : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
      };
    },
  });

  const runtime = new CodeToolRuntime({
    flags: { assertEnabled: async () => true } as never,
    schemas: CODE_TOOL_SCHEMAS,
    executors,
    toPort: () => ({}) as never,
    approvals: {
      request: async (input) => {
        const created = approvals.requestApproval(input.ctx, input.companyId, {
          runId: input.runId, agentId: input.agentId, toolName: input.toolName,
          actionSummary: input.actionSummary, inputPayload: input.inputPayload, ttlMs: input.ttlMs,
        });
        return { approvalId: created.id, expiresAt: created.expiresAt };
      },
      consume: async (input) => { approvals.consumeApproved(input.ctx, input.companyId, input.approvalId, input); },
    },
    approvalDecision: {
      timeoutMs: 1_000,
      wait: async () => (approvals.decision === "rejected"
        ? { status: "rejected" as const, comment: "not this time" }
        : { status: "approved" as const }),
    },
    repositoryState: {
      inspect: async ({ ctx, companyId, projectId }) => {
        const state = await service.inspectRepository(ctx, companyId, projectId);
        return { initialized: state.initialized };
      },
    },
  });

  let callCount = 0;
  return {
    runtime, approvals, pushes, calls, leases, http, dir,
    invoke: (tool, args, extra = {}) => runtime.invoke(owner(), {
      companyId: COMPANY, projectId: PROJECT, sessionId: SESSION, turnId: TURN,
      tool, args, runId: RUN, agentId: AGENT,
      toolCallId: extra.toolCallId ?? `call-${++callCount}`,
      ...(extra.approvalId ? { approvalId: extra.approvalId } : {}),
    }),
    cleanup: async () => { await rm(root, { recursive: true, force: true }); },
  };
}

function protectedBranchService(): CodeProtectedBranchService {
  return new CodeProtectedBranchService({
    store: new CodeProtectedBranchRepository(),
    resolveRole: async () => "owner",
    audit: { record: async () => undefined },
  });
}

function succeeded(result: CodeToolInvokeResult | CodeToolInvokeFailure): CodeToolInvokeResult {
  if (!result.ok) throw new Error(`expected the call to succeed, got ${result.error.code}: ${result.error.message}`);
  return result;
}

function refused(result: CodeToolInvokeResult | CodeToolInvokeFailure): CodeToolInvokeFailure {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.result)}`);
  return result;
}

function data(result: CodeToolInvokeResult): Record<string, unknown> {
  return (result.result as { data: Record<string, unknown> }).data;
}

/** Installs a fake GitHub HTTP layer for one test and returns a restore function. */
function stubGithubHttp(record: Array<{ url: string; body: Record<string, unknown> }>, response: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    record.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return { ok: true, status: 201, json: async () => response } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => { globalThis.fetch = original; };
}

// ---------------------------------------------------------------------------------------------
// 1. The push approval is redeemed at the boundary, and the push really happens
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 a `code.git.push` approval is redeemed at the git boundary", () => {
  it("requests, redeems and executes one push — the requested and the consumed payload hash are the same", async () => {
    const h = await harness();
    try {
      const result = succeeded(await h.invoke(PUSH, { targetBranch: SESSION_BRANCH, credentialId: CREDENTIAL_ID }));
      expect(data(result)).toMatchObject({ pushed: true, branch: SESSION_BRANCH, force: false });
      // The write really happened: one `git push` of the named refspec, one credential lease, revoked.
      expect(h.pushes).toHaveLength(1);
      expect(h.pushes[0]).toContain(`refs/heads/${SESSION_BRANCH}:refs/heads/${SESSION_BRANCH}`);
      expect(h.leases).toHaveLength(1);
      // The record was created once, under the tool the runtime gated, and consumed exactly once.
      expect(h.approvals.requested).toHaveLength(1);
      expect(h.approvals.requested[0]!.toolName).toBe(PUSH);
      expect(h.approvals.consumes).toHaveLength(1);
      /**
       * The proof that the two sides agree, and the whole point of this suite: the hash the request side
       * stored is the hash the boundary presented. Before the fix these differed by construction, so
       * `consumeApproved` refused with `APPROVAL_INVALID` and no push was ever issued.
       */
      expect(h.approvals.consumes[0]!.payloadHash).toBe(h.approvals.requested[0]!.payloadHash);
      expect(h.approvals.consumes[0]!.toolName).toBe(PUSH);
      expect(h.approvals.refusals).toEqual([]);
      // The payload the human approved names the operation, both branches, the remote and the credential.
      expect(h.approvals.requested[0]!.inputPayload).toMatchObject({
        projectId: PROJECT,
        tool: PUSH,
        git: {
          gitOperation: "push", sourceBranch: SESSION_BRANCH, targetBranch: SESSION_BRANCH,
          remoteBranch: SESSION_BRANCH, remote: null, force: false, credentialId: CREDENTIAL_ID,
        },
      });
      // An existing repository carries no initialization fact, so the payload is byte-identical to the one
      // this path produced before the fact existed — every already-issued approval keeps working.
      const git = (h.approvals.requested[0]!.inputPayload as { git: Record<string, unknown> }).git;
      expect(Object.prototype.hasOwnProperty.call(git, "repositoryInitialized")).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("binds both branches, and the refspec the boundary writes is the pair that was approved", async () => {
    const h = await harness();
    try {
      const result = succeeded(await h.invoke(PUSH, {
        targetBranch: "feature/remote", sourceBranch: "feature/local", credentialId: CREDENTIAL_ID,
      }));
      expect(data(result)).toMatchObject({ pushed: true, branch: "feature/remote" });
      // A `sourceBranch` that differs from the target is a field either side could drop; the write proves it.
      expect(h.pushes[0]).toContain("refs/heads/feature/local:refs/heads/feature/remote");
      expect((h.approvals.requested[0]!.inputPayload as { git: Record<string, unknown> }).git)
        .toMatchObject({ sourceBranch: "feature/local", targetBranch: "feature/remote" });
      expect(h.approvals.consumes[0]!.payloadHash).toBe(h.approvals.requested[0]!.payloadHash);
      expect(h.approvals.refusals).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  it("refuses without a decision and issues no side effect at all", async () => {
    const h = await harness();
    try {
      h.approvals.decision = "rejected";
      const refusal = refused(await h.invoke(PUSH, { targetBranch: SESSION_BRANCH, credentialId: CREDENTIAL_ID }));
      expect(refusal.error.code).toBe("approval_denied");
      // No push, no credential lease, and no consumption attempt: the refusal is before the write.
      expect(h.pushes).toHaveLength(0);
      expect(h.leases).toHaveLength(0);
      expect(h.approvals.consumes).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it("cannot redeem a record that was issued for another branch, and does not spend it", async () => {
    const h = await harness();
    try {
      // A record created (and approved) for `feature/one`.
      const foreign = h.approvals.requestApproval(owner(), COMPANY, {
        runId: RUN, agentId: AGENT, toolName: PUSH, actionSummary: "push feature/one",
        inputPayload: gitToolApprovalPayload({
          projectId: PROJECT, tool: PUSH,
          args: { targetBranch: "feature/one", credentialId: CREDENTIAL_ID }, repositoryInitialized: true,
        }),
      }).id;
      const refusal = refused(await h.invoke(PUSH, { targetBranch: "feature/two", credentialId: CREDENTIAL_ID }, { approvalId: foreign }));
      // The durable store's own code, preserved by the git boundary: the record does not authorise this write.
      expect(refusal.error.code).toBe("APPROVAL_INVALID");
      expect(h.pushes).toHaveLength(0);
      expect(h.leases).toHaveLength(0);
      // The record the write did not match is still unused, so the caller can present it for its own branch.
      expect(h.approvals.refusals).toHaveLength(1);
      const retry = succeeded(await h.invoke(PUSH, { targetBranch: "feature/one", credentialId: CREDENTIAL_ID }, { approvalId: foreign }));
      expect(data(retry)).toMatchObject({ pushed: true, branch: "feature/one" });
      expect(h.pushes).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. One approved record is one git write
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 one approved record is one git write", () => {
  it("refuses a second push that presents the record it already spent", async () => {
    const h = await harness();
    try {
      const record = h.approvals.requestApproval(owner(), COMPANY, {
        runId: RUN, agentId: AGENT, toolName: PUSH, actionSummary: "push",
        inputPayload: gitToolApprovalPayload({
          projectId: PROJECT, tool: PUSH,
          args: { targetBranch: SESSION_BRANCH, credentialId: CREDENTIAL_ID }, repositoryInitialized: true,
        }),
      }).id;
      const first = succeeded(await h.invoke(PUSH, { targetBranch: SESSION_BRANCH, credentialId: CREDENTIAL_ID }, { approvalId: record, toolCallId: "call-first" }));
      expect(data(first)).toMatchObject({ pushed: true });
      const second = refused(await h.invoke(PUSH, { targetBranch: SESSION_BRANCH, credentialId: CREDENTIAL_ID }, { approvalId: record, toolCallId: "call-second" }));
      expect(second.error.code).toBe("APPROVAL_ALREADY_USED");
      // Exactly one push and one lease: the second call wrote nothing.
      expect(h.pushes).toHaveLength(1);
      expect(h.leases).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  it("asks the human again for a second push in the same turn", async () => {
    const h = await harness();
    try {
      succeeded(await h.invoke(PUSH, { targetBranch: SESSION_BRANCH, credentialId: CREDENTIAL_ID }, { toolCallId: "call-1" }));
      // The git boundary consumed the first record at the first write, so the second call creates a new
      // request instead of inheriting the first one's decision.
      succeeded(await h.invoke(PUSH, { targetBranch: SESSION_BRANCH, credentialId: CREDENTIAL_ID }, { toolCallId: "call-2" }));
      expect(h.approvals.requested).toHaveLength(2);
      expect(h.approvals.consumes).toHaveLength(2);
      expect(h.approvals.consumes[0]!.id).not.toBe(h.approvals.consumes[1]!.id);
      expect(h.pushes).toHaveLength(2);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The pull request writes are redeemed the same way
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 `code.git.pr.create` and `code.git.pr.comment` are redeemed at the boundary", () => {
  it("opens the pull request the approval was granted for", async () => {
    const h = await harness();
    const restore = stubGithubHttp(h.http, { number: 42, html_url: "https://github.com/example/site/pull/42" });
    try {
      const result = succeeded(await h.invoke(PR_CREATE, {
        title: "Add the site", base: "main", head: SESSION_BRANCH, credentialId: CREDENTIAL_ID,
      }));
      expect(data(result)).toMatchObject({ prNumber: 42, created: true });
      expect(h.http).toHaveLength(1);
      expect(h.http[0]!.url).toBe("https://api.github.com/repos/example/site/pulls");
      expect(h.http[0]!.body).toMatchObject({ title: "Add the site", base: "main", head: SESSION_BRANCH });
      // The record was created under the tool the runtime gated and redeemed with the same payload hash.
      expect(h.approvals.requested[0]!.toolName).toBe(PR_CREATE);
      expect(h.approvals.consumes[0]!.payloadHash).toBe(h.approvals.requested[0]!.payloadHash);
      expect(h.approvals.refusals).toEqual([]);
    } finally {
      restore();
      await h.cleanup();
    }
  });

  it("posts the comment the approval was granted for, and nothing was spent on a refusal", async () => {
    const h = await harness();
    const restore = stubGithubHttp(h.http, { id: 7, html_url: "https://github.com/example/site/pull/3#issuecomment-7" });
    try {
      h.approvals.decision = "rejected";
      const denied = refused(await h.invoke(PR_COMMENT, { pullNumber: 3, body: "looks good", credentialId: CREDENTIAL_ID }));
      expect(denied.error.code).toBe("approval_denied");
      expect(h.http).toHaveLength(0);
      expect(h.approvals.consumes).toHaveLength(0);

      h.approvals.decision = "approved";
      /**
       * Whitespace is not part of what a comment approval binds: the boundary posts the **trimmed** body, so
       * the request side must hash the trimmed body too. Hashing the raw text made the two sides disagree for
       * any comment that arrived with a trailing newline — an approval that could never be redeemed for the
       * very comment it was granted for.
       */
      const result = succeeded(await h.invoke(PR_COMMENT, { pullNumber: 3, body: "  looks good\n", credentialId: CREDENTIAL_ID }));
      expect(data(result)).toMatchObject({ commentId: 7, pullNumber: 3, created: true });
      expect(h.http).toHaveLength(1);
      expect(h.http[0]!.url).toBe("https://api.github.com/repos/example/site/issues/3/comments");
      expect(h.http[0]!.body).toEqual({ body: "looks good" });
      expect(h.approvals.consumes.at(-1)!.payloadHash).toBe(h.approvals.requested.at(-1)!.payloadHash);
      expect(h.approvals.refusals).toEqual([]);
    } finally {
      restore();
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The three remote writes keep disjoint approval bindings
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 a push approval cannot be redeemed as a pull-request write, and the reverse", () => {
  it("refuses a comment approval presented for a push, and a push approval presented for a comment", async () => {
    const h = await harness();
    const restore = stubGithubHttp(h.http, { id: 7, html_url: "https://github.com/example/site/pull/3#issuecomment-7" });
    try {
      // A comment record, presented to the push path.
      const commentRecord = h.approvals.requestApproval(owner(), COMPANY, {
        runId: RUN, agentId: AGENT, toolName: PR_COMMENT, actionSummary: "comment",
        inputPayload: gitToolApprovalPayload({
          projectId: PROJECT, tool: PR_COMMENT,
          args: { pullNumber: 3, body: "looks good", credentialId: CREDENTIAL_ID },
        }),
      }).id;
      const pushRefusal = refused(await h.invoke(PUSH, { targetBranch: SESSION_BRANCH, credentialId: CREDENTIAL_ID }, { approvalId: commentRecord }));
      expect(pushRefusal.error.code).toBe("APPROVAL_INVALID");
      expect(h.pushes).toHaveLength(0);

      // A push record, presented to the comment path.
      const pushRecord = h.approvals.requestApproval(owner(), COMPANY, {
        runId: RUN, agentId: AGENT, toolName: PUSH, actionSummary: "push",
        inputPayload: gitToolApprovalPayload({
          projectId: PROJECT, tool: PUSH,
          args: { targetBranch: SESSION_BRANCH, credentialId: CREDENTIAL_ID }, repositoryInitialized: true,
        }),
      }).id;
      const commentRefusal = refused(await h.invoke(PR_COMMENT, { pullNumber: 3, body: "looks good", credentialId: CREDENTIAL_ID }, { approvalId: pushRecord }));
      expect(commentRefusal.error.code).toBe("APPROVAL_INVALID");
      // The write never reached GitHub, and neither record was spent by the attempt.
      expect(h.http).toHaveLength(0);
      expect(h.leases).toHaveLength(0);
      expect(h.approvals.refusals).toHaveLength(2);
      expect(h.approvals.isConsumed(pushRecord)).toBe(false);
      expect(h.approvals.isConsumed(commentRecord)).toBe(false);
      // ... and they are different bindings to begin with: the same project, credential and text, a different
      // act — so the two hashes cannot collide.
      expect(h.approvals.requested[0]!.payloadHash).not.toBe(h.approvals.requested[1]!.payloadHash);
    } finally {
      restore();
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 5. "This write creates the repository" is live on the code path too
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 the initialization fact is bound on the code path as well", () => {
  it("binds `repositoryInitialized: false` into the approved payload, and the approved create-and-push runs", async () => {
    const h = await harness({ initialized: false });
    try {
      const result = succeeded(await h.invoke(PUSH, { targetBranch: SESSION_BRANCH, credentialId: CREDENTIAL_ID }));
      expect(data(result)).toMatchObject({ pushed: true, branch: SESSION_BRANCH });
      // The human approved "create the repository and push", and that fact is in the payload the boundary
      // rebuilt — otherwise the two hashes would differ and the record could not be redeemed.
      const git = (h.approvals.requested[0]!.inputPayload as { git: Record<string, unknown> }).git;
      expect(git).toMatchObject({ repositoryInitialized: false, targetBranch: SESSION_BRANCH });
      expect(h.approvals.consumes[0]!.payloadHash).toBe(h.approvals.requested[0]!.payloadHash);
      expect(h.approvals.refusals).toEqual([]);
      /**
       * The ordering is the invariant: the record was consumed **before** the repository was created, so the
       * push pre-flight no longer performs the initialization the approval is bound to (it asks the read-only
       * inspector instead of `status()`, which reaches `ensureRepository`).
       */
      const consumed = h.approvals.order.indexOf("approval:consume");
      const initialized = h.approvals.order.indexOf("git:init -b main");
      expect(consumed).toBeGreaterThanOrEqual(0);
      expect(initialized).toBeGreaterThan(consumed);
      expect(existsSync(path.join(h.dir, ".git"))).toBe(true);
      expect(h.pushes).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });
});
