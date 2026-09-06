import { execFileSync } from "node:child_process";
const base=process.env.NPATI_API_URL??"http://localhost:3001",stamp=Date.now();
const docker=(...args)=>execFileSync("docker",args,{encoding:"utf8"}).trim();
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function req(path,method="GET",body,key){const r=await fetch(base+path,{method,headers:{"content-type":"application/json",...(key?{"idempotency-key":key}:{})},body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw new Error(r.status+" "+JSON.stringify(j));return j}
async function ready(){for(let i=0;i<60;i++){try{if((await fetch(base+"/health")).ok)return}catch{}await sleep(1000)}throw new Error("API did not recover")}
let company;
try{
  docker("stop","npati-agent-company-worker");
  company=await req("/companies","POST",{name:"Recovery verification "+stamp},"recovery-company-"+stamp);
  const agent=await req(`/companies/${company.id}/agents`,"POST",{name:"Recovery Main",role:"Manager",tools:[],isActive:true},"recovery-agent-"+stamp);
  company=await req(`/companies/${company.id}/main-agent`,"PUT",{agentId:agent.id,expectedRevision:company.revision});
  const key="recovery-run-"+stamp,posts=await Promise.all(Array.from({length:20},()=>req(`/companies/${company.id}/runs`,"POST",{task:"Reply RECOVERY_OK",mode:"single"},key)));
  const ids=[...new Set(posts.map(x=>x.run.id))],runId=ids[0];
  docker("exec","npati-agent-redis","redis-cli","DEL","npati:company-runs:v1");
  docker("restart","npati-agent-redis");
  docker("restart","npati-agent-api");
  await ready();
  docker("start","npati-agent-company-worker");
  let current=await req(`/companies/${company.id}/runs/${runId}`);
  for(let i=0;i<120&&!["completed","failed","cancelled"].includes(current.run.status);i++){await sleep(1000);current=await req(`/companies/${company.id}/runs/${runId}`)}
  const count=docker("exec","npati-agent-postgres","psql","-U","npati","-d","npati_agent","-Atc",`select count(*) from company_agent_runs where id='${runId}'`);
  console.log(JSON.stringify({uniqueRunIds:ids.length,databaseRows:Number(count),status:current.run.status,attemptCount:current.run.attemptCount,errorCode:current.run.errorCode,recoveredAfterStreamLoss:current.run.attemptCount>0},null,2));
  if(ids.length!==1||Number(count)!==1||current.run.attemptCount<1)process.exitCode=1;
}finally{
  try{docker("start","npati-agent-company-worker")}catch{}
  if(company?.id)await req(`/companies/${company.id}`,"DELETE").catch(()=>{});
}
