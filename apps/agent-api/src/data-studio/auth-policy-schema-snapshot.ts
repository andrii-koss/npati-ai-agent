import { randomUUID } from "node:crypto";
import type { AuthContext } from "@npati/workspace";
import type { ProjectAccessPolicy } from "@npati/shared";
import type { DataBackend, DataEnvironmentName } from "./types";
import type { ProjectAuthHost } from "./auth-service-host";
import { DataStudioError } from "./identifier";

/** Synchronize only a managed DEV policy change, under the existing migration
 * lock. Policy compilation, RBAC, approval and production behavior are unchanged. */
export async function withAuthPolicySchemaSnapshot<T>(host: ProjectAuthHost, ctx: AuthContext, backend: DataBackend,
  environment: DataEnvironmentName, policies: ProjectAccessPolicy[], work: () => Promise<T>): Promise<T> {
  const provider = environment === "dev" ? host.schemaProvider : undefined;
  if (!provider) return work();
  const token = randomUUID();
  if (!await host.repository.acquireLock(backend.id, environment, token, 120000))
    throw new DataStudioError(409, "migration_lock", "Schema migration already in progress", true, "MIGRATION_BUSY");
  try {
    const env = await host.repository.environment(ctx, backend.companyId, backend.id, environment);
    const before = await provider.introspectSchema(backend, environment);
    if (env.syncStatus !== "synced" || env.schemaFingerprint !== provider.schemaFingerprint(before))
      throw new DataStudioError(409, "drift", "Existing schema drift must be reconciled before policy changes", false, "SCHEMA_DRIFT");
    const result = await work();
    const after = await provider.introspectSchema(backend, environment);
    const collections = new Set(policies.map(policy => policy.collection));
    // The managed operation may only change policies/RLS on its target tables.
    // Never bless a concurrent column/table/index/constraint change as expected.
    const expected = { tables: before.tables.map(table => {
      if (!collections.has(table.name)) return table;
      const actual = after.tables.find(item => item.name === table.name);
      return actual ? { ...table, policies: actual.policies, rlsEnabled: actual.rlsEnabled, rlsForced: actual.rlsForced } : table;
    }) };
    if (provider.schemaFingerprint(expected) !== provider.schemaFingerprint(after))
      throw new DataStudioError(409, "drift", "Schema changed concurrently with policy configuration", false, "SCHEMA_DRIFT");
    await host.repository.setExpectedSchema(ctx, backend.companyId, backend.id, environment, after, provider.schemaFingerprint(after));
    return result;
  } finally { await host.repository.releaseLock(backend.id, environment, token); }
}
