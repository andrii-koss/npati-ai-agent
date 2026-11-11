import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import { PolicyEngine, type PolicyEngineDeps } from "../apps/agent-api/src/code-policy-engine";
import { writesGitFromShell } from "../apps/agent-api/src/code-policy-git-and-approval";

// The company setting "let the agents act without asking": what it allows, and what still asks or stays denied.
const owner: AuthContext = { workspaceId: "ws", userId: "owner", permissions: ["workspace:read", "workspace:write", "admin:all"] };
const TOOLS = ["code.fs.write", "code.fs.delete", "code.shell.exec", "code.deps.add"];
function engine(autoAllow: boolean, overrides: Partial<PolicyEngineDeps> = {}) {
  const requested: unknown[] = [];
  const deps: PolicyEngineDeps = {
    flags: { async assertEnabled() { return true; } },
    capabilities: { get: (id: string) => TOOLS.includes(id) ? { id, status: "active", version: 1, ...(id === "code.fs.delete" || id === "code.deps.add" ? { requiresConfirmation: true } : {}) } : undefined },
    classifier: (command: string) => /rm -rf \//.test(command) ? { risk: "hard_deny" as const } : { risk: "approval" as const },
    approvals: { async requestApproval(_c: AuthContext, _co: string, input: Record<string, unknown>) { requested.push(input); return { id: "a" + requested.length }; }, async consumeApproved() { return {}; } },
    networkEnforcement: () => true,
    companyAutoAllow: async () => autoAllow,
    ...overrides,
  };
  return { policy: new PolicyEngine(deps), requested };
}

describe("company setting: act without asking", () => {
  it("allows terminal commands, file deletes and dependency changes without creating a request", async () => {
    const { policy, requested } = engine(true);
    for (const request of [
      { tool: "code.shell.exec", command: "npm run seed" },
      { tool: "code.fs.delete" },
      { tool: "code.deps.add" },
    ]) {
      expect(await policy.evaluate({ ctx: owner, companyId: "c", projectId: "p", sessionMode: "auto", ...request }))
        .toMatchObject({ decision: "allow", reasons: expect.arrayContaining(["approval:company_setting"]) });
    }
    expect(requested).toHaveLength(0);
  });

  it("asks as before when the setting is off", async () => {
    const { policy, requested } = engine(false);
    expect(await policy.evaluate({ ctx: owner, companyId: "c", projectId: "p", sessionMode: "auto", tool: "code.shell.exec", command: "npm run seed" }))
      .toMatchObject({ decision: "require_approval" });
    expect(requested).toHaveLength(1);
  });

  it("still asks before a git write made from the terminal", async () => {
    const { policy } = engine(true);
    for (const command of ["git push origin main", "git commit -am wip", "FOO=1 git push --force", "git reset --hard HEAD~1"]) {
      expect(await policy.evaluate({ ctx: owner, companyId: "c", projectId: "p", sessionMode: "auto", tool: "code.shell.exec", command }), command)
        .toMatchObject({ decision: "require_approval" });
    }
    expect(writesGitFromShell("git status")).toBe(false);
    expect(writesGitFromShell("npm test")).toBe(false);
  });

  it("never turns a hard deny, plan mode or a closed network gate into an allow", async () => {
    expect(await engine(true).policy.evaluate({ ctx: owner, companyId: "c", projectId: "p", sessionMode: "full_auto", tool: "code.shell.exec", command: "rm -rf /" }))
      .toMatchObject({ decision: "deny" });
    expect(await engine(true).policy.evaluate({ ctx: owner, companyId: "c", projectId: "p", sessionMode: "plan", tool: "code.fs.write" }))
      .toMatchObject({ decision: "deny", code: "session_mode_denied" });
    expect(await engine(true, { networkEnforcement: () => false }).policy.evaluate({ ctx: owner, companyId: "c", projectId: "p", sessionMode: "full_auto", tool: "code.shell.exec", command: "npm install left-pad" }))
      .toMatchObject({ decision: "deny", code: "network_enforcement_unavailable" });
  });

  it("counts a setting that cannot be read as off", async () => {
    const { policy } = engine(true, { companyAutoAllow: async () => { throw new Error("store down"); } });
    expect(await policy.evaluate({ ctx: owner, companyId: "c", projectId: "p", sessionMode: "auto", tool: "code.fs.delete" }))
      .toMatchObject({ decision: "require_approval" });
  });
});
