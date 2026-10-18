import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const STATUSES = ["Verified", "Partial", "Broken", "Missing", "Not Verified", "Blocked", "Unassessed"];
const ROOT = "docs/coding-agent";
const PLAN = ROOT + "/PLAN.md";
const REVIEW = ROOT + "/plan-verification-evidence.json";
const MATRIX = ROOT + "/plan-verification-matrix";
const sha = value => createHash("sha256").update(value).digest("hex");
const stages = /^(C\d+[a-z]?|G1|R1)$/;
const labels = /^(?:\u0417\u0440\u043e\u0431\u0438\u0442\u0438|\u0422\u0415\u0421\u0422\u0418|\u041a\u0420\u0418\u0422\u0415\u0420\u0406\u0407|\u041d\u0415 \u0420\u041e\u0411\u0418\u0422\u0418|\u0417\u0410\u0412\u0414\u0410\u041d\u041d\u042f)/;

// Keep inline code, quoted examples and parenthetical qualifications together.
// Every leaf retains its complete source statement, so fragments never lose their scope.
export function splitObligations(text) {
  const parts = [];
  let start = 0, depth = 0, code = false, quote = "";
  const flush = end => {
    const part = text.slice(start, end).trim().replace(/^[,;]\s*/, "");
    if (part) parts.push(part);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\u0060" && !quote) { code = !code; continue; }
    if (code) continue;
    if (quote) { if (c === quote && text[i - 1] !== "\\") quote = ""; continue; }
    if ((c === '"' || c === "\u00ab") && (i === 0 || /[\s(:]/.test(text[i - 1]))) {
      quote = c === "\u00ab" ? "\u00bb" : c; continue;
    }
    if (c === "(" || c === "[") { depth++; continue; }
    if (c === ")" || c === "]") { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    const punctuation = c === ";" || c === "," || (/[.!?]/.test(c) && /\s/.test(text[i + 1] ?? "") &&
      /[A-Z\u0410-\u042f\u0406\u0407\u0404\u0490]/u.test(text.slice(i + 1).trimStart()[0] ?? ""));
    const conjunction = /^ (?:\u0456|\u0442\u0430|and) /u.exec(text.slice(i));
    if (punctuation || conjunction) {
      flush(i);
      start = i + (conjunction ? conjunction[0].length : 1);
      if (conjunction) i = start - 1;
    }
  }
  flush(text.length);
  return parts;
}

export function extractPlan(text) {
  const lines = text.split(/\r?\n/);
  const entries = [], coverage = [];
  let section = "Preamble", stage = "GLOBAL", kind = "context", subsection = "scope";
  const sectionIds = new Map();
  for (const [index, raw] of lines.entries()) {
    const line = index + 1, s = raw.trim().replace(/^>\s?/, "");
    const ignored = reason => coverage.push({ line, disposition: "structure", reason });
    if (!s) { ignored("blank"); continue; }
    if (/^>/.test(raw.trim()) && !/Architecture reaffirmed|shared\/self-hosted|about one Docker|specification\. This audit preserves/.test(s)) { ignored("historical audit pointer; not a PLAN requirement"); continue; }
    if (/^#{1,6} /.test(s)) {
      section = s.replace(/^#+ /, "");
      stage = /^## (C\d+[a-z]?|G1|R1)\./.exec(s)?.[1] ?? "GLOBAL";
      if (!sectionIds.has(section)) sectionIds.set(section, sectionIds.size + 1);
      subsection = "scope";
      ignored("heading"); continue;
    }
    if (/^\u0060{3,}|^---+$|^\|[\s:|-]+\|$/.test(s)) { ignored("fence or table separator"); continue; }
    if (/^\|.*\|$/.test(s) && /\u0421\u043a\u043b\u0430\u0434\u043e\u0432\u0430|\u041f\u0430\u0440\u0430\u043c\u0435\u0442\u0440/.test(s)) { ignored("table heading"); continue; }
    if (/^[AB\u0043]\. /.test(s) && !/\d/.test(s)) { subsection = s; ignored("subsection heading"); continue; }
    if (/^\u0422\u0415\u0421\u0422\u0418/.test(s)) subsection = "tests";
    if (/^\u041a\u0420\u0418\u0422\u0415\u0420\u0406\u0407/.test(s)) subsection = "acceptance";
    if (/^\u0417\u0440\u043e\u0431\u0438\u0442\u0438/.test(s)) subsection = "implementation";
    if (/^[^:]+:\s*$/.test(s) && (labels.test(s) || s.length < 100)) { ignored("section label"); continue; }
    kind = subsection === "tests" ? "test" : subsection === "acceptance" ? "acceptance" :
      stages.test(stage) ? "implementation" : "cross-cutting";
    const text = s.replace(/^(?:\d+|[a-o])\.\s+|^[-*]\s+/u, "");
    const parts = /^\|/.test(s) ? [text] : splitObligations(text);
    const ids = [];
    for (const [part, obligation] of parts.entries()) {
      const id = stage + ".L" + String(line).padStart(4, "0") + "." + String(part + 1).padStart(2, "0");
      ids.push(id);
      entries.push({ id, stage, section, kind, line, source: raw, obligation,
        optional: /\u043e\u043f\u0446\u0456\u0439\u043d|\u0437\u0430 \u043c\u043e\u0436\u043b\u0438\u0432\u043e\u0441\u0442\u0456/iu.test(obligation) });
    }
    coverage.push({ line, disposition: "requirements", ids });
  }
  return { schemaVersion: 1, planSha256: sha(text), lines: lines.length, stages: [...new Set(entries.map(e => e.stage).filter(s => s !== "GLOBAL"))],
    countingRule: "Source occurrences; split independent top-level comma/semicolon/sentence/conjunction clauses. Inline code, quotations and parenthetical qualifiers retain their source context. No deduplication across repeated normative sections. Source anchors and full original statements are retained for every leaf.",
    entries, coverage };
}

const reviewCache = () => ({ hashes: new Map(), reports: new Map(), stamps: new Map() });
const fileStamp = file => { const stat = fs.statSync(file); return [stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); };
function readStableEvidence(file, cache) {
  const before = fileStamp(file), bytes = fs.readFileSync(file);
  if (fileStamp(file) !== before) throw new Error("Evidence changed during verification: " + file);
  cache.stamps.set(file, before);
  return bytes;
}

export function validateReview(entry, review, cache = reviewCache()) {
  if (!STATUSES.includes(review.status) || review.status === "Unassessed") throw new Error(entry.id + ": invalid status");
  if (!review.observation || !Array.isArray(review.implementation) || !Array.isArray(review.checks))
    throw new Error(entry.id + ": incomplete individual assessment");
  for (const file of review.implementation) if (!fs.existsSync(file.path)) throw new Error(entry.id + ": missing implementation " + file.path);
  if (review.status === "Blocked" && !review.blocker) throw new Error(entry.id + ": missing concrete blocker");
  if (review.status === "Verified") for (const file of review.implementation) {
    if (!cache.hashes.has(file.path)) cache.hashes.set(file.path, sha(readStableEvidence(file.path, cache)));
    if (!file.sha256 || file.sha256 !== cache.hashes.get(file.path)) throw new Error(entry.id + ": implementation changed or hash missing");
  }
  if (review.status === "Verified" && (!review.implementation.length || !review.checks.length || review.remaining?.length))
    throw new Error(entry.id + ": Verified needs exact source/check evidence and no remaining obligations");
  for (const check of review.checks) {
    if (!check.path || !fs.existsSync(check.path)) throw new Error(entry.id + ": missing check artifact");
    if (check.assertion) {
      if (!cache.reports.has(check.path)) cache.reports.set(check.path, JSON.parse(readStableEvidence(check.path, cache).toString("utf8").replace(/^\uFEFF/, "")));
      const result = cache.reports.get(check.path);
      const matches = result.testResults?.flatMap(suite => suite.assertionResults).filter(a => a.fullName === check.assertion);
      if (matches?.length !== 1 || matches[0].status !== "passed") throw new Error(entry.id + ": assertion is not uniquely passed");
    } else if (review.status === "Verified" && check.kind !== "inspection") throw new Error(entry.id + ": exact passed assertion required");
  }
}

const escape = value => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", "<br>");
export function generatePlanVerification() {
  const extracted = extractPlan(fs.readFileSync(PLAN, "utf8"));
  const review = fs.existsSync(REVIEW) ? JSON.parse(fs.readFileSync(REVIEW, "utf8")) :
    { schemaVersion: 1, planSha256: extracted.planSha256, assessments: {} };
  if (review.planSha256 !== extracted.planSha256) throw new Error("PLAN changed: rebase source anchors explicitly before carrying assessments forward");
  const byId = new Map(extracted.entries.map(e => [e.id, e]));
  const cache = reviewCache();
  for (const [id, assessment] of Object.entries(review.assessments)) {
    const entry = byId.get(id); if (!entry) throw new Error("Unknown assessment " + id);
    validateReview(entry, assessment, cache);
  }
  for (const [file, stamp] of cache.stamps) if (fileStamp(file) !== stamp) throw new Error("Evidence changed during verification: " + file);
  const entries = extracted.entries.map(entry => ({ ...entry,
    status: review.assessments[entry.id]?.status ?? "Unassessed",
    reviewed: !!review.assessments[entry.id],
    assessment: review.assessments[entry.id] ?? null }));
  const totals = Object.fromEntries(STATUSES.map(s => [s, entries.filter(e => e.status === s).length]));
  if (Object.values(totals).reduce((a, b) => a + b, 0) !== entries.length) throw new Error("Status conservation failure");
  const result = { ...extracted, sourceStatements: new Set(entries.map(e => e.line)).size, acceptanceStatements: new Set(entries.filter(e => e.kind === "acceptance").map(e => e.line)).size, countsByStage: Object.fromEntries(["GLOBAL", ...extracted.stages].map(stage => [stage, entries.filter(e => e.stage === stage).length])), entries, totals, reviewed: entries.filter(e => e.reviewed).length, independentlyReviewed: entries.filter(e => e.assessment?.independentReview === true).length, generatedAt: new Date().toISOString() };
  fs.writeFileSync(REVIEW, JSON.stringify(review, null, 2) + "\n");
  fs.writeFileSync(MATRIX + ".json", JSON.stringify(result, null, 2) + "\n");
  const out = ["# Individual PLAN verification matrix", "",
    "Source of requirements: [PLAN.md](PLAN.md). This continues the existing audit. Prior stage labels, file presence and whole-suite passes do not certify individual requirements.", "",
    "Plan SHA-256: " + extracted.planSha256, "", extracted.countingRule, "",
    "Total: **" + entries.length + "**; individually assessed records: **" + result.reviewed + "**; independently reassessed in this continuation: **" + result.independentlyReviewed + "**; stages: **" + extracted.stages.length + "**.", "",
    "Earlier assessments are retained as evidence history. Their presence is not a claim that this continuation independently rechecked them. The independentReview field identifies current reassessments; changed Verified implementation fingerprints are not carried forward automatically.", "",
    "| Status | Count |", "| --- | ---: |", ...STATUSES.map(s => "| " + s + " | " + totals[s] + " |"), "",
    "Unassessed means no individual assessment; Not Verified means assessed with insufficient proof. The statuses are disjoint. Optional requirements remain in the denominator. Repeated requirements remain separately addressable; shared evidence is cited explicitly. Stage-local implementation restrictions are not interpreted as bans on later stages.", "",
    "| ID / PLAN | Requirement / source context | Implementation | Observed state | Tests / executed check | Result | Problem | Required fix / remaining | Final status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const entry of entries) {
    const a = entry.assessment;
    out.push("| [" + entry.id + "](PLAN.md#L" + entry.line + ") | " + escape(entry.obligation) +
      "<br><details><summary>Source statement</summary>" + escape(entry.source) + "</details> | " +
      escape(a?.implementation.map(f => f.path + (f.symbol ? " :: " + f.symbol : "")).join("; ")) + " | " +
      escape(a?.observation ?? "Not individually inspected yet.") + " | " +
      escape(a?.checks.map(c => c.path + (c.assertion ? " :: " + c.assertion : "")).join("; ")) + " | " +
      escape(a?.result ?? "Pending individual assessment") + " | " + escape(a?.problem) + " | " +
      escape(a?.remaining?.join("; ") ?? a?.blocker ?? "") + " | " + entry.status + " |");
  }
  fs.writeFileSync(MATRIX + ".md", out.join("\n") + "\n");
  console.log(JSON.stringify({ requirements: entries.length, assessed: result.reviewed, stages: extracted.stages.length, totals }));
}
