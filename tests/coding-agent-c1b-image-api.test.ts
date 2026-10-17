import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { AuthContext, SandboxImage } from "@npati/workspace";
import { AuthenticationError } from "../apps/agent-api/src/auth";
import {
  registerSandboxImageRoutes, validateImageReference,
  type SandboxImageAdmin, type SandboxImageLister,
} from "../apps/agent-api/src/sandbox-image-routes";

/**
 * C1b security-gate: the sandbox image API.
 *
 * The policy and the store are local stubs, so these tests cover the HTTP contract and its guards
 * without depending on the policy workstream: digest pinning, the administrative role, structured
 * error codes, the read-only admission check, ownership and the API version on every response.
 */

const DIGEST = "a".repeat(64);
const REFERENCE = `ghcr.io/npati/code-sandbox-node@sha256:${DIGEST}`;
const REVOKED_REFERENCE = `ghcr.io/npati/code-sandbox-python@sha256:${"b".repeat(64)}`;

const admin: AuthContext = { workspaceId: "ws-c1b", userId: "c1b-admin", permissions: ["workspace:read", "business:manage", "admin:all"] };
const member: AuthContext = { workspaceId: "ws-c1b", userId: "c1b-member", permissions: ["workspace:read", "business:manage"] };

function image(overrides: Partial<SandboxImage> = {}): SandboxImage {
  return {
    id: "img-1", workspaceId: "ws-c1b", variant: "node", reference: REFERENCE, digest: DIGEST, status: "verified",
    signature: "cosign:keyless", sbomPath: "sbom/node.json", scanTool: "trivy", scanAt: "2024-06-01T00:00:00.000Z",
    scanCritical: 0, scanHigh: 2, waiverOwner: null, waiverExpiresAt: null, previousReference: null,
    createdBy: "c1b-admin", createdAt: "2024-06-01T00:00:00.000Z", updatedAt: "2024-06-01T00:00:00.000Z", ...overrides,
  };
}

/** Minimal structural policy: only the surface the router consumes. */
function stubPolicy(overrides: Partial<SandboxImageAdmin> = {}): SandboxImageAdmin {
  const base: SandboxImageAdmin = {
    async admit(_ctx, input) {
      if (input.reference === REVOKED_REFERENCE) throw Object.assign(new Error("Image is revoked"), { code: "image_revoked", status: 409 });
      return { allowed: true, reference: input.reference, digest: DIGEST, variant: input.variant ?? "node", dev: false };
    },
    async allow(_ctx, input) { return image({ variant: input.variant, reference: input.reference, status: input.status ?? "unverified" }); },
    async revoke(_ctx, _companyId, reference) {
      if (reference === REVOKED_REFERENCE) throw Object.assign(new Error("Image is already revoked"), { code: "image_revoked", status: 409 });
      return image({ reference, status: "revoked" });
    },
    async recordScan(_ctx, reference, scan) { return image({ reference, scanTool: scan.tool, scanCritical: scan.critical, scanHigh: scan.high }); },
    catalogState() { return { configured: true, path: "docker/sandbox/images.json" }; },
  };
  return { ...base, ...overrides };
}

function stubStore(overrides: Partial<SandboxImageLister> = {}): SandboxImageLister {
  const base: SandboxImageLister = {
    async listSandboxImages() {
      return [
        image(),
        image({ id: "img-2", variant: "python", reference: REVOKED_REFERENCE, status: "revoked", scanCritical: 3 }),
      ];
    },
    async getCompany() { return { id: "c1" }; },
  };
  return { ...base, ...overrides };
}

function build(actor: AuthContext | "anonymous", policy?: SandboxImageAdmin, store?: SandboxImageLister) {
  const app = Fastify();
  registerSandboxImageRoutes(app, {
    authenticate: async () => {
      if (actor === "anonymous") throw new AuthenticationError("unauthorized");
      return actor;
    },
  } as never, policy, store);
  return app;
}

describe("security-gate: C1b sandbox image API", () => {
  it("requires authentication and an explicit administrative role for mutations", async () => {
    const anonymous = build("anonymous", stubPolicy(), stubStore());
    expect((await anonymous.inject({ method: "GET", url: "/companies/c1/code/sandbox-images" })).statusCode).toBe(401);
    expect((await anonymous.inject({ method: "POST", url: "/companies/c1/code/sandbox-images", payload: { variant: "node", reference: REFERENCE } })).statusCode).toBe(401);
    await anonymous.close();

    const asMember = build(member, stubPolicy(), stubStore());
    for (const [url, payload] of [
      ["/companies/c1/code/sandbox-images", { variant: "node", reference: REFERENCE }],
      ["/companies/c1/code/sandbox-images/revoke", { reference: REFERENCE, reason: "test" }],
      ["/companies/c1/code/sandbox-images/img-1/scan", { tool: "trivy", critical: 0, high: 0 }],
    ] as const) {
      const response = await asMember.inject({ method: "POST", url, payload });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("image_admin_required");
    }
    // Reads and the admission check stay available to a member.
    expect((await asMember.inject({ method: "GET", url: "/companies/c1/code/sandbox-images" })).statusCode).toBe(200);
    expect((await asMember.inject({ method: "POST", url: "/companies/c1/code/sandbox-images/admission-check", payload: { reference: REFERENCE } })).statusCode).toBe(200);
    await asMember.close();
  });

  it("refuses tags and :latest, and accepts only a digest-pinned reference", async () => {
    const app = build(admin, stubPolicy(), stubStore());
    for (const reference of ["ghcr.io/npati/code-sandbox-node:latest", "ghcr.io/npati/code-sandbox-node:1.2.3", "ghcr.io/npati/code-sandbox-node", "ghcr.io/npati/code-sandbox-node@sha256:short"]) {
      const response = await app.inject({ method: "POST", url: "/companies/c1/code/sandbox-images", payload: { variant: "node", reference } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("image_not_pinned");
    }
    const created = await app.inject({ method: "POST", url: "/companies/c1/code/sandbox-images", payload: { variant: "node", reference: REFERENCE, status: "verified" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().image.reference).toBe(REFERENCE);
    expect(created.json().apiVersion).toBe("v1");
    await app.close();
  });

  it("returns structured errors for revoked images, invalid scans and unknown ids", async () => {
    const app = build(admin, stubPolicy(), stubStore());
    const revoked = await app.inject({ method: "POST", url: "/companies/c1/code/sandbox-images/revoke", payload: { reference: REVOKED_REFERENCE, reason: "compromised" } });
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json().error.code).toBe("image_revoked");

    const missingReason = await app.inject({ method: "POST", url: "/companies/c1/code/sandbox-images/revoke", payload: { reference: REFERENCE } });
    expect(missingReason.statusCode).toBe(403);
    expect(missingReason.json().error.code).toBe("image_not_allowed");

    for (const payload of [
      { tool: "trivy", critical: -1, high: 0 },
      { tool: "trivy", critical: 1.5, high: 0 },
      { tool: "", critical: 0, high: 0 },
    ]) {
      const response = await app.inject({ method: "POST", url: "/companies/c1/code/sandbox-images/img-1/scan", payload });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("image_scan_failed");
    }

    const unknown = await app.inject({ method: "POST", url: "/companies/c1/code/sandbox-images/does-not-exist/scan", payload: { tool: "trivy", critical: 0, high: 0 } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("image_not_found");

    const scanStale = build(admin, stubPolicy({
      async recordScan() { throw Object.assign(new Error("Scan is stale"), { code: "image_scan_stale", status: 409, retryable: true }); },
    }), stubStore());
    const stale = await scanStale.inject({ method: "POST", url: "/companies/c1/code/sandbox-images/img-1/scan", payload: { tool: "trivy", critical: 0, high: 0 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: "image_scan_stale", retryable: true });
    await scanStale.close();
    await app.close();
  });

  it("admission check answers without starting anything and never leaks internals", async () => {
    const app = build(admin, stubPolicy(), stubStore());
    const admitted = await app.inject({ method: "POST", url: "/companies/c1/code/sandbox-images/admission-check", payload: { reference: REFERENCE } });
    expect(admitted.statusCode).toBe(200);
    expect(admitted.json()).toMatchObject({ allowed: true, reference: REFERENCE, digest: DIGEST, apiVersion: "v1" });

    const denied = await app.inject({ method: "POST", url: "/companies/c1/code/sandbox-images/admission-check", payload: { reference: REVOKED_REFERENCE } });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe("image_revoked");

    const unpinned = await app.inject({ method: "POST", url: "/companies/c1/code/sandbox-images/admission-check", payload: { reference: "ghcr.io/npati/code-sandbox-node:latest" } });
    expect(unpinned.statusCode).toBe(400);
    expect(unpinned.json().error.code).toBe("image_not_pinned");

    const missing = await app.inject({ method: "POST", url: "/companies/c1/code/sandbox-images/admission-check", payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("image_not_pinned");

    // An unexpected store failure must not surface a stack trace or an internal connection string.
    const exploding = build(admin, stubPolicy(), stubStore({ async listSandboxImages() { throw new Error("connection to postgres://user:pw@db failed"); } }));
    const failure = await exploding.inject({ method: "GET", url: "/companies/c1/code/sandbox-images" });
    expect(failure.statusCode).toBe(500);
    expect(failure.json().error.code).toBe("image_error");
    expect(JSON.stringify(failure.json())).not.toContain("postgres://");
    await exploding.close();
    await app.close();
  });

  it("keeps the company boundary: another owner cannot list this company's images", async () => {
    const foreignStore = stubStore({ async getCompany() { throw new Error("Company is not available to this user"); } });
    const app = build(admin, stubPolicy(), foreignStore);
    const response = await app.inject({ method: "GET", url: "/companies/other-company/code/sandbox-images" });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("image_not_allowed");
    expect(JSON.stringify(response.json())).not.toContain("not available to this user");
    await app.close();
  });

  it("advertises the API version and a feature-safe error when the policy is absent", async () => {
    const app = build(admin, stubPolicy(), stubStore());
    const listed = await app.inject({ method: "GET", url: "/companies/c1/code/sandbox-images" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().apiVersion).toBe("v1");
    expect(listed.json().images).toHaveLength(2);
    expect(listed.json().catalog.configured).toBe(true);
    expect(typeof listed.json().policy.maxScanAgeDays).toBe("number");
    await app.close();

    const unconfigured = build(admin, undefined, stubStore());
    const response = await unconfigured.inject({ method: "GET", url: "/companies/c1/code/sandbox-images" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("image_unavailable");
    await unconfigured.close();
  });

  it("validates references independently of the policy (unit guard)", () => {
    expect(validateImageReference(REFERENCE)).toEqual({ ok: true, reference: REFERENCE });
    expect(validateImageReference(`repo:latest@sha256:${DIGEST}`)).toMatchObject({ ok: false });
    expect(validateImageReference("repo@sha256:" + "z".repeat(64))).toMatchObject({ ok: false });
    expect(validateImageReference("")).toMatchObject({ ok: false });
    expect(validateImageReference(undefined)).toMatchObject({ ok: false });
  });
});

describe("security-gate: C1b independent company authorization", () => {
  it.each(["allow", "revoke", "scan", "admit"] as const)("refuses foreign-company %s before calling the policy", async (operation) => {
    let dispatched = 0;
    const unexpected = async () => { dispatched++; throw new Error("Policy must not be reached"); };
    const app = build(admin, stubPolicy({ allow: unexpected, revoke: unexpected, recordScan: unexpected, admit: unexpected }),
      stubStore({ getCompany: async () => { throw new Error("Foreign company"); } }));
    try {
      const base = "/companies/foreign/code/sandbox-images";
      const requests = {
        allow: { url: base, payload: { variant: "node", reference: REFERENCE } },
        revoke: { url: base + "/revoke", payload: { reference: REFERENCE, reason: "CVE" } },
        scan: { url: base + "/img-1/scan", payload: { tool: "trivy", critical: 0, high: 0 } },
        admit: { url: base + "/admission-check", payload: { reference: REFERENCE } },
      };
      const response = await app.inject({ method: "POST", ...requests[operation] });
      expect(response.statusCode).toBe(403);
      expect(dispatched).toBe(0);
    } finally { await app.close(); }
  });
});
