import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { WebsiteProjectCard } from "../website-builder-card";
import { websiteBuilderCopy } from "../website-builder-constants";
import type { WebsiteProject } from "../website-builder-cache";

describe("WebsiteProjectCard", () => {
  const dummyProject: WebsiteProject = {
    id: "proj-1",
    companyId: "comp-1",
    name: "Інтернет-магазин",
    description: "Responsive shop with products and shopping cart",
    type: "website",
    status: "ready",
    framework: "HTML/CSS",
    revision: 1,
    updatedAt: "2026-10-18T10:00:00Z",
  };

  it("renders the project title and compact action buttons without technical badges or descriptions", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <WebsiteProjectCard
          site={dummyProject}
          companyId="comp-1"
          language="uk"
          t={websiteBuilderCopy.uk}
          handleDuplicate={() => {}}
          handleRename={() => {}}
          handleDelete={() => {}}
        />
      </MemoryRouter>
    );

    // Title is present
    expect(markup).toContain("Інтернет-магазин");

    // Preview viewport is rendered
    expect(markup).toContain("website-card-placeholder");
    expect(markup).not.toContain("<iframe");

    // "Edit in chat" button is present
    expect(markup).toContain("Редагувати в чаті");

    // Compact icon buttons: Open Preview and Code; Duplicate, Rename and Delete live in the "⋯" menu (website-builder-card-menu.test.tsx)
    expect(markup).toContain("Відкрити Preview");
    expect(markup).toContain("aspect-ratio:16 / 10");
    expect(markup).not.toContain("height:180px");
    expect(markup).toContain("Код");
    expect(markup).toContain("Більше дій");
    expect(markup).toContain('aria-haspopup="menu"');

    // Excluded clutter: no description, no framework badge (Next.js/Vite), no status pill, no date
    expect(markup).not.toContain("Responsive shop with products and shopping cart");
    expect(markup).not.toContain("2026-10-18");
    expect(markup).not.toContain("Live Preview Status");
    expect(markup).not.toContain("company-run-card");
  });

  it("renders English copy when language is en", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <WebsiteProjectCard
          site={{ ...dummyProject, name: "Travel Website" }}
          companyId="comp-1"
          language="en"
          t={websiteBuilderCopy.en}
          handleDuplicate={() => {}}
          handleRename={() => {}}
          handleDelete={() => {}}
        />
      </MemoryRouter>
    );

    expect(markup).toContain("Travel Website");
    expect(markup).toContain("Edit in chat");
    expect(markup).toContain("Open Live Preview");
    expect(markup).toContain("Code");
    expect(markup).toContain("More options");
    expect(markup).toContain("No preview yet");
    expect(markup).toContain("A preview will be available after the project is set up.");
    expect(markup).toContain('data-project-variant="website"');
    expect(markup).not.toContain("lucide-camera");
  });

  it("renders distinct SVG placeholder variants for mobile, game, and other projects", () => {
    const mobileMarkup = renderToStaticMarkup(
      <MemoryRouter>
        <WebsiteProjectCard
          site={{ ...dummyProject, type: "mobile_app", kind: "mobile_app", framework: "Expo" }}
          companyId="comp-1"
          language="en"
          t={websiteBuilderCopy.en}
          handleDuplicate={() => {}}
          handleRename={() => {}}
          handleDelete={() => {}}
        />
      </MemoryRouter>
    );
    expect(mobileMarkup).toContain('data-project-variant="mobile"');
    expect(mobileMarkup).toContain("Preview coming soon");
    expect(mobileMarkup).toContain("This project&#x27;s preview will appear here.");

    const gameMarkup = renderToStaticMarkup(
      <MemoryRouter>
        <WebsiteProjectCard
          site={{ ...dummyProject, kind: "game", framework: "HTML/CSS" }}
          companyId="comp-1"
          language="uk"
          t={websiteBuilderCopy.uk}
          handleDuplicate={() => {}}
          handleRename={() => {}}
          handleDelete={() => {}}
        />
      </MemoryRouter>
    );
    expect(gameMarkup).toContain('data-project-variant="game"');
    expect(gameMarkup).toContain("Превʼю ще немає");

    const apiMarkup = renderToStaticMarkup(
      <MemoryRouter>
        <WebsiteProjectCard
          site={{ ...dummyProject, type: "code_project", kind: "api", framework: "Node.js" }}
          companyId="comp-1"
          language="en"
          t={websiteBuilderCopy.en}
          handleDuplicate={() => {}}
          handleRename={() => {}}
          handleDelete={() => {}}
        />
      </MemoryRouter>
    );
    expect(apiMarkup).toContain('data-project-variant="other"');
  });
});
