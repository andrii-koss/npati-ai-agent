import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const directory = "artifacts/coding-agent-audit-2026-10-15";
fs.mkdirSync(directory, { recursive: true });
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
if (!fs.existsSync(npmCli)) throw new Error("The installed npm CLI was not found beside Node");
const steps = [
  ["typecheck-tests", ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.tests.json"]],
  ["typecheck-workspaces", [npmCli, "run", "typecheck"]],
  ["lint", [npmCli, "run", "lint"]],
  ["build", [npmCli, "run", "build"]],
  ["security-gate", ["scripts/run-security-gate.mjs"]],
];
const exits = {}, detail = [];
for (const [name, args] of steps) {
  const startedAt = new Date().toISOString(), fd = fs.openSync(path.join(directory, name + "-current.log"), "w");
  let result;
  try { result = spawnSync(process.execPath, args, { stdio: ["ignore", fd, fd], timeout: 20 * 60 * 1000, windowsHide: true }); }
  finally { fs.closeSync(fd); }
  const exit = result.status ?? (result.error?.code ?? result.signal ?? "unknown_exit");
  exits[name] = exit;
  detail.push({ name, startedAt, finishedAt: new Date().toISOString(), exit, signal: result.signal });
  fs.writeFileSync(path.join(directory, "quality-continuation.json"), JSON.stringify(exits, null, 2));
  fs.writeFileSync(path.join(directory, "quality-current-detail.json"), JSON.stringify(detail, null, 2));
  if (name === "security-gate" && fs.existsSync("artifacts/security-gate-report.json"))
    fs.copyFileSync("artifacts/security-gate-report.json", path.join(directory, "security-gate-current.json"));
  console.log("[audit-quality] " + name + ": " + exit);
  if (exit !== 0) process.exit(1);
}
const sourceFiles = [
  "apps/agent-api/src/chat-turn.ts",
  "apps/agent-api/src/project-file-routes.ts", "apps/web/src/CodeWorkspacePage.tsx", "apps/web/src/code-workspace/actions.ts",
  "apps/web/src/code-workspace-page-types.ts", "apps/web/src/code-workspace/CodeWorkspaceHeader.tsx",
  "apps/web/src/code-workspace/CodeWorkspaceExecutionPanel.tsx", "apps/web/src/code-workspace/CodeWorkspaceFilePanel.tsx",
  "apps/agent-api/src/code-run-activity-sink.ts", "apps/agent-api/src/company-runtime-routes.ts",
  "apps/agent-api/src/business-profile-native.ts",
  "apps/agent-api/src/chat-routes.ts", "apps/agent-api/src/company-runtime.ts", "apps/agent-api/src/runtime-compat-routes.ts",
  "apps/agent-api/src/web-frontend.ts", "apps/agent-api/src/app-routes-and-lifecycle.ts",
  "apps/agent-api/src/chat-project-intent.ts", "apps/agent-api/src/chat-stream-routes.ts", "apps/agent-api/src/chat-stream-lease.ts",
  "apps/agent-api/src/company-chat-i18n.ts", "apps/agent-api/src/code-patch-transaction.ts", "apps/agent-api/src/code-tools-patch.ts",
  "apps/agent-api/src/code-tool-runtime.ts", "apps/agent-api/src/code-tool-runtime-write-guard.ts", "apps/agent-api/src/code-tool-executors-write.ts",
  "apps/agent-api/src/code-run-state.ts", "apps/agent-api/src/code-run-reconciler.ts", "apps/agent-api/src/coding-agent-runner.ts",
  "apps/agent-api/src/coding-agent-tool-waves.ts", "apps/agent-api/src/shared-project-runtime-provider.ts",
  "apps/agent-api/src/shared-project-runtime-server.ts", "apps/agent-api/src/sandbox-browser-qa.ts",
  "apps/agent-api/src/docker-sandbox-provider.ts", "apps/agent-api/browser-qa-runner.mjs", "apps/agent-api/project-runtime-launcher.mjs",
  "apps/agent-api/Dockerfile", "scripts/migration-registry-check.mjs",
];
fs.writeFileSync(path.join(directory, "quality-current-sources.json"), JSON.stringify(sourceFiles.map(file =>
  ({ file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") })), null, 2));
