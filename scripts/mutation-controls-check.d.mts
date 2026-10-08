/**
 * Types for `scripts/mutation-controls-check.mjs`, so the mutation-matrix suite can be part of
 * `npm run typecheck:tests` (the same pattern `scripts/attack-catalogue-check.d.mts` uses for the catalogue).
 *
 * The matrix and the row objects are `unknown` on purpose: the matrix is a hand-edited JSON file and an external
 * caller may hand this module anything, so every reader defends itself against a missing or malformed shape
 * instead of trusting the declaration.
 */

export declare const MUTATION_CONTROLS_PATH: string;
export declare const MUTATION_CONTROL_KINDS: readonly string[];
export declare const MUTATION_CONTROL_OPS: readonly string[];
export declare const MUTATION_RATIONALE_MIN_CHARS: number;
export declare const IN_MEMORY_CONTROLS_SUITE: string;

export interface MutationControlsState {
  controls: unknown[];
  matrix: unknown;
  error: string | null;
}

export interface MutationAnchorLocation {
  found: boolean;
  occurrences: number;
  line: number | null;
}

export interface MutationRender {
  ok: boolean;
  error: string | null;
  text: string | null;
  line: number | null;
}

export interface MutationIssue {
  code: string;
  id: string;
  detail: string;
}

export interface MutationValidation {
  ok: boolean;
  issues: MutationIssue[];
  counts: { decoy: number; cosmetic: number };
}

export declare function loadMutationControls(root?: string, matrixPath?: string): MutationControlsState;
export declare function locateMutationAnchor(source: unknown, control: unknown): MutationAnchorLocation;
export declare function renderMutation(source: unknown, control: unknown): MutationRender;
export declare function validateMutationControls(input: {
  root?: string;
  controls: unknown;
  suites?: readonly string[];
}): MutationValidation;
export declare function gateSuiteListFrom(source: unknown): string[] | null;
