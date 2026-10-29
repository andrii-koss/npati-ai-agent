import { minimalHtml, finalizeMinimalScaffold } from "./project-minimal-scaffold";
import { randomBytes } from "node:crypto";
import { canonicalFrameworkName, type SupportedProjectFramework } from "@npati/shared";

/**
 * Framework starters for chat-created code projects.
 *
 * The starter is deliberately complete enough to install, build and serve on its own. The Coding
 * Agent then applies the user's request to this workspace. Keeping the starters here (instead of
 * asking the model to scaffold) makes framework selection deterministic and gives build/preview a
 * known-good entry point.
 */
export interface FrameworkScaffoldInput {
  projectName: string;
  prompt: string;
  framework: string;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "npati-app";
}

function packageJson(name: string, scripts: Record<string, string>, dependencies: Record<string, string>, devDependencies: Record<string, string> = {}): string {
  return JSON.stringify({ name: slug(name), version: "0.1.0", private: true, scripts, dependencies, devDependencies }, null, 2) + "\n";
}

function htmlPage(title: string, _framework: string, _body: string, _script = ""): string { return minimalHtml(title); }
const commonBody = (_framework: string, _title: string) => "";
const counterScript = "";

function spaIndex(title: string, entry: string, id = "app"): string {
  return `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title></head>\n<body><div id="${id}"></div><script type="module" src="${entry}"></script></body>\n</html>\n`;
}

function withModuleType(manifest: string): string {
  const parsed = JSON.parse(manifest) as Record<string, unknown>;
  parsed.type = "module";
  return JSON.stringify(parsed, null, 2) + "\n";
}

function reactVite(name: string, framework: string): Record<string, string> {
  return {
    "package.json": withModuleType(packageJson(name, { dev: "vite --host 0.0.0.0", build: "vite build", preview: "vite preview --host 0.0.0.0", start: "vite preview --host 0.0.0.0" }, { react: "^18.3.1", "react-dom": "^18.3.1" }, { "@vitejs/plugin-react": "^4.3.4", vite: "^6.0.7" })),
    "vite.config.js": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n`,
    "index.html": spaIndex(name, "/src/main.jsx", "root"),
    "src/main.jsx": `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\nimport "./styles.css";\ncreateRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);\n`,
    "src/App.jsx": `import { useState } from "react";\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (<><header><strong>${name}</strong><nav><a href="#features">Features</a></nav></header><main><span className="badge">${framework}</span><h1>${name}</h1><p>A responsive starter created by the NPATI Coding Agent. It has a real production build and working browser interactions.</p><section className="card" id="features"><h2>Interactive demo</h2><p>Click the button to confirm that React state is running.</p><button onClick={() => setCount(count + 1)}>Click me</button><span className="count">{count}</span></section></main></>);\n}\n`,
    "src/styles.css": `:root{color-scheme:dark;--bg:#0b1020;--card:#151c33;--text:#f7f9ff;--muted:#a9b4d0;--accent:#6d8cff}*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:ui-sans-serif,system-ui,sans-serif;background:radial-gradient(circle at 20% 0%,#1d2a57 0,var(--bg) 55%);color:var(--text)}header{display:flex;justify-content:space-between;align-items:center;max-width:1060px;margin:0 auto;padding:24px}nav a{color:var(--muted);text-decoration:none;margin-left:18px}main{max-width:1060px;margin:0 auto;padding:56px 24px 80px}.badge{display:inline-block;padding:6px 14px;border:1px solid #3a4b80;border-radius:999px;color:#b9c7ff;font-size:13px}h1{font-size:clamp(38px,7vw,68px);line-height:1.03;margin:24px 0 18px;letter-spacing:-.04em}p{color:var(--muted);font-size:18px;line-height:1.65;max-width:650px}.card{background:var(--card);border:1px solid #273154;border-radius:22px;padding:28px;margin-top:38px}button{border:0;border-radius:12px;padding:12px 20px;background:var(--accent);color:white;font-weight:700;cursor:pointer}.count{font-size:34px;font-weight:800;margin-left:14px}\n`,
  };
}

function vueVite(name: string, framework: string): Record<string, string> {
  const index = spaIndex(name, "/src/main.js");
  return {
    "package.json": withModuleType(packageJson(name, { dev: "vite --host 0.0.0.0", build: "vite build", preview: "vite preview --host 0.0.0.0", start: "vite preview --host 0.0.0.0" }, { vue: "^3.5.13" }, { "@vitejs/plugin-vue": "^5.2.1", vite: "^6.0.7" })),
    "vite.config.js": `import { defineConfig } from "vite";\nimport vue from "@vitejs/plugin-vue";\nexport default defineConfig({ plugins: [vue()] });\n`,
    "index.html": index,
    "src/main.js": `import { createApp } from "vue";\nimport App from "./App.vue";\nimport "./styles.css";\ncreateApp(App).mount("#app");\n`,
    "src/App.vue": `<script setup>\nimport { ref } from "vue";\nconst count = ref(0);\n</script>\n<template>\n  <header><strong>${name}</strong><nav><a href="#features">Features</a></nav></header>\n  <main>\n    <span class="badge">${framework}</span>\n    <h1>${name}</h1>\n    <p>A responsive starter created by the NPATI Coding Agent. It has a real production build and working browser interactions.</p>\n    <section class="card" id="features"><h2>Interactive demo</h2><p>Click the button to confirm that Vue reactivity is running.</p><button @click="count++">Click me</button><span class="count">{{ count }}</span></section>\n  </main>\n</template>\n`,
    "src/styles.css": `:root{color-scheme:dark;--bg:#0b1020;--card:#151c33;--text:#f7f9ff;--muted:#a9b4d0;--accent:#6d8cff}*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:ui-sans-serif,system-ui,sans-serif;background:radial-gradient(circle at 20% 0%,#1d2a57 0,var(--bg) 55%);color:var(--text)}header{display:flex;justify-content:space-between;align-items:center;max-width:1060px;margin:0 auto;padding:24px}nav a{color:var(--muted);text-decoration:none;margin-left:18px}main{max-width:1060px;margin:0 auto;padding:56px 24px 80px}.badge{display:inline-block;padding:6px 14px;border:1px solid #3a4b80;border-radius:999px;color:#b9c7ff;font-size:13px}h1{font-size:clamp(38px,7vw,68px);line-height:1.03;margin:24px 0 18px;letter-spacing:-.04em}p{color:var(--muted);font-size:18px;line-height:1.65;max-width:650px}.card{background:var(--card);border:1px solid #273154;border-radius:22px;padding:28px;margin-top:38px}button{border:0;border-radius:12px;padding:12px 20px;background:var(--accent);color:white;font-weight:700;cursor:pointer}.count{font-size:34px;font-weight:800;margin-left:14px}\n`,
  };
}

function nuxt(name: string, framework: string): Record<string, string> {
  return {
    "package.json": withModuleType(packageJson(name, { dev: "nuxt dev --host 0.0.0.0", build: "nuxt build", start: "node .output/server/index.mjs" }, { nuxt: "3.17.7" })),
    "nuxt.config.ts": `export default defineNuxtConfig({\n  ssr: true,\n  devtools: { enabled: false },\n  app: { head: { title: ${JSON.stringify(name)}, htmlAttrs: { lang: "en" } } },\n});\n`,
    "app.vue": `<template><NuxtPage /></template>\n`,
    "pages/index.vue": `<script setup>\nimport { ref } from "vue";\nconst count = ref(0);\n</script>\n<template>\n  <div>\n    <header><strong>${name}</strong><nav><a href="#features">Features</a></nav></header>\n    <main><span class="badge">${framework} · SSR</span><h1>${name}</h1><p>A server-rendered starter created by the NPATI Coding Agent. It has a real production build and working browser interactions.</p><section class="card" id="features"><h2>Interactive demo</h2><p>Click the button to confirm that Vue hydration is running.</p><button @click="count++">Click me</button><span class="count">{{ count }}</span></section></main>\n  </div>\n</template>\n<style>\n:root{color-scheme:dark;--bg:#0b1020;--card:#151c33;--text:#f7f9ff;--muted:#a9b4d0;--accent:#6d8cff}*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:ui-sans-serif,system-ui,sans-serif;background:radial-gradient(circle at 20% 0%,#1d2a57 0,var(--bg) 55%);color:var(--text)}header{display:flex;justify-content:space-between;align-items:center;max-width:1060px;margin:0 auto;padding:24px}nav a{color:var(--muted);text-decoration:none;margin-left:18px}main{max-width:1060px;margin:0 auto;padding:56px 24px 80px}.badge{display:inline-block;padding:6px 14px;border:1px solid #3a4b80;border-radius:999px;color:#b9c7ff;font-size:13px}h1{font-size:clamp(38px,7vw,68px);line-height:1.03;margin:24px 0 18px;letter-spacing:-.04em}p{color:var(--muted);font-size:18px;line-height:1.65;max-width:650px}.card{background:var(--card);border:1px solid #273154;border-radius:22px;padding:28px;margin-top:38px}button{border:0;border-radius:12px;padding:12px 20px;background:var(--accent);color:white;font-weight:700;cursor:pointer}.count{font-size:34px;font-weight:800;margin-left:14px}\n</style>\n`,
    "server/api/health.get.ts": `export default defineEventHandler(() => ({ status: "ok", framework: "Nuxt" }));\n`,
  };
}

function svelteKit(name: string, framework: string): Record<string, string> {
  return {
    "package.json": withModuleType(packageJson(name, { dev: "vite dev --host 0.0.0.0", build: "vite build", start: "node build/index.js" }, { "@sveltejs/kit": "^2.15.1", svelte: "^5.16.0" }, { "@sveltejs/adapter-node": "^5.2.11", "@sveltejs/vite-plugin-svelte": "^5.0.3", vite: "^6.0.7" })),
    "svelte.config.js": `import adapter from "@sveltejs/adapter-node";\nexport default { kit: { adapter: adapter() } };\n`,
    "vite.config.js": `import { sveltekit } from "@sveltejs/kit/vite";\nimport { defineConfig } from "vite";\nexport default defineConfig({ plugins: [sveltekit()] });\n`,
    "src/app.html": `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />%sveltekit.head%</head>\n<body data-sveltekit-preload-data="hover"><div style="display:contents">%sveltekit.body%</div></body>\n</html>\n`,
    "src/routes/+page.svelte": `<svelte:head><title>${name}</title></svelte:head>\n<script>\nlet count = 0;\n</script>\n<header><strong>${name}</strong><nav><a href="#features">Features</a></nav></header>\n<main><span class="badge">${framework} · SSR</span><h1>${name}</h1><p>A server-rendered starter created by the NPATI Coding Agent. It has a real production build and working browser interactions.</p><section class="card" id="features"><h2>Interactive demo</h2><p>Click the button to confirm that Svelte reactivity is running.</p><button onclick={() => count += 1}>Click me</button><span class="count">{count}</span></section></main>\n<style>\n:root{color-scheme:dark;--bg:#0b1020;--card:#151c33;--text:#f7f9ff;--muted:#a9b4d0;--accent:#6d8cff}*{box-sizing:border-box}:global(body){margin:0;min-height:100vh;font-family:ui-sans-serif,system-ui,sans-serif;background:radial-gradient(circle at 20% 0%,#1d2a57 0,var(--bg) 55%);color:var(--text)}header{display:flex;justify-content:space-between;align-items:center;max-width:1060px;margin:0 auto;padding:24px}nav a{color:var(--muted);text-decoration:none;margin-left:18px}main{max-width:1060px;margin:0 auto;padding:56px 24px 80px}.badge{display:inline-block;padding:6px 14px;border:1px solid #3a4b80;border-radius:999px;color:#b9c7ff;font-size:13px}h1{font-size:clamp(38px,7vw,68px);line-height:1.03;margin:24px 0 18px;letter-spacing:-.04em}p{color:var(--muted);font-size:18px;line-height:1.65;max-width:650px}.card{background:var(--card);border:1px solid #273154;border-radius:22px;padding:28px;margin-top:38px}button{border:0;border-radius:12px;padding:12px 20px;background:var(--accent);color:white;font-weight:700;cursor:pointer}.count{font-size:34px;font-weight:800;margin-left:14px}\n</style>\n`,
    "src/routes/health/+server.js": `import { json } from "@sveltejs/kit";\nexport function GET() { return json({ status: "ok", framework: "SvelteKit" }); }\n`,
  };
}

function astro(name: string, framework: string): Record<string, string> {
  return {
    "package.json": withModuleType(packageJson(name, { dev: "astro dev --host 0.0.0.0", build: "astro build", preview: "astro preview --host 0.0.0.0", start: "astro preview --host 0.0.0.0" }, { astro: "5.7.13" })),
    "astro.config.mjs": `import { defineConfig } from "astro/config";\nexport default defineConfig({ output: "static" });\n`,
    "src/pages/index.astro": `---\nconst title = ${JSON.stringify(name)};\n---\n<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>{title}</title></head><body><header><strong>{title}</strong><nav><a href="#features">Features</a></nav></header><main><span class="badge">${framework} · Static</span><h1>{title}</h1><p>A statically generated starter created by the NPATI Coding Agent. It has a real production build and working browser interactions.</p><section class="card" id="features"><h2>Interactive demo</h2><p>Click the button to confirm that the Astro island script is running.</p><button id="counter">Click me</button><span class="count" id="count">0</span></section></main><script>${counterScript}</script></body></html>\n<style is:global>\n:root{color-scheme:dark;--bg:#0b1020;--card:#151c33;--text:#f7f9ff;--muted:#a9b4d0;--accent:#6d8cff}*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:ui-sans-serif,system-ui,sans-serif;background:radial-gradient(circle at 20% 0%,#1d2a57 0,var(--bg) 55%);color:var(--text)}header{display:flex;justify-content:space-between;align-items:center;max-width:1060px;margin:0 auto;padding:24px}nav a{color:var(--muted);text-decoration:none;margin-left:18px}main{max-width:1060px;margin:0 auto;padding:56px 24px 80px}.badge{display:inline-block;padding:6px 14px;border:1px solid #3a4b80;border-radius:999px;color:#b9c7ff;font-size:13px}h1{font-size:clamp(38px,7vw,68px);line-height:1.03;margin:24px 0 18px;letter-spacing:-.04em}p{color:var(--muted);font-size:18px;line-height:1.65;max-width:650px}.card{background:var(--card);border:1px solid #273154;border-radius:22px;padding:28px;margin-top:38px}button{border:0;border-radius:12px;padding:12px 20px;background:var(--accent);color:white;font-weight:700;cursor:pointer}.count{font-size:34px;font-weight:800;margin-left:14px}\n</style>\n`,
    "src/pages/health.json.ts": `export const prerender = true;\nexport function GET() {\n  return new Response(JSON.stringify({ status: "ok", framework: "Astro" }), { headers: { "content-type": "application/json" } });\n}\n`,
  };
}

function angular(name: string, framework: string): Record<string, string> {
  const app = slug(name);
  return {
    "package.json": packageJson(name, { build: "ng build", start: `serve -s dist/${app}/browser -l 3000` }, { "@angular/animations": "^19.2.0", "@angular/common": "^19.2.0", "@angular/compiler": "^19.2.0", "@angular/core": "^19.2.0", "@angular/forms": "^19.2.0", "@angular/platform-browser": "^19.2.0", "@angular/platform-browser-dynamic": "^19.2.0", rxjs: "~7.8.1", tslib: "^2.8.1", "zone.js": "~0.15.0" }, { "@angular-devkit/build-angular": "^19.2.0", "@angular/cli": "^19.2.0", "@angular/compiler-cli": "^19.2.0", serve: "^14.2.4", typescript: "~5.6.3" }),
    "angular.json": JSON.stringify({ version: 1, projects: { [app]: { projectType: "application", root: "", sourceRoot: "src", architect: { build: { builder: "@angular-devkit/build-angular:application", options: { outputPath: `dist/${app}`, index: "src/index.html", browser: "src/main.ts", polyfills: ["zone.js"], tsConfig: "tsconfig.app.json", assets: [], styles: ["src/styles.css"] }, configurations: { production: { budgets: [{ type: "initial", maximumWarning: "2mb", maximumError: "5mb" }], outputHashing: "all" } }, defaultConfiguration: "production" }, serve: { builder: "@angular-devkit/build-angular:dev-server", configurations: { production: { buildTarget: `${app}:build:production` } } } } } }, newline: "\n", cli: { analytics: false } }, null, 2) + "\n",
    "tsconfig.json": JSON.stringify({ compileOnSave: false, compilerOptions: { strict: true, noImplicitOverride: true, noPropertyAccessFromIndexSignature: true, noImplicitReturns: true, noFallthroughCasesInSwitch: true, skipLibCheck: true, esModuleInterop: true, experimentalDecorators: true, moduleResolution: "bundler", importHelpers: true, target: "ES2022", module: "ES2022", lib: ["ES2022", "dom"] }, angularCompilerOptions: { enableI18nLegacyMessageIdFormat: false, strictInjectionParameters: true, strictInputAccessModifiers: true, strictTemplates: true } }, null, 2) + "\n",
    "tsconfig.app.json": JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { outDir: "./out-tsc/app", types: [] }, files: ["src/main.ts"], include: ["src/**/*.d.ts"] }, null, 2) + "\n",
    "src/index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${name}</title><base href="/" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><app-root></app-root></body></html>\n`,
    "src/main.ts": `import { bootstrapApplication } from "@angular/platform-browser";\nimport { AppComponent } from "./app/app.component";\nbootstrapApplication(AppComponent).catch((err) => console.error(err));\n`,
    "src/app/app.component.ts": `import { Component } from "@angular/core";\n@Component({\n  selector: "app-root",\n  standalone: true,\n  template: \`<header><strong>${name}</strong><nav><a href="#features">Features</a></nav></header><main><span class="badge">${framework}</span><h1>${name}</h1><p>A responsive starter created by the NPATI Coding Agent. It has a real production build and working browser interactions.</p><section class="card" id="features"><h2>Interactive demo</h2><p>Click the button to confirm that Angular change detection is running.</p><button (click)="increment()">Click me</button><span class="count">{{ count }}</span></section></main>\`,\n})\nexport class AppComponent {\n  count = 0;\n  increment() { this.count += 1; }\n}\n`,
    "src/styles.css": `:root{color-scheme:dark;--bg:#0b1020;--card:#151c33;--text:#f7f9ff;--muted:#a9b4d0;--accent:#6d8cff}*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:ui-sans-serif,system-ui,sans-serif;background:radial-gradient(circle at 20% 0%,#1d2a57 0,var(--bg) 55%);color:var(--text)}header{display:flex;justify-content:space-between;align-items:center;max-width:1060px;margin:0 auto;padding:24px}nav a{color:var(--muted);text-decoration:none;margin-left:18px}main{max-width:1060px;margin:0 auto;padding:56px 24px 80px}.badge{display:inline-block;padding:6px 14px;border:1px solid #3a4b80;border-radius:999px;color:#b9c7ff;font-size:13px}h1{font-size:clamp(38px,7vw,68px);line-height:1.03;margin:24px 0 18px;letter-spacing:-.04em}p{color:var(--muted);font-size:18px;line-height:1.65;max-width:650px}.card{background:var(--card);border:1px solid #273154;border-radius:22px;padding:28px;margin-top:38px}button{border:0;border-radius:12px;padding:12px 20px;background:var(--accent);color:white;font-weight:700;cursor:pointer}.count{font-size:34px;font-weight:800;margin-left:14px}\n`,
  };
}

function remix(name: string, framework: string): Record<string, string> {
  return {
    "package.json": withModuleType(packageJson(name, { dev: "react-router dev", build: "react-router build", start: "react-router-serve ./build/server/index.js" }, { "@react-router/node": "^7.5.0", "@react-router/serve": "^7.5.0", react: "^19.0.0", "react-dom": "^19.0.0", "react-router": "^7.5.0", isbot: "^5.1.0" }, { "@react-router/dev": "^7.5.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", typescript: "^5.7.2", vite: "^6.0.7", "vite-tsconfig-paths": "^5.1.4" })),
    "react-router.config.ts": `import type { Config } from "@react-router/dev/config";\nexport default { ssr: true } satisfies Config;\n`,
    "vite.config.ts": `import { reactRouter } from "@react-router/dev/vite";\nimport { defineConfig } from "vite";\nimport tsconfigPaths from "vite-tsconfig-paths";\nexport default defineConfig({ plugins: [reactRouter(), tsconfigPaths()] });\n`,
    "tsconfig.json": JSON.stringify({ include: ["**/*.ts", "**/*.tsx", ".react-router/types/**/*"], compilerOptions: { lib: ["DOM", "DOM.Iterable", "ES2022"], types: ["node", "@react-router/node"], target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, skipLibCheck: true, esModuleInterop: true, resolveJsonModule: true, baseUrl: ".", paths: { "~/*": ["./app/*"] }, noEmit: true } }, null, 2) + "\n",
    "app/root.tsx": `import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";\nimport type { Route } from "./+types/root";\nimport "./app.css";\nexport function Layout({ children }: { children: React.ReactNode }) { return (<html lang="en"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><Meta /><Links /></head><body>{children}<ScrollRestoration /><Scripts /></body></html>); }\nexport default function App() { return <Outlet />; }\nexport function ErrorBoundary({ error }: Route.ErrorBoundaryProps) { return <main><h1>Application error</h1><pre>{String(error)}</pre></main>; }\n`,
    "app/routes.ts": `import { type RouteConfig, index } from "@react-router/dev/routes";\nexport default [index("routes/home.tsx")] satisfies RouteConfig;\n`,
    "app/routes/home.tsx": `import { useState } from "react";\nexport default function Home() {\n  const [count, setCount] = useState(0);\n  return (<><header><strong>${name}</strong><nav><a href="#features">Features</a></nav></header><main><span className="badge">${framework} · SSR</span><h1>${name}</h1><p>A server-rendered starter created by the NPATI Coding Agent. It has a real production build and working browser interactions.</p><section className="card" id="features"><h2>Interactive demo</h2><p>Click the button to confirm that React hydration is running.</p><button onClick={() => setCount(count + 1)}>Click me</button><span className="count">{count}</span></section></main></>);\n}\n`,
    "app/app.css": `:root{color-scheme:dark;--bg:#0b1020;--card:#151c33;--text:#f7f9ff;--muted:#a9b4d0;--accent:#6d8cff}*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:ui-sans-serif,system-ui,sans-serif;background:radial-gradient(circle at 20% 0%,#1d2a57 0,var(--bg) 55%);color:var(--text)}header{display:flex;justify-content:space-between;align-items:center;max-width:1060px;margin:0 auto;padding:24px}nav a{color:var(--muted);text-decoration:none;margin-left:18px}main{max-width:1060px;margin:0 auto;padding:56px 24px 80px}.badge{display:inline-block;padding:6px 14px;border:1px solid #3a4b80;border-radius:999px;color:#b9c7ff;font-size:13px}h1{font-size:clamp(38px,7vw,68px);line-height:1.03;margin:24px 0 18px;letter-spacing:-.04em}p{color:var(--muted);font-size:18px;line-height:1.65;max-width:650px}.card{background:var(--card);border:1px solid #273154;border-radius:22px;padding:28px;margin-top:38px}button{border:0;border-radius:12px;padding:12px 20px;background:var(--accent);color:white;font-weight:700;cursor:pointer}.count{font-size:34px;font-weight:800;margin-left:14px}\n`,
  };
}

function expressApp(name: string, framework: string): Record<string, string> {
  return {
    "package.json": packageJson(name, { build: "tsc -p tsconfig.json", start: "node dist/server.js" }, { express: "^4.21.2" }, { "@types/express": "^5.0.0", "@types/node": "^22.10.5", typescript: "^5.7.2" }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", outDir: "dist", rootDir: "src", strict: true, esModuleInterop: true, skipLibCheck: true, forceConsistentCasingInFileNames: true }, include: ["src/**/*.ts"] }, null, 2) + "\n",
    "src/server.ts": `import express from "express";\nconst app = express();\nconst port = Number(process.env.PORT || 3000);\nconst page = ${JSON.stringify(htmlPage(name, framework, commonBody(framework, name), counterScript))};\napp.get("/", (_req, res) => res.type("html").send(page));\napp.get("/health", (_req, res) => res.json({ status: "ok", framework: "Express" }));\napp.get("/api/info", (_req, res) => res.json({ name: ${JSON.stringify(name)}, framework: "Express" }));\napp.listen(port, "0.0.0.0");\n`,
    "Makefile": `build:\n\tnpm run build\n`,
  };
}

function fastifyApp(name: string, framework: string): Record<string, string> {
  return {
    "package.json": withModuleType(packageJson(name, { build: "tsc -p tsconfig.json", start: "node dist/server.js" }, { fastify: "^5.2.1" }, { "@types/node": "^22.10.5", typescript: "^5.7.2" })),
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", outDir: "dist", rootDir: "src", strict: true, esModuleInterop: true, skipLibCheck: true }, include: ["src/**/*.ts"] }, null, 2) + "\n",
    "index.html": htmlPage(name, framework, commonBody(framework, name), counterScript),
    "src/server.ts": `import { readFile } from "node:fs/promises";\nimport Fastify from "fastify";\nconst app = Fastify({ logger: false });\nconst port = Number(process.env.PORT || 3000);\nconst page = await readFile(new URL("../index.html", import.meta.url), "utf8");\napp.get("/", async (_req, reply) => reply.type("text/html").send(page));\napp.get("/health", async () => ({ status: "ok", framework: "Fastify" }));\napp.get("/api/info", async () => ({ name: ${JSON.stringify(name)}, framework: "Fastify" }));\nawait app.listen({ port, host: "0.0.0.0" });\n`,
  };
}

function nestApp(name: string, framework: string): Record<string, string> {
  const page = htmlPage(name, framework, commonBody(framework, name), counterScript);
  return {
    "package.json": packageJson(name, { build: "nest build", start: "node dist/main.js" }, { "@nestjs/common": "^11.0.5", "@nestjs/core": "^11.0.5", "@nestjs/platform-express": "^11.0.5", "reflect-metadata": "^0.2.2", rxjs: "^7.8.1" }, { "@nestjs/cli": "^11.0.2", "@nestjs/schematics": "^11.0.0", "@types/express": "^5.0.0", "@types/node": "^22.10.5", typescript: "^5.7.2" }),
    "nest-cli.json": JSON.stringify({ collection: "@nestjs/schematics", sourceRoot: "src" }, null, 2) + "\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { module: "commonjs", declaration: false, removeComments: true, emitDecoratorMetadata: true, experimentalDecorators: true, allowSyntheticDefaultImports: true, target: "ES2022", sourceMap: false, outDir: "./dist", baseUrl: "./", incremental: true, skipLibCheck: true, strict: true, strictPropertyInitialization: false }, include: ["src/**/*.ts"] }, null, 2) + "\n",
    "src/main.ts": `import "reflect-metadata";\nimport { NestFactory } from "@nestjs/core";\nimport { AppModule } from "./app.module";\nasync function bootstrap() { const app = await NestFactory.create(AppModule); await app.listen(Number(process.env.PORT || 3000), "0.0.0.0"); }\nvoid bootstrap();\n`,
    "src/app.module.ts": `import { Module } from "@nestjs/common";\nimport { AppController } from "./app.controller";\n@Module({ controllers: [AppController] })\nexport class AppModule {}\n`,
    "src/app.controller.ts": `import { Controller, Get, Header } from "@nestjs/common";\nconst page = ${JSON.stringify(page)};\n@Controller()\nexport class AppController {\n  @Get()\n  @Header("content-type", "text/html; charset=utf-8")\n  home() { return page; }\n  @Get("health")\n  health() { return { status: "ok", framework: "NestJS" }; }\n  @Get("api/info")\n  info() { return { name: ${JSON.stringify(name)}, framework: "NestJS" }; }\n}\n`,
  };
}

function fastApi(name: string, framework: string): Record<string, string> {
  const page = htmlPage(name, framework, commonBody(framework, name), counterScript);
  return {
    "requirements.txt": "fastapi>=0.115,<1\nuvicorn[standard]>=0.34,<1\n",
    "main.py": `from fastapi import FastAPI\nfrom fastapi.responses import HTMLResponse, JSONResponse\n\napp = FastAPI(title=${JSON.stringify(name)})\nPAGE = ${JSON.stringify(page)}\n\n@app.get("/", response_class=HTMLResponse)\ndef home() -> str:\n    return PAGE\n\n@app.get("/health")\ndef health() -> JSONResponse:\n    return JSONResponse({"status": "ok", "framework": "FastAPI"})\n\n@app.get("/api/info")\ndef info() -> JSONResponse:\n    return JSONResponse({"name": ${JSON.stringify(name)}, "framework": "FastAPI"})\n`,
    "Makefile": `.PHONY: build\nbuild:\n\tpython3 -m compileall -q main.py\n`,
  };
}

function django(name: string, framework: string): Record<string, string> {
  const page = htmlPage(name, framework, commonBody(framework, name), counterScript);
  return {
    "requirements.txt": "Django>=5.1,<6\n",
    "manage.py": `#!/usr/bin/env python\nimport os, sys\nif __name__ == "__main__":\n    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")\n    from django.core.management import execute_from_command_line\n    execute_from_command_line(sys.argv)\n`,
    "config/__init__.py": "",
    "config/settings.py": `import os\nimport secrets\nfrom pathlib import Path\nBASE_DIR = Path(__file__).resolve().parent.parent\nSECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or secrets.token_urlsafe(48)\nDEBUG = True\nALLOWED_HOSTS = ["*"]\nROOT_URLCONF = "config.urls"\nINSTALLED_APPS = ["django.contrib.contenttypes", "django.contrib.staticfiles", "web"]\nMIDDLEWARE = ["django.middleware.security.SecurityMiddleware", "django.middleware.common.CommonMiddleware"]\nTEMPLATES = [{"BACKEND": "django.template.backends.django.DjangoTemplates", "DIRS": [], "APP_DIRS": True, "OPTIONS": {"context_processors": []}}]\nWSGI_APPLICATION = "config.wsgi.application"\nDATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3"}}\nLANGUAGE_CODE = "en-us"\nTIME_ZONE = "UTC"\nUSE_I18N = True\nUSE_TZ = True\nSTATIC_URL = "static/"\nDEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"\n`,
    "config/urls.py": `from django.urls import path\nfrom web.views import home, health\nurlpatterns = [path("", home), path("health", health)]\n`,
    "config/wsgi.py": `import os\nfrom django.core.wsgi import get_wsgi_application\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")\napplication = get_wsgi_application()\n`,
    "web/__init__.py": "",
    "web/views.py": `from django.http import HttpResponse, JsonResponse\nPAGE = ${JSON.stringify(page)}\ndef home(request): return HttpResponse(PAGE)\ndef health(request): return JsonResponse({"status": "ok", "framework": "Django"})\n`,
    "Makefile": `.PHONY: build\nbuild:\n\t.venv/bin/python manage.py check\n`,
  };
}

function flask(name: string, framework: string): Record<string, string> {
  const page = htmlPage(name, framework, commonBody(framework, name), counterScript);
  return {
    "requirements.txt": "Flask>=3.1,<4\n",
    "app.py": `import os\nfrom flask import Flask, Response, jsonify\n\napp = Flask(__name__)\nPAGE = ${JSON.stringify(page)}\n\n@app.get("/")\ndef home():\n    return Response(PAGE, mimetype="text/html")\n\n@app.get("/health")\ndef health():\n    return jsonify({"status": "ok", "framework": "Flask"})\n\n@app.get("/api/info")\ndef info():\n    return jsonify({"name": ${JSON.stringify(name)}, "framework": "Flask"})\n\nif __name__ == "__main__":\n    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "3000")))\n`,
    "Makefile": `.PHONY: build\nbuild:\n\t.venv/bin/python -m compileall -q app.py\n`,
  };
}

function laravel(name: string, framework: string): Record<string, string> {
  const page = htmlPage(name, framework, commonBody(framework, name), counterScript);
  const key = randomBytes(32).toString("base64");
  return {
    "composer.json": JSON.stringify({ name: "npati/laravel-app", type: "project", require: { php: "^8.3", "laravel/framework": "^13.0" }, autoload: { "psr-4": { "App\\": "app/", "Database\\Factories\\": "database/factories/", "Database\\Seeders\\": "database/seeders/" } }, scripts: { "post-autoload-dump": ["@php artisan package:discover --ansi"] }, config: { platform: { php: "8.3.0" }, "optimize-autoloader": true, "preferred-install": "dist", "sort-packages": true }, "minimum-stability": "stable", "prefer-stable": true }, null, 2) + "\n",
    ".env": `APP_NAME=${JSON.stringify(name)}\nAPP_ENV=production\nAPP_KEY=base64:${key}\nAPP_DEBUG=false\nAPP_URL=http://localhost\nSESSION_DRIVER=file\nCACHE_STORE=file\nLOG_CHANNEL=single\n`,
    "artisan": `#!/usr/bin/env php\n<?php\ndefine('LARAVEL_START', microtime(true));\nrequire __DIR__.'/vendor/autoload.php';\n$app = require_once __DIR__.'/bootstrap/app.php';\n$status = $app->handleCommand(new Symfony\\Component\\Console\\Input\\ArgvInput);\nexit($status);\n`,
    "bootstrap/app.php": `<?php\nuse Illuminate\\Foundation\\Application;\nuse Illuminate\\Foundation\\Configuration\\Exceptions;\nuse Illuminate\\Foundation\\Configuration\\Middleware;\nreturn Application::configure(basePath: dirname(__DIR__))\n    ->withRouting(web: __DIR__.'/../routes/web.php', commands: __DIR__.'/../routes/console.php', health: '/up')\n    ->withMiddleware(function (Middleware $middleware) {})\n    ->withExceptions(function (Exceptions $exceptions) {})\n    ->create();\n`,
    "bootstrap/providers.php": `<?php\nreturn [App\\Providers\\AppServiceProvider::class];\n`,
    "app/Providers/AppServiceProvider.php": `<?php\nnamespace App\\Providers;\nuse Illuminate\\Support\\ServiceProvider;\nclass AppServiceProvider extends ServiceProvider\n{\n    public function register(): void {}\n    public function boot(): void {}\n}\n`,
    "public/index.php": `<?php\nuse Illuminate\\Http\\Request;\ndefine('LARAVEL_START', microtime(true));\nrequire __DIR__.'/../vendor/autoload.php';\n(require_once __DIR__.'/../bootstrap/app.php')->handleRequest(Request::capture());\n`,
    "routes/web.php": `<?php\nuse Illuminate\\Support\\Facades\\Route;\nRoute::get('/', function () { return view('welcome'); });\nRoute::get('/health', function () { return response()->json(['status' => 'ok', 'framework' => 'Laravel']); });\n`,
    "routes/console.php": `<?php\n`,
    "resources/views/welcome.blade.php": page,
    "config/app.php": `<?php\nreturn ['name' => env('APP_NAME', 'NPATI'), 'env' => env('APP_ENV', 'production'), 'debug' => (bool) env('APP_DEBUG', false), 'url' => env('APP_URL', 'http://localhost'), 'timezone' => 'UTC', 'locale' => 'en', 'fallback_locale' => 'en', 'faker_locale' => 'en_US', 'cipher' => 'AES-256-CBC', 'key' => env('APP_KEY'), 'previous_keys' => []];\n`,
    "config/session.php": `<?php\nreturn ['driver' => env('SESSION_DRIVER', 'file'), 'lifetime' => 120, 'expire_on_close' => false, 'encrypt' => false, 'files' => storage_path('framework/sessions'), 'connection' => null, 'table' => 'sessions', 'store' => null, 'lottery' => [2, 100], 'cookie' => 'npati_session', 'path' => '/', 'domain' => null, 'secure' => false, 'http_only' => true, 'same_site' => 'lax'];\n`,
    "config/view.php": `<?php\nreturn ['paths' => [resource_path('views')], 'compiled' => storage_path('framework/views')];\n`,
    "config/logging.php": `<?php\nreturn ['default' => env('LOG_CHANNEL', 'single'), 'deprecations' => ['channel' => null, 'trace' => false], 'channels' => ['single' => ['driver' => 'single', 'path' => storage_path('logs/laravel.log'), 'level' => 'debug', 'replace_placeholders' => true], 'stack' => ['driver' => 'stack', 'channels' => ['single'], 'ignore_exceptions' => false]]];\n`,
    "config/cache.php": `<?php\nreturn ['default' => env('CACHE_STORE', 'file'), 'stores' => ['file' => ['driver' => 'file', 'path' => storage_path('framework/cache/data')], 'array' => ['driver' => 'array']], 'prefix' => 'npati_cache_'];\n`,
    "config/filesystems.php": `<?php\nreturn ['default' => 'local', 'disks' => ['local' => ['driver' => 'local', 'root' => storage_path('app/private'), 'serve' => true, 'throw' => false]]];\n`,
    "storage/framework/sessions/.gitkeep": "",
    "storage/framework/views/.gitkeep": "",
    "storage/framework/cache/data/.gitkeep": "",
    "storage/logs/.gitkeep": "",
    "bootstrap/cache/.gitkeep": "",
    "Makefile": `.PHONY: build\nbuild:\n\tphp artisan route:list --json\n`,
  };
}

function staticHtml(name: string, framework: string): Record<string, string> {
  return {
    "index.html": htmlPage(name, framework, commonBody(framework, name), counterScript),
    "styles.css": `/* The starter styles are inline so the static page has no build step. Add shared overrides here. */\n`,
    "script.js": `${counterScript}\n`,
    "health.json": JSON.stringify({ status: "ok", framework: "HTML/CSS" }, null, 2) + "\n",
    "Makefile": `.PHONY: build\nbuild:\n\tnode -e "const fs=require('fs');if(!fs.existsSync('index.html'))process.exit(1)"\n`,
  };
}

const BUILDERS: Record<string, (name: string, framework: string) => Record<string, string>> = {
  "Next.js": () => { throw new Error("Next.js uses the existing NextJsAdapter"); },
  "React + Vite": reactVite,
  "Vue 3 + Vite": vueVite,
  "Nuxt": nuxt,
  "SvelteKit": svelteKit,
  "Astro": astro,
  "Angular": angular,
  "Remix": remix,
  "Express": expressApp,
  "Fastify": fastifyApp,
  "NestJS": nestApp,
  "FastAPI": fastApi,
  "Django": django,
  "Flask": flask,
  "Laravel": laravel,
  "HTML/CSS": staticHtml,
  "Flutter": () => ({
    "pubspec.yaml": "name: npati_mobile\ndescription: NPATI Flutter application\npublish_to: none\nversion: 1.0.0+1\nenvironment:\n  sdk: '>=3.4.0 <4.0.0'\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\nflutter:\n  uses-material-design: true\n",
    "lib/main.dart": 'import "package:flutter/material.dart";\nvoid main() => runApp(const MaterialApp(home: Scaffold(body: SizedBox.shrink())));\n',
  }),
  "Pygame": () => ({ "requirements.txt": "pygame\n", "main.py": '"""Implement the requested Python/Pygame desktop game here."""\n' }),
};

export function frameworkScaffoldSupported(value: string): boolean {
  const canonical = canonicalFrameworkName(value);
  return Boolean(canonical && canonical !== "Next.js" && canonical !== "Expo" && BUILDERS[canonical]);
}

/** Returns every file of a known-good framework starter. `Next.js` and `Expo` keep their adapters. */
export function createFrameworkScaffold(input: FrameworkScaffoldInput): Record<string, string> {
  const canonical = canonicalFrameworkName(input.framework);
  if (!canonical || canonical === "Next.js" || canonical === "Expo" || !BUILDERS[canonical]) {
    throw new Error(`Unsupported framework for deterministic scaffolding: ${input.framework}`);
  }
  if (canonical === "HTML/CSS") return {};
  const files = BUILDERS[canonical]!(input.projectName, canonical);
  // The project context is written separately; a README makes the starter self-describing.
  files["README.md"] = `# ${input.projectName}\n\nFramework: **${canonical}**\n\nThis project was scaffolded by the NPATI Coding Agent. Build and preview commands are managed by the platform.\n\n## Request\n\n${input.prompt}\n`;
  if(canonical === "Pygame") files["README.md"] = `# ${input.projectName}\n\nPython/Pygame desktop project. Use a project-local virtual environment and supported unit/headless tests. Real GUI/input needs an available, authorized display backend; report BLOCKED when absent. HTTP/browser Preview is not a desktop window.\n\n## Request\n${input.prompt}\n`;
  if(canonical === "Flutter") files["README.md"] = `# ${input.projectName}\n\nFlutter source project. Implement the requested screens and widget tests. Use flutter pub get, flutter analyze and flutter test only when the Flutter SDK is available. Android build requires JDK and Android SDK; report BLOCKED when absent. Source, build, install and device E2E are separate. No APK/AAB is supplied by this scaffold.\n\n## Request\n${input.prompt}\n`;
  return finalizeMinimalScaffold(files, canonical);
}

export function canonicalScaffoldFramework(value: string): SupportedProjectFramework | undefined {
  return canonicalFrameworkName(value);
}
