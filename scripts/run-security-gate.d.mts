/**
 * Types for `scripts/run-security-gate.mjs` — the **executable** half of the gate.
 *
 * G1 (item 5): the implementation moved to `scripts/lib/run-security-gate.mjs`, which owns the declarations
 * (`scripts/lib/run-security-gate.d.mts`). The wrapper re-exports that whole surface, so this file re-exports it
 * too: a suite that imports either path sees one declaration of the gate's contract, and there is no second copy
 * to drift.
 */
export * from "./lib/run-security-gate.mjs";
