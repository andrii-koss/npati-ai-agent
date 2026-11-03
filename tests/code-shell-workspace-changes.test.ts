import { describe, expect, it } from "vitest";
import { withTrackedShellChanges, type ShellChangePort } from "../apps/agent-api/src/code-shell-workspace-changes";
import type { CodeWriteChange } from "../apps/agent-api/src/code-workspace-checkpoint";

function fixture(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial)), changes: CodeWriteChange[] = [], reads: string[] = [];
  const port: ShellChangePort = {
    listFiles: async () => [...files.keys()].map(path => ({ path })),
    readFile: async path => { reads.push(path); return { content: files.get(path)! }; },
    record: change => { changes.push(change); },
  };
  return { files, changes, reads, port };
}

describe("foreground shell workspace evidence", () => {
  it("records npm manifest updates and newly generated lockfiles for review", async () => {
    const f = fixture({ "e2e-smoke/package.json": '{"private":true}\n' });
    await withTrackedShellChanges(f.port, async () => {
      f.files.set("e2e-smoke/package.json", '{"private":true,"dependencies":{"lodash":"^4.18.1"}}\n');
      f.files.set("e2e-smoke/package-lock.json", '{"lockfileVersion":3}\n');
      f.files.set("e2e-smoke/node_modules/lodash/index.js", "module.exports={};");
      return { exitCode: 0 };
    });
    expect(f.changes.map(c => c.path)).toEqual(["e2e-smoke/package.json", "e2e-smoke/package-lock.json"]);
    expect(f.changes[0]?.diff).toContain('+{"private":true,"dependencies":{"lodash":"^4.18.1"}}');
    expect(f.changes[1]?.diff).toContain('+{"lockfileVersion":3}');
    expect(f.changes[0]).toMatchObject({ linesAdded: 1, linesRemoved: 1 });
    expect(f.changes.every(c => c.tool === "code.shell.exec" && !!c.sha256)).toBe(true);
  });
  it("retains partial writes and deletions when a shell command throws", async () => {
    const f = fixture({ "old.txt": "old" });
    await expect(withTrackedShellChanges(f.port, async () => { f.files.delete("old.txt"); f.files.set("new.txt", "new"); throw Error("install_failed"); })).rejects.toThrow("install_failed");
    expect(f.changes.find(c => c.path === "old.txt")?.sha256).toBeNull();
    expect(f.changes.find(c => c.path === "new.txt")?.diff).toContain("+new");
  });
  it("does not invent writes for unchanged files or read sensitive/artifact paths", async () => {
    const f = fixture({ "hello.txt": "Hello", ".env": "never read", ".git/config": "never read", "node_modules/x.js": "never read" });
    expect(await withTrackedShellChanges(f.port, async () => 42)).toBe(42);
    expect(f.changes).toEqual([]);
    expect(f.reads).toEqual(["hello.txt", "hello.txt"]);
  });
  it("runs the command however many source files the project has", async () => {
    const f = fixture(Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`${i}.txt`, ""])));
    let executed = false;
    await withTrackedShellChanges(f.port, async () => { executed = true; });
    expect(executed).toBe(true);
  });
});
