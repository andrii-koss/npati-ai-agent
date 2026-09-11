import { describe, expect, it, vi } from "vitest";
import { createMockNpatiJwt, NpatiBackendAuthProvider } from "../apps/agent-api/src/auth";

describe("authentication workspace initialization", () => {
  it("single-flights concurrent initialization for the same authenticated workspace", async () => {
    const secret = "single-flight-secret-at-least-thirty-two-characters";
    const initialize = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const provider = new NpatiBackendAuthProvider({ jwtSecret: secret, workspaceStore: { initialize } as never });
    const token = createMockNpatiJwt({ userId: "concurrent-user" }, secret);
    const request = { headers: { authorization: `Bearer ${token}` } } as never;
    const contexts = await Promise.all(Array.from({ length: 1_000 }, () => provider.authenticate(request)));
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(new Set(contexts.map((context) => context.workspaceId))).toEqual(new Set(["workspace:concurrent-user"]));
  });
});

  it("allows a later request to retry a failed initialization", async () => {
    const secret = "single-flight-retry-secret-thirty-two-characters";
    let calls = 0;
    const initialize = vi.fn(async () => { calls += 1; if (calls === 1) throw new Error("database unavailable"); });
    const provider = new NpatiBackendAuthProvider({ jwtSecret: secret, workspaceStore: { initialize } as never });
    const token = createMockNpatiJwt({ userId: "retry-user" }, secret);
    const request = { headers: { authorization: `Bearer ${token}` } } as never;
    await provider.authenticate(request);
    await provider.authenticate(request);
    expect(initialize).toHaveBeenCalledTimes(2);
  });
