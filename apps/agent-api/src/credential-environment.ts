/**
 * C4 (owner decision): the environment marker of a Company credential.
 *
 * `unknown` is the default for every credential created before the marker existed and for anything
 * the platform cannot classify; the SecretLease policy treats `unknown` as **not leasable** unless an
 * owner/admin explicitly overrides it, and `production` as never leasable.
 */
export type CredentialEnvironment = "development" | "staging" | "production" | "unknown";

export const CREDENTIAL_ENVIRONMENTS: readonly CredentialEnvironment[] = ["development", "staging", "production", "unknown"] as const;
export const DEFAULT_CREDENTIAL_ENVIRONMENT: CredentialEnvironment = "unknown";

/** Accepts the stored values plus common aliases and normalises anything unknown to `unknown`. */
export function normalizeCredentialEnvironment(value: unknown): CredentialEnvironment {
  if (typeof value !== "string") return DEFAULT_CREDENTIAL_ENVIRONMENT;
  const marker = value.trim().toLowerCase();
  if (!marker) return DEFAULT_CREDENTIAL_ENVIRONMENT;
  if (marker === "development" || marker === "dev" || marker === "local" || marker === "test" || marker === "testing") return "development";
  if (marker === "staging" || marker === "stage" || marker === "preprod" || marker === "pre-production" || marker === "sandbox") return "staging";
  if (marker === "production" || marker === "prod" || marker === "live") return "production";
  return DEFAULT_CREDENTIAL_ENVIRONMENT;
}

export function isCredentialEnvironment(value: unknown): value is CredentialEnvironment {
  return typeof value === "string" && (CREDENTIAL_ENVIRONMENTS as readonly string[]).includes(value);
}

/** Only these environments may be leased without an explicit owner/admin override. */
export function isLeasableEnvironment(environment: CredentialEnvironment): boolean {
  return environment === "development" || environment === "staging";
}
