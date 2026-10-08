/**
 * TEMP debug (G1 item 5): what does `prepareTyposquatDataset` really write, and where?
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const { prepareTyposquatDataset } = await import("../scripts/lib/run-security-gate.mjs");

const root = mkdtempSync(path.join(tmpdir(), "npati-debug-"));
for (const file of [
  "scripts/typosquat-dataset-generate.mjs",
  "scripts/lib/typosquat-dataset-generate.mjs",
  "scripts/lib/run-security-gate.mjs",
]) {
  const target = path.join(root, ...file.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(path.join(ROOT, ...file.split("/"))), "utf8");
}
console.log("temp root:", root);
const direct = spawnSync(process.execPath, [path.join(root, "scripts", "typosquat-dataset-generate.mjs"), "--root", root], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
console.log("direct generator status:", direct.status, "error:", direct.error?.code ?? "none");
console.log("after direct run, scripts dir:", readdirSync(path.join(root, "data", "typosquat")).join(","));

rmSync(path.join(root, "data"), { recursive: true, force: true });
const preparation = prepareTyposquatDataset({ root });
console.log("preparation:", JSON.stringify({ ok: preparation.ok, generated: preparation.generated, reason: preparation.reason, missing: preparation.missing }));
console.log("temp tree top level:", readdirSync(root).join(","));
console.log("data exists:", readdirSync(path.join(root, "data"), { withFileTypes: true }).map((e) => e.name).join(","));
rmSync(root, { recursive: true, force: true });
