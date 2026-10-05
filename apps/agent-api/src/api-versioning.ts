/**
 * C1a (part B): API versioning for the Coding Agent surface.
 *
 * The Coding Agent API is versioned from the start: clients send the version they support and every
 * response carries the version it was produced by, so a later additive change can be rolled out with a
 * documented deprecation window instead of breaking installed clients (UI now, CLI later in C15).
 */

export const API_VERSION = "v1";
export const SUPPORTED_API_VERSIONS: readonly string[] = ["v1"];
/** How long an older version keeps working after a successor is announced. */
export const DEPRECATION_WINDOW_DAYS = 90;

export const API_VERSION_HEADER = "x-npati-api-version";

export class ApiVersionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) { super(message); }
}

type HeaderBag = Record<string, string | string[] | undefined> | { get?: (name: string) => string | null | undefined };

function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get: (name: string) => string | null | undefined }).get(name);
    return value ?? undefined;
  }
  const bag = headers as Record<string, string | string[] | undefined>;
  const direct = bag[name] ?? bag[name.toLowerCase()] ?? bag[name.toUpperCase()];
  if (Array.isArray(direct)) return direct[0];
  return direct;
}

/**
 * Resolves the API version from `x-npati-api-version` (or `accept-version`), defaulting to the current
 * version. An unsupported version is a structured 400 rather than a silently downgraded request.
 */
export function resolveApiVersion(headers: HeaderBag = {}): string {
  const requested = (readHeader(headers, API_VERSION_HEADER) ?? readHeader(headers, "accept-version") ?? API_VERSION).trim().toLowerCase();
  if (!requested) return API_VERSION;
  if (!SUPPORTED_API_VERSIONS.includes(requested)) {
    throw new ApiVersionError(
      "unsupported_api_version",
      `Unsupported API version "${requested}"; supported: ${SUPPORTED_API_VERSIONS.join(", ")}`,
      400,
    );
  }
  return requested;
}

/** Adds the version envelope to a response payload. */
export function withApiVersion<T extends Record<string, unknown>>(payload: T, version: string = API_VERSION): T & { apiVersion: string } {
  return { ...payload, apiVersion: version };
}

/** Version metadata for discovery endpoints and UI footers. */
export function apiVersionInfo(now = new Date()) {
  return {
    apiVersion: API_VERSION,
    supported: [...SUPPORTED_API_VERSIONS],
    deprecationWindowDays: DEPRECATION_WINDOW_DAYS,
    header: API_VERSION_HEADER,
    asOf: now.toISOString(),
  };
}
