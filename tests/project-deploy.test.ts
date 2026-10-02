import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryWorkspaceStore } from "../packages/workspace/src/in-memory-store";
import type { AuthContext } from "@npati/workspace";
import { ProjectGitService } from "../apps/agent-api/src/project-git-service";
import {
  ProjectDeployService,
  DeployApprovalRequiredError,
  DeployCredentialError,
  type CredentialResolver,
} from "../apps/agent-api/src/project-deploy-service";
import { DokployDeployProvider } from "../apps/agent-api/src/deploy-provider";
import { classifyProjectIntent } from "../packages/shared/src/project-intent";
import { PROJECT_DEPLOY_CAPABILITIES } from "../packages/shared/src/project-deploy-capabilities";

const ctxA: AuthContext = {
  userId: "user-alpha",
  workspaceId: "tenant-alpha",
  permissions: ["workspace:read", "workspace:write", "tools:execute"],
};

const ctxB: AuthContext = {
  userId: "user-beta",
  workspaceId: "tenant-beta",
  permissions: ["workspace:read", "workspace:write", "tools:execute"],
};

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "npati-deploy-test-"));
  tempDirs.push(root);

  const store = new InMemoryWorkspaceStore();
  await store.initialize(ctxA);

  const company = await store.createCompany(ctxA, { name: "Alpha Company" }, "comp-alpha");
  const { project } = await store.createProject(
    ctxA,
    company.id,
    { name: "Alpha Landing", type: "landing_page" },
    "proj-alpha"
  );

  const projectService = {
    get: async (ctx: AuthContext, companyId: string, projectId: string) => {
      const proj = await store.getProject(ctx, companyId, projectId);
      if (!proj) {
        const err: any = new Error("Project not found");
        err.statusCode = 404;
        throw err;
      }
      return proj;
    },
  };

  const gitService = new ProjectGitService(store, projectService, root);
  const { dir: projectDir } = await gitService.getProjectPath(ctxA, company.id, project.id);
  await gitService.ensureRepository(ctxA, company.id, project.id);

  // Write sample index.html and commit to establish clean git state
  await writeFile(path.join(projectDir, "index.html"), "<h1>Hello Deploy</h1>", "utf-8");
  await gitService.commit(ctxA, company.id, project.id, {
    message: "Initial commit for deploy",
  });

  // Vault mock storing secret tokens keyed by companyId:credentialId
  const vaultData = new Map<string, { id: string; token: string; url?: string; metadata?: any }>();
  vaultData.set(`${company.id}:dokploy-cred-1`, {
    id: "dokploy-cred-1",
    token: "super-secret-dokploy-token-abc123xyz",
    url: "https://dokploy.example.com",
    metadata: {
      provider: "dokploy",
      environment: "production",
      applicationId: "app-dokploy-alpha-99",
      appName: "alpha-landing-prod",
    },
  });

  const capturedRequests: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const rawHeaders = init?.headers || {};
    const normHeaders: Record<string, string> = {};
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => { normHeaders[k.toLowerCase()] = v; });
    } else if (Array.isArray(rawHeaders)) {
      for (const [k, v] of rawHeaders) { normHeaders[k.toLowerCase()] = v; }
    } else {
      for (const [k, v] of Object.entries(rawHeaders)) { normHeaders[k.toLowerCase()] = String(v); }
    }

    capturedRequests.push({
      url: String(input),
      method: init?.method || "GET",
      headers: normHeaders,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (String(input).includes("/api/application.deploy")) {
      return new Response(
        JSON.stringify({
          success: true,
          deploymentId: "dep-dokploy-12345",
          url: "https://alpha-landing.example.com",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const dokployProvider = new DokployDeployProvider(mockFetch);

  const resolveCredential: CredentialResolver = async (_ctx, companyId, credentialId) => {
    const cred = vaultData.get(`${companyId}:${credentialId}`);
    if (!cred) {
      throw new DeployCredentialError("CREDENTIAL_NOT_FOUND", `Credential ${credentialId} not found in Company vault`, 404);
    }
    return {
      token: cred.token,
      endpoint: cred.url || "https://dokploy.example.com",
      applicationId: cred.metadata?.applicationId || "app-dokploy-alpha-99",
    };
  };

  const deployService = new ProjectDeployService(
    store,
    projectService,
    gitService,
    resolveCredential,
    [dokployProvider]
  );

  return {
    store,
    company,
    project,
    gitService,
    deployService,
    dokployProvider,
    capturedRequests,
    projectDir,
  };
}

describe("Step 10: Project Deploy & Dokploy Provider", () => {
  it("computes comprehensive preflight summary (Environment, Branch, Files, Build, Tests, Target)", async () => {
    const { deployService, company, project } = await createFixture();

    const preflight = await deployService.preflight(ctxA, company.id, project.id, {
      target: {
        environment: "production",
        provider: "dokploy",
        endpoint: "https://dokploy.example.com",
        applicationId: "app-dokploy-alpha-99",
      },
    });

    expect(preflight.environment).toBe("production");
    expect(preflight.branch).toBe("main");
    expect(preflight.target.provider).toBe("dokploy");
    expect(preflight.buildStatus).toBe("ready");
    expect(preflight.filesChanged).toBe(0);
    expect(preflight.testsStatus).toBe("passed");
  });

  it("blocks deploy without approval and requires confirmation with preflight data", async () => {
    const { deployService, company, project } = await createFixture();

    let thrownError: unknown;
    try {
      await deployService.deploy(ctxA, company.id, project.id, {
        credentialId: "dokploy-cred-1",
        target: {
          environment: "production",
          provider: "dokploy",
          endpoint: "https://dokploy.example.com",
          applicationId: "app-dokploy-alpha-99",
        },
        approved: false, // approval not granted!
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(DeployApprovalRequiredError);
    const approvalErr = thrownError as DeployApprovalRequiredError;
    expect(approvalErr.preflight).toBeDefined();
    expect(approvalErr.preflight.environment).toBe("production");
    expect(approvalErr.preflight.branch).toBe("main");
    expect(approvalErr.approvalPayload).toBeDefined();

    // Verify no deployments were created in store
    const deployments = await deployService.listDeployments(ctxA, company.id, project.id);
    expect(deployments).toHaveLength(0);
  });

  it("executes deploy successfully when approval is confirmed", async () => {
    const { deployService, company, project, store, capturedRequests } = await createFixture();

    const result = await deployService.deploy(ctxA, company.id, project.id, {
      credentialId: "dokploy-cred-1",
      target: {
        environment: "production",
        provider: "dokploy",
        endpoint: "https://dokploy.example.com",
        applicationId: "app-dokploy-alpha-99",
      },
      approved: true, // explicit human approval granted!
    });

    expect(result.status).toBe("deployed");
    expect(result.targetUrl).toBe("https://alpha-landing.example.com");
    expect(result.deploymentId).toBe("dep-dokploy-12345");

    // Check deployment record in store
    const deployments = await deployService.listDeployments(ctxA, company.id, project.id);
    expect(deployments).toHaveLength(1);
    expect(deployments[0].status).toBe("deployed");
    expect(deployments[0].targetUrl).toBe("https://alpha-landing.example.com");

    // Check project was updated with deployment target URL and status
    const updatedProject = await store.getProject(ctxA, company.id, project.id);
    expect(updatedProject?.deploymentStatus).toBe("deployed");
    expect(updatedProject?.deploymentUrl).toBe("https://alpha-landing.example.com");

    // Verify Dokploy request was sent with Bearer token
    expect(capturedRequests.length).toBeGreaterThan(0);
    const deployReq = capturedRequests[0];
    expect(deployReq.headers.authorization).toBe("Bearer super-secret-dokploy-token-abc123xyz");
  });

  it("strictly forbids raw credentials in input payload", async () => {
    const { deployService, company, project } = await createFixture();

    await expect(
      deployService.deploy(ctxA, company.id, project.id, {
        credentialId: "dokploy-cred-1",
        token: "raw-bearer-token-in-body", // FORBIDDEN!
        target: {
          environment: "production",
          provider: "dokploy",
        },
        approved: true,
      } as any)
    ).rejects.toThrow(/raw credentials are not allowed/i);
  });

  it("prevents credential leakage from errors and logs", async () => {
    const secretToken = "my-ultra-secret-vault-token-987654";
    const leakingFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          error: `Authentication failed for token ${secretToken}: unauthorized upstream response`,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    };

    const provider = new DokployDeployProvider(leakingFetch);

    let errorThrown: any;
    try {
      await provider.deploy(
        {
          workspaceId: "tenant-alpha",
          companyId: "comp-alpha",
          projectId: "proj-alpha",
          userId: "user-alpha",
        },
        {
          target: {
            provider: "dokploy",
            environment: "production",
            endpoint: "https://dokploy.example.com",
            applicationId: "app-dokploy-123",
          },
          preflight: {
            environment: "production",
            branch: "main",
            target: { provider: "dokploy", environment: "production" },
            buildStatus: "ready",
            filesChanged: 0,
            changedFilesList: [],
            testsStatus: "passed",
          },
        },
        { token: secretToken }
      );
    } catch (err: any) {
      errorThrown = err;
    }

    expect(errorThrown).toBeDefined();
    // Verify the secret token was masked with [REDACTED] and NEVER leaked in message
    expect(errorThrown.message).not.toContain(secretToken);
    expect(errorThrown.message).toContain("[REDACTED]");
  });

  it("enforces tenant and project isolation", async () => {
    const { deployService, company, project } = await createFixture();

    // Tenant B cannot access Tenant A's project
    await expect(
      deployService.preflight(ctxB, company.id, project.id, {
        target: {
          environment: "production",
          provider: "dokploy",
        },
      })
    ).rejects.toThrow(/(?:not found|not available)/i);

    // Tenant B cannot deploy Tenant A's project
    await expect(
      deployService.deploy(ctxB, company.id, project.id, {
        credentialId: "dokploy-cred-1",
        target: {
          environment: "production",
          provider: "dokploy",
        },
        approved: true,
      })
    ).rejects.toThrow(/(?:not found|not available)/i);

    // Tenant A cannot use nonexistent credential from another company
    await expect(
      deployService.deploy(ctxA, company.id, project.id, {
        credentialId: "other-company-cred",
        target: {
          environment: "production",
          provider: "dokploy",
        },
        approved: true,
      })
    ).rejects.toThrow(DeployCredentialError);
  });

  it("validates Dokploy endpoint URLs and rejects non-HTTPS in production", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const provider = new DokployDeployProvider();
      await expect(
        provider.deploy(
          {
            workspaceId: "tenant-alpha",
            companyId: "comp-alpha",
            projectId: "proj-alpha",
            userId: "user-alpha",
          },
          {
            target: {
              provider: "dokploy",
              environment: "production",
              endpoint: "http://insecure-dokploy.com", // Insecure HTTP!
              applicationId: "app-123",
            },
            preflight: {
              environment: "production",
              branch: "main",
              target: { provider: "dokploy", environment: "production" },
              buildStatus: "ready",
              filesChanged: 0,
              changedFilesList: [],
              testsStatus: "passed",
            },
          },
          { token: "tok-123" }
        )
      ).rejects.toThrow(/HTTPS/i);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it("classifies DEPLOY_PROJECT intent correctly", () => {
    const context = {
      activeProjectId: "proj-alpha",
      activeCompanyId: "comp-alpha",
      recentFiles: ["index.html"],
    };

    const intentEn = classifyProjectIntent({
      message: "Deploy this website to Dokploy production",
      ...context,
    });
    expect(intentEn.intent).toBe("DEPLOY_PROJECT");
    expect(intentEn.confidence).toBeGreaterThan(0.8);

    const intentUk = classifyProjectIntent({
      message: "Задеплой проєкт на продакшн dokploy",
      ...context,
    });
    expect(intentUk.intent).toBe("DEPLOY_PROJECT");
    expect(intentUk.confidence).toBeGreaterThan(0.8);
    expect(intentUk.suggestedAction).toBe("project.deploy.publish");
    expect(intentUk.executable).toBe(true);
    expect(intentUk.isProjectIntent).toBe(true);
  });

  it("registers project.deploy.publish and project.deploy.status in capability matrix", () => {
    expect(PROJECT_DEPLOY_CAPABILITIES).toHaveLength(2);
    const publishCap = PROJECT_DEPLOY_CAPABILITIES.find((c) => c.id === "project.deploy.publish");
    const statusCap = PROJECT_DEPLOY_CAPABILITIES.find((c) => c.id === "project.deploy.status");

    expect(publishCap).toBeDefined();
    expect(publishCap?.risk).toBe("high");
    expect(publishCap?.requiresConfirmation).toBe(true);

    expect(statusCap).toBeDefined();
    expect(statusCap?.risk).toBe("low");
    expect(statusCap?.requiresConfirmation).toBe(false);
  });
});
