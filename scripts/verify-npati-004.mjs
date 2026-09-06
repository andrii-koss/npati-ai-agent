import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const base=process.env.NPATI_API_URL??"http://localhost:3001",stamp=Date.now(),sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const docker=(...args)=>execFileSync("docker",args,{encoding:"utf8"}).trim();
async function raw(path,method="GET",body,key){return fetch(base+path,{method,headers:{...(body?{"content-type":"application/json"}:{}),...(key?{"idempotency-key":key}:{})},body:body?JSON.stringify(body):undefined})}
async function req(path,method="GET",body,key){const r=await raw(path,method,body,key),text=await r.text(),value=text?JSON.parse(text):undefined;if(!r.ok)throw Error(r.status+" "+text);return value}
async function ready(){for(let i=0;i<90;i++){try{if((await fetch(base+"/health")).ok)return}catch{}await sleep(1000)}throw Error("API did not recover")}
async function waitDoc(companyId,id){for(let i=0;i<180;i++){const v=await req("/companies/"+companyId+"/knowledge/documents");const d=v.documents.find(x=>x.id===id);if(d?.status==="ready")return d;if(d?.status==="failed")throw Error("document failed: "+d.errorMessage);await sleep(1000)}throw Error("document timeout")}
let companyId,companyBId,bWorkspace="npati004-ws-"+stamp,bUser="npati004-user-"+stamp,bCompany="npati004-company-"+stamp,workerStopped=false;
try{
 const company=await req("/companies","POST",{name:"NPATI-004 verification "+stamp},"npati004-company-"+stamp);companyId=company.id;
 const manager=await req("/companies/"+companyId+"/agents","POST",{name:"Knowledge Manager",role:"Manager",tools:["Knowledge"],isActive:true},"npati004-manager-"+stamp);
 await req("/companies/"+companyId+"/main-agent","PUT",{agentId:manager.id,expectedRevision:company.revision});
 docker("stop","npati-agent-company-worker");workerStopped=true;
 const data=readFileSync(new URL("../tests/fixtures/company-knowledge.xlsx",import.meta.url)).toString("base64"),key="npati004-xlsx-"+stamp;
 const cancelledDocument=await req("/companies/"+companyId+"/knowledge/documents","POST",{filename:"cancelled.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",data},"npati004-delete-"+stamp);
 const deleteResponses=await Promise.all(Array.from({length:20},()=>raw("/companies/"+companyId+"/knowledge/documents/"+cancelledDocument.id,"DELETE")));
 if(deleteResponses.some(response=>response.status!==204))throw Error("concurrent document DELETE was not idempotent: "+deleteResponses.map(response=>response.status).join(","));
 const cancelledState=docker("exec","npati-agent-postgres","psql","-U","npati","-d","npati_agent","-Atc","select d.status,(select count(*) from company_knowledge_chunks c where c.document_id=d.id),(f.deleted_at is not null),(f.storage_deleted_at is not null) from company_knowledge_documents d join files f on f.id=d.file_id where d.id='"+cancelledDocument.id+"';");
 if(cancelledState!=="deleted|0|t|t")throw Error("cancelled document state "+cancelledState);
 const uploads=await Promise.all(Array.from({length:20},()=>req("/companies/"+companyId+"/knowledge/documents","POST",{filename:"company-knowledge.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",data},key)));
 const documentIds=[...new Set(uploads.map(x=>x.id))];if(documentIds.length!==1)throw Error("duplicate document ids: "+documentIds.length);
 const queued=await req("/companies/"+companyId+"/runs","POST",{task:"This queued run must be cancelled",mode:"single"},"npati004-cancel-"+stamp);
 const cancelled=await req("/companies/"+companyId+"/runs/"+queued.run.id+"/cancel","POST");
 if(cancelled.run.status!=="cancelled")throw Error("queued cancellation status="+cancelled.run.status);
 docker("exec","npati-agent-redis","redis-cli","DEL","npati:knowledge-documents:v1");
 docker("restart","npati-agent-redis");docker("restart","npati-agent-api");await ready();
 docker("start","npati-agent-company-worker");workerStopped=false;
 const document=await waitDoc(companyId,documentIds[0]);
 const counts=docker("exec","npati-agent-postgres","psql","-U","npati","-d","npati_agent","-Atc","select (select count(*) from company_knowledge_documents where id='"+document.id+"'),(select count(*) from company_knowledge_chunks where document_id='"+document.id+"'),(select count(distinct content_hash) from company_knowledge_chunks where document_id='"+document.id+"');");
 const [docs,chunks,hashes]=counts.split("|").map(Number);if(docs!==1||chunks<1||chunks!==hashes)throw Error("database duplicate check "+counts);
 const sql="BEGIN; INSERT INTO users(id,external_subject,display_name) VALUES('"+bUser+"','local:"+bUser+"','Tenant B'); INSERT INTO workspaces(id,name,owner_user_id) VALUES('"+bWorkspace+"','Tenant B','"+bUser+"'); INSERT INTO companies(id,workspace_id,user_id,name,create_request_key) VALUES('"+bCompany+"','"+bWorkspace+"','"+bUser+"','Tenant B Company','tenant-b'); COMMIT;";
 docker("exec","npati-agent-postgres","psql","-U","npati","-d","npati_agent","-v","ON_ERROR_STOP=1","-c",sql);
 const cross=await raw("/companies/"+bCompany+"/knowledge/documents");if(cross.status!==403)throw Error("cross-tenant HTTP status="+cross.status);
 const retrieve=await req("/companies/"+companyId+"/knowledge/retrieve","POST",{query:"What are support hours?",limit:4});
 if(!retrieve.chunks.some(x=>x.content.includes("09:00-18:00 Kyiv")))throw Error("Excel retrieval missing expected fact");
 const isolationSecret="COMPANY-B-ONLY-"+stamp;
 const companyB=await req("/companies","POST",{name:"NPATI-004 Company B "+stamp},"npati004-company-b-"+stamp);companyBId=companyB.id;
 const companyBDoc=await req("/companies/"+companyBId+"/knowledge/documents","POST",{filename:"company-b.txt",mimeType:"text/plain",data:Buffer.from(isolationSecret).toString("base64")},"npati004-company-b-doc-"+stamp);
 await waitDoc(companyBId,companyBDoc.id);
 const companyBRetrieve=await req("/companies/"+companyBId+"/knowledge/retrieve","POST",{query:isolationSecret,limit:4});
 if(!companyBRetrieve.chunks.some(x=>x.content.includes(isolationSecret)))throw Error("Company B control retrieval failed");
 const companyARetrieve=await req("/companies/"+companyId+"/knowledge/retrieve","POST",{query:isolationSecret,limit:4});
 if(companyARetrieve.chunks.some(x=>x.content.includes(isolationSecret)))throw Error("Company B knowledge leaked into Company A");
 const removedB=await raw("/companies/"+companyBId,"DELETE");if(removedB.status!==204)throw Error("Company B cleanup status="+removedB.status);companyBId=undefined;
 const removed=await raw("/companies/"+companyId,"DELETE");if(removed.status!==204)throw Error("company cleanup status="+removed.status);const remaining=Number(docker("exec","npati-agent-postgres","psql","-U","npati","-d","npati_agent","-Atc","select count(*) from companies where id='"+companyId+"'"));if(remaining!==0)throw Error("company cleanup remaining="+remaining);companyId=undefined;
 console.log(JSON.stringify({concurrentUploads:uploads.length,uniqueDocuments:documentIds.length,concurrentIdempotentDeletes:deleteResponses.length,cancelledDocumentState:cancelledState,documentStatus:document.status,chunks,distinctHashes:hashes,queuedCancellation:cancelled.run.status,crossTenantStatus:cross.status,crossCompanyRetrievalBlocked:true,retrievalMatched:true,recoveredAfterApiRedisWorkerRestart:true},null,2));
}finally{
 try{if(workerStopped)docker("start","npati-agent-company-worker")}catch{}
 try{docker("exec","npati-agent-postgres","psql","-U","npati","-d","npati_agent","-v","ON_ERROR_STOP=1","-c","DELETE FROM workspaces WHERE id='"+bWorkspace+"'; DELETE FROM users WHERE id='"+bUser+"';")}catch{}
 if(companyBId)await raw("/companies/"+companyBId,"DELETE").catch(()=>{});
 if(companyId)await raw("/companies/"+companyId,"DELETE").catch(()=>{});
}