import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerCodeToolRoutes } from "../apps/agent-api/src/code-tool-routes";
import type { CodeToolRuntime } from "../apps/agent-api/src/code-tool-runtime";

describe("durable approval conflict HTTP status", () => {
  for (const code of ["APPROVAL_INVALID", "APPROVAL_ALREADY_USED"]) {
    it(`preserves ${code} as a conflict`, async () => {
      const app = Fastify();
      registerCodeToolRoutes(app, {
        auth: { authenticate: async () => ({ workspaceId: "ws", userId: "owner", permissions: ["business:manage"] }) },
        runtime: { invoke: async () => ({ ok: false, error: { code, message: "Approval context or payload does not match", tool: "code.shell.exec", step: "execute", retryable: false } }) } as unknown as CodeToolRuntime,
      });
      try {
        const response = await app.inject({ method: "POST", url: "/companies/c/projects/p/code/tools/invoke", payload: { tool: "code.shell.exec", toolCallId: "call" } });
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe(code);
      } finally { await app.close(); }
    });
  }
});
