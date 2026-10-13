import type {
  ProjectApiKeyType,
} from "@npati/shared";
import type { DataBackend, DataEnvironmentName } from "./types";

export interface GatewayAuthResult {
  project: {
    id: string;
    workspaceId: string;
    companyId: string;
    createdBy: string;
    name?: string;
    dataBackendId?: string;
    status?: string;
    [key: string]: unknown;
  };
  backend: DataBackend;
  environment: DataEnvironmentName;
  keyType: ProjectApiKeyType;
  userId: string;
  userRole: string;
  userEmail?: string;
  corsAllowedOrigins: string[];
}

export interface GatewayListOptions {
  filter?: Record<string, unknown> | Array<{ field: string; operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: unknown }>;
  sort?: string | Array<{ field: string; direction: "asc" | "desc" }>;
  limit?: number;
  offset?: number;
  page?: number;
  fields?: string[];
  include?: string[];
}
