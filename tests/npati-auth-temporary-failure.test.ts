import { describe, expect, it, vi } from "vitest";
import { createMockNpatiJwt, NpatiBackendAuthProvider } from "../apps/agent-api/src/auth";

describe("central NPATI authentication failures", () => {
  it("keeps an upstream outage distinct from a rejected token", async () => {
    vi.stubEnv("NPATI_JWT_SECRET", "");
    vi.stubEnv("JWT_SECRET", "");
    try {
      const token = createMockNpatiJwt({ userId: "owner-1" }, "central-test-secret");
      const unavailable = new NpatiBackendAuthProvider({
        authClient: { getCurrentUser: async () => { throw new Error("network unavailable"); } } as never,
      });
      await expect(unavailable.verifyToken(token)).rejects.toMatchObject({
        status: 503,
        code: "AUTH_BACKEND_UNAVAILABLE",
      });

      const rejected = new NpatiBackendAuthProvider({
        authClient: { getCurrentUser: async () => { throw Object.assign(new Error("Invalid access token"), { status: 401 }); } } as never,
      });
      await expect(rejected.verifyToken(token)).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
