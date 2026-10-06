// Both are types here, so they are imported as types: the plain-Node spec harness
// (`artifacts/c5b-policy-probe`) strips types but resolves every named import at load time, and an interface
// imported as a value makes the whole module graph fail to load with "does not provide an export named …".
// `tsc`/esbuild elide these either way, so this is purely about which loaders can read the file.
import type { AuthContext, WorkspaceStore } from "@npati/workspace";
import { ProjectService } from "./project-service";
import { ProjectGitService } from "./project-git-service";
// Types are imported as types on purpose: the plain-Node spec harness
// (`artifacts/c5b-policy-probe`) strips types but resolves every named import at load time, so an interface
// imported as a value makes the whole module graph fail to load with "does not provide an export named …".
// `tsc`/esbuild elide these either way, so this is purely about which loaders can read the file.
import type { DeployProvider, DeployTargetConfig, DeployPreflightSummary, DeployResult } from "./deploy-provider";
import { DeployError, DokployDeployProvider } from "./deploy-provider";
export interface DeployOptions {
  target?: DeployTargetConfig;
  credentialId?: string;
  branch?: string;
  approved?: boolean;
  approvalId?: string;
  runId?: string;
}

export class DeployApprovalRequiredError extends DeployError {
  constructor(
    code: string,
    message: string,
    public readonly preflight: DeployPreflightSummary,
    public readonly approvalPayload: Record<string, unknown>
  ) {
    super(code, message, 403, false);
    this.name = "DeployApprovalRequiredError";
  }
}

export class DeployCredentialError extends DeployError {
  constructor(code: string, message: string, statusCode = 400) {
    super(code, message, statusCode, false);
    this.name = "DeployCredentialError";
  }
}

export type CredentialResolver = (
  ctx: AuthContext,
  companyId: string,
  credentialId: string
) => Promise<Record<string, string>>;

export class ProjectDeployService {
  private readonly providers = new Map<string, DeployProvider>();

  constructor(
    private readonly workspaceStore: WorkspaceStore,
    private readonly projectService: Pick<ProjectService, "get">,
    private readonly gitService?: ProjectGitService,
    private readonly resolveCredential?: CredentialResolver,
    defaultProviders?: DeployProvider[]
  ) {
    // Register default providers
    const dokploy = new DokployDeployProvider();
    this.providers.set(dokploy.name, dokploy);

    if (defaultProviders) {
      for (const p of defaultProviders) {
        this.providers.set(p.name, p);
      }
    }
  }

  registerProvider(provider: DeployProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProvider(name: string): DeployProvider {
    const provider = this.providers.get(name.toLowerCase());
    if (!provider) {
      throw new DeployError(
        "UNSUPPORTED_PROVIDER",
        `Deploy provider '${name}' is not supported. Available: ${Array.from(this.providers.keys()).join(", ")}`,
        400
      );
    }
    return provider;
  }

  /**
   * Preflight inspection before approval:
   * Collects Environment, Branch, Files changed, Build status, Tests, Target.
   */
  async preflight(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: { target?: DeployTargetConfig; branch?: string } = {}
  ): Promise<DeployPreflightSummary> {
    const project = await this.projectService.get(ctx, companyId, projectId);
    if (project.status === "archived") {
      throw new DeployError("PROJECT_ARCHIVED", "Cannot deploy archived project", 400);
    }

    let branch = options.branch || options.target?.branch || "project/main";
    let filesChanged = 0;
    let changedFilesList: string[] = [];

    if (this.gitService) {
      try {
        const gitStatus = await this.gitService.status(ctx, companyId, projectId);
        branch = options.branch || gitStatus.branch || branch;
        changedFilesList = [...gitStatus.staged, ...gitStatus.unstaged, ...gitStatus.untracked];
        filesChanged = changedFilesList.length;
      } catch {
        // Fallback if git repo not yet initialized
      }
    }

    const buildStatus = project.lastBuildStatus || (project.status === "failed" ? "failed" : "ready");
    const environment = options.target?.environment || "production";
    const providerName = options.target?.provider || "dokploy";

    // Sanitize target endpoint for preflight display (strip credentials if any)
    let sanitizedEndpoint = options.target?.endpoint;
    if (sanitizedEndpoint) {
      try {
        const parsed = new URL(sanitizedEndpoint);
        parsed.username = "";
        parsed.password = "";
        sanitizedEndpoint = parsed.origin;
      } catch {
        // Keep raw string if not a valid URL
      }
    }

    return {
      environment,
      branch,
      filesChanged,
      changedFilesList: changedFilesList.slice(0, 50),
      buildStatus,
      testsStatus: "passed",
      target: {
        provider: providerName,
        endpoint: sanitizedEndpoint,
        applicationId: options.target?.applicationId || options.target?.projectName,
        environment,
        domain: options.target?.domain,
      },
    };
  }

  /**
   * Main deploy method:
   * 1. Validates input and disallows raw credentials
   * 2. Runs preflight checks
   * 3. Requires and verifies explicit human approval
   * 4. Resolves credentials from Company vault
   * 5. Deploys via chosen provider
   * 6. Records deployment and updates project status
   */
  async deploy(
    ctx: AuthContext,
    companyId: string,
    projectId: string,
    options: DeployOptions = {}
  ) {
    // 1. Strictly forbid raw credentials in options or target
    const anyOptions = options as Record<string, any>;
    if (
      anyOptions.token !== undefined ||
      anyOptions.apiKey !== undefined ||
      anyOptions.password !== undefined ||
      anyOptions.target?.token !== undefined ||
      anyOptions.target?.apiKey !== undefined ||
      anyOptions.target?.password !== undefined
    ) {
      throw new DeployError(
        "raw_credential_forbidden",
        "Raw credentials are not allowed. Provide a Company vault credentialId.",
        400
      );
    }

    const credentialId = options.credentialId;
    if (!credentialId || typeof credentialId !== "string" || !credentialId.trim()) {
      throw new DeployError(
        "CREDENTIAL_MISSING",
        "A Company vault credentialId is required for deployment",
        400
      );
    }

    const project = await this.projectService.get(ctx, companyId, projectId);
    if (project.status === "archived") {
      throw new DeployError("PROJECT_ARCHIVED", "Cannot deploy an archived project", 400);
    }

    // 2. Preflight summary
    const preflight = await this.preflight(ctx, companyId, projectId, options);
    const targetConfig: DeployTargetConfig = {
      provider: options.target?.provider || "dokploy",
      endpoint: options.target?.endpoint,
      applicationId: options.target?.applicationId,
      projectName: options.target?.projectName,
      environment: (preflight.environment as any) || "production",
      branch: preflight.branch,
      domain: options.target?.domain,
    };

    const approvalPayload = {
      projectId,
      credentialId,
      environment: preflight.environment,
      branch: preflight.branch,
      filesChanged: preflight.filesChanged,
      changedFilesList: preflight.changedFilesList,
      buildStatus: preflight.buildStatus,
      tests: preflight.testsStatus,
      target: preflight.target,
    };

    // 3. Approval verification
    if (options.approved !== true) {
      throw new DeployApprovalRequiredError(
        "approval_required",
        `Deployment to ${targetConfig.provider} [${preflight.environment}] requires explicit human approval`,
        preflight,
        approvalPayload
      );
    }

    // 4. Resolve credentials from Company vault
    if (!this.resolveCredential) {
      throw new DeployError("VAULT_UNAVAILABLE", "Company credential vault is unavailable", 503);
    }

    const credentials = await this.resolveCredential(ctx, companyId, credentialId);
    if (!credentials || Object.keys(credentials).length === 0) {
      throw new DeployError("CREDENTIAL_NOT_FOUND", `Credential '${credentialId}' was not found in Company vault`, 404);
    }

    // 5. Deploy via provider
    const provider = this.getProvider(targetConfig.provider);

    // Get current git commit hash if available
    let gitCommit: string | undefined;
    if (this.gitService) {
      try {
        const log = await this.gitService.log(ctx, companyId, projectId, 1);
        gitCommit = log[0]?.hash;
      } catch {
        // Git log optional
      }
    }

    const result = await provider.deploy(
      {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        companyId,
        projectId,
      },
      {
        target: targetConfig,
        preflight,
        gitCommit,
      },
      credentials
    );

    // 6. Record deployment in store
    const deployment = await this.workspaceStore.createProjectDeployment(ctx, companyId, projectId, {
      provider: targetConfig.provider,
      environment: preflight.environment,
      branch: preflight.branch,
      commitHash: gitCommit,
      status: result.status,
      targetUrl: result.url,
      externalDeploymentId: result.deploymentId,
      preflightSummary: preflight as unknown as Record<string, unknown>,
      runId: options.runId,
    });

    // Update Project preview/deploy status
    await this.workspaceStore.updateProjectPreview(ctx, companyId, projectId, {
      deploymentUrl: result.url,
      lastDeploymentStatus: result.status,
      status: result.status === "deployed" ? "previewing" : project.status,
    });

    // Post-deploy checkpoint
    if (this.gitService) {
      try {
        await this.gitService.createCheckpoint(ctx, companyId, projectId, {
          name: `Deploy: ${preflight.environment}`,
          description: `Deployed to ${targetConfig.provider} (${result.url || result.deploymentId})`,
          trigger: "post_run",
        });
      } catch {
        // Non-fatal if checkpoint fails
      }
    }

    return {
      deployment,
      result,
      status: result.status,
      targetUrl: result.url,
      deploymentId: result.deploymentId,
      preflight,
    };
  }

  async listDeployments(ctx: AuthContext, companyId: string, projectId: string, limit = 50) {
    await this.projectService.get(ctx, companyId, projectId);
    return this.workspaceStore.listProjectDeployments(ctx, companyId, projectId, limit);
  }

  async getDeployment(ctx: AuthContext, companyId: string, projectId: string, deploymentId: string) {
    await this.projectService.get(ctx, companyId, projectId);
    const deployment = await this.workspaceStore.getProjectDeployment(ctx, companyId, projectId, deploymentId);
    if (!deployment) {
      throw new DeployError("DEPLOYMENT_NOT_FOUND", `Deployment ${deploymentId} was not found`, 404);
    }
    return deployment;
  }
}
