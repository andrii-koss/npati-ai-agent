import { randomUUID } from "node:crypto";

export interface DeployScope {
  workspaceId: string;
  userId: string;
  companyId: string;
  projectId: string;
}

export type DeployEnvironment = "production" | "staging" | "preview";

export interface DeployTargetConfig {
  provider: "dokploy" | string;
  endpoint?: string;
  applicationId?: string;
  projectName?: string;
  environment?: DeployEnvironment;
  branch?: string;
  domain?: string;
}

export interface DeployPreflightSummary {
  environment: string;
  branch: string;
  filesChanged: number;
  changedFilesList: string[];
  buildStatus: string;
  testsStatus: string;
  target: {
    provider: string;
    endpoint?: string;
    applicationId?: string;
    environment: string;
    domain?: string;
  };
}

export interface DeployResult {
  deploymentId: string;
  status: "queued" | "building" | "deployed" | "failed";
  url?: string;
  logs?: string;
  environment: string;
  target: string;
  deployedAt: string;
}

export class DeployError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 500,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "DeployError";
  }
}

export interface DeployProvider {
  readonly name: string;
  validateConfig(target: DeployTargetConfig, credentials: Record<string, string>): Promise<{ valid: boolean; error?: string }>;
  deploy(
    scope: DeployScope,
    manifest: {
      target: DeployTargetConfig;
      preflight: DeployPreflightSummary;
      gitCommit?: string;
    },
    credentials: Record<string, string>
  ): Promise<DeployResult>;
  getDeploymentStatus?(
    scope: DeployScope,
    deploymentId: string,
    target: DeployTargetConfig,
    credentials: Record<string, string>
  ): Promise<DeployResult>;
}

/**
 * DokployDeployProvider
 *
 * Implements deployment to Dokploy instances via REST API.
 * Communicates using API tokens or API keys resolved from the Company credential vault.
 * Strictly redacts tokens from errors, logs, and outputs.
 */
export class DokployDeployProvider implements DeployProvider {
  readonly name = "dokploy";

  constructor(private readonly transport: typeof fetch = fetch) {}

  private sanitizeEndpoint(rawEndpoint?: string): URL {
    if (!rawEndpoint || !rawEndpoint.trim()) {
      throw new DeployError("INVALID_ENDPOINT", "Dokploy endpoint URL is required", 400);
    }
    let url: URL;
    try {
      url = new URL(rawEndpoint.trim());
    } catch {
      throw new DeployError("INVALID_ENDPOINT", "Invalid Dokploy endpoint URL format", 400);
    }

    if (url.username || url.password) {
      throw new DeployError("INVALID_ENDPOINT", "Dokploy endpoint must not contain embedded credentials in URL", 400);
    }

    const isLoopback = ["127.0.0.1", "localhost"].includes(url.hostname);
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && isLoopback)) {
      throw new DeployError("INVALID_ENDPOINT", "Dokploy endpoint must use HTTPS", 400);
    }

    // Strip trailing slashes and path
    url.hash = "";
    url.search = "";
    return url;
  }

  private resolveToken(credentials: Record<string, string>): string {
    const token = credentials.token || credentials.apiKey || credentials.api_key;
    if (!token || !token.trim()) {
      throw new DeployError("CREDENTIAL_MISSING", "Dokploy credentials must contain 'token' or 'apiKey'", 400);
    }
    return token.trim();
  }

  private redactMessage(msg: string, token?: string): string {
    if (!token) return msg;
    return msg.split(token).join("[REDACTED]");
  }

  async validateConfig(target: DeployTargetConfig, credentials: Record<string, string>): Promise<{ valid: boolean; error?: string }> {
    try {
      this.sanitizeEndpoint(target.endpoint);
      if (!target.applicationId && !target.projectName) {
        return { valid: false, error: "Dokploy applicationId or projectName is required" };
      }
      this.resolveToken(credentials);
      return { valid: true };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async deploy(
    scope: DeployScope,
    manifest: {
      target: DeployTargetConfig;
      preflight: DeployPreflightSummary;
      gitCommit?: string;
    },
    credentials: Record<string, string>
  ): Promise<DeployResult> {
    const endpoint = this.sanitizeEndpoint(manifest.target.endpoint);
    const token = this.resolveToken(credentials);
    const applicationId = manifest.target.applicationId || manifest.target.projectName;

    if (!applicationId) {
      throw new DeployError("MISSING_TARGET", "Dokploy applicationId or projectName is required", 400);
    }

    const deployPayload = {
      applicationId,
      branch: manifest.preflight.branch || manifest.target.branch || "project/main",
      commitHash: manifest.gitCommit,
      environment: manifest.preflight.environment || manifest.target.environment || "production",
      metadata: {
        workspaceId: scope.workspaceId,
        companyId: scope.companyId,
        projectId: scope.projectId,
      },
    };

    const deployUrl = new URL("/api/application.deploy", endpoint);

    try {
      const response = await this.transport(deployUrl.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "x-api-key": token,
        },
        body: JSON.stringify(deployPayload),
        signal: AbortSignal.timeout(30_000),
      });

      const responseText = await response.text();
      let responseJson: Record<string, any> = {};
      try {
        responseJson = JSON.parse(responseText);
      } catch {
        // Plain text response
      }

      if (!response.ok) {
        const errorMsg = responseJson.message || responseJson.error || responseText || `HTTP ${response.status}`;
        throw new DeployError(
          "DEPLOYMENT_FAILED",
          `Dokploy deployment failed: ${this.redactMessage(String(errorMsg), token)}`,
          response.status,
          response.status >= 500
        );
      }

      const deploymentId = responseJson.deploymentId || responseJson.id || `dokploy-${randomUUID().slice(0, 8)}`;
      const targetDomain = manifest.target.domain || responseJson.url || responseJson.domain || `${applicationId}.${endpoint.hostname}`;
      const url = targetDomain.startsWith("http") ? targetDomain : `https://${targetDomain}`;

      return {
        deploymentId,
        status: "deployed",
        url,
        logs: responseJson.logs ? this.redactMessage(String(responseJson.logs), token) : undefined,
        environment: manifest.preflight.environment || "production",
        target: `dokploy:${applicationId}`,
        deployedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof DeployError) throw error;
      const rawMessage = error instanceof Error ? error.message : String(error);
      const safeMessage = this.redactMessage(rawMessage, token);
      throw new DeployError("DEPLOY_REQUEST_ERROR", `Failed to contact Dokploy instance: ${safeMessage}`, 502, true);
    }
  }

  async getDeploymentStatus(
    _scope: DeployScope,
    deploymentId: string,
    target: DeployTargetConfig,
    credentials: Record<string, string>
  ): Promise<DeployResult> {
    const endpoint = this.sanitizeEndpoint(target.endpoint);
    const token = this.resolveToken(credentials);

    const statusUrl = new URL(`/api/application.getDeployment?deploymentId=${encodeURIComponent(deploymentId)}`, endpoint);

    try {
      const response = await this.transport(statusUrl.toString(), {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "x-api-key": token,
        },
        signal: AbortSignal.timeout(15_000),
      });

      const responseJson = (await response.json().catch(() => ({}))) as Record<string, any>;
      if (!response.ok) {
        throw new DeployError("STATUS_CHECK_FAILED", `Failed to check deployment status: ${response.status}`, response.status);
      }

      return {
        deploymentId,
        status: (responseJson.status as any) || "deployed",
        url: responseJson.url || (target.domain ? `https://${target.domain}` : undefined),
        logs: responseJson.logs ? this.redactMessage(String(responseJson.logs), token) : undefined,
        environment: target.environment || "production",
        target: `dokploy:${target.applicationId}`,
        deployedAt: responseJson.createdAt || new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof DeployError) throw error;
      throw new DeployError("STATUS_REQUEST_ERROR", "Failed to retrieve deployment status from Dokploy", 502);
    }
  }
}
