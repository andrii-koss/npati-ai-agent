import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthContext } from "@npati/workspace";

/**
 * Security audit 2026-11-24, L6 (stage 1): short-lived, single-path tickets instead of the session token in `?token=`.
 *
 * A browser element that cannot send an Authorization header (an `<a download>`, an `<img>`, an EventSource) used to
 * carry the session token itself in its URL, where it lands in browser history, Referer headers and proxy logs. Such
 * a URL now carries a ticket: minted by an authenticated request, valid for 60 seconds, for GET on one exact path only.
 * A ticket copied out of a log is useless a minute later and never opened anything but that one resource.
 *
 * The ticket carries the authenticated context it was minted from (signed, so it cannot be widened). Only the paths in
 * TICKET_PATHS can be ticketed; everything else still requires the Authorization header.
 */
export const STREAM_TICKET_TTL_MS = 60_000;
const PREFIX = "st1";

/** Routes a ticket may open: GET only, matched against the path without the `/api` prefix and without the query. */
export const TICKET_PATHS: readonly RegExp[] = [
  /^\/attachments\/[0-9a-f-]{36}$/i,
  /^\/companies\/[^/]+\/email-inbox\/attachments\/[^/]+$/,
  /^\/companies\/[^/]+\/knowledge\/documents\/[^/]+\/content$/,
  // Project media (audit L7): `/api/projects/...` is rewritten to `/projects/...` before routing.
  /^\/projects\/[A-Za-z0-9_-]{1,100}\/media\/[^?#]+$/,
];

export class StreamTicketError extends Error {
  constructor(readonly code: string, message: string, readonly status = 401) { super(message); this.name = "StreamTicketError"; }
}

/** The path as the router sees it: no query, no `/api` prefix, no trailing slash. */
export function normalizeTicketPath(value: string): string {
  let path = (value.split("?", 1)[0] ?? "").split("#", 1)[0] ?? "";
  try { path = decodeURI(path); } catch { /* keep as is */ }
  if (path === "/api" || path.startsWith("/api/")) path = path.slice(4) || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function isTicketablePath(path: string): boolean {
  const normalized = normalizeTicketPath(path);
  return !normalized.includes("..") && TICKET_PATHS.some((pattern) => pattern.test(normalized));
}

interface TicketPayload {
  /** The authenticated context, as minted. */
  ctx: Pick<AuthContext, "userId" | "workspaceId" | "externalSubject" | "permissions"> & { companyId?: string; apiKeyId?: string; role?: string };
  path: string;
  exp: number;
  n: string;
}

/** Stable across API replicas (derived from the encryption key), never the key itself. */
export function resolveStreamTicketSecret(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.NPATI_ENCRYPTION_KEY || env.NPATI_REMOTE_ACCESS_TOKEN_SECRET;
  if (base) return createHmac("sha256", base).update("npati/stream-ticket/v1").digest("hex");
  return randomBytes(32).toString("hex");
}

export class StreamTicketService {
  private readonly secret: string;
  constructor(secret?: string, private readonly now: () => number = Date.now) {
    this.secret = secret || resolveStreamTicketSecret();
  }

  mint(context: AuthContext, path: string): { ticket: string; expiresAt: number; path: string } {
    const normalized = normalizeTicketPath(path);
    if (!isTicketablePath(normalized)) throw new StreamTicketError("TICKET_PATH_NOT_ALLOWED", "This resource cannot be opened with a ticket", 400);
    const ctx = context as AuthContext & { companyId?: string; apiKeyId?: string; role?: string };
    const payload: TicketPayload = {
      ctx: {
        userId: ctx.userId, workspaceId: ctx.workspaceId, externalSubject: ctx.externalSubject, permissions: [...ctx.permissions],
        ...(ctx.companyId ? { companyId: ctx.companyId } : {}), ...(ctx.apiKeyId ? { apiKeyId: ctx.apiKeyId } : {}), ...(ctx.role ? { role: ctx.role } : {}),
      },
      path: normalized,
      exp: this.now() + STREAM_TICKET_TTL_MS,
      n: randomBytes(9).toString("base64url"),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return { ticket: `${PREFIX}.${body}.${this.sign(body)}`, expiresAt: payload.exp, path: normalized };
  }

  /** Returns the minted context when the ticket is genuine, unexpired and was minted for exactly this path. */
  verify(ticket: string, requestPath: string, method: string): AuthContext {
    if (method !== "GET" && method !== "HEAD") throw new StreamTicketError("TICKET_METHOD_NOT_ALLOWED", "Tickets only open resources for reading");
    const parts = typeof ticket === "string" ? ticket.split(".") : [];
    if (parts.length !== 3 || parts[0] !== PREFIX) throw new StreamTicketError("INVALID_TICKET", "Invalid ticket");
    const expected = Buffer.from(this.sign(parts[1]!));
    const provided = Buffer.from(parts[2]!);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new StreamTicketError("INVALID_TICKET", "Invalid ticket");
    let payload: TicketPayload;
    try { payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as TicketPayload; }
    catch { throw new StreamTicketError("INVALID_TICKET", "Invalid ticket"); }
    if (!Number.isFinite(payload.exp) || payload.exp <= this.now()) throw new StreamTicketError("TICKET_EXPIRED", "The ticket has expired");
    if (payload.path !== normalizeTicketPath(requestPath) || !isTicketablePath(payload.path)) {
      throw new StreamTicketError("TICKET_PATH_MISMATCH", "The ticket was issued for another resource", 403);
    }
    return { ...payload.ctx, permissions: [...payload.ctx.permissions] } as AuthContext;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(`${PREFIX}.${body}`).digest("base64url");
  }
}
