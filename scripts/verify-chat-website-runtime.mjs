/** Executes the audited chat drill against the existing local shared runner, with a scripted model.
 * Supply an administrator DATABASE_URL for disposable databases. No user database or project is edited.
 */
import { execFileSync, spawnSync } from "node:child_process";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for disposable test databases");
// A host-run API drill must not mask a missing dependency in the deployed images.
for (const container of ["npati-agent-api", "npati-agent-company-worker"]) {
  execFileSync("docker", ["exec", container, "git", "--version"], { stdio: "pipe" });
}
const configuration = JSON.parse(execFileSync("docker", ["inspect", "npati-agent-api"], { encoding: "utf8" }))[0];
const env = { ...process.env, NPATI_SECURITY_GATE_DB: "1", NPATI_CHAT_WEBSITE_LIVE_SANDBOX: "1", NPATI_PROJECT_RUNTIME_MODE: "shared", NPATI_SANDBOX_RUNNER_MODE: "remote", NPATI_SANDBOX_RUNNER_URL: "http://127.0.0.1:7865" };
// Project databases use the same disposable PostgreSQL server as this drill's workspace.
// Never point this drill at the installation's postgres-projects database.
const database = new URL(process.env.DATABASE_URL);
env.NPATI_PROJECTS_POSTGRES_HOST = database.hostname;
env.NPATI_PROJECTS_POSTGRES_PORT = database.port || "5432";
env.NPATI_PROJECTS_POSTGRES_ADMIN_USER = decodeURIComponent(database.username);
env.NPATI_PROJECTS_POSTGRES_ADMIN_PASSWORD = decodeURIComponent(database.password);
env.NPATI_PROJECT_API_PUBLIC_URL = "http://localhost:3001";
for (const entry of configuration.Config.Env) {
  const index = entry.indexOf("="); const key = entry.slice(0, index);
  if (["NPATI_SANDBOX_RUNNER_SECRET", "NPATI_PREVIEW_SECRET", "NPATI_SANDBOX_ALLOWED_HOSTS"].includes(key)) env[key] = entry.slice(index + 1);
}
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/coding-agent-chat-website-postgres.test.ts", "--reporter=verbose"], { env, stdio: "inherit" });
process.exitCode = result.status ?? 1;
