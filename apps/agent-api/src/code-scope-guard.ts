/**
 * C9: scope guard.
 *
 * A code run is asked to change one thing and can end up touching thirty files. That is not automatically
 * wrong — a rename legitimately touches many files — so this guard **warns**, it does not block and it does
 * not invent an approval. An approval gate on the *number* of files would be satisfied by a single click and
 * would say nothing about risk; the honest control is a warning that reaches the summary and Activity, where
 * a human reviewing the run actually sees it. The one case that is escalated to `critical` is a gross
 * overrun (more than twice the configured limit), which is reported as such rather than silently tolerated.
 *
 * Relatedness is deliberately conservative and explainable: it is only judged when the run has a stated
 * focus (planned paths, or path-like tokens in the request). With no focus there is nothing to compare
 * against, and the guard says so instead of guessing — a false "unrelated file" warning trains people to
 * ignore the guard, which is worse than staying quiet.
 */

export type ScopeGuardSeverity = "info" | "warn" | "critical";

export interface ScopeGuardWarning {
  code: string;
  message: string;
  severity: ScopeGuardSeverity;
  /** Paths the warning is about. Metadata only: paths are not content. */
  paths: string[];
}

export interface ScopeGuardResult {
  changedFiles: number;
  limit: number;
  exceeded: boolean;
  severity: ScopeGuardSeverity;
  /** Paths considered unrelated to the request, each with the reason recorded in `warnings`. */
  unrelatedPaths: string[];
  warnings: ScopeGuardWarning[];
  /** True when relatedness could not be judged (no planned paths and no path-like request tokens). */
  relatednessUnknown: boolean;
}

export interface ScopeGuardInput {
  changedPaths: readonly string[];
  /** Paths the run said it would touch (plan/todo). Highest-quality focus signal. */
  plannedPaths?: readonly string[];
  /** The user's request; path-like tokens in it are used as a weaker focus signal. */
  requestText?: string;
  maxChangedFiles: number;
  /** How many unrelated paths to report before collapsing the rest into a count. */
  unrelatedSampleLimit?: number;
}

/**
 * Files whose change is never evidence of scope creep: manifests, lockfiles, configuration and docs are
 * legitimately touched by many tasks, so flagging them would produce noise rather than signal.
 */
const ALWAYS_RELATED_PATTERNS: readonly RegExp[] = [
  // Documentation and configuration move with almost every task, at any depth; flagging them is noise.
  /\.(json|ya?ml|toml|ini|cfg|md|txt|lock)$/i,
  /(^|\/)\.(github|gitlab|circleci)\//i,
  /(^|\/)(Dockerfile|Containerfile|Makefile|Justfile)$/i,
  /(^|\/)(tsconfig|jsconfig|vite\.config|vitest\.config|eslint\.config|jest\.config)[^/]*$/i,
  /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|composer\.json|Gemfile)$/i,
];

function normalize(path: string): string {
  return (path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function segments(path: string): string[] {
  return normalize(path).split("/").filter(Boolean);
}

/**
 * The deepest common directory of a path is a better focus signal than the file itself: touching
 * `src/billing/invoice.ts` makes `src/billing` the relevant neighbourhood.
 */
function focusRoots(input: ScopeGuardInput): string[] {
  const roots = new Set<string>();
  for (const planned of input.plannedPaths ?? []) {
    const parts = segments(planned);
    if (parts.length === 0) continue;
    roots.add(parts.length === 1 ? parts[0]! : parts.slice(0, Math.min(2, parts.length - 1)).join("/"));
  }
  const request = input.requestText ?? "";
  // Path-like tokens only: a bare word is not a path, and treating it as one would flood the focus set.
  for (const token of request.split(/[\s,;"'`()<>\[\]]+/)) {
    const cleaned = normalize(token).replace(/[.:]+$/, "");
    if (!cleaned.includes("/")) continue;
    if (!/^[\w.@-]+(\/[\w.@-]+)+$/.test(cleaned)) continue;
    const parts = segments(cleaned);
    if (parts.length === 0) continue;
    roots.add(parts.length === 1 ? parts[0]! : parts.slice(0, Math.min(2, parts.length - 1)).join("/"));
  }
  return [...roots];
}

function isAlwaysRelated(path: string): boolean {
  return ALWAYS_RELATED_PATTERNS.some((pattern) => pattern.test(path));
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Evaluates the run's change set against the configured file limit and, when a focus is known, against the
 * paths the run said it would touch.
 */
export function evaluateScopeGuard(input: ScopeGuardInput): ScopeGuardResult {
  const changed = [...new Set((input.changedPaths ?? []).map(normalize).filter(Boolean))].sort();
  const limit = Math.max(1, input.maxChangedFiles);
  const sampleLimit = Math.max(1, input.unrelatedSampleLimit ?? 10);
  const warnings: ScopeGuardWarning[] = [];

  const exceeded = changed.length > limit;
  const severity: ScopeGuardSeverity = !exceeded ? "info" : changed.length > limit * 2 ? "critical" : "warn";
  if (exceeded) {
    warnings.push({
      code: severity === "critical" ? "scope_grossly_exceeded" : "scope_exceeded",
      message: `The change set touches ${changed.length} files, above the configured limit of ${limit}.`,
      severity,
      // The paths themselves are reported so the warning is actionable, but the list is bounded: a summary
      // is not a file dump.
      paths: changed.slice(0, sampleLimit),
    });
  }

  const roots = focusRoots(input);
  const unrelatedPaths: string[] = [];
  if (roots.length > 0) {
    for (const path of changed) {
      if (roots.some((root) => isUnder(path, root))) continue;
      if (isAlwaysRelated(path)) continue;
      unrelatedPaths.push(path);
    }
    if (unrelatedPaths.length > 0) {
      warnings.push({
        code: "scope_unrelated_files",
        message: `The change set includes ${unrelatedPaths.length} file(s) outside the stated focus (${roots.slice(0, 5).join(", ")}).`,
        severity: "warn",
        paths: unrelatedPaths.slice(0, sampleLimit),
      });
    }
  }

  return {
    changedFiles: changed.length,
    limit,
    exceeded,
    severity,
    unrelatedPaths,
    warnings,
    relatednessUnknown: roots.length === 0,
  };
}
