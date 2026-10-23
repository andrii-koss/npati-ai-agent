import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import http from "node:http";
import net from "node:net";
import { registerProjectApiControlClient, registerProjectApiControlServer } from "../apps/agent-api/src/project-api-control-channel";
import { signRunnerRequest } from "../apps/agent-api/src/runner-readiness";
import { createProjectApiServiceBinding, validProjectApiRequest, PROJECT_API_SERVICE_HOST,
  type ProjectApiBindingRequest } from "../apps/agent-api/src/sandbox-project-api-binding.mjs";
const secret = "control-test-secret-".repeat(3);
const key = "npati_pk_dev_" + "a".repeat(32);
const path = "/v1/projects/11111111-1111-4111-8111-111111111111/collections/products";
const request: ProjectApiBindingRequest = { method: "GET", path, headers: { "x-project-key": key }, bodyBase64: "" };
const response = { status: 200, headers: { "content-type": "application/json" }, bodyBase64: Buffer.from('{"data":[{"title":"REAL"}]}').toString("base64") };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function runner(options: { maxPending?: number; timeoutMs?: number; enabled?: boolean } = {}) {
  const app = Fastify({ bodyLimit: 16_000_000 });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  registerProjectApiControlServer(app, secret, new Map(), { enabled: true, ...options });
  cleanup.push(() => app.close());
  const call = (action: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    return app.inject({ method: "POST", url: "/v1/project-api/" + action, payload: body, headers: signRunnerRequest({ secret, body }) });
  };
  return { app, call };
}
async function proxy(dispatch = vi.fn(async (_request: ProjectApiBindingRequest) => response)) {
  const binding = createProjectApiServiceBinding("dev", { dispatch })!;
  const server = http.createServer((req, res) => { void binding.handle(req, res, new URL(req.url!)); });
  const sockets = new Set<net.Socket>();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("connect", (req, socket, head) => { socket.pause(); if (!binding.connect(req, socket as net.Socket, head)) socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  const port = (server.address() as net.AddressInfo).port;
  const get = (route = path, headers: Record<string, string> = { "x-project-key": key }, method = "GET") =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, method, path: "http://" + PROJECT_API_SERVICE_HOST + route,
        headers: { host: PROJECT_API_SERVICE_HOST, ...headers } }, res => {
        let body = ""; res.on("data", chunk => body += chunk); res.on("end", () => resolve({ status: res.statusCode!, body }));
      }); req.on("error", reject); req.end();
    });
  return { binding, port, get, dispatch };
}

describe("Project API over the existing runner control channel", () => {
  it("is disabled unless explicitly enabled for dev", async () => {
    expect(createProjectApiServiceBinding()).toBeUndefined();
    expect(() => createProjectApiServiceBinding("prod")).toThrow();
    const f = runner({ enabled: false });
    expect((await f.call("status", {})).statusCode).toBe(404);
  });
  it.each([
    { ...request, path: "/api/admin" },
    { ...request, path: "//agent-api:3001/health" },
    { ...request, path: path + "/../../../../api/auth" },
    { ...request, path: path + "/%2e%2e/admin" },
    { ...request, path: path + "/%252fadmin" },
    { ...request, headers: { "x-project-key": "npati_sk_dev_" + "a".repeat(48) } },
    { ...request, headers: { "x-project-key": key.replace("_dev_", "_prod_") } },
    { ...request, headers: { "x-project-key": key, cookie: "admin-session" } },
    { ...request, method: "TRACE" },
    { ...request, bodyBase64: "not-base64!" },
  ])("refuses non-public/dev requests before dispatch", value => expect(validProjectApiRequest(value)).toBe(false));

  it("requires the existing HMAC, including replay protection", async () => {
    const f = runner(); const body = "{}";
    expect((await f.app.inject({ method: "POST", url: "/v1/project-api/poll", payload: body, headers: { "content-type": "application/json" } })).statusCode).toBe(401);
    const headers = signRunnerRequest({ secret, body });
    expect((await f.app.inject({ method: "POST", url: "/v1/project-api/status", payload: body, headers })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "POST", url: "/v1/project-api/status", payload: body, headers })).statusCode).toBe(401);
  });

  it("executes through existing API routes and preserves gateway authorization errors", async () => {
    const f = runner();
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const api = Fastify();
    const received = vi.fn();
    api.get(path, async (req, reply) => {
      received(req.headers);
      if (req.headers["x-project-key"] !== key) return reply.code(403).send({ error: { code: "INVALID_API_KEY" } });
      return { data: [{ title: "REAL" }] };
    });
    registerProjectApiControlClient(api, { enabled: true, runnerUrl: "http://127.0.0.1:" + (f.app.server.address() as net.AddressInfo).port, secret });
    cleanup.push(() => api.close());
    await api.ready();
    for (let i = 0; i < 50 && !(await f.call("status", {})).json().clientConnected; i++) await new Promise(r => setTimeout(r, 10));
    const answer = await f.call("dispatch", request);
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(Buffer.from(answer.json().bodyBase64, "base64").toString())).toEqual({ data: [{ title: "REAL" }] });
    expect(received.mock.calls[0]![0].cookie).toBeUndefined();
    const badKey = await f.call("dispatch", { ...request, headers: { "x-project-key": "npati_pk_dev_" + "b".repeat(32) } });
    expect(badKey.json().status).toBe(403);
    expect(Buffer.from(badKey.json().bodyBase64, "base64").toString()).toContain("INVALID_API_KEY");
  });

  it("bounds pending work, expires requests and never retries a timed-out write", async () => {
    const f = runner({ maxPending: 1, timeoutMs: 100 });
    const poll = f.call("poll", {});
    const first = f.call("dispatch", { ...request, method: "POST", bodyBase64: Buffer.from('{"title":"one"}').toString("base64") });
    const task = (await poll).json().task;
    expect(task.request.method).toBe("POST");
    expect((await f.call("dispatch", request)).json().status).toBe(503);
    expect((await first).json().status).toBe(503);
    expect((await f.call("reply", { id: task.id, response })).statusCode).toBe(409);
    expect((await f.call("status", {})).json().pending).toBe(0);
  });

  it("reports a missing API consumer as 503 instead of returning substitute data", async () => {
    const f = runner(); const answer = (await f.call("dispatch", request)).json();
    expect(answer.status).toBe(503);
    expect(Buffer.from(answer.bodyBase64, "base64").toString()).toContain("PROJECT_API_CONTROL_UNAVAILABLE");
    expect(answer).not.toHaveProperty("data");
  });

  it("filters HTTP destinations, keys and privileged headers on the existing proxy", async () => {
    const f = await proxy();
    expect((await f.get()).status).toBe(200);
    expect((await f.get("/api/admin")).status).toBe(403);
    expect((await f.get(path, {})).status).toBe(403);
    expect((await f.get(path, { "x-project-key": key, cookie: "SECRET_COOKIE", "x-forwarded-host": "admin" })).status).toBe(200);
    expect(f.dispatch.mock.calls.at(-1)![0].headers).toEqual({ "x-project-key": key });
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });

  it("parses HTTP inside CONNECT and rejects an administrative request on that same tunnel", async () => {
    const f = await proxy();
    const output = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: f.port });
      let body = "", sent = false;
      socket.setTimeout(3000, () => socket.destroy(new Error("test_timeout")));
      socket.on("connect", () => socket.write("CONNECT " + PROJECT_API_SERVICE_HOST + ":80 HTTP/1.1\r\nHost: " + PROJECT_API_SERVICE_HOST + ":80\r\n\r\n"));
      socket.on("data", chunk => {
        body += chunk;
        if (!sent && body.includes("\r\n\r\n")) {
          sent = true;
          socket.write("GET /api/admin HTTP/1.1\r\nHost: " + PROJECT_API_SERVICE_HOST + "\r\nX-Project-Key: " + key + "\r\nConnection: close\r\n\r\n");
        }
      });
      socket.on("error", reject); socket.on("end", () => resolve(body));
    });
    expect(output).toContain("200 Connection Established");
    expect(output).toContain("403 Forbidden");
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("rejects upstream redirects instead of exposing a second destination", async () => {
    const f = await proxy(vi.fn(async () => ({ ...response, status: 302 })));
    expect((await f.get()).status).toBe(502);
  });
});
