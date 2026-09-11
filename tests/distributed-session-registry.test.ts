import { describe, expect, it, vi } from "vitest";
import { InMemoryActiveSessionRegistry } from "../apps/agent-api/src/distributed-session-registry";

describe("distributed active session registry", () => {
  it("atomically deduplicates a session and rejects a stale owner", async () => {
    const registry = new InMemoryActiveSessionRegistry();
    const first = await registry.acquire("workspace-a", "user-a", "session-0001", 45);
    expect(first).toBeDefined();
    expect(await registry.acquire("workspace-a", "user-a", "session-0001", 45)).toBeUndefined();
    expect(await registry.release("workspace-a", "user-a", { ...first!, connectionId: "stale-owner" })).toBe(false);
    expect(await registry.count("workspace-a", "user-a")).toBe(1);
    expect(await registry.release("workspace-a", "user-a", first!)).toBe(true);
    expect(await registry.count("workspace-a", "user-a")).toBe(0);
  });

  it("isolates identical session IDs by workspace and user", async () => {
    const registry = new InMemoryActiveSessionRegistry();
    expect(await registry.acquire("workspace-a", "user-a", "same-session", 45)).toBeDefined();
    expect(await registry.acquire("workspace-b", "user-a", "same-session", 45)).toBeDefined();
    expect(await registry.acquire("workspace-a", "user-b", "same-session", 45)).toBeDefined();
    expect(await registry.count("workspace-a", "user-a")).toBe(1);
    expect(await registry.count("workspace-b", "user-a")).toBe(1);
  });

  it("expires abandoned leases and sustains 10,000 distinct session records", async () => {
    vi.useFakeTimers();
    try {
      const registry = new InMemoryActiveSessionRegistry();
      const leases = await Promise.all(Array.from({ length: 10_000 }, (_, index) => registry.acquire("workspace-scale", "user-scale", `session-${index.toString().padStart(5, "0")}`, 45)));
      expect(leases.every(Boolean)).toBe(true);
      expect(await registry.count("workspace-scale", "user-scale")).toBe(10_000);
      await vi.advanceTimersByTimeAsync(45_001);
      expect(await registry.count("workspace-scale", "user-scale")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
