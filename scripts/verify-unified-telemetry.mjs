import {execFileSync} from "node:child_process";

const base=process.env.NPATI_API_URL??"http://localhost:3001";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const loginResponse=await fetch(base+"/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:process.env.NPATI_TEST_EMAIL??"webuser1@example.com",password:process.env.NPATI_TEST_PASSWORD??"Password123!"})});
const login=await loginResponse.json();
if(!loginResponse.ok)throw new Error("Login failed: "+JSON.stringify(login));
const headers={authorization:"Bearer "+login.tokens.accessToken,"content-type":"application/json"};
async function request(path,method="GET",body,key){
  const response=await fetch(base+path,{method,headers:{...headers,...(key?{"idempotency-key":key}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text();const value=text?JSON.parse(text):undefined;
  if(!response.ok)throw new Error(`${method} ${path} failed: ${response.status} ${text}`);
  return {response,value};
}
async function waitHealthy(){for(let attempt=0;attempt<60;attempt+=1){try{if((await fetch(base+"/health")).ok)return;}catch{}await sleep(1_000);}throw new Error("Agent API did not recover");}

const stamp=Date.now();let companyId;
try{
  const company=(await request("/companies","POST",{name:"Telemetry E2E "+stamp},"telemetry-company-"+stamp)).value;companyId=company.id;
  const main=(await request(`/companies/${companyId}/agents`,"POST",{name:"Telemetry Main",role:"Coordinator",modelId:"openai/gpt-5.6-luna",isActive:true},"telemetry-main-"+stamp)).value;
  await request(`/companies/${companyId}/main-agent`,"PUT",{agentId:main.id,expectedRevision:company.revision});
  const chat=await request("/chat","POST",{message:"Reply with exactly TELEMETRY-OK",contextType:"company",companyId},"telemetry-chat-"+stamp);
  const runId=chat.value.companyRunId;
  const requiredHeaders=["x-npati-request-id","x-npati-selected-model","x-npati-selected-provider","x-npati-routing-strategy","x-npati-tokens-total","x-npati-cost-usd","x-npati-latency-ms","x-npati-cache-hit","x-npati-failover-count"];
  const observedHeaders=Object.fromEntries(requiredHeaders.map(name=>[name,chat.response.headers.get(name)]));
  if(requiredHeaders.some(name=>observedHeaders[name]===null))throw new Error("Missing telemetry headers: "+JSON.stringify(observedHeaders));
  const details=(await request(`/companies/${companyId}/runs/${runId}`)).value;
  const inference=details.toolAudit.filter(entry=>entry.toolName==="ai.inference");
  if(!inference.length||details.run.totalTokens<=0||details.run.totalDurationMs<=0)throw new Error("Run telemetry was not persisted: "+JSON.stringify(details));
  const usage=(await request(`/companies/${companyId}/analytics/usage`)).value.analytics;
  const audit=(await request(`/companies/${companyId}/audit`)).value.logs;
  if(usage.totalRequests<1||usage.totalTokens<=0||!audit.some(entry=>entry.resourceId===runId&&entry.action==="ai.inference.completed"))throw new Error("Unified usage/audit storage is incomplete");

  execFileSync("docker",["restart","npati-agent-api"],{stdio:"ignore"});await waitHealthy();
  const recovered=(await request(`/companies/${companyId}/runs/${runId}`)).value;
  const recoveredUsage=(await request(`/companies/${companyId}/analytics/usage`)).value.analytics;
  if(recovered.run.totalTokens!==details.run.totalTokens||recoveredUsage.totalTokens!==usage.totalTokens)throw new Error("Telemetry did not survive restart");
  const inspector=(await request("/capabilities/inspect")).value;
  const statuses=Object.fromEntries(inspector.items.filter(item=>[25,27,29,191,203].includes(item.id)).map(item=>[item.id,item.status]));
  if(Object.values(statuses).length!==5||Object.values(statuses).some(status=>status!=="VERIFIED_EXISTING"))throw new Error("Telemetry capabilities are not Verified: "+JSON.stringify(statuses));
  console.log(JSON.stringify({runId,observedHeaders,inferenceEvents:inference.length,usage,auditEvents:audit.length,restartRecovery:true,statuses},null,2));
}finally{if(companyId)await request("/companies/"+companyId,"DELETE").catch(()=>undefined);}
