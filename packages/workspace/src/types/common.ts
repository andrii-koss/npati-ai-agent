export interface AuthContext {
  userId: string;
  externalSubject?: string;
  workspaceId: string;
  permissions: string[];
  apiKeyId?: string;
  companyId?: string;
}

export type BusinessStage = "idea" | "starting" | "operating" | "growing" | "scaling";
export type TeamType = "solo" | "team";
export type PresenceType = "online" | "local" | "both";

export interface Business {
  id: string; workspaceId: string; ownerUserId: string; name: string;
  businessType?: string; industry?: string; niche?: string; country?: string; market?: string; website?: string;
  legalName?: string; contactEmail?: string; contactPhone?: string; postalAddress?: string; registrationDetails?: string; logoFileId?: string;
  businessStage: BusinessStage; teamType?: TeamType; businessModel?: string; presenceType?: PresenceType;
  description?: string; audienceSummary?: string; productsServicesSummary?: string;
  activationStatus: "draft" | "active"; createdAt: string; updatedAt: string;
}
export type BusinessInput = Partial<Omit<Business, "id" | "workspaceId" | "ownerUserId" | "activationStatus" | "createdAt" | "updatedAt">> & { name: string };
export interface BusinessPage { items: Business[]; nextCursor: string | null; }

export interface Company {
  id: string; workspaceId: string; userId: string; businessId?: string;
  name: string; website?: string; industry?: string; description?: string;
  productsServices?: string; languages: string[]; brandTone?: string; companyInstructions?: string;
  knowledge: unknown[]; memory: Record<string, unknown>; mainAgentId?: string;
  status: "active" | "inactive"; revision: number; createdAt: string; updatedAt: string;
}
export type CompanyInput = Partial<Omit<Company, "id" | "workspaceId" | "userId" | "mainAgentId" | "revision" | "createdAt" | "updatedAt">> & { name: string };
export interface CompanyPage { items: Company[]; nextCursor: string | null; }

