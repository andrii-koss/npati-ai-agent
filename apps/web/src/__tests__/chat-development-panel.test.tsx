import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DevelopmentProcess } from "@npati/shared";
import { ChatDevelopmentPanel } from "../ChatDevelopmentPanel";
const process = (n: number, status: DevelopmentProcess["status"] = "running"): DevelopmentProcess => ({ id: "process-" + n, companyId: "company", projectId: "project-" + n, parentConversationId: "parent", name: "Website " + n, framework: "Next.js", status, hidden: false, createdAt: "", updatedAt: "" });
const props = { onOpen() {}, onStop() {}, onHide() {}, onBack() {} };
describe("chat development panel", () => {
  it("shows at most four processes with real running indicators and accessible actions", () => {
    const markup = renderToStaticMarkup(<ChatDevelopmentPanel {...props} processes={[1, 2, 3, 4, 5].map(n => process(n))} />);
    expect(markup.match(/class="chat-development-tile"/g)).toHaveLength(4);
    expect(markup.match(/class="chat-development-spinner"/g)).toHaveLength(4);
    expect(markup).toContain('aria-label="Hide from panel: Website 1"');
    expect(markup).toContain('aria-label="Edit in chat: Website 1"');
    expect(markup).toContain('aria-label="Stop: Website 1"');
  });
  it("replaces the selected project's spinner with the back button, even if hidden", () => {
    const current = { ...process(1), hidden: true };
    const markup = renderToStaticMarkup(<ChatDevelopmentPanel {...props} processes={[process(2, "completed"), process(3, "completed"), process(4, "completed"), process(5, "completed"), current]} projectId="project-1" />);
    expect(markup).toContain('aria-label="Back to main chat"');
    expect(markup).not.toContain('class="chat-development-spinner"');
    expect(markup).toContain('data-status="completed"');
    expect(markup).toContain("Ready");
  });
  it("hides removed tiles and renders project names as text", () => {
    const markup = renderToStaticMarkup(<ChatDevelopmentPanel {...props} processes={[{ ...process(1), hidden: true }, { ...process(2), name: '<img src=x onerror=alert(1)>' }]} />);
    expect(markup).not.toContain("Website 1");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<img");
  });
});
