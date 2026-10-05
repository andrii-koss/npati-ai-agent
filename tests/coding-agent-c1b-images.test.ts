import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { SandboxImagePolicy, SandboxImageError, type AuditRecorder } from "../apps/agent-api/src/sandbox-image-policy";
import { CosignImageSignatureVerifier, NullImageSignatureVerifier, type ImageSignatureVerifier } from "../apps/agent-api/src/sandbox-image-signature";
import { SandboxImageCatalogError, loadSandboxImageCatalog, parseCatalog, validateCatalog } from "../apps/agent-api/src/sandbox-image-catalog";
import { buildSandboxCreateArgs } from "../apps/agent-api/src/docker-sandbox-provider";

const digest = (char: string) => char.repeat(64);
const NODE_IMAGE = `ghcr.io/npati/project-sandbox-node@sha256:${digest("a")}`;
const NEW_NODE_IMAGE = `ghcr.io/npati/project-sandbox-node@sha256:${digest("b")}`;
const REVOKED_IMAGE = `ghcr.io/npati/project-sandbox-python@sha256:${digest("c")}`;

const admin: AuthContext = { workspaceId: "ws-images", userId: "user-admin", permissions: ["workspace:read", "business:manage", "admin:all"] };
const member: AuthContext = { workspaceId: "ws-images", userId: "user-member", permissions: ["workspace:read", "business:manage"] };
const COMPANY = "company-images";

const allowVerifier: ImageSignatureVerifier = { verify: async () => ({ ok: true, signer: "ci@npati.dev" }) };
const fixedClock = (iso: string) => () => new Date(iso);

async function harness(options: {
  verifier?: ImageSignatureVerifier;
  now?: () => Date;
  allowUnverifiedImages?: boolean;
  environment?: string;
  flagsEnabled?: string[];
  audit?: AuditRecorder | undefined;
} = {}) {
  const store = new InMemoryWorkspaceStore();
  await store.initialize();
  await store.createCompany(admin, { name: "Images Co" }, COMPANY);
  const audit: AuditRecorder | undefined = "audit" in options ? options.audit : {
    record: vi.fn(async () => undefined),
  };
  const policy = new SandboxImagePolicy(store, {
    verifier: options.verifier ?? allowVerifier,
    signer: { identity: "ci@npati.dev", issuer: "https://token.actions.githubusercontent.com" },
    now: options.now ?? fixedClock("2026-02-10T00:00:00.000Z"),
    audit,
    maxImageAgeDays: 14,
    allowUnverifiedImages: options.allowUnverifiedImages ?? false,
    environment: options.environment ?? "production",
    catalog: { images: [] },
    flags: options.flagsEnabled
      ? { isEnabled: async (_ctx, key) => options.flagsEnabled!.includes(key) }
      : undefined,
  });
  return { store, policy, audit };
}

const verified = {
  variant: "node" as const,
  reference: NODE_IMAGE,
  // The recorded digest is the canonical `sha256:<64 hex>` form (same shape as docker/sandbox/images.json
  // and as digestOf(reference)), not the bare hex string.
  digest: `sha256:${digest("a")}`,
  status: "verified" as const,
  signature: "ci@npati.dev",
  signatureIssuer: "https://token.actions.githubusercontent.com",
  sbomPath: "s3://npati-sbom/node.spdx.json",
  scanTool: "trivy",
  scanAt: "2026-02-09T00:00:00.000Z",
  scanCritical: 0,
  scanHigh: 2,
};

describe("security-gate: C1b image admission", () => {
  it("refuses tags, :latest and anything that is not digest-pinned", async () => {
    const { policy } = await harness();
    for (const reference of ["ghcr.io/npati/project-sandbox-node:latest", "ghcr.io/npati/project-sandbox-node:1.2.3", "npati/project-sandbox", `${NODE_IMAGE} `, "ghcr.io/npati/sandbox@sha256:short"]) {
      await expect(policy.admit(admin, { companyId: COMPANY, reference })).rejects.toMatchObject({ code: "image_not_pinned", status: 403 });
    }
  });

  it("refuses an image that is not in the catalogue and one that is only unverified", async () => {
    const { store, policy } = await harness();
    await expect(policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).rejects.toMatchObject({ code: "image_not_allowed" });
    await store.upsertSandboxImage(admin, { ...verified, status: "unverified" });
    await expect(policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).rejects.toMatchObject({ code: "image_not_allowed", details: { status: "unverified" } });
  });

  it("admits a verified, freshly scanned and signed digest", async () => {
    const { store, policy } = await harness();
    await store.upsertSandboxImage(admin, verified);
    await expect(policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).resolves.toMatchObject({ allowed: true, reference: NODE_IMAGE, digest: `sha256:${digest("a")}`, dev: false });
  });

  it("refuses a revoked digest and asks for an upgrade with a replacement", async () => {
    const { store, policy } = await harness();
    await store.upsertSandboxImage(admin, { ...verified, reference: REVOKED_IMAGE, digest: `sha256:${digest("c")}`, variant: "python", status: "revoked" });
    await store.upsertSandboxImage(admin, { ...verified, reference: NODE_IMAGE, digest: `sha256:${digest("a")}` });
    const refused = await policy.admit(admin, { companyId: COMPANY, reference: REVOKED_IMAGE }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SandboxImageError);
    expect(refused).toMatchObject({ code: "image_revoked", status: 409, details: { forcedUpgrade: true } });
  });

  it("refuses a reference whose digest does not match the recorded row", async () => {
    const { store, policy } = await harness();
    await store.upsertSandboxImage(admin, { ...verified, digest: `sha256:${digest("f")}` });
    await expect(policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).rejects.toMatchObject({ code: "image_digest_mismatch", status: 409 });
  });

  it("refuses a stale scan and a missing scan", async () => {
    const { store, policy } = await harness({ now: fixedClock("2026-03-01T00:00:00.000Z") });
    await store.upsertSandboxImage(admin, { ...verified, scanAt: "2026-02-01T00:00:00.000Z" });
    await expect(policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).rejects.toMatchObject({ code: "image_scan_stale", status: 409 });

    const missing = await harness();
    await missing.store.upsertSandboxImage(admin, { ...verified, scanAt: null });
    await expect(missing.policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).rejects.toMatchObject({ code: "image_scan_failed", details: { reason: "scan_missing" } });
  });

  it("refuses critical findings without a waiver, and an expired waiver", async () => {
    const noWaiver = await harness();
    await noWaiver.store.upsertSandboxImage(admin, { ...verified, scanCritical: 3 });
    await expect(noWaiver.policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).rejects.toMatchObject({ code: "image_scan_failed", details: { scanCritical: 3 } });

    const expired = await harness({ now: fixedClock("2026-02-10T00:00:00.000Z") });
    await expired.store.upsertSandboxImage(admin, { ...verified, scanCritical: 3, waiverOwner: "ciso@npati.dev", waiverExpiresAt: "2026-02-01T00:00:00.000Z" });
    await expect(expired.policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).rejects.toMatchObject({ code: "image_waiver_expired", status: 409 });

    const valid = await harness();
    await valid.store.upsertSandboxImage(admin, { ...verified, scanCritical: 3, waiverOwner: "ciso@npati.dev", waiverExpiresAt: "2026-03-01T00:00:00.000Z", waiverReason: "no upstream fix" });
    await expect(valid.policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).resolves.toMatchObject({ allowed: true });
    expect(valid.audit).toBeDefined();
  });

  it("denies by default when no signature verifier is configured, and when the signature does not verify", async () => {
    const unconfigured = await harness({ verifier: new NullImageSignatureVerifier() });
    await unconfigured.store.upsertSandboxImage(admin, verified);
    await expect(unconfigured.policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE }))
      .rejects.toMatchObject({ code: "image_signature_invalid", details: { reason: "signature_verification_not_configured" } });

    const failing = await harness({ verifier: { verify: async () => ({ ok: false, reason: "signature_invalid" }) } });
    await failing.store.upsertSandboxImage(admin, verified);
    await expect(failing.policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).rejects.toMatchObject({ code: "image_signature_invalid" });
  });

  it("treats a missing cosign binary as a refusal, never as an admission", async () => {
    const verifier = new CosignImageSignatureVerifier({
      exec: async () => { throw Object.assign(new Error("spawn cosign ENOENT"), { code: "ENOENT" }); },
    });
    expect(await verifier.verify(NODE_IMAGE, { identity: "ci@npati.dev", issuer: "https://issuer" })).toMatchObject({ ok: false, reason: "cosign_unavailable" });

    const rejected = new CosignImageSignatureVerifier({
      exec: async () => { throw Object.assign(new Error("verify failed"), { stderr: "Error: no matching signatures" }); },
    });
    expect(await rejected.verify(NODE_IMAGE, { identity: "ci@npati.dev", issuer: "https://issuer" })).toMatchObject({ ok: false, reason: "signature_invalid" });

    const accepted = new CosignImageSignatureVerifier({
      exec: async () => ({ stdout: JSON.stringify([{ optional: { "1.3.6.1.4.1.57264.1.1": "https://token.actions.githubusercontent.com" } }]), stderr: "" }),
    });
    expect(await accepted.verify(NODE_IMAGE, { identity: "ci@npati.dev", issuer: "https://issuer" })).toMatchObject({ ok: true });
  });

  it("allows a development image only outside production and only while no production flag is on", async () => {
    const dev = await harness({ allowUnverifiedImages: true, environment: "development" });
    await expect(dev.policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).resolves.toMatchObject({ allowed: true, dev: true });
    // the locally built image is recorded as unverified, never as verified
    expect((await dev.store.getSandboxImage(admin, NODE_IMAGE))?.status).toBe("unverified");

    const production = await harness({ allowUnverifiedImages: true, environment: "production" });
    await expect(production.policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).rejects.toMatchObject({ code: "image_not_allowed" });

    const flagged = await harness({ allowUnverifiedImages: true, environment: "development", flagsEnabled: ["code.full_auto_sandbox"] });
    await expect(flagged.policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).rejects.toMatchObject({ code: "image_not_allowed" });

    const disabledByCaller = await harness({ allowUnverifiedImages: true, environment: "development" });
    await expect(disabledByCaller.policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE, devMode: false })).rejects.toMatchObject({ code: "image_not_allowed" });

    const off = await harness({ allowUnverifiedImages: false, environment: "development" });
    await expect(off.policy.admit(admin, { companyId: COMPANY, reference: NODE_IMAGE })).rejects.toMatchObject({ code: "image_not_allowed" });
  });
});

describe("security-gate: C1b image administration and audit", () => {
  it("requires the owner/admin role for allow, revoke and waiver", async () => {
    const { policy } = await harness();
    await expect(policy.allow(member, { ...verified, companyId: COMPANY })).rejects.toMatchObject({ code: "image_admin_required", status: 403 });
    await expect(policy.revoke(member, COMPANY, NODE_IMAGE, "compromised")).rejects.toMatchObject({ code: "image_admin_required" });
    await expect(policy.waive(member, COMPANY, NODE_IMAGE, { owner: "x", expiresAt: "2026-03-01T00:00:00.000Z", reason: "y" })).rejects.toMatchObject({ code: "image_admin_required" });
  });

  it("audits every allow, revoke and waiver before applying it", async () => {
    const record = vi.fn(async () => undefined);
    const { policy } = await harness({ audit: { record } });
    await policy.allow(admin, { ...verified, companyId: COMPANY });
    await policy.revoke(admin, COMPANY, NODE_IMAGE, "compromised base image");
    expect(record.mock.calls.map((call) => (call[1] as { action: string }).action)).toEqual(["sandbox_image.allow", "sandbox_image.revoke"]);
    expect(record.mock.calls[0]![1]).toMatchObject({ companyId: COMPANY, actorRole: "admin", decision: "allowed", resourceType: "sandbox_image" });
  });

  it("refuses allow and revoke when the audit journal is unavailable (fail closed)", async () => {
    const failing: AuditRecorder = { record: async () => { throw new Error("audit journal unavailable"); } };
    const { store, policy } = await harness({ audit: failing });
    await expect(policy.allow(admin, { ...verified, companyId: COMPANY })).rejects.toThrow(/audit journal unavailable/);
    expect(await store.getSandboxImage(admin, NODE_IMAGE)).toBeNull();

    await store.upsertSandboxImage(admin, verified);
    await expect(policy.revoke(admin, COMPANY, NODE_IMAGE, "compromised")).rejects.toThrow(/audit journal unavailable/);
    expect((await store.getSandboxImage(admin, NODE_IMAGE))?.status).toBe("verified");

    const none = await harness({ audit: undefined });
    await expect(none.policy.allow(admin, { ...verified, companyId: COMPANY })).rejects.toMatchObject({ code: "sandbox_image_policy_unavailable" });
  });

  it("keeps a session on its digest, adopts a new digest only through the rollout flag, and forces an upgrade after revocation", async () => {
    const { store, policy } = await harness({ flagsEnabled: [] });
    await store.upsertSandboxImage(admin, verified);
    await store.upsertSandboxImage(admin, { ...verified, reference: NEW_NODE_IMAGE, digest: `sha256:${digest("b")}`, scanAt: "2026-02-09T12:00:00.000Z" });

    // No rollout flag: the session keeps the digest it was created with.
    await expect(policy.selectForRollout(admin, { companyId: COMPANY, variant: "node", currentReference: NODE_IMAGE }))
      .resolves.toMatchObject({ reference: NODE_IMAGE, forcedUpgrade: false, reason: "session_pinned_digest" });

    // Rollout flag for the new digest prefix: a new session adopts it.
    const rollout = await harness({ flagsEnabled: [`code.sandbox_image.${digest("b").slice(0, 8)}`] });
    await rollout.store.upsertSandboxImage(admin, verified);
    await rollout.store.upsertSandboxImage(admin, { ...verified, reference: NEW_NODE_IMAGE, digest: `sha256:${digest("b")}`, scanAt: "2026-02-09T12:00:00.000Z" });
    await expect(rollout.policy.selectForRollout(admin, { companyId: COMPANY, variant: "node", currentReference: NODE_IMAGE }))
      .resolves.toMatchObject({ reference: NEW_NODE_IMAGE, reason: "rollout_flag_enabled" });

    // Revoked pinned digest: the caller is told to upgrade.
    await store.revokeSandboxImage(admin, NODE_IMAGE, { actor: admin.userId, reason: "CVE" });
    const forced = await policy.selectForRollout(admin, { companyId: COMPANY, variant: "node", currentReference: NODE_IMAGE });
    expect(forced).toMatchObject({ forcedUpgrade: true, reason: "current_digest_revoked", reference: NEW_NODE_IMAGE });
  });

  it("records scan results and refuses to record one for an unknown image", async () => {
    const { store, policy } = await harness();
    await store.upsertSandboxImage(admin, { ...verified, status: "unverified" });
    const updated = await policy.recordScan(admin, NODE_IMAGE, { tool: "grype", at: "2026-02-09T18:00:00.000Z", critical: 0, high: 1 });
    expect(updated).toMatchObject({ scanTool: "grype", scanCritical: 0, scanHigh: 1 });
    await expect(policy.recordScan(admin, NEW_NODE_IMAGE, { tool: "grype", at: "2026-02-09T18:00:00.000Z", critical: 0, high: 0 }))
      .rejects.toMatchObject({ code: "image_not_allowed" });
  });
});

describe("security-gate: C1b image catalogue and container hardening", () => {
  it("rejects a catalogue with tags, missing SBOM, unknown status or a bad timestamp", async () => {
    const catalog = {
      images: [
        { variant: "node", reference: "ghcr.io/npati/node:latest", status: "verified", sbomPath: "s3://x", scanAt: "2026-02-09T00:00:00.000Z" },
        { variant: "node", reference: NODE_IMAGE, status: "verified", sbomPath: "", scanAt: "2026-02-09T00:00:00.000Z" },
        { variant: "node", reference: NEW_NODE_IMAGE, status: "trusted", sbomPath: "s3://x", scanAt: "2026-02-09T00:00:00.000Z" },
        { variant: "node", reference: `ghcr.io/npati/z@sha256:${digest("d")}`, status: "verified", sbomPath: "s3://x", scanAt: "not-a-date" },
        { variant: "cobol" as never, reference: `ghcr.io/npati/w@sha256:${digest("f")}`, status: "verified", sbomPath: "s3://x", scanAt: "2026-02-09T00:00:00.000Z" },
        { variant: "node", reference: `ghcr.io/npati/y@sha256:${digest("e")}`, status: "verified", sbomPath: "s3://x", scanAt: "2026-02-09T00:00:00.000Z" },
        { variant: "node", reference: `ghcr.io/npati/y@sha256:${digest("e")}`, status: "verified", sbomPath: "s3://x", scanAt: "2026-02-09T00:00:00.000Z" },
      ],
    };
    const problems = validateCatalog(catalog);
    expect(problems.map((problem) => problem.reason)).toEqual(expect.arrayContaining(["reference_must_be_digest_pinned", "sbom_path_is_required", "unknown_status", "scan_timestamp_is_required", "unknown_variant", "duplicate_reference"]));
    expect(() => parseCatalog(JSON.stringify(catalog))).toThrow(SandboxImageCatalogError);
    expect(() => parseCatalog("{not json")).toThrow(SandboxImageCatalogError);
  });

  it("returns an empty catalogue for a missing file instead of trusting anything", async () => {
    const log = vi.fn();
    const catalog = await loadSandboxImageCatalog("does/not/exist/images.json", log);
    expect(catalog.images).toEqual([]);
    expect(log).toHaveBeenCalledWith("sandbox_image_catalog_unavailable", expect.objectContaining({ path: "does/not/exist/images.json" }));
  });

  it("builds a hardened docker command line with the admitted digest and no privileged extras", () => {
    const args = buildSandboxCreateArgs({
      sandboxName: "npati-sb-11111111-1111-1111-1111-111111111111",
      sandboxId: "11111111-1111-1111-1111-111111111111",
      network: "npati-net-11111111-1111-1111-1111-111111111111",
      scope: { workspaceId: "ws", userId: "u", companyId: "c", projectId: "p" },
      image: NODE_IMAGE,
      cpus: "1",
      memory: "1536m",
      pids: 128,
      diskBytes: 1536 * 1024 * 1024,
      seccompProfile: "/etc/npati/seccomp.json",
    });
    const joined = args.join(" ");
    for (const expected of ["--cap-drop ALL", "--read-only", "--security-opt no-new-privileges", "--security-opt seccomp=/etc/npati/seccomp.json", "--user 10001:10001", "--tmpfs /workspace:rw,exec,nosuid,nodev,uid=10001,gid=10001", "--pids-limit 128", NODE_IMAGE]) {
      expect(joined).toContain(expected);
    }
    for (const forbidden of ["--privileged", "docker.sock", "-v /", "--pid=host", "--network=host", ":latest"]) {
      expect(joined).not.toContain(forbidden);
    }
    // The seccomp profile is optional: without it the rest of the hardening stays.
    const withoutSeccomp = buildSandboxCreateArgs({ sandboxName: "npati-sb-x", sandboxId: "x", network: "npati-net-x", scope: { workspaceId: "ws", userId: "u", companyId: "c", projectId: "p" }, image: NODE_IMAGE, cpus: "1", memory: "1536m", pids: 128, diskBytes: 1 });
    expect(withoutSeccomp.join(" ")).not.toContain("seccomp=");
    expect(withoutSeccomp.join(" ")).toContain("--cap-drop ALL");
  });
});
