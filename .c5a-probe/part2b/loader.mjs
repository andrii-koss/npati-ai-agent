/**
 * Local ESM resolve hook for the part 2B probe (verification aid, not a deliverable).
 *
 * The production modules import each other without a file extension (`./code-rbac`), which plain Node ESM
 * cannot resolve. This hook appends `.ts` / `/index.ts` for relative specifiers only — nothing else is
 * rewritten, so the probe exercises the real modules as they ship.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
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

/**
 * `@npati/workspace` imports its migrations as `.sql` text (the bundler's text loader does this in
 * production). Node has no loader for that extension, so the probe supplies the same semantics — the
 * migration SQL is *not* executed by this probe, it only has to be loadable.
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith(".sql")) {
    const source = readFileSync(fileURLToPath(url), "utf8");
    return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(source)};` };
  }
  return nextLoad(url, context);
}
