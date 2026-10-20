import { createFrameworkScaffold } from "../apps/agent-api/src/project-framework-scaffold";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const frameworks = [
  "React + Vite", "Vue 3 + Vite", "Nuxt", "SvelteKit", "Astro", "Angular",
  "Remix", "Express", "Fastify", "NestJS", "FastAPI", "Django", "Flask", "Laravel", "HTML/CSS",
];
const out = join(process.cwd(), "scratch", "framework-fixtures");
rmSync(out, { recursive: true, force: true });
for (const framework of frameworks) {
  const slug = framework.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const dir = join(out, slug);
  const files = createFrameworkScaffold({ projectName: `NPATI ${framework} Test`, prompt: `Test ${framework}`, framework });
  for (const [filePath, content] of Object.entries(files)) {
    const target = join(dir, filePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  console.log(framework, Object.keys(files).length, "files");
}
