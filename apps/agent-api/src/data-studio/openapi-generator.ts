import type { SchemaSnapshot } from "./data-provider";

export interface OpenApiGeneratorOptions {
  projectId: string;
  projectName: string;
  environment: string;
  baseUrl?: string;
}

export function generateOpenApiSpec(
  options: OpenApiGeneratorOptions,
  schema: SchemaSnapshot,
): Record<string, unknown> {
  const { projectId, projectName, environment, baseUrl = `/v1/projects/${projectId}` } = options;

  const mapSqlTypeToOpenApi = (type: string): { type: string; format?: string } => {
    const lower = type.toLowerCase();
    if (lower.includes("int") || lower.includes("serial")) return { type: "integer" };
    if (lower.includes("numeric") || lower.includes("decimal") || lower.includes("real") || lower.includes("double")) return { type: "number" };
    if (lower.includes("bool")) return { type: "boolean" };
    if (lower.includes("json")) return { type: "object" };
    if (lower.includes("timestamp") || lower.includes("date")) return { type: "string", format: "date-time" };
    if (lower.includes("uuid")) return { type: "string", format: "uuid" };
    return { type: "string" };
  };

  const schemas: Record<string, unknown> = {
    ErrorResponse: {
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            status: { type: "integer" },
          },
          required: ["code", "message"],
        },
      },
      required: ["error"],
    },
    AuthUser: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        email: { type: "string", format: "email" },
        name: { type: "string" },
        roles: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: ["active", "suspended", "pending"] },
        emailVerified: { type: "boolean" },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id", "email", "roles"],
    },
    AuthSession: {
      type: "object",
      properties: {
        token: { type: "string" },
        refreshToken: { type: "string" },
        expiresIn: { type: "integer" },
        user: { $ref: "#/components/schemas/AuthUser" },
      },
      required: ["token", "user"],
    },
    RegisterRequest: {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string", minLength: 8 },
        name: { type: "string" },
      },
      required: ["email", "password"],
    },
    LoginRequest: {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string" },
      },
      required: ["email", "password"],
    },
    RefreshTokenRequest: {
      type: "object",
      properties: {
        refreshToken: { type: "string" },
      },
      required: ["refreshToken"],
    },
  };

  const paths: Record<string, unknown> = {
    "/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Register new end-user",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/RegisterRequest" } } },
        },
        responses: {
          "200": {
            description: "Registered successfully",
            content: { "application/json": { schema: { $ref: "#/components/schemas/AuthSession" } } },
          },
          "400": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Login with email and password",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } },
        },
        responses: {
          "200": {
            description: "Logged in successfully",
            content: { "application/json": { schema: { $ref: "#/components/schemas/AuthSession" } } },
          },
          "401": { description: "Invalid credentials", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
    "/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Get current authenticated user profile",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "Current user profile",
            content: { "application/json": { schema: { type: "object", properties: { user: { $ref: "#/components/schemas/AuthUser" } } } } },
          },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/auth/refresh": {
      post: {
        tags: ["Auth"],
        summary: "Refresh expired access token",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/RefreshTokenRequest" } } },
        },
        responses: {
          "200": {
            description: "Token refreshed successfully",
            content: { "application/json": { schema: { $ref: "#/components/schemas/AuthSession" } } },
          },
          "401": { description: "Invalid refresh token" },
        },
      },
    },
    "/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Logout and revoke refresh token",
        requestBody: {
          required: false,
          content: { "application/json": { schema: { $ref: "#/components/schemas/RefreshTokenRequest" } } },
        },
        responses: {
          "200": { description: "Logged out successfully" },
        },
      },
    },
  };

  // Build collection endpoints from introspected tables
  for (const table of schema.tables) {
    if (table.name.startsWith("_npati_")) continue;

    const schemaName = table.name.charAt(0).toUpperCase() + table.name.slice(1);
    const properties: Record<string, unknown> = {};
    const createProperties: Record<string, unknown> = {};
    const requiredProps: string[] = [];

    for (const col of table.columns) {
      const typeInfo = mapSqlTypeToOpenApi(col.type);
      properties[col.name] = typeInfo;

      // Omit auto-managed fields from creation schema
      if (!["id", "created_at", "updated_at"].includes(col.name)) {
        createProperties[col.name] = typeInfo;
        if (!col.nullable) {
          requiredProps.push(col.name);
        }
      }
    }

    schemas[schemaName] = {
      type: "object",
      properties,
    };

    schemas[`${schemaName}Input`] = {
      type: "object",
      properties: createProperties,
      required: requiredProps.length > 0 ? requiredProps : undefined,
    };

    paths[`/data/${table.name}`] = {
      get: {
        tags: [table.name],
        summary: `List rows from ${table.name}`,
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 20 }, description: "Max rows to return (max 100)" },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 }, description: "Row offset" },
          { name: "sort", in: "query", schema: { type: "string" }, description: "Field and order e.g. created_at:desc" },
          { name: "fields", in: "query", schema: { type: "string" }, description: "Comma-separated column names to return" },
          { name: "include", in: "query", schema: { type: "string" }, description: "Relations to expand" },
        ],
        responses: {
          "200": {
            description: `List of ${table.name}`,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: `#/components/schemas/${schemaName}` } },
                    meta: {
                      type: "object",
                      properties: {
                        total: { type: "integer" },
                        page: { type: "integer" },
                        limit: { type: "integer" },
                        hasMore: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: [table.name],
        summary: `Create a new row in ${table.name}`,
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}Input` } } },
        },
        responses: {
          "201": {
            description: "Created row",
            content: { "application/json": { schema: { type: "object", properties: { data: { $ref: `#/components/schemas/${schemaName}` } } } } },
          },
          "400": { description: "Invalid input" },
        },
      },
    };

    paths[`/data/${table.name}/{id}`] = {
      get: {
        tags: [table.name],
        summary: `Get single row by ID from ${table.name}`,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "fields", in: "query", schema: { type: "string" } },
          { name: "include", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Found row",
            content: { "application/json": { schema: { type: "object", properties: { data: { $ref: `#/components/schemas/${schemaName}` } } } } },
          },
          "404": { description: "Row not found" },
        },
      },
      patch: {
        tags: [table.name],
        summary: `Update row by ID in ${table.name}`,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}Input` } } },
        },
        responses: {
          "200": {
            description: "Updated row",
            content: { "application/json": { schema: { type: "object", properties: { data: { $ref: `#/components/schemas/${schemaName}` } } } } },
          },
          "404": { description: "Row not found" },
        },
      },
      delete: {
        tags: [table.name],
        summary: `Delete row by ID from ${table.name}`,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Deleted successfully",
            content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, id: { type: "string" } } } } },
          },
          "404": { description: "Row not found" },
        },
      },
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: `${projectName} - Project API (${environment})`,
      version: "1.0.0",
      description: `Public REST API for Project ${projectId} managed by NPATI Data Studio.`,
    },
    servers: [{ url: baseUrl }],
    security: [{ ApiKeyAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-Project-Key",
          description: "PROJECT_PUBLISHABLE_KEY (browser/mobile) or PROJECT_SECRET_KEY (server-side only)",
        },
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "End-user JWT access token from /auth/login or /auth/register",
        },
      },
      schemas,
    },
  };
}

export function generateProjectTypeScriptTypes(schema: SchemaSnapshot): string {
  const lines = ["// Generated from the live Project database schema.", "export interface ProjectCollections {"];
  for (const table of schema.tables.filter((item) => /^[a-z][a-z0-9_]*$/.test(item.name) && !item.name.startsWith("_npati_"))) {
    lines.push(`  ${table.name}: {`);
    for (const column of table.columns.filter((item) => /^[a-z][a-z0-9_]*$/.test(item.name))) {
      const normalized = column.type.toLowerCase();
      const type = /^(int|bigint|smallint|numeric|decimal|real|double)/.test(normalized) ? "number"
        : normalized === "boolean" ? "boolean"
        : normalized.includes("json") ? "unknown"
        : "string";
      lines.push(`    ${column.name}: ${type}${column.nullable ? " | null" : ""};`);
    }
    lines.push("  };");
  }
  lines.push("}", "");
  return lines.join("\n");
}