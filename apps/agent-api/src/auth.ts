import type { AuthContext } from "@npati/workspace";
import type { FastifyRequest } from "fastify";

export interface AuthProvider {
  authenticate(request: FastifyRequest): Promise<AuthContext>;
}

export class LocalDevAuthProvider implements AuthProvider {
  private readonly context: AuthContext;
  constructor(input: Partial<AuthContext> = {}) {
    this.context = {
      userId: input.userId ?? "dev-user",
      externalSubject: input.externalSubject ?? "local:dev-user",
      workspaceId: input.workspaceId ?? "dev-workspace",
      permissions: input.permissions ?? ["workspace:read", "workspace:write", "business:manage", "chat:use"],
    };
  }
  async authenticate(_request: FastifyRequest) { return { ...this.context, permissions: [...this.context.permissions] }; }
}
