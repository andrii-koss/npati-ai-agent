#!/usr/bin/env node
// C1b: builds and pushes every sandbox image variant and records the REAL digest in images.json.
//
// Flow (each step is immutable once pushed):
//   1. resolve the upstream Node digest            -> docker buildx imagetools inspect node:24-alpine
//   2. build docker/sandbox/Dockerfile.base        -> push npati-sandbox-base
//   3. resolve the base image digest
//   4. build each variant with --build-arg BASE_IMAGE=<base>@sha256:<digest>, push, resolve its digest
//   5. update images.json (reference + digest + createdAt); status stays "unverified" until the scan
//      and sign steps pass, so a build can never publish an unverified image as usable
//
// Usage: node scripts/sandbox-image-build.mjs [--variant node] [--all] [--dry-run] [--no-push] [--update]
import { CATALOG_PATH, DOCKER_DIR, commandExists, dockerfileFor, error, imageName, isoNow, log, parseArgs, readCatalog, requireTool, runTool, warn, writeCatalog } from "./sandbox-image-lib.mjs";
import { readFileSync } from "node:fs";

const { flags, values } = parseArgs();
const dryRun = flags.has("dry-run");
const noPush = flags.has("no-push");
const update = flags.has("update") || !dryRun;
const only = values.get("variant");
const all = flags.has("all") || !only;
const catalogPath = values.get("catalog") ?? CATALOG_PATH;
const catalog = readCatalog(catalogPath);
const registry = values.get("registry") ?? catalog.registry;
const upstream = values.get("upstream") ?? "node:24-alpine";
/** Placeholder digests must never reach a push; kept in sync with the Dockerfile ARG defaults. */
const PLACEHOLDER_PATTERN = /^sha256:(0{64}|1af7aff2620bfaeedf260e2d9f3f1d495ee6a98a83d6ee6995db2bd62609aa13|98f001afad55538765b307c8fa65f07c0d1a9ec1620de77a1dcf08798363d8e3|6dcf3bf07318e8d2630881e8245fb9f0014bd633a910c93ef14d94e753f51e6a|924a23adb176f53ca1e84b8cf1440fa057dd1cd5de9463ed14d68b6d0e71e856|41c2090c79ea71eecebb48b391ae36aaddc4933bc98a573783fde09374073233|0022df4f6745117b8d904a7d503aa1248ef26919e49f9a3a21966aa456aac1ce)$/;

const targets = catalog.images.filter((entry) => all || entry.variant === only);
if (!targets.length) { error(`no catalog entry matches variant ${JSON.stringify(only)}`); process.exit(1); }
// Missing docker is fatal for a real build; `--dry-run` prints the plan and exits 0.
if (!requireTool("docker", { dryRun, purpose: "build and push sandbox images" }) && !dryRun) process.exit(1);

if (dryRun) {
  log(`[dry-run] registry: ${registry}`);
  log(`[dry-run] 1. resolve upstream digest: docker buildx imagetools inspect --format {{.Manifest.Digest}} ${upstream}`);
  log(`[dry-run] 2. build base: docker build -f docker/sandbox/Dockerfile.base --build-arg UPSTREAM_BASE=${upstream}@sha256:<digest> -t ${registry}/npati-sandbox-base:build docker/sandbox`);
  for (const entry of targets) {
    log(`[dry-run] 4. build ${entry.variant}: docker build -f ${dockerfileFor(entry.variant).replace(/\\/g, "/")} --build-arg BASE_IMAGE=${registry}/npati-sandbox-base@sha256:<digest> -t ${imageName(entry.variant, registry)} docker/sandbox${noPush ? " (no push)" : " && docker push"}`);
  }
  log(`[dry-run] 5. would update ${catalogPath} with the resolved digests`);
  process.exit(0);
}

function resolveDigest(reference) {
  const result = runTool("docker", ["buildx", "imagetools", "inspect", "--format", "{{.Manifest.Digest}}", reference], { allowFailure: true });
  if (!result.ok) return null;
  const digest = result.stdout.trim().split("\n").pop()?.trim();
  return /^sha256:[0-9a-f]{64}$/.test(digest ?? "") ? digest : null;
}

const upstreamDigest = resolveDigest(upstream);
if (!upstreamDigest) { error(`cannot resolve the digest of ${upstream}; refusing to build from a floating tag`); process.exit(1); }
log(`upstream ${upstream} -> ${upstreamDigest}`);

const baseTag = `${registry}/npati-sandbox-base:build`;
const baseBuild = runTool("docker", ["build", "-f", dockerfileFor("base"), "--build-arg", `UPSTREAM_BASE=${upstream}@${upstreamDigest}`, "-t", baseTag, DOCKER_DIR], { allowFailure: true });
if (!baseBuild.ok) { error(`base image build failed (exit ${baseBuild.code})`); process.exit(1); }
if (!noPush) {
  const basePush = runTool("docker", ["push", baseTag], { allowFailure: true });
  if (!basePush.ok) { error("base image push failed"); process.exit(1); }
}
const baseDigest = resolveDigest(baseTag);
if (!baseDigest) { error("cannot resolve the built base image digest; refusing to substitute the upstream image"); process.exit(1); }
if (PLACEHOLDER_PATTERN.test(baseDigest)) { error("resolved base digest is a placeholder; refusing to continue"); process.exit(1); }
log(`base ${baseTag} -> ${baseDigest}`);

let updatedCount = 0;
for (const entry of targets) {
  const name = imageName(entry.variant, registry);
  const build = runTool("docker", ["build", "-f", dockerfileFor(entry.variant), "--build-arg", `BASE_IMAGE=${registry}/npati-sandbox-base@${baseDigest}`, "-t", name, DOCKER_DIR], { allowFailure: true });
  if (!build.ok) { error(`${entry.id}: build failed (exit ${build.code})`); process.exit(1); }
  if (!noPush) {
    const push = runTool("docker", ["push", name], { allowFailure: true });
    if (!push.ok) { error(`${entry.id}: push failed`); process.exit(1); }
  }
  const digest = resolveDigest(name);
  if (!digest || PLACEHOLDER_PATTERN.test(digest)) { error(`${entry.id}: cannot resolve a real digest (got ${JSON.stringify(digest)}); images.json untouched`); process.exit(1); }
  entry.previousReference = entry.reference;
  entry.reference = `${name}@${digest}`;
  entry.digest = digest;
  entry.createdAt = isoNow();
  entry.status = "unverified";
  // A newly built digest has no scan or SBOM yet; evidence from its predecessor must never be reused.
  entry.scan = { tool: "pending", at: null, critical: null, high: null };
  entry.sbomPath = null;
  updatedCount += 1;
  log(`${entry.id}: ${entry.reference}`);
}

if (update) {
  writeCatalog(catalog, catalogPath);
  warn(`${updatedCount} entry/entries updated; run the scan and sign steps before the images can be marked verified`);
} else {
  log("catalog not written (pass --update)");
}

// The Dockerfile ARG defaults must stay honest placeholders; report them so the doc stays accurate.
const nodeDockerfile = readFileSync(dockerfileFor("node"), "utf8");
if (!/sha256:0{64}/.test(nodeDockerfile)) warn("docker/sandbox/Dockerfile.node no longer carries a placeholder digest; update docs/audit/coding-agent/sandbox-images.md");
if (!commandExists("docker")) warn("docker disappeared from PATH; state is inconsistent");
log(`build step finished for ${targets.length} image(s)`);
