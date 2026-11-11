import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeView, codeLanguage, tokenizeLine, type CodeLanguage } from "../code-highlight";

function run(source: string, language: CodeLanguage) {
  let state = { mode: language, home: language } as Parameters<typeof tokenizeLine>[1];
  return source.split("\n").map(line => {
    const result = tokenizeLine(line, state);
    state = result.next;
    return result.tokens;
  });
}
const kinds = (tokens: { text: string; kind?: string }[]) => Object.fromEntries(tokens.filter(token => token.kind).map(token => [token.text.trim(), token.kind]));

describe("code colouring", () => {
  it("keeps original JSON lines and whitespace when rendering project source files", () => {
    const source = '{"name":"demo", "enabled":true}\n';
    const html = renderToStaticMarkup(<CodeView path="package.json" text={source} preserveSource />);
    expect(html.match(/code-view-number/g)).toHaveLength(2);
    expect(html).toContain('code-token-property');
    expect(html).toContain('code-token-keyword');
    expect(html).not.toContain("--indent:2");
  });

  it("never changes a character, whatever the input", () => {
    for (const [source, language] of [['<a href="x" b>t</a> <!-- c', "html"], ["a{color:#fff;width:10px}/* x", "css"], ['const a = "x\\"y" + `t${1}` // c', "js"], ['<', "html"], ['"', "js"]] as const) {
      expect(run(source, language).flat().map(token => token.text).join("")).toBe(source);
    }
  });

  it("colours JavaScript", () => {
    expect(kinds(run('const a = fn("x", 12); // note', "js")[0]!)).toEqual({ const: "keyword", fn: "function", '"x"': "string", "12": "number", "// note": "comment" });
  });

  it("colours CSS and HTML", () => {
    expect(kinds(run("color: #ff0000;", "css")[0]!)).toEqual({ color: "property", "#ff0000": "number" });
    expect(kinds(run('<a href="x">', "html")[0]!)).toEqual({ "<a": "tag", href: "attr", '"x"': "string", ">": "tag" });
  });

  it("carries comments and templates across lines", () => {
    expect(run("/* a\nb */ const", "js")[1]).toEqual([{ text: "b */", kind: "comment" }, { text: " " }, { text: "const", kind: "keyword" }]);
    expect(run("`a\nb` + 1", "js")[1]![0]).toEqual({ text: "b`", kind: "string" });
  });

  it("switches language inside script and style blocks and back", () => {
    const lines = run("<script>\nconst a = 1;\n</script>\n<p>const</p>", "html");
    expect(kinds(lines[1]!)).toMatchObject({ const: "keyword" });
    expect(lines[3]!.some(token => token.kind === "keyword")).toBe(false);
    expect(kinds(run("<style>\ncolor: red;\n</style>", "html")[1]!)).toMatchObject({ color: "property" });
  });

  it("draws numbered code with brackets apart from the tag name and the file's indent unit", () => {
    const html = renderToStaticMarkup(<CodeView path="a.html" text={"<div>\n    <p>x</p>\n</div>"} />);
    expect(html.match(/code-view-number/g)).toHaveLength(3);
    expect(html).toContain('<span class="code-token-punctuation">&lt;</span><span class="code-token-tag">div</span><span class="code-token-punctuation">&gt;</span>');
    expect(html).toContain("--guide:4ch");
    expect(html).toContain("--indent:4");
  });

  it("gives diffs, JSON and logs the same block", () => {
    const diff = renderToStaticMarkup(<CodeView text={"--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new"} />);
    expect(diff).toContain('code-token-diff-remove">-old');
    expect(diff).toContain('code-token-diff-add">+new');
    expect(diff).toContain('code-token-diff-hunk');
    const json = renderToStaticMarkup(<CodeView text={'{"source":"ai","n":1}'} />);
    expect(json).toContain('code-token-property">&quot;source&quot;');
    expect(json).toContain('code-token-string">&quot;ai&quot;');
    expect(json.match(/code-view-number/g)).toHaveLength(4);
    const cut = renderToStaticMarkup(<CodeView text={'{"source":"a'} />);
    expect(cut).toContain("code-token-");
    const log = renderToStaticMarkup(<CodeView text={"Compiled successfully"} />);
    expect(log).toContain("code-view-number");
    expect(log).not.toContain("code-token-");
  });

  it("knows which files it can colour", () => {
    expect(["a.html", "b.SCSS", "c.tsx", "d.json", "e.py"].map(codeLanguage)).toEqual(["html", "css", "js", "js", null]);
  });
});
