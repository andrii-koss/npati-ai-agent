export type ProjectApiKeyType = "publishable" | "secret" | "anonymous";

export interface ProjectApiKeysConfig {
  publishableKey: string;
  secretKeyHash: string;
  encryptedSecretKey?: string;
  corsAllowedOrigins?: string[];
  rateLimit?: {
    maxRequestsPerMinute?: number;
  };
  previousKeys?: Array<{
    keyType: "publishable" | "secret";
    keyOrHash: string;
    deprecatedAt: string;
  }>;
}

export interface ProjectApiKeysInfo {
  publishableKey: string;
  secretKeyMasked: string;
  apiUrl: string;
  corsAllowedOrigins: string[];
  rateLimit: {
    maxRequestsPerMinute: number;
  };
}

export interface ProjectApiRequestLog {
  id: string;
  projectId: string;
  backendId: string;
  environment: "dev" | "prod";
  keyType: ProjectApiKeyType;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ip?: string;
  createdAt: string;
}

export interface ProjectApiUsage {
  requestCount: number;
  databaseBytes: number;
  collectionsCount: number;
  maxDatabaseBytes: number;
  maxRequestsPerMinute: number;
}

export interface ProjectApiEndpointSummary {
  method: string;
  path: string;
  description: string;
  authRequired: boolean;
  keyRequired: "publishable" | "secret" | "none";
}

export interface ProjectApiInspectResult {
  projectId: string;
  environment: "dev" | "prod";
  apiUrl: string;
  openApiUrl: string;
  collections: Array<{
    name: string;
    fields: Array<{ name: string; type: string; required?: boolean }>;
  }>;
  endpoints: ProjectApiEndpointSummary[];
  authEnabled: boolean;
  /** Generated Project API client vendored into the Project workspace for the sandbox. */
  sdk: {
    file: string;
    importPath: string;
    available: boolean;
  };
}
