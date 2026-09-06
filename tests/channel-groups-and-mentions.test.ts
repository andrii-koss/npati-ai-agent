import { describe, expect, it } from "vitest";
import {
  ExternalChannelPluginLoader,
  GroupChatManager,
  MentionActivationRouter,
} from "../apps/agent-api/src/channel-groups-and-mentions";

describe("External Channel Plugin Loader (External channel plugins)", () => {
  it("loads 3rd party plugins and flags untrusted capability restrictions", () => {
    const loader = new ExternalChannelPluginLoader();

    const loadRes = loader.loadPlugin({
      id: "community-matrix-plugin",
      name: "Matrix Synapse Gateway",
      channel: "matrix",
      version: "0.9.1",
      requestedPermissions: ["network:outbound", "storage:read"],
      isTrusted: false,
    });

    expect(loadRes.success).toBe(true);
    expect(loadRes.warning).toContain("is untrusted");
    expect(loader.listPlugins().length).toBe(1);
  });
});

describe("Group Chat Manager (Group chat)", () => {
  it("manages multi-participant group threads and member participation", () => {
    const manager = new GroupChatManager();

    manager.createGroup("group-100", "telegram", "NPATI Architecture Discussion", ["user_1"]);

    manager.recordMessage("group-100", {
      messageId: "m1",
      senderId: "user_1",
      senderName: "Andrii",
      text: "Has anyone benchmarked Qdrant vs pgvector?",
    });

    manager.recordMessage("group-100", {
      messageId: "m2",
      senderId: "user_2",
      senderName: "Alex",
      text: "Yes, int8 quantization yields 4x memory reduction.",
    });

    const history = manager.getRecentHistory("group-100");
    expect(history.length).toBe(2);
    expect(history[0]!.senderName).toBe("Andrii");
    expect(history[1]!.senderName).toBe("Alex");
  });
});

describe("Mention Activation Router (Mention activation)", () => {
  it("activates only when explicitly mentioned or commanded in groups", () => {
    const config = {
      botName: "NPATI",
      botUsername: "npati_agent_bot",
      isDm: false,
      aliases: ["npati_ai"],
    };

    // Random noise message in group -> IGNORED
    const noise = MentionActivationRouter.evaluate("What is the weather today?", config);
    expect(noise.activates).toBe(false);
    expect(noise.reason).toBe("ignored");

    // @mention -> ACTIVATES
    const mention = MentionActivationRouter.evaluate("@npati_agent_bot summarize recent commits", config);
    expect(mention.activates).toBe(true);
    expect(mention.reason).toBe("explicit_mention");
    expect(mention.strippedPrompt).toBe("summarize recent commits");

    // Command prefix -> ACTIVATES
    const cmd = MentionActivationRouter.evaluate("/deploy staging", config);
    expect(cmd.activates).toBe(true);
    expect(cmd.reason).toBe("command_prefix");
    expect(cmd.strippedPrompt).toBe("staging");

    // Name callout -> ACTIVATES
    const callout = MentionActivationRouter.evaluate("NPATI: check system status", config);
    expect(callout.activates).toBe(true);
    expect(callout.reason).toBe("name_callout");
    expect(callout.strippedPrompt).toBe("check system status");
  });
});
