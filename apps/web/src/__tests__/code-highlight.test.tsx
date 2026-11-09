import { describe, expect, it } from "vitest";
import { codeLanguage, tokenizeLine, type CodeLanguage } from "../code-highlight";

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

  it("knows which files it can colour", () => {
    expect(["a.html", "b.SCSS", "c.tsx", "d.json", "e.py"].map(codeLanguage)).toEqual(["html", "css", "js", "js", null]);
  });
});
