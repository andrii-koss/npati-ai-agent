import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { CodeAgentsPage } from "./CodeAgentsPage";

vi.mock("./i18n", () => ({ useTranslation: () => ({ language: "en" }) }));
vi.mock("./CodeSettingsPage", () => ({
  CodeSettingsPage: () => <main>Existing project, session and flag settings</main>,
}));

function renderAt(path: string) {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><CodeAgentsPage /></MemoryRouter>);
}

describe("coding agent settings navigation", () => {
  it("opens the catalog first and links NPATI to its existing settings", () => {
    const markup = renderAt("/settings/code");
    expect(markup).toContain("Explore Agents");
    expect(markup).toContain("My Agents");
    expect(markup).toContain('href="/settings/code?agent=npati"');
    expect(markup).not.toContain("Existing project, session and flag settings");
    expect(markup).not.toContain("CONNECTED");
  });
  it("opens the existing settings through a direct agent link", () => {
    const markup = renderAt("/settings/code?agent=npati");
    expect(markup).toContain("Existing project, session and flag settings");
    expect(markup).not.toContain("Explore Agents");
  });
  it("keeps unknown agent links in the catalog", () => {
    expect(renderAt("/settings/code?agent=unknown")).toContain("Explore Agents");
  });
});

