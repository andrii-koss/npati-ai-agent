import { execFileSync } from "node:child_process";

const base=process.env.NPATI_API_BASE_URL??"http://127.0.0.1:3001";
const email=process.env.NPATI_TEST_EMAIL??"webuser1@example.com",password=process.env.NPATI_TEST_PASSWORD??"Password123!";
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
let token="";
async function raw(path,method="GET",body,idempotencyKey){const headers={"content-type":"application/json"};if(token)headers.authorization=`Bearer ${token}`;if(idempotencyKey)headers["idempotency-key"]=idempotencyKey;const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();return {response,value:text?JSON.parse(text):undefined,text};}
async function request(path,method="GET",body,idempotencyKey,expected=200){const result=await raw(path,method,body,idempotencyKey);if(result.response.status!==expected)throw new Error(`${method} ${path}: expected ${expected}, got ${result.response.status} ${result.text}`);return result.value;}
async function healthy(){for(let i=0;i<60;i+=1){try{if((await fetch(base+"/health")).ok)return;}catch{}await sleep(1000);}throw new Error("API did not recover");}
async function waitTerminal(companyId,runId){for(let i=0;i<120;i+=1){const details=await request(`/companies/${companyId}/runs/${runId}`);if(["completed","failed","cancelled"].includes(details.run.status))return details;await sleep(1000);}throw new Error("Background run did not finish");}

await healthy();
const login=await raw("/auth/login","POST",{email,password});if(!login.response.ok)throw new Error("Strict-auth login failed: "+login.text);token=login.value.tokens.accessToken;
const stamp=Date.now();let companyId,otherCompanyId,workerStopped=false;
try{
  const company=await request("/companies","POST",{name:"Background Reporting E2E "+stamp},"background-company-"+stamp,201);companyId=company.id;
  const agent=await request(`/companies/${companyId}/agents`,"POST",{name:"Background Main",role:"Coordinator",modelId:"openai/gpt-5.6-luna",isActive:true},"background-agent-"+stamp,201);
  await request(`/companies/${companyId}/main-agent`,"PUT",{agentId:agent.id,expectedRevision:company.revision});
  execFileSync("docker",["stop","npati-agent-company-worker"],{stdio:"ignore"});workerStopped=true;
  const queued=await request(`/companies/${companyId}/runs`,"POST",{task:"Reply with exactly BACKGROUND-REPORT-OK",mode:"single"},"background-run-"+stamp,202);
  if(queued.run.status!=="queued"||queued.backgroundEvents?.[0]?.eventType!=="queued")throw new Error("Durable queued event missing: "+JSON.stringify(queued));
  const pendingReport=await request(`/companies/${companyId}/runs/${queued.run.id}/report`,"GET",undefined,undefined,202);
  if(pendingReport.report!==null||pendingReport.status!=="queued")throw new Error("Pending report contract is invalid");
  execFileSync("docker",["start","npati-agent-company-worker"],{stdio:"ignore"});workerStopped=false;
  const completed=await waitTerminal(companyId,queued.run.id);
  const types=completed.backgroundEvents.map(event=>event.eventType);
  for(const required of ["queued","claimed","started","completed"])if(!types.includes(required))throw new Error(`Missing ${required} background event: ${JSON.stringify(types)}`);
  if(completed.run.status!=="completed"||completed.completionReport?.status!=="completed"||!completed.completionReport?.completedAt)throw new Error("Completion report missing: "+JSON.stringify(completed));
  const report=await request(`/companies/${companyId}/runs/${queued.run.id}/report`);
  if(report.report.runId!==queued.run.id||report.report.status!=="completed")throw new Error("Report endpoint mismatch");
  const other=await request("/companies","POST",{name:"Background Isolation "+stamp},"background-other-"+stamp,201);otherCompanyId=other.id;
  await request(`/companies/${otherCompanyId}/runs/${queued.run.id}/report`,"GET",undefined,undefined,403);
  execFileSync("docker",["restart","npati-agent-api","npati-agent-company-worker"],{stdio:"ignore"});await healthy();
  const recovered=await request(`/companies/${companyId}/runs/${queued.run.id}`);
  if(recovered.backgroundEvents.length!==completed.backgroundEvents.length||recovered.completionReport?.status!=="completed")throw new Error("Background audit/report did not survive restart");
  const inspector=await request("/capabilities/inspect");
  const statuses=Object.fromEntries(inspector.items.filter(item=>[56,114].includes(item.id)).map(item=>[item.id,item.status]));
  if(Object.values(statuses).length!==2||Object.values(statuses).some(status=>status!=="VERIFIED_EXISTING"))throw new Error("Background capabilities are not Verified: "+JSON.stringify(statuses));
  console.log(JSON.stringify({runId:queued.run.id,eventTypes:types,completionReport:report.report,restartRecovery:true,crossCompanyDenied:true,statuses},null,2));
}finally{
  if(workerStopped)try{execFileSync("docker",["start","npati-agent-company-worker"],{stdio:"ignore"});}catch{}
  if(otherCompanyId)await raw("/companies/"+otherCompanyId,"DELETE");
  if(companyId)await raw("/companies/"+companyId,"DELETE");
}
