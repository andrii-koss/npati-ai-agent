import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createMockNpatiJwt, NpatiBackendAuthProvider } from "../apps/agent-api/src/auth";
import { InMemoryActiveSessionRegistry } from "../apps/agent-api/src/distributed-session-registry";
import { registerSessionStreamRoutes } from "../apps/agent-api/src/session-stream-routes";

describe("authenticated session stream routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  it("opens an SSE lease, blocks duplicates, isolates users, and cleans up disconnects", async () => {
    const secret = "scale-test-secret-at-least-thirty-two-characters";
    const registry = new InMemoryActiveSessionRegistry();
    const app = Fastify(); apps.push(app);
    registerSessionStreamRoutes(app, new NpatiBackendAuthProvider({ jwtSecret: secret }), registry);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const tokenA = createMockNpatiJwt({ userId: "scale-user-a" }, secret);
    const tokenB = createMockNpatiJwt({ userId: "scale-user-b" }, secret);
    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/sessions/session-0001/stream`, { headers: { authorization: `Bearer ${tokenA}` }, signal: controller.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const duplicate = await fetch(`${baseUrl}/sessions/session-0001/stream`, { headers: { authorization: `Bearer ${tokenA}` } });
    expect(duplicate.status).toBe(409);
    const otherUser = new AbortController();
    const isolated = await fetch(`${baseUrl}/sessions/session-0001/stream`, { headers: { authorization: `Bearer ${tokenB}` }, signal: otherUser.signal });
    expect(isolated.status).toBe(200);
    expect((await fetch(`${baseUrl}/sessions/active`, { headers: { authorization: `Bearer ${tokenA}` } }).then((r) => r.json()) as { activeSessions: number }).activeSessions).toBe(1);
    expect((await fetch(`${baseUrl}/sessions/active`)).status).toBe(401);
    controller.abort(); otherUser.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await fetch(`${baseUrl}/sessions/active`, { headers: { authorization: `Bearer ${tokenA}` } }).then((r) => r.json()) as { activeSessions: number }).activeSessions).toBe(0);
  });
});
