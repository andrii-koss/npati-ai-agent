import { describe, expect, it, vi } from "vitest";
import { CodeToolError } from "../apps/agent-api/src/code-tools-path";
import { buildUnifiedDiff, diffStats, splitLines } from "../apps/agent-api/src/code-tools-diff";
import { extractWriteChanges } from "../apps/agent-api/src/code-workspace-checkpoint";
import {
  applyEdit, deletePathSafe, detectEol, findWhitespaceTolerantMatch, movePathSafe,
  preferredEditTool, resolveWriteLimits, writeFileSafe, type CodeWritePort,
} from "../apps/agent-api/src/code-tools-write";
import { applyHunksToContent, applyPatch, collectTurnDiff, parsePatch, validateUndoRequest } from "../apps/agent-api/src/code-tools-patch";

/** In-memory workspace: the write engine never touches a real filesystem in these tests. */
function memoryPort(files: Record<string, string>, modes: Record<string, number> = {}) {
  const store = new Map(Object.entries(files));
  const modeStore = new Map(Object.entries(modes));
  const calls = { write: 0, delete: 0, move: 0, read: 0 };
  const port: CodeWritePort = {
    async readFile(path) {
      calls.read += 1;
      const content = store.get(path);
      if (content === undefined) throw new CodeToolError("not_a_file", `"${path}" not found`, "test", 404);
      return { content, mode: modeStore.get(path), revision: `r-${content.length}` };
    },
    async writeFile(path, content, opts) {
      calls.write += 1;
      store.set(path, content);
      if (opts?.mode !== undefined) modeStore.set(path, opts.mode);
      return { sha256: `sha-${content.length}`, revision: `r-${content.length}` };
    },
    async deletePath(path, opts) {
      calls.delete += 1;
      store.delete(path);
      // A recursive delete removes the directory subtree, the way a real port would.
      if (opts?.recursive) for (const key of [...store.keys()]) if (key.startsWith(`${path}/`)) store.delete(key);
    },
    async movePath(from, to) {
      calls.move += 1;
      const value = store.get(from);
      store.delete(from);
      if (value !== undefined) store.set(to, value);
      for (const key of [...store.keys()]) {
        if (!key.startsWith(`${from}/`)) continue;
        const moved = store.get(key)!;
        store.delete(key);
        store.set(`${to}/${key.slice(from.length + 1)}`, moved);
      }
    },
    async stat(path) {
      if (!store.has(path)) {
        const isDirectory = [...store.keys()].some((key) => key.startsWith(`${path}/`));
        return isDirectory ? { exists: true, type: "dir" as const } : { exists: false };
      }
      return { exists: true, type: "file" as const, mode: modeStore.get(path), size: store.get(path)!.length };
    },
    async listDir(dir) { return [...store.keys()].filter((key) => key.startsWith(`${dir}/`)).map((key) => ({ name: key, type: "file" })); },
  };
  return { port, store, modeStore, calls };
}

const limits = { maxEditBytes: 4096, maxPatchFiles: 5, massOperationThreshold: 2 };

describe("security-gate: C3 diff engine", () => {
  it("reports removing or adding only the EOF newline as a real reviewable change", () => {
    const removed = buildUnifiedDiff("Hello\n", "Hello", "hello.txt");
    expect(removed).toContain("-Hello\n+Hello\n\\ No newline at end of file");
    expect(diffStats(removed)).toMatchObject({ additions: 1, deletions: 1 });
    const added = buildUnifiedDiff("Hello", "Hello\n", "hello.txt");
    expect(added).toContain("-Hello\n\\ No newline at end of file\n+Hello");
  });

  it("keeps an identical write out of mutation bookkeeping and performs no filesystem write", async () => {
    const { port, calls } = memoryPort({ "hello.txt": "Hello" });
    const result = await writeFileSafe({ path: "hello.txt", content: "Hello" }, port, { limits }, { revision: "r-5" });
    expect(result).toMatchObject({ created: false, diff: "", bytes: 5 });
    expect(calls.write).toBe(0);
    expect(extractWriteChanges("code.fs.write", result)).toEqual([]);
  });

  it("keeps CRLF-only mutations reviewable instead of classifying them as no-op writes", async () => {
    const { port, calls } = memoryPort({ "hello.txt": "Hello\r\n" });
    const result = await writeFileSafe({ path: "hello.txt", content: "Hello\n" }, port, { limits }, { revision: "r-7" });
    expect(result.diff).toContain("-Hello\r\n+Hello\n");
    expect(calls.write).toBe(1);
    expect(extractWriteChanges("code.fs.write", result)).toHaveLength(1);
  });
  it("produces git-style hunks with context and counts lines", () => {
    const before = "one\ntwo\nthree\nfour\nfive\n";
    const after = "one\ntwo\nTHREE\nfour\nfive\n";
    const diff = buildUnifiedDiff(before, after, "src/a.ts");
    expect(diff).toContain("--- a/src/a.ts");
    expect(diff).toContain("+++ b/src/a.ts");
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diff).toContain("-three");
    expect(diff).toContain("+THREE");
    expect(diff).toContain(" two");
    expect(diffStats(diff)).toMatchObject({ additions: 1, deletions: 1, files: 1 });
  });

  it("returns an empty diff for identical content and handles empty files", () => {
    expect(buildUnifiedDiff("same\n", "same\n", "a.ts")).toBe("");
    const created = buildUnifiedDiff("", "first\nsecond\n", "new.ts");
    expect(created).toContain("+first");
    expect(created).toContain("+second");
    expect(diffStats(created).additions).toBe(2);
    const cleared = buildUnifiedDiff("only\n", "", "gone.ts");
    expect(diffStats(cleared).deletions).toBe(1);
  });

  it("copes with a missing trailing newline and with several hunks", () => {
    const diff = buildUnifiedDiff("a\nb", "a\nB", "x.ts");
    expect(diffStats(diff)).toMatchObject({ additions: 1, deletions: 1 });
    const many = buildUnifiedDiff(
      Array.from({ length: 40 }, (_, index) => `line-${index}`).join("\n"),
      Array.from({ length: 40 }, (_, index) => (index === 2 || index === 30 ? `changed-${index}` : `line-${index}`)).join("\n"),
      "big.ts",
    );
    expect(many.match(/@@ /g)?.length).toBe(2);
    expect(splitLines("a\nb\n")).toMatchObject({ trailingNewline: true });
    expect(splitLines("a\nb")).toMatchObject({ trailingNewline: false });
  });
});

describe("security-gate: C3 code.fs.edit", () => {
  it("replaces a unique match and reports diff, hash, encoding and EOL", async () => {
    const { port } = memoryPort({ "src/a.ts": "const a = 1;\nconst b = 2;\n" });
    const result = await applyEdit({ path: "src/a.ts", old_string: "const b = 2;", new_string: "const b = 3;" }, port, { limits });
    expect(result).toMatchObject({ path: "src/a.ts", replacements: 1, linesAdded: 1, linesRemoved: 1, encoding: "utf8", eol: "lf" });
    expect(result.sha256).toBeTruthy();
    expect(result.diff).toContain("+const b = 3;");
  });

  it("refuses a missing match and offers a whitespace-tolerant hint", async () => {
    const { port } = memoryPort({ "src/a.ts": "function f() {\n    return 1;\n}\n" });
    await expect(applyEdit({ path: "src/a.ts", old_string: "function f() {\n  return 1;\n}", new_string: "x" }, port, { limits }))
      .rejects.toMatchObject({ code: "edit_no_match", details: { line: 1 } });
    const hint = findWhitespaceTolerantMatch("function f() {\n    return 1;\n}\n", "function f() {\n  return 1;\n}");
    expect(hint?.line).toBe(1);
    expect(hint?.snippet).toContain("return 1;");
    await expect(applyEdit({ path: "src/a.ts", old_string: "absent", new_string: "x" }, port, { limits }))
      .rejects.toMatchObject({ code: "edit_no_match" });
  });

  it("refuses an ambiguous match unless replace_all is set", async () => {
    const { port, store } = memoryPort({ "src/a.ts": "let x = 1;\nlet y = x;\nlet z = x;\n" });
    await expect(applyEdit({ path: "src/a.ts", old_string: "x", new_string: "q" }, port, { limits }))
      .rejects.toMatchObject({ code: "edit_not_unique", details: { occurrences: 3 } });
    const result = await applyEdit({ path: "src/a.ts", old_string: "x", new_string: "q", replace_all: true }, port, { limits });
    expect(result.replacements).toBe(3);
    expect(store.get("src/a.ts")).toBe("let q = 1;\nlet y = q;\nlet z = q;\n");
  });

  it("preserves CRLF, LF, BOM, unicode, tabs and file mode", async () => {
    const { port, store, modeStore } = memoryPort({
      "crlf.txt": "a\r\nb\r\n",
      "bom.txt": "\uFEFFa\nb\n",
      "tabs.ts": "\tif (x) {\n\t\ty();\n\t}\n",
      "mode.sh": "#!/bin/sh\necho hi\n",
    }, { "mode.sh": 0o755 });
    const crlf = await applyEdit({ path: "crlf.txt", old_string: "b", new_string: "B" }, port, { limits });
    expect(crlf.eol).toBe("crlf");
    expect(store.get("crlf.txt")).toBe("a\r\nB\r\n");
    const bom = await applyEdit({ path: "bom.txt", old_string: "b", new_string: "B" }, port, { limits });
    expect(bom.encoding).toBe("utf8-bom");
    expect(store.get("bom.txt")!.startsWith("\uFEFF")).toBe(true);
    await applyEdit({ path: "tabs.ts", old_string: "\t\ty();", new_string: "\t\tz();" }, port, { limits });
    expect(store.get("tabs.ts")).toContain("\t\tz();");
    await applyEdit({ path: "mode.sh", old_string: "hi", new_string: "héllo ✓" }, port, { limits });
    expect(store.get("mode.sh")).toContain("héllo ✓");
    expect(modeStore.get("mode.sh")).toBe(0o755);
  });

  it("reports a mixed line-ending file and refuses a change above the size limit", async () => {
    const { port } = memoryPort({ "mixed.txt": "a\r\nb\n" });
    const result = await applyEdit({ path: "mixed.txt", old_string: "b", new_string: "B" }, port, { limits });
    expect(result.eolMixed).toBe(true);
    expect(detectEol("a\nb\r\nc\r\n")).toMatchObject({ eol: "crlf", mixed: true });
    const small = memoryPort({ "big.txt": "x".repeat(5000) });
    await expect(applyEdit({ path: "big.txt", old_string: "x", new_string: "y", replace_all: true }, small.port, { limits }))
      .rejects.toMatchObject({ code: "edit_too_large" });
  });

  it("refuses identical strings and a non-string argument", async () => {
    const { port } = memoryPort({ "src/a.ts": "a\n" });
    await expect(applyEdit({ path: "src/a.ts", old_string: "a", new_string: "a" }, port, { limits }))
      .rejects.toMatchObject({ code: "unchanged" });
    await expect(applyEdit({ path: "src/a.ts", old_string: 5, new_string: "b" }, port, { limits }))
      .rejects.toMatchObject({ code: "invalid_argument" });
  });
});

describe("security-gate: C3 write guards", () => {
  it("refuses .git, sensitive files, traversal and absolute paths; allows them only with approval", async () => {
    const { port } = memoryPort({ ".git/config": "[core]\n", ".env": "TOKEN=abc\n", "src/a.ts": "a\n" });
    await expect(applyEdit({ path: ".git/config", old_string: "core", new_string: "core2" }, port, { limits }))
      .rejects.toMatchObject({ code: "git_dir_protected" });
    await expect(applyEdit({ path: ".env", old_string: "abc", new_string: "xyz" }, port, { limits }))
      .rejects.toMatchObject({ code: "sensitive_file_denied" });
    await expect(applyEdit({ path: "../outside.ts", old_string: "a", new_string: "b" }, port, { limits }))
      .rejects.toMatchObject({ code: "path_outside_workspace" });
    await expect(applyEdit({ path: "/etc/passwd", old_string: "a", new_string: "b" }, port, { limits }))
      .rejects.toMatchObject({ code: "path_outside_workspace" });
    await expect(applyEdit({ path: "src/../a.ts", old_string: "a", new_string: "b" }, port, { limits }))
      .rejects.toMatchObject({ code: "path_outside_workspace" });
    const approved = await applyEdit({ path: ".env", old_string: "abc", new_string: "xyz" }, port, { limits, approved: true });
    expect(approved.approved).toBe(true);
  });

  it("requires a recursive delete and a mass patch to be approved", async () => {
    const { port } = memoryPort({ "src/a.ts": "a\n", "src/b.ts": "b\n", "src/c.ts": "c\n" });
    await expect(deletePathSafe({ path: "src", recursive: true }, port, { limits }))
      .rejects.toMatchObject({ code: "approval_required" });
    // Three files exceed the mass-operation threshold of two, so the patch needs approval.
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+A",
      "*** Update File: src/b.ts",
      "@@ -1,1 +1,1 @@",
      "-b",
      "+B",
      "*** Update File: src/c.ts",
      "@@ -1,1 +1,1 @@",
      "-c",
      "+C",
      "*** End Patch",
    ].join("\n");
    await expect(applyPatch({ patch }, port, { limits })).rejects.toMatchObject({ code: "approval_required" });
    const approved = await applyPatch({ patch }, port, { limits, approved: true });
    expect(approved.applied).toHaveLength(3);
  });

  it("refuses to delete the workspace root and a directory without recursive", async () => {
    const { port } = memoryPort({ "src/a.ts": "a\n" });
    await expect(deletePathSafe({ path: "." }, port, { limits, approved: true }))
      .rejects.toMatchObject({ code: "invalid_path" });
    await expect(deletePathSafe({ path: "src", recursive: false }, port, { limits }))
      .rejects.toMatchObject({ code: "not_a_file" });
  });

  it("keeps mass thresholds configurable and reports the effective limits", () => {
    const resolved = resolveWriteLimits({ NPATI_CODE_MAX_EDIT_BYTES: "1024", NPATI_CODE_MAX_PATCH_FILES: "3", NPATI_CODE_MASS_OP_THRESHOLD: "1" } as NodeJS.ProcessEnv);
    expect(resolved).toEqual({ maxEditBytes: 1024, maxPatchFiles: 3, massOperationThreshold: 1 });
    expect(resolveWriteLimits({ NPATI_CODE_MAX_EDIT_BYTES: "-5" } as NodeJS.ProcessEnv).maxEditBytes).toBe(1024);
  });
});

describe("security-gate: C3 code.fs.write, move and delete", () => {
  it("creates a file, refuses a silent overwrite and reports the diff", async () => {
    const { port, store } = memoryPort({ "src/existing.ts": "old\n" });
    const created = await writeFileSafe({ path: "src/new.ts", content: "export const x = 1;\n" }, port, { limits });
    expect(created).toMatchObject({ created: true, linesAdded: 1 });
    expect(store.get("src/new.ts")).toBe("export const x = 1;\n");

    await expect(writeFileSafe({ path: "src/existing.ts", content: "new\n" }, port, { limits }))
      .rejects.toMatchObject({ code: "not_read" });
    await expect(writeFileSafe({ path: "src/existing.ts", content: "new\n", overwrite: false }, port, { limits }))
      .rejects.toMatchObject({ code: "already_exists" });
    const overwritten = await writeFileSafe({ path: "src/existing.ts", content: "new\n" }, port, { limits }, { revision: "r-4" });
    expect(overwritten.created).toBe(false);
    expect(store.get("src/existing.ts")).toBe("new\n");
  });

  it("refuses to write over a directory", async () => {
    const { port } = memoryPort({ "src/a.ts": "a\n" });
    await expect(writeFileSafe({ path: "src", content: "x" }, port, { limits }))
      .rejects.toMatchObject({ code: "not_a_file" });
  });

  it("moves a file and refuses to overwrite without the flag", async () => {
    const { port, store } = memoryPort({ "src/a.ts": "a\n", "src/b.ts": "b\n" });
    const moved = await movePathSafe({ from: "src/a.ts", to: "src/c.ts" }, port, { limits });
    expect(moved.moved).toBe(true);
    expect(store.has("src/a.ts")).toBe(false);
    await expect(movePathSafe({ from: "src/b.ts", to: "src/c.ts" }, port, { limits }))
      .rejects.toMatchObject({ code: "already_exists" });
  });

  it("blocks a recursive delete only until it is approved, and never deletes a missing path silently", async () => {
    const { port, store } = memoryPort({ "src/a.ts": "a\n" });
    await expect(deletePathSafe({ path: "missing.ts" }, port, { limits }))
      .rejects.toMatchObject({ code: "not_a_file", httpStatus: 404 });
    const deleted = await deletePathSafe({ path: "src", recursive: true }, port, { limits, approved: true });
    expect(deleted).toMatchObject({ deleted: true, recursive: true, approved: true });
    expect(store.has("src/a.ts")).toBe(false);
  });

  it("collects a turn diff and validates the undo confirmation", () => {
    const turn = collectTurnDiff([
      { path: "a.ts", before: "x\n", after: "y\n" },
      { path: "b.ts", before: "", after: "new\n" },
    ], { maxFiles: 10 });
    expect(turn.stats).toEqual({ files: 2, additions: 2, deletions: 1 });
    expect(turn.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(collectTurnDiff([{ path: "a.ts", before: "x\n", after: "y\n" }], { path: "b.ts" }).files).toHaveLength(0);
    expect(() => validateUndoRequest({})).toThrowError(CodeToolError);
    expect(validateUndoRequest({ confirm: true })).toEqual({ confirmed: true });
  });

  it("runs post-write hooks as warnings that never block the write", async () => {
    const { port, store } = memoryPort({ "src/a.ts": "a\n" });
    const result = await applyEdit({ path: "src/a.ts", old_string: "a", new_string: "b" }, port, {
      limits,
      hooks: {
        formatChangedFiles: async () => ({ warnings: ["formatter not configured"] }),
        checkSyntax: async () => { throw new Error("syntax service down"); },
      },
    });
    expect(result.warnings).toEqual(["formatter not configured", "syntax hook failed: syntax service down"]);
    expect(store.get("src/a.ts")).toBe("b\n");
  });
});

describe("security-gate: C3 code.fs.apply_patch", () => {
  it("applies an update, an add and a delete atomically and reports per-file stats", async () => {
    const { port, store, calls } = memoryPort({ "src/a.ts": "one\ntwo\n", "src/gone.ts": "bye\n" });
    const result = await applyPatch({
      patch: [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@ -1,2 +1,3 @@",
        " one",
        "-two",
        "+two",
        "+three",
        "*** Add File: src/new.ts",
        "+export const value = 1;",
        "*** Delete File: src/gone.ts",
        "*** End Patch",
      ].join("\n"),
    }, port, { limits, approved: true });
    expect(result.dryRun).toBe(false);
    expect(result.applied.map((entry) => [entry.path, entry.action])).toEqual([
      ["src/a.ts", "update"], ["src/new.ts", "add"], ["src/gone.ts", "delete"],
    ]);
    expect(store.get("src/a.ts")).toBe("one\ntwo\nthree\n");
    expect(store.get("src/new.ts")).toBe("export const value = 1;\n");
    expect(store.has("src/gone.ts")).toBe(false);
    expect(result.stats.files).toBe(3);
    // Two writes plus one delete, nothing more.
    expect(calls.write).toBe(2);
    expect(calls.delete).toBe(1);
  });

  it("writes nothing at all when one hunk in the middle conflicts", async () => {
    const { port, store, calls } = memoryPort({ "src/a.ts": "one\ntwo\n", "src/b.ts": "alpha\n" });
    await expect(applyPatch({
      patch: [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@ -1,1 +1,1 @@",
        "-one",
        "+ONE",
        "*** Update File: src/b.ts",
        "@@ -1,1 +1,1 @@",
        "-wrong-context",
        "+x",
        "*** End Patch",
      ].join("\n"),
    }, port, { limits, approved: true })).rejects.toMatchObject({ code: "patch_conflict", details: { path: "src/b.ts", hunk: 1, line: 1 } });
    expect(store.get("src/a.ts")).toBe("one\ntwo\n");
    expect(store.get("src/b.ts")).toBe("alpha\n");
    expect(calls.write).toBe(0);
  });

  it("rolls back what was already written if a later write fails", async () => {
    const { port, store } = memoryPort({ "src/a.ts": "one\n", "src/b.ts": "alpha\n" });
    const failing: CodeWritePort = {
      ...port,
      async writeFile(path, content, opts) {
        if (path === "src/b.ts") throw new Error("disk full");
        return port.writeFile(path, content, opts);
      },
    };
    await expect(applyPatch({
      patch: [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@ -1,1 +1,1 @@",
        "-one",
        "+ONE",
        "*** Update File: src/b.ts",
        "@@ -1,1 +1,1 @@",
        "-alpha",
        "+ALPHA",
        "*** End Patch",
      ].join("\n"),
    }, failing, { limits, approved: true })).rejects.toThrow(/disk full/);
    expect(store.get("src/a.ts")).toBe("one\n");
  });

  it("computes a dry run without writing anything", async () => {
    const { port, store, calls } = memoryPort({ "src/a.ts": "one\n" });
    const result = await applyPatch({
      patch: ["*** Begin Patch", "*** Update File: src/a.ts", "@@ -1,1 +1,1 @@", "-one", "+ONE", "*** End Patch"].join("\n"),
      dryRun: true,
    }, port, { limits });
    expect(result.dryRun).toBe(true);
    expect(result.diff).toContain("+ONE");
    expect(result.applied).toHaveLength(1);
    expect(calls.write).toBe(0);
    expect(store.get("src/a.ts")).toBe("one\n");
  });

  it("applies several hunks of the same file sequentially without clobbering each other", async () => {
    const before = Array.from({ length: 12 }, (_, index) => `line${index}`).join("\n");
    const port = memoryPort({ "src/a.ts": `${before}\n` });
    const result = await applyPatch({
      patch: [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@ -1,2 +1,2 @@",
        " line0",
        "-line1",
        "+LINE1",
        "@@ -11,2 +11,2 @@",
        "-line10",
        "+LINE10",
        " line11",
        "*** End Patch",
      ].join("\n"),
    }, port.port, { limits, approved: true });
    expect(result.applied[0]!.linesAdded).toBe(2);
    const content = port.store.get("src/a.ts")!;
    expect(content).toContain("LINE1");
    expect(content).toContain("LINE10");
    expect(content).toContain("line2");
  });

  it("refuses a malformed patch, an oversized patch and a duplicate file entry", async () => {
    const { port } = memoryPort({ "src/a.ts": "a\n" });
    await expect(applyPatch({ patch: "no markers here" }, port, { limits })).rejects.toMatchObject({ code: "patch_invalid" });
    await expect(applyPatch({ patch: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" }, port, { limits }))
      .rejects.toMatchObject({ code: "patch_invalid" });
    const tooMany = ["*** Begin Patch", ...Array.from({ length: 6 }, (_, index) => `*** Add File: src/f${index}.ts\n+x`), "*** End Patch"].join("\n");
    await expect(applyPatch({ patch: tooMany }, port, { limits, approved: true })).rejects.toMatchObject({ code: "patch_too_large" });
    const duplicated = [
      "*** Begin Patch",
      "*** Update File: src/a.ts", "@@ -1,1 +1,1 @@", "-a", "+A",
      "*** Update File: src/a.ts", "@@ -1,1 +1,1 @@", "-A", "+AA",
      "*** End Patch",
    ].join("\n");
    await expect(applyPatch({ patch: duplicated }, port, { limits, approved: true })).rejects.toMatchObject({ code: "patch_invalid" });
  });

  it("parses a patch without side effects and applies hunks purely in memory", () => {
    const parsed = parsePatch(["*** Begin Patch", "*** Update File: a.ts", "@@ -3,2 +3,3 @@", " ctx", "-old", "+new", "+extra", "*** End Patch"].join("\n"));
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({ path: "a.ts", action: "update" });
    expect(parsed.files[0]!.hunks[0]).toMatchObject({ beforeStart: 3, beforeCount: 2, afterStart: 3, afterCount: 3 });
    const applied = applyHunksToContent({ path: "a.ts", content: "one\ntwo\nctx\nold\nlast\n", hunks: parsed.files[0]!.hunks, tool: "test" });
    expect(applied.content).toBe("one\ntwo\nctx\nnew\nextra\nlast\n");
  });

  it("protects sensitive and git paths inside a patch too", async () => {
    const { port, calls } = memoryPort({ ".env": "TOKEN=1\n" });
    await expect(applyPatch({
      patch: ["*** Begin Patch", "*** Update File: .env", "@@ -1,1 +1,1 @@", "-TOKEN=1", "+TOKEN=2", "*** End Patch"].join("\n"),
    }, port, { limits })).rejects.toMatchObject({ code: "sensitive_file_denied" });
    expect(calls.write).toBe(0);
  });

  it("refuses to add a file that already exists", async () => {
    const { port } = memoryPort({ "src/a.ts": "a\n" });
    await expect(applyPatch({
      patch: ["*** Begin Patch", "*** Add File: src/a.ts", "+x", "*** End Patch"].join("\n"),
    }, port, { limits, approved: true })).rejects.toMatchObject({ code: "already_exists" });
  });
});

describe("security-gate: C3 edit tool preference", () => {
  it("picks the tool from the profile without hardcoding model names", () => {
    expect(preferredEditTool(null)).toBe("code.fs.edit");
    expect(preferredEditTool({ preferredEditTool: "apply_patch" })).toBe("code.fs.apply_patch");
    expect(preferredEditTool({ preferred_edit_tool: "write_whole_file_for_small" }, { fileBytes: 100 })).toBe("code.fs.write");
    expect(preferredEditTool({ preferred_edit_tool: "write_whole_file_for_small" }, { fileBytes: 100_000 })).toBe("code.fs.edit");
    expect(preferredEditTool({ preferredEditTool: "apply_patch", smallFileBytes: 10 }, { fileBytes: 5 })).toBe("code.fs.apply_patch");
    expect(preferredEditTool({ preferredEditTool: "something-else" })).toBe("code.fs.edit");
  });

  it("keeps the write engine dependency-free of process state", async () => {
    const { port } = memoryPort({ "src/a.ts": "a\n" });
    const spy = vi.spyOn(process, "cwd");
    await applyEdit({ path: "src/a.ts", old_string: "a", new_string: "b" }, port, { limits });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("security-gate: C3 literal replacement and inserted newline regression", () => {
  it.each(["$&", "$$", "$" + String.fromCharCode(96), "$'"])("writes replacement token %s literally", async (replacement) => {
    const { port, store } = memoryPort({ "literal.txt": "before TARGET after\n" });
    await applyEdit({ path: "literal.txt", old_string: "TARGET", new_string: replacement }, port);
    expect(store.get("literal.txt")).toBe("before " + replacement + " after\n");
  });
  it.each([false, true])("preserves CRLF when inserting LF text (replace_all=%s)", async (replaceAll) => {
    const { port, store } = memoryPort({ "lines.txt": "\uFEFFfirst\r\nTARGET\r\nlast\r\n" });
    await applyEdit({ path: "lines.txt", old_string: "TARGET", new_string: "two\nlines", replace_all: replaceAll }, port);
    expect(store.get("lines.txt")).toBe("\uFEFFfirst\r\ntwo\r\nlines\r\nlast\r\n");
  });
});

describe("security-gate: C3 patch commit failure regression", () => {
  const patch = "*** Begin Patch\n*** Update File: a.txt\n@@ -1 +1 @@\n-old-a\n+new-a\n*** Update File: b.txt\n@@ -1 +1 @@\n-old-b\n+new-b\n*** End Patch";
  it("reports incomplete rollback without overwriting a concurrent edit", async () => {
    const { port, store } = memoryPort({ "a.txt": "old-a\n", "b.txt": "old-b\n" });
    const write = port.writeFile.bind(port);
    port.writeFile = async (path, content, opts) => {
      if (path === "b.txt") {
        store.set("a.txt", "concurrent edit\n");
        throw new Error("simulated disk failure");
      }
      return write(path, content, opts);
    };
    await expect(applyPatch({ patch }, port)).rejects.toMatchObject({ code: "write_failed", details: { rollbackIncomplete: true, paths: ["a.txt"] } });
    expect(store.get("a.txt")).toBe("concurrent edit\n");
    expect(store.get("b.txt")).toBe("old-b\n");
  });
});
