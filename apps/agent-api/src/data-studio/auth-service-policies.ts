import { withAuthPolicySchemaSnapshot } from "./auth-policy-schema-snapshot";
import type { AuthContext } from "@npati/workspace";
import type { ProjectAccessPolicy } from "@npati/shared";
import { quoteIdentifier } from "./identifier";
import type { DataEnvironmentName } from "./types";
import { ProjectKeyManager } from "./auth-crypto";
import { RlsPolicyCompiler } from "./rls-compiler";
import type { ProjectAuthHost } from "./auth-service-host";

export async function getAuthAccessPolicies(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
): Promise<ProjectAccessPolicy[]> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  return host.repository.getAccessPolicies(ctx, companyId, backend.id, environment);
}

export async function applyAuthAccessPolicies(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
  policies: ProjectAccessPolicy[],
): Promise<{ compiled: number; fingerprint: string }> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  return withAuthPolicySchemaSnapshot(host, ctx, backend, environment, policies, async () => {
  const migratorPool = await host.getPool(backend, environment, "migrator");

  // Group policies by collection
  const byCollection = new Map<string, ProjectAccessPolicy[]>();
  for (const policy of policies) {
    RlsPolicyCompiler.validate(policy);
    const list = byCollection.get(policy.collection) ?? [];
    list.push(policy);
    byCollection.set(policy.collection, list);
  }

  const client = await migratorPool.connect();
  try {
    await client.query("BEGIN");
    for (const [col, colPolicies] of byCollection.entries()) {
      const compiled = RlsPolicyCompiler.compile(col, colPolicies);
      for (const statement of compiled.sql) {
        await client.query(statement);
      }
      const runtimeUser = host.poolFactory ? "npati_runtime" : (await host.provisioner.getConnection(backend, environment, "runtime")).user;
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${quoteIdentifier(col)} TO ${quoteIdentifier(runtimeUser)}`);
      await host.repository.setCollectionAccessPolicies(ctx, companyId, backend.id, environment, col, colPolicies);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const allPolicies = await host.repository.getAccessPolicies(ctx, companyId, backend.id, environment);
  const fingerprint = RlsPolicyCompiler.computeFingerprint("all", allPolicies);
  return { compiled: byCollection.size, fingerprint };
  });
}

export async function rotateAuthSigningKey(
  host: ProjectAuthHost,
  ctx: AuthContext,
  companyId: string,
  projectId: string,
  environment: DataEnvironmentName,
): Promise<{ activeKid: string; previousKids: string[] }> {
  const backend = await host.getBackend(ctx, companyId, projectId);
  const settings = await host.getAuthSettings(ctx, companyId, projectId, environment);
  const bundle = await host.ensureInitialized(ctx, backend, environment);

  const ttlSec = (settings.accessTokenTtlMinutes || 15) * 60;
  const rotated = ProjectKeyManager.rotateBundle(bundle, ttlSec);
  await host.repository.saveSigningKeys(ctx, companyId, backend.id, environment, rotated);

  return {
    activeKid: rotated.activeKey.kid,
    previousKids: rotated.previousKeys.map((k) => k.kid),
  };
}
