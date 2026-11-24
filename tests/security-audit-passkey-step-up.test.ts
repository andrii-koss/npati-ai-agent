import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { NpatiBackendAuthProvider, createMockNpatiJwt } from "../apps/agent-api/src/auth";
import { ACCESS_COOKIE, CSRF_COOKIE } from "../apps/agent-api/src/browser-session";
import { PasskeyService, PasskeyStore, STEP_UP_HEADER, registerPasskeyRoutes } from "../apps/agent-api/src/passkeys";
import { SoftAuthenticator } from "./support/soft-authenticator";

/**
 * Security audit 2026-11-24, residual XSS risk: credentials that outlive the page (API keys, remote tokens) and reveals
 * of stored secrets need a passkey confirmation when the request comes from the browser cookie session.
 */
const ORIGIN = "http://localhost:3000";
const secret = "passkey-step-up-test-jwt-secret-0123456789abcd";
const cookie = (userId = "owner") => `${ACCESS_COOKIE}=${createMockNpatiJwt({ userId }, secret)}; ${CSRF_COOKIE}=csrf-1`;
const browser = (userId = "owner", extra: Record<string, string> = {}) => ({ cookie: cookie(userId), origin: ORIGIN, host: "localhost:3000", "x-csrf-token": "csrf-1", ...extra });

function setup(): { app: FastifyInstance; created: string[] } {
  const app = Fastify();
  const auth = new NpatiBackendAuthProvider({ jwtSecret: secret, workspaceStore: { initialize: async () => undefined } as never });
  registerPasskeyRoutes(app, auth, new PasskeyService(new PasskeyStore()));
  const created: string[] = [];
  app.post("/companies/:companyId/api-keys", async () => { created.push("key"); return { key: "npati_live_new" }; });
  app.post("/companies/:companyId/webhooks/:webhookId/reveal", async () => ({ url: "https://hooks.example/secret" }));
  return { app, created };
}

async function enroll(app: FastifyInstance, authenticator: SoftAuthenticator, headers = browser()) {
  const options = (await app.inject({ method: "POST", url: "/auth/passkeys/registration/options", headers, payload: {} })).json() as { challenge: string };
  return app.inject({ method: "POST", url: "/auth/passkeys/registration/verify", headers, payload: { name: "Laptop", response: authenticator.register(options) } });
}

async function confirm(app: FastifyInstance, authenticator: SoftAuthenticator, purpose: string, assertExtra: { origin?: string; userVerified?: boolean } = {}, headers = browser()) {
  const options = (await app.inject({ method: "POST", url: "/auth/step-up/options", headers, payload: { purpose } })).json() as { challenge: string };
  return app.inject({ method: "POST", url: "/auth/step-up/verify", headers, payload: { purpose, response: authenticator.assert(options, assertExtra) } });
}

describe("passkey step-up for long-lived credentials and secret reveals", () => {
  it("without a passkey a cookie-session request is told to add one; nothing is created", async () => {
    const { app, created } = setup();
    try {
      const response = await app.inject({ method: "POST", url: "/companies/c1/api-keys", headers: browser(), payload: {} });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "PASSKEY_REQUIRED", purpose: "api_key.create" } });
      expect(created).toEqual([]);
    } finally { await app.close(); }
  });

  it("with a passkey: STEP_UP_REQUIRED, then a verified confirmation allows exactly one request", async () => {
    const { app, created } = setup();
    const authenticator = new SoftAuthenticator(ORIGIN);
    try {
      expect((await enroll(app, authenticator)).statusCode).toBe(201);
      const refused = await app.inject({ method: "POST", url: "/companies/c1/api-keys", headers: browser(), payload: {} });
      expect(refused.json()).toMatchObject({ error: { code: "STEP_UP_REQUIRED" } });
      const confirmed = await confirm(app, authenticator, "api_key.create");
      expect(confirmed.statusCode).toBe(200);
      const { stepUpToken } = confirmed.json() as { stepUpToken: string };
      const allowed = await app.inject({ method: "POST", url: "/companies/c1/api-keys", headers: browser("owner", { [STEP_UP_HEADER]: stepUpToken }), payload: {} });
      expect(allowed.statusCode).toBe(200);
      const replay = await app.inject({ method: "POST", url: "/companies/c1/api-keys", headers: browser("owner", { [STEP_UP_HEADER]: stepUpToken }), payload: {} });
      expect(replay.statusCode).toBe(403);
      expect(created).toEqual(["key"]);
    } finally { await app.close(); }
  });

  it("a confirmation is bound to its purpose and its person", async () => {
    const { app } = setup();
    const owner = new SoftAuthenticator(ORIGIN);
    try {
      await enroll(app, owner);
      const { stepUpToken } = (await confirm(app, owner, "webhook.reveal")).json() as { stepUpToken: string };
      expect((await app.inject({ method: "POST", url: "/companies/c1/api-keys", headers: browser("owner", { [STEP_UP_HEADER]: stepUpToken }), payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/companies/c1/webhooks/w1/reveal", headers: browser("other", { [STEP_UP_HEADER]: stepUpToken }), payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/companies/c1/webhooks/w1/reveal", headers: browser("owner", { [STEP_UP_HEADER]: stepUpToken }), payload: {} })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("refuses an assertion without user verification, from another origin, or by an unregistered key", async () => {
    const { app } = setup();
    const owner = new SoftAuthenticator(ORIGIN);
    try {
      await enroll(app, owner);
      const noUv = await confirm(app, owner, "api_key.create", { userVerified: false });
      expect(noUv.statusCode).toBe(403);
      expect(noUv.json()).toMatchObject({ error: { code: "PASSKEY_INVALID" } });
      expect(String((noUv.json() as { error: { message: string } }).error.message)).toMatch(/verif/i);
      const foreign = await confirm(app, owner, "api_key.create", { origin: "https://evil.example" });
      expect(foreign.json()).toMatchObject({ error: { code: "PASSKEY_INVALID" } });
      expect(String((foreign.json() as { error: { message: string } }).error.message)).toMatch(/origin/i);
      expect((await confirm(app, new SoftAuthenticator(ORIGIN), "api_key.create")).json()).toMatchObject({ error: { code: "PASSKEY_UNKNOWN" } });
    } finally { await app.close(); }
  });

  it("a second passkey (and removing one) needs a confirmation with an existing passkey", async () => {
    const { app } = setup();
    const first = new SoftAuthenticator(ORIGIN), injected = new SoftAuthenticator(ORIGIN);
    try {
      await enroll(app, first);
      const options = await app.inject({ method: "POST", url: "/auth/passkeys/registration/options", headers: browser(), payload: {} });
      expect(options.json()).toMatchObject({ error: { code: "STEP_UP_REQUIRED", purpose: "passkey.register" } });
      const { stepUpToken } = (await confirm(app, first, "passkey.register")).json() as { stepUpToken: string };
      expect((await enroll(app, injected, browser("owner", { [STEP_UP_HEADER]: stepUpToken }))).statusCode).toBe(201);
      const list = (await app.inject({ method: "GET", url: "/auth/passkeys", headers: browser() })).json() as { passkeys: Array<{ id: string }> };
      expect(list.passkeys).toHaveLength(2);
      expect((await app.inject({ method: "DELETE", url: `/auth/passkeys/${list.passkeys[1]!.id}`, headers: browser() })).statusCode).toBe(403);
      const remove = (await confirm(app, first, "passkey.delete")).json() as { stepUpToken: string };
      expect((await app.inject({ method: "DELETE", url: `/auth/passkeys/${list.passkeys[1]!.id}`, headers: browser("owner", { [STEP_UP_HEADER]: remove.stepUpToken }) })).statusCode).toBe(204);
    } finally { await app.close(); }
  });

  it("Bearer and API-key clients are not asked (page script cannot reach those credentials)", async () => {
    const { app, created } = setup();
    try {
      const response = await app.inject({ method: "POST", url: "/companies/c1/api-keys", headers: { authorization: `Bearer ${createMockNpatiJwt({ userId: "owner" }, secret)}` }, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(created).toEqual(["key"]);
    } finally { await app.close(); }
  });

  it("the cookie session's CSRF check still applies before the confirmation", async () => {
    const { app } = setup();
    try {
      const response = await app.inject({ method: "POST", url: "/companies/c1/api-keys", headers: { cookie: cookie(), origin: ORIGIN, host: "localhost:3000" }, payload: {} });
      expect(response.json()).toMatchObject({ error: { code: "CSRF_TOKEN_REQUIRED" } });
    } finally { await app.close(); }
  });
});
