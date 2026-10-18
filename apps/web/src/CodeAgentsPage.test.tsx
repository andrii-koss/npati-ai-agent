import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { CodeAgentsPage } from "./CodeAgentsPage";

vi.mock("./i18n", () => ({ useTranslation: () => ({ language: "en", t: () => "" }) }));
// vi.mock("./CodeSettingsPage", () => ({
//   CodeSettingsPage: () => <main>Existing project, session and flag settings</main>,
// }));

function renderAt(path: string) {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><CodeAgentsPage /></MemoryRouter>);
}

describe("coding agent settings navigation", () => {
  it("opens the catalog first and displays Npati Code with Manage action", () => {
    const markup = renderAt("/settings/code");
    expect(markup).toContain("Explore Agents");
    expect(markup).toContain("My Agents");
    expect(markup).toContain("Npati Code");
    expect(markup).toContain("Manage");
    expect(markup).toContain("DEFAULT");
    expect(markup).toContain("Set as default");
    expect(markup).toContain("Remove");
    expect(markup).toContain("/npati-auto.png");
    expect(markup).not.toContain("Code Task Execution");
    expect(markup).not.toContain("Existing project, session and flag settings");
    expect(markup).not.toContain("CONNECTED");
  });
  it("opens the existing settings through a direct agent link", () => {
    const markup = renderAt("/settings/code?agent=npati");
    expect(markup).toContain("Settings · Code");
    expect(markup).toContain("Npati Code");
    expect(markup).not.toContain("Explore Agents");
  });
  it("keeps unknown agent links in the catalog", () => {
    expect(renderAt("/settings/code?agent=unknown")).toContain("Explore Agents");
  });
  it("renders Built-in tab with 1 count when enabled by default", () => {
    const markup = renderAt("/settings/code");
    expect(markup).toContain("Built-in");
    expect(markup).toContain("<span>Built-in</span><small>1</small>");
  });
});

