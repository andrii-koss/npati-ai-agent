import { describe, expect, it } from "vitest";
import {
  parseExactHttpOrigin,
  rewriteSetCookieHeader,
  filterIncomingCookies,
} from "../apps/agent-api/src/project-preview-service";
import { ProjectApiGatewayService } from "../apps/agent-api/src/data-studio/gateway-service";
import { MockEmailProvider, UnconfiguredEmailProvider } from "../apps/agent-api/src/data-studio/email-provider";
import { DataStudioError } from "../apps/agent-api/src/data-studio/identifier";

// These suites test the proxy mechanics on the app host; host isolation itself (audit H1) is pinned in
// tests/security-audit-h1-preview-isolation.test.ts. Self-hosted opt-in, never honoured on npati_hosted.
process.env.NPATI_PREVIEW_ALLOW_APP_ORIGIN = "true";

describe("Stage 2: NPATI Website Integration - Auth, CORS & Preview Proxy", () => {
  describe("1. Exact Origin & CORS Synchronization", () => {
    it("parseExactHttpOrigin validates exact HTTP(S) origins and rejects wildcards / malformed origins", () => {
      expect(parseExactHttpOrigin("http://localhost:3000")).toBe("http://localhost:3000");
      expect(parseExactHttpOrigin("https://preview.npati.app")).toBe("https://preview.npati.app");
      expect(parseExactHttpOrigin("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173");

      // Invalid / Wildcards / Bad protocols
      expect(parseExactHttpOrigin("*")).toBeNull();
      expect(parseExactHttpOrigin("http://*")).toBeNull();
      expect(parseExactHttpOrigin("https://*.npati.app")).toBeNull();
      expect(parseExactHttpOrigin("ftp://example.com")).toBeNull();
      expect(parseExactHttpOrigin("not-a-url")).toBeNull();
      expect(parseExactHttpOrigin("http://localhost:3000/path")).toBeNull();
      expect(parseExactHttpOrigin("")).toBeNull();
      expect(parseExactHttpOrigin(undefined)).toBeNull();
    });

    it("resolveAllowedOrigins synchronizes corsOriginsByProject and falls back to corsAllowedOrigins", () => {
      const gateway = new ProjectApiGatewayService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      const projectId = "proj-123";

      // 1. When project-specific origins are configured
      const configWithProject = {
        corsOriginsByProject: {
          "proj-123": ["http://localhost:3000", "https://preview.example.com", "*"],
        },
        corsAllowedOrigins: ["http://fallback.com"],
      };
      const allowed1 = gateway.resolveAllowedOrigins(configWithProject, projectId);
      // Notice wildcard '*' is filtered out
      expect(allowed1).toEqual(["http://localhost:3000", "https://preview.example.com"]);

      // 2. When project-specific list is empty, fallback to corsAllowedOrigins
      const configFallback = {
        corsOriginsByProject: {
          "proj-123": [],
        },
        corsAllowedOrigins: ["http://localhost:3000", "http://localhost:5173", "invalid-origin", "*"],
      };
      const allowed2 = gateway.resolveAllowedOrigins(configFallback, projectId);
      expect(allowed2).toEqual(["http://localhost:3000", "http://localhost:5173"]);

      // 3. Exact matching in isOriginAllowed
      expect(gateway.isOriginAllowed("http://localhost:3000", allowed2, projectId)).toBe(true);
      expect(gateway.isOriginAllowed("http://localhost:4000", allowed2, projectId)).toBe(false);
      expect(gateway.isOriginAllowed("https://evil-attacker.com", allowed2, projectId)).toBe(false);
      expect(gateway.isOriginAllowed("*", allowed2, projectId)).toBe(false);
    });
  });

  describe("2. Preview Proxy Session & Cookie Isolation", () => {
    const projectId = "715009ee-a7bf-4999-bce2-053d207b7af5";
    const companyId = "e8fb3cc1-4809-4c95-a10a-1c7e2a57913b";
    const projectPrefix = `_npati_p_${projectId.slice(0, 8)}_`;
    const proxyPath = `/api/companies/${companyId}/projects/${projectId}/preview/proxy`;

    it("rewrites outgoing Set-Cookie to namespace cookie name, scope path, strip domain, and enforce Lax", () => {
      const originalCookie = "user_session=abc12345; Path=/; Domain=npati.local; HttpOnly; SameSite=Strict";
      const rewritten = rewriteSetCookieHeader(originalCookie, projectPrefix, proxyPath);

      expect(rewritten).toContain(`_npati_p_715009ee_user_session=abc12345`);
      expect(rewritten).toContain(`Path=${proxyPath}`);
      expect(rewritten).toContain(`SameSite=Lax`);
      expect(rewritten).toContain(`HttpOnly`);
      expect(rewritten).not.toContain(`Domain=`);
    });

    it("applies default Path and SameSite if not specified in upstream cookie", () => {
      const simpleCookie = "theme=dark";
      const rewritten = rewriteSetCookieHeader(simpleCookie, projectPrefix, proxyPath);

      expect(rewritten).toBe(`_npati_p_715009ee_theme=dark; Path=${proxyPath}; SameSite=Lax`);
    });

    it("filters incoming cookies: isolates project cookies and strips NPATI platform cookies", () => {
      const incomingCookieHeader = [
        "npati_session=PLATFORM_SECRET",
        "_npati_auth_token=JWT_TOKEN",
        `_npati_p_715009ee_user_session=client_site_token`,
        `_npati_p_715009ee_cart_id=cart_999`,
        `_npati_p_otherpro_session=leaked_from_other_project`,
      ].join("; ");

      const filtered = filterIncomingCookies(incomingCookieHeader, projectPrefix);

      // Only this project's cookies must remain, and the internal prefix must be stripped for the sandbox
      expect(filtered).toBe("user_session=client_site_token; cart_id=cart_999");
      expect(filtered).not.toContain("npati_session");
      expect(filtered).not.toContain("PLATFORM_SECRET");
      expect(filtered).not.toContain("otherpro");
    });

    it("returns undefined when no matching project cookies are present", () => {
      const platformOnlyCookies = "npati_session=PLATFORM_SECRET; other=123";
      const filtered = filterIncomingCookies(platformOnlyCookies, projectPrefix);
      expect(filtered).toBeUndefined();
    });
  });

  describe("3. Email Provider Verification & Fail-Closed Behavior", () => {
    it("UnconfiguredEmailProvider fails closed with EMAIL_SERVICE_UNCONFIGURED", async () => {
      const unconfigured = new UnconfiguredEmailProvider();
      await expect(
        unconfigured.sendVerificationEmail("user@example.com", "token123", "user@example.com"),
      ).rejects.toThrowError(DataStudioError);

      try {
        await unconfigured.sendVerificationEmail("user@example.com", "token123", "user@example.com");
      } catch (err: any) {
        expect(err.code).toBe("EMAIL_SERVICE_UNCONFIGURED");
        expect(err.status).toBe(503);
      }
    });

    it("MockEmailProvider records verification message with token and deep link", async () => {
      const mock = new MockEmailProvider();
      await mock.sendVerificationEmail("user@example.com", "verify_token_456", "user@example.com", {
        link: "http://localhost:3000/auth/verify?token=verify_token_456",
      });

      expect(mock.sentMessages).toHaveLength(1);
      const msg = mock.sentMessages[0]!;
      expect(msg.to).toBe("user@example.com");
      expect(msg.token).toBe("verify_token_456");
      expect(msg.type).toBe("verification");
      expect(msg.link).toBe("http://localhost:3000/auth/verify?token=verify_token_456");
    });
  });

  describe("4. End-to-End Preview Proxy Isolation (Fastify inject)", () => {
    it("protects platform tokens, isolates cookies, and rewrites response cookies through handleProxy", async () => {
      const Fastify = (await import("fastify")).default;
      const { ProjectPreviewService } = await import("../apps/agent-api/src/project-preview-service");
      const { registerProjectPreviewRoutes } = await import("../apps/agent-api/src/project-preview-routes");
      const { LocalDevAuthProvider } = await import("../apps/agent-api/src/auth");

      const companyId = "c-12345678";
      const projectId = "715009ee-a7bf-4999-bce2-053d207b7af5";
      const sandboxId = "sbx-999";

      let capturedUpstreamHeaders: Record<string, string> = {};

      const mockSandbox: any = {
        supportsPreviewProxy: () => true,
        proxyPreview: async (_scope: any, _sbxId: any, options: any) => {
          capturedUpstreamHeaders = options.headers;
          return {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": "session_id=site_cookie_val_123; Path=/; Domain=npati.local; HttpOnly",
            },
            body: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
          };
        },
      };

      // The proxy confirms the project is still previewable (not deleted, failed or rebuilding) before forwarding.
      const projects = { get: async () => ({ id: projectId, companyId, status: "previewing" }) };
      const previewService = new ProjectPreviewService(
        projects as any,
        {} as any,
        {} as any,
        mockSandbox,
        "test-secret-key-12345678901234567890",
      );

      // Register active session
      previewService.setSession(projectId, {
        projectId,
        companyId,
        sandboxId,
        processId: "proc-1",
        port: 3000,
        framework: "vite",
        command: "npm run dev",
        restartCount: 0,
        maxRestarts: 3,
        status: "running",
        startedAt: new Date().toISOString(),
        workspaceId: "ws-1",
        userId: "usr-1",
      });

      const { token: previewToken } = previewService.generateToken({
        userId: "usr-1",
        companyId,
        projectId,
        sandboxId,
      });

      const app = Fastify();
      const auth = new LocalDevAuthProvider({ userId: "usr-1", workspaceId: "ws-1", permissions: ["*"] });
      registerProjectPreviewRoutes(app, previewService, {} as any, auth);

      // 1. Send request with platform cookies and project cookies, and platform auth token
      const res = await app.inject({
        method: "GET",
        url: `/companies/${companyId}/projects/${projectId}/preview/proxy/api/user?token=${previewToken}`,
        headers: {
          cookie: `npati_session=PLATFORM_CORE_SECRET; _npati_p_715009ee_site_cart=cart_abc; other_p_123=leak`,
          authorization: `Bearer ${previewToken}`, // preview token in auth header
          "x-user-token": "custom-client-token-456",
        },
      });

      expect(res.statusCode).toBe(200);

      // Verify what was forwarded upstream to sandbox:
      // A. Cookie isolation: platform cookies stripped, only project cookies forwarded with prefix stripped
      expect(capturedUpstreamHeaders["cookie"]).toBe("site_cart=cart_abc");
      expect(capturedUpstreamHeaders["cookie"]).not.toContain("npati_session");
      expect(capturedUpstreamHeaders["cookie"]).not.toContain("PLATFORM_CORE_SECRET");
      expect(capturedUpstreamHeaders["cookie"]).not.toContain("other_p_123");

      // B. Token protection: preview token was NOT forwarded upstream in authorization
      expect(capturedUpstreamHeaders["authorization"]).toBeUndefined();

      // C. Custom site header was forwarded
      expect(capturedUpstreamHeaders["x-user-token"]).toBe("custom-client-token-456");

      // D. Outgoing response Set-Cookie was rewritten
      const setCookieHeader = res.headers["set-cookie"];
      expect(setCookieHeader).toBeDefined();
      expect(String(setCookieHeader)).toContain("_npati_p_715009ee_session_id=site_cookie_val_123");
      expect(String(setCookieHeader)).toContain(`Path=/api/companies/${companyId}/projects/${projectId}/preview/proxy`);
      expect(String(setCookieHeader)).toContain("SameSite=Lax");
      expect(String(setCookieHeader)).toContain("HttpOnly");
      expect(String(setCookieHeader)).not.toContain("Domain=");
    });
  });
});
