import { describe, expect, it } from "vitest";
import { classifyTerminalCommand } from "../apps/agent-api/src/terminal-command-policy";

const approval = (command: string) => classifyTerminalCommand(command).requiresApproval;

describe("quoted arguments in auto mode", () => {
  it("runs node -e and flutter create with a quoted description without approval", () => {
    expect(approval(`node -e "console.log(require('lodash/package.json').version)"`)).toBe(false);
    expect(approval(`node -p 'process.versions.node'`)).toBe(false);
    expect(approval(`flutter create --project-name flutter_todo_list --platforms web,android --description "Застосунок зі списком і формою" .`)).toBe(false);
  });
  it("still asks when the quotes hide shell expansion or chaining", () => {
    expect(approval(`node -e "console.log($(whoami))"`)).toBe(true);
    expect(approval("node -e \"`id`\"")).toBe(true);
    expect(approval(`node -e "1" && rm -rf /`)).toBe(true);
    expect(approval(`flutter create --description "x" ../outside`)).toBe(true);
    expect(approval(`flutter create . ; rm -rf ~`)).toBe(true);
  });
});
