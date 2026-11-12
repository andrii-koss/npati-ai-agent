import { expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CodePreferencesStore } from "../apps/agent-api/src/code-preferences";

const ctx: AuthContext = { workspaceId: "w-hidden", userId: "u-hidden", permissions: ["workspace:read", "workspace:write"] };

// V6 step 04: external coding agents (Claude Code, Codex, …) are not connected to NPATI projects yet; choosing one only
// showed its name while Npati Code did the work. By default they cannot be enabled or activated, and an external agent
// saved earlier is read as Npati Code.
it("keeps Npati Code as the only coding agent while external agents are hidden", async () => {
  delete process.env.NPATI_EXTERNAL_CODING_AGENTS;
  const store = new InMemoryWorkspaceStore();
  const prefs = new CodePreferencesStore(store);
  await expect(prefs.setActiveAgent(ctx, "claude", "Claude Code")).rejects.toMatchObject({ status: 409, code: "EXTERNAL_CODING_AGENT_UNAVAILABLE" });
  await expect(prefs.toggleAgent(ctx, "codex", true)).rejects.toMatchObject({ code: "EXTERNAL_CODING_AGENT_UNAVAILABLE" });
  await expect(prefs.set(ctx, { activeAgentId: "claude" })).rejects.toMatchObject({ code: "EXTERNAL_CODING_AGENT_UNAVAILABLE" });
  await store.setUserSetting(ctx, "code.preferences", { activeAgentId: "claude", activeAgentName: "Claude Code", enabledAgentIds: ["npati", "claude"] }, 0);
  expect(await prefs.get(ctx)).toMatchObject({ activeAgentId: "npati", activeAgentName: "Npati Code", enabledAgentIds: ["npati"] });
  expect((await prefs.setActiveAgent(ctx, "npati")).activeAgentId).toBe("npati");
});
