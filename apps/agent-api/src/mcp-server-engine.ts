export interface McpCallerScope {
  companyId: string;
  tenantId: string;
  userId?: string;
  permissions: string[]; // e.g. ["mcp:tools:execute", "mcp:resources:read", "mcp:prompts:read", "tools:linter"]
}

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, any>;
}

export interface McpJsonRpcResponse<T = any> {
  jsonrpc: "2.0";
  id: string | number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  requiredPermission?: string;
  handler: (args: Record<string, any>, scope: McpCallerScope) => Promise<any> | any;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
  content: string;
}

export class McpServerEngine {
  private readonly tools = new Map<string, McpToolDefinition>();
  private readonly resources = new Map<string, McpResourceDefinition>();

  constructor() {
    this.registerDefaultTools();
  }

  private registerDefaultTools(): void {
    this.registerTool({
      name: "echo",
      description: "Echoes back the input message for connection testing.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "The message to echo" },
        },
        required: ["message"],
      },
      handler: (args) => ({ echoed: args.message }),
    });

    this.registerResource({
      uri: "npati://system/capabilities",
      name: "System Capabilities",
      description: "Core capabilities of NPATI Agent platform.",
      mimeType: "text/markdown",
      content: "# NPATI Agent Platform\n\nFeatures: Multi-agent routing, A2A v0.3, Sandboxing, Long-term memory.",
    });
  }

  registerTool(tool: McpToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerResource(resource: McpResourceDefinition): void {
    this.resources.set(resource.uri, resource);
  }

  /**
   * Validate caller's scoped permissions
   */
  static hasPermission(scope: McpCallerScope, requiredPermission: string): boolean {
    if (scope.permissions.includes("*") || scope.permissions.includes("mcp:*")) {
      return true;
    }
    return scope.permissions.includes(requiredPermission);
  }

  /**
   * Handle JSON-RPC 2.0 MCP Request
   */
  async handleRequest(request: McpJsonRpcRequest, scope: McpCallerScope): Promise<McpJsonRpcResponse> {
    if (request.jsonrpc !== "2.0" || !request.method) {
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32600, message: "Invalid Request: Must be JSON-RPC 2.0 with a method." },
      };
    }

    try {
      switch (request.method) {
        case "initialize": {
          return {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2024-11-05",
              serverInfo: { name: "npati-mcp-server", version: "1.0.0" },
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
                prompts: { listChanged: false },
              },
            },
          };
        }

        case "tools/list": {
          const list = Array.from(this.tools.values()).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          }));
          return {
            jsonrpc: "2.0",
            id: request.id,
            result: { tools: list },
          };
        }

        case "tools/call": {
          const toolName = request.params?.name;
          const toolArgs = request.params?.arguments ?? {};

          if (!toolName || !this.tools.has(toolName)) {
            return {
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: `Tool '${toolName}' not found.` },
            };
          }

          const tool = this.tools.get(toolName)!;

          // Check scoped permissions
          if (!McpServerEngine.hasPermission(scope, "mcp:tools:execute")) {
            return {
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32001, message: "FORBIDDEN: Missing 'mcp:tools:execute' permission." },
            };
          }

          if (tool.requiredPermission && !McpServerEngine.hasPermission(scope, tool.requiredPermission)) {
            return {
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32001,
                message: `FORBIDDEN: Missing required tool permission '${tool.requiredPermission}'.`,
              },
            };
          }

          const output = await tool.handler(toolArgs, scope);
          return {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }],
            },
          };
        }

        case "resources/list": {
          const resources = Array.from(this.resources.values()).map((r) => ({
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
          }));
          return {
            jsonrpc: "2.0",
            id: request.id,
            result: { resources },
          };
        }

        case "resources/read": {
          const uri = request.params?.uri;
          if (!uri || !this.resources.has(uri)) {
            return {
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32602, message: `Resource '${uri}' not found.` },
            };
          }

          if (!McpServerEngine.hasPermission(scope, "mcp:resources:read")) {
            return {
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32001, message: "FORBIDDEN: Missing 'mcp:resources:read' permission." },
            };
          }

          const resource = this.resources.get(uri)!;
          return {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.content }],
            },
          };
        }

        default:
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: `Method '${request.method}' not implemented.` },
          };
      }
    } catch (err: any) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: err?.message || "Internal server error" },
      };
    }
  }
}
