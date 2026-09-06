export interface VersionInfo {
  version: string;
  schemaVersion: number;
  buildCommit: string;
  channel: "stable" | "beta" | "nightly";
  releaseDate: string;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string;
  migrationRequired: boolean;
}

export interface XPost {
  id: string;
  authorHandle: string;
  authorName: string;
  text: string;
  likes: number;
  retweets: number;
  createdAt: string;
  sentiment: "positive" | "neutral" | "negative";
}

export interface XSearchResult {
  query: string;
  posts: XPost[];
  trendingTopics: string[];
}

export interface OfficialChannelPlugin {
  id: string;
  name: string;
  channel: "whatsapp" | "slack" | "discord" | "msteams" | "webchat";
  version: string;
  certifiedSignature: string;
  permissions: string[];
  status: "verified" | "unverified";
}

export class SystemVersionManager {
  private readonly currentInfo: VersionInfo = {
    version: "3.8.50",
    schemaVersion: 12,
    buildCommit: "e5a8f2c",
    channel: "stable",
    releaseDate: "2026-09-02",
  };

  /**
   * 1. Version Manager: Manages semver releases, capabilities, and migrations
   */
  getVersion(): VersionInfo {
    return { ...this.currentInfo };
  }

  checkUpdate(channel: "stable" | "beta" | "nightly" = "stable"): UpdateCheckResult {
    const latestStable = "3.8.52";
    const current = this.currentInfo.version;

    const hasUpdate = this.compareSemver(latestStable, current) > 0;

    return {
      hasUpdate,
      currentVersion: current,
      latestVersion: hasUpdate ? latestStable : current,
      releaseNotes: hasUpdate
        ? "v3.8.52: Enhanced ACP protocol streaming and Qdrant int8 indexing performance."
        : "System is on the latest version.",
      migrationRequired: false,
    };
  }

  private compareSemver(v1: string, v2: string): number {
    const p1 = v1.split(".").map(Number);
    const p2 = v2.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      const a = p1[i] || 0;
      const b = p2[i] || 0;
      if (a > b) return 1;
      if (a < b) return -1;
    }
    return 0;
  }
}

export class XSearchEngine {
  /**
   * 2. X Search: Real-time search and social sentiment extraction
   */
  search(
    query: string,
    options: { maxResults?: number; minLikes?: number } = {}
  ): XSearchResult {
    const max = options.maxResults ?? 5;
    const minLikes = options.minLikes ?? 0;

    const mockPosts: XPost[] = [
      {
        id: "post_001",
        authorHandle: "@openclaw_dev",
        authorName: "OpenClaw Community",
        text: `Excited to see NPATI Agent integrating deep AI orchestration with ${query}!`,
        likes: 142,
        retweets: 38,
        createdAt: new Date().toISOString(),
        sentiment: "positive",
      },
      {
        id: "post_002",
        authorHandle: "@ai_engineer",
        authorName: "Tech Trends",
        text: `Benchmarking agent architectures for ${query}. Latency is critical.`,
        likes: 89,
        retweets: 12,
        createdAt: new Date().toISOString(),
        sentiment: "neutral",
      },
    ];

    const filtered = mockPosts.filter((p) => p.likes >= minLikes).slice(0, max);

    return {
      query,
      posts: filtered,
      trendingTopics: ["#AIAgents", "#NPATI", "#OpenClaw", "#OmniRoute"],
    };
  }
}

export class OfficialChannelPluginRegistry {
  private readonly plugins = new Map<string, OfficialChannelPlugin>();

  /**
   * 3. Official Channel Plugins: Verified channel connectors (WhatsApp, Slack, Discord)
   */
  register(plugin: {
    id: string;
    name: string;
    channel: "whatsapp" | "slack" | "discord" | "msteams" | "webchat";
    version: string;
    certifiedSignature: string;
    permissions: string[];
  }): OfficialChannelPlugin {
    // Verify certification signature (simulated verification)
    const isVerified =
      plugin.certifiedSignature.startsWith("npati_cert_sig_") &&
      plugin.certifiedSignature.length > 20;

    const record: OfficialChannelPlugin = {
      ...plugin,
      status: isVerified ? "verified" : "unverified",
    };

    this.plugins.set(plugin.id, record);
    return record;
  }

  listPlugins(): OfficialChannelPlugin[] {
    return Array.from(this.plugins.values());
  }

  getPlugin(id: string): OfficialChannelPlugin | undefined {
    return this.plugins.get(id);
  }
}
