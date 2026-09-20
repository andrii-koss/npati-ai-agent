import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type {
  NpatiAuthClient,
  NpatiInstallationPairingInput,
  NpatiUser,
} from "@npati/hub-connector";
import { InstallationAuthStore } from "../apps/agent-api/src/installation-auth";
import { registerInstallationAuthRoutes } from "../apps/agent-api/src/installation-auth-routes";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class InstallationClient implements NpatiAuthClient {
  pending = true;
  revoked = false;
  starts: NpatiInstallationPairingInput[] = [];
  register = async () => { throw new Error("not used"); };
  login = async () => { throw new Error("not used"); };
  refresh = async () => { throw new Error("not used"); };
  logout = async () => ({ success: true });
  getCurrentUser = async (): Promise<NpatiUser> => ({ id: "owner-1", email: "owner@npati.test", username: "owner" });
  startInstallationPairing = async (input: NpatiInstallationPairingInput) => {
    this.starts.push(input);
    return {
      deviceCode: "d".repeat(43),
      userCode: "NPATI-ABCD-1234",
      verificationUri: "https://npati.com/agent/connect",
      verificationUriComplete: "https://npati.com/agent/connect?code=NPATI-ABCD-1234",
      expiresIn: 600,
      interval: 5,
    };
  };
  exchangeInstallationDeviceCode = async () => this.pending
    ? ({ status: "authorization_pending" as const })
    : ({ status: "authorized" as const, installationId: this.starts[0].installationId, installationToken: "npati_inst_secret", expiresAt: "2099-01-01T00:00:00.000Z" });
  createInstallationSession = async () => {
    if (this.revoked) throw Object.assign(new Error("revoked"), { status: 401 });
    return {
      installationId: this.starts[0].installationId,
      accessToken: "central-access",
      user: { id: "owner-1", email: "owner@npati.test", username: "owner" },
    };
  };
  heartbeatInstallation = async () => ({ ok: true });
  revokeInstallation = async () => { this.revoked = true; };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "npati-installation-"));
  directories.push(directory);
  const store = new InstallationAuthStore(directory);
  const client = new InstallationClient();
  const app = Fastify();
  registerInstallationAuthRoutes(app, {
    authClient: client,
    store,
    publicDomain: "localhost:3000",
    version: "1.2.3",
  });
  return { app, client, store, directory };
}

describe("central installation authorization", () => {
  it("persists one installation id across restarts", async () => {
    const { directory, store } = await fixture();
    const first = (await store.load()).installationId;
    const second = (await new InstallationAuthStore(directory).load()).installationId;
    expect(second).toBe(first);
  });

  it("supports routes after the production proxy strips the /api prefix", async () => {
    const { app } = await fixture();
    const status = await app.inject({ method: "GET", url: "/auth/installation/status" });
    expect(status.statusCode).toBe(200);
    const start = await app.inject({ method: "POST", url: "/auth/installation/start" });
    expect(start.statusCode).toBe(201);
    await app.close();
  });
  it("starts device pairing without collecting an NPATI password", async () => {
    const { app, client } = await fixture();
    const response = await app.inject({ method: "POST", url: "/api/auth/installation/start" });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.userCode).toBe("NPATI-ABCD-1234");
    expect(client.starts[0]).toMatchObject({ domain: "localhost:3000", version: "1.2.3", deploymentType: "self_hosted" });
    expect(response.body).not.toContain("password");
    await app.close();
  });

  it("polls idempotently, creates a browser session, and restores it", async () => {
    const { app, client } = await fixture();
    await app.inject({ method: "POST", url: "/api/auth/installation/start" });
    const pending = await app.inject({
      method: "POST", url: "/api/auth/installation/poll", headers: { "x-forwarded-proto": "https" }, payload: { deviceCode: "d".repeat(43) },
    });
    expect(pending.statusCode).toBe(202);

    client.pending = false;
    const authorized = await app.inject({
      method: "POST", url: "/api/auth/installation/poll", headers: { "x-forwarded-proto": "https" }, payload: { deviceCode: "d".repeat(43) },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().data.accessToken).toBe("central-access");
    const setCookie = String(authorized.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    const cookie = setCookie.split(";")[0];

    const noCookie = await app.inject({ method: "POST", url: "/api/auth/installation/session" });
    expect(noCookie.statusCode).toBe(401);
    const restored = await app.inject({
      method: "POST", url: "/api/auth/installation/session", headers: { cookie },
    });
    expect(restored.statusCode).toBe(200);
    await app.close();
  });

  it("revokes the installation and rejects subsequent central sessions", async () => {
    const { app, client } = await fixture();
    await app.inject({ method: "POST", url: "/api/auth/installation/start" });
    client.pending = false;
    await app.inject({ method: "POST", url: "/api/auth/installation/poll", headers: { "x-forwarded-proto": "https" }, payload: { deviceCode: "d".repeat(43) } });
    const revoked = await app.inject({
      method: "POST", url: "/api/auth/installation/disconnect", headers: { authorization: "Bearer owner-access" },
    });
    expect(revoked.statusCode).toBe(200);
    expect(client.revoked).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/auth/installation/status" })).json().data.connected).toBe(false);
    await app.close();
  });
});
