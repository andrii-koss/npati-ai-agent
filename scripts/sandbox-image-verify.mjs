#!/usr/bin/env node
// C1b local guard: validates the sandbox image catalog and the Dockerfile variants WITHOUT Docker,
// syft, trivy or cosign. This is the check that must stay green on every commit and in CI.
//
// Usage: node scripts/sandbox-image-verify.mjs [--check|--require-verified] [--json]
//
// Exit codes: 0 = catalog is internally consistent (warnings allowed unless --require-verified),
//             1 = at least one hard violation.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  CATALOG_PATH, DIGEST_PATTERN, MAX_IMAGE_AGE_DAYS, ROOT, VALID_STATUSES, VARIANTS,
  ageDays, digestOf, dockerfileFor, error, log, parseArgs, readCatalog, warn,
} from "./sandbox-image-lib.mjs";

import { imageScanPolicyErrors } from "./lib/sandbox-image-scan-policy.mjs";

const { flags, values } = parseArgs();
const asJson = flags.has("json");
const requireVerified = flags.has("require-verified");
const catalogPath = values.get("catalog") ?? CATALOG_PATH;

const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);
const caution = (message) => warnings.push(message);

function verifyDockerfiles() {
  for (const variant of ["base", ...VARIANTS]) {
    const file = dockerfileFor(variant);
    if (!existsSync(file)) { fail(`missing Dockerfile for variant "${variant}": docker/sandbox/Dockerfile.${variant}`); continue; }
    const content = readFileSyncText(file);
    const fromLines = content.split(/\r?\n/).filter((line) => /^\s*FROM\s+/i.test(line));
    if (!fromLines.length) fail(`docker/sandbox/Dockerfile.${variant} has no FROM instruction`);
    for (const line of fromLines) {
      if (/:latest(\s|$)/i.test(line)) fail(`docker/sandbox/Dockerfile.${variant}: "FROM ${line.trim()}" uses the :latest tag`);
      const isArg = /\$\{?[A-Z_]+\}?/.test(line);
      const pinned = DIGEST_PATTERN.test(line.trim());
      if (!isArg && !pinned) fail(`docker/sandbox/Dockerfile.${variant}: "FROM ${line.trim()}" must be digest-pinned (repo@sha256:<64hex>)`);
      if (isArg && !/sha256:[0-9a-f]{64}/.test(content)) caution(`docker/sandbox/Dockerfile.${variant}: the ARG default is a placeholder digest; the build script must pass a resolved digest`);
    }
    if (!/^\s*USER\s+10001:10001\s*$/m.test(content)) fail(`docker/sandbox/Dockerfile.${variant} must end as USER 10001:10001`);
    if (/--privileged|docker\.sock/i.test(content)) fail(`docker/sandbox/Dockerfile.${variant} references privileged mode or the host docker socket`);
  }
}

function readFileSyncText(file) {
  // Comments are stripped so that documentation inside a Dockerfile (for example "no docker socket")
  // never trips the hardening checks.
  return readFileSync(file, "utf8").split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join("\n");
}

function verifyCatalog() {
  let catalog;
  try { catalog = readCatalog(catalogPath); }
  catch (cause) { fail(`cannot read ${catalogPath}: ${cause instanceof Error ? cause.message : cause}`); return; }

  if (catalog.schemaVersion !== 1) fail(`images.json schemaVersion must be 1, found ${JSON.stringify(catalog.schemaVersion)}`);
  if (!catalog.registry) fail("images.json must declare a registry");
  const images = Array.isArray(catalog.images) ? catalog.images : [];
  if (!images.length) fail("images.json contains no images");

  const seenIds = new Set();
  const seenDigests = new Set();
  const seenVariants = new Set();

  for (const entry of images) {
    const label = entry.id ?? entry.variant ?? "unknown entry";
    if (!entry.id) fail(`entry without id (variant ${entry.variant ?? "?"})`);
    if (seenIds.has(entry.id)) fail(`duplicate image id ${entry.id}`);
    seenIds.add(entry.id);
    if (!VARIANTS.includes(entry.variant)) fail(`${label}: unknown variant ${JSON.stringify(entry.variant)}`);
    seenVariants.add(entry.variant);
    if (!VALID_STATUSES.includes(entry.status)) fail(`${label}: invalid status ${JSON.stringify(entry.status)} (expected ${VALID_STATUSES.join(" | ")})`);

    if (typeof entry.reference !== "string" || !DIGEST_PATTERN.test(entry.reference)) {
      fail(`${label}: reference must be an immutable repo@sha256:<64 hex>, found ${JSON.stringify(entry.reference)}`);
    } else if (/:latest/i.test(entry.reference)) {
      fail(`${label}: reference must never use :latest`);
    }
    if (typeof entry.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.digest)) {
      fail(`${label}: digest must be sha256:<64 hex>, found ${JSON.stringify(entry.digest)}`);
    } else {
      if (seenDigests.has(entry.digest)) fail(`${label}: digest ${entry.digest} is reused by another entry`);
      seenDigests.add(entry.digest);
      const fromReference = digestOf(entry.reference);
      if (fromReference && fromReference !== entry.digest) fail(`${label}: digest ${entry.digest} does not match the digest inside the reference (${fromReference})`);
    }

    if (entry.previousReference) {
      if (!DIGEST_PATTERN.test(entry.previousReference)) fail(`${label}: previousReference must be digest-pinned for rollback`);
      if (/:latest/i.test(entry.previousReference)) fail(`${label}: previousReference must never use :latest`);
    }

    if (!entry.sbomPath) fail(`${label}: sbomPath is required`);
    else if (!existsSync(path.resolve(ROOT, entry.sbomPath))) {
      fail(`${label}: sbomPath ${entry.sbomPath} does not exist (run scripts/sandbox-image-sbom.mjs)`);
    }

    const scan = entry.scan ?? {};
    if (!Number.isInteger(scan.critical) || scan.critical < 0) fail(`${label}: scan.critical must be a non-negative integer`);
    if (!Number.isInteger(scan.high) || scan.high < 0) fail(`${label}: scan.high must be a non-negative integer`);
    if (typeof scan.at !== "string" || Number.isNaN(Date.parse(scan.at))) fail(`${label}: scan.at must be an ISO timestamp`);
    if (scan.critical > 0) fail(`${label}: scan.critical is ${scan.critical}; a critical finding blocks publishing`);
    if (scan.high > 0 && !entry.waiver) fail(`${label}: scan.high is ${scan.high} without a waiver (owner, reason, expiresAt)`);
    if (entry.waiver) {
      if (!entry.waiver.owner || !entry.waiver.reason || !entry.waiver.expiresAt) fail(`${label}: waiver must contain owner, reason and expiresAt`);
      else if (ageDays(entry.waiver.expiresAt) > 0) fail(`${label}: waiver expired at ${entry.waiver.expiresAt}`);
    }

    const signature = entry.signature ?? {};
    if (entry.status === "verified") {
      if (signature.tool !== "cosign") fail(`${label}: verified images must carry a cosign signature record`);
      if (!signature.identity || !signature.issuer) fail(`${label}: verified images must record the signing identity and issuer`);
      if (signature.issuer !== "https://token.actions.githubusercontent.com") caution(`${label}: unexpected OIDC issuer ${signature.issuer}`);
    }

    if (entry.status === "verified" || entry.status === "deprecated") {
      for (const problem of imageScanPolicyErrors(scan, entry.waiver, Date.now(), MAX_IMAGE_AGE_DAYS)) fail(label + ": " + problem);
      const age = ageDays(scan.at);
      if (!Number.isFinite(age)) fail(`${label}: scan.at is not a valid date`);
      else if (age > MAX_IMAGE_AGE_DAYS) fail(`${label}: last scan is ${Math.floor(age)} days old, older than the ${MAX_IMAGE_AGE_DAYS}-day policy (rescan required)`);
    }
    if (entry.status === "unverified") {
      const message = `${label}: status is "unverified" — the catalog entry is a placeholder and must not be wired into a deployment`;
      if (requireVerified) fail(message); else caution(message);
    }
    if (entry.status === "revoked") caution(`${label}: revoked images must not be referenced by new sessions (the runner refuses them)`);
  }

  for (const variant of VARIANTS) {
    if (!seenVariants.has(variant)) fail(`images.json has no entry for variant "${variant}" (docker/sandbox/Dockerfile.${variant} exists)`);
  }
}

verifyDockerfiles();
verifyCatalog();

if (asJson) {
  process.stdout.write(`${JSON.stringify({ ok: errors.length === 0, errors, warnings, maxImageAgeDays: MAX_IMAGE_AGE_DAYS }, null, 2)}\n`);
} else {
  for (const message of warnings) warn(message);
  for (const message of errors) error(message);
  log(`catalog: ${catalogPath}`);
  log(`age policy: ${MAX_IMAGE_AGE_DAYS} days; ${errors.length} error(s), ${warnings.length} warning(s)`);
  if (!errors.length) log(requireVerified ? "OK: every catalog entry is verified" : "OK: sandbox image catalog is consistent");
}
process.exit(errors.length ? 1 : 0);
