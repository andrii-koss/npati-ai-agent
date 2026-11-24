/**
 * Secrets that ship in this repository (compose defaults, development fallbacks, test fixtures) are public. A
 * production process must never accept one of them, whatever `NPATI_ENV` says: the main compose file runs every
 * service with `NODE_ENV=production` while `NPATI_ENV` defaults to `development`, so a check keyed on `NPATI_ENV`
 * alone let a fresh installation run on keys anyone can read (security audit 2026-11-24, finding C1).
 *
 * "Production" therefore means `NODE_ENV=production` OR `NPATI_ENV=production`.
 */
// The deny-list lives in crypto-vault.ts (that module may import nothing but node:crypto) and is reused here.
import { isInsecureDefaultSecret, isProductionEnvironment } from "./crypto-vault";

interface SecretRule {
  name: string;
  /** Required in production (absent = refusal). Optional secrets are only checked when set. */
  required?: boolean;
  /** Minimum length when set. */
  minLength?: number;
}

/**
 * The secrets a production API / worker process checks at startup. `NPATI_ENCRYPTION_KEY_PREVIOUS` is deliberately
 * absent: it is a decrypt-only key used while migrating data off a leaked key, so it may be exactly such a default.
 */
export const PRODUCTION_SECRET_RULES: readonly SecretRule[] = [
  { name: "NPATI_ENCRYPTION_KEY", required: true, minLength: 32 },
  { name: "NPATI_REMOTE_ACCESS_TOKEN_SECRET", minLength: 32 },
  { name: "NPATI_JWT_SECRET", minLength: 32 },
  { name: "NPATI_PREVIEW_SECRET", minLength: 32 },
  { name: "NPATI_AUDIT_ANCHOR_KEY", minLength: 32 },
  { name: "NPATI_SANDBOX_RUNNER_SECRET", minLength: 32 },
  { name: "NPATI_BROWSER_INTERNAL_TOKEN", minLength: 32 },
  { name: "NPATI_PRODUCTION_TOKEN", minLength: 32 },
  { name: "CRAWL4AI_API_TOKEN", minLength: 24 },
  { name: "OMNIROUTE_API_KEY", minLength: 24 },
  { name: "OMNIROUTE_MANAGEMENT_PASSWORD", minLength: 16 },
  { name: "MINIO_SECRET_KEY", minLength: 16 },
  { name: "NPATI_PROJECTS_POSTGRES_ADMIN_PASSWORD", minLength: 16 },
  { name: "OIDC_SHARED_SECRET", minLength: 32 },
];

function databaseUrlPassword(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.password ? decodeURIComponent(parsed.password) : undefined;
  } catch {
    return undefined;
  }
}

/** Every problem with the production secrets in `env`, as `NAME: reason` (never the value). Empty when fine. */
export function insecureProductionSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isProductionEnvironment(env)) return [];
  const problems: string[] = [];
  for (const rule of PRODUCTION_SECRET_RULES) {
    const value = env[rule.name]?.trim();
    if (!value) {
      if (rule.required) problems.push(`${rule.name}: required in production`);
      continue;
    }
    if (isInsecureDefaultSecret(value)) problems.push(`${rule.name}: publicly known default value`);
    else if (rule.minLength && value.length < rule.minLength) problems.push(`${rule.name}: shorter than ${rule.minLength} characters`);
  }
  for (const name of ["DATABASE_URL", "REDIS_URL"]) {
    const password = databaseUrlPassword(env[name]);
    if (password && isInsecureDefaultSecret(password)) problems.push(`${name}: password is a publicly known default`);
  }
  return problems;
}

export class InsecureSecretsError extends Error {
  constructor(readonly problems: string[]) {
    super(`NPATI_INSECURE_SECRETS: refusing to start with unsafe production secrets — ${problems.join("; ")}`);
    this.name = "InsecureSecretsError";
  }
}

/** Startup gate for production processes. Throws before any listener or worker starts. */
export function assertProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const problems = insecureProductionSecrets(env);
  if (problems.length) throw new InsecureSecretsError(problems);
}
