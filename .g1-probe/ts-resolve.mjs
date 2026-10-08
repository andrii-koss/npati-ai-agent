/**
 * G1 (D1) probe loader: resolve the repository's extensionless relative TypeScript specifiers and load the
 * `.sql` migration assets.
 *
 * Two sandbox facts shape this file:
 *
 *  - the sandbox cannot start `tsx`/`esbuild` (a child process with piped stdio is refused: `spawn EPERM`),
 *    so the probe uses Node's own in-process type stripping (`--experimental-transform-types`);
 *  - the package sources are written for `bundler`/`node16` TypeScript resolution (`./types`, not
 *    `./types.ts`), which Node's ESM resolver refuses, so the `resolve` hook appends the extension when the
 *    exact specifier does not exist.
 *
 * The `load` hook for `.sql` mirrors — line for line — the `npati-sql-migrations` plugin in
 * `vitest.config.ts:5-12`, so the store's migration SQL reaches the probe exactly as it reaches the suite.
 * No code under measurement is changed; only module resolution is.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try { return await nextResolve(candidate, context); } catch { /* try the next candidate */ }
      }
      throw error;
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".sql")) {
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), "utf8"))};`,
    };
  }
  return nextLoad(url, context);
}
