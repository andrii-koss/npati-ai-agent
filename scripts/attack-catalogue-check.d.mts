/**
 * Types for `scripts/attack-catalogue-check.mjs`, so the C14 catalogue suites can be part of
 * `npm run typecheck:tests` (the same pattern `scripts/run-security-gate.d.mts` uses for the gate).
 *
 * The catalogue and the report are `unknown` on purpose: both are external input (a hand-edited JSON file and
 * a vitest report), and every reader defends itself against a missing or malformed shape rather than trusting
 * the declaration.
 */

export declare const ATTACK_CATALOGUE_PATH: string;
export declare const CATALOGUE_STATUSES: readonly string[];
export declare const NEGATIVE_CONTROL_MIN_CHARS: number;
export declare const EXEMPTION_REASON_MIN_CHARS: number;

export interface CatalogueIssue {
  code: string;
  id: string;
  detail: string;
}

export interface CatalogueValidation {
  ok: boolean;
  issues: CatalogueIssue[];
}

export interface MissingCatalogueEntry {
  id: string;
  suite: string;
  title: string;
}

export declare function itTitlesIn(source: unknown): string[];
export declare function normalizeSuiteKey(value: unknown): string;
export declare function loadAttackCatalogue(root: string): { catalogue: unknown; error: string | null };
export declare function validateAttackCatalogue(input: {
  root?: string;
  catalogue: unknown;
  suites?: readonly string[];
  hardDenyRuleIds?: readonly string[];
}): CatalogueValidation;
export declare function findMissingCatalogueEntries(report: unknown, catalogue: unknown): MissingCatalogueEntry[];
