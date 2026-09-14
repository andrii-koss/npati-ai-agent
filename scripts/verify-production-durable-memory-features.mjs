import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";

const base=process.env.NPATI_API_URL??"http://localhost:3001";
const secret=process.env.NPATI_JWT_SECRET??"pati-backend-jwt-secret-key-2024-min-32-chars-long";
const stamp=Date.now();
const encode=value=>Buffer.from(JSON.stringify(value)).toString("base64url");
const token=userId=>{const now=Math.floor(Date.now()/1000),h=encode({alg:"HS256",typ:"JWT"}),p=encode({userId,email:userId+"@example.test",role:"user",iat:now,exp:now+3600});return h+"."+p+"."+createHmac("sha256",secret).update(h+"."+p).digest("base64url");};
async function request(path,{method="GET",token:authToken,body,key}={}){const response=await fetch(base+path,{method,headers:{authorization:"Bearer "+authToken,...(body?{"content-type":"application/json"}:{}),...(["POST","PUT","PATCH","DELETE"].includes(method)?{"idempotency-key":key??"durable-"+stamp+"-"+Math.random()}: {})},body:body?JSON.stringify(body):undefined});const text=await response.text();let data;try{data=text?JSON.parse(text):null}catch{data=text}return{status:response.status,data};}
const assert=(condition,message,detail)=>{if(!condition)throw Error(message+": "+JSON.stringify(detail));console.log("OK "+message);};
async function health(){for(let i=0;i<80;i++){try{if((await fetch(base+"/health")).ok)return}catch{}await new Promise(r=>setTimeout(r,500));}throw Error("API did not recover");}
const sql=value=>String(value).replaceAll("'","''");
const tokenA=token("durable-a-"+stamp),tokenB=token("durable-b-"+stamp);
let companyA,companyB,business;
try{
  companyA=await request("/companies",{method:"POST",token:tokenA,body:{name:"Durable A "+stamp}});
  companyB=await request("/companies",{method:"POST",token:tokenB,body:{name:"Durable B "+stamp}});
  assert(companyA.status===201&&companyB.status===201,"isolated companies created",{companyA,companyB});

  const typed=await request("/companies/"+companyA.data.id+"/knowledge/memory",{method:"POST",token:tokenA,body:{content:"Permanent policy TYPE-"+stamp,type:"immutable",weight:0.95,title:"Permanent policy"}});
  assert(typed.status===201&&typed.data.metadata.type==="immutable"&&typed.data.metadata.weight===0.95,"typed memory persisted through production API",typed);

  const noteKey="daily-"+stamp;
  const noteBody={date:"2026-09-14",topic:"Release",content:"Daily code NOTE-"+stamp};
  const note1=await request("/companies/"+companyA.data.id+"/knowledge/memory/daily-notes",{method:"POST",token:tokenA,key:noteKey,body:noteBody});
  const note2=await request("/companies/"+companyA.data.id+"/knowledge/memory/daily-notes",{method:"POST",token:tokenA,key:noteKey,body:noteBody});
  assert(note1.status===201&&note2.status===200&&note1.data.id===note2.data.id,"daily note is durable and idempotent",{note1,note2});
  const foreignNotes=await request("/companies/"+companyA.data.id+"/knowledge/memory/daily-notes?date=2026-09-14",{token:tokenB});
  assert(foreignNotes.status===403,"daily notes deny cross-tenant access",foreignNotes);

  const intentKey="intent-"+stamp;
  const intent=await request("/companies/"+companyA.data.id+"/knowledge/memory/standing-intents",{method:"POST",token:tokenA,key:intentKey,body:{title:"Watch renewal",description:"Notify when renewal is mentioned",triggerKeywords:["renewal","contract"]}});
  assert(intent.status===201&&intent.data.revision===1,"standing intent persisted",intent);
  const match=await request("/companies/"+companyA.data.id+"/knowledge/memory/standing-intents?query=contract%20renewal",{token:tokenA});
  assert(match.status===200&&match.data.intents.some(item=>item.id===intent.data.id),"standing intent keyword matching works",match);
  const agentContext=await request("/companies/"+companyA.data.id+"/knowledge/retrieve",{method:"POST",token:tokenA,body:{query:"contract renewal NOTE-"+stamp,limit:10}});
  assert(agentContext.status===200&&agentContext.data.memories.some(item=>item.source==="daily_note")&&agentContext.data.memories.some(item=>item.source==="standing_intent"),"daily notes and standing intents enter the agent retrieval context",agentContext);
  const updated=await request("/companies/"+companyA.data.id+"/knowledge/memory/standing-intents/"+intent.data.id,{method:"PATCH",token:tokenA,body:{status:"fulfilled",expectedRevision:1}});
  const stale=await request("/companies/"+companyA.data.id+"/knowledge/memory/standing-intents/"+intent.data.id,{method:"PATCH",token:tokenA,body:{status:"pending",expectedRevision:1}});
  assert(updated.status===200&&updated.data.revision===2&&stale.status===409,"intent transition uses optimistic revision control",{updated,stale});

  business=await request("/businesses",{method:"POST",token:tokenA,body:{name:"Flush Business "+stamp}});
  const conversation=await request("/businesses/"+business.data.id+"/conversations",{method:"POST",token:tokenA,body:{title:"Flush E2E"}});
  assert(business.status===201&&conversation.status===201,"business conversation created",{business,conversation});
  const flushCode="FLUSH-"+stamp;
  const insert=`INSERT INTO messages(id,conversation_id,role,content,created_at) SELECT 'flush-${stamp}-'||g,'${sql(conversation.data.id)}',CASE WHEN g%2=1 THEN 'user' ELSE 'assistant' END,CASE WHEN g=1 THEN 'Remember that escalation code is ${flushCode}.' ELSE CASE WHEN g%2=1 THEN 'User turn '||g ELSE 'Assistant turn '||g END END,now()+g*interval '1 millisecond' FROM generate_series(1,14) g;`;
  execFileSync("docker",["exec","npati-agent-postgres","psql","-U","npati","-d","npati_agent","-v","ON_ERROR_STOP=1","-c",insert],{stdio:"ignore"});
  const chat=await request("/chat",{method:"POST",token:tokenA,body:{businessId:business.data.id,conversationId:conversation.data.id,message:"Reply briefly."}});
  assert(chat.status===200&&chat.data.contextCompaction?.applied===true&&chat.data.contextCompaction?.automaticMemoryFlush?.persistedCount>=1,"real chat compaction durably flushes memory",chat);
  const memories=await request("/businesses/"+business.data.id+"/memory?search="+flushCode,{token:tokenA});
  assert(memories.status===200&&memories.data.some(item=>item.content.includes(flushCode)&&item.source==="automatic_flush"),"flushed fact is queryable from Business Memory",memories);

  execFileSync("docker",["restart","npati-agent-api"],{stdio:"ignore"});await health();
  const notesAfter=await request("/companies/"+companyA.data.id+"/knowledge/memory/daily-notes?date=2026-09-14",{token:tokenA});
  const intentsAfter=await request("/companies/"+companyA.data.id+"/knowledge/memory/standing-intents?status=fulfilled",{token:tokenA});
  const typedAfter=await request("/companies/"+companyA.data.id+"/knowledge/memory",{token:tokenA});
  const flushAfter=await request("/businesses/"+business.data.id+"/memory?search="+flushCode,{token:tokenA});
  assert(notesAfter.data.notes?.some(item=>item.id===note1.data.id),"daily notes survive API restart",notesAfter);
  assert(intentsAfter.data.intents?.some(item=>item.id===intent.data.id&&item.revision===2),"standing intents survive API restart",intentsAfter);
  assert(typedAfter.data.memories?.some(item=>item.id===typed.data.id&&item.metadata.type==="immutable"),"typed memory survives API restart",typedAfter);
  assert(flushAfter.data.some(item=>item.content.includes(flushCode)),"automatic flush survives API restart",flushAfter);
}finally{
  if(business?.data?.id)await request("/businesses/"+business.data.id,{method:"DELETE",token:tokenA});
  if(companyA?.data?.id)await request("/companies/"+companyA.data.id,{method:"DELETE",token:tokenA});
  if(companyB?.data?.id)await request("/companies/"+companyB.data.id,{method:"DELETE",token:tokenB});
}
console.log("NPATI #77/#81/#83/#85 production Docker E2E passed; #79 remains Not implemented");
