/**
 * Types for `scripts/check-known-failures.mjs` — the **executable** half of the quarantine gate.
 *
 * G1 (item 5): the implementation moved to `scripts/lib/check-known-failures.mjs`, which owns the declarations
 * (`scripts/lib/check-known-failures.d.mts`). The wrapper re-exports that whole surface, so this file re-exports
 * it too: a suite that imports either path sees one declaration of the verdict's contract, and there is no second
 * copy to drift.
 */
export * from "./lib/check-known-failures.mjs";
