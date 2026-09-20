import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { NpatiAuthClient } from "@npati/hub-connector";
import { InstallationAuthStore } from "./installation-auth";

const COOKIE = "npati_agent_session";
const cookie = (request: FastifyRequest) => (request.headers.cookie ?? "").split(";")
  .map((part) => part.trim().split("="))
  .find(([name]) => name === COOKIE)?.slice(1).join("=");
const bearer = (request: FastifyRequest) => request.headers.authorization?.replace(/^Bearer /, "");
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

  registerGet("/auth/installation/status", async (_request, reply) => {
    const state = await store.load();
    return reply.send({ success: true, data: {
      installationId: state.installationId,
      connected: Boolean(state.installationToken),
      expiresAt: state.installationTokenExpiresAt ?? null,
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
      await store.authorize(exchange.installationToken, exchange.expiresAt);
      const session = await authClient!.createInstallationSession!(exchange.installationToken);
      const localSession = await store.createBrowserSession();
      const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      reply.header("set-cookie", `${COOKIE}=${localSession}; HttpOnly; SameSite=Strict; Path=/api/auth/installation; Max-Age=7776000${secure}`);
      return reply.send({ success: true, data: session });
    } catch (error) { return failure(reply, error); }
  });

  registerPost("/auth/installation/session", async (request, reply) => {
    if (unavailable(reply)) return;
    if (!await store.verifyBrowserSession(cookie(request))) return reply.code(401).send({
      success: false, error: { code: "LOCAL_SESSION_REQUIRED", message: "Reconnect this browser to the NPATI installation." },
    });
    const state = await store.load();
    if (!state.installationToken) return reply.code(401).send({ success: false, error: { code: "INSTALLATION_NOT_CONNECTED", message: "Installation is not connected." } });
    try { return reply.send({ success: true, data: await authClient!.createInstallationSession!(state.installationToken) }); }
    catch (error) { return failure(reply, error); }
  });

  registerPost("/auth/installation/browser-logout", async (_request, reply) => {
    await store.clearBrowserSession();
    reply.header("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/auth/installation; Max-Age=0`);
    return reply.send({ success: true });
  });

  registerPost("/auth/installation/disconnect", async (request, reply) => {
    if (unavailable(reply)) return;
    const state = await store.load();
    const accessToken = bearer(request);
    if (!accessToken || !state.installationToken) return reply.code(401).send({ success: false, error: { code: "AUTH_REQUIRED", message: "An authenticated owner session is required." } });
    try {
      await authClient!.revokeInstallation!(accessToken, state.installationId);
      await store.clearAuthorization();
      reply.header("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/auth/installation; Max-Age=0`);
      return reply.send({ success: true });
    } catch (error) { return failure(reply, error); }
  });

  let timer: NodeJS.Timeout | undefined;
  app.addHook("onReady", async () => {
    if (!authClient?.heartbeatInstallation) return;
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
