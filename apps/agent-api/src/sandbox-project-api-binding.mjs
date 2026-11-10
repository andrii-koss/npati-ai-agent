/**
 * Opt-in dev Project API route in the EXISTING egress proxy. It sends parsed
 * requests over the existing signed runner control channel. There is no
 * connection to an internal API address and no private-IP policy exception.
 */
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";

export const PROJECT_API_SERVICE_HOST = "project-api.npati.internal";
const HOST = new Set([PROJECT_API_SERVICE_HOST, PROJECT_API_SERVICE_HOST + ":80"]);
const PATH = /^\/v1\/projects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/[a-zA-Z0-9_-]+)*\/?$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"]);
const REQUEST_HEADERS = ["accept", "content-type", "x-project-key", "authorization", "origin", "x-npati-dry-run"];
export const PROJECT_API_RESPONSE_HEADERS = ["content-type", "retry-after", "access-control-allow-origin", "access-control-allow-credentials", "vary"];
export const PROJECT_API_BODY_LIMIT = 1024 * 1024;
export const PROJECT_API_RESPONSE_LIMIT = 8 * 1024 * 1024;

export function validProjectApiRequest(value) {
  if (!value || !METHODS.has(value.method) || typeof value.path !== "string" || value.path.length > 8192) return false;
  let url;
  try { url = new URL(value.path, "http://" + PROJECT_API_SERVICE_HOST); } catch { return false; }
  if (!value.path.startsWith("/") || value.path.startsWith("//") || url.hash || url.pathname !== value.path.split("?")[0]
    || !PATH.test(url.pathname)) return false;
  if (!value.headers || typeof value.headers !== "object" || Array.isArray(value.headers)
    || Object.entries(value.headers).some(([k, v]) => !REQUEST_HEADERS.includes(k) || typeof v !== "string" || v.length > 8192 || /[\r\n]/.test(v))) return false;
  const key = value.headers["x-project-key"];
  if (typeof key !== "string" || !/^npati_pk_dev_[0-9a-f]{32,64}$/.test(key)) return false;
  if (value.headers["x-npati-dry-run"] !== undefined && value.headers["x-npati-dry-run"] !== "1") return false;
  const auth = value.headers.authorization;
  if (auth && (!/^Bearer [a-zA-Z0-9._~-]{1,8192}$/.test(auth) || /^Bearer npati_sk_/i.test(auth))) return false;
  return typeof value.bodyBase64 === "string" && value.bodyBase64.length <= Math.ceil(PROJECT_API_BODY_LIMIT / 3) * 4
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bodyBase64)
    && Buffer.byteLength(value.bodyBase64, "base64") <= PROJECT_API_BODY_LIMIT;
}
export function validProjectApiResponse(value) {
  return value && Number.isInteger(value.status) && value.status >= 200 && value.status <= 599
    && value.headers && typeof value.headers === "object" && !Array.isArray(value.headers)
    && Object.entries(value.headers).every(([k, v]) => PROJECT_API_RESPONSE_HEADERS.includes(k) && typeof v === "string" && v.length <= 8192 && !/[\r\n]/.test(v))
    && typeof value.bodyBase64 === "string" && value.bodyBase64.length <= Math.ceil(PROJECT_API_RESPONSE_LIMIT / 3) * 4
    && Buffer.byteLength(value.bodyBase64, "base64") <= PROJECT_API_RESPONSE_LIMIT;
}
function refuse(res, status, code) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: { code, message: "Project API service route unavailable or refused", status } }));
}

/** Only trusted supervisor traffic reaches this existing HMAC-protected control port. */
export function dispatchProjectApiRequest(payload) {
  const secret = process.env.NPATI_SANDBOX_RUNNER_SECRET ?? "";
  if (secret.length < 32) return Promise.reject(new Error("project_api_control_auth_unavailable"));
  const body = JSON.stringify(payload), timestamp = String(Date.now()), nonce = randomUUID();
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: "127.0.0.1", port: 7865, method: "POST", path: "/v1/project-api/dispatch",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body),
        "x-npati-timestamp": timestamp, "x-npati-nonce": nonce,
        "x-npati-signature": createHmac("sha256", secret).update(timestamp + "." + nonce + "." + body).digest("hex") },
      timeout: 20000 }, response => {
      let size = 0; const chunks = [];
      response.on("data", chunk => { size += chunk.length; if (size > PROJECT_API_RESPONSE_LIMIT * 1.4 + 65536) response.destroy(); else chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode !== 200 || !validProjectApiResponse(value)) throw new Error("project_api_control_invalid_response");
          resolve(value);
        } catch { reject(new Error("project_api_control_invalid_response")); }
      });
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("project_api_control_timeout")));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
/** dispatch is a test seam; clients cannot choose a transport/upstream. */
export function createProjectApiServiceBinding(mode, { dispatch = dispatchProjectApiRequest } = {}) {
  if (!mode) return undefined;
  if (mode !== "dev") throw new Error("invalid_project_api_service_binding");
  const handle = async (req, res, absoluteUrl) => {
    try {
      if (!HOST.has(String(req.headers.host ?? "").toLowerCase())) return refuse(res, 403, "PROJECT_API_BINDING_HOST");
      const raw = String(req.url ?? "");
      const rawPath = absoluteUrl ? raw.replace(/^http:\/\/[^/]+/, "").split("?")[0] || "/" : raw.split("?")[0];
      const url = absoluteUrl ?? new URL(raw, "http://" + PROJECT_API_SERVICE_HOST);
      if (url.protocol !== "http:" || url.hostname !== PROJECT_API_SERVICE_HOST || url.port || url.username || url.password || url.hash
        || url.pathname !== rawPath || raw.length > 8192) return refuse(res, 403, "PROJECT_API_BINDING_PATH");
      const declared = Number(req.headers["content-length"] ?? 0);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > PROJECT_API_BODY_LIMIT) return refuse(res, 413, "PROJECT_API_BINDING_BODY_LIMIT");
      const headers = {};
      for (const name of REQUEST_HEADERS) if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
      // Validate destination/auth before consuming any body.
      if (!validProjectApiRequest({ method: req.method, path: url.pathname + url.search, headers, bodyBase64: "" }))
        return refuse(res, 403, "PROJECT_API_BINDING_REQUEST_REFUSED");
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > PROJECT_API_BODY_LIMIT) return refuse(res, 413, "PROJECT_API_BINDING_BODY_LIMIT");
        chunks.push(chunk);
      }
      const response = await dispatch({ method: req.method, path: url.pathname + url.search, headers, bodyBase64: Buffer.concat(chunks).toString("base64") });
      if (!validProjectApiResponse(response)) return refuse(res, 502, "PROJECT_API_BINDING_INVALID_RESPONSE");
      if (response.status >= 300 && response.status < 400) return refuse(res, 502, "PROJECT_API_BINDING_REDIRECT");
      res.writeHead(response.status, { ...response.headers, "cache-control": "no-store" });
      res.end(Buffer.from(response.bodyBase64, "base64"));
    } catch { refuse(res, 503, "PROJECT_API_BINDING_UPSTREAM_UNAVAILABLE"); }
  };
  // Native fetch uses CONNECT for HTTP too. Parse the nested HTTP requests,
  // never tunnel bytes to the API/control socket.
  const parser = http.createServer((req, res) => { void handle(req, res); });
  parser.requestTimeout = 20000; parser.headersTimeout = 10000; parser.maxRequestsPerSocket = 100;
  parser.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  parser.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  parser.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  return {
    matches(url) { return url.hostname === PROJECT_API_SERVICE_HOST; }, handle,
    connect(req, client, head) {
      const target = String(req.url ?? "").toLowerCase();
      if (!target.startsWith(PROJECT_API_SERVICE_HOST + ":")) return false;
      if (target !== PROJECT_API_SERVICE_HOST + ":80") { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return true; }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) client.unshift(head);
      parser.emit("connection", client); client.resume(); return true;
    },
  };
}
