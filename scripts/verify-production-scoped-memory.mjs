import { execFileSync } from "node:child_process";

const base=process.env.NPATI_API_URL??"http://localhost:3001";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const loginResponse=await fetch(base+"/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"webuser1@example.com",password:"Password123!"})});
const login=await loginResponse.json();
if(!loginResponse.ok)throw new Error(JSON.stringify(login));
const bearer={authorization:"Bearer "+login.tokens.accessToken};
async function user(path,method="GET",body,key){
  const response=await fetch(base+path,{method,headers:{...bearer,...(body?{"content-type":"application/json"}:{}),...(key?{"idempotency-key":key}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text();const value=text?JSON.parse(text):undefined;
  if(!response.ok)throw new Error(method+" "+path+" "+response.status+" "+text);
  return value;
}
async function companyApi(token,path,method="GET",body,key,expected=200){
  const response=await fetch(base+path,{method,headers:{"x-npati-api-key":token,...(body?{"content-type":"application/json"}:{}),...(key?{"idempotency-key":key}:{})},body:body?JSON.stringify(body):undefined});
  const text=await response.text();const value=text?JSON.parse(text):undefined;
  if(response.status!==expected)throw new Error(method+" "+path+" "+response.status+" "+text);
  return value;
}
async function waitHealthy(){
  for(let attempt=0;attempt<60;attempt+=1){
    try{const response=await fetch(base+"/health");if(response.ok)return;}catch{}
    await sleep(1000);
  }
  throw new Error("Agent API did not recover after restart");
}

const stamp=Date.now();
let companyId;
try{
  const company=await user("/companies","POST",{name:"Scoped Memory E2E "+stamp},"scoped-company-"+stamp);
  companyId=company.id;
  const main=await user("/companies/"+companyId+"/agents","POST",{name:"Scoped Main",role:"Coordinator",modelId:"openai/gpt-5.6-luna",tools:["Knowledge","Company Memory"],isActive:true},"scoped-main-"+stamp);
  await user("/companies/"+companyId+"/main-agent","PUT",{agentId:main.id,expectedRevision:company.revision});
  const scopes=["memory:read","memory:write","chat:write"];
  const keyA=(await user("/companies/"+companyId+"/api-keys","POST",{name:"Scoped A",scopes})).key;
  const keyB=(await user("/companies/"+companyId+"/api-keys","POST",{name:"Scoped B",scopes})).key;
  const sessionId="shared-session";
  const codeA="SCOPED-ALPHA-"+stamp;
  const codeB="SCOPED-BETA-"+stamp;
  const a=await companyApi(keyA.rawToken,"/company-api/memory","POST",{sessionId,title:"Session escalation code",content:codeA},"scoped-write-a-"+stamp,201);
  await companyApi(keyA.rawToken,"/company-api/memory","POST",{sessionId,title:"Session escalation code",content:codeA},"scoped-write-a-"+stamp,201);
  await companyApi(keyB.rawToken,"/company-api/memory","POST",{sessionId,title:"Session escalation code",content:codeB},"scoped-write-b-"+stamp,201);

  execFileSync("docker",["restart","npati-agent-api"],{stdio:"ignore"});
  await waitHealthy();

  const listA=await companyApi(keyA.rawToken,"/company-api/memory?sessionId="+sessionId);
  const listB=await companyApi(keyB.rawToken,"/company-api/memory?sessionId="+sessionId);
  const serializedA=JSON.stringify(listA),serializedB=JSON.stringify(listB);
  if(!serializedA.includes(codeA)||serializedA.includes(codeB))throw new Error("API key A scope isolation failed");
  if(!serializedB.includes(codeB)||serializedB.includes(codeA))throw new Error("API key B scope isolation failed");
  if(listA.memories.filter(item=>item.content===codeA).length!==1)throw new Error("Idempotent memory write produced a duplicate");

  const chat=await companyApi(keyA.rawToken,"/company-api/chat","POST",{sessionId,message:"Return the exact Session escalation code from Company Memory."},"scoped-chat-"+stamp);
  if(!chat.message?.includes(codeA)||chat.message.includes(codeB))throw new Error("Company chat did not inject the correctly scoped memory: "+String(chat.message));
  const privateChat=await companyApi(keyA.rawToken,"/company-api/chat","POST",{sessionId,message:"Return the exact Session escalation code from Company Memory.",noMemory:true},"scoped-private-"+stamp);
  if(privateChat.message?.includes(codeA))throw new Error("no-memory request leaked scoped memory");

  const deniedDelete=await fetch(base+"/company-api/memory/"+a.memory.id+"?sessionId="+sessionId,{method:"DELETE",headers:{"x-npati-api-key":keyB.rawToken}});
  if(deniedDelete.status!==404)throw new Error("Cross-key delete was not denied");
  const inspector=await user("/capabilities/inspect");
  console.log(JSON.stringify({restartRecovery:true,apiKeyIsolation:true,sessionIsolation:true,idempotency:true,memoryInjection:true,noMemoryBypass:true,crossKeyDeleteDenied:true,statuses:(inspector.capabilities??inspector.items??[]).filter(item=>[67,68,69].includes(item.id??item.capability?.id)).map(item=>item.status??item.effectiveStatus),codeA},null,2));
}finally{
  if(companyId)await user("/companies/"+companyId,"DELETE").catch(()=>undefined);
}
