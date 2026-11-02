import { describe, expect, it } from "vitest";
import { assertUserFileScope, explicitUserWritePaths } from "../apps/agent-api/src/code-user-file-scope";

describe("D08 explicit user file restrictions", () => {
  it.each([
    ["У файлі index.html заміни заголовок «Початковий заголовок» на «Новий заголовок». Змінюй лише index.html, решту файлів залиш без змін.", ["index.html"]],
    ["Edit only src/app.ts and src/app.test.ts.", ["src/app.ts", "src/app.test.ts"]],
    ["Редагуй тільки `src/Головна.tsx` та styles.css.", ["src/Головна.tsx", "styles.css"]],
    ["Change only index.html.", ["index.html"]],
    ["Fix index.html and investigate the failure", undefined],
    ["Edit only the title of index.html", undefined],
    ["Edit only ../outside.ts", undefined],
    ["Example:\n```\nEdit only other.ts\n```", undefined],
  ])("recognizes only explicit lists: %s", (prompt, expected) => expect(explicitUserWritePaths(prompt)).toEqual(expected));
  it.each(["code.fs.edit", "code.fs.write", "code.fs.delete"])("refuses out-of-scope %s before execution", tool => {
    expect(() => assertUserFileScope(tool, {path: "math.cjs"}, ["index.html"], true)).toThrowError(expect.objectContaining({code: "file_scope_denied", status: 403}));
    expect(() => assertUserFileScope(tool, {path: "./index.html"}, ["index.html"], true)).not.toThrow();
  });
  it("checks every move and patch target", () => {
    expect(() => assertUserFileScope("code.fs.move", {from: "index.html", to: "copy.html"}, ["index.html"], true)).toThrow();
    expect(() => assertUserFileScope("code.fs.apply_patch", {patch: "*** Begin Patch\n*** Update File: math.cjs\n@@\n-old\n+new\n*** End Patch"}, ["index.html"], true)).toThrow();
  });
  it.each(["code.shell.exec", "code.deps.install", "code.git.restore", "code.subagents.spawn", "code.fs.undo_last_turn"])("does not offer a %s workaround", tool => {
    expect(() => assertUserFileScope(tool, {}, ["index.html"], true)).toThrow();
  });
  it("keeps source reads, canonical verification and preview available", () => {
    for (const tool of ["code.fs.read", "code.verify.run", "code.preview.start"]) expect(() => assertUserFileScope(tool, {}, ["index.html"], false)).not.toThrow();
  });
});
