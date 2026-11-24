import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthContext } from "@npati/workspace";
import { AuthenticationError, sessionBearer, type AuthProvider } from "./auth";
import { accessTokenFromCookie, csrfFailure } from "./browser-session";

/**
 * Security audit 2026-11-24 (residual XSS risk after L6 stage 2): while a page is open, injected script acts with the
 * person's session. Actions that create credentials which outlive the page, or that reveal stored secrets, therefore
 * need a passkey confirmation: a WebAuthn assertion with user verification, which script cannot produce without the
 * person acting on their device.
 *
 * Flow: the action answers 403 STEP_UP_REQUIRED {purpose}; the page asks for options (POST /auth/step-up/options),
 * the browser signs the challenge (navigator.credentials.get), the server verifies it (POST /auth/step-up/verify) and
 * returns a step-up token; the action is retried with `x-npati-step-up: <token>`. A token is bound to the person, the
 * purpose and five minutes, and is consumed by the one request it confirms.
 *
 * Only cookie-session requests are confirmed: an API key or a Bearer token is not in page script's reach.
 *
 * Enrolment: adding a passkey when one exists, and removing one, need a confirmation with an existing passkey (an
 * injected script could otherwise enrol a software key it holds). The first passkey of an account can be enrolled by
 * whoever holds the session; every enrolment is visible in the passkey list.
 */
export const STEP_UP_HEADER = "x-npati-step-up";
const CHALLENGE_TTL_MS = 5 * 60_000;

export type StepUpPurpose =
  | "api_key.create" | "remote_token.create" | "browser_credential.reveal" | "webhook.reveal"
  | "data_studio_keys.reveal" | "data_studio_keys.rotate" | "passkey.register" | "passkey.delete";

/** The guarded routes (method + route pattern, both with and without the /api prefix). */
export const STEP_UP_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp; purpose: StepUpPurpose }> = [
  { method: "POST", pattern: /^(?:\/api)?\/companies\/:companyId\/api-keys$/, purpose: "api_key.create" },
  { method: "POST", pattern: /^(?:\/api)?\/companies\/:companyId\/remote-tokens$/, purpose: "remote_token.create" },
  { method: "POST", pattern: /^(?:\/api)?\/companies\/:companyId\/browser-credentials\/:credentialId\/reveal$/, purpose: "browser_credential.reveal" },
  { method: "POST", pattern: /^(?:\/api)?\/companies\/:companyId\/webhooks\/:webhookId\/reveal$/, purpose: "webhook.reveal" },
  { method: "POST", pattern: /\/api\/keys\/reveal$/, purpose: "data_studio_keys.reveal" },
  { method: "POST", pattern: /\/api\/keys\/rotate$/, purpose: "data_studio_keys.rotate" },
  { method: "DELETE", pattern: /^(?:\/api)?\/auth\/passkeys\/:passkeyId$/, purpose: "passkey.delete" },
];

export interface StoredPasskey { id: string; workspaceId: string; userId: string; credentialId: string; publicKey: Uint8Array; counter: number; transports: string[]; name: string; createdAt: string; lastUsedAt: string | null }
interface Challenge { id: string; challenge: string; workspaceId: string; userId: string; purpose: string; kind: "registration" | "authentication"; expiresAt: number; verifiedAt: number | null; consumedAt: number | null }

export class StepUpError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403, readonly purpose?: string) { super(message); this.name = "StepUpError"; }
}

/** Postgres when a pool is given (shared by all API replicas), memory otherwise (tests, in-memory installs). */
export class PasskeyStore {
  private readonly passkeys = new Map<string, StoredPasskey>();
  private readonly challenges = new Map<string, Challenge>();
  constructor(private readonly pool?: Pick<Pool, "query">, private readonly now: () => number = Date.now) {}

  async list(ctx: Pick<AuthContext, "workspaceId" | "userId">): Promise<StoredPasskey[]> {
    if (this.pool) {
      const result = await this.pool.query(`SELECT id, workspace_id AS "workspaceId", user_id AS "userId", credential_id AS "credentialId", public_key AS "publicKey", counter::int AS counter, transports, name, created_at::text AS "createdAt", last_used_at::text AS "lastUsedAt" FROM user_passkeys WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at`, [ctx.workspaceId, ctx.userId]);
      return result.rows.map((row) => ({ ...row, publicKey: new Uint8Array(row.publicKey) }));
    }
    return [...this.passkeys.values()].filter((p) => p.workspaceId === ctx.workspaceId && p.userId === ctx.userId);
  }

  async add(ctx: Pick<AuthContext, "workspaceId" | "userId">, input: { credentialId: string; publicKey: Uint8Array; counter: number; transports: string[]; name: string }): Promise<StoredPasskey> {
    const item: StoredPasskey = { id: randomUUID(), workspaceId: ctx.workspaceId, userId: ctx.userId, ...input, createdAt: new Date(this.now()).toISOString(), lastUsedAt: null };
    if (this.pool) {
      await this.pool.query(`INSERT INTO user_passkeys(id, workspace_id, user_id, credential_id, public_key, counter, transports, name) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [item.id, item.workspaceId, item.userId, item.credentialId, Buffer.from(item.publicKey), item.counter, JSON.stringify(item.transports), item.name]);
    } else {
      if ([...this.passkeys.values()].some((p) => p.credentialId === item.credentialId)) throw new StepUpError("PASSKEY_EXISTS", "This passkey is already registered", 409);
      this.passkeys.set(item.id, item);
    }
    return item;
  }

  async remove(ctx: Pick<AuthContext, "workspaceId" | "userId">, id: string): Promise<boolean> {
    if (this.pool) return Boolean((await this.pool.query(`DELETE FROM user_passkeys WHERE id=$1 AND workspace_id=$2 AND user_id=$3`, [id, ctx.workspaceId, ctx.userId])).rowCount);
    const item = this.passkeys.get(id);
    if (!item || item.workspaceId !== ctx.workspaceId || item.userId !== ctx.userId) return false;
    return this.passkeys.delete(id);
  }

  async recordUse(id: string, counter: number): Promise<void> {
    if (this.pool) { await this.pool.query(`UPDATE user_passkeys SET counter=$2, last_used_at=now() WHERE id=$1`, [id, counter]); return; }
    const item = this.passkeys.get(id);
    if (item) Object.assign(item, { counter, lastUsedAt: new Date(this.now()).toISOString() });
  }

  async createChallenge(ctx: Pick<AuthContext, "workspaceId" | "userId">, challenge: string, purpose: string, kind: Challenge["kind"]): Promise<Challenge> {
    const item: Challenge = { id: randomBytes(32).toString("base64url"), challenge, workspaceId: ctx.workspaceId, userId: ctx.userId, purpose, kind, expiresAt: this.now() + CHALLENGE_TTL_MS, verifiedAt: null, consumedAt: null };
    if (this.pool) {
      await this.pool.query(`DELETE FROM auth_step_up_challenges WHERE expires_at < now() - interval '1 day'`);
      await this.pool.query(`INSERT INTO auth_step_up_challenges(id, challenge, workspace_id, user_id, purpose, kind, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [item.id, item.challenge, item.workspaceId, item.userId, item.purpose, item.kind, new Date(item.expiresAt).toISOString()]);
    } else this.challenges.set(item.id, item);
    return item;
  }

  /** Finds an unexpired, unverified challenge of this person by its value, and marks it verified (single use). */
  async takeChallenge(ctx: Pick<AuthContext, "workspaceId" | "userId">, challenge: string, purpose: string, kind: Challenge["kind"]): Promise<Challenge | null> {
    if (this.pool) {
      const result = await this.pool.query(`UPDATE auth_step_up_challenges SET verified_at=now() WHERE challenge=$1 AND workspace_id=$2 AND user_id=$3 AND purpose=$4 AND kind=$5 AND verified_at IS NULL AND expires_at > now() RETURNING id, challenge, purpose, kind, extract(epoch from expires_at)*1000 AS "expiresAt"`,
        [challenge, ctx.workspaceId, ctx.userId, purpose, kind]);
      const row = result.rows[0];
      return row ? { ...row, workspaceId: ctx.workspaceId, userId: ctx.userId, expiresAt: Number(row.expiresAt), verifiedAt: this.now(), consumedAt: null } : null;
    }
    const item = [...this.challenges.values()].find((c) => c.challenge === challenge);
    if (!item || item.workspaceId !== ctx.workspaceId || item.userId !== ctx.userId || item.purpose !== purpose || item.kind !== kind || item.verifiedAt !== null || item.expiresAt <= this.now()) return null;
    item.verifiedAt = this.now();
    return item;
  }

  /** Spends a verified step-up token for one request of this person and purpose. */
  async consume(ctx: Pick<AuthContext, "workspaceId" | "userId">, token: string, purpose: string): Promise<boolean> {
    if (this.pool) {
      return Boolean((await this.pool.query(`UPDATE auth_step_up_challenges SET consumed_at=now() WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND purpose=$4 AND kind='authentication' AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at > now()`,
        [token, ctx.workspaceId, ctx.userId, purpose])).rowCount);
    }
    const item = this.challenges.get(token);
    if (!item || item.workspaceId !== ctx.workspaceId || item.userId !== ctx.userId || item.purpose !== purpose || item.kind !== "authentication" || item.verifiedAt === null || item.consumedAt !== null || item.expiresAt <= this.now()) return false;
    item.consumedAt = this.now();
    return true;
  }
}

/** The relying party of this request: its Origin must be this host or a configured web origin. */
export function relyingParty(request: Pick<FastifyRequest, "headers">, env: NodeJS.ProcessEnv = process.env): { rpID: string; origin: string } {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin.replace(/\/+$/, "") : "";
  if (!origin) throw new StepUpError("ORIGIN_REQUIRED", "Passkeys are used from the browser app", 400);
  const configured = env.NPATI_WEB_ORIGIN?.split(",").map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean) ?? [];
  let url: URL;
  try { url = new URL(origin); } catch { throw new StepUpError("ORIGIN_INVALID", "Invalid Origin", 400); }
  if (url.host !== request.headers.host && !configured.includes(origin)) throw new StepUpError("ORIGIN_MISMATCH", "Passkeys can only be used from this site", 403);
  return { rpID: url.hostname, origin };
}

/** True when the request is authenticated by the browser session cookie (no Authorization header or API key). */
export function isCookieSessionRequest(request: Pick<FastifyRequest, "headers">): boolean {
  const apiKey = request.headers["x-api-key"] || request.headers["x-npati-api-key"];
  return !apiKey && !sessionBearer(request.headers.authorization) && Boolean(accessTokenFromCookie(request));
}

export class PasskeyService {
  constructor(private readonly store: PasskeyStore, private readonly rpName = "NPATI Agent") {}

  list(ctx: AuthContext) { return this.store.list(ctx); }
  remove(ctx: AuthContext, id: string) { return this.store.remove(ctx, id); }

  async registrationOptions(ctx: AuthContext, request: FastifyRequest) {
    const { rpID } = relyingParty(request);
    const existing = await this.store.list(ctx);
    const options = await generateRegistrationOptions({
      rpName: this.rpName, rpID, userName: ctx.userId, userID: new TextEncoder().encode(`${ctx.workspaceId}\u0000${ctx.userId}`).slice(0, 64),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    await this.store.createChallenge(ctx, options.challenge, "passkey.register", "registration");
    return options;
  }

  async verifyRegistration(ctx: AuthContext, request: FastifyRequest, response: unknown, name: string) {
    const { rpID, origin } = relyingParty(request);
    const challenge = clientChallenge(response);
    if (!challenge || !await this.store.takeChallenge(ctx, challenge, "passkey.register", "registration")) throw new StepUpError("CHALLENGE_INVALID", "The passkey request expired; try again", 400);
    let verification;
    try {
      verification = await verifyRegistrationResponse({ response: response as never, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    } catch (error) { throw new StepUpError("PASSKEY_INVALID", error instanceof Error ? error.message : "Invalid passkey", 400); }
    if (!verification.verified) throw new StepUpError("PASSKEY_INVALID", "The passkey could not be verified", 400);
    const { credential } = verification.registrationInfo;
    return this.store.add(ctx, { credentialId: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports ?? [], name: name.trim().slice(0, 80) || "Passkey" });
  }

  async stepUpOptions(ctx: AuthContext, request: FastifyRequest, purpose: string) {
    const { rpID } = relyingParty(request);
    const passkeys = await this.store.list(ctx);
    if (!passkeys.length) throw new StepUpError("PASSKEY_REQUIRED", "Add a passkey to confirm this action", 409, purpose);
    const options = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: passkeys.map((p) => ({ id: p.credentialId, transports: p.transports })) });
    await this.store.createChallenge(ctx, options.challenge, purpose, "authentication");
    return options;
  }

  /** Verifies the assertion and returns the step-up token for one request with this purpose. */
  async verifyStepUp(ctx: AuthContext, request: FastifyRequest, purpose: string, response: unknown): Promise<{ stepUpToken: string; expiresAt: string }> {
    const { rpID, origin } = relyingParty(request);
    const challenge = clientChallenge(response);
    const taken = challenge ? await this.store.takeChallenge(ctx, challenge, purpose, "authentication") : null;
    if (!taken) throw new StepUpError("CHALLENGE_INVALID", "The confirmation expired; try again", 400, purpose);
    const credentialId = typeof (response as { id?: unknown })?.id === "string" ? (response as { id: string }).id : "";
    const passkey = (await this.store.list(ctx)).find((p) => p.credentialId === credentialId);
    if (!passkey) throw new StepUpError("PASSKEY_UNKNOWN", "This passkey is not registered for your account", 403, purpose);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: response as never, expectedChallenge: challenge!, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: passkey.credentialId, publicKey: passkey.publicKey as never, counter: passkey.counter, transports: passkey.transports },
      });
    } catch (error) { throw new StepUpError("PASSKEY_INVALID", error instanceof Error ? error.message : "Invalid passkey", 403, purpose); }
    if (!verification.verified) throw new StepUpError("PASSKEY_INVALID", "The passkey could not be verified", 403, purpose);
    await this.store.recordUse(passkey.id, verification.authenticationInfo.newCounter);
    return { stepUpToken: taken.id, expiresAt: new Date(taken.expiresAt).toISOString() };
  }

  /** Throws STEP_UP_REQUIRED unless a cookie-session request carries a valid, unspent token for this purpose. */
  async require(ctx: AuthContext, request: FastifyRequest, purpose: string): Promise<void> {
    if (!isCookieSessionRequest(request)) return;
    const token = request.headers[STEP_UP_HEADER];
    if (typeof token === "string" && token && await this.store.consume(ctx, token, purpose)) return;
    const hasPasskey = (await this.store.list(ctx)).length > 0;
    throw new StepUpError(hasPasskey ? "STEP_UP_REQUIRED" : "PASSKEY_REQUIRED", hasPasskey ? "Confirm this action with your passkey" : "Add a passkey to confirm this action", 403, purpose);
  }
}

function clientChallenge(response: unknown): string | null {
  try {
    const clientData = (response as { response?: { clientDataJSON?: unknown } })?.response?.clientDataJSON;
    if (typeof clientData !== "string") return null;
    const parsed = JSON.parse(Buffer.from(clientData, "base64url").toString("utf8")) as { challenge?: unknown };
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch { return null; }
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof StepUpError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...(error.purpose ? { purpose: error.purpose } : {}) } });
  if (error instanceof AuthenticationError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  throw error;
}

const PURPOSES = new Set<string>(["api_key.create", "remote_token.create", "browser_credential.reveal", "webhook.reveal", "data_studio_keys.reveal", "data_studio_keys.rotate", "passkey.register", "passkey.delete"]);

export function registerPasskeyRoutes(app: FastifyInstance, auth: AuthProvider, passkeys: PasskeyService, audit?: (ctx: AuthContext, action: string, details: Record<string, unknown>) => Promise<void>) {
  const authenticate = async (request: FastifyRequest) => auth.authenticate(request);

  app.get("/auth/passkeys", async (request, reply) => {
    try {
      const ctx = await authenticate(request);
      const items = await passkeys.list(ctx);
      return { passkeys: items.map(({ id, name, createdAt, lastUsedAt, transports }) => ({ id, name, createdAt, lastUsedAt, transports })) };
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Body: { name?: string } }>("/auth/passkeys/registration/options", async (request, reply) => {
    try {
      const ctx = await authenticate(request);
      // A further passkey needs the confirmation of an existing one; the first can be added by the session holder.
      if ((await passkeys.list(ctx)).length) await passkeys.require(ctx, request, "passkey.register");
      return await passkeys.registrationOptions(ctx, request);
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Body: { response?: unknown; name?: string } }>("/auth/passkeys/registration/verify", async (request, reply) => {
    try {
      const ctx = await authenticate(request);
      const created = await passkeys.verifyRegistration(ctx, request, request.body?.response, String(request.body?.name ?? ""));
      await audit?.(ctx, "auth.passkey.register", { passkeyId: created.id, name: created.name }).catch(() => undefined);
      return reply.code(201).send({ passkey: { id: created.id, name: created.name, createdAt: created.createdAt, lastUsedAt: null, transports: created.transports } });
    } catch (error) { return sendError(reply, error); }
  });

  app.delete<{ Params: { passkeyId: string } }>("/auth/passkeys/:passkeyId", async (request, reply) => {
    try {
      const ctx = await authenticate(request);
      // The guard below (STEP_UP_ROUTES) has already confirmed this request.
      if (!await passkeys.remove(ctx, request.params.passkeyId)) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Passkey not found" } });
      await audit?.(ctx, "auth.passkey.delete", { passkeyId: request.params.passkeyId }).catch(() => undefined);
      return reply.code(204).send();
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Body: { purpose?: string } }>("/auth/step-up/options", async (request, reply) => {
    try {
      const ctx = await authenticate(request);
      const purpose = String(request.body?.purpose ?? "");
      if (!PURPOSES.has(purpose)) return reply.code(400).send({ error: { code: "PURPOSE_INVALID", message: "Unknown action" } });
      return await passkeys.stepUpOptions(ctx, request, purpose);
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Body: { purpose?: string; response?: unknown } }>("/auth/step-up/verify", async (request, reply) => {
    try {
      const ctx = await authenticate(request);
      const purpose = String(request.body?.purpose ?? "");
      if (!PURPOSES.has(purpose)) return reply.code(400).send({ error: { code: "PURPOSE_INVALID", message: "Unknown action" } });
      return reply.header("cache-control", "no-store").send(await passkeys.verifyStepUp(ctx, request, purpose, request.body?.response));
    } catch (error) { return sendError(reply, error); }
  });

  // The guard for the sensitive actions: one place, keyed by route pattern, before the route's own handler runs.
  app.addHook("preHandler", async (request, reply) => {
    const route = request.routeOptions?.url ?? "";
    const rule = STEP_UP_ROUTES.find((candidate) => candidate.method === request.method && candidate.pattern.test(route));
    if (!rule || !isCookieSessionRequest(request)) return;
    // The CSRF check of the cookie session comes first, exactly as in authenticate().
    const csrf = csrfFailure(request);
    if (csrf) return reply.code(403).send({ error: { code: csrf, message: "Cross-site request refused" } });
    try {
      const ctx = await authenticate(request);
      await passkeys.require(ctx, request, rule.purpose);
    } catch (error) { return sendError(reply, error); }
  });
}
