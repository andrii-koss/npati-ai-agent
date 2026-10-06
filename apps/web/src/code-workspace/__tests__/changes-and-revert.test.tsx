import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { ChangesView } from "../ChangesView";
import { revertRequest, validateChangePaths } from "../actions";
import type { ChangedFile } from "../types";

/**
 * [C7-web] [security-gate] Changes view and revert mapping.
 *
 * Revert is the destructive control here, so the tests cover both halves: the view renders what changed
 * and refuses an invalid selection with a reason, and the mapping refuses traversal paths outright rather
 * than normalising them (normalising a traversal is still a traversal).
 */

const files: ChangedFile[] = [
  { path: "src/sum.ts", status: "modified", additions: 2, deletions: 1, diff: "@@ -1 +1 @@" },
  { path: "src/extra.ts", status: "added", additions: 10, deletions: 0 },
];

describe("[C7-web] [security-gate] changes and revert", () => {
  it("renders changed files with status and statistics", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ChangesView, { files, onRevert: () => {}, onRevertAll: () => {} })
    );
    expect(markup).toContain('data-file="src/sum.ts"');
    expect(markup).toContain("modified");
    expect(markup).toContain("+2 −1");
    expect(markup).toContain("+10 −0");
    expect(markup).toContain('data-revert-file="src/sum.ts"');
    expect(markup).toContain('data-action="revert-all"');
  });

  it("shows an empty state instead of an empty table", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ChangesView, { files: [], onRevert: () => {}, onRevertAll: () => {} })
    );
    expect(markup).toContain('data-field="changes-empty"');
    expect(markup).not.toContain("<table");
  });

  it("disables every revert control when the flag is off", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ChangesView, { files, disabled: true, onRevert: () => {}, onRevertAll: () => {} })
    );
    expect(markup).toContain('data-action="revert-all"');
    expect(markup).toContain("disabled");
  });

  it("maps revert-all to a single all:true request", () => {
    const plan = revertRequest({ companyId: "c1", sessionId: "s1", all: true });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.request.path).toBe("/companies/c1/code/sessions/s1/changes/revert");
      expect(plan.request.body).toEqual({ all: true });
    }
  });

  it("maps revert-files to a validated file list", () => {
    const plan = revertRequest({ companyId: "c1", sessionId: "s1", files: ["src/sum.ts"] });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.request.body).toEqual({ files: ["src/sum.ts"] });
  });

  it("refuses traversal, absolute, drive-letter, backslash, home and empty segments", () => {
    const bad = [
      "../etc/passwd",
      "src/../../etc/passwd",
      "/etc/passwd",
      "\\windows\\system32",
      "C:/windows",
      "~/.ssh/id_rsa",
      "src//sum.ts",
      "src/./sum.ts",
    ];
    for (const path of bad) {
      const validated = validateChangePaths([path]);
      expect(validated.ok).toBe(false);
      if (!validated.ok) expect(validated.path).toBe(path);
      const plan = revertRequest({ companyId: "c1", sessionId: "s1", files: [path] });
      expect(plan.ok).toBe(false);
      // A refused revert must not produce a request at all.
      expect("request" in plan).toBe(false);
    }
  });

  it("refuses an empty selection rather than reverting everything", () => {
    expect(validateChangePaths([]).ok).toBe(false);
    expect(revertRequest({ companyId: "c1", sessionId: "s1", files: [] }).ok).toBe(false);
  });

  it("accepts ordinary nested workspace paths", () => {
    expect(validateChangePaths(["src/a/b.ts", "README.md"])).toEqual({
      ok: true,
      paths: ["src/a/b.ts", "README.md"],
    });
  });
});
