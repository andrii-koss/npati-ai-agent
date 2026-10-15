import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyProjectIntent, extractFramework, HybridRouter, isMobileAppRequest } from "@npati/shared";

const specification = readFileSync(new URL("./fixtures/website-intent/novashop.uk.txt", import.meta.url), "utf8");

describe("website specification routing", () => {
  it.each([undefined, "existing-site"])("creates the requested store with project context %s", activeProjectId => {
    expect(classifyProjectIntent({ message: specification, activeProjectId })).toMatchObject({
      intent: "CREATE_WEBSITE", executable: true, needsClarification: false,
      targetDetails: { framework: "HTML/CSS", projectType: "website", topic: specification.trim() },
    });
  });

  it("keeps ancillary QA, repository and deployment steps inside a new website request", () => {
    expect(classifyProjectIntent("Create a new website for a shop.\n\nConnect repository, run tests, fix bugs, git commit and deploy the site.").intent).toBe("CREATE_WEBSITE");
    expect(classifyProjectIntent("Створи повноцінний, сучасний, багатосторінковий інтернет-магазин NovaShop.\n\nПротестуй сайт і виправ помилки.").intent).toBe("CREATE_WEBSITE");
  });

  it("does not interpret app.js or responsive smartphone support as a mobile app", () => {
    expect(isMobileAppRequest("Сайт для смартфонів, assets/js/app.js")).toBe(false);
    expect(isMobileAppRequest("Створи мобільний додаток на Expo")).toBe(true);
    expect(extractFramework(specification)).toBe("HTML/CSS");
    expect(extractFramework("Build a website with Next.js")).toBe("Next.js");
  });

  it("selects project work despite browser, URL and news content in the specification", () => {
    const decision = new HybridRouter().route({
      message: specification + "\nAdd latest news, a browser preview and https://example.com images.",
      resolutionContext: {
        auth: { workspaceId: "ws", userId: "owner", permissions: ["admin:all"] },
        activeContext: { contextType: "company", companyId: "company" },
      },
    });
    expect(decision.projectIntent).toBe("CREATE_WEBSITE");
    expect(decision.primaryDomain).toBe("files");
    expect(decision.matchedSignals).toContain("website_create");
    expect(decision.matchedSignals).not.toContain("crawl_action");
    expect(decision.matchedSignals).not.toContain("time_sensitive");
    expect(decision.matchedSignals).not.toContain("browser_action");
  });

  it("preserves existing-project edits and standalone preview/test requests", () => {
    expect(classifyProjectIntent({ message: "Create a contact form on this website", activeProjectId: "site" }).intent).toBe("EDIT_PROJECT");
    expect(classifyProjectIntent({ message: "Open preview", activeProjectId: "site" }).intent).toBe("PREVIEW_PROJECT");
    expect(classifyProjectIntent({ message: "Run tests", activeProjectId: "site" }).intent).toBe("TEST_PROJECT");
  });
});
