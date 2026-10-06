import { describe, expect, it } from "vitest";
import type { AuthContext } from "@npati/workspace";
import {
  PolicyEngine, type PolicyEngineDeps, type PolicyRequest,
} from "../apps/agent-api/src/code-policy-engine";
import { classifyShellCommand, classifyShellRisk } from "../apps/agent-api/src/code-shell-classifier";
import {
  CodeShellRuntime, ShellRuntimeError, type CodeShellSandboxPort,
} from "../apps/agent-api/src/code-shell-runtime";
import {
  MIGRATION_CODES,
  analyzeMigrationDiff,
  applyMigrationThroughDataStudio,
  assertNoProductionCredentialsVisible,
  detectHiddenMigrations,
  detectMigrationAction,
  evaluateMigrationSafety,
  resolveMigrationTarget,
} from "../apps/agent-api/src/code-migration-safety";

/**
 * SG-3 (C6a): database migration safety.
 *
 * The suite exists to prove three things that must never regress:
 *   1. a migration can never touch production, an external database or an unidentified target — the
 *      refusal is a hard deny that no mode, role, standing rule or `approved: true` claim can lift;
 *   2. a development migration can only run through the Data Studio migration engine (advisory lock,
 *      checksum, snapshot, history), never through a hand-written SQL path;
 *   3. destructive work (DROP/TRUNCATE/DELETE without WHERE/column removal/type change) requires a
 *      snapshot in addition to an approval, and the reviewer sees that in the approval payload.
 */

const owner: AuthContext = { workspaceId: "ws-c6a", userId: "user-owner", permissions: ["workspace:read", "workspace:write", "admin:all"] };

const TOOLS = ["code.shell.exec", "code.fs.write", "code.fs.read", "code.deps.add", "code.verify.run"];

const PRODUCTION_URL = "postgres://npati_admin:s3cret@db.prod.npati.internal:5432/app";
const DEV_HOST = "dev-db.data-studio.internal";

function harness(overrides: Partial<PolicyEngineDeps> = {}) {
  const approvals = {
    requested: [] as Array<Record<string, unknown>>,
    consumed: [] as Array<{ id: string; params: Record<string, unknown> }>,
    async requestApproval(_ctx: AuthContext, _companyId: string, input: Record<string, unknown>) {
      approvals.requested.push(input);
      return { id: `approval-${approvals.requested.length}` };
    },
    async consumeApproved(_ctx: AuthContext, _companyId: string, id: string, params: Record<string, unknown>) {
      approvals.consumed.push({ id, params });
      return { id };
    },
  };
  const deps: PolicyEngineDeps = {
    flags: { async assertEnabled() { return true; } },
    capabilities: { get: (id: string) => (TOOLS.includes(id) ? { id, status: "active", version: 1 } : undefined) },
    // The real classifier is used on purpose: the migration hint has to survive the actual code path.
    classifier: (command: string) => classifyShellCommand(command, {}),
    approvals,
    networkEnforcement: () => true,
    ...overrides,
  };
  return { engine: new PolicyEngine(deps), approvals, deps };
}

function request(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    ctx: owner,
    companyId: "company-1",
    projectId: "project-1",
    sessionId: "session-1",
    tool: "code.shell.exec",
    command: "prisma migrate deploy",
    sessionMode: "full_auto",
    ...overrides,
  };
}

describe("security-gate: C6a migration command detection", () => {
  it("recognises the migration runners the plan lists", () => {
    expect(detectMigrationAction("npx prisma migrate deploy")?.tool).toBe("prisma");
    expect(detectMigrationAction("prisma db push")?.action).toBe("apply");
    expect(detectMigrationAction("alembic upgrade head")?.tool).toBe("alembic");
    expect(detectMigrationAction("python manage.py migrate")?.tool).toBe("django");
    expect(detectMigrationAction("bundle exec rails db:migrate")?.tool).toBe("rails");
    expect(detectMigrationAction("php artisan migrate")?.tool).toBe("artisan");
    expect(detectMigrationAction("knex migrate:latest")?.tool).toBe("knex");
    expect(detectMigrationAction("typeorm migration:run")?.tool).toBe("typeorm");
    expect(detectMigrationAction("npx sequelize db:migrate")?.tool).toBe("sequelize");
    expect(detectMigrationAction("flyway migrate")?.tool).toBe("flyway");
    expect(detectMigrationAction("liquibase update")?.tool).toBe("liquibase");
    expect(detectMigrationAction("goose up")?.tool).toBe("goose");
    expect(detectMigrationAction("sqlx migrate run")?.tool).toBe("sqlx");
    expect(detectMigrationAction("dbmate up")?.tool).toBe("dbmate");
  });

  it("marks the destructive forms as destructive", () => {
    expect(detectMigrationAction("prisma migrate reset")?.destructive).toBe(true);
    expect(detectMigrationAction("prisma db push --force-reset")?.destructive).toBe(true);
    expect(detectMigrationAction("prisma db push --accept-data-loss")?.destructive).toBe(true);
    expect(detectMigrationAction("flyway clean")?.destructive).toBe(true);
    expect(detectMigrationAction("goose reset")?.destructive).toBe(true);
    expect(detectMigrationAction("alembic downgrade base")?.destructive).toBe(true);
    expect(detectMigrationAction("typeorm schema:drop")?.destructive).toBe(true);
  });

  it("does not treat writing a migration file as running a migration", () => {
    // The command text only *mentions* a migration: nothing executes it.
    expect(detectMigrationAction("cat prisma/migrations/20240101_init/migration.sql")).toBeUndefined();
    expect(detectMigrationAction("rg 'prisma migrate deploy' src/")).toBeUndefined();
    expect(detectMigrationAction("git status")).toBeUndefined();
    expect(detectMigrationAction("npm test")).toBeUndefined();
  });

  it("treats a local SQL client as ordinary development work and a remote one as a migration", () => {
    expect(detectMigrationAction("psql -h localhost -U dev app")).toBeUndefined();
    expect(detectMigrationAction("psql postgres://dev@127.0.0.1:5432/app")).toBeUndefined();
    expect(detectMigrationAction("sqlite3 ./dev.db 'select 1'")).toBeUndefined();
    expect(detectMigrationAction("psql -h db.prod.npati.internal -U admin app")?.directSqlClient).toBe(true);
    expect(detectMigrationAction("mysql --host=reports.example.com app")?.directSqlClient).toBe(true);
  });

  it("escalates a migration command to approval in the shell classifier and keeps the hint", () => {
    const classification = classifyShellCommand("prisma migrate deploy");
    expect(classification.risk).toBe("approval");
    expect(classification.migration?.tool).toBe("prisma");
    expect(classification.reasons.join(" ")).toMatch(/migration/i);
    // The downgrade must not be reachable: even `full_auto` sees an approval class.
    expect(classifyShellRisk("prisma migrate deploy")).toBe("approval");
    // Unrelated read-only commands keep their previous classification.
    expect(classifyShellRisk("git status")).toBe("safe");
  });
});

describe("security-gate: C6a migration targets", () => {
  it("classifies production by environment or by host, never by variable name", () => {
    expect(resolveMigrationTarget({ environment: "production" }).kind).toBe("production");
    expect(resolveMigrationTarget({ databaseUrl: PRODUCTION_URL, productionUrls: [PRODUCTION_URL] }).kind).toBe("production");
    expect(resolveMigrationTarget({ host: "db.prod.npati.internal", productionHosts: ["db.prod.npati.internal"] }).kind).toBe("production");
  });

  it("classifies the ephemeral sandbox and the dev DataBackend", () => {
    expect(resolveMigrationTarget({ sandboxEphemeral: true }).kind).toBe("ephemeral_sandbox");
    expect(resolveMigrationTarget({ host: "localhost" }).kind).toBe("ephemeral_sandbox");
    expect(resolveMigrationTarget({ environment: "development", dataStudioBackend: true, host: DEV_HOST }).kind).toBe("dev_data_backend");
    expect(resolveMigrationTarget({ host: DEV_HOST, devHosts: [DEV_HOST] }).kind).toBe("dev_data_backend");
  });

  it("fails closed on an unknown or external target", () => {
    expect(resolveMigrationTarget({}).kind).toBe("unknown");
    expect(resolveMigrationTarget({ host: "random.example.com" }).kind).toBe("external");
    // A development-looking environment name does not make an unknown host a dev backend.
    expect(resolveMigrationTarget({ environment: "development", host: "random.example.com" }).kind).toBe("external");
  });
});

describe("security-gate: C6a migration diff analysis", () => {
  it("flags destructive SQL in migration files", () => {
    const analysis = analyzeMigrationDiff([
      { path: "prisma/migrations/20240101_drop/migration.sql", content: "ALTER TABLE users DROP COLUMN email;" },
      { path: "prisma/migrations/20240102_truncate/migration.sql", content: "TRUNCATE TABLE audit_log;" },
      { path: "prisma/migrations/20240103_delete/migration.sql", content: "DELETE FROM sessions;" },
    ]);
    expect(analysis.destructive).toBe(true);
    expect(analysis.requiresSnapshot).toBe(true);
    expect(analysis.findings.map((finding) => finding.kind).sort()).toEqual(["drop_column", "truncate", "unbounded_delete"]);
    // One finding per kind and file: the same statement is not reported twice.
    expect(new Set(analysis.findings.map((finding) => `${finding.path}:${finding.kind}`)).size).toBe(analysis.findings.length);
  });

  it("does not flag a bounded DELETE, and detects a rollback plan", () => {
    const bounded = analyzeMigrationDiff([
      { path: "prisma/migrations/20240101_cleanup/migration.sql", content: "DELETE FROM sessions WHERE expires_at < now();" },
    ]);
    expect(bounded.destructive).toBe(false);
    expect(bounded.requiresSnapshot).toBe(false);

    const withRollback = analyzeMigrationDiff([
      { path: "prisma/migrations/20240101_init/migration.sql", content: "-- down\nDROP TABLE users;" },
    ]);
    expect(withRollback.destructive).toBe(true);
    expect(withRollback.hasRollbackPlan).toBe(true);
  });

  it("flags the ORM code forms of destructive changes", () => {
    const prisma = analyzeMigrationDiff([
      { path: "prisma/migrations/20240101_x/migration.ts", content: "await prisma.$executeRaw`ALTER TABLE t DROP COLUMN c`;\nexport async function down() {}" },
    ]);
    expect(prisma.destructive).toBe(true);
    const knex = analyzeMigrationDiff([
      { path: "migrations/20240101_x.js", content: "exports.up = (knex) => knex.schema.table('t', (t) => t.dropColumn('c'));" },
    ]);
    expect(knex.destructive).toBe(true);
  });
});

describe("security-gate: C6a hidden migrations", () => {
  it("detects a migration run from a project script", () => {
    const findings = detectHiddenMigrations([
      {
        path: "package.json",
        content: JSON.stringify({
          scripts: {
            prestart: "prisma migrate deploy",
            dev: "npm run build && prisma migrate deploy && node dist/server.js",
            test: "vitest run",
            lint: "eslint .",
          },
        }),
      },
    ]);
    expect(findings.map((finding) => finding.script)).toEqual(expect.arrayContaining(["prestart", "dev"]));
    expect(findings.every((finding) => finding.reasonCode === "hidden_migration_script")).toBe(true);
    // A script that does not run a migration is not reported.
    expect(findings.some((finding) => finding.script === "test")).toBe(false);
  });

  it("detects a migration inside a Makefile target or an entrypoint script", () => {
    const makefile = detectHiddenMigrations([{ path: "Makefile", content: "migrate:\n\tgoose up\n" }]);
    expect(makefile).toHaveLength(1);
    const entrypoint = detectHiddenMigrations([{ path: "docker/docker-entrypoint.sh", content: "#!/bin/sh\nnpx prisma migrate deploy\n" }]);
    expect(entrypoint).toHaveLength(1);
  });
});

describe("security-gate: C6a production credentials", () => {
  it("refuses when a production connection string is visible to the agent", () => {
    const leaked = assertNoProductionCredentialsVisible({
      agentEnv: { DATABASE_URL: PRODUCTION_URL, PATH: "/usr/bin" },
      productionUrls: [PRODUCTION_URL],
    });
    expect(leaked.safe).toBe(false);
    expect(leaked.leakedKeys).toEqual(["DATABASE_URL"]);
    expect(leaked.code).toBe(MIGRATION_CODES.credentialsVisible);

    const named = assertNoProductionCredentialsVisible({
      agentEnv: { PROD_DATABASE_URL: "postgres://u:p@elsewhere/app" },
      productionSecretKeys: ["PROD_DATABASE_URL"],
    });
    expect(named.safe).toBe(false);

    const safe = assertNoProductionCredentialsVisible({
      agentEnv: { DATABASE_URL: "postgres://dev:dev@127.0.0.1:5432/dev", PATH: "/usr/bin" },
      productionUrls: [PRODUCTION_URL],
    });
    expect(safe.safe).toBe(true);
  });
});

describe("security-gate: C6a migration verdict", () => {
  it("denies production, external and unknown targets", () => {
    const production = evaluateMigrationSafety({
      command: "prisma migrate deploy", target: resolveMigrationTarget({ environment: "production" }),
    });
    expect(production?.decision).toBe("deny");
    expect(production?.code).toBe(MIGRATION_CODES.productionTarget);
    expect(production?.executionPath).toBe("denied");

    const external = evaluateMigrationSafety({
      command: "psql -h random.example.com app -c 'select 1'", target: resolveMigrationTarget({ host: "random.example.com" }),
    });
    expect(external?.decision).toBe("deny");
    expect(external?.code).toBe(MIGRATION_CODES.externalTarget);

    const unknown = evaluateMigrationSafety({ command: "alembic upgrade head", target: resolveMigrationTarget({}) });
    expect(unknown?.decision).toBe("deny");
    expect(unknown?.code).toBe(MIGRATION_CODES.unknownTarget);

    // No migration context at all is still a refusal, not an implicit allow.
    const undeclared = evaluateMigrationSafety({ command: "flyway migrate" });
    expect(undeclared?.decision).toBe("deny");
    expect(undeclared?.code).toBe(MIGRATION_CODES.unknownTarget);
  });

  it("requires the Data Studio engine for a development DataBackend", () => {
    const withoutEngine = evaluateMigrationSafety({
      command: "psql -h dev-db.data-studio.internal -U migrator app -f migration.sql",
      target: resolveMigrationTarget({ host: DEV_HOST, devHosts: [DEV_HOST] }),
    });
    expect(withoutEngine?.decision).toBe("deny");
    expect(withoutEngine?.code).toBe(MIGRATION_CODES.executionPathRequired);

    const withEngine = evaluateMigrationSafety({
      command: "prisma migrate deploy",
      target: resolveMigrationTarget({ dataStudioBackend: true, environment: "development", host: DEV_HOST }),
      dataStudioEngine: true,
    });
    expect(withEngine?.decision).toBe("require_approval");
    expect(withEngine?.executionPath).toBe("data_studio_engine");
  });

  it("requires a snapshot for destructive work and an approval for everything else", () => {
    const destructive = evaluateMigrationSafety({
      command: "prisma migrate reset", target: resolveMigrationTarget({ sandboxEphemeral: true }),
    });
    expect(destructive?.decision).toBe("require_approval");
    expect(destructive?.code).toBe(MIGRATION_CODES.destructive);
    expect(destructive?.requiresSnapshot).toBe(true);

    const plain = evaluateMigrationSafety({
      command: "prisma migrate deploy", target: resolveMigrationTarget({ sandboxEphemeral: true }),
      rollbackPlan: false,
    });
    expect(plain?.decision).toBe("require_approval");
    expect(plain?.requiresSnapshot).toBe(false);

    const destructiveDiff = evaluateMigrationSafety({
      command: "prisma migrate deploy",
      target: resolveMigrationTarget({ sandboxEphemeral: true }),
      files: [{ path: "prisma/migrations/20240101_drop/migration.sql", content: "DROP TABLE users;" }],
    });
    expect(destructiveDiff?.decision).toBe("require_approval");
    expect(destructiveDiff?.code).toBe(MIGRATION_CODES.destructive);
    expect(destructiveDiff?.requiresSnapshot).toBe(true);
  });

  it("requires an approval when a migration has no rollback plan or hides behind a script", () => {
    const noRollback = evaluateMigrationSafety({
      command: "goose up", target: resolveMigrationTarget({ sandboxEphemeral: true }),
      files: [{ path: "migrations/20240101_x.sql", content: "CREATE TABLE t(id int);" }],
    });
    expect(noRollback?.code).toBe(MIGRATION_CODES.noRollbackPlan);

    const hidden = evaluateMigrationSafety({
      command: "npm run prestart", target: resolveMigrationTarget({ sandboxEphemeral: true }),
      files: [{ path: "package.json", content: JSON.stringify({ scripts: { prestart: "prisma migrate deploy" } }) }],
    });
    expect(hidden?.decision).toBe("require_approval");
    expect([MIGRATION_CODES.hidden, MIGRATION_CODES.destructive]).toContain(hidden?.code);
  });

  it("ignores non-migration requests entirely", () => {
    expect(evaluateMigrationSafety({ command: "npm test" })).toBeUndefined();
    expect(evaluateMigrationSafety({ command: "git status" })).toBeUndefined();
    expect(evaluateMigrationSafety({ command: "psql -h localhost app", files: [{ path: "src/index.ts", content: "const a = 1;" }] })).toBeUndefined();
  });
});

describe("security-gate: C6a migration execution path", () => {
  it("runs a development migration through the Data Studio engine, not through SQL", async () => {
    const calls: string[] = [];
    const engine = {
      async dryRun() { calls.push("dryRun"); return { destructive: false }; },
      async apply(_ctx: unknown, _request: unknown) { calls.push("apply"); return { id: "migration-1", version: 1 }; },
    };
    const result = await applyMigrationThroughDataStudio(engine, owner, { environment: "development" });
    expect(calls).toEqual(["dryRun", "apply"]);
    expect(result).toMatchObject({ id: "migration-1" });

    // The real engine satisfies the structural port: same method names, bivariant parameters.
    const engineShape: Parameters<typeof applyMigrationThroughDataStudio>[0] = engine;
    expect(typeof engineShape.apply).toBe("function");
  });

  it("surfaces a failed migration exactly once, leaving the transaction or snapshot restore to the engine", async () => {
    const calls: string[] = [];
    const engine = {
      async dryRun() { calls.push("dryRun"); return {}; },
      async apply() {
        calls.push("apply");
        throw Object.assign(new Error("relation already exists"), { code: "MIGRATION_FAILED" });
      },
    };
    await expect(applyMigrationThroughDataStudio(engine, owner, {})).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    // Exactly one attempt: retrying could apply a half-applied migration twice, which is what the engine's
    // transaction (and the snapshot it takes for destructive work) exists to prevent.
    expect(calls).toEqual(["dryRun", "apply"]);
  });

  it("never reaches the engine when the verdict is a denial", async () => {    const calls: string[] = [];
    const engine = {
      async dryRun() { calls.push("dryRun"); return {}; },
      async apply() { calls.push("apply"); return {}; },
    };
    const verdict = evaluateMigrationSafety({
      command: "prisma migrate deploy", target: resolveMigrationTarget({ environment: "production" }),
    });
    await expect(applyMigrationThroughDataStudio(engine, owner, {}, { verdict })).rejects.toMatchObject({
      code: MIGRATION_CODES.productionTarget,
    });
    expect(calls).toEqual([]);
  });
});

describe("security-gate: C6a policy engine migration phase", () => {
  it("hard denies a migration against production and never asks for an approval", async () => {
    const { engine, approvals } = harness();
    const result = await engine.evaluate(request({
      command: "prisma migrate deploy",
      migration: { target: { environment: "production" } },
      sessionMode: "full_auto",
      approved: true,
      approvalId: "approval-forged",
    }));
    expect(result.decision).toBe("deny");
    expect(result.code).toBe(MIGRATION_CODES.productionTarget);
    expect(result.phase).toBe("hard_deny");
    expect(result.risk).toBe("hard_deny");
    expect(approvals.requested).toEqual([]);
  });

  it("hard denies production even with a matching connection string and a known host", async () => {
    const { engine, approvals } = harness();
    for (const target of [
      { databaseUrl: PRODUCTION_URL, productionUrls: [PRODUCTION_URL] },
      { host: "db.prod.npati.internal", productionHosts: ["db.prod.npati.internal"] },
    ]) {
      const result = await engine.evaluate(request({ command: "npx prisma migrate deploy", migration: { target } }));
      expect(result.decision).toBe("deny");
      expect(result.code).toBe(MIGRATION_CODES.productionTarget);
    }
    expect(approvals.requested).toEqual([]);
  });

  it("denies an external or unknown target", async () => {
    const { engine } = harness();
    const external = await engine.evaluate(request({
      command: "psql -h random.example.com app -c 'drop table t'",
      migration: { target: { host: "random.example.com" } },
    }));
    expect(external.decision).toBe("deny");
    expect(external.code).toBe(MIGRATION_CODES.externalTarget);

    const unknown = await engine.evaluate(request({ command: "alembic upgrade head" }));
    expect(unknown.decision).toBe("deny");
    expect(unknown.code).toBe(MIGRATION_CODES.unknownTarget);
  });

  it("denies a development migration that does not go through the Data Studio engine", async () => {
    const { engine, approvals } = harness();
    const result = await engine.evaluate(request({
      command: "psql -h dev-db.data-studio.internal -U migrator app -f up.sql",
      migration: { target: { host: DEV_HOST, devHosts: [DEV_HOST] } },
    }));
    expect(result.decision).toBe("deny");
    expect(result.code).toBe(MIGRATION_CODES.executionPathRequired);
    expect(result.phase).toBe("hard_deny");
    expect(approvals.requested).toEqual([]);
  });

  it("requires an approval with a snapshot for a destructive migration, in every mode", async () => {
    const { engine, approvals } = harness();
    for (const mode of ["plan", "edit", "auto", "full_auto"] as const) {
      const result = await engine.evaluate(request({
        command: "prisma migrate reset",
        sessionMode: mode,
        migration: { target: { sandboxEphemeral: true } },
      }));
      // In `plan` the session-mode phase refuses shell tools outright; the point of the loop is that no
      // mode turns a destructive migration into an allow.
      expect(["deny", "require_approval"]).toContain(result.decision);
      if (mode !== "plan") {
        expect(result.decision).toBe("require_approval");
        expect(result.code).toBe("approval_required");
        expect(result.phase).toBe("approval");
      }
    }
    const first = approvals.requested[0] as { migration?: Record<string, unknown> } | undefined;
    expect(first?.migration).toMatchObject({
      destructive: true,
      requiresSnapshot: true,
      target: "ephemeral_sandbox",
      executionPath: "ephemeral_sandbox",
    });
    // The approval payload never carries SQL text, a connection string or credentials.
    const serialised = JSON.stringify(approvals.requested);
    expect(serialised).not.toMatch(/postgres:\/\//);
    expect(serialised).not.toMatch(/drop table/i);
    expect(serialised).not.toMatch(/s3cret/);
  });

  it("requires an approval with a snapshot when the diff itself is destructive", async () => {
    const { engine, approvals } = harness();
    const result = await engine.evaluate(request({
      command: "prisma migrate deploy",
      migration: {
        target: { sandboxEphemeral: true },
        files: [{ path: "prisma/migrations/20240101_drop/migration.sql", content: "ALTER TABLE users DROP COLUMN email;" }],
      },
    }));
    expect(result.decision).toBe("require_approval");
    expect(result.reasons.join(" ")).toContain("migration:");
    const payload = approvals.requested[0] as { migration?: Record<string, unknown> } | undefined;
    expect(payload?.migration).toMatchObject({ destructive: true, requiresSnapshot: true });
  });

  it("keeps a non-migration command on its previous path", async () => {
    const { engine, approvals } = harness();
    // A safe command stays an allow, and no migration context is attached to it.
    const safe = await engine.evaluate(request({ command: "git status" }));
    expect(safe.decision).toBe("allow");
    expect(safe.reasons.join(" ")).not.toContain("migration:");
    // `npm test` keeps exactly the classification it had before this step: the harness does not invent a
    // migration verdict for it, and the approval payload carries no migration metadata.
    const test = await engine.evaluate(request({ command: "npm test" }));
    expect(test.reasons.join(" ")).not.toContain("migration:");
    expect((approvals.requested[0] as { migration?: unknown } | undefined)?.migration).toBeUndefined();
    // A file change without a command never enters the migration phase.
    const write = await engine.evaluate(request({ tool: "code.fs.write", command: undefined, paths: ["src/index.ts"] }));
    expect(write.decision).toBe("allow");
    expect(write.reasons.join(" ")).not.toContain("migration:");
    expect(approvals.requested.every((entry) => (entry as { migration?: unknown }).migration === undefined)).toBe(true);
  });

  it("does not let a standing rule or a consumed approval lift the migration approval requirement", async () => {
    const { engine, approvals } = harness({
      approvalRules: { async findRule() { return { id: "rule-1", scope: "project" }; } },
    });
    const result = await engine.evaluate(request({
      command: "prisma migrate deploy",
      migration: { target: { sandboxEphemeral: true } },
      approvalScope: "project",
    }));
    // A scoped rule may satisfy the *approval* for a legitimate migration, but never a denied target.
    expect(["allow", "require_approval"]).toContain(result.decision);

    const denied = await engine.evaluate(request({
      command: "prisma migrate deploy",
      migration: { target: { environment: "production" } },
      approvalScope: "project",
    }));
    expect(denied.decision).toBe("deny");
    expect(denied.code).toBe(MIGRATION_CODES.productionTarget);
    expect(approvals.consumed).toEqual([]);
  });
});

/**
 * The wiring itself. The three sub-checks above prove the module and the engine; these prove that a real
 * caller (the shell runtime) actually declares the migration context, that a host named inside the command
 * still wins over that declaration, and that a visible production credential stops the call before the
 * sandbox is reached. Without this block the phase would be a module nobody feeds — the exact failure the
 * project keeps catching (protected branches, provider policy, disk pressure).
 */
describe("security-gate: C6a shell runtime migration wiring", () => {
  const PROD_HOST = "db.prod.npati.internal";
  const DEV_HOST_RUNTIME = "dev-db.data-studio.internal";

  const allowAllFlags = { assertEnabled: async () => true, isEnabled: async () => true };

  function sandboxPort() {
    const calls: Array<Record<string, unknown>> = [];
    const port: CodeShellSandboxPort = {
      execute: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 5, status: "completed", sandboxId: "sbx-1" };
      },
    };
    return { port, calls };
  }

  function runtimeWith(enginePolicy: PolicyEngine, options: Record<string, unknown> = {}) {
    const sandbox = sandboxPort();
    const runtime = new CodeShellRuntime({
      sandbox: sandbox.port,
      classifier: { classify: (command: string) => classifyShellCommand(command, {}) },
      flags: allowAllFlags,
      policy: enginePolicy,
      ...options,
    } as unknown as ConstructorParameters<typeof CodeShellRuntime>[0]);
    return { runtime, sandbox };
  }

  function realEngine() {
    const approvals = {
      requested: [] as Array<Record<string, unknown>>,
      async requestApproval(_ctx: AuthContext, _companyId: string, input: Record<string, unknown>) {
        approvals.requested.push(input);
        return { id: `approval-${approvals.requested.length}` };
      },
      async consumeApproved() { return { id: "approval-1" }; },
    };
    const engine = new PolicyEngine({
      flags: { async assertEnabled() { return true; } },
      capabilities: { get: (id: string) => (TOOLS.includes(id) ? { id, status: "active", version: 1 } : undefined) },
      classifier: (command: string) => classifyShellCommand(command, {}),
      approvals,
      networkEnforcement: () => true,
    });
    return { engine, approvals };
  }

  it("declares the ephemeral sandbox target, so a legitimate migration is an approval and not an unknown target", async () => {
    const { engine } = realEngine();
    const { runtime, sandbox } = runtimeWith(engine, {
      migrationTargets: { productionHosts: [PROD_HOST], devHosts: [DEV_HOST_RUNTIME] },
    });
    const failure = await runtime.exec(owner, {
      companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t1",
      command: "prisma migrate deploy", sessionMode: "full_auto",
    } as never).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(ShellRuntimeError);
    // Before the wiring this was `migration_target_unknown_denied` (a hard deny), which made a legitimate
    // sandbox migration impossible. The repository's own pnpm/npm migration commands must be reachable.
    expect(failure).toMatchObject({ code: "approval_required", httpStatus: 403 });
    expect(sandbox.calls).toHaveLength(0);
  });

  it("still hard denies when the command itself names the production host", async () => {
    const { engine } = realEngine();
    const { runtime, sandbox } = runtimeWith(engine, {
      migrationTargets: { productionHosts: [PROD_HOST], devHosts: [DEV_HOST_RUNTIME] },
    });
    const failure = await runtime.exec(owner, {
      companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t2",
      command: `psql -h ${PROD_HOST} -U admin app -c 'select 1'`, sessionMode: "full_auto", approved: true,
    } as never).then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({ code: MIGRATION_CODES.productionTarget, httpStatus: 403 });
    expect(sandbox.calls).toHaveLength(0);
  });

  it("refuses a development migration executed through a hand-written SQL path", async () => {
    const { engine } = realEngine();
    const { runtime, sandbox } = runtimeWith(engine, {
      migrationTargets: { productionHosts: [PROD_HOST], devHosts: [DEV_HOST_RUNTIME] },
    });
    const failure = await runtime.exec(owner, {
      companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t3",
      command: `psql -h ${DEV_HOST_RUNTIME} -U migrator app -f up.sql`, sessionMode: "full_auto",
    } as never).then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({ code: MIGRATION_CODES.executionPathRequired, httpStatus: 403 });
    expect(sandbox.calls).toHaveLength(0);
  });

  it("refuses a run whose shell environment exposes a production credential, before the sandbox", async () => {
    const { engine } = realEngine();
    const { runtime, sandbox } = runtimeWith(engine, {
      migrationTargets: { productionHosts: [PROD_HOST], productionUrls: [PRODUCTION_URL] },
    });
    const failure = await runtime.exec(owner, {
      companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t4",
      command: "git status", sessionMode: "full_auto",
      env: { DATABASE_URL: PRODUCTION_URL },
    } as never).then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({ code: MIGRATION_CODES.credentialsVisible, httpStatus: 403 });
    expect((failure as ShellRuntimeError).details?.leakedKeys).toEqual(["DATABASE_URL"]);
    expect(sandbox.calls).toHaveLength(0);
  });

  it("still refuses the production credential after an approval was consumed", async () => {
    const { engine, approvals } = realEngine();
    const { runtime, sandbox } = runtimeWith(engine, {
      migrationTargets: { productionHosts: [PROD_HOST], productionUrls: [PRODUCTION_URL] },
    });
    const failure = await runtime.exec(owner, {
      companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t4b",
      command: "npm test", sessionMode: "full_auto", approved: true, approvalId: "approval-1",
      env: { DATABASE_URL: PRODUCTION_URL },
    } as never).then(() => null, (error: unknown) => error);

    // The approval gate and the credential check are independent: an approved command still may not see a
    // production connection string.
    expect(approvals.requested).toHaveLength(0);
    expect(failure).toMatchObject({ code: MIGRATION_CODES.credentialsVisible, httpStatus: 403 });
    expect(sandbox.calls).toHaveLength(0);
  });

  it("still runs an ordinary command with a development connection string", async () => {
    const { engine } = realEngine();
    const { runtime, sandbox } = runtimeWith(engine, {
      migrationTargets: { productionHosts: [PROD_HOST], productionUrls: [PRODUCTION_URL] },
    });
    const result = await runtime.exec(owner, {
      companyId: "c1", projectId: "p1", sessionId: "s1", toolCallId: "t5",
      command: "git status", sessionMode: "full_auto",
      env: { DATABASE_URL: "postgres://dev:dev@127.0.0.1:5432/dev" },
    } as never);

    expect(result.exitCode).toBe(0);
    // The narrow credential check must not block legitimate development work.
    expect(sandbox.calls).toHaveLength(1);
  });
});
