import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { previewOriginConfig, previewOriginMeta } from "./preview-origin-config";

const apiRequests = new WeakSet<IncomingMessage>();
export type CustomDomainHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<boolean>;
const customDomainHandlers = new WeakMap<FastifyInstance, CustomDomainHandler>();
export function setCustomDomainHandler(app: FastifyInstance, handler: CustomDomainHandler): void {
  customDomainHandlers.set(app, handler);
}

/** Match the former nginx /api/ proxy without buffering or redispatching requests. */
export function rewriteBrowserApiUrl(request: IncomingMessage): string {
  const url = request.url ?? "/";
  if (/^\/api(?:\/|\?|$)/.test(url)) {
    apiRequests.add(request);
    // These paths already include /api and do not collide with browser endpoints.
    if (/^\/api\/(?:version|tags|generate|projects)(?:\?|$)/.test(url)) return url;
    const rewritten = url.slice(4);
    return rewritten.startsWith("/") ? rewritten : "/" + rewritten;
  }
  return url;
}

// Some React pages share names with legacy unprefixed API routes.
const frontendPage = /^\/(?:chat|c|business|b|settings|company|projects|dashboard|activity|content|connections|automations|inbox|email|capabilities|goals|memory|skills)(?:\/|$)/;
const dataStudioPage = /^\/companies\/[^/]+\/projects\/[^/]+\/data\/?$/;

export function registerWebFrontend(app: FastifyInstance, directory: string): void {
  const root = path.resolve(directory);
  let indexHtml: Buffer;
  // The Preview origin is configured on the server (NPATI_PREVIEW_ORIGIN), so a prebuilt web bundle picks it up from here.
  app.addHook("onReady", async () => {
    const html = (await readFile(path.join(root, "index.html"))).toString("utf8");
    const meta = previewOriginMeta(previewOriginConfig());
    indexHtml = Buffer.from(meta ? html.replace("</head>", () => `  ${meta}
</head>`) : html, "utf8");
  });
  app.register(fastifyStatic, {
    root,
    index: false,
    cacheControl: false,
    dotfiles: "deny",
    setHeaders(response, filename) {
      response.header("X-Content-Type-Options", "nosniff");
      const normalized = filename.replaceAll("\\", "/");
      response.header("Cache-Control", normalized.endsWith("/index.html")
        ? "no-cache"
        : normalized.includes("/assets/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate");
    },
  });
  app.addHook("onRequest", async (request, reply) => {
    const domainHandler = customDomainHandlers.get(app);
    if (domainHandler && (await domainHandler(request, reply))) return;
    const pathname = request.url.split("?")[0] ?? "/";

    // Auto-route absolute asset/module requests from preview proxy tabs (e.g. Vite ES module imports)
    const referer = typeof request.headers.referer === "string" ? request.headers.referer : "";
    if (referer && !pathname.startsWith("/api/") && !pathname.startsWith("/v1/projects/") && !pathname.startsWith("/companies/") && !pathname.startsWith("/assets/") && !frontendPage.test(pathname) && !dataStudioPage.test(pathname) && !pathname.startsWith("/health")) {
      const match = referer.match(/(\/(?:api\/)?companies\/[^/]+\/projects\/[^/]+\/preview\/proxy)(?:[/?#]|$)/);
      if (match?.[1]) {
        const prefix = match[1].startsWith("/api/") ? match[1] : `/api${match[1]}`;
        return reply.redirect(`${prefix}${request.url}`, 307);
      }
    }
    const staticRoute = request.routeOptions.url === "/*";
    if (apiRequests.has(request.raw)) {
      // Never turn an unknown API endpoint into a static file or a React page.
      if (staticRoute) return reply.code(404).send({ error: "Not Found", statusCode: 404 });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") return;
    if (staticRoute) {
      let decoded: string;
      try { decoded = decodeURIComponent(pathname); }
      catch { return reply.code(400).send({ error: "Bad Request", statusCode: 400 }); }
      if (decoded.split(/[\\/]/).some(segment => segment.startsWith("."))) {
        return reply.code(404).send({ error: "Not Found", statusCode: 404 });
      }
    }
    const navigation = request.headers.accept?.includes("text/html");
    if (pathname === "/" || (navigation && !pathname.startsWith("/assets/") && !path.posix.extname(pathname)
      && (staticRoute || frontendPage.test(pathname) || dataStudioPage.test(pathname)))) {
      // Complete navigation in this hook; asynchronous sendFile can race the
      // wildcard/not-found handler and send a JSON error with an HTML MIME type.
      // Another site must not frame the app: a hidden frame could steer a click onto "Allow" of an approval
      // (V6 step 17). The app's own Preview frames are same-origin and stay allowed.
      return reply.type("text/html; charset=utf-8").header("Cache-Control", "no-cache")
        .header("X-Content-Type-Options", "nosniff").header("X-Frame-Options", "SAMEORIGIN")
        .header("Content-Security-Policy", "frame-ancestors 'self'").header("Referrer-Policy", "strict-origin-when-cross-origin")
        .header("Content-Length", indexHtml.length)
        .send(request.method === "HEAD" ? undefined : indexHtml);
    }
  });
}
