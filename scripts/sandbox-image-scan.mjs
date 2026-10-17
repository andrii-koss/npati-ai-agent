#!/usr/bin/env node
// C1b: scans every catalog image and writes the result back into images.json.
//
// Policy: a CRITICAL finding fails the step (publishing is blocked). A HIGH finding also fails unless
// the catalog entry carries a waiver with an owner, a reason and an expiry date.
//
// Usage: node scripts/sandbox-image-scan.mjs [--variant node] [--all] [--dry-run] [--tool trivy|grype]
import {
  CATALOG_PATH, commandExists, error, isoNow, log, parseArgs, readCatalog, requireTool, runTool, warn, writeCatalog,
} from "./sandbox-image-lib.mjs";

import { parseScanJson, imageScanPolicyErrors } from "./lib/sandbox-image-scan-policy.mjs";
export { parseScanJson } from "./lib/sandbox-image-scan-policy.mjs";

const { flags, values } = parseArgs();
const dryRun = flags.has("dry-run");
const only = values.get("variant");
const all = flags.has("all") || !only;
const preferred = values.get("tool");
const tool = preferred ?? (commandExists("trivy") ? "trivy" : commandExists("grype") ? "grype" : "trivy");
const catalogPath = values.get("catalog") ?? CATALOG_PATH;
const catalog = readCatalog(catalogPath);
const targets = catalog.images.filter((entry) => all || entry.variant === only);

if (!targets.length) { error(`no catalog entry matches variant ${JSON.stringify(only)}`); process.exit(1); }
// A missing scanner is fatal for a real run (the image must not be published unscanned) but must not
// break `--dry-run`, which only prints the plan.
if (!requireTool(tool, { dryRun, purpose: "scan images for vulnerabilities" }) && !dryRun) process.exit(1);

let blocking = 0;
let updated = 0;

for (const entry of targets) {
  if (dryRun) {
    log(`[dry-run] would run: ${tool} image ${entry.reference} (fail on critical, waiver required for high)`);
    continue;
  }
  const args = tool === "trivy"
    ? ["image", "--quiet", "--format", "json", "--severity", "CRITICAL,HIGH", entry.reference]
    : ["image", entry.reference, "-o", "json", "-q"];
  log(`${tool} ${entry.reference}`);
  const result = runTool(tool, args, { allowFailure: true });
  if (!result.ok) { error(`${tool} could not run for ${entry.id}: ${result.stderr.trim()}`); blocking += 1; continue; }

  let counts;
  try { counts = parseScanJson(tool, result.stdout); }
  catch (cause) {
    error(`${entry.id}: cannot parse ${tool} output (${cause instanceof Error ? cause.message : cause}); treated as a blocking failure`);
    blocking += 1;
    continue;
  }

  entry.scan = { tool, at: isoNow(), critical: counts.critical, high: counts.high };
  updated += 1;
  const policyErrors = imageScanPolicyErrors(entry.scan, entry.waiver);
  if (policyErrors.length) {
    error(entry.id + ": scan policy refused publication (" + policyErrors.join(", ") + ")");
    blocking += 1;
    continue;
  }
  log(`${entry.id}: critical=0 high=${counts.high}${entry.waiver ? " (waived)" : ""}`);
}

if (updated && !dryRun) writeCatalog(catalog, catalogPath);
if (blocking) { error(`${blocking} image(s) failed the scan policy`); process.exit(1); }
log(`scan step finished for ${targets.length} image(s)${dryRun ? " (dry-run)" : ""}`);
