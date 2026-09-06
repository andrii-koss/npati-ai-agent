import { describe, expect, it } from "vitest";
import {
  SystemVersionManager,
  XSearchEngine,
  OfficialChannelPluginRegistry,
} from "../apps/agent-api/src/versioning-xsearch-channel-plugins";

describe("System Version Manager (Version manager)", () => {
  it("returns current runtime version and checks update channels", () => {
    const versionManager = new SystemVersionManager();

    const info = versionManager.getVersion();
    expect(info.version).toBe("3.8.50");
    expect(info.schemaVersion).toBe(12);

    const update = versionManager.checkUpdate("stable");
    expect(update.hasUpdate).toBe(true);
    expect(update.latestVersion).toBe("3.8.52");
    expect(update.releaseNotes).toContain("v3.8.52");
  });
});

describe("X Search Engine (X search)", () => {
  it("queries real-time posts and applies engagement filters", () => {
    const engine = new XSearchEngine();

    const result = engine.search("autonomous agents", { minLikes: 50, maxResults: 2 });
    expect(result.query).toBe("autonomous agents");
    expect(result.posts.length).toBeGreaterThanOrEqual(1);
    expect(result.posts[0]!.authorHandle).toContain("@");
    expect(result.posts[0]!.likes).toBeGreaterThanOrEqual(50);
    expect(result.trendingTopics.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Official Channel Plugin Registry (Official channel plugins)", () => {
  it("verifies and registers certified channel plugins", () => {
    const registry = new OfficialChannelPluginRegistry();

    const slackPlugin = registry.register({
      id: "official-slack-plugin",
      name: "Slack Enterprise Connect",
      channel: "slack",
      version: "1.2.0",
      certifiedSignature: "npati_cert_sig_9f8e7d6c5b4a3f2e1d0c",
      permissions: ["channels:read", "chat:write"],
    });

    expect(slackPlugin.status).toBe("verified");
    expect(slackPlugin.channel).toBe("slack");

    const retrieved = registry.getPlugin("official-slack-plugin");
    expect(retrieved?.name).toBe("Slack Enterprise Connect");
  });
});
