import { describe, expect, it } from "vitest";
import { extractFramework, planChatDevelopment } from "@npati/shared";
import { createFrameworkScaffold } from "../apps/agent-api/src/project-framework-scaffold";
import { detectProjectStack, extractPortFromCommand } from "../apps/agent-api/src/project-preview-service";
import { projectRuntimeCommandPort } from "../apps/agent-api/src/shared-project-runtime-provider";
import { normalizeWorkspacePath } from "../apps/agent-api/src/code-tools-path";

const frameworks = [
  ["React 18 + Vite", "React + Vite"],
  ["Vue 3 + Vite", "Vue 3 + Vite"],
  ["Nuxt 3 SSR", "Nuxt"],
  ["SvelteKit SSR", "SvelteKit"],
  ["Astro static site", "Astro"],
  ["Angular 19", "Angular"],
  ["Remix React Router", "Remix"],
  ["Express.js", "Express"],
  ["Fastify", "Fastify"],
  ["NestJS", "NestJS"],
  ["FastAPI Python", "FastAPI"],
  ["Django", "Django"],
  ["Flask", "Flask"],
  ["Laravel PHP", "Laravel"],
  ["HTML + CSS + JavaScript", "HTML/CSS"],
] as const;

describe("framework request routing", () => {
  it.each(frameworks)("detects %s as %s", (prompt, expected) => {
    expect(extractFramework(`Create a responsive project with ${prompt}`)).toBe(expected);
  });

  it("keeps the requested homepage verb from turning a new Vue project into a page edit", () => {
    expect(planChatDevelopment("Створи сучасний адаптивний тестовий сайт на Vue 3 + Vite. Додай головну сторінку, навігацію та інтерактивні елементи. Встанови залежності, виконай production build і запусти Live Preview.")).toEqual([
      { kind: "website", name: "Company website", framework: "Vue 3 + Vite" },
    ]);
  });
  it("uses the requested framework and enters the API project path for backend prompts", () => {
    expect(planChatDevelopment("Створи мінімальний застосунок на FastAPI з /health")).toEqual([
      { kind: "api", name: "API service", framework: "FastAPI" },
    ]);
    expect(planChatDevelopment("Create a Fastify service with a health endpoint")).toEqual([
      { kind: "api", name: "API service", framework: "Fastify" },
    ]);
    expect(planChatDevelopment("Create a responsive website on Vue 3 + Vite")[0]?.framework).toBe("Vue 3 + Vite");
    expect(planChatDevelopment("Створи сайт на SvelteKit")[0]?.framework).toBe("SvelteKit");
  });
});

describe("deterministic framework starters", () => {
  const nodeFrameworks: Array<[string, string[]]> = [
    ["React + Vite", ["package.json", "vite.config.js", "src/App.jsx", "index.html"]],
    ["Vue 3 + Vite", ["package.json", "vite.config.js", "src/App.vue", "index.html"]],
    ["Nuxt", ["package.json", "nuxt.config.ts", "pages/index.vue"]],
    ["SvelteKit", ["package.json", "svelte.config.js", "src/routes/+page.svelte"]],
    ["Astro", ["package.json", "astro.config.mjs", "src/pages/index.astro"]],
    ["Angular", ["package.json", "angular.json", "src/main.ts", "src/app/app.component.ts"]],
    ["Remix", ["package.json", "app/root.tsx", "app/routes/home.tsx"]],
    ["Express", ["package.json", "src/server.ts", "Makefile"]],
    ["Fastify", ["package.json", "src/server.ts"]],
    ["NestJS", ["package.json", "nest-cli.json", "src/main.ts", "src/app.controller.ts"]],
  ];

  it.each(nodeFrameworks)("creates a buildable %s starter", (framework, required) => {
    const files = createFrameworkScaffold({ projectName: `Test ${framework}`, prompt: "Build it", framework });
    for (const file of required) expect(files[file], `${framework} is missing ${file}`).toBeTruthy();
    const manifest = JSON.parse(files["package.json"]!);
    expect(manifest.scripts.build).toBeTruthy();
    expect(manifest.dependencies ?? {}).toBeTypeOf("object");
  });

  it.each([
    ["FastAPI", ["main.py", "requirements.txt", "Makefile"], "FastAPI"],
    ["Django", ["manage.py", "config/settings.py", "web/views.py", "Makefile"], "django"],
    ["Flask", ["app.py", "requirements.txt", "Makefile"], "Flask"],
    ["Laravel", ["composer.json", "artisan", "routes/web.php", "config/app.php", "Makefile"], "Laravel"],
    ["HTML/CSS", ["index.html", "styles.css", "health.json"], "HTML/CSS"],
  ])("creates a %s starter with its build/health surface", (framework, required, marker) => {
    const files = createFrameworkScaffold({ projectName: `Test ${framework}`, prompt: "Build it", framework });
    for (const file of required) expect(files[file], `${framework} is missing ${file}`).toBeTruthy();
    expect(JSON.stringify(files)).toContain(marker);
    if (framework !== "HTML/CSS") expect(files["Makefile"]).toContain("build:");
  });
});

describe("stack detection and preview commands", () => {
  it.each([
    ["Nuxt", { "package.json": JSON.stringify({ dependencies: { nuxt: "3" }, scripts: { dev: "nuxt dev", build: "nuxt build" } }), "nuxt.config.ts": "" }, "nuxt"],
    ["SvelteKit", { "package.json": JSON.stringify({ dependencies: { "@sveltejs/kit": "2", svelte: "5" }, scripts: { dev: "vite dev", build: "vite build" } }), "svelte.config.js": "" }, "sveltekit"],
    ["Remix", { "package.json": JSON.stringify({ dependencies: { "@react-router/dev": "7" }, scripts: { dev: "react-router dev", build: "react-router build" } }), "react-router.config.ts": "" }, "remix"],
    ["Angular", { "package.json": JSON.stringify({ dependencies: { "@angular/core": "19" }, scripts: { build: "ng build", start: "serve -s dist/app/browser -l 3000" } }), "angular.json": "{}" }, "angular"],
    ["Fastify", { "package.json": JSON.stringify({ dependencies: { fastify: "5" }, scripts: { build: "tsc", start: "node dist/server.js" } }), "tsconfig.json": "{}" }, "fastify"],
  ])("detects %s", async (_name, files, framework) => {
    const detected = await detectProjectStack(Object.keys(files).map((path) => ({ path })), async (path) => files[path] ?? "");
    expect(detected.framework).toBe(framework);
    expect(detected.productionCommand).toBeTruthy();
  });

  it("detects Python and PHP servers instead of serving them as static files", async () => {
    const djangoFiles = { "manage.py": "", "requirements.txt": "Django", "config/settings.py": "" };
    const django = await detectProjectStack(Object.keys(djangoFiles).map((path) => ({ path })), async (path) => djangoFiles[path as keyof typeof djangoFiles] ?? "");
    expect(django.framework).toBe("django");
    expect(django.command).toContain("manage.py runserver");

    const fastapiFiles = { "main.py": "from fastapi import FastAPI\napp = FastAPI()", "requirements.txt": "fastapi" };
    const fastapi = await detectProjectStack(Object.keys(fastapiFiles).map((path) => ({ path })), async (path) => fastapiFiles[path as keyof typeof fastapiFiles] ?? "");
    expect(fastapi.framework).toBe("fastapi");
    expect(fastapi.command).toContain("uvicorn");

    const laravelFiles = { "composer.json": "{}", "artisan": "" };
    const laravel = await detectProjectStack(Object.keys(laravelFiles).map((path) => ({ path })), async (path) => laravelFiles[path as keyof typeof laravelFiles] ?? "");
    expect(laravel.framework).toBe("laravel");
    expect(laravel.command).toContain("php artisan serve");
  });

  it("treats SvelteKit +files and Astro [slug] files as literal framework paths", () => {
    expect(normalizeWorkspacePath("src/routes/+page.svelte", { tool: "code.fs.read" })).toBe("src/routes/+page.svelte");
    expect(normalizeWorkspacePath("src/routes/+layout.server.ts", { tool: "code.fs.read" })).toBe("src/routes/+layout.server.ts");
    expect(normalizeWorkspacePath("src/pages/[slug].astro", { tool: "code.fs.read" })).toBe("src/pages/[slug].astro");
    expect(() => normalizeWorkspacePath("src/*.svelte", { tool: "code.fs.read" })).toThrow(/Glob metacharacters/);
  });

  it("rewrites the runtime port for every server style", () => {
    expect(projectRuntimeCommandPort("npx vite preview --host 0.0.0.0 --port 5173", 3040)).toBe("npx vite preview --host 0.0.0.0 --port 3040");
    expect(projectRuntimeCommandPort("python3 -m http.server 3000 --bind 0.0.0.0", 3041)).toBe("python3 -m http.server 3041 --bind 0.0.0.0");
    expect(projectRuntimeCommandPort(".venv/bin/python manage.py runserver 0.0.0.0:8000 --noreload", 3042)).toBe(".venv/bin/python manage.py runserver 0.0.0.0:3042 --noreload");
    expect(projectRuntimeCommandPort("php artisan serve --host=0.0.0.0 --port=8000", 3043)).toBe("php artisan serve --host=0.0.0.0 --port=3043");
    expect(projectRuntimeCommandPort(".venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8000", 3044)).toContain("--port 3044");
    expect(extractPortFromCommand("node build/index.js", 3000)).toBe(3000);
  });
});
