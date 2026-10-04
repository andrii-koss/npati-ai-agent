import { describe, expect, it } from "vitest";
import { classifyTerminalCommand } from "../apps/agent-api/src/terminal-command-policy";
import { defaultRiskApprovalService } from "@npati/shared";

describe("Project terminal command policy", () => {
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
