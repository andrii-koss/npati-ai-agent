import { readFile as readFileFromDisk } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256 } from "@npati/workspace";

/**
 * C4a: the curated typosquat dataset.
 *
 * The dataset is versioned and shipped in the repository (`data/typosquat/<ecosystem>.json`): there is
 * deliberately **no** runtime call to an external ranking API, so dependency checks work offline and
 * cannot be steered by a third party. Each file carries the sha256 of the canonical JSON of its sorted
 * name list, so any tampering is detected here; a stale file is refused by age.
 *
 * If the dataset cannot be loaded the dependency guard must escalate to approval — never allow — see
 * `typosquat_dataset_unavailable` in `code-deps-guard.ts`.
 */
export type TyposquatEcosystem = "npm" | "pypi" | "cargo" | "go" | "composer" | "maven";
export const TYPOSQUAT_ECOSYSTEMS: readonly TyposquatEcosystem[] = ["npm", "pypi", "cargo", "go", "composer", "maven"] as const;

export const TYPOSQUAT_SCHEMA_VERSION = 1;

export interface TyposquatDataset {
  schemaVersion: number;
  ecosystem: TyposquatEcosystem;
  datasetVersion: string;
  generatedAt: string;
  source: { kind: string; description: string; references: string[] };
  hash: string;
  packageNames: string[];
}

export type TyposquatDatasetFailureReason =
  | "dataset_missing"
  | "dataset_invalid"
  | "dataset_stale"
  | "dataset_ecosystem_mismatch"
  | "dataset_hash_mismatch"
  | "dataset_unsupported_schema";

export interface TyposquatDatasetFailure {
  ok: false;
  reason: TyposquatDatasetFailureReason;
  details: string;
  ecosystem: TyposquatEcosystem;
}
export interface TyposquatDatasetSuccess { ok: true; dataset: TyposquatDataset }
export type TyposquatDatasetResult = TyposquatDatasetSuccess | TyposquatDatasetFailure;

export interface TyposquatDatasetOptions {
  directory?: string;
  /** Injected so tests never touch the filesystem. */
  readFile?: (file: string) => Promise<string>;
  now?: Date;
  maxAgeDays?: number;
}

export const DEFAULT_TYPOSQUAT_MAX_AGE_DAYS = 365;

export function defaultTyposquatDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.NPATI_CODE_TYPOSQUAT_DIR ?? path.join("data", "typosquat"));
}

export function resolveTyposquatMaxAgeDays(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.NPATI_CODE_TYPOSQUAT_MAX_AGE_DAYS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TYPOSQUAT_MAX_AGE_DAYS;
}

/** sha256 of the canonical JSON of the sorted name list — the same rule the generator uses. */
export function typosquatDatasetHash(packageNames: readonly string[]): string {
  return `sha256:${sha256(canonicalJson([...packageNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))))}`;
}

function fail(ecosystem: TyposquatEcosystem, reason: TyposquatDatasetFailureReason, details: string): TyposquatDatasetFailure {
  return { ok: false, ecosystem, reason, details };
}

/**
 * Loads and validates one ecosystem dataset. Every failure is structured: the caller must treat a
 * failure as a hard escalation to approval (never as "no known typosquats, so allow").
 */
export async function loadTyposquatDataset(
  ecosystem: TyposquatEcosystem,
  options: TyposquatDatasetOptions = {},
): Promise<TyposquatDatasetResult> {
  const directory = options.directory ?? defaultTyposquatDirectory();
  const file = path.join(directory, `${ecosystem}.json`);
  const read = options.readFile ?? ((target: string) => readFileFromDisk(target, "utf8"));

  let raw: string;
  try {
    raw = await read(file);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    return fail(ecosystem, "dataset_missing", code === "ENOENT" ? `No dataset file at ${file}` : `Cannot read ${file}: ${(error as Error)?.message ?? "unknown error"}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return fail(ecosystem, "dataset_invalid", `Invalid JSON: ${(error as Error)?.message ?? "parse error"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(ecosystem, "dataset_invalid", "Dataset root must be an object");
  const dataset = parsed as Partial<TyposquatDataset>;

  if (dataset.schemaVersion !== TYPOSQUAT_SCHEMA_VERSION) {
    return fail(ecosystem, "dataset_unsupported_schema", `schemaVersion ${String(dataset.schemaVersion)} is not supported (expected ${TYPOSQUAT_SCHEMA_VERSION})`);
  }
  if (dataset.ecosystem !== ecosystem) {
    return fail(ecosystem, "dataset_ecosystem_mismatch", `Dataset declares ecosystem "${String(dataset.ecosystem)}" but "${ecosystem}" was requested`);
  }
  if (typeof dataset.datasetVersion !== "string" || !dataset.datasetVersion.trim()) return fail(ecosystem, "dataset_invalid", "datasetVersion is missing");
  if (typeof dataset.hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(dataset.hash)) return fail(ecosystem, "dataset_invalid", "hash is missing or malformed");
  if (!dataset.source || typeof dataset.source !== "object" || typeof dataset.source.description !== "string") return fail(ecosystem, "dataset_invalid", "source metadata is missing");

  const generatedAt = typeof dataset.generatedAt === "string" ? new Date(dataset.generatedAt) : new Date(Number.NaN);
  if (Number.isNaN(generatedAt.getTime())) return fail(ecosystem, "dataset_invalid", "generatedAt is not a valid date");
  const maxAgeDays = options.maxAgeDays ?? resolveTyposquatMaxAgeDays();
  const ageDays = ((options.now ?? new Date()).getTime() - generatedAt.getTime()) / 86_400_000;
  if (ageDays > maxAgeDays) {
    return fail(ecosystem, "dataset_stale", `Dataset is ${Math.floor(ageDays)} days old (limit ${maxAgeDays}); regenerate data/typosquat/${ecosystem}.json`);
  }

  const names = dataset.packageNames;
  if (!Array.isArray(names) || names.length === 0) return fail(ecosystem, "dataset_invalid", "packageNames must be a non-empty array");
  if (!names.every((name) => typeof name === "string" && name.trim().length > 0)) return fail(ecosystem, "dataset_invalid", "packageNames must contain non-empty strings");
  if (new Set(names).size !== names.length) return fail(ecosystem, "dataset_invalid", "packageNames contains duplicates");

  const recomputed = typosquatDatasetHash(names);
  if (recomputed !== dataset.hash) {
    return fail(ecosystem, "dataset_hash_mismatch", `Recorded hash ${dataset.hash} does not match the recomputed ${recomputed}`);
  }

  return {
    ok: true,
    dataset: {
      schemaVersion: dataset.schemaVersion,
      ecosystem,
      datasetVersion: dataset.datasetVersion,
      generatedAt: dataset.generatedAt!,
      source: { kind: dataset.source.kind ?? "curated", description: dataset.source.description, references: Array.isArray(dataset.source.references) ? dataset.source.references : [] },
      hash: dataset.hash,
      packageNames: [...names],
    },
  };
}

/** Loads every ecosystem dataset; used by diagnostics and by the guard when no ecosystem is known. */
export async function loadAllTyposquatDatasets(options: TyposquatDatasetOptions = {}): Promise<Record<TyposquatEcosystem, TyposquatDatasetResult>> {
  const entries = await Promise.all(TYPOSQUAT_ECOSYSTEMS.map(async (ecosystem) => [ecosystem, await loadTyposquatDataset(ecosystem, options)] as const));
  return Object.fromEntries(entries) as Record<TyposquatEcosystem, TyposquatDatasetResult>;
}
