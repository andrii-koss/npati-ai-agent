import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentStreamView } from "../AgentStreamView";
import { ChangesView } from "../ChangesView";
import { ApprovalCard } from "../ApprovalCard";
import type { AgentStreamItem, ChangedFile } from "../types";

/**
 * [C7-web] [security-gate] XSS hygiene for tool output and file names.
 *
 * Two independent checks, because either one alone can pass while the UI is still unsafe:
 *  1. a **source scan** — no component in this directory may use `dangerouslySetInnerHTML`, `innerHTML`,
 *     `eval`, `new Function` or build an `href`/`src` from data. A rendering convention that is only
 *     documented gets broken by the next component; this one fails the build.
 *  2. a **render check** — payloads that a model can plant (tool output, command, and above all a *file
 *     name*, which reaches the tree, the diff and the approvals card) must appear as escaped text.
 */

const PAYLOADS = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  '"><svg onload=alert(1)>',
  "javascript:alert(1)",
  "<iframe src=javascript:alert(1)>",
];

function moduleDir(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

function componentSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...componentSources(full));
      continue;
    }
    if (entry.endsWith(".tsx") || entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("[C7-web] [security-gate] XSS in tool output and file names", () => {
  it("never uses an HTML-injection or code-evaluation primitive in the workspace UI", () => {
    const files = componentSources(moduleDir());
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of ["dangerouslySetInnerHTML", "innerHTML", "outerHTML", "eval(", "new Function(", "document.write"]) {
        expect(source.includes(forbidden), `${file} must not use ${forbidden}`).toBe(false);
      }
      // No attribute may be built from a template with data, e.g. href={`javascript:${x}`}.
      expect(/href=\{\s*`/.test(source), `${file} must not build href from a template`).toBe(false);
      expect(/src=\{\s*`/.test(source), `${file} must not build src from a template`).toBe(false);
    }
  });

  it("renders tool output, commands and file names as text, never as markup", () => {
    const items: AgentStreamItem[] = PAYLOADS.flatMap((payload, index) => [
      { kind: "message", role: "assistant", text: payload } as AgentStreamItem,
      {
        kind: "tool_call",
        toolCallId: `call-${index}`,
        tool: "code.fs.write",
        file: payload,
        command: payload,
        result: payload,
        status: "ok",
      } as AgentStreamItem,
    ]);
    const files: ChangedFile[] = PAYLOADS.map((payload, index) => ({
      path: payload,
      status: "modified",
      additions: 1,
      deletions: 1,
      diff: payload,
    }));

    const markup = renderToStaticMarkup(
      React.createElement("div", null, [
        React.createElement(AgentStreamView, { items, key: "stream" }),
        React.createElement(ChangesView, { files, onRevert: () => {}, onRevertAll: () => {}, key: "changes" }),
        React.createElement(
          ApprovalCard,
          { data: { approvalId: "a1", action: "code.shell.exec", command: PAYLOADS[0] ?? "", diff: PAYLOADS[1] ?? "" }, onDecision: () => {}, key: "approval" }
        ),
      ])
    );

    // Nothing executable survived as markup...
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("onerror=");
    expect(markup).not.toContain("href=\"javascript:");
    // ...and the payload text is visible literally, so a reviewer can see what the model produced.
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).toContain("javascript:alert(1)");
  });
});
