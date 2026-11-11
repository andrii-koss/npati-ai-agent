import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerProjectAuthRoutes } from "../apps/agent-api/src/data-studio/auth-routes";

describe("Project Auth role mutation response", () => {
  it("returns JSON after a void service result and preserves the scope and roles", async () => {
    const setUserRoles = vi.fn(async () => undefined);
    const ctx = { permissions: ["business:manage"] };
    const app = Fastify();
    registerProjectAuthRoutes(app, { authenticate: async () => ctx } as any, { setUserRoles } as any);
    try {
      const response = await app.inject({ method: "PATCH",
        url: "/companies/company-a/projects/project-a/data-studio/prod/auth/users/user-a/roles",
        payload: { roles: ["member", "editor"] } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(setUserRoles).toHaveBeenCalledWith(ctx, "company-a", "project-a", "prod", "user-a", ["member", "editor"]);
    } finally { await app.close(); }
  });

  it("does not call the mutation without management permission", async () => {
    const setUserRoles = vi.fn();
    const app = Fastify();
    registerProjectAuthRoutes(app, { authenticate: async () => ({ permissions: ["workspace:read"] }) } as any, { setUserRoles } as any);
    try {
      const response = await app.inject({ method: "PATCH",
        url: "/companies/company-a/projects/project-a/data-studio/dev/auth/users/user-a/roles",
        payload: { roles: ["admin"] } });
      expect(response.statusCode).toBe(403);
      expect(setUserRoles).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
