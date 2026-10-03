import { describe, it, expect } from "vitest";
import {
  COMPONENT_REGISTRY,
  createDefaultWebsiteDocument,
  NextJsAdapter,
  ViteAdapter,
  getWebsiteAdapter,
  type WebsiteBlockType,
} from "@npati/shared";

describe("Website Builder Document Model & Adapters", () => {
  it("creates a valid default website document with Next.js", () => {
    const doc = createDefaultWebsiteDocument("CloudScale Hosting", "nextjs", {
      purpose: "Fast cloud hosting for businesses",
      primaryColor: "#2563eb",
    });

    expect(doc.version).toBe("1.0");
    expect(doc.name).toBe("CloudScale Hosting");
    expect(doc.framework).toBe("nextjs");
    expect(doc.theme.primaryColor).toBe("#2563eb");
    expect(doc.pages.length).toBeGreaterThanOrEqual(1);

    const homePage = doc.pages[0];
    expect(homePage.slug).toBe("/");
    expect(homePage.blocks.length).toBeGreaterThan(3);

    // Verify key blocks exist
    const blockTypes = homePage.blocks.map((b) => b.type);
    expect(blockTypes).toContain("navbar");
    expect(blockTypes).toContain("hero");
    expect(blockTypes).toContain("features");
    expect(blockTypes).toContain("pricing");
    expect(blockTypes).toContain("footer");

    const heroBlock = homePage.blocks.find((b) => b.type === "hero");
    expect(heroBlock?.props.title).toBe("CloudScale Hosting");
    expect(heroBlock?.props.subtitle).toBe("Fast cloud hosting for businesses");
  });

  it("contains all required components in the Component Registry", () => {
    const requiredTypes: WebsiteBlockType[] = [
      "navbar",
      "hero",
      "features",
      "pricing",
      "cta",
      "testimonials",
      "faq",
      "gallery",
      "stats",
      "team",
      "contact",
      "forms",
      "footer",
      "custom",
    ];

    for (const type of requiredTypes) {
      const def = COMPONENT_REGISTRY[type];
      expect(def, `Component definition for ${type} must exist`).toBeDefined();
      expect(def.type).toBe(type);
      expect(def.title).toBeTruthy();
      expect(def.defaultProps).toBeDefined();
      expect(def.defaultStyles).toBeDefined();
      expect(Array.isArray(def.propertySchema)).toBe(true);
      expect(def.propertySchema.length).toBeGreaterThan(0);
    }
  });

  it("scaffolds a complete Next.js App Router project using NextJsAdapter", () => {
    const doc = createDefaultWebsiteDocument("Apex Hosting", "nextjs");
    const adapter = new NextJsAdapter();
    const files = adapter.scaffoldProject(doc);

    // Verify critical Next.js files
    expect(files["package.json"]).toBeDefined();
    expect(files["package.json"]).toContain('"next":');
    expect(files["tsconfig.json"]).toBeDefined();
    expect(files["website.config.json"]).toBeDefined();
    expect(files["app/layout.tsx"]).toBeDefined();
    expect(files["app/globals.css"]).toBeDefined();
    expect(files["app/page.tsx"]).toBeDefined();
    expect(files["components/BlockRenderer.tsx"]).toBeDefined();

    // Verify single source of truth is embedded
    const parsedConfig = JSON.parse(files["website.config.json"]);
    expect(parsedConfig.name).toBe("Apex Hosting");
    expect(parsedConfig.theme.primaryColor).toBe(doc.theme.primaryColor);

    // Verify app/page.tsx consumes website.config.json and BlockRenderer
    expect(files["app/page.tsx"]).toContain('import websiteConfig from "../website.config.json"');
    expect(files["app/page.tsx"]).toContain("<BlockRenderer");
  });

  it("synchronizes document changes without destroying other files", () => {
    const doc = createDefaultWebsiteDocument("Apex Hosting", "nextjs");
    const adapter = new NextJsAdapter();
    const initialFiles = adapter.scaffoldProject(doc);

    // User modifies Hero title and theme color in visual builder
    const heroBlock = doc.pages[0].blocks.find((b) => b.type === "hero");
    if (heroBlock) {
      heroBlock.props.title = "Updated Hero Heading";
    }
    doc.theme.primaryColor = "#10b981";

    const synced = adapter.syncDocument(doc, initialFiles);

    // Verify website.config.json was updated
    const updatedConfig = JSON.parse(synced["website.config.json"]);
    const updatedHero = updatedConfig.pages[0].blocks.find((b: any) => b.type === "hero");
    expect(updatedHero.props.title).toBe("Updated Hero Heading");
    expect(updatedConfig.theme.primaryColor).toBe("#10b981");

    // Verify globals.css reflected the new primary color
    expect(synced["app/globals.css"]).toContain("--primary-color: #10b981;");

    // Verify other initial files like tsconfig.json remained untouched
    expect(synced["tsconfig.json"]).toBe(initialFiles["tsconfig.json"]);
  });

  it("generates safe, standalone HTML pages for a static hosting site", () => {
    const doc = createDefaultWebsiteDocument('Cloud <Host>', 'static', { template: 'hosting' });
    const adapter = getWebsiteAdapter('static');
    const files = adapter.scaffoldProject(doc);

    expect(adapter.framework).toBe('static');
    expect(files['package.json']).toBeUndefined();
    expect(files['index.html']).toContain('<html lang="uk">');
    expect(files['index.html']).toContain('id="pricing"');
    expect(files['index.html']).toContain('Cloud &lt;Host&gt;');
    expect(files['index.html']).not.toContain('<Host>');
    expect(files['pricing.html']).toContain('<html lang="uk">');
    doc.pages[0].blocks.find((block) => block.type === 'hero')!.props.title = 'Updated hosting site';
    expect(adapter.syncDocument(doc)['index.html']).toContain('Updated hosting site');
  });
  it("supports ViteAdapter via getWebsiteAdapter factory", () => {
    const nextAdapter = getWebsiteAdapter("nextjs");
    expect(nextAdapter.framework).toBe("nextjs");

    const viteAdapter = getWebsiteAdapter("vite");
    expect(viteAdapter.framework).toBe("vite");

    const doc = createDefaultWebsiteDocument("Vite App", "vite");
    const files = viteAdapter.scaffoldProject(doc);
    expect(files["package.json"]).toContain('"vite":');
  });
});
