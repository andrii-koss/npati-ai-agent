import assert from 'node:assert/strict';
import fs from 'node:fs';
const base=(process.argv[2]??'http://127.0.0.1:13001').replace(/\/$/,''),results=[];
async function check(path,status,options={}){
 const response=await fetch(base+path,{...options,signal:AbortSignal.timeout(15000)});
 assert.equal(response.status,status,path);results.push({path,status:response.status,contentType:response.headers.get('content-type')});return response;
}
await check('/health/live',200);await check('/api/health/live',200);
const root=await check('/',200),html=await root.text();assert.match(html,/id="root"/);assert.equal(root.headers.get('cache-control'),'no-cache');
for(const route of ['/projects/validation/project','/settings/capabilities','/companies/validation/projects/project/data']){
 const response=await check(route,200,{headers:{accept:'text/html'}});assert.equal(await response.text(),html);
}
const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(match=>match[1]);assert(assets.length>=2);
for(const asset of assets){const response=await check(asset,200);assert.match(response.headers.get('cache-control'),/immutable/);assert((await response.text()).length>100);}
await check('/assets/missing.js',404);await check('/.env',404);await check('/api/nonexistent-route',404);
await check('/api/companies',401);await check('/api/auth/installation/status',200);
fs.mkdirSync('artifacts/docker-validation',{recursive:true});fs.writeFileSync('artifacts/docker-validation/http-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
