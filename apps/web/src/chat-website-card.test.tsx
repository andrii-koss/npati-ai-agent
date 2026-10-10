import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ProjectChatCard } from "./BusinessWorkspace";

describe("website chat card", () => {
  it("does not invent a build or offer an unavailable preview after a stopped code run", () => {
    const markup = renderToStaticMarkup(<MemoryRouter><ProjectChatCard card={{ id: "s", projectId: "p", companyId: "c", name: "Shop", status: "stopped", kind: "code_project", framework: "Next.js" }} /></MemoryRouter>);
    expect(markup).toContain("not run"); expect(markup).not.toContain(">ready<");
    expect(markup).toMatch(/disabled=""[^>]*>Preview/);
  });
  it.each(["website_project", "code_project"] as const)("offers Preview and chat editing for %s", kind => {
    const markup = renderToStaticMarkup(<MemoryRouter><ProjectChatCard card={{ id: "s", projectId: "p", companyId: "c", name: "Shop", status: "completed", kind, framework: "Next.js" }} /></MemoryRouter>);
    expect(markup).toContain(">Preview</button>"); expect(markup).toContain("Edit in chat");
    expect(markup).not.toContain("Builder"); expect(markup).not.toContain("Open Workspace");
  });
});
