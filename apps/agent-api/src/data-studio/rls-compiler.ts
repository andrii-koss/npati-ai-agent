import { createHash } from "node:crypto";
import type { ProjectAccessPolicy } from "@npati/shared";
import { DataStudioError, quoteIdentifier, validateIdentifier } from "./identifier";

export interface CompiledRlsPolicy {
  collection: string;
  sql: string[];
  fingerprint: string;
}

export class RlsPolicyCompiler {
  /**
   * Validates policy structure and identifiers.
   */
  static validate(policy: ProjectAccessPolicy): void {
    if (!policy.collection || typeof policy.collection !== "string") {
      throw new DataStudioError(400, "policy", "Collection name is required in access policy", false, "INVALID_POLICY");
    }
    validateIdentifier(policy.collection);

    if (!["public", "authenticated", "owner", "role"].includes(policy.rule)) {
      throw new DataStudioError(400, "policy", `Unsupported access policy rule: ${policy.rule}`, false, "INVALID_POLICY_RULE");
    }

    if (policy.rule === "owner") {
      const ownerField = policy.ownerField ?? "owner_id";
      validateIdentifier(ownerField);
    }

    if (policy.rule === "role") {
      if (!policy.role || typeof policy.role !== "string") {
        throw new DataStudioError(400, "policy", "Role name is required for role-based access policy", false, "ROLE_REQUIRED");
      }
      validateIdentifier(policy.role);
    }
  }

  /**
   * Compiles declarative access policies into PostgreSQL RLS statements.
   */
  static compile(collectionName: string, policies: ProjectAccessPolicy[]): CompiledRlsPolicy {
    const table = quoteIdentifier(validateIdentifier(collectionName));
    const statements: string[] = [];

    // 1. Enable and Force RLS
    statements.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    statements.push(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);

    // 2. Drop existing npati policies on this table
    const policyPrefix = `npati_pol_${collectionName}_`;
    statements.push(`DROP POLICY IF EXISTS "${policyPrefix}select" ON ${table};`);
    statements.push(`DROP POLICY IF EXISTS "${policyPrefix}insert" ON ${table};`);
    statements.push(`DROP POLICY IF EXISTS "${policyPrefix}update" ON ${table};`);
    statements.push(`DROP POLICY IF EXISTS "${policyPrefix}delete" ON ${table};`);
    statements.push(`DROP POLICY IF EXISTS "${policyPrefix}mgmt" ON ${table};`);

    // 3. Grant migrator role management bypass
    statements.push(
      `CREATE POLICY "${policyPrefix}mgmt" ON ${table} FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);`,
    );

    // If no policies configured, default-deny remains in effect (only migrator has access)
    if (!policies.length) {
      const fingerprint = this.computeFingerprint(collectionName, policies);
      return { collection: collectionName, sql: statements, fingerprint };
    }

    // Collect conditions for each action
    const selectConditions: string[] = [];
    const insertConditions: string[] = [];
    const updateConditions: string[] = [];
    const deleteConditions: string[] = [];

    for (const policy of policies) {
      this.validate(policy);
      const actions = policy.actions ?? ["all"];
      const appliesTo = (action: "select" | "insert" | "update" | "delete") =>
        actions.includes("all") || actions.includes(action);

      let usingClause = "";
      let withCheckClause = "";

      switch (policy.rule) {
        case "public":
          usingClause = "true";
          withCheckClause = "true";
          break;

        case "authenticated":
          usingClause = "nullif(current_setting('npati.auth.user_id', true), '') IS NOT NULL";
          withCheckClause = "nullif(current_setting('npati.auth.user_id', true), '') IS NOT NULL";
          break;

        case "owner": {
          const ownerCol = quoteIdentifier(validateIdentifier(policy.ownerField ?? "owner_id"));
          usingClause = `(${ownerCol})::text = current_setting('npati.auth.user_id', true)`;
          withCheckClause = `(${ownerCol})::text = current_setting('npati.auth.user_id', true)`;
          break;
        }

        case "role": {
          const roleVal = policy.role!.replace(/'/g, "''");
          usingClause = `current_setting('npati.auth.user_role', true) = '${roleVal}'`;
          withCheckClause = `current_setting('npati.auth.user_role', true) = '${roleVal}'`;
          break;
        }
      }

      if (appliesTo("select")) selectConditions.push(usingClause);
      if (appliesTo("insert")) insertConditions.push(withCheckClause);
      if (appliesTo("update")) {
        updateConditions.push(usingClause);
      }
      if (appliesTo("delete")) deleteConditions.push(usingClause);
    }

    if (selectConditions.length) {
      statements.push(
        `CREATE POLICY "${policyPrefix}select" ON ${table} FOR SELECT USING (${selectConditions.join(" OR ")});`,
      );
    }
    if (insertConditions.length) {
      statements.push(
        `CREATE POLICY "${policyPrefix}insert" ON ${table} FOR INSERT WITH CHECK (${insertConditions.join(" OR ")});`,
      );
    }
    if (updateConditions.length) {
      statements.push(
        `CREATE POLICY "${policyPrefix}update" ON ${table} FOR UPDATE USING (${updateConditions.join(" OR ")}) WITH CHECK (${updateConditions.join(" OR ")});`,
      );
    }
    if (deleteConditions.length) {
      statements.push(
        `CREATE POLICY "${policyPrefix}delete" ON ${table} FOR DELETE USING (${deleteConditions.join(" OR ")});`,
      );
    }

    const fingerprint = this.computeFingerprint(collectionName, policies);
    return { collection: collectionName, sql: statements, fingerprint };
  }

  /**
   * Computes deterministic fingerprint for access policies.
   */
  static computeFingerprint(collection: string, policies: ProjectAccessPolicy[]): string {
    const canonical = policies.map((p) => ({
      collection: p.collection,
      rule: p.rule,
      ownerField: p.ownerField ?? null,
      role: p.role ?? null,
      actions: (p.actions ?? ["all"]).slice().sort(),
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    return createHash("sha256").update(JSON.stringify({ collection, policies: canonical })).digest("hex");
  }
}
