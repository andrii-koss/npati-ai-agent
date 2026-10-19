import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

async function harness(options: { failOn?: (args: string[]) => boolean; checkpointCommit?: string; clean?: boolean; inCheckpoint?: string[]; noCheckpoints?: boolean } = {}): Promise<Harness> {
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
    // `cat-file -e <commit>:<path>` decides restore-versus-remove, so the double has to model it: a path is in the
    // checkpoint when listed, and by default everything is (which keeps the argv assertions above readable).
    if (head === "cat-file") {
      const spec = String(args[2] ?? "");
      const target = spec.slice(spec.indexOf(":") + 1);
      if (options.inCheckpoint && !options.inCheckpoint.includes(target)) throw new Error("path not in checkpoint");
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };

  const store = {
    createProjectCheckpoint: async (_ctx: AuthContext, _companyId: string, _projectId: string, input: { name: string; commitHash: string; trigger?: string }) => {
      checkpoints.push({ name: input.name, trigger: input.trigger });
      return { id: `cp-${checkpoints.length}`, name: input.name, commitHash: input.commitHash, trigger: input.trigger ?? "manual" } as unknown as ProjectCheckpoint;
    },
    getProjectCheckpoint: async () => ({ id: "cp-target", name: "target", commitHash: options.checkpointCommit ?? "def5678aaaa", trigger: "pre_run" }) as unknown as ProjectCheckpoint,
    // The revert target is resolved from the checkpoint list, never from HEAD.
    listProjectCheckpoints: async () => (options.noCheckpoints ? [] : [{ id: "cp-latest", name: "pre run", commitHash: COMMIT, trigger: "pre_run" }]) as unknown as ProjectCheckpoint[],
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

/** `stat` that answers "is this path there?" instead of throwing. */
async function existsOnDisk(target: string): Promise<boolean> {
  return stat(target).then(() => true).catch(() => false);
}

/**
 * Checkpoint-state semantics, verified with **real filesystem state**.
 *
 * A note on what is and is not proven here. The confining sandbox forbids spawning processes with piped stdio
 * (`spawn EPERM`), so a suite cannot run the real `git` binary. What is therefore asserted is the decision and its
 * filesystem effect: a path that the checkpoint contains produces a path-scoped `checkout <checkpoint> -- <path>`
 * (git's own guarantee is that this recreates a deleted file and rewinds a modified one), and a path the checkpoint
 * does **not** contain is really deleted from disk — that part runs for real and is checked with `stat`, not inferred
 * from an argument list.
 */
describe("[C7] [security-gate] path revert reaches the checkpoint state, not the HEAD state", () => {
  it("restores a path that existed in the checkpoint instead of deleting it", async () => {
    const harnessed = await harness({ inCheckpoint: ["src/keep.ts"] });
    try {
      await writeFile(path.join(harnessed.dir, "src", "keep.ts"), "keep v2 (run)\n", "utf8");

      const outcome = await harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/keep.ts"] });

      expect(outcome.restored.join(",")).toBe("src/keep.ts");
      expect(outcome.removed.length).toBe(0);
      const checkout = harnessed.calls.filter((args) => args[0] === "checkout");
      expect(checkout.length).toBe(1);
      // Anchored on the checkpoint commit, never on HEAD.
      expect(checkout[0]!.join(" ")).toBe(`checkout ${COMMIT} -- src/keep.ts`);
      expect(await existsOnDisk(path.join(harnessed.dir, "src", "keep.ts"))).toBe(true);
    } finally {
      await harnessed.cleanup();
    }
  });

  it("really removes a path that was created after the checkpoint", async () => {
    const harnessed = await harness({ inCheckpoint: [] });
    try {
      const created = path.join(harnessed.dir, "src", "created-after.ts");
      await writeFile(created, "created by the run\n", "utf8");
      expect(await existsOnDisk(created)).toBe(true);

      const outcome = await harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/created-after.ts"] });

      expect(outcome.removed.join(",")).toBe("src/created-after.ts");
      expect(outcome.restored.length).toBe(0);
      // The checkpoint state is observed on disk, not assumed from the plan.
      expect(await existsOnDisk(created)).toBe(false);
      expect(harnessed.calls.filter((args) => args[0] === "checkout").length).toBe(0);
    } finally {
      await harnessed.cleanup();
    }
  });

  it("restores a path that was deleted after the checkpoint", async () => {
    const harnessed = await harness({ inCheckpoint: ["src/remove-me.ts"] });
    try {
      // The run deleted it; reverting must ask git for the checkpoint version rather than treat it as new.
      const outcome = await harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/remove-me.ts"] });

      expect(outcome.restored.join(",")).toBe("src/remove-me.ts");
      expect(outcome.removed.length).toBe(0);
      const checkout = harnessed.calls.filter((args) => args[0] === "checkout");
      expect(checkout[0]!.join(" ")).toBe(`checkout ${COMMIT} -- src/remove-me.ts`);
    } finally {
      await harnessed.cleanup();
    }
  });

  it("returns both sides of a rename to the checkpoint state", async () => {
    // At the checkpoint only the old name existed, so the old name is restored and the new one is removed.
    const harnessed = await harness({ inCheckpoint: ["src/old-name.ts"] });
    try {
      const renamed = path.join(harnessed.dir, "src", "new-name.ts");
      await writeFile(renamed, "rename me\n", "utf8");

      const outcome = await harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/new-name.ts", "src/old-name.ts"] });

      expect(outcome.removed.join(",")).toBe("src/new-name.ts");
      expect(outcome.restored.join(",")).toBe("src/old-name.ts");
      expect(await existsOnDisk(renamed)).toBe(false);
      expect(harnessed.calls.filter((args) => args[0] === "checkout")[0]!.join(" ")).toBe(`checkout ${COMMIT} -- src/old-name.ts`);
    } finally {
      await harnessed.cleanup();
    }
  });

  it("leaves a modified sibling alone while reverting its neighbour", async () => {
    const harnessed = await harness({ inCheckpoint: [] });
    try {
      const sibling = path.join(harnessed.dir, "src", "unrelated.ts");
      const target = path.join(harnessed.dir, "src", "created-after.ts");
      await writeFile(sibling, "run's own work\n", "utf8");
      await writeFile(target, "created by the run\n", "utf8");

      await harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/created-after.ts"] });

      expect(await existsOnDisk(target)).toBe(false);
      expect(await readFile(sibling, "utf8")).toBe("run's own work\n");
    } finally {
      await harnessed.cleanup();
    }
  });
});

describe("[C7] [security-gate] removal stays guarded", () => {
  it("removes a directory created after the checkpoint without touching its parent", async () => {
    const harnessed = await harness({ inCheckpoint: [] });
    try {
      await mkdir(path.join(harnessed.dir, "src", "newdir"), { recursive: true });
      await writeFile(path.join(harnessed.dir, "src", "newdir", "inside.txt"), "x\n", "utf8");

      const outcome = await harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/newdir"] });

      expect(outcome.removed.join(",")).toBe("src/newdir");
      expect(await existsOnDisk(path.join(harnessed.dir, "src", "newdir"))).toBe(false);
      expect(await existsOnDisk(path.join(harnessed.dir, "src"))).toBe(true);
    } finally {
      await harnessed.cleanup();
    }
  });

  it("refuses to remove a path reached through a junction and leaves the target intact", async () => {
    const harnessed = await harness({ inCheckpoint: [] });
    const outside = await mkdtemp(path.join(tmpdir(), "npati-c7-outside-"));
    try {
      await writeFile(path.join(outside, "precious.txt"), "precious\n", "utf8");
      await symlink(outside, path.join(harnessed.dir, "src", "linked"), "junction");

      const refused = await rejection(harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/linked/precious.txt"] }));

      expect(refused.toLowerCase().includes("symlink")).toBe(true);
      expect(await readFile(path.join(outside, "precious.txt"), "utf8")).toBe("precious\n");
      // Nothing was restored and nothing was deleted: the guard runs before any mutation.
      expect(harnessed.calls.filter((args) => args[0] === "checkout").length).toBe(0);
      expect(harnessed.calls.filter((args) => args[0] === "rm").length).toBe(0);
    } finally {
      await harnessed.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses when there is no checkpoint to anchor the revert on", async () => {
    const harnessed = await harness({ inCheckpoint: [], noCheckpoints: true });
    try {
      const refused = await rejection(harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/a.ts"] }));
      expect(refused.toLowerCase().includes("checkpoint")).toBe(true);
      // A revert anchored on HEAD would silently keep the run's commits, so it refuses instead.
      expect(harnessed.calls.filter((args) => args[0] === "checkout").length).toBe(0);
    } finally {
      await harnessed.cleanup();
    }
  });

  it("keeps 'revert all' on the checkpoint service and independent of the path-scoped revert", async () => {
    const harnessed = await harness();
    try {
      // `all` is unchanged: it still resets the workspace to the checkpoint, which is why it must never be reused
      // for a single file.
      await harnessed.service.restoreCheckpoint(context(), COMPANY, PROJECT, "cp-target");
      const allArgs = harnessed.calls.map((entry) => entry.join(" "));
      expect(allArgs.includes("-c core.autocrlf=false reset --hard def5678aaaa")).toBe(true);
      expect(allArgs.includes("clean -fd -e .npati-* -e .worktrees")).toBe(true);
      expect(allArgs.includes("clean -fd")).toBe(false);

      harnessed.calls.length = 0;
      await harnessed.service.restorePaths(context(), COMPANY, PROJECT, { files: ["src/a.ts"], commitHash: "def5678aaaa" });

      const pathArgs = harnessed.calls.map((entry) => entry.join(" "));
      expect(pathArgs.some((line) => line.includes("reset") || line.includes("clean"))).toBe(false);
      expect(pathArgs.includes("checkout def5678aaaa -- src/a.ts")).toBe(true);
    } finally {
      await harnessed.cleanup();
    }
  });
});
