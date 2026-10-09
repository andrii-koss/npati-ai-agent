import {
  type ActiveContext,
  type ContextType,
  type RunContextSnapshot,
  validateActiveContext,
  ContextValidationError,
  defaultHybridRouter,
} from "@npati/shared";
import {
  type AuthContext,
  type Business,
  type Company,
  type Project,
  type WorkspaceStore,
  WorkspaceAccessError,
} from "@npati/workspace";

export interface ResolvedActiveContext {
  context: ActiveContext;
  company?: Company;
  business?: Business;
  project?: Project;
  snapshot: RunContextSnapshot;
}

export class ActiveContextResolver {
  constructor(private readonly store: WorkspaceStore) {}

  /** A new Project request must not validate or reuse the previous chat's Project. */
  async resolveChat(auth: AuthContext, requested: Parameters<ActiveContextResolver["resolve"]>[1], message: string): Promise<ResolvedActiveContext> {
    const validated = validateActiveContext(requested ?? {});
    const intent = defaultHybridRouter.classifyProject({ message, activeCompanyId: validated.companyId, activeProjectId: validated.projectId });
    if (validated.projectId && (intent.intent === "CREATE_WEBSITE" || intent.intent === "CREATE_PROJECT")) {
      return this.resolve(auth, { contextType: "company", companyId: validated.companyId });
    }
    return this.resolve(auth, requested);
  }

  async resolve(
    auth: AuthContext,
    requested?: {
      contextType?: ContextType | string;
      businessId?: string | null;
      companyId?: string | null;
      projectId?: string | null;
    }
  ): Promise<ResolvedActiveContext> {
    const validated = validateActiveContext(requested ?? {});
    const timestamp = new Date().toISOString();

    if (validated.contextType === "project" || validated.projectId) {
      if (!validated.projectId) {
        throw new ContextValidationError("projectId is required for project context");
      }
      if (!validated.companyId) {
        throw new ContextValidationError("companyId is required for project context");
      }
      const company = await this.store.getCompany(auth, validated.companyId);
      if (!company) {
        throw new WorkspaceAccessError(`Company not found or access denied: ${validated.companyId}`);
      }
      let project: Project | undefined;
      try {
        project = await this.store.getProject(auth, validated.companyId, validated.projectId);
      } catch {
        project = undefined;
      }
      if (!project || project.companyId !== company.id) {
        if (validated.contextType === "project") {
          throw new WorkspaceAccessError(`Project not found or does not belong to company: ${validated.projectId}`);
        }
        return this.resolve(auth, {
          contextType: "company",
          companyId: company.id,
          businessId: company.businessId ?? null,
        });
      }
      if (project.status === "archived") {
        if (validated.contextType === "project") {
          throw new ContextValidationError(`Cannot set active context to an archived project: ${validated.projectId}`);
        }
        return this.resolve(auth, {
          contextType: "company",
          companyId: company.id,
          businessId: company.businessId ?? null,
        });
      }
      let business: Business | undefined;
      if (company.businessId) {
        try {
          business = await this.store.getBusiness(auth, company.businessId);
        } catch {
          // Business may not be accessible or deleted
        }
      }
      const snapshot: RunContextSnapshot = {
        contextType: "project",
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        companyId: company.id,
        businessId: company.businessId ?? null,
        projectId: project.id,
        agentId: company.mainAgentId ?? null,
        companyRevision: company.revision,
        capturedAt: timestamp,
      };
      return {
        context: {
          contextType: "project",
          companyId: company.id,
          businessId: company.businessId ?? null,
          projectId: project.id,
          workspaceId: auth.workspaceId,
        },
        company,
        business,
        project,
        snapshot,
      };
    }

    if (validated.contextType === "company") {
      if (!validated.companyId) {
        throw new ContextValidationError("companyId is required for company context");
      }
      // Assert company ownership and access within auth.workspaceId
      const company = await this.store.getCompany(auth, validated.companyId);
      if (!company) {
        throw new WorkspaceAccessError(`Company not found or access denied: ${validated.companyId}`);
      }

      let business: Business | undefined;
      if (company.businessId) {
        try {
          business = await this.store.getBusiness(auth, company.businessId);
        } catch {
          // Business may not be accessible or deleted
        }
      }

      const snapshot: RunContextSnapshot = {
        contextType: "company",
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        companyId: company.id,
        businessId: company.businessId ?? null,
        agentId: company.mainAgentId ?? null,
        companyRevision: company.revision,
        capturedAt: timestamp,
      };

      return {
        context: {
          contextType: "company",
          companyId: company.id,
          businessId: company.businessId ?? null,
        },
        company,
        business,
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
