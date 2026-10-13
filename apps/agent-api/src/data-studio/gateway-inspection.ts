import type { SchemaSnapshot } from "./data-provider";

export interface ApiCollectionField {
  name: string;
  type: string;
  required: boolean;
}

export interface ApiCollectionInfo {
  name: string;
  fields: ApiCollectionField[];
}

export interface ApiEndpointInfo {
  method: string;
  path: string;
  description: string;
  authRequired: boolean;
  keyRequired: "publishable" | "secret";
}

export function extractApiCollections(schema: SchemaSnapshot): ApiCollectionInfo[] {
  return schema.tables
    .filter((t) => !t.name.startsWith("_npati_"))
    .map((t) => ({
      name: t.name,
      fields: t.columns.map((c) => ({ name: c.name, type: c.type, required: !c.nullable })),
    }));
}

export function buildApiEndpoints(projectId: string, collections: ApiCollectionInfo[]): ApiEndpointInfo[] {
  const endpoints: ApiEndpointInfo[] = [
    { method: "POST", path: `/v1/projects/${projectId}/auth/register`, description: "Register end-user", authRequired: false, keyRequired: "publishable" },
    { method: "POST", path: `/v1/projects/${projectId}/auth/login`, description: "Login end-user", authRequired: false, keyRequired: "publishable" },
    { method: "POST", path: `/v1/projects/${projectId}/auth/logout`, description: "Logout end-user", authRequired: false, keyRequired: "publishable" },
    { method: "GET", path: `/v1/projects/${projectId}/auth/me`, description: "Get current user profile", authRequired: true, keyRequired: "publishable" },
    { method: "POST", path: `/v1/projects/${projectId}/auth/refresh`, description: "Refresh access token", authRequired: false, keyRequired: "publishable" },
  ];

  for (const col of collections) {
    endpoints.push(
      { method: "GET", path: `/v1/projects/${projectId}/data/${col.name}`, description: `List ${col.name}`, authRequired: false, keyRequired: "publishable" },
      { method: "GET", path: `/v1/projects/${projectId}/data/${col.name}/:id`, description: `Get ${col.name} by ID`, authRequired: false, keyRequired: "publishable" },
      { method: "POST", path: `/v1/projects/${projectId}/data/${col.name}`, description: `Create ${col.name}`, authRequired: false, keyRequired: "publishable" },
      { method: "PATCH", path: `/v1/projects/${projectId}/data/${col.name}/:id`, description: `Update ${col.name}`, authRequired: false, keyRequired: "publishable" },
      { method: "DELETE", path: `/v1/projects/${projectId}/data/${col.name}/:id`, description: `Delete ${col.name}`, authRequired: false, keyRequired: "publishable" },
    );
  }

  return endpoints;
}
