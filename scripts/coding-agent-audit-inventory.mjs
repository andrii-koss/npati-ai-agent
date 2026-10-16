/** Rebuilds the requirement inventory. A mapped file or passing suite never certifies a requirement. */
import fs from "node:fs";
import path from "node:path";

const sources = {
  C0: ["docs/coding-agent/00-audit.md", "docs/coding-agent/architecture.md"],
  C1: ["apps/agent-api/src/code-service.ts", "apps/agent-api/src/code-toolchain-detector.ts", "packages/workspace/src/types/code-session.ts"],
  C1a: ["apps/agent-api/src/feature-flags.ts", "apps/agent-api/src/code-tool-registry.ts"],
  C1b: ["apps/agent-api/src/sandbox-image-policy.ts", "apps/agent-api/src/sandbox-image-signature.ts"],
  C1c: ["apps/agent-api/src/audit-log.ts"],
  C2: ["apps/agent-api/src/code-tools-fs.ts", "apps/agent-api/src/code-tools-path.ts", "apps/agent-api/src/code-tool-runtime.ts"],
  C3: ["apps/agent-api/src/code-tool-runtime-write-guard.ts", "apps/agent-api/src/code-tools-write.ts", "apps/agent-api/src/code-tools-patch.ts", "apps/agent-api/src/code-patch-transaction.ts"],
  C4: ["apps/agent-api/src/code-shell-runtime.ts", "apps/agent-api/src/code-process-runtime.ts", "apps/agent-api/src/code-secret-lease.ts", "apps/agent-api/src/docker-sandbox-provider.ts", "apps/agent-api/src/shared-project-runtime-provider.ts"],
  C4a: ["apps/agent-api/src/code-deps-policy.ts", "apps/agent-api/src/code-deps-guard.ts", "apps/agent-api/src/code-deps-audit.ts"],
  C4b: ["apps/agent-api/src/sandbox-egress-enforcement.ts", "apps/agent-api/src/sandbox-egress-proxy.mjs", "apps/agent-api/src/ssrf-safe-http.ts"],
  C5: ["apps/agent-api/src/code-policy-engine.ts", "apps/agent-api/src/code-edit-approval.ts", "apps/agent-api/src/code-approval-scope.ts"],
  C5a: ["apps/agent-api/src/code-rbac.ts", "apps/agent-api/src/code-membership.ts", "apps/agent-api/src/code-prod-operations.ts"],
  C5b: ["apps/agent-api/src/provider-data-guard.ts", "apps/agent-api/src/provider-data-policy.ts", "apps/agent-api/src/provider-data-policy-service.ts"],
  C6: ["apps/agent-api/src/coding-agent-runner.ts", "apps/agent-api/src/coding-agent-tool-waves.ts", "apps/agent-api/src/code-tool-call-adapter.ts", "packages/omniroute-adapter/src/omniroute-engine.ts"],
  C6a: ["apps/agent-api/src/code-run-reconciler.ts", "apps/agent-api/src/code-reaper.ts", "apps/agent-api/src/code-migration-safety.ts"],
  C6b: ["apps/agent-api/src/execution-snapshot.ts", "apps/agent-api/src/code-replay-engine.ts", "apps/agent-api/src/code-replay-bundle.ts"],
  C7: ["apps/web/src/CodeWorkspacePage.tsx", "apps/agent-api/src/code-monitor-routes.ts", "apps/agent-api/src/code-project-lifecycle-routes.ts", "apps/agent-api/src/project-browser-qa-service.ts", "apps/agent-api/src/shared-project-runtime-provider.ts", "apps/agent-api/src/sandbox-browser-qa.ts"],
  G1: ["scripts/lib/run-security-gate.mjs", ".github/workflows/ci.yml", "docs/coding-agent/security-gate-report.md"],
  R1: ["apps/agent-api/src/code-run-queue.ts", "apps/agent-api/src/code-run-quota.ts", "apps/agent-api/src/sandbox-resource-quota.ts", "apps/agent-api/src/code-data-retention.ts", "apps/agent-api/src/code-data-erasure.ts"],
  C8: ["apps/agent-api/src/code-conversation-compaction.ts", "apps/agent-api/src/coding-agent-context-compactor.ts", "apps/agent-api/src/code-repo-map.ts", "apps/agent-api/src/code-instructions-loader.ts"],
  C9: ["apps/agent-api/src/code-verification-loop.ts", "apps/agent-api/src/code-self-review.ts", "apps/agent-api/src/code-plan-tool.ts"],
  C10: ["apps/agent-api/src/code-session-resume.ts", "apps/agent-api/src/code-session-rewind.ts", "apps/agent-api/src/code-background-run-routes.ts"],
  C11: ["apps/agent-api/src/code-git-workflow.ts", "apps/agent-api/src/code-protected-branches.ts"],
  C12: ["apps/agent-api/src/code-subagent-child-runner.ts", "apps/agent-api/src/code-subagent-limits.ts", "apps/agent-api/src/code-subagent-handoff.ts", "apps/agent-api/src/code-agent-spawn-executor.ts"],
  C13: ["apps/agent-api/src/code-hooks.ts", "apps/agent-api/src/code-commands.ts", "apps/agent-api/src/code-skills-instructions.ts", "apps/agent-api/src/mcp-run-path.ts"],
  C14: ["apps/agent-api/src/code-eval-harness.ts", "apps/agent-api/src/code-metrics.ts", "tests/fixtures/coding-agent-eval/tasks.json"],
  C15: ["apps/agent-api/src/mounted-workspace-provider.ts", "apps/agent-api/src/code-cli-run-routes.ts", "docs/coding-agent/ide-protocol.md"],
};
for (const [stage, files] of Object.entries(sources)) for (const file of files) if (!fs.existsSync(file)) throw new Error(`${stage}: missing evidence source ${file}`);
const lines = fs.readFileSync("docs/coding-agent/PLAN.md", "utf8").split(/\r?\n/);
const rows = []; let stage, category = "requirements", section = 0;
for (const [index, line] of lines.entries()) {
  const heading = /^## (C\d+[a-z]?|G1|R1)\./.exec(line);
  if (heading) { stage = heading[1]; category = "requirements"; section = 0; }
  else if (line.startsWith("## ")) stage = undefined;
  if (!stage) continue;
  if (/^(?:ТЕСТИ|КРИТЕРІЇ)/.test(line)) { category = line.startsWith("ТЕСТИ") ? "tests" : "acceptance"; section++; }
  const numbered = /^(\d+|[a-o])\.\s+(.+)$/.exec(line.trim());
  const bullet = /^- (.+)$/.exec(line);
  if (!numbered && !bullet) continue;
  rows.push({ stage, id: `${stage}.${category}.${section}.${numbered?.[1] ?? "bullet"}.${index + 1}`, line: index + 1,
    requirement: numbered?.[2] ?? bullet[1], status: "Untested", evidence: sources[stage],
    limitation: "Source mapped; this inventory does not certify individual runtime acceptance. See the audit report for executed checks and open blockers." });
}
const checkedRequirements = [{"stage":"C3","prefix":"code.fs.edit:","proof":"[file-safety-final.json](../../artifacts/coding-agent-audit-2026-10-15/file-safety-final.json)","limit":"Read-before-write and truncated-file refusal tested; full filesystem encoding/permission and live-agent editing acceptance not re-certified."},{"stage":"C3","prefix":"code.fs.apply_patch:","proof":"[patch recovery tests](../../tests/coding-agent-patch-recovery.test.ts)","limit":"Canonical/unified validation and compensating rollback tested. Arbitrary external-writer races and process-death atomicity remain open."},{"stage":"C3","prefix":"code.fs.move / code.fs.delete:","proof":"[C3 runtime tests](../../tests/coding-agent-c3-runtime.test.ts)","limit":"Patch deletion approval and payload binding tested. Full human UI move/delete flow not exercised."},{"stage":"C3","prefix":"Захист:","proof":"[C3 runtime tests](../../tests/coding-agent-c3-runtime.test.ts)","limit":"Patch scopes, sensitive/bulk targets and size limits tested. Full live filesystem attack campaign not certified."},{"stage":"C4","prefix":"code.shell.exec:","proof":"[real runner](../../artifacts/coding-agent-audit-2026-10-15/live-runtime.json)","limit":"Real commands/installs/builds/stdout/exit status on four stacks; entire persistent shell/env/TTY/timeout contract not re-certified."},{"stage":"C4","prefix":"code.shell.process.*:","proof":"[real runner](../../artifacts/coding-agent-audit-2026-10-15/live-runtime.json)","limit":"Four real servers, separate ports, HTTP previews and cleanup. Worker-death/long-session resource recovery remains open."},{"stage":"C6","prefix":"CodingAgentRunner:","proof":"[runner tests](../../tests/coding-agent-c6-runner.test.ts)","limit":"Actual runner with scripted provider validates tool-history correlation and bounded execution. No autonomous live-model task certified."},{"stage":"C6","prefix":"Умови зупинки:","proof":"[cancellation-trace.json](../../artifacts/coding-agent-audit-2026-10-15/cancellation-trace.json)","limit":"Stop/cancellation and late-response accounting tested with scripted provider. Live budget/provider cancellation campaign remains open."},{"stage":"C6","prefix":"Обробка помилок:","proof":"[runner tests](../../tests/coding-agent-c6-runner.test.ts)","limit":"Rejected/partial tool histories and correction budgets tested. Real streaming/provider failover without duplicate side effects not certified."},{"stage":"C6","prefix":"Інтеграція з Run/Activity:","proof":"[cancellation-trace.json](../../artifacts/coding-agent-audit-2026-10-15/cancellation-trace.json)","limit":"Late completed model calls close trace and account tokens. Lossless DB/SSE history across restart and all A–L remains untested."},{"stage":"C6a","prefix":"Reconciler при старті","proof":"[reconciler tests](../../tests/coding-agent-c6a-reconciler.test.ts)","limit":"Lease-claim, resumed-worker race and competing reconcilers tested. No real API/worker kill and PostgreSQL recovery drill."},{"stage":"C6b","prefix":"Підключення до C6:","proof":"[stop-condition tests](../../tests/coding-agent-c6-runner-stop-conditions.test.ts)","limit":"Configured snapshot persistence fails closed before provider/tools. Full deployed snapshot/replay/resume chain not certified."},{"stage":"C7","prefix":"Безпека UI:","proof":"[browser-contract-drill.json](../../artifacts/coding-agent-audit-2026-10-15/browser-contract-drill.json)","limit":"Actual Async Workspace component renders malicious output inert in Chromium with mocked HTTP. All Workspace surfaces and live transports not certified."}];
for (const check of checkedRequirements) {
  const matches = rows.filter(row => row.stage === check.stage && row.requirement.startsWith(check.prefix));
  if (matches.length !== 1) throw new Error("Ambiguous or missing audited requirement: " + check.stage + " / " + check.prefix);
  Object.assign(matches[0], { status: "Partial", auditEvidence: check.proof, limitation: check.limit });
}
const tests = fs.readdirSync("tests").filter(name => name.endsWith(".test.ts"));
const output = ["# Coding Agent requirement inventory — 2026-10-15", "", "This is a source-to-plan inventory, not a declaration of completion. `Untested` means the individual requirement has not been certified end to end in this audit. Stage test suites are supporting evidence, not substitutes for acceptance. `Partial` rows have explicit targeted evidence and an unresolved acceptance boundary. The current result and blockers are in [the audit report](2026-10-15-full-system-audit.md).", "", `Inventory: ${rows.length} numbered or bulleted plan entries across ${Object.keys(sources).length} stages. Shared rules, architecture decisions and unnumbered prose remain in PLAN.md; they are not falsely counted as independently verified here.`, ""];
for (const [id, files] of Object.entries(sources)) {
  output.push(`## ${id} evidence`, "", files.map(file => `[${path.basename(file)}](../../${file})`).join(", "), "");
  const prefix = new RegExp(`^coding-agent-${id.toLowerCase()}(?:-|\\.)`);
  const suites = tests.filter(file => prefix.test(file));
  output.push("Supporting suites: " + (suites.length ? suites.map(file => `[${file}](../../tests/${file})`).join(", ") : "No stage-named suite; see runtime acceptance and report."), "", "| PLAN line | Requirement | Status | Evidence / remaining boundary |", "| --- | --- | --- | --- |");
  for (const row of rows.filter(row => row.stage === id)) output.push(`| [${row.line}](PLAN.md) | ${row.requirement.replaceAll("|", "\\|")} | ${row.status} | ${row.auditEvidence ? row.auditEvidence + " — " + row.limitation.replaceAll("|", "\\|") : "Not individually certified."} |`);
  output.push("");
}
fs.writeFileSync("docs/coding-agent/2026-10-15-plan-inventory.md", output.join("\n"));
fs.mkdirSync("artifacts/coding-agent-audit-2026-10-15", { recursive: true });
fs.writeFileSync("artifacts/coding-agent-audit-2026-10-15/plan-inventory.json", JSON.stringify(rows, null, 2));
console.log(JSON.stringify({ entries: rows.length, stages: Object.keys(sources).length }));
