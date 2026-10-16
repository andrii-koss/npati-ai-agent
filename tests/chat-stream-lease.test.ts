import { afterEach, describe, expect, it, vi } from "vitest";
import { reserveChatStream } from "../apps/agent-api/src/chat-stream-lease";
import { InMemoryActiveSessionRegistry, type ActiveSessionRegistry } from "../apps/agent-api/src/distributed-session-registry";

const owner = { workspaceId: "ws", userId: "owner" };
afterEach(() => { vi.useRealTimers(); });
function fixture(registry: ActiveSessionRegistry = new InMemoryActiveSessionRegistry()) {
  const activeStreams = new Map();
  const controller = new AbortController();
  return { registry, activeStreams, controller, reserve: () => reserveChatStream({ owner, streamId: "stream-identity", controller, activeStreams, registry }) };
}

describe("security-gate: early chat stream ownership", () => {
  it("reserves local and distributed identity before work and releases once", async () => {
    const f = fixture();
    const release = await f.reserve();
    expect(f.activeStreams.get("stream-identity")?.controller).toBe(f.controller);
    expect(await f.registry.count(owner.workspaceId, owner.userId)).toBe(1);
    await expect(f.reserve()).rejects.toMatchObject({ code: "STREAM_ALREADY_ACTIVE", status: 409 });
    await release(); await release();
    expect(f.activeStreams.size).toBe(0);
    expect(await f.registry.count(owner.workspaceId, owner.userId)).toBe(0);
  });

  it("rejects another replica even when the local map is empty", async () => {
    const registry = new InMemoryActiveSessionRegistry();
    const first = fixture(registry), second = fixture(registry);
    const release = await first.reserve();
    await expect(second.reserve()).rejects.toMatchObject({ code: "STREAM_ALREADY_ACTIVE", status: 409 });
    expect(second.activeStreams.size).toBe(0);
    await release();
  });

  it("fails closed on coordination failure without leaving a local reservation", async () => {
    const registry = new InMemoryActiveSessionRegistry();
    vi.spyOn(registry, "acquire").mockRejectedValueOnce(new Error("Private Redis details"));
    const f = fixture(registry);
    await expect(f.reserve()).rejects.toMatchObject({ code: "CHAT_LEASE_UNAVAILABLE", status: 503 });
    expect(f.activeStreams.size).toBe(0);
  });

  it("bounds acquisition and releases a lease that arrives after the deadline", async () => {
    vi.useFakeTimers();
    const registry = new InMemoryActiveSessionRegistry();
    const acquire = registry.acquire.bind(registry);
    let complete!: (lease: Awaited<ReturnType<typeof acquire>>) => void;
    vi.spyOn(registry, "acquire").mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const release = vi.spyOn(registry, "release");
    const f = fixture(registry);
    const pending = expect(f.reserve()).rejects.toMatchObject({ code: "CHAT_LEASE_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(5001); await pending;
    expect(f.activeStreams.size).toBe(0);
    complete(await acquire(owner.workspaceId, owner.userId, "chat:stream-identity", 45));
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledOnce();
    expect(await registry.count(owner.workspaceId, owner.userId)).toBe(0);
  });

  it("renews during preflight and aborts if ownership is lost", async () => {
    vi.useFakeTimers();
    const registry = new InMemoryActiveSessionRegistry();
    vi.spyOn(registry, "renew").mockResolvedValueOnce(false);
    const f = fixture(registry), release = await f.reserve();
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.controller.signal.aborted).toBe(true);
    expect(f.controller.signal.reason).toMatchObject({ code: "CHAT_LEASE_LOST" });
    await release();
  });

  it("does not overlap stalled renewals and bounds cleanup", async () => {
    vi.useFakeTimers();
    const registry = new InMemoryActiveSessionRegistry();
    const renew = vi.spyOn(registry, "renew").mockImplementation(() => new Promise(() => undefined));
    const f = fixture(registry), release = await f.reserve();
    await vi.advanceTimersByTimeAsync(20001);
    expect(renew).toHaveBeenCalledOnce();
    expect(f.controller.signal.aborted).toBe(true);
    await release();
  });
});
