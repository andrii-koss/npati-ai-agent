import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const artifactsRoot = path.resolve("artifacts");
const directory = path.resolve(process.env.NPATI_AUDIT_OUTPUT_DIRECTORY ?? "artifacts/coding-agent-audit-2026-10-15");
const relativeDirectory = path.relative(artifactsRoot, directory);
if (!relativeDirectory || relativeDirectory.startsWith("..") || path.isAbsolute(relativeDirectory)) throw new Error("Audit output must be inside workspace artifacts");
mkdirSync(directory, { recursive: true });
const name = "npati-audit-postgres-" + randomUUID();
const password = randomBytes(32).toString("hex");
const dockerPath = process.platform === "win32" ? "C:/Program Files/Docker/Docker/resources/bin/docker.exe" : "docker";
const image = process.env.NPATI_AUDIT_POSTGRES_IMAGE ?? "pgvector/pgvector:pg17";
if (!/^[A-Za-z0-9][A-Za-z0-9_./:@-]+$/.test(image)) throw new Error("Invalid audit image");
const docker = args => execFileSync(dockerPath, args, { encoding: "utf8", timeout: 30000,
  windowsHide: true, env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const evidence = { kind: "real-postgres-audit", container: name, image, startedAt: new Date().toISOString(), status: "failed" };
const reportFile = path.join(directory, "postgres-current.json");
let created = false;
try {
  docker(["image", "inspect", image]);
  docker(["run", "--detach", "--pull", "never", "--name", name, "--read-only",
    "--cap-drop", "ALL", ...["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"].flatMap(cap => ["--cap-add", cap]),
    "--security-opt", "no-new-privileges:true", "--memory", "1g", "--cpus", "1", "--pids-limit", "256",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--tmpfs", "/var/run/postgresql:rw,nosuid,nodev,size=16m",
    "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,size=512m",
    "--publish", "127.0.0.1::5432", "--env", "POSTGRES_PASSWORD", image]);
  created = true;
  evidence.imageId = docker(["inspect", "--format", "{{.Image}}", name]);
  for (let attempt = 0; ; attempt++) {
    try { docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); break; }
    catch { if (attempt >= 59) throw new Error("Audit PostgreSQL readiness failed"); await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  const binding = docker(["port", name, "5432/tcp"]);
  const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];
  if (!port) throw new Error("Audit PostgreSQL loopback binding unavailable");
  const env = { ...process.env, DATABASE_URL: "postgresql://postgres:" + password + "@127.0.0.1:" + port + "/postgres",
    NPATI_SECURITY_GATE_DB: "1", NPATI_CHAT_WEBSITE_LIVE_SANDBOX: "0" };
  const suites = (process.env.NPATI_AUDIT_POSTGRES_C1_ONLY === "1" ? ["coding-agent-c1-postgres"] : process.env.NPATI_AUDIT_POSTGRES_WEBSITE_ONLY === "1" ? ["coding-agent-chat-website-postgres"] : ["coding-agent-async-inbox-postgres", "coding-agent-chat-website-postgres",
    "coding-agent-c1c-audit-postgres", "coding-agent-g1-migrations-postgres", "coding-agent-r1c-data-lifecycle-postgres"]);
  if (process.env.NPATI_AUDIT_POSTGRES_INCLUDE_C1 === "1" && !suites.includes("coding-agent-c1-postgres")) suites.unshift("coding-agent-c1-postgres");
  evidence.suites = suites;
  let output = "";
  try {
    output = execFileSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...suites.map(suite => "tests/" + suite + ".test.ts"),
      "--maxWorkers=1", "--reporter=json", "--outputFile=" + reportFile], { encoding: "utf8", env,
      windowsHide: true, timeout: 600000, maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    output = String(error.stdout ?? "") + "\n" + String(error.stderr ?? "");
    evidence.executionExit = typeof error.status === "number" ? error.status : "execution_failed";
  } finally {
    writeFileSync(path.join(directory, "postgres-current.log"), output.replaceAll(password, "[REDACTED]"));
    if (existsSync(reportFile)) writeFileSync(reportFile, readFileSync(reportFile, "utf8").replaceAll(password, "[REDACTED]"));
  }
  if (evidence.executionExit !== undefined) throw new Error("Audit PostgreSQL tests failed");
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  evidence.tests = { passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests };
  if (!report.success || report.numPendingTests || report.numFailedTests || report.testResults.length !== suites.length)
    throw new Error("Audit PostgreSQL test coverage incomplete");
  evidence.status = "passed";
} catch (error) {
  // Never retain connection strings or subprocess output in the runtime summary.
  evidence.error = String(error.message).replaceAll(password, "[REDACTED]").slice(0, 500);
} finally {
  if (created) {
    if (!/^npati-audit-postgres-[0-9a-f-]{36}$/.test(name)) throw new Error("Unsafe audit cleanup target");
    try { docker(["rm", "--force", name]); evidence.cleanup = "passed"; }
    catch { evidence.cleanup = "failed"; evidence.status = "failed"; }
  }
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(path.join(directory, "postgres-runtime.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  if (evidence.status !== "passed") process.exitCode = 1;
}
