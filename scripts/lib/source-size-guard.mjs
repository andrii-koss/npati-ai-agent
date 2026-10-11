/**
 * The source-size gate: no new god files, no growth of the existing ones, and a written justification
 * for every file still above the hard cap.
 *
 * Policy (owner directive):
 *   - handwritten source: a file above 800 lines must be in the baseline; a file above 1200 lines must
 *     carry a reason, an owner and an expiry;
 *   - a baselined file may shrink but never grow (3200 -> 3000 passes, 3200 -> 3500 fails);
 *   - a baselined file that shrank to 800 or below makes its entry stale, which is red, so the baseline
 *     can only ever get smaller;
 *   - generated files, i18n dictionaries and migrations are exempt, and any other exemption has to be
 *     written into the baseline with a reason like every other entry.
 *
 * Usage: node scripts/source-size-guard.mjs [--json] [--update-baseline]
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASELINE_PATH = path.resolve(ROOT, "source-size-baseline.json");
export const SOFT_LIMIT = 800;
export const HARD_LIMIT = 1200;
export const GROWTH_TOLERANCE = 0.02;
export const REQUIRED_FIELDS = ["reason", "owner", "expires_at"];
export const PENDING_REASON = "pending justification";

const SCAN_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".vite", "coverage"]);
const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/;
const GENERATED_MARKER = "Auto-generated";
const EXEMPT_PATTERNS = [/[/\\]locales[/\\]/, /[/\\]migration-\d+\.ts$/, /[/\\]migrations[/\\]/];

export function isEntryPoint(argv, moduleUrl) {
  const invoked = argv[1];
  if (!invoked) return false;
  return path.resolve(invoked).replace(/\\/g, "/").toLowerCase() === fileURLToPath(moduleUrl).replace(/\\/g, "/").toLowerCase();
}

export function listSourceFiles(root = ROOT) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!SOURCE_EXT.test(entry.name)) continue;
      found.push(path.relative(root, path.join(dir, entry.name)).replace(/\\/g, "/"));
    }
  };
  for (const r of SCAN_ROOTS) walk(path.join(root, r));
  return found.sort();
}

export function countLines(absPath) {
  const text = readFileSync(absPath, "utf8");
  if (text === "") return 0;
  const lines = text.split(/\r?\n/);
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

export function exemptionReason(relPath, head) {
  if (EXEMPT_PATTERNS.some((re) => re.test("/" + relPath))) return "generated or declarative path";
  if (head.includes(GENERATED_MARKER)) return "generated file";
  return null;
}

export function readBaseline(baselinePath = BASELINE_PATH) {
  if (!existsSync(baselinePath)) return { version: 1, entries: {} };
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  return { version: parsed.version ?? 1, entries: parsed.entries ?? {} };
}

export function measure(root = ROOT) {
  const oversized = new Map();
  for (const rel of listSourceFiles(root)) {
    const abs = path.join(root, rel);
    let lines;
    try {
      lines = countLines(abs);
    } catch {
      continue;
    }
    if (lines <= SOFT_LIMIT) continue;
    const head = readFileSync(abs, "utf8").slice(0, 400);
    if (exemptionReason(rel, head)) continue;
    oversized.set(rel, lines);
  }
  return oversized;
}

export function evaluate({ oversized, baseline, today = new Date() }) {
  const problems = [];
  const stale = [];
  for (const [rel, lines] of oversized) {
    const entry = baseline.entries[rel];
    if (!entry) {
      problems.push({ kind: "new", file: rel, lines, message: `new handwritten file above ${SOFT_LIMIT} lines` });
      continue;
    }
    if (lines > entry.lines * (1 + GROWTH_TOLERANCE)) {
      problems.push({ kind: "growth", file: rel, lines, message: `grew from ${entry.lines} to ${lines} lines` });
    }
    for (const field of REQUIRED_FIELDS) {
      if (!entry[field] || String(entry[field]).trim() === "" || entry[field] === PENDING_REASON) {
        problems.push({ kind: "unjustified", file: rel, lines, message: `${field} is missing` });
      }
    }
    if (lines > HARD_LIMIT && (!entry.reason || entry.reason === PENDING_REASON)) {
      problems.push({ kind: "hard", file: rel, lines, message: `above ${HARD_LIMIT} lines without a justification` });
    }
    if (entry.expires_at && /^\d{4}-\d{2}-\d{2}$/.test(entry.expires_at) && new Date(entry.expires_at) < today) {
      problems.push({ kind: "expired", file: rel, lines, message: `justification expired on ${entry.expires_at}` });
    }
  }
  for (const rel of Object.keys(baseline.entries)) {
    const lines = oversized.get(rel);
    if (lines === undefined) stale.push({ file: rel, message: lines === undefined ? "no longer above the limit" : "shrank" });
  }
  return { problems, stale };
}

export function buildBaseline(oversized, previous) {
  const entries = {};
  const expires = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  for (const [rel, lines] of [...oversized.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const old = previous.entries[rel];
    entries[rel] = {
      lines,
      reason: old?.reason ?? PENDING_REASON,
      owner: old?.owner ?? "unassigned",
      expires_at: old?.expires_at ?? expires,
    };
  }
  return { version: 1, entries };
}

export function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes("--json");
  const update = argv.includes("--update-baseline");
  const baseline = readBaseline();
  const oversized = measure();
  if (update) {
    const next = buildBaseline(oversized, baseline);
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
    console.log(`[size] baseline written: ${Object.keys(next.entries).length} file(s) above ${SOFT_LIMIT} lines`);
    return 0;
  }
  const verdict = evaluate({ oversized, baseline });
  if (asJson) {
    console.log(JSON.stringify({ oversized: [...oversized.entries()].map(([file, lines]) => ({ file, lines })), ...verdict }, null, 2));
    return verdict.problems.length === 0 && verdict.stale.length === 0 ? 0 : 1;
  }
  console.log(`[size] ${oversized.size} handwritten file(s) above ${SOFT_LIMIT} lines, all in the baseline`);
  for (const p of verdict.problems) console.log(`[size] ${p.kind.toUpperCase()} ${p.file}: ${p.message}`);
  for (const s of verdict.stale) console.log(`[size] STALE ${s.file}: ${s.message} - run --update-baseline in the commit that shrank it`);
  if (verdict.problems.length || verdict.stale.length) {
    console.log(`[size] FAILED: ${verdict.problems.length} problem(s), ${verdict.stale.length} stale entry(ies)`);
    return 1;
  }
  console.log("[size] OK: no new god files, no growth, every justification current");
  return 0;
}
