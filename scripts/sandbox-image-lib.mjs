// Shared helpers for the C1b sandbox image toolchain.
//
// Everything here is plain Node (no TypeScript loader, no build step) because these scripts run in CI
// before any compilation, and because the local guard (`sandbox-image-verify.mjs`) must work in an
// environment without Docker, syft, trivy or cosign.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOG_PATH = path.join(ROOT, "docker", "sandbox", "images.json");
export const SBOM_DIR = path.join(ROOT, "docker", "sandbox", "sbom");
export const DOCKER_DIR = path.join(ROOT, "docker", "sandbox");

/** Variants that ship as images; the ids in images.json are `<id prefix>-<variant>-<generation>`. */
export const VARIANTS = ["node", "python", "php", "go", "rust", "java"];
export const VALID_STATUSES = ["unverified", "verified", "deprecated", "revoked"];
/** Rebuild/rescan window; the C1 configuration table uses the same default of 14 days. */
export const MAX_IMAGE_AGE_DAYS = Number.parseInt(process.env.NPATI_CODE_MAX_IMAGE_AGE_DAYS ?? "", 10) > 0
  ? Number.parseInt(process.env.NPATI_CODE_MAX_IMAGE_AGE_DAYS, 10)
  : 14;
export const DIGEST_PATTERN = /@sha256:[0-9a-f]{64}$/;

export function log(message) { process.stdout.write(`[sandbox-images] ${message}\n`); }
export function warn(message) { process.stdout.write(`[sandbox-images] WARN ${message}\n`); }
export function error(message) { process.stderr.write(`[sandbox-images] ERROR ${message}\n`); }

export function readCatalog(catalogPath = CATALOG_PATH) {
  return JSON.parse(readFileSync(catalogPath, "utf8"));
}

export function writeCatalog(catalog, catalogPath = CATALOG_PATH) {
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
}

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [name, inline] = token.slice(2).split("=");
    const next = argv[index + 1];
    if (inline !== undefined) values.set(name, inline);
    else if (next && !next.startsWith("--")) { values.set(name, next); index += 1; }
    else flags.add(name);
  }
  return { flags, values };
}

export function dockerfileFor(variant) {
  return path.join(DOCKER_DIR, `Dockerfile.${variant}`);
}

export function imageName(variant, registry) {
  return `${registry}/npati-sandbox-${variant}`;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isoNow(now = new Date()) {
  return now.toISOString();
}

export function ageDays(isoDate, now = new Date()) {
  const parsed = Date.parse(isoDate);
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - parsed) / 86_400_000;
}

export function digestOf(reference) {
  const match = /@(sha256:[0-9a-f]{64})$/.exec(reference ?? "");
  return match ? match[1] : null;
}

/**
 * Resolves an executable from PATH without spawning anything. Spawning is what can fail (EPERM under
 * a confined sandbox), so tool detection must never depend on it.
 */
export function commandExists(command) {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try { if (existsSync(candidate) && statSync(candidate).isFile()) return candidate; } catch { /* ignore unreadable PATH entries */ }
    }
  }
  return null;
}

/**
 * Runs an external tool. Never throws: a missing binary, a refused spawn (EPERM) or a non-zero exit
 * all come back as a structured result so callers can decide between a hard failure and `--dry-run`.
 */
export function runTool(command, args, { allowFailure = false } = {}) {
  if (!commandExists(command)) return { ok: false, unavailable: true, code: null, stdout: "", stderr: `${command} is not installed` };
  try {
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.error) return { ok: false, unavailable: true, code: null, stdout: "", stderr: String(result.error.message ?? result.error) };
    const ok = result.status === 0;
    if (!ok && !allowFailure) return { ok: false, unavailable: false, code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    return { ok, unavailable: false, code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    return { ok: false, unavailable: true, code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

/** Requires an external tool, honouring `--dry-run`: warns and continues in dry-run, fails otherwise. */
export function requireTool(command, { dryRun, purpose }) {
  if (commandExists(command)) return true;
  if (dryRun) { warn(`${command} is not installed; skipping ${purpose} (--dry-run)`); return false; }
  error(`${command} is required to ${purpose} but is not installed (or cannot be spawned in this environment)`);
  return false;
}

/** Deterministic fallback SBOM document, used when syft is unavailable. */
export function fallbackSbom({ id, variant, reference, digest }) {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `npati-sandbox-${variant}`,
    documentNamespace: `https://npati.ai/spdx/${id}/${digest.replace(":", "-")}`,
    creationInfo: {
      created: isoNow(),
      creators: ["Tool: npati-sandbox-image-sbom (fallback, syft unavailable)"],
      comment: "Placeholder SBOM: package inventory requires syft. Do not treat as a complete inventory.",
    },
    packages: [{
      SPDXID: "SPDXRef-Package-sandbox-image",
      name: reference,
      versionInfo: digest,
      downloadLocation: "NOASSERTION",
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      supplier: "Organization: NPATI",
      comment: "Container image reference; contents not enumerated in fallback mode.",
    }],
  };
}

export function sbomFiles() {
  try { return readdirSync(SBOM_DIR); } catch { return []; }
}

export function summarizeCatalog(catalog) {
  return (catalog.images ?? []).map((entry) => `${entry.id}(${entry.status})`).join(", ") || "empty";
}
