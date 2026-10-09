import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { EgressEnforcement, EgressEnforcementReport } from "./sandbox-egress-enforcement";

/**
 * C4b (owner decision): the sandbox runner is the **authoritative** component for network enforcement,
 * because it is the process that owns the Docker daemon and creates the run network. The API process must
 * therefore not probe Docker itself; it asks the runner through an authenticated readiness endpoint.
 *
 * This module holds the two pieces both sides share:
 * - the runner request authentication (the same HMAC scheme every runner endpoint already uses, so a new
 *   endpoint inherits the existing mechanism instead of inventing a second one);
 * - the readiness aggregation, decomposed into the individual facts the owner asked for, built on top of
 *   the one `EgressEnforcement` probe (no second probe implementation).
 */
export interface RunnerAuthInput {
  headers: Record<string, string | string[] | undefined>;
  body: string;
  secret: string;
  /** Replay cache: nonce -> first seen timestamp. */
  seen: Map<string, number>;
  now?: number;
}
export type RunnerAuthResult = { ok: true } | { ok: false; status: number; code: string; message: string };

const RUNNER_AUTH_WINDOW_MS = 30_000;
const RUNNER_NONCE_PATTERN = /^[0-9a-f-]{36}$/i;
const RUNNER_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/**
 * Verifies a runner request. Identical rules to `/v1/sandbox`: timestamp within ±30 s, UUID nonce that was
 * never seen, HMAC-SHA256 over `${timestamp}.${nonce}.${body}` compared in constant time. A missing or
 * unusable secret fails closed.
 */
export function authenticateRunnerRequest(input: RunnerAuthInput): RunnerAuthResult {
  const now = input.now ?? Date.now();
  const timestamp = firstHeader(input.headers["x-npati-timestamp"]);
  const nonce = firstHeader(input.headers["x-npati-nonce"]);
  const signature = firstHeader(input.headers["x-npati-signature"]);
  if (!input.secret || input.secret.length < 32) {
    return { ok: false, status: 503, code: "runner_auth_not_configured", message: "Sandbox runner authentication is not configured" };
  }
  const time = Number(timestamp);
  const unauthorized: RunnerAuthResult = { ok: false, status: 401, code: "unauthorized", message: "Invalid runner authentication" };
  if (!Number.isSafeInteger(time) || Math.abs(now - time) > RUNNER_AUTH_WINDOW_MS) return unauthorized;
  if (!RUNNER_NONCE_PATTERN.test(nonce) || !RUNNER_SIGNATURE_PATTERN.test(signature)) return unauthorized;
  if (input.seen.has(nonce)) return unauthorized;
  const expected = createHmac("sha256", input.secret).update(`${timestamp}.${nonce}.${input.body}`).digest();
  const provided = Buffer.from(signature, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) return unauthorized;
  input.seen.set(nonce, now);
  for (const [key, value] of input.seen) if (now - value > 60_000) input.seen.delete(key);
  return { ok: true };
}

/** Client side of the same scheme; used by the readiness client (and by tests). */
export function signRunnerRequest(input: { secret: string; body: string; timestamp?: number; nonce?: string }): Record<string, string> {
  const timestamp = String(input.timestamp ?? Date.now());
  const nonce = input.nonce ?? randomUUID();
  const signature = createHmac("sha256", input.secret).update(`${timestamp}.${nonce}.${input.body}`).digest("hex");
  return { "content-type": "application/json", "x-npati-timestamp": timestamp, "x-npati-nonce": nonce, "x-npati-signature": signature };
}

/** The six facts the owner asked the runner to report separately. */
export interface RunnerReadinessReport {
  docker_ready: boolean;
  egress_proxy_ready: boolean;
  network_policy_ready: boolean;
  dns_policy_ready: boolean;
  required_images_ready: boolean;
  overall_ready: boolean;
  reasons: string[];
  details: Record<string, unknown>;
  checkedAt: number;
}

export interface RunnerReadinessOptions {
  /** Docker command runner (the same helper the runner already uses). */
  docker: (args: string[], timeoutMs?: number) => Promise<{ ok: boolean; output: string }>;
  /** Enforcement probe scoped to readiness infrastructure, independent of Project run scopes. */
  enforcement: EgressEnforcement;
  /** Images a run needs; both must be present locally. */
  images?: { sandbox?: string; egressProxy?: string };
  /** Short cache so the endpoint stays cheap; the enforcement probe has its own TTL. */
  ttlMs?: number;
  now?: () => number;
  prepareEgress?: () => Promise<void>;
}

export interface RunnerReadiness {
  collect(force?: boolean): Promise<RunnerReadinessReport>;
}

const DEFAULT_READINESS_TTL_MS = 10_000;

export function createRunnerReadiness(options: RunnerReadinessOptions): RunnerReadiness {
  const ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : DEFAULT_READINESS_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const images = { sandbox: options.images?.sandbox, egressProxy: options.images?.egressProxy };
  let cached: RunnerReadinessReport | undefined;

  const collect = async (force = false): Promise<RunnerReadinessReport> => {
    if (!force && cached && cached.checkedAt + ttlMs > now()) return { ...cached, details: { ...cached.details, fromCache: true } };
    const reasons: string[] = [];

    const dockerCheck = await options.docker(["version", "--format", "{{.Server.Version}}"]).catch((error: unknown) => ({ ok: false, output: error instanceof Error ? error.message : String(error) }));
    const dockerReady = dockerCheck.ok;
    if (!dockerReady) reasons.push("docker_unavailable");

    const imageChecks: Array<{ name: string; present: boolean }> = [];
    for (const [role, name] of [["sandbox", images.sandbox], ["egressProxy", images.egressProxy]] as const) {
      if (!name) { imageChecks.push({ name: `${role}:not_configured`, present: false }); reasons.push(`required_image_not_configured:${role}`); continue; }
      const present = dockerReady ? await options.docker(["image", "inspect", name, "--format", "{{.Id}}"]).then((value) => value.ok).catch(() => false) : false;
      imageChecks.push({ name, present });
      if (!present) reasons.push(`required_image_missing:${name}`);
    }
    const requiredImagesReady = imageChecks.every((entry) => entry.present);

    // One probe, decomposed: the enforcement report already proves proxy health, direct-egress blocking
    // and DNS blocking, and it fails closed when the probe is missing or the feature is disabled.
    const report: EgressEnforcementReport = await (async () => {
      if (dockerReady && requiredImagesReady) await options.prepareEgress?.();
      return options.enforcement.verify(force);
    })().catch((error: unknown) => ({
      enforced: false, reason: "probe_unavailable" as const, details: { detail: error instanceof Error ? error.message : "Readiness setup failed" }, checkedAt: now(), fromCache: false,
    }));
    const checks = report.checks;
    const egressProxyReady = checks?.proxy?.ok === true;
    const networkPolicyReady = checks?.direct?.blocked === true;
    const dnsPolicyReady = checks?.dns?.blocked === true;
    if (!egressProxyReady) reasons.push(report.reason === "proxy_unhealthy" || report.reason === "proxy_unreachable" ? "egress_proxy_unhealthy" : `egress_proxy_unverified:${report.reason ?? "unknown"}`);
    if (!networkPolicyReady) reasons.push(report.reason === "direct_egress_open" ? "direct_egress_open" : `network_policy_unverified:${report.reason ?? "unknown"}`);
    if (!dnsPolicyReady) reasons.push(report.reason === "dns_bypass_open" ? "dns_bypass_open" : `dns_policy_unverified:${report.reason ?? "unknown"}`);

    const ready = dockerReady && requiredImagesReady && egressProxyReady && networkPolicyReady && dnsPolicyReady;
    const result: RunnerReadinessReport = {
      docker_ready: dockerReady,
      egress_proxy_ready: egressProxyReady,
      network_policy_ready: networkPolicyReady,
      dns_policy_ready: dnsPolicyReady,
      required_images_ready: requiredImagesReady,
      overall_ready: ready,
      reasons: [...new Set(reasons)],
      details: {
        docker: dockerCheck.ok ? dockerCheck.output : null,
        images: imageChecks,
        enforcementReason: report.reason ?? null,
        enforcementChecks: checks ?? null,
        enforcementDetails: report.details,
        enforcementCheckedAt: report.checkedAt,
        fromCache: false,
      },
      checkedAt: now(),
    };
    cached = result;
    return result;
  };

  return { collect };
}
