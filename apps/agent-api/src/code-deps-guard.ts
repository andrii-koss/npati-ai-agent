/**
 * C4a: guard for NEW dependencies, evaluated before anything is installed.
 *
 * The guard never touches the network itself: metadata arrives through an injected lookup port, which
 * keeps the decision testable and keeps the agent's own process free of outbound requests (the sandbox
 * and the C4b egress proxy are the only places where the network exists).
 *
 * The typosquat check uses the curated, versioned datasets from `data/typosquat/` (never an external
 * ranking API); when that dataset cannot be loaded the verdict escalates to approval with
 * `typosquat_dataset_unavailable` — a missing dataset must never disable the check.
 *
 * Verdicts are advisory for the caller (the policy engine turns them into allow/approval/deny):
 * - `deny` is used when the dependency is provably wrong (unknown package, registry outside allowlist);
 * - `require_approval` is used whenever the risk is real but a human may accept it (typosquatting,
 *   install scripts, freshly published packages when configured that way, unknown metadata);
 * - `allow` only when every rule passed.
 */
import { createHash } from "node:crypto";
import { loadTyposquatDataset, type TyposquatDatasetOptions, type TyposquatDatasetResult, type TyposquatEcosystem } from "./code-typosquat-dataset";

export type DependencyManager = "npm" | "pnpm" | "yarn" | "pip" | "poetry" | "composer" | "cargo" | "go";
export type DependencyVerdict = "allow" | "require_approval" | "deny";
export type DependencySource = "registry" | "git" | "tarball" | "http" | "local_path";

export interface DependencyMetadata {
  exists: boolean;
  latestVersion?: string;
  publishedAt?: string;
  license?: string;
  hasInstallScripts?: boolean;
  maintainers?: number;
  weeklyDownloads?: number;
}

export interface DependencyMetadataLookup {
  (name: string, options: { registryHost: string }): Promise<DependencyMetadata>;
}

export interface DependencyCheckResult {
  verdict: DependencyVerdict;
  reasons: string[];
  metadata: DependencyMetadata & { name: string; ageDays?: number; registryHost: string };
}

export interface DepsGuardPolicy {
  /** Minimum age of the published version before it may be installed without a human. */
  minAgeDays: number;
  /** When true a too-young package becomes `require_approval` instead of `deny`. */
  allowYoungWithApproval: boolean;
  /** Registry hosts that may be used at all. */
  allowedRegistries: string[];
  /** Names used for the typosquatting check (populated per project where possible). */
  popularPackages: string[];
  /** Maximum Levenshtein distance that still counts as suspicious. */
  typoDistance: number;
}

export const DEFAULT_ALLOWED_REGISTRIES = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "repo.packagist.org",
  "packagist.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
];

/**
 * C4a: there is deliberately **no** built-in popular-package list — the curated, versioned datasets in
 * `data/typosquat/<ecosystem>.json` are the single source (see `code-typosquat-dataset.ts`). An explicit
 * list can still be injected for tests or by an administrator through
 * `NPATI_CODE_DEPS_POPULAR_PACKAGES`, but the default is empty so a missing dataset cannot silently
 * disable the check: `checkDependency` escalates to approval with `typosquat_dataset_unavailable`.
 */
export const DEFAULT_POPULAR_PACKAGES: string[] = [];

const REGISTRY_CONFIG_FILES = [
  /(^|\/)\.npmrc$/,
  /(^|\/)\.yarnrc$/,
  /(^|\/)\.yarnrc\.yml$/,
  /(^|\/)pip\.conf$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)composer\.json$/,
];

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const items = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : fallback;
}

export function resolveDepsGuardPolicy(env: NodeJS.ProcessEnv = process.env): DepsGuardPolicy {
  return {
    minAgeDays: positiveInt(env.NPATI_CODE_DEPS_MIN_AGE_DAYS, 7),
    allowYoungWithApproval: env.NPATI_CODE_DEPS_ALLOW_YOUNG_APPROVAL === "true",
    allowedRegistries: list(env.NPATI_CODE_DEPS_ALLOWED_REGISTRIES, DEFAULT_ALLOWED_REGISTRIES),
    popularPackages: list(env.NPATI_CODE_DEPS_POPULAR_PACKAGES, DEFAULT_POPULAR_PACKAGES),
    typoDistance: positiveInt(env.NPATI_CODE_DEPS_TYPO_DISTANCE, 2),
  };
}

export function levenshtein(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** True when two adjacent characters are swapped (`lodahs` vs `lodash`) — a common typosquat shape. */
export function isAdjacentTransposition(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left.length !== right.length) return false;
  const differing: number[] = [];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) differing.push(index);
    if (differing.length > 2) return false;
  }
  if (differing.length !== 2) return false;
  const [first, second] = differing as [number, number];
  return second === first + 1 && left[first] === right[second] && left[second] === right[first];
}

export function findTyposquatTarget(name: string, popularPackages: string[], maxDistance: number): string | null {
  const candidate = name.toLowerCase();
  for (const popular of popularPackages) {
    const target = popular.toLowerCase();
    if (candidate === target) return null;
    if (isAdjacentTransposition(candidate, target)) return popular;
    // Scope prefixes (`@scope/lodash`) are compared on the package part only.
    const withoutScope = candidate.includes("/") ? candidate.split("/").pop()! : candidate;
    if (withoutScope !== candidate && (withoutScope === target || isAdjacentTransposition(withoutScope, target))) return popular;
    if (levenshtein(candidate, target) <= maxDistance) return popular;
  }
  return null;
}

export function isRegistryAllowed(registryHost: string, allowedRegistries: string[]): boolean {
  const host = registryHost.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return allowedRegistries.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function ageInDays(publishedAt: string | undefined, now: Date): number | undefined {
  if (!publishedAt) return undefined;
  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) return undefined;
  return Math.floor((now.getTime() - published.getTime()) / 86_400_000);
}

export interface CheckDependencyInput {
  manager: DependencyManager;
  name: string;
  version?: string;
  registryHost: string;
  metadataLookup: DependencyMetadataLookup;
  now?: Date;
  policy?: DepsGuardPolicy;
  /** C4a: which curated dataset to use for the typosquat check (defaults to `npm`). */
  ecosystem?: TyposquatEcosystem;
  /** Injected loader (tests); defaults to `loadTyposquatDataset` reading `data/typosquat/`. */
  loadTyposquatDataset?: (ecosystem: TyposquatEcosystem, options?: TyposquatDatasetOptions) => Promise<TyposquatDatasetResult>;
  typosquatDatasetOptions?: TyposquatDatasetOptions;
}

/**
 * Evaluates one new dependency. Order matters: the cheapest and most certain refusals come first, and
 * an unresolvable lookup never becomes an implicit allow.
 */
export async function checkDependency(input: CheckDependencyInput): Promise<DependencyCheckResult> {
  const policy = input.policy ?? resolveDepsGuardPolicy();
  const now = input.now ?? new Date();
  const reasons: string[] = [];

  if (!isRegistryAllowed(input.registryHost, policy.allowedRegistries)) {
    return {
      verdict: "deny",
      reasons: [`registry_not_allowed:${input.registryHost}`],
      metadata: { name: input.name, exists: false, registryHost: input.registryHost },
    };
  }

  let metadata: DependencyMetadata;
  try {
    metadata = await input.metadataLookup(input.name, { registryHost: input.registryHost });
  } catch {
    return {
      verdict: "require_approval",
      reasons: ["metadata_unavailable"],
      metadata: { name: input.name, exists: false, registryHost: input.registryHost },
    };
  }

  if (!metadata.exists) {
    return {
      verdict: "deny",
      reasons: ["package_not_found"],
      metadata: { ...metadata, name: input.name, registryHost: input.registryHost },
    };
  }

  const ageDays = ageInDays(metadata.publishedAt, now);
  if (ageDays !== undefined && ageDays < policy.minAgeDays) {
    reasons.push(`package_too_young:${ageDays}d<${policy.minAgeDays}d`);
    return {
      verdict: policy.allowYoungWithApproval ? "require_approval" : "deny",
      reasons,
      metadata: { ...metadata, name: input.name, registryHost: input.registryHost, ageDays },
    };
  }

  // C4a: the typosquat dataset is the source of truth. An injected list always wins (tests /
  // administrator override); otherwise it is loaded from data/typosquat/<ecosystem>.json and a failure
  // escalates to approval instead of silently skipping the check.
  let popularPackages = policy.popularPackages;
  if (popularPackages.length === 0) {
    const dataset = await (input.loadTyposquatDataset ?? loadTyposquatDataset)(input.ecosystem ?? "npm", input.typosquatDatasetOptions);
    if (dataset.ok) {
      popularPackages = dataset.dataset.packageNames;
      reasons.push(`typosquat_dataset:${dataset.dataset.datasetVersion}`);
    } else {
      reasons.push(`typosquat_dataset_unavailable:${dataset.reason}`);
    }
  }

  // The dataset lists official package names, so an exact match means the requested name IS the popular
  // package: it must never be reported as a typosquat of itself.
  const candidates = popularPackages.filter((popular) => popular.toLowerCase() !== input.name.trim().toLowerCase());
  const typosquat = candidates.length ? findTyposquatTarget(input.name, candidates, policy.typoDistance) : null;
  if (typosquat) reasons.push(`possible_typosquat:${typosquat}`);
  if (metadata.hasInstallScripts) reasons.push("install_scripts_present");
  if (metadata.maintainers !== undefined && metadata.maintainers <= 1) reasons.push("single_maintainer");

  const verdict: DependencyVerdict = reasons.some(
    (reason) => reason.startsWith("possible_typosquat") || reason.startsWith("install_scripts") || reason.startsWith("typosquat_dataset_unavailable"),
  )
    ? "require_approval"
    : "allow";

  return {
    verdict,
    reasons: reasons.length ? reasons : ["rules_passed"],
    metadata: { ...metadata, name: input.name, registryHost: input.registryHost, ageDays },
  };
}

/** Registry dependencies are the normal path; every other source needs a human decision. */
export function classifyDependencySource(input: { manager: DependencyManager; spec: string }): DependencySource {
  const spec = input.spec.trim();
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/i.test(spec) || /\.git(#|$)/i.test(spec)) return "git";
  if (/^https?:\/\//i.test(spec) && /\.(tgz|tar\.gz|whl|zip)(#|$)/i.test(spec)) return "tarball";
  if (/^https?:\/\//i.test(spec)) return "http";
  if (/^(file:|link:|workspace:|\.{0,2}\/|[A-Za-z]:\\)/.test(spec)) return "local_path";
  return "registry";
}

export function sourceRequiresApproval(source: DependencySource): boolean {
  return source !== "registry";
}

export interface RegistryConfigChange {
  changed: boolean;
  urls: string[];
  files: string[];
}

const REGISTRY_URL_PATTERN = /(?:registry|index-url|extra-index-url|@[a-z0-9-]+:registry|repositories|source)\s*[=:"'\s]\s*(https?:\/\/[^\s"',}]+)/gi;

/**
 * Detects registry/index URL changes in package-manager configuration files. Any non-default registry
 * endpoint means the install would talk to a host the project did not choose, so it needs approval.
 */
export function registryConfigChanges(files: Array<{ path: string; content: string }>): RegistryConfigChange {
  const urls: string[] = [];
  const touched: string[] = [];
  for (const file of files) {
    const normalized = file.path.replace(/\\/g, "/");
    if (!REGISTRY_CONFIG_FILES.some((pattern) => pattern.test(normalized))) continue;
    const found: string[] = [];
    for (const match of file.content.matchAll(REGISTRY_URL_PATTERN)) {
      const url = match[1]!;
      const host = url.replace(/^https?:\/\//, "").split("/")[0]!.toLowerCase();
      if (!DEFAULT_ALLOWED_REGISTRIES.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) found.push(url);
    }
    if (found.length) {
      touched.push(normalized);
      urls.push(...found);
    }
  }
  return { changed: touched.length > 0, urls, files: touched };
}

/** Stable identifier for an approval request: same dependency, same decision. */
export function dependencyFingerprint(input: { manager: string; name: string; version?: string; registryHost: string }): string {
  return createHash("sha256")
    .update([input.manager, input.name, input.version ?? "latest", input.registryHost].join("|"))
    .digest("hex");
}
