import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
// Validate the deployment YAML directly. Generate environment values only;
// never rewrite services, networks, health checks or security settings.
const project='npati-isolated-source-20261011';
const dir=path.resolve('artifacts/docker-validation-source');
const file=path.join(dir,'.env.validation');
fs.mkdirSync(dir,{recursive:true});
if(fs.existsSync(file)){
 console.log(`Reuse ${file}; credentials were not rotated.`);
 process.exit(0);
}
for(const args of [['ps','-aq','--filter',`label=com.docker.compose.project=${project}`],['volume','ls','-q','--filter',`label=com.docker.compose.project=${project}`]]){
 const result=spawnSync('docker',args,{encoding:'utf8'});
 if(result.status!==0)throw Error('Docker Desktop must be running');
 if(result.stdout.trim())throw Error('Existing validation resources have no saved environment; refusing to rotate credentials');
}
const source=fs.readFileSync('docker-compose.dokploy-isolated.yml','utf8');
const env={};
for(const match of source.matchAll(/\$\{([A-Z0-9_]+):\?/g))env[match[1]]=randomBytes(32).toString('hex');
Object.assign(env,{
 COMPOSE_PROJECT_NAME:project,
 NPATI_BACKEND_URL:process.env.NPATI_BACKEND_URL||'https://www.npati.com',
 NPATI_WEB_ORIGIN:'http://127.0.0.1:13001',
 NPATI_AGENT_PUBLIC_DOMAIN:'http://127.0.0.1:13001',
 NPATI_AGENT_PUBLISHED_PORT:'13001',
 NPATI_BUILD_COMMIT:spawnSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).stdout.trim(),
 NPATI_BUILD_TIME:new Date().toISOString(),
 MINIO_ROOT_USER:'validation-admin',MINIO_ACCESS_KEY:'',MINIO_SECRET_KEY:'',
});
// Use only an explicit image mirror override supported by the deployment YAML.
if(process.env.MINIO_IMAGE)env.MINIO_IMAGE=process.env.MINIO_IMAGE;
fs.writeFileSync(file,Object.entries(env).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n');
console.log(`Prepared environment only: ${file}`);
console.log(`docker compose --env-file "${file}" -f docker-compose.dokploy-isolated.yml up -d --build`);
