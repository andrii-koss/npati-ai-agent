import { describe, expect, it } from "vitest";
import { fileChanges } from "../chat-file-diff";

describe("agent changes in an opened file", () => {
  it("marks a replaced line as modified and keeps the old text", () => {
    const result = fileChanges("a\nb\nc", "a\nB\nc");
    expect(result.changes).toEqual([{ kind: "modified", line: 1, old: ["b"] }]);
    expect(result).toMatchObject({ added: 1, removed: 1 });
  });

  it("marks inserted lines as added and removed lines where they were", () => {
    expect(fileChanges("a\nc", "a\nb\nc").changes).toEqual([{ kind: "added", line: 1 }]);
    expect(fileChanges("a\nb\nc", "a\nc").changes).toEqual([{ kind: "deleted", line: 1, old: ["b"] }]);
    expect(fileChanges("a\nb", "a").changes).toEqual([{ kind: "deleted", line: 1, old: ["b"] }]);
  });

  it("treats a file the run created as all new", () => {
    const result = fileChanges(null, "x\ny");
    expect(result.changes.map(change => change.kind)).toEqual(["added", "added"]);
    expect(result).toMatchObject({ added: 2, removed: 0 });
  });

  it("lists before and after lines in order for the change view", () => {
    const ops = fileChanges("one\ntwo\nthree", "one\n2\nthree\nfour").ops.map(op => (op.type === "add" ? "+" : op.type === "del" ? "-" : " ") + op.text);
    expect(ops).toEqual([" one", "-two", "+2", " three", "+four"]);
  });

  it("reports nothing for an unchanged file", () => {
    expect(fileChanges("same\ntext", "same\ntext")).toMatchObject({ changes: [], added: 0, removed: 0 });
  });
});
