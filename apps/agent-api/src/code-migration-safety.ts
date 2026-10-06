/**
 * C6a — database migration safety.
 *
 * The agent may write migration *files* like any other code change, but actually *running* a migration is
 * a privileged operation: it mutates a schema that may hold real data and it is frequently irreversible.
 * This module is the single place that decides
 *
 *   1. whether a shell command is a migration action at all (`detectMigrationAction`),
 *   2. which database the command would touch (`resolveMigrationTarget`),
 *   3. whether the migration code in the diff is destructive or has a rollback plan
 *      (`analyzeMigrationDiff`),
 *   4. whether a project script runs a migration behind the user's back (`detectHiddenMigrations`),
 *   5. whether production credentials are even visible to the agent
 *      (`assertNoProductionCredentialsVisible`),
 *
 * and combines them into one verdict (`evaluateMigrationSafety`) that the PolicyEngine applies in a
 * dedicated phase. Execution against a dev DataBackend is only sanctioned through the **existing** Data
 * Studio engine (`applyMigrationThroughDataStudio`) — this module never issues SQL itself.
 *
 * Fail-closed rules that must not be relaxed:
 *   - production, external and *unknown* targets are **hard denied**;
 *   - a destructive migration always requires a snapshot, in addition to an approval;
 *   - a migration is never an implicit allow, in any session mode;
 *   - the agent never receives a production `DATABASE_URL`.
 */

/** Migration runners and direct SQL clients the Coding Agent can be asked to run. */
export type MigrationRunnerTool =
  | "prisma"
  | "drizzle"
  | "alembic"
  | "django"
  | "rails"
  | "artisan"
  | "knex"
  | "typeorm"
  | "sequelize"
  | "flyway"
  | "liquibase"
  | "goose"
  | "sqlx"
  | "dbmate"
  | "psql"
  | "mysql"
  | "sqlite3"
  | "script";

export type MigrationAction = "apply" | "rollback" | "reset" | "status" | "execute_sql";

export interface MigrationActionHint {
  tool: MigrationRunnerTool;
  action: MigrationAction;
  /** The command itself destroys data or drops objects (reset/clean/–force-reset/DROP/TRUNCATE). */
  destructive: boolean;
  /** `psql`/`mysql`/`sqlite3` reaching a non-local database. */
  directSqlClient: boolean;
  /** True for a `npm|yarn|pnpm|make` script name that looks like a migration entry point. */
  scriptInvocation: boolean;
  codes: string[];
  /** A read-only command that would print the plan, when the tool supports one. Never executed here. */
  planCommand?: string;
}

export type MigrationTargetKind = "ephemeral_sandbox" | "dev_data_backend" | "production" | "external" | "unknown";

export interface MigrationTargetInput {
  /** Connection string seen in the environment / tool arguments. */
  databaseUrl?: string | null;
  host?: string | null;
  environment?: string | null;
  /** Known production connection strings (compared by host). */
  productionUrls?: string[];
  productionHosts?: string[];
  /** Hosts that are known development DataBackends. */
  devHosts?: string[];
  /** True when the command runs inside the ephemeral sandbox database only. */
  sandboxEphemeral?: boolean;
  /** True when the caller routes the migration through the Data Studio migration engine. */
  dataStudioBackend?: boolean;
}

export interface MigrationTargetResolution {
  kind: MigrationTargetKind;
  host?: string;
  source: string;
  reasonCode: string;
}

export interface MigrationDiffFile {
  path: string;
  content: string;
}

export interface MigrationDiffFinding {
  path: string;
  kind: string;
  detail: string;
}

export interface MigrationDiffAnalysis {
  /** True when at least one destructive statement was found. */
  destructive: boolean;
  findings: MigrationDiffFinding[];
  /** A destructive migration must be preceded by a snapshot. */
  requiresSnapshot: boolean;
  /** A down migration / rollback section is present. */
  hasRollbackPlan: boolean;
  /** Files that look like migration files at all. */
  migrationFiles: string[];
}

export interface HiddenMigrationFinding {
  path: string;
  script: string;
  command: string;
  reasonCode: string;
}

export type MigrationDecision = "allow" | "require_approval" | "deny";

export interface MigrationSafetyVerdict {
  decision: MigrationDecision;
  code: string;
  reason: string;
  target: MigrationTargetKind;
  destructive: boolean;
  requiresSnapshot: boolean;
  executionPath: "ephemeral_sandbox" | "data_studio_engine" | "denied";
  codes: string[];
  planCommand?: string;
  hiddenScripts: HiddenMigrationFinding[];
}

export const MIGRATION_CODES = {
  productionTarget: "migration_target_production_denied",
  externalTarget: "migration_target_external_denied",
  unknownTarget: "migration_target_unknown_denied",
  executionPathRequired: "migration_execution_path_required",
  destructive: "migration_destructive_requires_snapshot",
  hidden: "hidden_migration_requires_approval",
  noRollbackPlan: "migration_without_rollback_plan",
  requiresApproval: "migration_requires_approval",
  credentialsVisible: "production_credentials_visible_denied",
} as const;

/** Script names that run migrations indirectly (package.json, Makefile, entrypoints). */
const HIDDEN_MIGRATION_SCRIPT_NAMES = /(?:^|[-_:])(?:migrat|db[-_:]?(?:push|migrate|reset)|schema[-_:]?(?:push|sync|update)|deploy|release|prestart|postinstall|prepare|start|dev|test)(?:$|[-_:])/i;

const SQL_DESTRUCTIVE = /\b(?:drop\s+(?:table|column|schema|database|index|constraint|type|view|materialized\s+view)|truncate\s+(?:table\s+)?[A-Za-z_"'`[])/i;

/** `DELETE FROM x` without a `WHERE` in the same statement. */
function hasUnboundedDelete(sql: string): boolean {
  for (const statement of sql.split(";")) {
    if (!/\bdelete\s+from\b/i.test(statement)) continue;
    if (!/\bwhere\b/i.test(statement)) return true;
  }
  return false;
}

const MIGRATION_FILE = /(?:^|\/)(?:migrations?|migrate|schema|drizzle|prisma)(?:\/|$)|(?:^|\/)\d{8,}[_-]|\.(?:sql|up\.sql)$|migration\.(?:ts|js|py|rb|php|go|rs)$/i;

const ROLLBACK_MARKERS = [
  /\bdown_sql\b/i, /\bdownsql\b/i, /\bdef\s+down\b/, /^\s*--\s*down\b/im, /\bdowngrade\b/i,
  /\bdown\s*[:(=]/i, /\bexport\s+(?:async\s+)?function\s+down\b/, /\bpublic\s+function\s+down\b/,
  /\bfunction\s+down\b/, /\brevert\b/i, /\brollback\b/i, /\bdrop_?(?:table|column)\b.{0,200}$/im,
];

const DESTRUCTIVE_CODE_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  // Raw SQL first, with a precise kind per statement so a reviewer sees *what* is destroyed.
  { kind: "drop_table", pattern: /\bdrop\s+table\b/i },
  { kind: "drop_column", pattern: /\bdrop\s+column\b/i },
  { kind: "drop_object", pattern: /\bdrop\s+(?:schema|database|index|constraint|type|view|materialized\s+view|sequence|trigger|function)\b/i },
  { kind: "truncate", pattern: /\btruncate\s+(?:table\s+)?["'`[]?[A-Za-z_]/i },
  // Then the ORM/migration-framework code forms.
  { kind: "drop_table", pattern: /\b(?:dropTable|drop_table|op\.drop_table|DeleteModel|dropIfExists)\b/ },
  { kind: "drop_column", pattern: /\b(?:dropColumn|drop_column|op\.drop_column|remove_column|RemoveField)\b/ },
  { kind: "rename_column", pattern: /\b(?:renameColumn|rename_column|sp_rename)\b/ },
  { kind: "alter_column_type", pattern: /\b(?:alterColumn|alter_column|change_column|modify_column|AlterField|setDataType)\b/ },
  { kind: "drop_constraint", pattern: /\b(?:dropConstraint|drop_constraint|op\.drop_constraint|dropIndex|drop_index|op\.drop_index)\b/ },
];

/**
 * True when `host` points at the machine the sandbox itself runs on. A `psql` against a local database is
 * ordinary development work, not a migration against somebody's data.
 */
function isLocalHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "" || value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "0.0.0.0") return true;
  if (value.startsWith("/")) return true; // unix socket path
  if (value.endsWith(".localhost")) return true;
  return false;
}

function hostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(url.trim());
  if (match?.[1]) return match[1];
  return null;
}

function tokeniseSegments(command: string): string[][] {
  return command
    .split(/&&|\|\||;|\n|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? []);
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] ?? value;
}

function valueForFlag(args: string[], flags: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    for (const flag of flags) {
      if (arg === flag) return args[index + 1] ?? null;
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    }
  }
  return null;
}

function planCommandFor(tool: MigrationRunnerTool, action: MigrationAction): string | undefined {
  if (action !== "apply") return undefined;
  switch (tool) {
    case "prisma": return "prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --script";
    case "alembic": return "alembic upgrade head --sql";
    case "django": return "python manage.py sqlmigrate <app> <migration>";
    case "rails": return "rails db:migrate:status";
    case "knex": return "knex migrate:list";
    case "typeorm": return "typeorm migration:show";
    case "goose": return "goose status";
    case "sqlx": return "sqlx migrate info";
    case "dbmate": return "dbmate status";
    default: return undefined;
  }
}

/**
 * Recognises a migration action in a shell command. Returns `undefined` for everything else, including a
 * local `psql`/`sqlite3` session and commands that merely *write* a migration file.
 */
export function detectMigrationAction(command: string): MigrationActionHint | undefined {
  if (!command || typeof command !== "string") return undefined;
  for (const argv of tokeniseSegments(command)) {
    const executable = basename(argv[0] ?? "");
    if (!executable) continue;
    const args = argv.slice(1);
    const argsText = ` ${args.join(" ")} `;

    if (executable === "prisma" || (executable === "npx" && basename(args[0] ?? "") === "prisma")) {
      const shift = executable === "npx" ? 1 : 0;
      const sub = args.slice(shift);
      const joined = sub.join(" ");
      if (/^migrate\s+reset\b/.test(joined)) return hint("prisma", "reset", true, false, false, ["prisma_migrate_reset"]);
      if (/^db\s+push\b/.test(joined)) {
        const destructive = /--force-reset|--accept-data-loss/.test(joined);
        return hint("prisma", "apply", destructive, false, false, destructive ? ["prisma_db_push_force"] : ["prisma_db_push"]);
      }
      if (/^db\s+execute\b/.test(joined)) return hint("prisma", "execute_sql", SQL_DESTRUCTIVE.test(joined) || hasUnboundedDelete(joined), false, false, ["prisma_db_execute"]);
      if (/^migrate\s+(?:deploy|dev)\b/.test(joined)) return hint("prisma", "apply", false, false, false, ["prisma_migrate"]);
      if (/^migrate\s+status\b/.test(joined)) return hint("prisma", "status", false, false, false, ["prisma_migrate_status"]);
      continue;
    }
    if (executable === "drizzle-kit" || (executable === "npx" && basename(args[0] ?? "") === "drizzle-kit")) {
      const joined = args.join(" ");
      if (/\bpush\b/.test(joined)) return hint("drizzle", "apply", /\b--force\b/.test(joined), false, false, ["drizzle_push"]);
      if (/\bmigrate\b/.test(joined)) return hint("drizzle", "apply", false, false, false, ["drizzle_migrate"]);
      if (/\bdrop\b/.test(joined)) return hint("drizzle", "reset", true, false, false, ["drizzle_drop"]);
      continue;
    }
    if (executable === "alembic") {
      if (args[0] === "upgrade") return hint("alembic", "apply", false, false, false, ["alembic_upgrade"]);
      if (args[0] === "downgrade") {
        const target = args[1] ?? "";
        // Downgrading to `base` removes every revision: that destroys data even though it is a "rollback".
        const destructive = /^base$/i.test(target);
        return hint("alembic", "rollback", destructive, false, false, ["alembic_downgrade"]);
      }
      if (args[0] === "history" || args[0] === "current") return hint("alembic", "status", false, false, false, ["alembic_status"]);
      continue;
    }
    if (executable === "python" || executable === "python3") {
      const manageIndex = args.findIndex((value) => basename(value) === "manage.py");
      if (manageIndex >= 0) {
        const rest = args.slice(manageIndex + 1);
        if (rest[0] === "migrate") return hint("django", "apply", false, false, false, ["django_migrate"]);
        if (rest[0] === "flush" || rest[0] === "sqlflush") return hint("django", "reset", true, false, false, ["django_flush"]);
        if (rest[0] === "showmigrations" || rest[0] === "sqlmigrate") return hint("django", "status", false, false, false, ["django_status"]);
      }
      continue;
    }
    if (executable === "rails" || executable === "rake" || executable === "bundle") {
      const joined = args.join(" ");
      if (/\bdb:migrate\b/.test(joined)) return hint("rails", "apply", false, false, false, ["rails_db_migrate"]);
      if (/\bdb:(?:drop|reset|rollback)\b/.test(joined)) {
        return hint("rails", /\bdb:rollback\b/.test(joined) ? "rollback" : "reset", true, false, false, ["rails_db_destructive"]);
      }
      continue;
    }
    if (executable === "php" || executable === "artisan") {
      const joined = args.join(" ");
      if (/artisan\s+migrate\b/.test(joined) || (executable === "artisan" && args[0] === "migrate")) {
        const destructive = /migrate:(?:fresh|reset|refresh)\b/.test(joined);
        return hint("artisan", destructive ? "reset" : "apply", destructive, false, false, ["artisan_migrate"]);
      }
      continue;
    }
    if (executable === "knex") {
      if (/migrate:(?:latest|up)/.test(argsText)) return hint("knex", "apply", false, false, false, ["knex_migrate"]);
      if (/migrate:(?:rollback|down)/.test(argsText)) return hint("knex", "rollback", false, false, false, ["knex_rollback"]);
      continue;
    }
    if (executable === "typeorm") {
      if (/migration:run/.test(argsText)) return hint("typeorm", "apply", false, false, false, ["typeorm_run"]);
      if (/migration:revert/.test(argsText)) return hint("typeorm", "rollback", false, false, false, ["typeorm_revert"]);
      if (/schema:drop/.test(argsText)) return hint("typeorm", "reset", true, false, false, ["typeorm_schema_drop"]);
      continue;
    }
    if (executable === "sequelize" || (executable === "npx" && basename(args[0] ?? "") === "sequelize")) {
      if (/db:migrate:undo/.test(argsText)) return hint("sequelize", "rollback", false, false, false, ["sequelize_undo"]);
      if (/db:migrate/.test(argsText)) return hint("sequelize", "apply", false, false, false, ["sequelize_migrate"]);
      if (/db:drop/.test(argsText)) return hint("sequelize", "reset", true, false, false, ["sequelize_drop"]);
      continue;
    }
    if (executable === "flyway") {
      if (/\bclean\b/.test(argsText)) return hint("flyway", "reset", true, false, false, ["flyway_clean"]);
      if (/\b(?:migrate|update)\b/.test(argsText)) return hint("flyway", "apply", false, false, false, ["flyway_migrate"]);
      if (/\bundo\b/.test(argsText)) return hint("flyway", "rollback", false, false, false, ["flyway_undo"]);
      continue;
    }
    if (executable === "liquibase") {
      if (/drop-all/.test(argsText)) return hint("liquibase", "reset", true, false, false, ["liquibase_drop_all"]);
      if (/\bupdate\b/.test(argsText)) return hint("liquibase", "apply", false, false, false, ["liquibase_update"]);
      if (/\brollback\b/.test(argsText)) return hint("liquibase", "rollback", false, false, false, ["liquibase_rollback"]);
      continue;
    }
    if (executable === "goose") {
      if (/\breset\b/.test(argsText)) return hint("goose", "reset", true, false, false, ["goose_reset"]);
      if (/\bup\b/.test(argsText)) return hint("goose", "apply", false, false, false, ["goose_up"]);
      if (/\bdown\b/.test(argsText)) return hint("goose", "rollback", false, false, false, ["goose_down"]);
      continue;
    }
    if (executable === "sqlx") {
      if (/database\s+drop/.test(argsText)) return hint("sqlx", "reset", true, false, false, ["sqlx_database_drop"]);
      if (/migrate\s+run/.test(argsText)) return hint("sqlx", "apply", false, false, false, ["sqlx_migrate_run"]);
      if (/migrate\s+revert/.test(argsText)) return hint("sqlx", "rollback", false, false, false, ["sqlx_migrate_revert"]);
      continue;
    }
    if (executable === "dbmate") {
      if (/\bdrop\b/.test(argsText)) return hint("dbmate", "reset", true, false, false, ["dbmate_drop"]);
      if (/\bup\b/.test(argsText)) return hint("dbmate", "apply", false, false, false, ["dbmate_up"]);
      if (/\bdown\b/.test(argsText)) return hint("dbmate", "rollback", false, false, false, ["dbmate_down"]);
      continue;
    }
    if (executable === "psql" || executable === "mysql" || executable === "mysqladmin") {
      const host = valueForFlag(args, ["-h", "--host"]) ?? hostFromUrl(args.find((value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value)));
      // A local database is ordinary development work: it is not a migration action, and existing
      // behaviour for a local `psql` must not change.
      if (isLocalHost(host)) continue;
      const inline = valueForFlag(args, ["-c", "--command"]) ?? (args.find((value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) ? args.join(" ") : null);
      const destructive = inline !== null && (SQL_DESTRUCTIVE.test(inline) || hasUnboundedDelete(inline));
      return hint(executable === "psql" ? "psql" : "mysql", "execute_sql", destructive, true, false, ["direct_sql_client"]);
    }
    if (executable === "sqlite3") {
      const target = args.find((value) => !value.startsWith("-"));
      // `sqlite3 ./dev.db` is a local file: not a migration action.
      if (!target || !/^(?:[a-z][a-z0-9+.-]*:\/\/)/i.test(target)) continue;
      return hint("sqlite3", "execute_sql", false, true, false, ["direct_sql_client"]);
    }
    if (executable === "npm" || executable === "pnpm" || executable === "yarn" || executable === "make" || executable === "sh" || executable === "bash") {
      const script = args.find((value) => !value.startsWith("-"));
      if (!script) continue;
      if (executable === "make" && /migrat|db[-_:.]?(?:push|update|deploy)/i.test(script)) {
        return hint("script", "apply", false, false, true, ["make_migration_target"]);
      }
      if (executable === "sh" || executable === "bash") continue;
      if (HIDDEN_MIGRATION_SCRIPT_NAMES.test(script) && /migrat|db[-_:]?(?:push|migrate|reset)|schema[-_:]?(?:push|sync|update)/i.test(script)) {
        return hint("script", "apply", false, false, true, ["script_migration"]);
      }
    }
  }
  return undefined;
}

function hint(
  tool: MigrationRunnerTool,
  action: MigrationAction,
  destructive: boolean,
  directSqlClient: boolean,
  scriptInvocation: boolean,
  codes: string[],
): MigrationActionHint {
  const result: MigrationActionHint = { tool, action, destructive, directSqlClient, scriptInvocation, codes };
  const plan = planCommandFor(tool, action);
  if (plan) result.planCommand = plan;
  return result;
}

/**
 * Extracts the host/URL a migration command names on its own. This takes precedence over any target the
 * caller declares: a command such as `psql -h db.prod.internal` must be judged by that host even when the
 * call itself runs inside the ephemeral sandbox. Without this, "we are in the sandbox" would mask a
 * production host written into the command.
 */
export function inferMigrationTargetFromCommand(command: string): { host?: string; url?: string } | null {
  if (!command) return null;
  const runners = new Set([
    "psql", "mysql", "mysqladmin", "sqlite3", "prisma", "drizzle-kit", "alembic", "rails", "rake", "artisan",
    "knex", "typeorm", "sequelize", "flyway", "liquibase", "goose", "sqlx", "dbmate", "python", "python3", "npx",
  ]);
  for (const argv of tokeniseSegments(command)) {
    if (!argv.length) continue;
    const executable = basename(argv[0] ?? "");
    const args = argv.slice(1);
    if (!runners.has(executable) && !runners.has(basename(args[0] ?? ""))) continue;
    const url = args.find((value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^file:/i.test(value));
    if (url) return { url };
    const host = valueForFlag(args, ["-h", "--host"]);
    if (host) return { host };
    const urlFlag = valueForFlag(args, ["--database-url", "--db-url", "--url", "--dsn", "--connection-string"]);
    if (urlFlag) return /^[a-z][a-z0-9+.-]*:\/\//i.test(urlFlag) ? { url: urlFlag } : { host: urlFlag };
  }
  return null;
}

/**
 * Decides which database a migration would touch. Production, external and unknown targets are refused by
 * `evaluateMigrationSafety`; this function only classifies, using the host — never the variable name.
 */
export function resolveMigrationTarget(input: MigrationTargetInput): MigrationTargetResolution {
  const url = input.databaseUrl ?? null;
  const host = input.host ?? hostFromUrl(url) ?? null;
  const environment = (input.environment ?? "").trim().toLowerCase();
  const productionHosts = (input.productionHosts ?? []).map((value) => value.trim().toLowerCase());
  for (const value of input.productionUrls ?? []) {
    const productionHost = hostFromUrl(value) ?? value.trim().toLowerCase();
    if (productionHost) productionHosts.push(productionHost.toLowerCase());
  }
  const normalisedHost = (host ?? "").trim().toLowerCase();

  if (environment === "production" || environment === "prod") {
    return { kind: "production", ...(host ? { host } : {}), source: "environment", reasonCode: "environment_production" };
  }
  if (normalisedHost && productionHosts.includes(normalisedHost)) {
    return { kind: "production", host: normalisedHost, source: "host", reasonCode: "host_production" };
  }
  if (input.sandboxEphemeral === true || isLocalHost(normalisedHost)) {
    return { kind: "ephemeral_sandbox", ...(host ? { host } : {}), source: input.sandboxEphemeral === true ? "sandbox" : "host", reasonCode: "host_local" };
  }
  const devHosts = (input.devHosts ?? []).map((value) => value.trim().toLowerCase());
  if (input.dataStudioBackend === true && environment !== "production" && environment !== "prod") {
    return { kind: "dev_data_backend", ...(host ? { host } : {}), source: "data_studio", reasonCode: "data_studio_backend" };
  }
  if (normalisedHost && devHosts.includes(normalisedHost)) {
    return { kind: "dev_data_backend", host: normalisedHost, source: "host", reasonCode: "host_dev" };
  }
  if (!normalisedHost && !url) {
    return { kind: "unknown", source: "none", reasonCode: "target_unknown" };
  }
  return { kind: "external", ...(host ? { host } : {}), source: "host", reasonCode: "host_not_allowlisted" };
}

/** Static analysis of the migration code in a diff. Nothing is executed here. */
export function analyzeMigrationDiff(files: MigrationDiffFile[]): MigrationDiffAnalysis {
  const findings: MigrationDiffFinding[] = [];
  const migrationFiles: string[] = [];
  let destructive = false;
  let hasRollbackPlan = false;

  for (const file of files ?? []) {
    const path = file.path ?? "";
    const content = file.content ?? "";
    const isMigrationFile = MIGRATION_FILE.test(path);
    if (isMigrationFile) migrationFiles.push(path);
    const seen = new Set<string>();
    for (const { kind, pattern } of DESTRUCTIVE_CODE_PATTERNS) {
      if (!pattern.test(content)) continue;
      // One finding per kind and file: the same statement must not be reported twice.
      if (seen.has(kind)) continue;
      seen.add(kind);
      destructive = true;
      findings.push({ path, kind, detail: `destructive pattern ${kind}` });
    }
    if (isMigrationFile && hasUnboundedDelete(content) && !seen.has("unbounded_delete")) {
      destructive = true;
      findings.push({ path, kind: "unbounded_delete", detail: "DELETE without WHERE" });
    }
    if (isMigrationFile && ROLLBACK_MARKERS.some((marker) => marker.test(content))) hasRollbackPlan = true;
  }
  return { destructive, findings, requiresSnapshot: destructive, hasRollbackPlan, migrationFiles };
}

/**
 * Finds migrations that would run as a side effect of a script nobody reviews: `prestart`, `dev`, `test`,
 * `postinstall`, Makefile targets and container entrypoints.
 */
export function detectHiddenMigrations(files: MigrationDiffFile[]): HiddenMigrationFinding[] {
  const findings: HiddenMigrationFinding[] = [];
  for (const file of files ?? []) {
    const path = file.path ?? "";
    const content = file.content ?? "";
    if (/(?:^|\/)package\.json$/.test(path)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        continue;
      }
      const scripts = (parsed as { scripts?: Record<string, unknown> }).scripts ?? {};
      for (const [script, body] of Object.entries(scripts)) {
        if (typeof body !== "string") continue;
        const action = detectMigrationAction(body);
        if (!action) continue;
        if (!HIDDEN_MIGRATION_SCRIPT_NAMES.test(script) && !/migrat/i.test(script)) continue;
        findings.push({ path, script, command: body, reasonCode: "hidden_migration_script" });
      }
      continue;
    }
    if (/(?:^|\/)(?:Makefile|makefile)$/.test(path) || /\.(?:sh|bash)$/.test(path) || /docker-entrypoint/.test(path)) {
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const action = detectMigrationAction(trimmed);
        if (!action) continue;
        const script = /(?:^|\/)(?:Makefile|makefile)$/.test(path)
          ? (trimmed.split(":")[0] ?? "").trim()
          : basename(path);
        findings.push({ path, script, command: trimmed, reasonCode: "hidden_migration_script" });
      }
    }
  }
  return findings;
}

/**
 * The agent must never see a production connection string. A leaked production URL is not a warning: the
 * caller refuses the run.
 */
export function assertNoProductionCredentialsVisible(input: {
  agentEnv?: Record<string, string | undefined> | null;
  productionUrls?: string[];
  productionSecretKeys?: string[];
}): { safe: boolean; leakedKeys: string[]; code?: string } {
  const env = input.agentEnv ?? {};
  const productionHosts = new Set<string>();
  for (const value of input.productionUrls ?? []) {
    const host = hostFromUrl(value);
    if (host) productionHosts.add(host.toLowerCase());
    else if (value) productionHosts.add(value.trim().toLowerCase());
  }
  const productionKeys = new Set((input.productionSecretKeys ?? []).map((key) => key.trim()));
  const leakedKeys: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue;
    if (productionKeys.has(key)) { leakedKeys.push(key); continue; }
    const host = hostFromUrl(value);
    if (host && productionHosts.has(host.toLowerCase())) leakedKeys.push(key);
  }
  if (!leakedKeys.length) return { safe: true, leakedKeys: [] };
  return { safe: false, leakedKeys, code: MIGRATION_CODES.credentialsVisible };
}

/**
 * The single migration verdict. Returns `undefined` when nothing in the request is a migration action, so
 * every other command keeps its existing treatment.
 */
export function evaluateMigrationSafety(input: {
  command?: string | undefined;
  hint?: MigrationActionHint | null;
  target?: MigrationTargetResolution | null;
  files?: MigrationDiffFile[];
  dataStudioEngine?: boolean;
  rollbackPlan?: boolean;
  sandboxEphemeral?: boolean;
  hiddenMigrations?: HiddenMigrationFinding[];
}): MigrationSafetyVerdict | undefined {
  const hint = input.hint ?? (input.command ? detectMigrationAction(input.command) : undefined);
  const analysis = analyzeMigrationDiff(input.files ?? []);
  const hiddenScripts = input.hiddenMigrations ?? detectHiddenMigrations(input.files ?? []);
  if (!hint && !analysis.destructive && hiddenScripts.length === 0) return undefined;

  const target: MigrationTargetResolution = input.target
    ?? (input.sandboxEphemeral === true
      ? { kind: "ephemeral_sandbox", source: "sandbox", reasonCode: "host_local" }
      : { kind: "unknown", source: "none", reasonCode: "target_unknown" });

  const codes: string[] = [...(hint?.codes ?? [])];
  const destructive = hint?.destructive === true || analysis.destructive;
  const planCommand = hint?.planCommand;

  const base = {
    target: target.kind,
    destructive,
    requiresSnapshot: destructive,
    codes,
    hiddenScripts,
    ...(planCommand ? { planCommand } : {}),
  } as const;

  // 1. Target first: nothing about the migration content can make a production target acceptable.
  if (target.kind === "production") {
    return { ...base, decision: "deny", code: MIGRATION_CODES.productionTarget, executionPath: "denied",
      reason: "Running a migration against production is never allowed for the agent; use the promote/deploy flow with an approval" };
  }
  if (target.kind === "external") {
    return { ...base, decision: "deny", code: MIGRATION_CODES.externalTarget, executionPath: "denied",
      reason: "The migration target is an external database that is not a known development DataBackend" };
  }
  if (target.kind === "unknown") {
    return { ...base, decision: "deny", code: MIGRATION_CODES.unknownTarget, executionPath: "denied",
      reason: "The migration target could not be identified, so the migration is refused" };
  }
  // 2. A dev DataBackend is only reachable through the Data Studio migration engine (lock, checksum,
  //    snapshot-before-destructive, history): never with a hand-written SQL path.
  if (target.kind === "dev_data_backend" && input.dataStudioEngine !== true) {
    return { ...base, decision: "deny", code: MIGRATION_CODES.executionPathRequired, executionPath: "denied",
      reason: "Development migrations must go through the Data Studio migration engine (advisory lock, checksum, snapshot, history)" };
  }

  const executionPath: MigrationSafetyVerdict["executionPath"] =
    target.kind === "dev_data_backend" ? "data_studio_engine" : "ephemeral_sandbox";

  // 3. Destructive work needs a snapshot, on top of the approval.
  if (destructive) {
    codes.push("destructive");
    return { ...base, decision: "require_approval", code: MIGRATION_CODES.destructive, executionPath,
      requiresSnapshot: true,
      reason: "This migration drops or rewrites data and requires an approval with a snapshot of the target database" };
  }
  // 4. A script that hides a migration behind another command is still a migration.
  if (hiddenScripts.length > 0) {
    codes.push("hidden_script");
    return { ...base, decision: "require_approval", code: MIGRATION_CODES.hidden, executionPath,
      reason: "A project script runs a migration implicitly and requires an explicit approval" };
  }
  // 5. An applied migration with no rollback plan is only acceptable with a human decision.
  if (hint?.action === "apply" && !analysis.hasRollbackPlan && input.rollbackPlan !== true) {
    codes.push("no_rollback_plan");
    return { ...base, decision: "require_approval", code: MIGRATION_CODES.noRollbackPlan, executionPath,
      reason: "The migration has no down migration or documented rollback plan" };
  }
  // 6. Everything else: a migration is an approval class, never an implicit allow.
  return { ...base, decision: "require_approval", code: MIGRATION_CODES.requiresApproval, executionPath,
    reason: "Running a database migration requires an approval" };
}

/**
 * Structural port of the **existing** Data Studio migration engine
 * (`data-studio/migration-engine.ts` → `ProjectMigrationEngine.dryRun/apply`). Method syntax keeps the
 * parameters bivariant, so the real engine satisfies it without a cast.
 */
export interface MigrationEnginePort {
  dryRun(request: unknown): Promise<unknown>;
  apply(ctx: unknown, request: unknown): Promise<unknown>;
}

/**
 * The only sanctioned way to run a development migration. It calls the Data Studio engine — which performs
 * the tenant check, the drift check, the migration lock, the checksum, the snapshot for destructive work
 * and the transaction/rollback — instead of issuing SQL directly.
 */
export async function applyMigrationThroughDataStudio(
  engine: MigrationEnginePort,
  ctx: unknown,
  request: unknown,
  options: { dryRunFirst?: boolean; verdict?: MigrationSafetyVerdict | null } = {},
): Promise<unknown> {
  // A refused verdict must never reach the database, not even the read-only dry run.
  if (options.verdict && options.verdict.decision === "deny") {
    throw Object.assign(new Error(options.verdict.reason), {
      code: options.verdict.code,
      decision: "deny" as const,
      target: options.verdict.target,
    });
  }
  if (options.dryRunFirst !== false) await engine.dryRun(request);
  return engine.apply(ctx, request);
}
