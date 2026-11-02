import { describe, expect, it, vi } from "vitest";
import { classifyTerminalCommand, normalizeTerminalCommand } from "../apps/agent-api/src/terminal-command-policy";
import { defaultRiskApprovalService } from "@npati/shared";
import { logTerminalPolicy } from "../apps/agent-api/src/terminal-policy-log";
import { classifyShellCommand } from "../apps/agent-api/src/code-shell-classifier";

describe("Project terminal command policy", () => {
  it.each(["npm install lodash --save", "npm install --save @types/node"])("keeps explicit npm default-save equivalent to bare install: %s", command => {
    expect(classifyTerminalCommand(command)).toMatchObject({ level: "controlled", requiresApproval: false });
    expect(classifyShellCommand(command)).toMatchObject({ risk: "controlled" });
  });
  it.each(["npm install lodash --save --global", "npm install lodash --save --prefix ../host", "npm install lodash --save --registry=https://untrusted.example", "npm install lodash --save --ignore-scripts=false"])("retains approval for extended save installs: %s", command => {
    expect(classifyTerminalCommand(command).requiresApproval).toBe(true);
    expect(classifyShellCommand(command).risk).toBe("approval");
  });
  it.each(["node -v", "node --version", "npm -v", "npm --version"])("allows the exact read-only version diagnostic %s", command => {
    expect(classifyTerminalCommand(command)).toMatchObject({ level: "safe", requiresApproval: false });
  });
  it.each(["node -v app.js", "node --version --require evil.js", "node -v && npm install", "./node -v", "npm --version install lodash"])("keeps extended version commands behind approval: %s", command => {
    expect(classifyTerminalCommand(command).requiresApproval).toBe(true);
  });
  it("redacts secrets in terminal policy diagnostics", () => {
    const previous = process.env.NPATI_TERMINAL_POLICY_LOG;
    process.env.NPATI_TERMINAL_POLICY_LOG = "true";
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      logTerminalPolicy({ rawCommand: "npm install --token=private-value", normalizedCommand: "npm install --token=private-value", rawArgs: ["--token=private-value"], projectId: "project-a", sandboxId: "sandbox-a", decision: "approval", reason: "test", policyRule: "test", toolName: "project.terminal.exec", executionContext: "project_agent", runId: "run-a", agentId: "agent-a", runType: "single" });
      const output = JSON.stringify(spy.mock.calls);
      expect(output).toContain("[terminal-policy]");
      expect(output).toContain("project-a");
      expect(output).not.toContain("private-value");
    } finally { spy.mockRestore(); if (previous === undefined) delete process.env.NPATI_TERMINAL_POLICY_LOG; else process.env.NPATI_TERMINAL_POLICY_LOG = previous; }
  });
  it("matches structured executable, args and sandbox cwd", () => {
    const normalized = normalizeTerminalCommand({ command: "npm", args: ["run", "dev", "--", "-H", "0.0.0.0"], cwd: "/workspace/site" });
    expect(normalized).toMatchObject({ command: "npm run dev -- -H 0.0.0.0", executable: "npm", cwd: "site" });
    expect(classifyTerminalCommand(normalized.command).requiresApproval).toBe(false);
    expect(classifyTerminalCommand({ command: "npm install", args: ["--no-audit"] }).requiresApproval).toBe(false);
    expect(classifyTerminalCommand("corepack pnpm install").requiresApproval).toBe(false);
    expect(classifyTerminalCommand("corepack yarn install").requiresApproval).toBe(false);
    expect(classifyTerminalCommand("corepack enable").requiresApproval).toBe(true);
    expect(classifyTerminalCommand("sh -c npm install").requiresApproval).toBe(true);
    expect(() => normalizeTerminalCommand({ command: "npm", args: ["run", "build;rm"] })).toThrow();
    expect(() => normalizeTerminalCommand({ command: "npm run build", cwd: "../host" })).toThrow();
  });
  it("keeps global host and system exec approval enabled", () => {
    expect(defaultRiskApprovalService.requiresApproval("exec")).toBe(true);
    expect(defaultRiskApprovalService.requiresApproval("system.eval")).toBe(true);
    expect(defaultRiskApprovalService.requiresApproval("project.terminal.exec")).toBe(true);
  });
  it.each(["ls", "pwd", "cat src/index.ts", "npm run build", "npm test", "pnpm run build", "yarn test", "git status", "git diff --stat"])("classifies %s as safe", (command) => {
    expect(classifyTerminalCommand(command)).toMatchObject({ level: "safe", requiresApproval: false });
  });
  it.each(["npm install", "npm ci", "pnpm install", "yarn install", "pip install requests", "composer install"])("classifies %s as controlled", (command) => {
    expect(classifyTerminalCommand(command)).toMatchObject({ level: "controlled", requiresApproval: false });
  });
  it.each(["npm run dev", "npm run start", "npm run dev -- --hostname 0.0.0.0 --port 3000", "pnpm dev -- --host 0.0.0.0", "yarn start", "npx next dev -H 0.0.0.0 -p 3000", "npx vite build", "npx --yes create-next-app@latest . --typescript --app --use-npm", "npx create-vite . --template react-ts", "node server.js"])("auto-approves sandbox web command %s", (command) => {
    expect(classifyTerminalCommand(command).requiresApproval).toBe(false);
  });
  it.each(["git push", "npm run deploy", "npm run migrate", "rm -rf /", "rm -rf ./", "curl https://unknown.example", "wget https://unknown.example", "a && rm -rf /", "npm test; rm -rf ./", "ls | sh", "echo $(rm -rf /)", "echo `rm -rf /`", "echo $SECRET", "A=1 npm test", "npm run build > /tmp/output", "ls\nrm -rf ./", "unknown-command", "sudo apt install docker", "docker run alpine", "npm run deploy", "npx next dev --script-shell /bin/sh", "node -e process.exit(1)"])("requires approval for %s", (command) => {
    expect(classifyTerminalCommand(command)).toMatchObject({ level: "approval", requiresApproval: true });
  });
  it("rejects empty and excessively long commands", () => {
    expect(() => classifyTerminalCommand("")).toThrow();
    expect(() => classifyTerminalCommand("a".repeat(5000))).toThrow();
  });
});
