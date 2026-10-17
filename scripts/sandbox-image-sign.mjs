#!/usr/bin/env node
// C1b: signs and verifies every catalog image with cosign (keyless, GitHub OIDC).
//
// Usage: node scripts/sandbox-image-sign.mjs [--variant node] [--all] [--dry-run] [--verify-only]
//
// A signature is only recorded — and the entry only becomes "verified" — after `cosign verify` passes
// with the expected identity and issuer, so a signature that does not match the workflow is rejected.
import {
  CATALOG_PATH, commandExists, error, log, parseArgs, readCatalog, requireTool, runTool, warn, writeCatalog,
} from "./sandbox-image-lib.mjs";

import { imageScanPolicyErrors } from "./lib/sandbox-image-scan-policy.mjs";

const { flags, values } = parseArgs();
const dryRun = flags.has("dry-run");
const verifyOnly = flags.has("verify-only");
const only = values.get("variant");
const all = flags.has("all") || !only;
const catalogPath = values.get("catalog") ?? CATALOG_PATH;
const catalog = readCatalog(catalogPath);
const targets = catalog.images.filter((entry) => all || entry.variant === only);

if (!targets.length) { error(`no catalog entry matches variant ${JSON.stringify(only)}`); process.exit(1); }
// Missing cosign is fatal for a real run; `--dry-run` only prints what would be signed and verified.
if (!requireTool("cosign", { dryRun, purpose: "sign and verify images" }) && !dryRun) process.exit(1);

let failures = 0;
let signed = 0;

for (const entry of targets) {
  const identity = entry.signature?.identity;
  const issuer = entry.signature?.issuer ?? "https://token.actions.githubusercontent.com";
  if (!identity) { error(`${entry.id}: signature.identity is required to verify the signer`); failures += 1; continue; }

  const verifyArgs = ["verify", "--certificate-identity", identity, "--certificate-oidc-issuer", issuer, entry.reference];
  if (dryRun) {
    log(`[dry-run] would run: cosign ${verifyArgs.join(" ")}`);
    if (!verifyOnly) log(`[dry-run] would run: cosign sign --yes ${entry.reference}`);
    continue;
  }

  const policyErrors = imageScanPolicyErrors(entry.scan, entry.waiver);
  if (entry.status === "revoked" || !entry.sbomPath || policyErrors.length) {
    error(entry.id + ": image is revoked or lacks valid SBOM/scan evidence (" + policyErrors.join(", ") + ")");
    failures += 1;
    continue;
  }
  let verified = runTool("cosign", verifyArgs, { allowFailure: true });
  if (!verified.ok && !verifyOnly) {
    log(`cosign sign --yes ${entry.reference}`);
    const signResult = runTool("cosign", ["sign", "--yes", entry.reference], { allowFailure: true });
    if (!signResult.ok) {
      error(`${entry.id}: cosign sign failed${signResult.unavailable ? " (cosign could not run)" : ` (exit ${signResult.code})`}`);
      failures += 1;
      continue;
    }
    signed += 1;
    verified = runTool("cosign", verifyArgs, { allowFailure: true });
  }
  if (!verified.ok) {
    error(`${entry.id}: cosign verify failed — refusing to mark the image verified`);
    failures += 1;
    continue;
  }
  entry.signature = { tool: "cosign", identity, issuer };
  // Only a scanned, signed image becomes verified; the scan step enforces critical=0 first.
  if (entry.scan?.critical === 0) entry.status = "verified";
  else warn(`${entry.id}: signature is valid but the scan has not passed, keeping status ${entry.status}`);
  log(`${entry.id}: signature verified`);
}

if (!dryRun) writeCatalog(catalog, catalogPath);
if (failures) { error(`${failures} image(s) failed signing or verification`); process.exit(1); }
log(`sign step finished for ${targets.length} image(s)${signed ? `, ${signed} newly signed` : ""}${dryRun ? " (dry-run)" : ""}`);
