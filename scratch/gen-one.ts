import { createFrameworkScaffold } from "../apps/agent-api/src/project-framework-scaffold";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const framework = process.argv[2] ?? "Nuxt";
const dir = join(process.cwd(), "scratch", process.argv[3] ?? "nuxt-check");
rmSync(dir, { recursive: true, force: true });
const files = createFrameworkScaffold({ projectName: `NPATI ${framework} Test`, prompt: `Test ${framework}`, framework });
for (const [filePath, content] of Object.entries(files)) {
  const target = join(dir, filePath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}
console.log(dir, Object.keys(files).length);
