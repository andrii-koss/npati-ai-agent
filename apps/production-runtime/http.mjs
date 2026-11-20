import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { request } from "node:http";
import { extname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { ProductionError, safeFile } from "./config.mjs";

const media = new Map(Object.entries({
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webp": "image/webp", ".avif": "image/avif", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".pdf": "application/pdf",
  ".xml": "application/xml", ".txt": "text/plain; charset=utf-8",
}));
const privateFiles = /^(?:(?:package(?:-lock)?|deployment|composer|credentials|secrets?|tsconfig|jsconfig)(?:\.[^.]+)*|(?:server|next\.config|vite\.config|webpack\.config|tailwind\.config|postcss\.config)\.(?:m?js|cjs|ts))$/i;
export const publicFile = path => safeFile(path) && !path.split("/").some(part => part.startsWith(".") || /^(?:node_modules|tests?|__tests__|fixtures?)$/i.test(part))
  && !privateFiles.test(path.split("/").at(-1)) && media.has(extname(path).toLowerCase());

export function text(res, status, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
  res.end(message);
}

async function serveStatic(req, res, root, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "Method not allowed");
  const relativePath = pathname.slice(1).replace(/\/$/, "");
  if (relativePath && (!safeFile(relativePath) || relativePath.split("/").some(part => part.startsWith(".")))) {
    return text(res, 404, "Not found");
  }
  const candidates = relativePath ? [relativePath, `${relativePath}/index.html`] : ["index.html"];
  for (const candidate of candidates) {
    if (!publicFile(candidate)) continue;
    const target = await realpath(join(root, candidate)).catch(() => null);
    if (!target || !publicFile(relative(root, target))) continue;
    const file = await stat(target).catch(() => null);
    if (!file?.isFile()) continue;
    res.writeHead(200, {
      "content-type": media.get(extname(target).toLowerCase()), "content-length": file.size,
      "x-content-type-options": "nosniff", "cache-control": extname(target).toLowerCase() === ".html" ? "no-cache" : "public, max-age=60",
    });
    if (req.method === "HEAD") res.end();
    else await pipeline(createReadStream(target), res);
    return;
  }
  text(res, 404, "Not found");
}

const hopByHop = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization",
  "transfer-encoding", "trailer", "te", "upgrade"];
function endToEnd(headers) {
  const result = { ...headers };
  for (const name of [...hopByHop, ...String(headers.connection ?? "").toLowerCase().split(/\s*,\s*/)]) delete result[name];
  return result;
}

function serveApplication(req, res, socketPath, path, limits) {
  return new Promise(resolve => {
    const upstream = request({ socketPath, path, method: req.method, headers: endToEnd(req.headers) }, response => {
      res.writeHead(response.statusCode ?? 502, endToEnd(response.headers));
      pipeline(response, res).then(resolve, resolve);
    });
    const timeout = setTimeout(() => {
      text(res, 504, "Application response deadline exceeded");
      upstream.destroy();
    }, limits.timeoutSeconds * 1000);
    let bytes = 0;
    const input = chunk => {
      bytes += chunk.length;
      if (bytes > limits.bodyMiB * 1048576) {
        text(res, 413, "Request body too large");
        upstream.destroy();
      } else if (!upstream.destroyed && !upstream.write(chunk)) {
        req.pause();
        upstream.once("drain", () => req.resume());
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      req.off("data", input);
      upstream.destroy();
      req.resume();
      resolve();
    };
    req.on("data", input);
    req.once("end", () => upstream.end());
    res.once("close", cleanup);
    res.once("finish", cleanup);
    upstream.once("error", () => { if (!res.writableEnded) text(res, 502, "Application unavailable"); });
  });
}

export function recordRequest(record, started, status) {
  const now = Math.floor(Date.now() / 3600000);
  const bucket = record.traffic[now] ??= { requests: 0, errors: 0, limited: 0, durationMs: 0 };
  bucket.requests++;
  bucket.errors += Number(status >= 500);
  bucket.limited += Number(status === 429);
  bucket.durationMs += Math.round(performance.now() - started);
  for (const key of Object.keys(record.traffic)) {
    if (+key < now - 23) delete record.traffic[key];
  }
}

export function trafficSummary(traffic) {
  const first = Math.floor(Date.now() / 3600000) - 23;
  const totals = { requests: 0, errors: 0, limited: 0, durationMs: 0 };
  for (const [hour, bucket] of Object.entries(traffic)) {
    if (+hour >= first) for (const key of Object.keys(totals)) totals[key] += bucket[key];
  }
  const { requests, errors, limited, durationMs } = totals;
  return { requests, errors, limited, averageMs: requests ? Math.round(durationMs / requests) : 0 };
}

export async function publicRequest(req, res, record, rootFor, getApplication, redirectOrigin) {
  const release = record?.release;
  if (!release) return text(res, 404, "Unknown project");
  const { limits, path, stripPath } = release.settings;
  const rawPath = (req.url ?? "/").split("?")[0];
  let pathname;
  try { pathname = decodeURIComponent(rawPath); }
  catch { return text(res, 400, "Invalid URL"); }
  if (!pathname.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(pathname) ||
      pathname.split("/").some(part => part === "." || part === "..")) return text(res, 400, "Invalid URL");
  if (path !== "/" && rawPath !== path && !rawPath.startsWith(`${path}/`)) return text(res, 404, "Not found");

  const started = performance.now();
  res.once("finish", () => recordRequest(record, started, res.statusCode));
  const traffic = record.admission ??= { tokens: limits.requestsPerSecond, last: started, open: 0 };
  traffic.tokens = Math.min(limits.requestsPerSecond, traffic.tokens + (started - traffic.last) * limits.requestsPerSecond / 1000);
  traffic.last = started;
  if (traffic.tokens < 1 || traffic.open >= limits.concurrency) {
    res.setHeader("retry-after", "1");
    return text(res, 429, "Project traffic limit exceeded");
  }
  if (Number(req.headers["content-length"] ?? 0) > limits.bodyMiB * 1048576) return text(res, 413, "Request body too large");
  traffic.tokens--;
  traffic.open++;
  const onClose = () => { traffic.open--; clearTimeout(deadline); };
  const deadline = setTimeout(() => text(res, 504, "Project response deadline exceeded"), limits.timeoutSeconds * 1000);
  res.once("close", onClose);
  try {
    if (redirectOrigin) {
      res.writeHead(308, { location: redirectOrigin + req.url, "cache-control": "no-cache" });
      return res.end();
    }
    if (path !== "/" && pathname === path && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(308, { location: `${path}/${req.url.slice(rawPath.length)}` });
      return res.end();
    }
    if (release.kind === "static") {
      const relativePath = path !== "/" ? pathname.slice(path.length) || "/" : pathname;
      return await serveStatic(req, res, rootFor(record, release), relativePath);
    }
    const app = await getApplication(record, release);
    if (!app) return text(res, 503, "Application is unavailable");
    const forwardPath = stripPath && path !== "/" ? ((rawPath.slice(path.length) || "/") + req.url.slice(rawPath.length)) : req.url;
    await serveApplication(req, res, app.socketPath, forwardPath, limits);
  } catch (error) {
    if (!res.destroyed) text(res, 500, "Production request failed");
    throw error;
  }
}

export async function readJson(req, maxBytes) {
  if (Number(req.headers["content-length"] ?? 0) > maxBytes) throw new ProductionError(413, "Deployment snapshot is too large");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new ProductionError(413, "Deployment snapshot is too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ProductionError(400, "Invalid deployment request"); }
}
