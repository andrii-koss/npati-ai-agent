import {
  ALLOWED_SCHEMES,
  DEFAULT_ALLOWED_PORTS,
  SsrfPolicyError,
  canonicalIp,
  hasAmbiguousLeadingZero,
  normalizeHostInput,
  parseDestination,
  resolveAndValidate,
  type ResolverPort,
  type SsrfPolicyOptions,
} from "./ssrf-policy";
import { EGRESS_FORBIDDEN_HOSTS } from "./egress-allowlist";
import { assertOutboundAllowed } from "./outbound-exfiltration-guard";
import { ssrfSafeFetch, type SsrfFetchOptions, type SsrfFetchResult, type SsrfTransportPort } from "./ssrf-safe-http";

/**
 * C4b: webhook destinations have their **own** policy and do not reuse the web-fetch host allowlist.
 *
 * A tenant webhook URL is legitimately an arbitrary public host, so the policy is built from the
 * endpoint the user or Company explicitly stored rather than from a static list:
 *
 * - the stored endpoint is the authority for scheme + hostname + port (exact match, no wildcard);
 * - the URL is validated with the shared SSRF policy at **save** time, so a private, internal or
 *   metadata destination can never be stored;
 * - DNS and every resolved address are validated again on **every** delivery — the stored decision is
 *   never trusted, because the hostname may now point at a private address;
 * - redirects are **disabled** for delivery: a webhook must never be bounced to another host;
 * - delivery goes through the one shared SSRF-safe client (pinning, re-validation, header handling).
 */
export type WebhookDestinationReason =
  | "invalid_url"
  | "scheme_not_allowed"
  | "port_not_allowed"
  | "port_not_allowed_for_destination"
  | "credentials_not_allowed"
  | "http_not_allowed"
  | "address_literal_not_allowed"
  | "forbidden_host"
  | "single_label_host"
  | "private_or_reserved_address"
  | "dns_resolution_failed"
  | "not_a_stored_endpoint"
  | "redirect_refused";

export class WebhookDestinationError extends Error {
  readonly code = "webhook_destination_blocked";
  readonly httpStatus = 403;
  readonly retryable = false;
  readonly reason: WebhookDestinationReason;
  readonly details: Record<string, unknown>;

  constructor(reason: WebhookDestinationReason, message: string, details: Record<string, unknown> = {}) {
    super(`[webhook_destination_blocked:${reason}] ${message}`);
    this.name = "WebhookDestinationError";
    this.reason = reason;
    this.details = { ...details, reason };
  }
}

export interface WebhookEndpointIdentity {
  scheme: "http" | "https";
  host: string;
  port: number;
}

export interface WebhookDestinationOptions extends SsrfPolicyOptions {
  resolve?: ResolverPort;
  /**
   * Endpoints the user or Company explicitly stored. The destination must match one of them exactly
   * (scheme + hostname + port); there is no wildcard and no "any public host" escape hatch.
   */
  storedEndpoints?: readonly string[];
  /** Delivery requires a stored endpoint; save-time validation may create one. */
  requireStoredEndpoint?: boolean;
  /**
   * Plain HTTP is refused for ad-hoc destinations. For a stored endpoint the stored scheme is
   * authoritative, so an operator who stored `http://…` keeps working (and owns that risk).
   */
  allowInsecureHttp?: boolean;
}

export interface WebhookDestinationVerdict {
  url: URL;
  identity: WebhookEndpointIdentity;
  addresses: string[];
  ip: string;
  storedEndpoint?: string;
}

/** Conservative default: webhooks may only use the standard web ports. */
export const WEBHOOK_ALLOWED_PORTS: readonly number[] = [443, 80] as const;

function translate(error: unknown, fallback: WebhookDestinationReason, details: Record<string, unknown> = {}): never {
  if (error instanceof WebhookDestinationError) throw error;
  if (error instanceof SsrfPolicyError) {
    throw new WebhookDestinationError(mapPolicyError(error.code), error.message, { ...details, policyCode: error.code });
  }
  throw new WebhookDestinationError(fallback, error instanceof Error ? error.message : String(error), details);
}

function mapPolicyError(code: SsrfPolicyError["code"]): WebhookDestinationReason {
  switch (code) {
    case "ssrf_blocked_scheme":
      return "scheme_not_allowed";
    case "ssrf_blocked_port":
      return "port_not_allowed";
    case "ssrf_blocked_credentials":
      return "credentials_not_allowed";
    case "ssrf_blocked_private_ip":
      return "private_or_reserved_address";
    case "dns_resolution_failed":
      return "dns_resolution_failed";
    default:
      return "invalid_url";
  }
}

function basePorts(options: WebhookDestinationOptions): readonly number[] {
  return options.allowedPorts ?? WEBHOOK_ALLOWED_PORTS;
}

/**
 * Shape validation without DNS. The shared policy is used with an allowlist holding exactly this
 * host, which is precisely the "the stored endpoint is the policy" rule.
 */
export function webhookEndpointIdentity(input: string, options: WebhookDestinationOptions = {}): WebhookEndpointIdentity {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) throw new WebhookDestinationError("invalid_url", "Webhook destination is required");
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1];
  if (authority) {
    const hostPart = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
    const hostOnly = (hostPart.startsWith("[") ? hostPart.slice(0, hostPart.indexOf("]") + 1) : hostPart.split(":")[0]!).replace(/^\[|\]$/g, "");
    if (hasAmbiguousLeadingZero(hostOnly)) {
      throw new WebhookDestinationError("address_literal_not_allowed", "Ambiguous numeric host literals are never allowed", { host: hostOnly });
    }
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookDestinationError("invalid_url", "Webhook destination must be an absolute URL", { input: raw.slice(0, 200) });
  }
  if (!(ALLOWED_SCHEMES as readonly string[]).includes(url.protocol)) {
    throw new WebhookDestinationError("scheme_not_allowed", `Webhook destinations must use http or https, got ${url.protocol}`, { scheme: url.protocol });
  }
  const host = normalizeHostInput(url.hostname);
  if (!host) throw new WebhookDestinationError("invalid_url", "Webhook destination has no hostname");
  if (EGRESS_FORBIDDEN_HOSTS.has(host)) {
    throw new WebhookDestinationError("forbidden_host", "Localhost, metadata and NPATI-internal service names are never valid webhook destinations", { host });
  }
  const literal = canonicalIp(host);
  if (literal) {
    // A literal is either private (blocked outright) or public — but webhooks must use hostnames so the
    // destination can be re-validated by name on every delivery.
    throw new WebhookDestinationError(
      "address_literal_not_allowed",
      "Webhook destinations must be hostnames; IP literals are refused",
      { host, ip: literal },
    );
  }
  if (!host.includes(".")) {
    throw new WebhookDestinationError("single_label_host", "Single-label hostnames are not valid webhook destinations", { host });
  }

  // Authoritative shared checks (scheme, credentials, port, ambiguity, private ranges) with the policy
  // allowlist derived from the destination itself.
  let port: number;
  try {
    const parsed = parseDestination(raw, { ...options, allowlist: [host], allowedPorts: basePorts(options) });
    port = parsed.port;
  } catch (error) {
    return translate(error, "invalid_url", { host });
  }
  const scheme = url.protocol.replace(":", "") as "http" | "https";
  return { scheme, host, port };
}

export function sameWebhookEndpoint(left: WebhookEndpointIdentity, right: WebhookEndpointIdentity): boolean {
  return left.scheme === right.scheme && left.host === right.host && left.port === right.port;
}

/** Returns the stored endpoint string that matches exactly, or undefined. Invalid stored entries are ignored. */
export function findStoredEndpoint(input: string, storedEndpoints: readonly string[], options: WebhookDestinationOptions = {}): string | undefined {
  const identity = webhookEndpointIdentity(input, options);
  return storedEndpoints.find((candidate) => {
    try {
      return sameWebhookEndpoint(webhookEndpointIdentity(candidate, options), identity);
    } catch {
      return false;
    }
  });
}

/**
 * Full validation: shape, stored-endpoint match, DNS and **every** resolved address. Called at save time
 * and again on every delivery; callers must not cache the outcome.
 */
export async function validateWebhookDestination(input: string, options: WebhookDestinationOptions = {}): Promise<WebhookDestinationVerdict> {
  const identity = webhookEndpointIdentity(input, options);
  const insecureAllowed = options.allowInsecureHttp ?? Boolean(options.storedEndpoints?.length);
  if (identity.scheme === "http" && !insecureAllowed) {
    throw new WebhookDestinationError("http_not_allowed", "Plain HTTP webhook destinations are refused; store an https endpoint", { host: identity.host });
  }

  let storedEndpoint: string | undefined;
  if (options.storedEndpoints) {
    storedEndpoint = findStoredEndpoint(input, options.storedEndpoints, options);
    if (!storedEndpoint && options.requireStoredEndpoint !== false) {
      throw new WebhookDestinationError("not_a_stored_endpoint", "The webhook destination is not an endpoint stored for this company or user", {
        host: identity.host, scheme: identity.scheme, port: identity.port,
      });
    }
  } else if (options.requireStoredEndpoint) {
    throw new WebhookDestinationError("not_a_stored_endpoint", "Webhook delivery requires a stored endpoint; none was provided", { host: identity.host });
  }

  const resolve = options.resolve;
  if (!resolve) {
    throw new WebhookDestinationError("dns_resolution_failed", "No resolver configured, so the webhook destination cannot be validated", { host: identity.host });
  }
  let parsed;
  try {
    parsed = parseDestination(input, { ...options, allowlist: [identity.host], allowedPorts: basePorts(options) });
  } catch (error) {
    return translate(error, "invalid_url", { host: identity.host });
  }
  let resolved: { addresses: string[]; ip: string };
  try {
    resolved = await resolveAndValidate(parsed, resolve);
  } catch (error) {
    return translate(error, "dns_resolution_failed", { host: identity.host });
  }
  return { url: parsed.url, identity, addresses: resolved.addresses, ip: resolved.ip, storedEndpoint };
}

/**
 * Delivery-time check: identical to {@link validateWebhookDestination} but a stored endpoint is
 * mandatory, because delivery must never target an arbitrary URL taken from a payload.
 */
export async function assertWebhookDeliveryAllowed(input: string, options: WebhookDestinationOptions = {}): Promise<WebhookDestinationVerdict> {
  return validateWebhookDestination(input, { ...options, requireStoredEndpoint: true });
}

/** Webhook delivery never follows redirects: a redirect would move the request to an unvetted host. */
export const WEBHOOK_DELIVERY_MAX_REDIRECTS = 0;

export interface DeliverWebhookOptions extends WebhookDestinationOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxBytes?: number;
  transport?: SsrfTransportPort;
  /** C5b: the tenant/project this payload belongs to, so the exfiltration guard resolves *its* policy. */
  policyContext?: { companyId?: string; projectId?: string; dataClassification?: "public" | "internal" | "confidential" | "restricted" };
  /** Test seam only; delivery always runs through the shared SSRF-safe client by default. */
  fetchImpl?: (url: string, options: SsrfFetchOptions) => Promise<SsrfFetchResult>;
}

/**
 * Sends one webhook payload through the shared SSRF-safe client with redirects disabled. Every call
 * re-validates the destination, including DNS, before a socket is opened.
 */
export async function deliverWebhook(input: string, options: DeliverWebhookOptions = {}): Promise<SsrfFetchResult> {
  const verdict = await assertWebhookDeliveryAllowed(input, options);
  // C5b: the destination policy above answers "may we talk to this host?"; the exfiltration guard answers
  // "may this payload leave NPATI at all?". A webhook delivers to a third-party endpoint, so a secret is a
  // refusal (never a redaction) and private repository code is an approval-class event.
  const bodyText = typeof options.body === "string"
    ? options.body
    : options.body instanceof Uint8Array
      ? Buffer.from(options.body).toString("utf8")
      : "";
  assertOutboundAllowed({
    channel: "webhook",
    parts: [
      { kind: "url", value: input, label: "webhook_url" },
      { kind: "text", value: bodyText, label: "webhook_body" },
    ],
    ...(options.policyContext ? { context: options.policyContext } : {}),
  });
  const fetchImpl = options.fetchImpl ?? ssrfSafeFetch;
  try {
    return await fetchImpl(input, {
      method: options.method ?? "POST",
      headers: options.headers,
      body: options.body,
      maxRedirects: WEBHOOK_DELIVERY_MAX_REDIRECTS,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      resolve: options.resolve,
      transport: options.transport,
      allowedPorts: basePorts(options),
      // The shared client requires an explicit allowlist; for a webhook that allowlist is exactly the
      // stored endpoint's host, which is what the pre-check just proved.
      allowlist: [verdict.identity.host],
    });
  } catch (error) {
    if (error instanceof SsrfPolicyError && error.code === "too_many_redirects") {
      throw new WebhookDestinationError("redirect_refused", "Webhook delivery does not follow redirects", { policyCode: error.code });
    }
    return translate(error, "invalid_url", { host: input });
  }
}
