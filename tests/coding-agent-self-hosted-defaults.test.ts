import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import { FeatureFlagService, CODE_AGENT_SUB_FLAGS } from "../apps/agent-api/src/feature-flags";
import { NpatiBackendAuthProvider, createMockNpatiJwt } from "../apps/agent-api/src/auth";
import { InstallationAuthStore } from "../apps/agent-api/src/installation-auth";
import type { CodeSession } from "@npati/workspace";
import { CodeSessionRunExecutor } from "../apps/agent-api/src/code-session-run-executor";

const owner = { userId: "owner-1", workspaceId: "workspace:owner-1", permissions: ["owner", "admin:all", "workspace:write", "business:manage"] };

describe("self-hosted coding defaults and installation ownership", () => {
  it("enables stable coding features globally while experimental async inbox remains opt-in", async () => {
    const store = new InMemoryWorkspaceStore();
    const flags = new FeatureFlagService(store, undefined, { enabledByDefault: true });
    for (const key of ["coding_agent.enabled", ...CODE_AGENT_SUB_FLAGS, "code.model_profile.hosted-native-tools"]) {
      expect(await flags.isEnabled(owner, key, { companyId: "company-a" })).toBe(!["code.async_inbox", "code.async_processes", "code.async_subagents", "code.async_agent_control"].includes(key));
    }
    const described = await flags.describe(owner, { companyId: "company-a" });
    expect(described.master).toMatchObject({ enabled: true, scope: "global", source: "self_hosted_default" });
  });

  it("preserves explicit opt-outs and an immediate global kill switch", async () => {
    const store = new InMemoryWorkspaceStore();
    const flags = new FeatureFlagService(store, undefined, { enabledByDefault: true });
    await flags.setFlag(owner, { flagKey: "code.shell", scope: "global", stage: "off", enabled: false });
    expect(await flags.isEnabled(owner, "code.shell")).toBe(false);
    expect(await flags.isEnabled(owner, "code.read")).toBe(true);
    await flags.killSwitch(owner, {});
    expect(await flags.isEnabled(owner, "coding_agent.enabled")).toBe(false);
    expect(await flags.isEnabled(owner, "code.read")).toBe(false);
    const restarted = new FeatureFlagService(store, undefined, { enabledByDefault: true });
    expect(await restarted.isEnabled(owner, "code.write")).toBe(false);
  });

  it("keeps hosted defaults off", async () => {
    const flags = new FeatureFlagService(new InMemoryWorkspaceStore());
    expect(await flags.isEnabled(owner, "coding_agent.enabled")).toBe(false);
  });

  it("limits a company opt-out to that company without changing self-hosted global defaults", async () => {
    const flags = new FeatureFlagService(new InMemoryWorkspaceStore(), undefined, { enabledByDefault: true, allowPreGateRollout: true });
    await flags.setFlag(owner, { flagKey: "coding_agent.enabled", scope: "company", scopeId: "company-b", stage: "off", enabled: false });
    expect(await flags.isEnabled(owner, "code.write", { companyId: "company-a" })).toBe(true);
    expect(await flags.isEnabled(owner, "code.write", { companyId: "company-b" })).toBe(false);
    expect(await flags.isEnabled(owner, "code.write", { companyId: "company-c" })).toBe(true);
  });

  it("does not let a company enable bypass the global master kill switch", async () => {
    const flags = new FeatureFlagService(new InMemoryWorkspaceStore(), undefined, { enabledByDefault: true, allowPreGateRollout: true });
    await flags.setFlag(owner, { flagKey: "coding_agent.enabled", scope: "global", stage: "off", enabled: false });
    await flags.setFlag(owner, { flagKey: "coding_agent.enabled", scope: "company", scopeId: "company-a", stage: "ga", enabled: true });
    expect(await flags.isEnabled(owner, "code.write", { companyId: "company-a" })).toBe(false);
  });

  it("passes the user's selected model through the shared Workspace and chat executor", async () => {
    let selected: string | undefined;
    const executor = new CodeSessionRunExecutor({
      control: { clearSession() {}, registerController() {}, unregisterController() {} },
      resolveModel: async (ctx) => { expect(ctx.userId).toBe(owner.userId); return "openai/selected-model"; },
      runner: { run: async (input) => { selected = input.model; return { status: "completed" }; } },
    });
    const outcome = await executor.execute({ ctx: owner, session: { id: "session-1" } as CodeSession, prompt: "Inspect repository", cancelRequested: () => false });
    expect(outcome.terminalStatus).toBe("completed");
    expect(selected).toBe("openai/selected-model");
  });

  it("persists verified ownership, refuses a new claimant and retains it on disconnect", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "npati-owner-test-"));
    try {
      const store = new InstallationAuthStore(directory);
      expect(await store.bindOwner("owner-1")).toBe("owner-1");
      expect(await store.bindOwner("stranger")).toBe("owner-1");
      await store.clearAuthorization();
      expect((await new InstallationAuthStore(directory).load()).ownerUserId).toBe("owner-1");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("grants local administration only to the installation owner after JWT verification", async () => {
    const secret = "self-hosted-auth-test-secret";
    const auth = new NpatiBackendAuthProvider({ jwtSecret: secret, isInstallationOwner: async (id) => id === "owner-1" });
    const request = (id: string) => ({ headers: { authorization: `Bearer ${createMockNpatiJwt({ userId: id, role: "user" }, secret)}` } } as never);
    const localOwner = await auth.authenticate(request("owner-1"));
    expect(localOwner.permissions).toContain("admin:all");
    expect(localOwner.permissions).toContain("tools:execute");
    expect(localOwner.permissions).not.toContain("code.prod.operate");
    expect((await auth.authenticate(request("stranger"))).permissions).not.toContain("admin:all");
    await expect(auth.authenticate({ headers: { authorization: "Bearer invalid" } } as never)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });
});
