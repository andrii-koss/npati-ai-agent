import path from "node:path";
import type { AuthContext } from "@npati/workspace";
import { push } from "./project-git-push-service";
import { GitError } from "./project-git-service";
import type { ProjectGitBoundary } from "./project-git-service";

export interface ProjectGitCredentialHost {
  boundary?: ProjectGitBoundary
  resolveGithubCredential?: (ctx: AuthContext, companyId: string, credentialId: string) => Promise<string>
}

export async function githubToken(host: ProjectGitCredentialHost, ctx: AuthContext, companyId: string, credentialId?: string): Promise<string> {
    if (!credentialId || !host.resolveGithubCredential) throw new GitError("CREDENTIAL_MISSING", "A Company vault credential reference is required", 400);
    return host.resolveGithubCredential(ctx, companyId, credentialId);
  }

export async function acquireCredential(host: ProjectGitCredentialHost, ctx: AuthContext, companyId: string, projectId: string, input: { credentialId?: string; purpose: "git.push" | "pull_request.create" | "pull_request.comment"; toolCallId: string }): Promise<{ value: string; leaseId: string | null }> {
    if (host.boundary?.credentials && input.credentialId) {
      const lease = await host.boundary.credentials.acquire({
        ctx, companyId, projectId, credentialId: input.credentialId, toolCallId: input.toolCallId, purpose: input.purpose,
      });
      return { value: lease.value, leaseId: lease.leaseId };
    }
    return { value: await githubToken(host, ctx, companyId, input.credentialId), leaseId: null };
  }

