export type GdprStrategy = "delete" | "anonymize" | "detach" | "retain";

export type ProjectAuthUserStatus = "active" | "suspended" | "pending";

export interface ProjectAuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  status: ProjectAuthUserStatus;
  roles: string[];
  createdAt: string;
  lastLogin: string | null;
  metadata: Record<string, unknown>;
}

export interface ProjectAuthSettings {
  allowRegistration: boolean;
  requireEmailVerification: boolean;
  minPasswordLength: number;
  requireNumbers: boolean;
  requireSymbols: boolean;
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
}

export const DEFAULT_AUTH_SETTINGS: ProjectAuthSettings = {
  allowRegistration: true,
  requireEmailVerification: false,
  minPasswordLength: 8,
  requireNumbers: false,
  requireSymbols: false,
  accessTokenTtlMinutes: 15,
  refreshTokenTtlDays: 30,
};

export type AccessPolicyRule = "public" | "authenticated" | "owner" | "role";
export type AccessPolicyAction = "select" | "insert" | "update" | "delete" | "all";

export interface ProjectAccessPolicy {
  id?: string;
  collection: string;
  rule: AccessPolicyRule;
  ownerField?: string;
  role?: string;
  actions?: AccessPolicyAction[];
  description?: string;
}

export interface ProjectAuthTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  role: string;
  roles?: string[];
  exp: number;
  iat: number;
  jti: string;
}

export interface ProjectAuthTokenHeader {
  alg: "EdDSA";
  typ: "JWT";
  kid: string;
}

export interface ProjectAuthSession {
  user: ProjectAuthUser;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface GdprAffectedCollection {
  collection: string;
  strategy: GdprStrategy;
  affectedRows: number;
}

export interface GdprAffectedData {
  userId: string;
  collections: GdprAffectedCollection[];
  totalAffectedRows: number;
}

export interface GdprExportResult {
  user: ProjectAuthUser;
  data: Record<string, Record<string, unknown>[]>;
  exportedAt: string;
}

export interface ProjectOAuthProvider {
  id: "google" | "github";
  name: string;
  getAuthorizationUrl(redirectUri: string, state: string): Promise<string>;
  exchangeCode(code: string, redirectUri: string): Promise<{ providerUserId: string; email: string; name?: string }>;
}
