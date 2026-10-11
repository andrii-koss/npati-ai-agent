import { spawnSync } from "node:child_process";

// Read the environment of the actual containers, not a possibly stale .env file.
// Credentials travel over stdin to an ephemeral probe and are never printed.
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
const probe = `
import { Client } from 'minio';
import { Agent } from 'node:http';
let input='';for await(const chunk of process.stdin)input+=chunk;
const config=JSON.parse(input);
const results={};
for(const [name,credentials] of Object.entries(config)){
  if(!credentials.accessKey||!credentials.secretKey){results[name]={accepted:false,code:'MissingEnvironmentCredentials'};continue;}
  const agent=new Agent({timeout:8000});
  const client=new Client({endPoint:'127.0.0.1',port:9000,useSSL:false,region:'us-east-1',...credentials,transportAgent:agent});
  try {
    await client.listBuckets(); results[name]={accepted:true};
    try { results[name].bucketExists=await client.bucketExists('npati-chat-files'); }
    catch(error){const code=error.code;results[name].bucketCheckCode=typeof code==='string'&&/^[A-Za-z0-9]{1,80}$/.test(code)?code:'BucketProbeFailed';}
  }
  catch(error){const code=error.code;results[name]={accepted:false,code:typeof code==='string'&&/^[A-Za-z0-9]{1,80}$/.test(code)?code:'ProbeFailed'};}
  finally{agent.destroy();}
}
console.log(JSON.stringify(results));
`;
const output = docker(["run", "--rm", "-i", "--network", "container:" + minioName,
  "--entrypoint", "node", api.Image, "--input-type=module", "-e", probe],
  { input: JSON.stringify({ root, api: credentials }), timeout: 30_000 });
const result = {
  endpoint: apiEnv.MINIO_ENDPOINT,
  port: apiEnv.MINIO_PORT,
  ssl: apiEnv.MINIO_USE_SSL,
  accessKeyMatchesRoot: Boolean(root.accessKey && credentials.accessKey === root.accessKey),
  secretKeyMatchesRoot: Boolean(root.secretKey && credentials.secretKey === root.secretKey),
  sharedNetworks: Object.keys(api.NetworkSettings.Networks ?? {}).filter(name => name in (minio.NetworkSettings.Networks ?? {})),
  authenticationAgainstSelectedMinio: JSON.parse(output),
};
console.log(JSON.stringify(result, null, 2));
if (!result.authenticationAgainstSelectedMinio.api.accepted) process.exitCode = 1;
