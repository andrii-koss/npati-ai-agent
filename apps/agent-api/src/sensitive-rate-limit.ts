import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Security audit 2026-11-24, L3: the API had no request rate limit outside chat admission and Data Studio. This limits the
 * routes where volume itself is the risk (sign-in, OAuth callbacks, inbound webhooks, connection probes, paid media
 * generation) per client address and route group, in a fixed one-minute window.
 *
 * It is per process (each API replica counts on its own), which is a floor, not a quota system. The client address is
 * Fastify's `request.ip`, so it honours NPATI_TRUST_PROXY and cannot be chosen by the client.
 */
export interface RateRule { name: string; match: RegExp; perMinute: number }

export const SENSITIVE_RATE_RULES: readonly RateRule[] = [
  { name: "auth", match: /^\/(?:api\/)?auth\//, perMinute: 30 },
  { name: "oauth_callback", match: /^\/(?:api\/)?email\/oauth\/callback/, perMinute: 20 },
  { name: "inbound_webhook", match: /^\/(?:api\/)?v1\/(?:integrations|webhooks)\//, perMinute: 600 },
  { name: "connection_probe", match: /\/email-accounts\/[^/]+\/(?:test-connection|dns-check|oauth\/authorize)$/, perMinute: 10 },
  { name: "media_generation", match: /^\/(?:api\/)?media\/(?:images|video|music|documents|audio)\//, perMinute: 30 },
];

export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly windowMs = 60_000, private readonly maxKeys = 50_000) {}

  /** Returns seconds to wait when over the limit, otherwise 0. */
  hit(key: string, limit: number, now = Date.now()): number {
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      if (this.windows.size >= this.maxKeys) this.prune(now);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    return window.count > limit ? Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000)) : 0;
  }

  private prune(now: number) {
    for (const [key, window] of this.windows) if (now - window.start >= this.windowMs) this.windows.delete(key);
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}

export function registerSensitiveRateLimits(app: FastifyInstance, options: { rules?: readonly RateRule[]; limiter?: FixedWindowLimiter; disabled?: boolean } = {}) {
  if (options.disabled ?? process.env.NPATI_RATE_LIMIT_DISABLED === "true") return;
  const rules = options.rules ?? SENSITIVE_RATE_RULES;
  const limiter = options.limiter ?? new FixedWindowLimiter();
  app.addHook("onRequest", async (request: FastifyRequest, reply) => {
    const path = request.url.split("?", 1)[0]!;
    const rule = rules.find((candidate) => candidate.match.test(path));
    if (!rule) return;
    const retryAfter = limiter.hit(`${rule.name}:${request.ip}`, rule.perMinute);
    if (retryAfter > 0) {
      return reply.code(429).header("retry-after", String(retryAfter))
        .send({ error: { code: "RATE_LIMITED", message: "Too many requests; retry later." } });
    }
  });
}
