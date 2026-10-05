import { execFile } from "node:child_process";

/**
 * C1b: image signature verification.
 *
 * The policy never trusts a digest on its own: a digest proves the bytes are the ones that were
 * scanned, and the signature proves who published them. Both are required before an image may run
 * code from a Company.
 *
 * Deny by default: when no verifier is configured the policy uses `NullImageSignatureVerifier`,
 * which always refuses, so a deployment that has not set up signing cannot silently admit images.
 */
export interface ImageSignatureVerification {
  ok: boolean;
  reason?: string;
  signer?: string;
}

export interface ImageSignatureVerifier {
  /**
   * Verifies that `reference` (a digest-pinned image) was signed by the expected identity.
   * Implementations must fail closed: any error means "not verified".
   */
  verify(reference: string, expectedSigner: { identity: string; issuer: string }): Promise<ImageSignatureVerification>;
}

/** Always refuses. Used when signing keys/identities are not configured. */
export class NullImageSignatureVerifier implements ImageSignatureVerifier {
  async verify(): Promise<ImageSignatureVerification> {
    return { ok: false, reason: "signature_verification_not_configured" };
  }
}

export interface CosignVerifierOptions {
  /** Extra args, e.g. `--insecure-ignore-tlog` for an air-gapped deployment. Kept explicit. */
  extraArgs?: string[];
  timeoutMs?: number;
  /** Injectable for tests: replaces `execFile`. */
  exec?: (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Verifies a signed image with `cosign verify`, keyless (certificate identity + OIDC issuer).
 * A missing binary or a failed verification is a refusal, never an admission.
 */
export class CosignImageSignatureVerifier implements ImageSignatureVerifier {
  private readonly exec: NonNullable<CosignVerifierOptions["exec"]>;

  constructor(private readonly options: CosignVerifierOptions = {}) {
    this.exec = options.exec ?? ((file, args, execOptions) => new Promise((resolve, reject) => {
      execFile(file, args, execOptions, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      });
    }));
  }

  async verify(reference: string, expectedSigner: { identity: string; issuer: string }): Promise<ImageSignatureVerification> {
    if (!expectedSigner.identity || !expectedSigner.issuer) return { ok: false, reason: "signature_identity_not_configured" };
    if (!/^[a-z0-9][a-z0-9._/-]*(?::[0-9]+)?@sha256:[0-9a-f]{64}$/.test(reference)) return { ok: false, reason: "image_not_pinned" };
    const args = [
      "verify",
      "--certificate-identity", expectedSigner.identity,
      "--certificate-oidc-issuer", expectedSigner.issuer,
      "--output", "json",
      ...(this.options.extraArgs ?? []),
      reference,
    ];
    try {
      const { stdout } = await this.exec("cosign", args, { timeout: this.options.timeoutMs ?? 20_000, maxBuffer: 512_000 });
      const signer = extractSigner(stdout);
      return signer ? { ok: true, signer } : { ok: false, reason: "signature_payload_unreadable" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: false, reason: "cosign_unavailable" };
      return { ok: false, reason: /no matching signatures|verification failed/i.test(String((error as { stderr?: string }).stderr ?? "")) ? "signature_invalid" : "signature_verification_failed" };
    }
  }
}

function extractSigner(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as Array<{ optional?: Record<string, unknown>; critical?: { identity?: { docker_reference?: string } } }>;
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    const certificate = first?.optional?.["1.3.6.1.4.1.57264.1.1"] ?? first?.optional?.Subject;
    return typeof certificate === "string" && certificate.length ? certificate.slice(0, 200) : null;
  } catch {
    return null;
  }
}
