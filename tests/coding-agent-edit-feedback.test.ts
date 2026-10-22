import { describe, expect, it } from "vitest";
import { applyEdit, findClosestFragment } from "../apps/agent-api/src/code-tools-write";
import { applyHunksToContent, parsePatch } from "../apps/agent-api/src/code-tools-patch";

const CSS = [":root {", "  --primary: #2255ff;", "  --bg: #ffffff;", "}", ".button {", "  color: var(--primary);", "  padding: 8px;", "}"].join("\n") + "\n";

function port(content: string) {
  return {
    readFile: async (path: string) => ({ path, content, revision: "r1" }),
    writeFile: async () => ({ path: "x", revision: "r2" }),
  } as never;
}

describe("edit returns actionable feedback (audit F-05)", () => {
  it("names the closest current text with line numbers when old_string is wrong", async () => {
    const error = await applyEdit({ path: "styles.css", old_string: "  color: var(--accent);", new_string: "  color: green;" }, port(CSS)).catch((e) => e);
    expect(error.code).toBe("edit_no_match");
    expect(error.message).toContain("Retry code.fs.edit");
    expect(error.message).not.toContain("use code.fs.write");
    expect(error.details.currentFragment).toContain("6:   color: var(--primary);");
  });

  it("finds a fragment by shared words when no line matches", () => {
    const found = findClosestFragment(CSS, "--bg value");
    expect(found?.line).toBe(3);
    expect(found?.fragment).toContain("3:   --bg: #ffffff;");
    expect(findClosestFragment("", "anything")).toBeNull();
  });
});

describe("apply_patch accepts Codex-style hunks without line ranges (audit F-06)", () => {
  it("locates a bare @@ hunk by its context", () => {
    const patch = "*** Begin Patch\n*** Update File: styles.css\n@@\n-  --bg: #ffffff;\n+  --bg: #101010;\n*** End Patch";
    const [file] = parsePatch(patch, "code.fs.apply_patch").files;
    const applied = applyHunksToContent({ path: "styles.css", content: CSS, hunks: file!.hunks, tool: "code.fs.apply_patch" });
    expect(applied.content).toContain("--bg: #101010;");
    expect(applied.content).toContain("--primary: #2255ff;");
  });

  it("accepts an anchor after @@ and still refuses ambiguous context", () => {
    const anchored = "*** Begin Patch\n*** Update File: styles.css\n@@ .button {\n-  padding: 8px;\n+  padding: 12px;\n*** End Patch";
    const [file] = parsePatch(anchored, "code.fs.apply_patch").files;
    expect(applyHunksToContent({ path: "styles.css", content: CSS, hunks: file!.hunks, tool: "code.fs.apply_patch" }).content).toContain("padding: 12px;");
    const ambiguous = "*** Begin Patch\n*** Update File: styles.css\n@@\n-}\n+} /* end */\n*** End Patch";
    const [twice] = parsePatch(ambiguous, "code.fs.apply_patch").files;
    expect(() => applyHunksToContent({ path: "styles.css", content: CSS, hunks: twice!.hunks, tool: "code.fs.apply_patch" })).toThrow(/multiple locations/);
  });

  it("keeps validating counts for ranged hunks", () => {
    const wrong = "*** Begin Patch\n*** Update File: styles.css\n@@ -3,5 +3,1 @@\n-  --bg: #ffffff;\n+  --bg: #000;\n*** End Patch";
    expect(() => parsePatch(wrong, "code.fs.apply_patch")).toThrow(/counts/);
  });
});
