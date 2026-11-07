import { describe, expect, it } from "vitest";
import { javascriptSyntax } from "../apps/agent-api/src/code-js-syntax-check";

describe("JavaScript syntax in the write result", () => {
  it("accepts a valid script and a valid module", async () => {
    expect(await javascriptSyntax("app.js", "const a = 1;\ndocument.title = String(a);\n")).toMatchObject({ ok: true });
    expect(await javascriptSyntax("src/main.js", "import x from './x.js';\nexport const y = x;\n")).toMatchObject({ ok: true });
  });
  it("names the agent's file and the line of a syntax error", async () => {
    const result = await javascriptSyntax("script.js", "function f() {\n  return 1;\n\n");
    expect(result?.ok).toBe(false);
    expect((result as { error: string }).error).toContain("script.js");
    expect((result as { error: string }).error).not.toContain("npati-syntax-");
  });
  it("never runs the file and skips anything that is not JavaScript", async () => {
    expect(await javascriptSyntax("app.js", "require('fs').writeFileSync('/tmp/npati-ran', '1')")).toMatchObject({ ok: true });
    expect(await javascriptSyntax("styles.css", "body {")).toBeUndefined();
    expect(await javascriptSyntax("app.ts", "let x: number = 1")).toBeUndefined();
  });
});
