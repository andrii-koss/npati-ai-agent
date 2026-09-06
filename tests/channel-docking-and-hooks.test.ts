import { describe, expect, it } from "vitest";
import {
  ChannelThreadDocker,
  PluginHookManager,
  InternalEventBus,
} from "../apps/agent-api/src/channel-docking-and-hooks";

describe("Channel Thread Docker (Channel Docking / Thread Binding)", () => {
  it("binds and resolves external channel threads to agent sessions", () => {
    const docker = new ChannelThreadDocker();

    const binding = docker.bindThread("telegram", "chat_987654_topic_42", "sess-alpha-001", {
      groupName: "NPATI Core Devs",
    });

    expect(binding.channel).toBe("telegram");
    expect(binding.sessionId).toBe("sess-alpha-001");

    const resolved = docker.resolveSession("telegram", "chat_987654_topic_42");
    expect(resolved).toBe("sess-alpha-001");

    const unbindRes = docker.unbindThread("telegram", "chat_987654_topic_42");
    expect(unbindRes).toBe(true);
    expect(docker.resolveSession("telegram", "chat_987654_topic_42")).toBeUndefined();
  });
});

describe("Plugin Hook Manager (Plugin Hooks)", () => {
  it("registers lifecycle hooks and executes pipeline modifications", async () => {
    const hookManager = new PluginHookManager();

    hookManager.registerHook("before_inference", "audit-plugin", (ctx: { prompt: string }) => {
      return { prompt: `[AUDITED] ${ctx.prompt}` };
    });

    hookManager.registerHook("before_inference", "tag-plugin", (ctx: { prompt: string }) => {
      return { prompt: `${ctx.prompt} [TAGGED]` };
    });

    const modified = await hookManager.executeHooks("before_inference", {
      prompt: "Hello assistant",
    });

    expect(modified.prompt).toBe("[AUDITED] Hello assistant [TAGGED]");
  });
});

describe("Internal Event Bus (Internal Hooks)", () => {
  it("emits events to prioritized internal listeners and supports unsubscription", () => {
    const bus = new InternalEventBus();
    const executionOrder: string[] = [];

    // Low priority listener (priority 0)
    bus.on("session:created", () => {
      executionOrder.push("normal-priority");
    }, 0);

    // High priority listener (priority 100)
    const unsubscribeHigh = bus.on("session:created", () => {
      executionOrder.push("high-priority");
    }, 100);

    bus.emit("session:created", { sessionId: "s-123" });
    expect(executionOrder).toEqual(["high-priority", "normal-priority"]);

    // Unsubscribe high priority
    unsubscribeHigh();
    executionOrder.length = 0;

    bus.emit("session:created", { sessionId: "s-456" });
    expect(executionOrder).toEqual(["normal-priority"]);
  });
});
