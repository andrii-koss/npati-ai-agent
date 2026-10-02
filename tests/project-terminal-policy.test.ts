import { describe, expect, it } from "vitest";
import { classifyTerminalCommand } from "../apps/agent-api/src/terminal-command-policy";

describe("Project terminal command policy", () => {
  it.each(["ls", "pwd", "cat src/index.ts", "npm run build", "npm test", "pnpm run build", "yarn test", "git status", "git diff --stat"])("classifies %s as safe", (command) => {
    expect(classifyTerminalCommand(command)).toMatchObject({ level: "safe", requiresApproval: false });
  });
  it.each(["npm install", "npm ci", "pnpm install", "yarn install", "pip install requests", "composer install"])("classifies %s as controlled", (command) => {
    expect(classifyTerminalCommand(command)).toMatchObject({ level: "controlled", requiresApproval: false });
  });
  it.each(["git push", "npm run deploy", "npm run migrate", "rm -rf /", "rm -rf ./", "curl https://unknown.example", "wget https://unknown.example", "a && rm -rf /", "npm test; rm -rf ./", "ls | sh", "echo $(rm -rf /)", "echo `rm -rf /`", "echo $SECRET", "A=1 npm test", "npm run build > /tmp/output", "ls\nrm -rf ./", "unknown-command"])("requires approval for %s", (command) => {
    expect(classifyTerminalCommand(command)).toMatchObject({ level: "approval", requiresApproval: true });
  });
  it("rejects empty and excessively long commands", () => {
    expect(() => classifyTerminalCommand("")).toThrow();
    expect(() => classifyTerminalCommand("a".repeat(5000))).toThrow();
  });
});
