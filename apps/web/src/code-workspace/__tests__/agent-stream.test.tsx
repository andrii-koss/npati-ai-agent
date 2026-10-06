import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { AgentStreamView } from "../AgentStreamView";
import type { AgentStreamItem } from "../types";

/**
 * [C7-web] Agent stream rendering: messages, tool calls, plan, changed files.
 *
 * Rendered through `react-dom/server` (no jsdom in this repository) — enough to prove what the DOM will
 * receive, which is what these assertions are about.
 */

const items: AgentStreamItem[] = [
  { kind: "message", role: "user", text: "fix the failing test in this project" },
  { kind: "message", role: "assistant", text: "I will read the test first." },
  {
    kind: "tool_call",
    toolCallId: "call-1",
    tool: "code.fs.read",
    toolVersion: 3,
    file: "src/sum.test.ts",
    status: "ok",
    result: "expect(sum(1, 2)).toBe(3)",
    durationMs: 12,
  },
  {
    kind: "tool_call",
    toolCallId: "call-2",
    tool: "code.shell.exec",
    command: "npm test -- --run",
    cwd: "/workspace",
    status: "failed",
    result: "1 test failed",
    truncated: true,
    errorCode: "command_failed",
  },
  { kind: "plan", title: "Fix the test", steps: [{ text: "read the test", done: true }, { text: "fix sum()" }] },
  {
    kind: "changed_files",
    files: [{ path: "src/sum.ts", status: "modified", additions: 2, deletions: 1, diff: "@@ -1 +1 @@\n-  return a - b;\n+  return a + b;" }],
  },
];

describe("[C7-web] agent stream", () => {
  it("renders user and assistant messages with their role", () => {
    const markup = renderToStaticMarkup(React.createElement(AgentStreamView, { items }));
    expect(markup).toContain("fix the failing test in this project");
    expect(markup).toContain("I will read the test first.");
    expect(markup).toContain('data-role="user"');
    expect(markup).toContain('data-role="assistant"');
  });

  it("renders each tool call as a collapsible element with file, command, cwd and result", () => {
    const markup = renderToStaticMarkup(React.createElement(AgentStreamView, { items }));
    expect(markup).toContain("<details");
    expect(markup).toContain("<summary");
    expect(markup).toContain('data-tool-call-id="call-1"');
    expect(markup).toContain('data-tool-call-id="call-2"');
    expect(markup).toContain("src/sum.test.ts");
    expect(markup).toContain("npm test -- --run");
    expect(markup).toContain("/workspace");
    expect(markup).toContain("1 test failed");
    expect(markup).toContain('data-status="failed"');
    expect(markup).toContain("command_failed");
  });

  it("marks a truncated tool result instead of hiding the fact", () => {
    const markup = renderToStaticMarkup(React.createElement(AgentStreamView, { items, isUk: true }));
    expect(markup).toContain("обрізано");
  });

  it("renders the plan/todo block with done and pending steps", () => {
    const markup = renderToStaticMarkup(React.createElement(AgentStreamView, { items }));
    expect(markup).toContain('data-kind="plan"');
    expect(markup).toContain("Fix the test");
    expect(markup).toContain("✓ read the test");
    expect(markup).toContain("• fix sum()");
  });

  it("renders changed files with diff statistics and the inline diff", () => {
    const markup = renderToStaticMarkup(React.createElement(AgentStreamView, { items }));
    expect(markup).toContain('data-file="src/sum.ts"');
    expect(markup).toContain("+2 −1");
    expect(markup).toContain("return a + b;");
  });

  it("renders an empty stream without throwing", () => {
    const markup = renderToStaticMarkup(React.createElement(AgentStreamView, { items: [] }));
    expect(markup).toContain("Agent stream");
  });
});
