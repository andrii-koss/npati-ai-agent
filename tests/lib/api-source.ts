/* Source-level contracts: the tests that assert on the *composition* used to read
 * `apps/agent-api/src/app.ts` as text. After step 2 of docs/audit/refactoring/PLAN.md the composition lives in
 * several modules (app.ts plus the per-domain `*-wiring.ts` / `*-routes.ts` files), so reading app.ts alone
 * both misses the moved code and breaks every time a block moves.
 *
 * `readApiSources()` returns the concatenation of every TypeScript file in apps/agent-api/src, in a stable
 * order. Assertions about "the composed application contains X" stay meaningful, and future extractions no
 * longer require touching the tests.
 *
 * Use `readApiSource("name.ts")` when a test needs one specific file.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const apiDir = fileURLToPath(new URL("../../apps/agent-api/src", import.meta.url));

/** Every .ts file of apps/agent-api/src, concatenated with file banners (stable alphabetical order). */
export function readApiSources(): string {
  const names = readdirSync(apiDir).filter((name) => name.endsWith(".ts")).sort();
  return names.map((name) => `\n/* ===== ${name} ===== */\n${readFileSync(join(apiDir, name), "utf8")}`).join("");
}

/** The contents of one file of apps/agent-api/src. */
export function readApiSource(name: string): string {
  return readFileSync(join(apiDir, name), "utf8");
}
