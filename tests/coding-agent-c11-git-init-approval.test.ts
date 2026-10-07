import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthContext, Project, WorkspaceStore } from "@npati/workspace";
import { ProjectGitService } from "../apps/agent-api/src/project-git-service";
import {
  bindsRepositoryInitialization,
  gitApprovalPayload,
  gitWriteIntentFromToolInput,
} from "../apps/agent-api/src/code-git-write-policy";
import { gitToolApprovalPayload } from "../apps/agent-api/src/code-git-workflow";
import { fnv1a, payloadHashFor } from "../apps/agent-api/src/code-policy-engine";
import { CodeProtectedBranchRepository, CodeProtectedBranchService } from "../apps/agent-api/src/code-protected-branches";

/**
 * C11 (owner decision 13, the last known issue): **no git mutation before authorization + approval**.
 *
 * The defect this suite pins shut: `ProjectGitService.resolveWriteIntent` resolved an unnamed branch through
 * `currentBranch`, and `currentBranch` went through `ensureRepository`, which runs `git init` — and writes
 * `.gitignore`, and commits — for a repository that does not exist yet. A request that was about to be
 * **refused** (by the policy, by the missing approval record, by RBAC) therefore left a `.git` directory
 * behind: the refusal was correct and the disk was changed anyway.
 *
 * The three claims this file makes *factually* — by recording processes and hashing files, not by reading the
 * source it tests:
 *
 *  1. `inspectRepository()` is read-only. It may `lstat` and run the two read-only `rev-parse` probes named
 *     below, and nothing else: an invocation log proves no mutating subcommand ran, and a recursive
 *     path+sha256 snapshot proves no file changed.
 *  2. `ensureRepositoryInitialized()` is the only mutating half, and no refusal path reaches it. Five
 *     different refusals are driven on an uninitialized workspace and each one must leave no `.git`, not one
 *     changed byte and no mutating git subcommand.
 *  3. "This write creates the repository" is part of the approval payload — and therefore of the payload hash
 *     — so an approval for "push into an existing repository" cannot be redeemed for "create the repository
 *     and push", or the other way round, while every already-initialized write keeps the exact payload and
 *     hash it had before.
 *
 * The ordering around the initialization is pinned at the end: the canonical revision is read before the
 * approval, `git init` runs only after the approval was consumed, and the revision is re-checked *after* the
 * initialization — so an initialization that moved the workspace refuses the push instead of publishing bytes
 * nobody reconciled.
 */

const COMPANY = "company-1";
const PROJECT = "project-1";
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "ghp_C11INITAPPROVALSECRET0123456789";
const REPOSITORY_URL = "https://github.com/example/site.git";
const PUSH_TOOL = "project.git.push";

/**
 * Every git subcommand that changes anything. A path that is supposed to leave the disk alone fails if any of
 * these is invoked; `rev-parse`, `diff --cached --name-only` and `status` are the read-only probes the service
 * is allowed to make.
 */
const MUTATING_GIT_SUBCOMMANDS = new Set([
  "init", "config", "add", "commit", "checkout", "switch", "reset", "clean", "push", "fetch", "pull",
  "clone", "remote", "merge", "rebase", "worktree", "update-ref", "rm", "mv", "tag", "branch", "stash",
]);

function isMutating(args: string[]): boolean {
  return MUTATING_GIT_SUBCOMMANDS.has(args[0] ?? "");
}

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

/** Path + sha256 of every file under `root`, recursively, plus whether `root` exists at all. */
async function fileSnapshot(root: string): Promise<string> {
  const lines: string[] = [`exists=${existsSync(root) ? "yes" : "no"}`];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of [...items].sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(path.join(dir, item.name), relative);
      else if (item.isFile()) {
        const bytes = await readFile(path.join(dir, item.name));
        lines.push(`${relative} ${createHash("sha256").update(bytes).digest("hex")}`);
      } else lines.push(`${relative} <not-a-file>`);
    }
  };
  if (existsSync(root)) await walk(root, "");
  return lines.join("\n");
}

interface HarnessOptions {
  /** `true` (the default) puts a `.git` directory in place; `false` leaves the workspace uninitialized. */
  initialized?: boolean;
  /** The branch the fake checkout reports for `rev-parse --abbrev-ref HEAD`. */
  branch?: string;
  /** The toplevel the fake repository reports; a different path emulates a foreign repository. */
  toplevel?: (dir: string) => string;
  /** A `.git` that is a file (a linked-worktree pointer) instead of a directory. */
  gitPointerFile?: boolean;
  /** The project directory is not created at all (a workspace that does not exist yet). */
  withoutProjectDirectory?: boolean;
  /** The protected-branch port: `"unwired"` omits it, so the write must fail closed. */
  policy?: "allow" | "deny" | "unwired";
  /** Called for every mutating git invocation, before it is emulated. */
  onMutating?: (args: string[]) => void;
  /** Called when the approval record is consumed — the window between the two revision reads. */
  onApprovalConsumed?: () => void;
  /** The canonical revision port; `undefined` means no revision is claimed. */
  revisions?: {
    capture(): Promise<{ revision: string; branch: string | null; capturedAt: number }>;
    assertUnchanged(snapshot: { revision: string; branch: string | null; capturedAt: number }, phase: string): Promise<unknown>;
  };
}

interface Harness {
  service: ProjectGitService;
  root: string;
  dir: string;
  /** Every git invocation, in order. */
  calls: string[][];
  /** A cross-cutting event log: `git:…`, `policy`, `approval:consume`, `revision:check:…`, `credential:acquire`. */
  order: string[];
  approvedPayloads: Array<Record<string, unknown>>;
  revoked: string[];
  cleanup: () => Promise<void>;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "npati-c11-init-"));
  const dir = path.join(root, COMPANY, PROJECT);
  if (!options.withoutProjectDirectory) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), "<h1>site</h1>\n", "utf8");
    await writeFile(path.join(dir, "app.ts"), "export const answer = 42;\n", "utf8");
    if (options.initialized !== false) {
      if (options.gitPointerFile) await writeFile(path.join(dir, ".git"), "gitdir: ../elsewhere/.git\n", "utf8");
      else await mkdir(path.join(dir, ".git"), { recursive: true });
    }
  }

  const calls: string[][] = [];
  const order: string[] = [];
  const approvedPayloads: Array<Record<string, unknown>> = [];
  const revoked: string[] = [];

  /**
   * The git process. It records the argv, emulates only what the service observes (`init` really creates
   * `.git`, the two `rev-parse` probes answer), and refuses to emulate `config` before `init` — so a
   * mis-ordered mutation fails loudly instead of passing quietly.
   */
  const runGit = async (calledDir: string, args: string[]) => {
    calls.push([...args]);
    order.push(`git:${args.join(" ")}`);
    if (isMutating(args)) {
      if (args[0] === "config" && !existsSync(path.join(calledDir, ".git"))) throw new Error("git config before git init");
      options.onMutating?.([...args]);
      if (args[0] === "init") await mkdir(path.join(calledDir, ".git"), { recursive: true });
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: `${options.toplevel ? options.toplevel(calledDir) : calledDir}\n`, stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: `${options.branch ?? "feature/topic"}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };

  const store = {
    createProjectCheckpoint: async () => ({ id: "cp-1" }),
    listProjectCheckpoints: async () => [],
  } as unknown as WorkspaceStore;

  const policy = options.policy ?? "allow";
  const boundary: NonNullable<ConstructorParameters<typeof ProjectGitService>[6]> = {
    ...(policy === "unwired"
      ? {}
      : {
          assertGitWriteAllowed: async () => {
            order.push("policy");
            if (policy === "deny") {
              throw Object.assign(new Error("The branch is protected"), {
                code: "protected_branch_write_denied", httpStatus: 403, details: { branch: "main" },
              });
            }
            return { allowed: true };
          },
        }),
    approvals: {
      consumeApproved: async (_ctx, _companyId, id, params) => {
        order.push("approval:consume");
        approvedPayloads.push({
          id,
          runId: params.runId,
          agentId: params.agentId,
          toolName: params.toolName,
          payload: params.inputPayload,
          ...params.inputPayload,
        });
        options.onApprovalConsumed?.();
        return { id };
      },
    },
    credentials: {
      acquire: async (input) => {
        order.push("credential:acquire");
        if (!input.toolCallId) throw new Error("tool call id is required");
        return { leaseId: `lease-${input.toolCallId}`, value: TOKEN };
      },
      revoke: async (leaseId) => { revoked.push(leaseId); },
    },
    ...(options.revisions
      ? {
          workspaceRevisions: {
            capture: async () => options.revisions!.capture(),
            assertUnchanged: async (_scope, snapshot, phase) => {
              order.push(`revision:check:${phase}`);
              return options.revisions!.assertUnchanged(snapshot, phase);
            },
          },
        }
      : {}),
  };

  const service = new ProjectGitService(store, { get: async () => project() }, root, undefined, undefined, runGit, boundary);
  return { service, root, dir, calls, order, approvedPayloads, revoked, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
}

/** The approval record a caller presents; `approved: true` is not proof on its own. */
const approvalRecord = { approvalId: "approval-1", runId: "run-1", agentId: "agent-1", toolName: PUSH_TOOL };

type Refusal = { code?: string; status?: number; httpStatus?: number; details?: Record<string, unknown>; message?: string };

function refusal(promise: Promise<unknown>): Promise<Refusal> {
  return promise.then(() => ({}), (error: Refusal) => error);
}

// ---------------------------------------------------------------------------------------------
// 1. inspectRepository() is read-only
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 git init — inspectRepository() reports, and never repairs", () => {
  it("reports an uninitialized workspace without invoking git at all", async () => {
    const h = await harness({ initialized: false });
    try {
      const before = await fileSnapshot(h.root);
      const state = await h.service.inspectRepository(owner(), COMPANY, PROJECT);
      expect(state.initialized).toBe(false);
      expect(state.branch).toBeNull();
      expect(state.dir).toBe(h.dir);
      // Not one git process: there is nothing to ask a repository that does not exist, and nothing to create.
      expect(h.calls).toHaveLength(0);
      expect(existsSync(path.join(h.dir, ".git"))).toBe(false);
      expect(await fileSnapshot(h.root)).toBe(before);
    } finally {
      await h.cleanup();
    }
  });

  it("reports a workspace that does not exist yet without creating it", async () => {
    const h = await harness({ withoutProjectDirectory: true });
    try {
      const state = await h.service.inspectRepository(owner(), COMPANY, PROJECT);
      expect(state.initialized).toBe(false);
      expect(h.calls).toHaveLength(0);
      // A read-only caller must not materialise the project directory, let alone `.git`.
      expect(existsSync(h.dir)).toBe(false);
      expect(existsSync(path.join(h.dir, ".git"))).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("reports an initialized workspace using only the two read-only rev-parse probes", async () => {
    const h = await harness({ branch: "feature/topic" });
    try {
      const state = await h.service.inspectRepository(owner(), COMPANY, PROJECT);
      expect(state.initialized).toBe(true);
      expect(state.branch).toBe("feature/topic");
      // Exactly the workspace-membership proof and the checkout probe — nothing else, and nothing mutating.
      expect(h.calls).toEqual([
        ["rev-parse", "--show-toplevel"],
        ["rev-parse", "--abbrev-ref", "HEAD"],
      ]);
      expect(h.calls.filter((args) => isMutating(args))).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it("reports a detached HEAD as no branch instead of guessing one", async () => {
    const h = await harness({ branch: "HEAD" });
    try {
      const state = await h.service.inspectRepository(owner(), COMPANY, PROJECT);
      expect(state.initialized).toBe(true);
      expect(state.branch).toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  it("refuses a `.git` that does not belong to the project workspace", async () => {
    const h = await harness({ toplevel: () => path.join(tmpdir(), "somewhere-else") });
    try {
      const error = await refusal(h.service.inspectRepository(owner(), COMPANY, PROJECT));
      expect(error).toMatchObject({ code: "INVALID_WORKSPACE", status: 403 });
      expect(h.calls.filter((args) => isMutating(args))).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it("refuses a `.git` that is a pointer file, before any git process starts", async () => {
    const h = await harness({ gitPointerFile: true });
    try {
      const before = await fileSnapshot(h.root);
      const error = await refusal(h.service.inspectRepository(owner(), COMPANY, PROJECT));
      // The pre-C11 code would have run `git init` over it; that writes into somebody else's checkout.
      expect(error).toMatchObject({ code: "INVALID_WORKSPACE", status: 403 });
      expect(h.calls).toHaveLength(0);
      expect(await fileSnapshot(h.root)).toBe(before);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. ensureRepositoryInitialized() is the mutating half
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 git init — ensureRepositoryInitialized() is the only mutation", () => {
  it("creates the repository, the identity, the ignore file and the initial commit", async () => {
    const h = await harness({ initialized: false });
    try {
      const dir = await h.service.ensureRepositoryInitialized(owner(), COMPANY, PROJECT);
      expect(dir).toBe(h.dir);
      expect(h.calls).toEqual([
        ["init", "-b", "main"],
        ["config", "user.name", "NPATI AI Agent"],
        ["config", "user.email", "agent@npati.ai"],
        ["config", "commit.gpgsign", "false"],
        ["add", "-A"],
        ["diff", "--no-ext-diff", "--cached", "--name-only", "-z"],
        ["commit", "-m", "Initial project workspace"],
        ["rev-parse", "--show-toplevel"],
      ]);
      expect(existsSync(path.join(h.dir, ".git"))).toBe(true);
      const ignore = await readFile(path.join(h.dir, ".gitignore"), "utf8");
      expect(ignore).toContain(".worktrees");
      expect(ignore).toContain("node_modules");
    } finally {
      await h.cleanup();
    }
  });

  it("is a no-op on a repository that already exists", async () => {
    const h = await harness({ initialized: true });
    try {
      await h.service.ensureRepositoryInitialized(owner(), COMPANY, PROJECT);
      expect(h.calls).toEqual([["rev-parse", "--show-toplevel"]]);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The regression: no refusal leaves a `.git` behind
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 no git mutation before authorization + approval", () => {
  interface Case {
    name: string;
    options: HarnessOptions;
    push: Parameters<ProjectGitService["push"]>[3];
    match: Refusal;
    /** Refusals that mean "this write would have to create the repository". */
    requiresInitialization?: boolean;
  }

  const cases: Case[] = [
    {
      name: "the `approved` flag alone is not an approval",
      options: { initialized: false },
      push: { branch: "feature/topic", credentialId: CREDENTIAL_ID },
      match: { code: "GIT_APPROVAL_REQUIRED", status: 403 },
    },
    {
      name: "an unnamed branch on an uninitialized workspace is refused as such",
      options: { initialized: false },
      push: { credentialId: CREDENTIAL_ID, approved: true },
      match: { code: "repository_not_initialized", status: 409 },
      requiresInitialization: true,
    },
    {
      name: "a named branch without an approval record does not initialize anything",
      options: { initialized: false },
      push: { branch: "feature/topic", credentialId: CREDENTIAL_ID, approved: true },
      match: { code: "repository_not_initialized", status: 409 },
      requiresInitialization: true,
    },
    {
      name: "an approval record does not bypass the protected-branch policy",
      options: { initialized: false, policy: "deny" },
      push: { branch: "feature/topic", credentialId: CREDENTIAL_ID, approved: true, approval: approvalRecord },
      match: { code: "protected_branch_write_denied", httpStatus: 403 },
    },
    {
      name: "an approval record cannot substitute for a missing policy port",
      options: { initialized: false, policy: "unwired" },
      push: { branch: "feature/topic", credentialId: CREDENTIAL_ID, approved: true, approval: approvalRecord },
      match: { code: "GIT_POLICY_UNAVAILABLE", status: 503 },
    },
  ];

  for (const entry of cases) {
    it(`${entry.name} — and creates no .git and changes no file`, async () => {
      const h = await harness(entry.options);
      try {
        const before = await fileSnapshot(h.root);
        const error = await refusal(h.service.push(owner(), COMPANY, PROJECT, entry.push));
        expect(error).toMatchObject(entry.match);
        if (entry.requiresInitialization) {
          expect(error).toMatchObject({
            details: {
              requiresInitialization: true,
              repositoryInitialized: false,
              repositoryState: "uninitialized",
              projectId: PROJECT,
            },
          });
        }
        // The proof, by fact rather than by reading the implementation: no `.git`, not one changed byte, and
        // no mutating git subcommand anywhere in the recorded process list.
        expect(existsSync(path.join(h.dir, ".git"))).toBe(false);
        expect(await fileSnapshot(h.root)).toBe(before);
        expect(h.calls.filter((args) => isMutating(args))).toHaveLength(0);
        // Nothing was spent either: no approval consumed, no credential leased.
        expect(h.approvedPayloads).toHaveLength(0);
        expect(h.revoked).toHaveLength(0);
      } finally {
        await h.cleanup();
      }
    });
  }

  it("the repository is created only after the approval was consumed, and the push follows it", async () => {
    const h = await harness({ initialized: false, policy: "allow" });
    try {
      const result = await h.service.push(owner(), COMPANY, PROJECT, {
        branch: "feature/topic", credentialId: CREDENTIAL_ID, approved: true, approval: approvalRecord,
      });
      expect(result).toMatchObject({ pushed: true, branch: "feature/topic", remote: REPOSITORY_URL });
      expect(existsSync(path.join(h.dir, ".git"))).toBe(true);
      // The facts that make the ordering real: the approval was consumed before `git init`, and `init` is the
      // first mutating invocation of the whole call.
      const firstMutation = h.calls.findIndex((args) => isMutating(args));
      expect(h.calls[firstMutation]).toEqual(["init", "-b", "main"]);
      expect(h.order.indexOf("approval:consume")).toBeGreaterThanOrEqual(0);
      expect(h.order.indexOf("approval:consume")).toBeLessThan(h.order.indexOf("git:init -b main"));
      // The payload the boundary consumed says what the write really is: create the repository, then push.
      expect(h.approvedPayloads).toHaveLength(1);
      expect(h.approvedPayloads[0]).toMatchObject({
        id: "approval-1", runId: "run-1", agentId: "agent-1", toolName: PUSH_TOOL,
        projectId: PROJECT, tool: PUSH_TOOL,
        git: {
          gitOperation: "push", sourceBranch: "feature/topic", targetBranch: "feature/topic",
          remote: null, force: false, credentialId: CREDENTIAL_ID, repositoryInitialized: false,
        },
      });
      // The credential was leased only after the initialization, and only for the push.
      expect(h.order.indexOf("git:init -b main")).toBeLessThan(h.order.indexOf("credential:acquire"));
      expect(h.calls.some((args) => args[0] === "push")).toBe(true);
      expect(h.revoked).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  it("pushing an existing repository is unchanged: no init, no initialization fact", async () => {
    const h = await harness({ initialized: true, branch: "feature/topic" });
    try {
      const result = await h.service.push(owner(), COMPANY, PROJECT, {
        branch: "feature/topic", credentialId: CREDENTIAL_ID, approved: true, approval: approvalRecord,
      });
      expect(result).toMatchObject({ pushed: true, branch: "feature/topic" });
      expect(h.calls.filter((args) => args[0] === "init")).toHaveLength(0);
      const payload = h.approvedPayloads[0] as { git: Record<string, unknown> };
      expect(payload).toMatchObject({ git: { targetBranch: "feature/topic" } });
      // The field is absent, not `true`: this payload is byte-identical to the one C11 produced before the
      // initialization fact existed, which is why every already-issued approval keeps working.
      expect(Object.prototype.hasOwnProperty.call(payload.git, "repositoryInitialized")).toBe(false);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The initialization fact is bound into the approval payload hash
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 the initialization fact is part of the approval binding", () => {
  it("binds `repositoryInitialized: false` only for a write that creates the repository", () => {
    const intent = gitWriteIntentFromToolInput("code.git.push", { targetBranch: "feature/topic", credentialId: CREDENTIAL_ID })!;
    const existing = gitApprovalPayload({ projectId: PROJECT, tool: PUSH_TOOL, intent: { ...intent, repositoryInitialized: true } });
    const creating = gitApprovalPayload({ projectId: PROJECT, tool: PUSH_TOOL, intent: { ...intent, repositoryInitialized: false } });
    expect(bindsRepositoryInitialization({ repositoryInitialized: false })).toBe(true);
    expect(bindsRepositoryInitialization({ repositoryInitialized: true })).toBe(false);
    expect(bindsRepositoryInitialization({})).toBe(false);
    expect(JSON.stringify(existing)).not.toBe(JSON.stringify(creating));
    // An ordinary write still carries exactly the fields it carried before decision 13.
    expect(existing).toEqual(gitApprovalPayload({ projectId: PROJECT, tool: PUSH_TOOL, intent }));
    expect((existing as { git: Record<string, unknown> }).git).toEqual({
      gitOperation: "push", sourceBranch: "feature/topic", targetBranch: "feature/topic", remoteBranch: "feature/topic",
      remote: null, force: false, credentialId: CREDENTIAL_ID,
    });
    expect((creating as { git: Record<string, unknown> }).git).toMatchObject({ repositoryInitialized: false });
  });

  it("keeps the payload hash of an initialized repository byte-identical, and moves it for an initialization", () => {
    const base = { ctx: owner(), companyId: COMPANY, tool: "code.git.push", sessionId: "session-1" };
    const intent = gitWriteIntentFromToolInput("code.git.push", { targetBranch: "feature/topic", credentialId: CREDENTIAL_ID })!;
    const existing = payloadHashFor({ ...base, git: { ...intent, repositoryInitialized: true } });
    const creating = payloadHashFor({ ...base, git: { ...intent, repositoryInitialized: false } });
    /**
     * The hash of an ordinary write is the hash of the material exactly as it was before decision 13: the
     * pre-change JSON is rebuilt here and hashed with the engine's own digest, so "the hashes did not move" is
     * a computation rather than a promise.
     */
    const preDecisionThirteenMaterial = JSON.stringify({
      tool: "code.git.push",
      command: null,
      paths: [],
      projectId: null,
      sessionId: "session-1",
      git: {
        gitOperation: "push",
        sourceBranch: "feature/topic",
        targetBranch: "feature/topic",
        remoteBranch: "feature/topic",
        remote: null,
        force: false,
        credentialId: CREDENTIAL_ID,
      },
    });
    expect(existing).toBe(fnv1a(preDecisionThirteenMaterial));
    expect(payloadHashFor({ ...base, git: intent })).toBe(existing);
    // ... and the two acts are not interchangeable in either direction.
    expect(creating).not.toBe(existing);
    // A request that is not a git write keeps its hash (the key is added only when an intent is present).
    expect(payloadHashFor({ ...base, git: undefined, command: "git status" })).toBe(payloadHashFor({ ...base, git: undefined, command: "git status" }));
  });

  it("carries the fact on the code-tool path as well, where the runtime builds the request payload", () => {
    const args = { targetBranch: "feature/topic", credentialId: CREDENTIAL_ID };
    const creating = gitToolApprovalPayload({ projectId: PROJECT, tool: "code.git.push", args, repositoryInitialized: false });
    const existing = gitToolApprovalPayload({ projectId: PROJECT, tool: "code.git.push", args, repositoryInitialized: true });
    expect((creating as { git: Record<string, unknown> }).git).toMatchObject({ repositoryInitialized: false });
    expect(Object.prototype.hasOwnProperty.call((existing as { git: Record<string, unknown> }).git, "repositoryInitialized")).toBe(false);
    expect(creating).not.toEqual(existing);
    // A git-write tool that names no branch still cannot be approved at all: there is nothing to bind.
    expect(() => gitToolApprovalPayload({ projectId: PROJECT, tool: "code.git.push", args: { credentialId: CREDENTIAL_ID } })).toThrow();
  });

  it("computes the same payload on the request side and at the boundary for the same write", async () => {
    const creating = await harness({ initialized: false });
    const existing = await harness({ initialized: true, branch: "feature/topic" });
    try {
      await creating.service.push(owner(), COMPANY, PROJECT, {
        branch: "feature/topic", credentialId: CREDENTIAL_ID, approved: true, approval: approvalRecord,
      });
      await existing.service.push(owner(), COMPANY, PROJECT, {
        branch: "feature/topic", credentialId: CREDENTIAL_ID, approved: true, approval: approvalRecord,
      });
      const args = { targetBranch: "feature/topic", credentialId: CREDENTIAL_ID };
      /**
       * The request side, exactly as `company-runtime.ts` builds it for a `project.git.push`: the typed intent
       * from the tool arguments plus the initialization fact the read-only inspector returned. The code-tool
       * path (`code.git.push`) reaches the same payload through `gitToolApprovalPayload`; both call
       * `gitApprovalPayload`, which is why the two sides of the hash cannot drift.
       */
      const requestSide = (repositoryInitialized: boolean) => gitApprovalPayload({
        projectId: PROJECT,
        tool: PUSH_TOOL,
        intent: { ...gitWriteIntentFromToolInput(PUSH_TOOL, args)!, repositoryInitialized },
      });
      expect(creating.approvedPayloads[0]!.payload).toEqual(requestSide(false));
      expect(existing.approvedPayloads[0]!.payload).toEqual(requestSide(true));
      expect(JSON.stringify(creating.approvedPayloads[0])).not.toBe(JSON.stringify(existing.approvedPayloads[0]));
      // A record issued for the other state cannot be redeemed: the boundary rebuilds the payload from the
      // repository it just inspected, so the hash the human approved is not the hash of this write.
      expect(requestSide(false)).not.toEqual(requestSide(true));
    } finally {
      await creating.cleanup();
      await existing.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 5. The revision is checked after the initialization
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 the canonical revision is re-checked after the initialization", () => {
  function revisionPort(initial: string) {
    const state = { revision: initial, captures: 0, checks: [] as Array<{ phase: string; expected: string; current: string }> };
    return {
      state,
      port: {
        capture: async () => {
          state.captures += 1;
          return { revision: state.revision, branch: "feature/topic", capturedAt: 0 };
        },
        assertUnchanged: async (snapshot: { revision: string }, phase: string) => {
          state.checks.push({ phase, expected: snapshot.revision, current: state.revision });
          if (snapshot.revision !== state.revision) {
            throw Object.assign(new Error("The canonical workspace moved before git_push"), {
              code: "workspace_revision_mismatch", httpStatus: 409,
              details: { phase, expectedRevision: snapshot.revision, currentRevision: state.revision },
            });
          }
          return { revision: state.revision, branch: null, capturedAt: 0 };
        },
      },
    };
  }

  it("captures before the approval and asserts after it, for an existing repository", async () => {
    const revisions = revisionPort("rev-1");
    const h = await harness({ initialized: true, branch: "feature/topic", revisions: revisions.port });
    try {
      const result = await h.service.push(owner(), COMPANY, PROJECT, {
        branch: "feature/topic", credentialId: CREDENTIAL_ID, approved: true, approval: approvalRecord,
      });
      expect(result).toMatchObject({ pushed: true });
      expect(revisions.state.captures).toBe(1);
      expect(revisions.state.checks).toEqual([{ phase: "git_push", expected: "rev-1", current: "rev-1" }]);
      // The check stands between the approval and the side effect: approval, revision, lease, push.
      expect(h.order.indexOf("approval:consume")).toBeLessThan(h.order.indexOf("revision:check:git_push"));
      expect(h.order.indexOf("revision:check:git_push")).toBeLessThan(h.order.indexOf("credential:acquire"));
    } finally {
      await h.cleanup();
    }
  });

  it("refuses the push when the approved initialization moved the canonical workspace", async () => {
    const revisions = revisionPort("rev-before-init");
    const h = await harness({
      initialized: false,
      // The initialization is exactly the change the revision guard watches for: `git init` plus the
      // `.gitignore` write move the canonical digest.
      onMutating: (args) => { if (args[0] === "init") revisions.state.revision = "rev-after-init"; },
      revisions: revisions.port,
    });
    try {
      const error = await refusal(h.service.push(owner(), COMPANY, PROJECT, {
        branch: "feature/topic", credentialId: CREDENTIAL_ID, approved: true, approval: approvalRecord,
      }));
      expect(error).toMatchObject({
        code: "workspace_revision_mismatch",
        httpStatus: 409,
        details: { phase: "git_push", expectedRevision: "rev-before-init", currentRevision: "rev-after-init" },
      });
      // The approved initialization is the side effect that ran; the push is not, and no credential was
      // leased for it. The caller re-prepares against the revision that now exists.
      expect(existsSync(path.join(h.dir, ".git"))).toBe(true);
      expect(h.calls.some((args) => args[0] === "push")).toBe(false);
      expect(h.order).not.toContain("credential:acquire");
      expect(h.revoked).toHaveLength(0);
      expect(h.order.indexOf("git:init -b main")).toBeLessThan(h.order.indexOf("revision:check:git_push"));
    } finally {
      await h.cleanup();
    }
  });

  it("refuses the push when the canonical workspace moved while the approval was consumed", async () => {
    const revisions = revisionPort("rev-1");
    const h = await harness({
      initialized: true,
      branch: "feature/topic",
      revisions: revisions.port,
      // The window the check now covers: the human's approval is consumed, and the workspace moves before the
      // write. Before decision 13 nothing compared the two.
      onApprovalConsumed: () => { revisions.state.revision = "rev-2"; },
    });
    try {
      const error = await refusal(h.service.push(owner(), COMPANY, PROJECT, {
        branch: "feature/topic", credentialId: CREDENTIAL_ID, approved: true, approval: approvalRecord,
      }));
      expect(error).toMatchObject({
        code: "workspace_revision_mismatch",
        details: { phase: "git_push", expectedRevision: "rev-1", currentRevision: "rev-2" },
      });
      expect(h.calls.some((args) => args[0] === "push")).toBe(false);
      expect(h.order).not.toContain("credential:acquire");
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 6. The real protected-branch service drives the same refusal path
// ---------------------------------------------------------------------------------------------

describe("security-gate: C11 a fresh workspace is refused before the policy and the approval", () => {
  it("denies a request with no approval record before the policy is even consulted, creating nothing", async () => {
    const policy = new CodeProtectedBranchService({
      store: new CodeProtectedBranchRepository(),
      resolveRole: async () => "owner",
      audit: { record: async () => undefined },
    });
    await policy.updatePolicy(owner(), COMPANY, { branches: ["main"], expectedRevision: 0 });

    const root = await mkdtemp(path.join(tmpdir(), "npati-c11-init-policy-"));
    const dir = path.join(root, COMPANY, PROJECT);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), "<h1>site</h1>\n", "utf8");
    const calls: string[][] = [];
    const policyIntents: string[] = [];
    let approvals = 0;
    const service = new ProjectGitService(
      { createProjectCheckpoint: async () => ({ id: "cp-1" }) } as unknown as WorkspaceStore,
      { get: async () => project() },
      root,
      undefined,
      undefined,
      async (calledDir, args) => {
        calls.push([...args]);
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: `${calledDir}\n`, stderr: "" };
        return { stdout: "", stderr: "" };
      },
      {
        assertGitWriteAllowed: (ctx, companyId, input) => {
          policyIntents.push(input.targetBranch);
          return policy.assertGitWriteAllowed(ctx, companyId, input);
        },
        approvals: { consumeApproved: async () => { approvals += 1; return { id: "approval-1" }; } },
        credentials: { acquire: async () => ({ leaseId: "lease-1", value: TOKEN }), revoke: async () => undefined },
      },
    );
    try {
      const before = await fileSnapshot(root);
      // No approval record at all: the workspace has no repository, which is what a caller is told.
      const noRecord = await refusal(service.push(owner(), COMPANY, PROJECT, {
        branch: "main", credentialId: CREDENTIAL_ID, approved: true,
      }));
      expect(noRecord).toMatchObject({
        code: "repository_not_initialized",
        status: 409,
        details: { requiresInitialization: true, repositoryInitialized: false },
      });
      // The real protected-branch policy was never consulted: the refusal is earlier than the policy phase.
      expect(policyIntents).toHaveLength(0);
      expect(approvals).toBe(0);

      // With a record the gate is passed and the real hard deny is what stops the write — still no `.git`,
      // still no consumed approval, and still no mutating git process.
      const protectedBranch = await refusal(service.push(owner(), COMPANY, PROJECT, {
        branch: "main", credentialId: CREDENTIAL_ID, approved: true, approval: approvalRecord,
      }));
      expect(protectedBranch).toMatchObject({ code: "protected_branch_write_denied", httpStatus: 403 });
      expect(policyIntents).toEqual(["main"]);
      expect(approvals).toBe(0);

      expect(calls.filter((args) => isMutating(args))).toHaveLength(0);
      expect(await fileSnapshot(root)).toBe(before);
      expect(existsSync(path.join(dir, ".git"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
