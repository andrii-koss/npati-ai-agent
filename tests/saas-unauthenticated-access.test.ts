/**
 * Without signing in, nothing but the deliberately public routes may answer with data. Every registered route is
 * called with no credentials; any 2xx outside the allow-list below fails the test. Runs on the in-memory store.
 */
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { expect, it } from "vitest";
import { buildApp } from "../apps/agent-api/src/app";

// Public by design, each with the reason it must work without an account.
const PUBLIC: Array<[RegExp, string]> = [
  [/^GET \/(api\/)?health(\/live)?$/, "uptime checks; /health shows only the overall status to anyone who is not an administrator"],
  [/^(GET|POST) \/(api\/)?auth\/installation\//, "signing in starts here"],
  [/^POST \/(api\/)?auth\/(login|register|refresh|logout|sso|exchange)/, "session endpoints used before a session exists"],
];

it("no route answers with data to a visitor who has not signed in, except the public ones", async () => {
  const ai = {
    supportsNativeTools: () => true, chat: async () => ({ content: "x" }), async *stream() { yield "x"; },
    listModels: async () => [], getModel: async () => undefined, executeTool: async () => undefined,
    searchMemory: async () => [], saveMemory: async () => undefined, getCapabilities: async () => ["chat"], healthCheck: async () => ({ status: "ok" }),
  } as unknown as AIEngine;
  const marketplace = new Proxy({}, { get: () => async () => ({ providers: [], models: [], overview: { connectedProviders: 1 } }) }) as unknown as OmniRouteMarketplace;
  const app = buildApp({ aiEngine: ai, marketplace, authProvider: { authenticate: async () => {
    throw Object.assign(new Error("Bearer token is required"), { statusCode: 401, status: 401 });
  } } as never });
  try {
    await app.ready();
    const routes: Array<{ method: string; path: string }> = [];
    const stack: string[] = [];
    for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
      const m = line.match(/^([│ ]*)(?:[├└]── )(.*)$/);
      if (!m) continue;
      const depth = m[1].length / 4;
      const mm = m[2].match(/^(.*?) \(([^)]*)\)$/);
      stack.length = depth;
      stack[depth] = mm ? mm[1] : m[2];
      if (mm) for (const method of mm[2].split(", ")) if (!["HEAD", "OPTIONS"].includes(method)) routes.push({ method, path: stack.join("") });
    }
    const open: Array<{ route: string; status: number; body: string }> = [];
    for (const { method, path } of routes) {
      const route = `${method} ${path}`;
      if (/stream|\/events\b|\/sse\b|websocket/.test(path)) continue;
      const url = path.replace(/:([A-Za-z]+)/g, "00000000-0000-4000-8000-000000000000");
      const request = app.inject({ method: method as never, url, ...(method === "GET" || method === "DELETE" ? {} : { payload: {} }) });
      const res = await Promise.race([request, new Promise<{ statusCode: number; body: string }>((resolve) => setTimeout(() => resolve({ statusCode: 0, body: "TIMEOUT" }), 8000))]);
      if (res.statusCode >= 200 && res.statusCode < 300 && !PUBLIC.some(([pattern]) => pattern.test(route))) open.push({ route, status: res.statusCode, body: res.body.slice(0, 160) });
    }
    if (process.env.SAAS_UNAUTH_OUT) (await import("node:fs")).writeFileSync(process.env.SAAS_UNAUTH_OUT, JSON.stringify({ routes: routes.length, open }, null, 2));
    expect(open).toEqual([]);
  } finally {
    await app.close();
  }
}, 600_000);
