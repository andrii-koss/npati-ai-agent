import { readFileSync } from "node:fs";
const base=process.env.NPATI_API_URL??"http://localhost:3001",stamp=Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitApiHealthy(){for(let i=0;i<90;i++){try{if((await fetch(base+"/health")).ok)return}catch{}await sleep(1000)}throw Error("API did not become healthy")}
let token;
async function raw(path,method="GET",body,key){return fetch(base+path,{method,headers:{...(token?{authorization:"Bearer "+token}:{}),...(body?{"content-type":"application/json"}:{}),...(key?{"idempotency-key":key}:{})},body:body?JSON.stringify(body):undefined})}
async function req(path,method="GET",body,key){const r=await raw(path,method,body,key),t=await r.text(),v=t?JSON.parse(t):undefined;if(!r.ok)throw Error(r.status+" "+t);return v}
let companyId;
try{
 await waitApiHealthy();
 const anonymous=await raw("/companies");if(anonymous.status!==401)throw Error("strict auth is not enforced: anonymous status="+anonymous.status);
 const loginResponse=await fetch(base+"/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:process.env.NPATI_TEST_EMAIL??"webuser1@example.com",password:process.env.NPATI_TEST_PASSWORD??"Password123!"})});
 const login=await loginResponse.json();if(!loginResponse.ok)throw Error("login failed: "+JSON.stringify(login));token=login.tokens.accessToken;
 const company=await req("/companies","POST",{name:"NPATI-004 E2E "+stamp,description:"Support company used for production E2E verification",companyInstructions:"For support questions, Main Agent must delegate to the active Support Specialist and use Company Knowledge."},"npati004-e2e-company-"+stamp);companyId=company.id;
 const manager=await req("/companies/"+companyId+"/agents","POST",{name:"Main Manager",role:"Manager",description:"Always delegate support-hours questions to Support Specialist.",systemInstruction:"For this verification, select Support Specialist as a worker, call the requested storage.company_memory operation exactly, then return the knowledge-grounded result.",tools:["Knowledge","Company Memory"],isActive:true},"npati004-e2e-manager-"+stamp);
 const specialist=await req("/companies/"+companyId+"/agents","POST",{name:"Support Specialist",role:"Support",description:"Answers support policy questions from Company Knowledge and Company Memory.",systemInstruction:"Use the supplied Company Knowledge and Company Memory. State exact factual values.",tools:["Knowledge","Company Memory"],isActive:true},"npati004-e2e-specialist-"+stamp);
 await req("/companies/"+companyId+"/main-agent","PUT",{agentId:manager.id,expectedRevision:company.revision});
 const data=readFileSync(new URL("../tests/fixtures/company-knowledge.xlsx",import.meta.url)).toString("base64");
 const doc=await req("/companies/"+companyId+"/knowledge/documents","POST",{filename:"support.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",data},"npati004-e2e-doc-"+stamp);
 let ready=false;for(let i=0;i<180;i++){const v=await req("/companies/"+companyId+"/knowledge/documents"),d=v.documents.find(x=>x.id===doc.id);if(d?.status==="ready"){ready=true;break}if(d?.status==="failed")throw Error("document failed "+d.errorMessage);await sleep(1000)}if(!ready)throw Error("document processing timeout");
 const memoryCode="MEM-"+stamp;
 const memory=await req("/companies/"+companyId+"/knowledge/memory","POST",{content:"The exact escalation code is "+memoryCode+".",source:"production-e2e"});
 const started=await req("/companies/"+companyId+"/runs","POST",{task:"Call storage.company_memory with operation get and id "+memory.id+", delegate to Support Specialist, and answer from Company Knowledge and Company Memory: What are the exact support hours, timezone, and escalation code?",mode:"pipeline"},"npati004-e2e-run-"+stamp);
 let result=started;for(let i=0;i<240&&!["completed","failed","cancelled"].includes(result.run.status);i++){await sleep(1000);result=await req("/companies/"+companyId+"/runs/"+result.run.id)}
 if(result.run.status!=="completed")throw Error("run "+result.run.status+" "+(result.run.errorCode||"")+" "+(result.run.errorMessage||""));
 if(!result.steps.some(x=>x.agentId===specialist.id))throw Error("specialist was not delegated");
 if(!result.toolAudit?.some(x=>x.toolName==="storage.company_memory"&&x.status==="succeeded"&&x.inputSummary?.operation==="get"&&x.inputSummary?.id===memory.id))throw Error("Company Memory get was not executed successfully: "+JSON.stringify(result.toolAudit));
 if(!/(?:09\s*[:.]?\s*00|9\s*[:.]\s*00\s*AM)/i.test(result.run.result||"")||!/(?:18\s*[:.]?\s*00|6\s*[:.]\s*00\s*PM)/i.test(result.run.result||""))throw Error("final answer missing grounded hours: "+result.run.result);
 if(!(result.run.result||"").includes(memoryCode))throw Error("final answer missing grounded Company Memory: "+result.run.result);
 console.log(JSON.stringify({strictAuth:true,status:result.run.status,mode:result.run.executionMode,mainAgentId:manager.id,specialistDelegated:true,companyMemoryToolCalled:true,memoryGetCalled:true,knowledgeGrounded:true,memoryGrounded:true,answer:result.run.result},null,2));
 const removed=await raw("/companies/"+companyId,"DELETE");if(removed.status!==204)throw Error("cleanup "+removed.status);companyId=undefined;
}finally{if(companyId)await raw("/companies/"+companyId,"DELETE").catch(()=>{})}
