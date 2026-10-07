#!/usr/bin/env node
/**
 * C13: resolve hook for the capability-audit gates.
 *
 * The repository writes extensionless relative imports (`from "./capability-catalog"`), which a bundler
 * and vitest resolve but Node's ESM resolver does not. This hook adds the candidate extensions so the
 * *real* TypeScript modules can be imported instead of a regex over their source text.
 *
 * It is registered programmatically by `scripts/capability-audit-runtime.mjs` (`module.register`), so the
 * gates stay runnable as plain `node scripts/verify-capability-matrix.mjs` / `node scripts/upgrade-gate.mjs`.
 * Nothing here runs at import time: the hook thread only needs the exported functions.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      for (const suffix of [".ts", ".mts", ".mjs", ".js", "/index.ts", "/index.js"]) {
        try {
          return await nextResolve(specifier + suffix, context);
        } catch {
          // Keep trying; the original error is rethrown below when no candidate resolves.
        }
      }
      throw error;
    }
  }
  return nextResolve(specifier, context);
}
