import { spawnSync } from "node:child_process";

// Read the environment of the actual containers, not a possibly stale .env file.
// Credentials travel over stdin to mc inside the existing MinIO container and are never printed.
// No diagnostic container is created, so this also works while API is restarting.
const [apiName, minioName] = process.argv.slice(2);
if (!apiName || !minioName) {
  console.error("Usage: node scripts/diagnose-minio-docker.mjs <agent-api-container> <minio-container>");
  process.exit(2);
}
function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 4_000_000, ...options });
  if (result.status !== 0) throw new Error("Docker diagnostic command failed; check container names and Docker access");
  return result.stdout;
}
function inspect(name) { return JSON.parse(docker(["inspect", name]))[0]; }
function environment(container) {
  return Object.fromEntries((container.Config.Env ?? []).map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}
const api = inspect(apiName), minio = inspect(minioName);
const apiEnv = environment(api), minioEnv = environment(minio);
const root = { accessKey: minioEnv.MINIO_ROOT_USER, secretKey: minioEnv.MINIO_ROOT_PASSWORD };
const credentials = { accessKey: apiEnv.MINIO_ACCESS_KEY, secretKey: apiEnv.MINIO_SECRET_KEY };
function authenticate(credentials, endpoint = "http://127.0.0.1:9000") {
  if (!credentials.accessKey || !credentials.secretKey) return { accepted: false, code: "MissingEnvironmentCredentials" };
  const url = new URL(endpoint);
  url.username = credentials.accessKey;
  url.password = credentials.secretKey;
  // MC_HOST avoids writing an alias containing credentials to a config file.
  const result = spawnSync("docker", ["exec", "-i", minioName, "sh", "-c",
    'IFS= read -r MC_HOST_npati; export MC_HOST_npati; mc --json ls npati'],
    { input: url.href + "\n", encoding: "utf8", timeout: 15_000, maxBuffer: 4_000_000 });
  if (result.status === 0) return { accepted: true };
  // Raw mc errors can echo request details; emit only a validated S3 error code.
  for (const line of ((result.stdout ?? "") + "\n" + (result.stderr ?? "")).split("\n")) {
    try {
      const code = JSON.parse(line)?.error?.cause?.error?.Code;
      if (typeof code === "string" && /^[A-Za-z0-9]{1,80}$/.test(code)) return { accepted: false, code };
    } catch { /* Non-JSON command output is never printed. */ }
  }
  return { accepted: false, code: result.error?.code === "ETIMEDOUT" ? "ProbeTimeout" : "ProbeFailedCheckMcAvailability" };
}
const authentication = { root: authenticate(root), api: authenticate(credentials) };
const result = {
  endpoint: apiEnv.MINIO_ENDPOINT,
  port: apiEnv.MINIO_PORT,
  ssl: apiEnv.MINIO_USE_SSL,
  accessKeyMatchesRoot: Boolean(root.accessKey && credentials.accessKey === root.accessKey),
  secretKeyMatchesRoot: Boolean(root.secretKey && credentials.secretKey === root.secretKey),
  sharedNetworks: Object.keys(api.NetworkSettings.Networks ?? {}).filter(name => name in (minio.NetworkSettings.Networks ?? {})),
  authenticationAgainstSelectedMinio: authentication,
};
console.log(JSON.stringify(result, null, 2));
if (!result.authenticationAgainstSelectedMinio.api.accepted) process.exitCode = 1;
