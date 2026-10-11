import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
const root=process.cwd();
const dir=path.join(root,'artifacts/docker-validation');
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'empty.env'),'');
const source=fs.readFileSync('docker-compose.dokploy-isolated.yml','utf8');
const env={...process.env};
for(const match of source.matchAll(/\$\{([A-Z0-9_]+):\?/g))env[match[1]]='validation-only-987654321abcdef987654321abcdef';
Object.assign(env,{MINIO_ROOT_USER:'validation-admin',MINIO_ROOT_PASSWORD:randomBytes(32).toString('hex'),MINIO_ACCESS_KEY:'',MINIO_SECRET_KEY:'',NPATI_BACKEND_URL:process.env.NPATI_BACKEND_URL||'https://www.npati.com',NPATI_WEB_ORIGIN:'http://127.0.0.1:13001',NPATI_AGENT_PUBLIC_DOMAIN:'http://127.0.0.1:13001',NPATI_DEPLOYMENT_TYPE:'self_hosted',NPATI_BUILD_COMMIT:spawnSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).stdout.trim(),NPATI_BUILD_TIME:new Date().toISOString(),NPATI_ENCRYPTION_KEY:randomBytes(32).toString('hex')});
// Do not rotate credentials in an existing validation project's persistent databases.
for(const args of [['ps','-aq','--filter','label=com.docker.compose.project=npati-validation-20261011'],['volume','ls','-q','--filter','label=com.docker.compose.project=npati-validation-20261011']]){
 const existing=spawnSync('docker',args,{encoding:'utf8'});
 if(existing.status!==0)throw Error('Docker Desktop must be running');
 if(existing.stdout.trim())throw Error('Validation project already exists; reuse its compose.json or remove that validation project first');
}
const result=spawnSync('docker',['compose','--env-file',path.join(dir,'empty.env'),'-p','npati-validation-20261011','-f','docker-compose.dokploy-isolated.yml','config','--format','json'],{env,encoding:'utf8',maxBuffer:8e6});
if(result.status!==0)throw Error(result.stderr);
const config=JSON.parse(result.stdout);
config.services['agent-api'].ports=[{target:3001,published:'13001',host_ip:'127.0.0.1',protocol:'tcp'}];
// Preserve all production services and settings; isolate only resource names and host port.
config.services.crawler.image='npati-validation-crawler:20261011';
for(const service of Object.values(config.services)){if(service.container_name)throw Error('Unexpected fixed container name');}
for(const volume of Object.values(config.volumes))if(!volume.name.startsWith('npati-validation-20261011'))throw Error('Unsafe volume name');
fs.writeFileSync(path.join(dir,'compose.json'),JSON.stringify(config,null,2));
console.log('Prepared isolated production validation: '+Object.keys(config.services).join(', '));
