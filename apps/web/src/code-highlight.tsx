import React, { memo, useMemo } from "react";

export type CodeLanguage = "html" | "css" | "js";
type Token = { text: string; kind?: string };
/** What a line starts inside of, carried from the line before it. */
type LineState = { mode: CodeLanguage; block?: "comment" | "template" | "tag"; home: CodeLanguage; tag?: string };

export function codeLanguage(path: string): CodeLanguage | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (["html", "htm", "vue", "svelte", "astro"].includes(extension)) return "html";
  if (["css", "scss", "sass", "less"].includes(extension)) return "css";
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx", "json"].includes(extension)) return "js";
  return null;
}

const KEYWORDS = new Set("as async await break case catch class const continue default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public return static super switch this throw true try type typeof undefined var void while with yield".split(" "));
const JS = /\/\/.*|\/\*|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`|\b\d[\d_.]*(?:[eE][+-]?\d+)?\b|[A-Za-z_$][\w$]*/g;
const CSS = /\/\*|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|@[\w-]+|#[0-9a-fA-F]{3,8}\b|-?\b\d[\d.]*(?:%|[a-zA-Z]+)?|--[\w-]+|[\w-]+(?=\s*:(?!:))/g;
const HTML_TEXT = /<!--|<\/?[A-Za-z][\w:-]*|<!DOCTYPE[^>]*>/gi;
const HTML_TAG = /"[^"]*"?|'[^']*'?|\/?>|[A-Za-z_:@][\w:.-]*/g;

/** Splits one line into coloured pieces. Plain text between matches keeps every character, so the layout matches the editor. */
export function tokenizeLine(line: string, start: LineState): { tokens: Token[]; next: LineState } {
  const tokens: Token[] = [];
  const state: LineState = { ...start };
  let position = 0;
  const push = (end: number, kind?: string) => { if (end > position) tokens.push({ text: line.slice(position, end), ...(kind ? { kind } : {}) }); position = end; };
  const endsBlock = (closer: string, kind: string) => {
    const end = line.indexOf(closer, position);
    if (end < 0) { push(line.length, kind); return false; }
    push(end + closer.length, kind);
    state.block = undefined;
    return true;
  };
  while (position < line.length) {
    if (state.block === "comment") { if (!endsBlock(state.mode === "html" ? "-->" : "*/", "comment")) break; continue; }
    if (state.block === "template") {
      const end = /(?:^|[^\\])`/.exec(line.slice(position));
      if (!end) { push(line.length, "string"); break; }
      push(position + end.index + end[0].length, "string");
      state.block = undefined;
      continue;
    }
    // Embedded code ends at its closing tag, in any language.
    if (state.mode !== state.home) {
      const closing = new RegExp(`</${state.mode === "js" ? "script" : "style"}`, "i").exec(line.slice(position));
      if (closing && closing.index === 0) { state.mode = state.home; continue; }
      if (closing) {
        const scoped = tokenizeLine(line.slice(position, position + closing.index), { ...state });
        tokens.push(...scoped.tokens);
        position += closing.index;
        state.block = scoped.next.block;
        state.mode = state.home;
        continue;
      }
    }
    if (state.mode === "html" && state.block === "tag") {
      HTML_TAG.lastIndex = position;
      const match = HTML_TAG.exec(line);
      if (!match) { push(line.length); break; }
      push(match.index);
      const text = match[0];
      if (text.endsWith(">")) {
        push(position + text.length, "tag");
        state.block = undefined;
        if (state.tag === "<script") state.mode = "js"; else if (state.tag === "<style") state.mode = "css";
      } else push(position + text.length, /^["']/.test(text) ? "string" : "attr");
      continue;
    }
    if (state.mode === "html") {
      HTML_TEXT.lastIndex = position;
      const match = HTML_TEXT.exec(line);
      if (!match) { push(line.length); break; }
      push(match.index);
      if (match[0] === "<!--") { state.block = "comment"; push(position + 4, "comment"); continue; }
      push(position + match[0].length, "tag");
      if (!match[0].startsWith("<!")) { state.block = "tag"; state.tag = match[0].toLowerCase(); }
      continue;
    }
    const pattern = state.mode === "css" ? CSS : JS;
    pattern.lastIndex = position;
    const match = pattern.exec(line);
    if (!match) { push(line.length); break; }
    push(match.index);
    const text = match[0], end = position + text.length;
    if (text === "/*") { state.block = "comment"; push(end, "comment"); }
    else if (text === "`") { state.block = "template"; push(end, "string"); }
    else if (text.startsWith("//")) push(end, "comment");
    else if (/^["']/.test(text)) push(end, "string");
    else if (state.mode === "css") push(end, text.startsWith("@") ? "keyword" : /^(?:#|-?\d)/.test(text) ? "number" : "property");
    else if (/^\d/.test(text)) push(end, "number");
    else if (KEYWORDS.has(text)) push(end, "keyword");
    else push(end, /^\s*\(/.test(line.slice(end)) ? "function" : undefined);
  }
  return { tokens, next: state };
}

/** Only a line whose own text or starting state changed is drawn again, so typing stays cheap in a long file. */
const CodeLine = memo(function CodeLine({ tokens }: { tokens: Token[]; text: string; state: string }) {
  return <>{tokens.map((token, index) => token.kind ? <span key={index} className={`code-token-${token.kind}`}>{token.text}</span> : token.text)}{"\n"}</>;
}, (previous, next) => previous.text === next.text && previous.state === next.state);

export const CODE_LINE_HEIGHT = 20;
const WINDOW_STEP = 30;
const WINDOW_LINES = 180;
/** The group of rows a scroll position needs; the colours are redrawn only when it changes. */
export const codeWindow = (scrollTop: number) => Math.floor(scrollTop / CODE_LINE_HEIGHT / WINDOW_STEP) * WINDOW_STEP;

/** Colours only the rows around the viewport: a long file then costs what a short one does. */
export function HighlightedCode({ text, language, firstLine }: { text: string; language: CodeLanguage | null; firstLine: number }) {
  const lines = useMemo(() => {
    if (!language) return null;
    let state: LineState = { mode: language, home: language };
    return text.split("\n").map(line => {
      const key = JSON.stringify(state);
      const { tokens, next } = tokenizeLine(line, state);
      state = next;
      return { line, key, tokens };
    });
  }, [text, language]);
  const widest = useMemo(() => (lines ?? []).reduce((width, item) => Math.max(width, item.line.length), 0), [lines]);
  if (!lines) return <>{text}</>;
  const start = Math.max(0, firstLine - WINDOW_STEP * 2);
  const end = Math.min(lines.length, start + WINDOW_LINES);
  return <>
    <div style={{ height: start * CODE_LINE_HEIGHT, width: `${widest}ch` }} />
    {lines.slice(start, end).map((item, index) => <CodeLine key={start + index} tokens={item.tokens} text={item.line} state={item.key} />)}
    <div style={{ height: (lines.length - end) * CODE_LINE_HEIGHT }} />
  </>;
}
