import { NextJsAdapter, type WebsiteRendererAdapter } from "./website-renderer";
import type { WebsiteDocument } from "./website-schema";

export class ViteAdapter implements WebsiteRendererAdapter {
  readonly framework = "vite" as const;

  scaffoldProject(doc: WebsiteDocument): Record<string, string> {
    const nextAdapter = new NextJsAdapter();
    const files = nextAdapter.scaffoldProject(doc);
    // Vite package.json
    files["package.json"] = JSON.stringify(
      {
        name: doc.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "npati-vite-website",
        version: "0.1.0",
        private: true,
        scripts: {
          dev: "vite --host 0.0.0.0",
          build: "vite build",
          preview: "vite preview --host 0.0.0.0",
        },
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
        devDependencies: {
          "@vitejs/plugin-react": "^4.3.1",
          vite: "^5.4.2",
          typescript: "^5",
        },
      },
      null,
      2
    ) + "\n";
    return files;
  }

  syncDocument(doc: WebsiteDocument, existingFiles?: Record<string, string>): Record<string, string> {
    const nextAdapter = new NextJsAdapter();
    return nextAdapter.syncDocument(doc, existingFiles);
  }
}

export class AstroAdapter implements WebsiteRendererAdapter {
  readonly framework = "astro" as const;

  scaffoldProject(doc: WebsiteDocument): Record<string, string> {
    const nextAdapter = new NextJsAdapter();
    const files = nextAdapter.scaffoldProject(doc);
    files["package.json"] = JSON.stringify(
      {
        name: doc.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "npati-astro-website",
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          dev: "astro dev --host 0.0.0.0",
          start: "astro dev --host 0.0.0.0",
          build: "astro build",
          preview: "astro preview --host 0.0.0.0",
        },
        dependencies: {
          astro: "5.7.13",
        },
      },
      null,
      2
    ) + "\n";
    files["astro.config.mjs"] = `import { defineConfig } from "astro/config";\n\nexport default defineConfig({});\n`;
    files["src/pages/index.astro"] = `---
const title = "${doc.name}";
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{title}</title>
    <style>
      :root {
        --bg-color: #0b0f19;
        --card-bg: #151b2b;
        --text-color: #f8fafc;
        --muted-color: #94a3b8;
        --accent: #ff5d01;
      }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--bg-color);
        color: var(--text-color);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 2rem;
        box-sizing: border-box;
      }
      .card {
        background: var(--card-bg);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 16px;
        padding: 2.5rem;
        max-width: 600px;
        text-align: center;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
      }
      .pill {
        display: inline-block;
        padding: 4px 14px;
        border-radius: 999px;
        background: rgba(255, 93, 1, 0.15);
        color: var(--accent);
        font-weight: 600;
        font-size: 0.85rem;
        margin-bottom: 1.25rem;
        border: 1px solid rgba(255, 93, 1, 0.3);
      }
      h1 { margin: 0 0 1rem; font-size: 2.2rem; }
      p { color: var(--muted-color); font-size: 1.05rem; line-height: 1.6; margin: 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <span class="pill">🚀 Astro Framework</span>
      <h1>{title}</h1>
      <p>Performance-driven website built with Astro island architecture and live sandbox preview.</p>
    </div>
  </body>
</html>\n`;
    return files;
  }

  syncDocument(doc: WebsiteDocument, existingFiles?: Record<string, string>): Record<string, string> {
    const nextAdapter = new NextJsAdapter();
    return nextAdapter.syncDocument(doc, existingFiles);
  }
}
