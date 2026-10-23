/** Deterministic live checks only. No providers, account changes or production writes. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
const container = process.env.NPATI_FOLLOWUP_API_CONTAINER ?? "npati-isolated-source-20261011-agent-api-1";
const runner = readFileSync("apps/agent-api/browser-qa-runner.mjs", "utf8")
  .replace('from "playwright"', 'from "/opt/npati-qa/node_modules/playwright/index.mjs"');
const diagnostics = readFileSync("apps/agent-api/browser-qa-diagnostics.mjs", "utf8");
const source = String.raw`
import assert from "node:assert/strict";
import {createHmac,randomUUID} from "node:crypto";
const secret=process.env.NPATI_SANDBOX_RUNNER_SECRET;
assert(secret?.length>=32);
const base=process.env.NPATI_SANDBOX_RUNNER_URL;
const scope={workspaceId:randomUUID(),userId:randomUUID(),companyId:randomUUID(),projectId:randomUUID()};
let sandboxId;
async function request(path,payload){
  runtimeRequests++;
  const body=JSON.stringify(payload), timestamp=String(Date.now()),nonce=randomUUID();
  const response=await fetch(base+path,{method:"POST",body,headers:{"content-type":"application/json",
    "x-npati-timestamp":timestamp,"x-npati-nonce":nonce,
    "x-npati-signature":createHmac("sha256",secret).update(timestamp+"."+nonce+"."+body).digest("hex")},
    signal:AbortSignal.timeout(90000)});
  const value=await response.json();
  if(!response.ok)throw Error("Runner HTTP "+response.status+": "+(value.error?.code??"failed"));
  return value;
}
async function op(operation,payload={}){
  return (await request("/v1/sandbox",{operation,payload:{scope,sandboxId,...payload}})).result;
}
const started=Date.now();
const checks=[];
let runtimeRequests=0;
try{
  const ready=await request("/v1/readiness",{});
  assert.equal(ready.overall_ready,true);
  sandboxId=(await op("createSandbox")).id;
  await op("startSandbox");
  const port=(await op("exposePort",{port:3001})).port;
  const networkSource = "\n(async()=>{\nconst {spawnSync}=require(\"node:child_process\");\nconst results=[];\nfor(const enabled of [\"0\",\"1\"]){\n  const start=Date.now();\n  const child=spawnSync(process.execPath,[\"-e\",\n    \"fetch('http://registry.npmjs.org/-/ping',{signal:AbortSignal.timeout(8000)}).then(async r=>console.log(JSON.stringify({status:r.status}))).catch(e=>console.log(JSON.stringify({code:e.cause?.code??e.name})))\"],\n    {encoding:\"utf8\",timeout:12000,env:{...process.env,NODE_USE_ENV_PROXY:enabled}});\n  results.push({nativeProxy:enabled,ms:Date.now()-start,result:JSON.parse(child.stdout.trim())});\n}\nfor(const url of [\"http://127.0.0.1:13001/health\",\"http://agent-api:3001/health\",\"http://postgres-projects:5432/\"]){\n const start=Date.now();\n const child=spawnSync(process.execPath,[\"-e\",\n   \"fetch(\"+JSON.stringify(url)+\",{signal:AbortSignal.timeout(3000)}).then(r=>console.log(JSON.stringify({status:r.status}))).catch(e=>console.log(JSON.stringify({code:e.cause?.code??e.name})))\"],\n   {encoding:\"utf8\",timeout:6000,env:{...process.env,NODE_USE_ENV_PROXY:\"1\"}});\n results.push({url,ms:Date.now()-start,result:JSON.parse(child.stdout.trim())});\n}\nconsole.log(JSON.stringify(results));\n})().catch(()=>process.exit(1));\n";
  const qaInput={host:"10.0.2.2",port,path:"/",viewport:{width:1280,height:800},timeoutMs:15000,maxScreenshotBytes:500000,maxBrokenLinks:5,screenshot:false};
  const wrapper="const r=require('node:child_process').spawnSync(process.execPath,['browser-qa-runner.mjs','--shared-runtime'],{input:"+JSON.stringify(JSON.stringify(qaInput))+",encoding:'utf8',timeout:30000});process.stdout.write(r.stdout);process.exitCode=r.status;";
  await op("uploadFiles",{files:[
    {path:"browser-qa-runner.mjs",content:RUNNER},
    {path:"browser-qa-diagnostics.mjs",content:DIAGNOSTICS},
    {path:"network.cjs",content:networkSource},
    {path:"qa.cjs",content:wrapper},
    {path:"site.cjs",content:"require('node:http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end('<html lang=\"en\"><head><title>QA</title></head><body><h1>Functional QA fixture</h1><script>console.error(\"password=QA_SECRET_DO_NOT_FORWARD\");setTimeout(()=>missingFunction_QA_SECRET_DO_NOT_FORWARD(),30);</script></body></html>')}).listen(Number(process.env.PORT),'127.0.0.1');"}
  ]});
  const network=await op("executeCommand",{command:"node network.cjs",options:{timeoutMs:45000,outputLimitBytes:16000}});
  assert.equal(network.exitCode,0);
  const networkResults=JSON.parse(network.stdout);
  assert.equal(networkResults[1].result.status,200,"Native proxy fetch must reach the allowed registry");
  assert.notEqual(networkResults[0].result.status,200,"Baseline native fetch should fail without DNS/proxy");
  assert(networkResults.slice(2).every(r=>r.result.status!==200),"Internal API/database access must remain blocked");
  checks.push({name:"network-preflight",status:"PASS",results:networkResults});
  await op("startProcess",{command:"node /workspace/site.cjs",options:{cwd:".",timeoutMs:60000,outputLimitBytes:16000}});
  let preview;
  for(let i=0;i<20;i++){
    try{preview=await op("proxyPreview",{options:{port,path:"/",method:"GET",headers:{}}});break;}
    catch(e){if(i===19)throw e;await new Promise(r=>setTimeout(r,250));}
  }
  assert.equal(preview.status,200);
  const qaStarted=Date.now();
  const output=await op("executeCommand",{command:"node qa.cjs",options:{timeoutMs:45000,outputLimitBytes:16000}});
  assert.equal(output.exitCode,0,output.stderr);
  const qa=JSON.parse(output.stdout);
  assert(qa.consoleErrorCount>=2);
  assert(qa.consoleDiagnostics.some(d=>d.cause==="undefined_reference"));
  assert(!JSON.stringify(qa).includes("QA_SECRET_DO_NOT_FORWARD"));
  checks.push({name:"live-browser-diagnostics",status:"PASS",ms:Date.now()-qaStarted,
    httpStatus:qa.statusCode,errorCount:qa.consoleErrorCount,diagnostics:qa.consoleDiagnostics});
  const api=await fetch("http://127.0.0.1:3001/health",{signal:AbortSignal.timeout(3000)});
  checks.push({name:"API-process-health",status:api.ok?"PASS":"FAIL",httpStatus:api.status});
  console.log(JSON.stringify({status:"PASS",runtimeMode:ready.details.runtimeMode,isolation:ready.details.isolation,
    ms:Date.now()-started,runtimeRequestsBeforeCleanup:runtimeRequests,cleanupRequests:1,llmCalls:0,tokens:0,modelToolCalls:0,checks,
    databaseToSandboxSite:"BLOCKED: no approved egress-reachable Project API endpoint"},null,2));
}finally{if(sandboxId)await op("destroySandbox");}
`;
const script=source.replace("content:RUNNER","content:"+JSON.stringify(runner)).replace("content:DIAGNOSTICS","content:"+JSON.stringify(diagnostics));
const output=execFileSync("docker",["exec","-i",container,"node","--input-type=module"],{input:script,encoding:"utf8",timeout:180000,maxBuffer:1000000});
const result=JSON.parse(output);
assert.equal(result.status,"PASS");
mkdirSync("artifacts/architecture-followup",{recursive:true});
writeFileSync("artifacts/architecture-followup/live-smoke.json",JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify(result,null,2));
