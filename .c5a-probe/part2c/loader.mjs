/**
 * Local ESM resolve hook for the C5a part 2C test harness (verification aid, not a deliverable).
 *
 * `vitest` cannot start in this sandbox, so the real spec files are executed with a shim module: this
 * hook maps the bare `vitest` specifier onto `vitest.mjs` next to this file, and (like the part 2B loader)
 * resolves the extensionless relative imports of the shipped modules and the `.sql` text imports of
 * `@npati/workspace`.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "vitest") {
    return { url: new URL("./vitest.mjs", import.meta.url).href, shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") && context.parentURL) {
      const base = new URL(specifier, context.parentURL);
      for (const suffix of [".ts", ".tsx", "/index.ts"]) {
        const candidate = new URL(`${base.href}${suffix}`);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".sql")) {
    const source = readFileSync(fileURLToPath(url), "utf8");
    return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(source)};` };
  }
  return nextLoad(url, context);
}
