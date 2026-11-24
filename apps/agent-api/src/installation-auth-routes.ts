import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { NpatiAuthClient } from "@npati/hub-connector";
import { InstallationAuthStore } from "./installation-auth";
import { sessionBearer } from "./auth";
import { accessTokenFromCookie, clearSessionCookies } from "./browser-session";

const COOKIE = "npati_agent_session";
const cookie = (request: FastifyRequest) => (request.headers.cookie ?? "").split(";")
  .map((part) => part.trim().split("="))
  .find(([name]) => name === COOKIE)?.slice(1).join("=");
// L6 stage 2: a browser's access token is in the HttpOnly session cookie, not in a header.
const bearer = (request: FastifyRequest) => sessionBearer(request.headers.authorization) || accessTokenFromCookie(request);
const failure = (reply: FastifyReply, error: unknown) => reply.code(Number((error as any)?.status ?? 502)).send({
  success: false,
  error: { code: "INSTALLATION_AUTH_FAILED", message: error instanceof Error ? error.message : "Installation authorization failed" },
});

export function registerInstallationAuthRoutes(app: FastifyInstance, options: {
  authClient?: NpatiAuthClient;
  store: InstallationAuthStore;
  publicDomain?: string;
  version?: string;
  deploymentType?: "self_hosted" | "npati_hosted";
  hostedRegistrationToken?: string;
}) {
  const { authClient, store } = options;
  const unavailable = (reply: FastifyReply) => {
    if (authClient?.startInstallationPairing && authClient.exchangeInstallationDeviceCode && authClient.createInstallationSession) return false;
    reply.code(503).send({ success: false, error: { code: "NPATI_BACKEND_UNAVAILABLE", message: "Central NPATI backend is not configured." } });
    return true;
  };
  const registerGet = (path: string, handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => {
    app.get(path, handler);
    app.get(`/api${path}`, handler);
  };
  const registerPost = <Body = unknown>(path: string, handler: (request: FastifyRequest<{ Body: Body }>, reply: FastifyReply) => Promise<unknown>) => {
    app.post<{ Body: Body }>(path, handler);
    app.post<{ Body: Body }>(`/api${path}`, handler);
  };

  registerGet("/auth/installation/status", async (request, reply) => {
    const state = await store.load();
    const browserSession = await store.getBrowserSession(cookie(request));
    return reply.send({ success: true, data: {
      installationId: state.installationId,
      connected: Boolean(browserSession || (options.deploymentType !== "npati_hosted" && state.installationToken)),
      expiresAt: browserSession?.installationTokenExpiresAt ?? state.installationTokenExpiresAt ?? null,
      deploymentType: options.deploymentType ?? "self_hosted",
    } });
  });

  registerPost("/auth/installation/start", async (_request, reply) => {
    if (unavailable(reply)) return;
    const state = await store.load();
    try {
      const data = await authClient!.startInstallationPairing!({
        installationId: state.installationId,
        domain: options.publicDomain ?? null,
        version: options.version ?? null,
        deploymentType: options.deploymentType ?? "self_hosted",
        hostedRegistrationToken: options.hostedRegistrationToken,
      });
      return reply.code(201).send({ success: true, data });
    } catch (error) { return failure(reply, error); }
  });

  registerPost<{ deviceCode?: string }>("/auth/installation/poll", async (request, reply) => {
    if (unavailable(reply)) return;
    if (!request.body?.deviceCode) return reply.code(400).send({ success: false, error: { code: "DEVICE_CODE_REQUIRED", message: "Device code is required." } });
    try {
      const exchange = await authClient!.exchangeInstallationDeviceCode!(request.body.deviceCode);
      if (exchange.status === "authorization_pending") return reply.code(202).send({ success: true, data: exchange });
      if (options.deploymentType !== "npati_hosted") {
        await store.authorize(exchange.installationToken, exchange.expiresAt);
      }
      const session = await authClient!.createInstallationSession!(exchange.installationToken);
      if (options.deploymentType !== "npati_hosted") await store.bindOwner(session.user.id);
      const localSession = await store.createBrowserSession(exchange.installationToken, exchange.expiresAt);
      const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      reply.header("set-cookie", `${COOKIE}=${localSession}; HttpOnly; SameSite=Strict; Path=/api/auth/installation; Max-Age=7776000${secure}`);
      return reply.send({ success: true, data: session });
    } catch (error) { return failure(reply, error); }
  });

  registerPost("/auth/installation/session", async (request, reply) => {
    if (unavailable(reply)) return;
    const browserSession = await store.getBrowserSession(cookie(request));
    if (!browserSession) return reply.code(401).send({
      success: false, error: { code: "LOCAL_SESSION_REQUIRED", message: "Reconnect this browser to the NPATI installation." },
    });
    try { return reply.send({ success: true, data: await authClient!.createInstallationSession!(browserSession.installationToken) }); }
    catch (error) { return failure(reply, error); }
  });

  registerPost("/auth/installation/browser-logout", async (request, reply) => {
    await store.clearBrowserSession(cookie(request));
    reply.header("set-cookie", [`${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/auth/installation; Max-Age=0`, ...clearSessionCookies(request)]);
    return reply.send({ success: true });
  });

  registerPost("/auth/installation/disconnect", async (request, reply) => {
    if (unavailable(reply)) return;
    const state = await store.load();
    const accessToken = bearer(request);
    const browserSession = await store.getBrowserSession(cookie(request));
    if (!accessToken || !browserSession) return reply.code(401).send({ success: false, error: { code: "AUTH_REQUIRED", message: "An authenticated account session is required." } });
    try {
      await authClient!.revokeInstallation!(accessToken, state.installationId);
      await store.clearBrowserSession(cookie(request));
      if (options.deploymentType !== "npati_hosted") await store.clearAuthorization();
      reply.header("set-cookie", [`${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/auth/installation; Max-Age=0`, ...clearSessionCookies(request)]);
      return reply.send({ success: true });
    } catch (error) { return failure(reply, error); }
  });

  let timer: NodeJS.Timeout | undefined;
  app.addHook("onReady", async () => {
    if (!authClient?.heartbeatInstallation) return;
    if (options.deploymentType === "npati_hosted") return;
    const heartbeat = async () => {
      let state = await store.load();
      const expiresSoon = state.installationTokenExpiresAt
        ? Date.parse(state.installationTokenExpiresAt) - Date.now() < 7 * 24 * 60 * 60 * 1000
        : false;
      if (state.installationToken && expiresSoon && authClient.refreshInstallationToken) {
        const rotated = await authClient.refreshInstallationToken(state.installationToken).catch(() => null);
        if (rotated) {
          await store.authorize(rotated.installationToken, rotated.expiresAt);
          state = await store.load();
        }
      }
      if (state.installationToken) await authClient.heartbeatInstallation!(state.installationToken, {
        domain: options.publicDomain ?? null, version: options.version ?? null,
      }).catch(() => undefined);
    };
    await heartbeat();
    timer = setInterval(heartbeat, 15 * 60 * 1000);
    timer.unref();
  });
  app.addHook("onClose", async () => { if (timer) clearInterval(timer); });
}
