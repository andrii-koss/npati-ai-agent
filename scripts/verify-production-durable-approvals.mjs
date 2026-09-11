import {execFileSync} from "node:child_process";
const base=process.env.NPATI_API_URL??"http://localhost:3001",stamp=Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const loginResponse=await fetch(base+"/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"webuser1@example.com",password:"Password123!"})});
const login=await loginResponse.json();if(!loginResponse.ok)throw new Error(JSON.stringify(login));
const bearer={authorization:"Bearer "+login.tokens.accessToken};let sequence=0;
async function user(path,method="GET",body,expected){
  const response=await fetch(base+path,{method,headers:{...bearer,...(body?{"content-type":"application/json"}:{}),...(method==="POST"?{"idempotency-key":"approval-e2e-"+stamp+"-"+(++sequence)}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text(),value=text?JSON.parse(text):undefined;
  if(expected!==undefined?response.status!==expected:!response.ok)throw new Error(method+" "+path+" "+response.status+" "+text);
  return {value,response};
}
async function healthy(){for(let i=0;i<60;i++){try{if((await fetch(base+"/health")).ok)return;}catch{}await sleep(1000);}throw new Error("API did not recover");}
async function waitRun(companyId,runId){for(let i=0;i<90;i++){const {value}=await user("/companies/"+companyId+"/runs/"+runId);if(["failed","completed","cancelled"].includes(value.run.status))return value;await sleep(1000);}throw new Error("Run timeout");}
let companyId;
try{
  let {value:company}=await user("/companies","POST",{name:"Durable Approval E2E "+stamp});
  companyId=company.id;
  const {value:agent}=await user("/companies/"+companyId+"/agents","POST",{name:"Approval Main",role:"Coordinator",modelId:"openai/gpt-5.6-luna",tools:["Company Memory"],isActive:true});
  await user("/companies/"+companyId+"/main-agent","PUT",{agentId:agent.id,expectedRevision:company.revision});
  const {value:memory}=await user("/companies/"+companyId+"/knowledge/memory","POST",{content:"Temporary approval record "+stamp});
  const task="Delete the Company Memory item with id "+memory.id+" using the Company Memory delete operation.";
  const {value:queued}=await user("/companies/"+companyId+"/runs","POST",{task});
  const blocked=await waitRun(companyId,queued.run.id);
  if(blocked.run.errorCode!=="APPROVAL_REQUIRED")throw new Error("Run was not stopped for approval: "+JSON.stringify(blocked.run));
  const {value:list}=await user("/companies/"+companyId+"/approvals?status=pending");
  const approval=list.approvals.find(item=>item.runId===queued.run.id);if(!approval)throw new Error("Pending approval not found");
  execFileSync("docker",["restart","npati-agent-api","npati-agent-company-worker"],{stdio:"ignore"});await healthy();
  await user("/companies/"+companyId+"/approvals/"+approval.id+"/decide","POST",{decision:"approved",notes:"E2E approval"});
  const {value:resumed,response:resumeResponse}=await user("/companies/"+companyId+"/runs/"+queued.run.id+"/resume","POST",{approvalId:approval.id});
  if(resumeResponse.status!==200||resumed.run.status!=="completed")throw new Error("Approved run did not complete: "+JSON.stringify(resumed));
  const {value:memories}=await user("/companies/"+companyId+"/knowledge/memory");
  if(memories.memories.some(item=>item.id===memory.id))throw new Error("Approved delete did not execute");
  const replay=await user("/companies/"+companyId+"/runs/"+queued.run.id+"/resume","POST",{approvalId:approval.id},409);
  const runs=await user("/companies/"+companyId+"/runs");
  if(!runs.response.headers.get("x-ratelimit-tier"))throw new Error("Route tier headers missing");
  const inspector=(await user("/capabilities/inspect")).value;
  console.log(JSON.stringify({restartRecovery:true,approvalCreated:true,humanDecision:true,approvedActionExecuted:true,
    replayDenied:replay.value.run?.errorCode==="APPROVAL_ALREADY_USED",routeTier:runs.response.headers.get("x-ratelimit-tier"),
    statuses:(inspector.capabilities??inspector.items??[]).filter(item=>[39,49,54].includes(item.id??item.capability?.id)).map(item=>item.status??item.effectiveStatus)},null,2));
}finally{if(companyId)await user("/companies/"+companyId,"DELETE").catch(()=>undefined);}
