import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const base=new URL(process.env.NPATI_API_URL??"http://localhost:3001");
const tiers=(process.argv.slice(2).length?process.argv.slice(2):["100","500","1000","5000","10000"]).map(Number);
const timeoutMs=Number(process.env.LOAD_TIMEOUT_MS??30000);
const docker=(...args)=>{try{return execFileSync("docker",args,{encoding:"utf8",timeout:15000}).trim()}catch(error){return "unavailable"}};
const percentile=(values,p)=>values.length?values[Math.min(values.length-1,Math.floor(values.length*p))]:0;
function infrastructure(){
  let stats={};try{stats=docker("stats","--no-stream","--format","{{json .}}","npati-agent-api","npati-agent-company-worker","npati-agent-postgres","npati-agent-redis").split(/\r?\n/).filter(Boolean).map(JSON.parse).reduce((a,x)=>(a[x.Name]={cpu:x.CPUPerc,memory:x.MemUsage},a),{})}catch{}
  const pg=docker("exec","npati-agent-postgres","psql","-U","npati","-d","npati_agent","-Atc","select count(*) from pg_stat_activity where datname='npati_agent'");
  const redis=docker("exec","npati-agent-redis","redis-cli","--raw","INFO","clients","memory","stats");
  const pick=(name)=>redis.match(new RegExp("^"+name+":([^\\r\\n]+)","m"))?.[1]??null;
  const depth=docker("exec","npati-agent-redis","redis-cli","XLEN","npati:company-runs:v1");
  return {containers:stats,postgresConnections:Number(pg)||null,redis:{connectedClients:Number(pick("connected_clients"))||null,usedMemory:pick("used_memory_human"),opsPerSecond:Number(pick("instantaneous_ops_per_sec"))||0,queueDepth:Number(depth)||0}};
}
async function health(){try{const r=await fetch(new URL("/health",base));const j=await r.json();return {ok:r.ok,omniroute:j.services?.omniroute??j.details?.omniroute?.status??"unknown"}}catch{return {ok:false,omniroute:"unavailable"}}}
function one(agent){
  return new Promise(resolve=>{const started=performance.now();let timedOut=false;
    const req=http.request({hostname:base.hostname,port:base.port,path:"/companies?limit=1",method:"GET",agent},res=>{res.resume();res.on("end",()=>resolve({ms:performance.now()-started,ok:res.statusCode===200,timeout:false,status:res.statusCode}))});
    req.setTimeout(timeoutMs,()=>{timedOut=true;req.destroy(new Error("timeout"))});
    req.on("error",()=>resolve({ms:performance.now()-started,ok:false,timeout:timedOut,status:0}));req.end();
  });
}
const results=[];
for(const concurrent of tiers){
  const agent=new http.Agent({keepAlive:true,maxSockets:concurrent,maxFreeSockets:256});
  const before={infra:infrastructure(),health:await health()},started=performance.now();
  const samples=await Promise.all(Array.from({length:concurrent},()=>one(agent)));
  const wallMs=performance.now()-started;agent.destroy();
  const latency=samples.map(x=>x.ms).sort((a,b)=>a-b),errors=samples.filter(x=>!x.ok).length,timeouts=samples.filter(x=>x.timeout).length;
  const result={concurrentRequests:concurrent,wallMs:Number(wallMs.toFixed(1)),throughputRps:Number((concurrent/(wallMs/1000)).toFixed(1)),
    latencyMs:{p50:Number(percentile(latency,.5).toFixed(1)),p95:Number(percentile(latency,.95).toFixed(1)),p99:Number(percentile(latency,.99).toFixed(1)),max:Number((latency.at(-1)??0).toFixed(1))},
    errors,errorRate:Number((errors/concurrent).toFixed(5)),timeouts,providerFailures:[before.health.omniroute,(await health()).omniroute].filter(x=>x!=="ok"&&x!==true).length,
    before:before.infra,after:infrastructure()};
  results.push(result);console.log(JSON.stringify(result));
  if(result.errorRate>.01||timeouts>0){console.error("Stopping after threshold failure");break}
  await new Promise(r=>setTimeout(r,3000));
}
mkdirSync("artifacts",{recursive:true});const file=`artifacts/company-load-results-${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
writeFileSync(file,JSON.stringify({scope:"Authenticated Company read API path; not provider-backed chat/SSE sessions",generatedAt:new Date().toISOString(),results},null,2));
console.log("RESULT_FILE="+file);
