import {
  type ActiveContext,
  type ContextType,
  type RunContextSnapshot,
  validateActiveContext,
  ContextValidationError,
} from "@npati/shared";
import {
  type AuthContext,
  type Business,
  type Company,
  type WorkspaceStore,
  WorkspaceAccessError,
} from "@npati/workspace";

export interface ResolvedActiveContext {
  context: ActiveContext;
  company?: Company;
  business?: Business;
  snapshot: RunContextSnapshot;
}

export class ActiveContextResolver {
  constructor(private readonly store: WorkspaceStore) {}

  async resolve(
    auth: AuthContext,
    requested?: {
      contextType?: ContextType | string;
      businessId?: string | null;
      companyId?: string | null;
    }
  ): Promise<ResolvedActiveContext> {
    const validated = validateActiveContext(requested ?? {});
    const timestamp = new Date().toISOString();

    if (validated.contextType === "company") {
      if (!validated.companyId) {
        throw new ContextValidationError("companyId is required for company context");
      }
      // Assert company ownership and access within auth.workspaceId
      const company = await this.store.getCompany(auth, validated.companyId);
      if (!company) {
        throw new WorkspaceAccessError(`Company not found or access denied: ${validated.companyId}`);
      }

      const snapshot: RunContextSnapshot = {
        contextType: "company",
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        companyId: company.id,
        businessId: null,
        agentId: company.mainAgentId ?? null,
        companyRevision: company.revision,
        capturedAt: timestamp,
      };

      return {
        context: {
          contextType: "company",
          companyId: company.id,
          businessId: null,
        },
        company,
        snapshot,
      };
    }

    if (validated.contextType === "business") {
      if (validated.businessId) {
        // Assert business ownership and access within auth.workspaceId
        const business = await this.store.getBusiness(auth, validated.businessId);
        if (!business) {
          throw new WorkspaceAccessError(`Business not found or access denied: ${validated.businessId}`);
        }

        const snapshot: RunContextSnapshot = {
          contextType: "business",
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          companyId: null,
          businessId: business.id,
          capturedAt: timestamp,
        };

        return {
          context: {
            contextType: "business",
            companyId: null,
            businessId: business.id,
          },
          business,
          snapshot,
        };
      }

      // Business onboarding / creation phase before businessId is assigned
      const snapshot: RunContextSnapshot = {
        contextType: "business",
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        companyId: null,
        businessId: null,
        capturedAt: timestamp,
      };

      return {
        context: {
          contextType: "business",
          companyId: null,
          businessId: null,
        },
        snapshot,
      };
    }

    // Neutral context ('none')
    const snapshot: RunContextSnapshot = {
      contextType: "none",
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      companyId: null,
      businessId: null,
      capturedAt: timestamp,
    };

    return {
      context: {
        contextType: "none",
        companyId: null,
        businessId: null,
      },
      snapshot,
    };
  }
}
