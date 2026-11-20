import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { WebsiteProjectCard } from "../website-builder-card";
import { websiteBuilderCopy } from "../website-builder-constants";
import type { WebsiteProject } from "../website-builder-cache";
import type { ProductionStatus } from "../code-workspace/project-production";

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
    hasThumbnail: false,
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
    expect(markup).toContain("website-preview-viewport");
    expect(markup).not.toContain("height:180px");
    expect(markup).toContain("Код");
    expect(markup).toContain("Більше дій");
    expect(markup).toContain('aria-haspopup="menu"');

    // Excluded clutter: no description, no framework badge (Next.js/Vite), no status pill, no date
    expect(markup).not.toContain("Responsive shop with products and shopping cart");
    expect(markup).not.toContain("2026-10-18");
    expect(markup).not.toContain("Live Preview Status");
    expect(markup).not.toContain("company-run-card");
    expect(markup).not.toContain("website-card-production-dot");
  });

  it.each([
    ["running", "disabled", true],
    ["running", "pending", false],
    ["stopped", "disabled", false],
    ["unavailable", "issued", false],
  ] as const)("shows the production indicator for runtime %s and certificate %s", (runtime, certificate, healthy) => {
    const defaults = { cpu: 1, memoryMiB: 512, requestsPerSecond: 20, concurrency: 5, bodyMiB: 1, timeoutSeconds: 10 };
    const status: ProductionStatus = {
      enabled: true, automaticDomain: "site.localhost", localEnabled: true, tlsEnabled: true, defaults,
      release: {
        kind: "static", createdAt: dummyProject.updatedAt, url: "http://site.localhost:18080/", certificate, runtime,
        settings: { domain: "site.localhost", path: "/", port: 3000, stripPath: false, tls: false, entrypoint: "auto", limits: defaults },
      },
      job: null, logs: [], activity: [], traffic: { requests: 0, errors: 0, limited: 0, averageMs: 0 },
    };
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <WebsiteProjectCard site={dummyProject} companyId="comp-1" language="en" t={websiteBuilderCopy.en}
          drawerProductionStatus={status} handleDuplicate={() => {}} handleRename={() => {}} handleDelete={() => {}} />
      </MemoryRouter>
    );
    expect(markup).toContain(`class="website-card-production-dot" data-healthy="${healthy}"`);
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
    expect(markup).toContain('href="/settings/code/comp-1/proj-1?view=all"');
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
    expect(mobileMarkup).toContain('href="/settings/code/comp-1/proj-1?view=all"');
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
