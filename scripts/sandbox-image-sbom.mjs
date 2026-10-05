#!/usr/bin/env node
// C1b: generates an SBOM for every catalog image into docker/sandbox/sbom/.
//
// Usage: node scripts/sandbox-image-sbom.mjs [--variant node] [--all] [--dry-run] [--format spdx-json|cyclonedx-json]
//
// syft is used when present. Without it (or when spawning is refused) a deterministic fallback
// document is written and a warning is printed: the file records the image reference and digest but
// NOT the package inventory, so it must not be presented as a complete SBOM.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CATALOG_PATH, ROOT, SBOM_DIR, commandExists, error, fallbackSbom, log, parseArgs,
  readCatalog, requireTool, runTool, warn, writeCatalog,
} from "./sandbox-image-lib.mjs";

const { flags, values } = parseArgs();
const dryRun = flags.has("dry-run");
const all = flags.has("all") || !values.get("variant");
const only = values.get("variant");
const format = values.get("format") ?? "spdx-json";
const catalog = readCatalog(values.get("catalog") ?? CATALOG_PATH);
const useSyft = commandExists("syft");

if (!useSyft) requireTool("syft", { dryRun, purpose: "enumerate image packages" });

const targets = catalog.images.filter((entry) => all || entry.variant === only);
if (!targets.length) { error(`no catalog entry matches variant ${JSON.stringify(only)}`); process.exit(1); }

// `--dry-run` never touches the filesystem: it prints the syft commands and the entries that would get
// a fallback SBOM. In a real run the directory is created here (CI has a writable workspace).
if (dryRun) {
  for (const entry of targets) {
    log(useSyft
      ? `[dry-run] would run: syft ${entry.reference} -o ${format}=${entry.sbomPath}`
      : `[dry-run] syft is not installed; would write a fallback SBOM to ${entry.sbomPath}`);
  }
  log(`SBOM step planned for ${targets.length} image(s) (dry-run)`);
  process.exit(0);
}

mkdirSync(SBOM_DIR, { recursive: true });
let fallbacks = 0;

for (const entry of targets) {
  const file = path.resolve(ROOT, entry.sbomPath);
  mkdirSync(path.dirname(file), { recursive: true });
  if (useSyft && !dryRun) {
    log(`syft ${entry.reference} -> ${entry.sbomPath}`);
    const result = runTool("syft", [entry.reference, "-o", `${format}=${file}`]);
    if (!result.ok) {
      if (result.unavailable) warn(`syft could not run (${result.stderr.trim()}); using the fallback SBOM`);
      else { error(`syft failed for ${entry.id} (exit ${result.code}): ${result.stderr.trim().split("\n")[0] ?? ""}`); process.exit(1); }
    } else { continue; }
  } else if (useSyft && dryRun) {
    log(`[dry-run] would run: syft ${entry.reference} -o ${format}=${file}`);
    continue;
  }
  const document = fallbackSbom({ id: entry.id, variant: entry.variant, reference: entry.reference, digest: entry.digest });
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  entry.sbomPath = path.relative(ROOT, file).split(path.sep).join("/");
  fallbacks += 1;
  warn(`${entry.id}: wrote a fallback SBOM (no package inventory) to ${entry.sbomPath}`);
}

if (!dryRun && fallbacks) {
  writeCatalog(catalog, values.get("catalog") ?? CATALOG_PATH);
  warn(`${fallbacks} of ${targets.length} SBOM(s) are fallbacks; install syft to produce real inventories`);
}
log(`SBOM step finished for ${targets.length} image(s)${dryRun ? " (dry-run)" : ""}`);
