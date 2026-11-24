import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { FixedWindowLimiter, registerSensitiveRateLimits } from "../apps/agent-api/src/sensitive-rate-limit";

/** Security audit 2026-11-24, L3: sensitive routes are rate limited per client address. */
describe("L3: sensitive route rate limits", () => {
  it("answers 429 with Retry-After once a client exceeds the route group's limit", async () => {
    const app = Fastify();
    registerSensitiveRateLimits(app, { disabled: false, rules: [{ name: "auth", match: /^\/auth\//, perMinute: 3 }] });
    app.post("/auth/login", async () => ({ ok: true }));
    app.get("/health", async () => ({ ok: true }));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await app.inject({ method: "POST", url: "/auth/login", remoteAddress: "198.51.100.1" })).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const limited = await app.inject({ method: "POST", url: "/auth/login", remoteAddress: "198.51.100.1" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await app.inject({ method: "POST", url: "/auth/login", remoteAddress: "198.51.100.2" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health", remoteAddress: "198.51.100.1" })).statusCode).toBe(200);
    await app.close();
  });

  it("windows reset", () => {
    const limiter = new FixedWindowLimiter(1_000);
    expect(limiter.hit("k", 1, 0)).toBe(0);
    expect(limiter.hit("k", 1, 10)).toBeGreaterThan(0);
    expect(limiter.hit("k", 1, 1_001)).toBe(0);
  });
});
