import { readFile } from "node:fs/promises";
import { SANDBOX_IMAGE_REFERENCE_PATTERN, SANDBOX_IMAGE_STATUSES, SANDBOX_IMAGE_VARIANTS, type SandboxImageStatus, type SandboxImageVariant } from "@npati/workspace";

/**
 * C1b: the declarative image catalogue.
 *
 * It is the reviewed source of truth for which digests exist, what they were scanned with and where
 * their SBOM lives. A row may be pre-seeded here (for example by CI) and is only promoted into the
 * database as `verified` after admission checks pass.
 *
 * Validation is strict and mirrors the policy: tags and `latest` are rejected outright, and an entry
 * without an SBOM, a scan timestamp or a known status invalidates the whole catalogue, because a
 * half-specified catalogue is how unverified images sneak into production.
 */
export interface SandboxImageCatalogEntry {
  variant: SandboxImageVariant;
  reference: string;
  status: SandboxImageStatus;
  sbomPath: string;
  scanAt: string;
  scanTool?: string;
  scanCritical?: number;
  scanHigh?: number;
  signature?: string | null;
  signatureIssuer?: string | null;
  waiverOwner?: string | null;
  waiverExpiresAt?: string | null;
  waiverReason?: string | null;
  previousReference?: string | null;
}

export interface SandboxImageCatalog {
  version?: number;
  images: SandboxImageCatalogEntry[];
}

export interface SandboxImageCatalogProblem {
  index: number;
  reference?: string;
  reason: string;
}

export class SandboxImageCatalogError extends Error {
  readonly code = "invalid_image_catalog";
  constructor(message: string, readonly problems: SandboxImageCatalogProblem[]) { super(message); }
}

/** Validates one entry without throwing; returns null when the entry is well formed. */
export function validateCatalogEntry(entry: unknown, index: number): SandboxImageCatalogProblem | null {
  const value = entry as Partial<SandboxImageCatalogEntry> | null;
  if (!value || typeof value !== "object") return { index, reason: "entry_must_be_an_object" };
  if (typeof value.reference !== "string") return { index, reason: "reference_is_required" };
  if (!SANDBOX_IMAGE_REFERENCE_PATTERN.test(value.reference)) {
    return { index, reference: value.reference, reason: "reference_must_be_digest_pinned" };
  }
  if (!value.variant || !SANDBOX_IMAGE_VARIANTS.includes(value.variant)) return { index, reference: value.reference, reason: "unknown_variant" };
  if (!value.status || !SANDBOX_IMAGE_STATUSES.includes(value.status)) return { index, reference: value.reference, reason: "unknown_status" };
  if (typeof value.sbomPath !== "string" || !value.sbomPath.length) return { index, reference: value.reference, reason: "sbom_path_is_required" };
  if (typeof value.scanAt !== "string" || Number.isNaN(Date.parse(value.scanAt))) return { index, reference: value.reference, reason: "scan_timestamp_is_required" };
  return null;
}

export function validateCatalog(catalog: SandboxImageCatalog): SandboxImageCatalogProblem[] {
  const problems: SandboxImageCatalogProblem[] = [];
  if (!Array.isArray(catalog.images)) return [{ index: -1, reason: "images_must_be_an_array" }];
  catalog.images.forEach((entry, index) => {
    const problem = validateCatalogEntry(entry, index);
    if (problem) problems.push(problem);
  });
  const seen = new Set<string>();
  catalog.images.forEach((entry, index) => {
    if (typeof entry?.reference !== "string") return;
    if (seen.has(entry.reference)) problems.push({ index, reference: entry.reference, reason: "duplicate_reference" });
    seen.add(entry.reference);
  });
  return problems;
}

export function parseCatalog(raw: string): SandboxImageCatalog {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { throw new SandboxImageCatalogError(`Image catalogue is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`, [{ index: -1, reason: "invalid_json" }]); }
  const catalog = parsed as SandboxImageCatalog;
  const problems = validateCatalog(catalog);
  if (problems.length) throw new SandboxImageCatalogError(`Image catalogue is invalid (${problems.length} problem(s))`, problems);
  return catalog;
}

/**
 * Reads the catalogue from disk. A missing or unreadable file is not an error: it yields an empty
 * catalogue and a log line, so a deployment that manages images purely through the API still works
 * (and admission stays deny-by-default regardless).
 */
export async function loadSandboxImageCatalog(filePath: string, log: (message: string, meta?: Record<string, unknown>) => void = () => undefined): Promise<SandboxImageCatalog> {
  try {
    const raw = await readFile(filePath, "utf8");
    const catalog = parseCatalog(raw);
    log("sandbox_image_catalog_loaded", { path: filePath, images: catalog.images.length });
    return catalog;
  } catch (error) {
    if (error instanceof SandboxImageCatalogError) { log("sandbox_image_catalog_invalid", { path: filePath, problems: error.problems }); throw error; }
    log("sandbox_image_catalog_unavailable", { path: filePath, reason: error instanceof Error ? error.message : "unknown" });
    return { images: [] };
  }
}

export function defaultCatalogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.NPATI_SANDBOX_IMAGE_CATALOG || "docker/sandbox/images.json";
}
