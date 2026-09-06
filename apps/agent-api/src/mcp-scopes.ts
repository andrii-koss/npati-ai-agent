export type McpScope =
  | "mcp:*"
  | "mcp:read"
  | "mcp:write"
  | "mcp:execute"
  | "mcp:admin"
  | string;

export interface McpAuthorizationRequest {
  toolName: string;
  serverName?: string;
  action?: "read" | "write" | "execute" | "admin";
  grantedScopes: string[];
}

export interface McpAuthorizationResult {
  granted: boolean;
  requiredScope: string;
  grantedScopes: string[];
  reason?: string;
}

export class McpScopeGuard {
  /**
   * Determine required scope for an MCP tool action
   */
  static getRequiredScope(toolName: string, action: "read" | "write" | "execute" | "admin" = "execute", serverName?: string): string {
    const cleanTool = toolName.toLowerCase().replace(/^mcp\./, "");
    if (serverName) {
      return `mcp:${serverName.toLowerCase()}:${action}`;
    }
    
    // Check if tool name is read-only
    if (action === "read" || /^(get|list|read|search|fetch|describe|inspect)/i.test(cleanTool)) {
      return "mcp:read";
    }
    if (action === "write" || /^(create|update|insert|modify|write|append|save)/i.test(cleanTool)) {
      return "mcp:write";
    }
    if (action === "admin" || /^(delete|drop|admin|manage|restart|reconfigure)/i.test(cleanTool)) {
      return "mcp:admin";
    }
    return "mcp:execute";
  }

  /**
   * Check if a set of granted scopes satisfies the required scope
   */
  static hasScope(grantedScopes: string[], requiredScope: string): boolean {
    if (grantedScopes.includes("*") || grantedScopes.includes("all") || grantedScopes.includes("mcp:*")) {
      return true;
    }

    if (grantedScopes.includes(requiredScope)) {
      return true;
    }

    // Check wildcard patterns, e.g. "mcp:github:*" satisfies "mcp:github:read"
    const reqParts = requiredScope.split(":");
    for (const scope of grantedScopes) {
      const parts = scope.split(":");
      if (parts.length === reqParts.length) {
        let match = true;
        for (let i = 0; i < parts.length; i++) {
          if (parts[i] !== "*" && parts[i] !== reqParts[i]) {
            match = false;
            break;
          }
        }
        if (match) return true;
      }
    }

    // Hierarchy fallback: mcp:admin grants execute, write, read
    if (grantedScopes.includes("mcp:admin")) {
      return true;
    }
    // mcp:execute grants read
    if (requiredScope === "mcp:read" && (grantedScopes.includes("mcp:execute") || grantedScopes.includes("mcp:write"))) {
      return true;
    }

    return false;
  }

  /**
   * Authorize an MCP execution request
   */
  static authorize(request: McpAuthorizationRequest): McpAuthorizationResult {
    const requiredScope = this.getRequiredScope(request.toolName, request.action, request.serverName);
    const granted = this.hasScope(request.grantedScopes, requiredScope);

    if (!granted) {
      return {
        granted: false,
        requiredScope,
        grantedScopes: request.grantedScopes,
        reason: `INSUFFICIENT_MCP_SCOPE: Requires '${requiredScope}', but was granted [${request.grantedScopes.join(", ")}]`,
      };
    }

    return {
      granted: true,
      requiredScope,
      grantedScopes: request.grantedScopes,
    };
  }
}
