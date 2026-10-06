import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthContext, Project, ProjectCheckpoint, WorkspaceStore } from "@npati/workspace";
import { ProjectGitService } from "../apps/agent-api/src/project-git-service";

/**
 * C7 security-gate: path-scoped revert (`git checkout <commit> -- <paths>`).
 *
 * The whole point of this method is what it does **not** do. `restoreCheckpoint` reverts everything with
 * `git reset --hard` + `git clean -fd`; reusing it for "revert this one file" would silently discard every other
 * change in the workspace. So the suite pins:
 *  - no `reset` and no `clean` is ever issued by a path restore, whatever the caller asks for;
 *  - every path is validated (traversal, absolute, `~`, protected/secret paths) **before** a git process starts,
 *    so a hostile path cannot even reach the argument list;
 *  - a symlink anywhere along a path aborts the call instead of letting git write through the link;
 *  - a mandatory pre-restore safety checkpoint is taken, which is what makes the revert itself reversible;
 *  - per-file outcomes are honest: one failing path does not mark the others as failed, and does not get reported
 *    as restored either.
 */

const COMPANY = "company-1";
const PROJECT = "project-1";
const COMMIT = "abc1234def5678";

function context(permissions: string[] = ["workspace:write"]): AuthContext {
  return { workspaceId: "ws-1", userId: "user-1", companyId: COMPANY, permissions, role: "developer" } as unknown as AuthContext;
}

interface Harness {
  service: ProjectGitService;
  calls: string[][];
  checkpoints: Array<{ name: string; trigger?: string }>;
  dir: string;
  cleanup: () => Promise<void>;
}

async function harness(options: { failOn?: (args: string[]) => boolean; checkpointCommit?: string; clean?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "npati-c7-revert-"));
  const dir = path.join(root, COMPANY, PROJECT);
  await mkdir(path.join(dir, ".git"), { recursive: true });
  await mkdir(path.join(dir, "src"), { recursive: true });

  const calls: string[][] = [];
  const checkpoints: Array<{ name: string; trigger?: string }> = [];

  const runGit = async (calledDir: string, args: string[]) => {
    calls.push(args);
    if (options.failOn?.(args)) throw new Error("git failed");
    const head = args[0];
    if (head === "rev-parse" && args[1] === "--show-toplevel") return { stdout: calledDir, stderr: "" };
    if (head === "rev-parse") return { stdout: COMMIT, stderr: "" };
    if (head === "status") return { stdout: options.clean === false ? "## main\n M src/a.ts\n" : "## main\n", stderr: "" };
    if (head === "diff") return { stdout: "", stderr: "" };
    return { stdout: "", stderr: "" };
  };

  const store = {
    createProjectCheckpoint: async (_ctx: AuthContext, _companyId: string, _projectId: string, input: { name: string; commitHash: string; trigger?: string }) => {
      checkpoints.push({ name: input.name, trigger: input.trigger });
      return { id: `cp-${checkpoints.length}`, name: input.name, commitHash: input.commitHash, trigger: input.trigger ?? "manual" } as unknown as ProjectCheckpoint;
    },
    getProjectCheckpoint: async () => ({ id: "cp-target", name: "target", commitHash: options.checkpointCommit ?? "def5678aaaa", trigger: "pre_run" }) as unknown as ProjectCheckpoint,
  } as unknown as WorkspaceStore;

  const project = { id: PROJECT, companyId: COMPANY, workspaceId: "ws-1", status: "ready" } as unknown as Project;
  const service = new ProjectGitService(store, { get: async () => project }, root, undefined, undefined, runGit);

  return { service, calls, checkpoints, dir, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
}

function gitArgs(calls: string[][]): string[] {
  return calls.map((args) => args.join(" "));
}

/** Harness-proof rejection probe: the shim does not implement regex matchers for `toThrow`. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    const typed = error as { message?: string; code?: string };
    return `${typed.code ?? ""} ${typed.message ?? ""}`.trim();
  }
}

describe("[C7] [security-gate] path-scoped revert never resets the workspace", () => {
  it("restores only the named paths and issues no reset or clean", async () => {
    const harnessed = await harness();
    try {
      const outcome = await harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/a.ts", "src/b.ts"] });

      expect(outcome.restored.join(",")).toBe("src/a.ts,src/b.ts");
      expect(outcome.failed.length).toBe(0);
      expect(outcome.safetyCheckpointId).toBe("cp-1");

      const checkoutCalls = harnessed.calls.filter((args) => args[0] === "checkout");
      expect(checkoutCalls.length).toBe(2);
      expect(checkoutCalls[0]!.join(" ")).toBe(`checkout ${COMMIT} -- src/a.ts`);
      expect(checkoutCalls[1]!.join(" ")).toBe(`checkout ${COMMIT} -- src/b.ts`);

      const destructive = harnessed.calls.filter((args) => args[0] === "reset" || args[0] === "clean");
      expect(destructive.length).toBe(0);
      expect(gitArgs(harnessed.calls).some((line) => line.includes("reset") || line.includes("clean"))).toBe(false);
    } finally {
      await harnessed.cleanup();
    }
  });

  it("takes a pre-restore safety checkpoint before touching anything", async () => {
    const harnessed = await harness();
    try {
      await harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/a.ts"] });
      expect(harnessed.checkpoints.length).toBe(1);
      expect(harnessed.checkpoints[0]!.trigger).toBe("pre_restore");
    } finally {
      await harnessed.cleanup();
    }
  });

  it("rejects traversal, absolute, home-relative, secret and malformed paths before any git process", async () => {
    const harnessed = await harness();
    try {
      const hostile = ["../etc/passwd", "src/../../etc/passwd", "/etc/passwd", "C:/windows/system32", "~/.ssh/id_rsa", ".env", "src/a.ts ", "..\\windows"];
      for (const file of hostile) {
        const refused = await rejection(harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: [file] }));
        expect(refused.length > 0).toBe(true);
      }
      expect(harnessed.calls.length).toBe(0);
    } finally {
      await harnessed.cleanup();
    }
  });

  it("rejects an empty list and duplicate paths without calling git", async () => {
    const harnessed = await harness();
    try {
      expect((await rejection(harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: [] }))).includes("required")).toBe(true);
      expect((await rejection(harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/a.ts", "src/a.ts"] }))).includes("uplicate")).toBe(true);
      expect(harnessed.calls.length).toBe(0);
    } finally {
      await harnessed.cleanup();
    }
  });

  it("refuses a path that is or crosses a symlink, and never reaches checkout", async () => {
    const harnessed = await harness();
    const outside = await mkdtemp(path.join(tmpdir(), "npati-c7-outside-"));
    try {
      await writeFile(path.join(outside, "notes.md"), "notes\n", "utf8");
      // A directory link is used because it can be created without elevated rights on every supported platform;
      // the guard being tested is the walk over path components, which behaves identically for file links.
      // The file name is deliberately neutral: `safeProjectPath` already refuses `secret*`-named paths with a
      // stronger reason, so a name like `secret.txt` would never reach the symlink check.
      await symlink(outside, path.join(harnessed.dir, "src", "outdir"), "junction");

      const refused = await rejection(harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/outdir/notes.md"] }));
      expect(refused.toLowerCase().includes("symlink")).toBe(true);
      expect(harnessed.calls.filter((args) => args[0] === "checkout").length).toBe(0);
    } finally {
      await harnessed.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a non-hex commit hash instead of passing it to git", async () => {
    const harnessed = await harness();
    try {
      expect((await rejection(harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/a.ts"], commitHash: "--upload-pack=evil" }))).includes("ommit")).toBe(true);
      expect((await rejection(harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/a.ts"], commitHash: "zz" }))).includes("ommit")).toBe(true);
      expect(harnessed.calls.filter((args) => args[0] === "checkout").length).toBe(0);
    } finally {
      await harnessed.cleanup();
    }
  });

  it("reports per-file outcomes honestly when one path cannot be restored", async () => {
    const harnessed = await harness({ failOn: (args) => args[0] === "checkout" && args.includes("src/b.ts") });
    try {
      const outcome = await harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/a.ts", "src/b.ts"] });

      expect(outcome.restored.join(",")).toBe("src/a.ts");
      expect(outcome.failed.length).toBe(1);
      expect(outcome.failed[0]!.path).toBe("src/b.ts");
      // The safety checkpoint exists regardless: a partial revert is still revertible.
      expect(outcome.safetyCheckpointId).toBe("cp-1");
    } finally {
      await harnessed.cleanup();
    }
  });

  it("can target a checkpoint commit explicitly", async () => {
    const harnessed = await harness({ checkpointCommit: "def5678aaaa" });
    try {
      const outcome = await harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/a.ts"], checkpointId: "cp-target" });
      expect(outcome.targetCommit).toBe("def5678aaaa");
      expect(harnessed.calls.filter((args) => args[0] === "checkout")[0]!.join(" ")).toBe("checkout def5678aaaa -- src/a.ts");
    } finally {
      await harnessed.cleanup();
    }
  });

  it("refuses without a write permission and runs no git process", async () => {
    const harnessed = await harness();
    try {
      expect((await rejection(harnessed.service.restorePaths(context(["workspace:read"]), COMPANY, PROJECT, { files: ["src/a.ts"] }))).includes("enied")).toBe(true);
      expect(harnessed.calls.length).toBe(0);
    } finally {
      await harnessed.cleanup();
    }
  });
});
