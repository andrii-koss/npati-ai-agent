import { execFileSync,spawnSync } from "node:child_process";

const base=process.env.NPATI_API_URL??"http://localhost:3001";
const email=process.env.NPATI_TEST_EMAIL??"webuser1@example.com";
const password=process.env.NPATI_TEST_PASSWORD??"Password123!";
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const docker=(...args)=>execFileSync("docker",args,{encoding:"utf8"}).trim();
const sql=(query)=>docker("exec","npati-agent-postgres","psql","-U","npati","-d","npati_agent","-Atc",query);

async function waitHealthy(url,attempts=90){
  for(let i=0;i<attempts;i++){
    try{if((await fetch(url)).ok)return;}catch{}
    await sleep(1000);
  }
  throw new Error("Service did not become healthy: "+url);
}

async function waitContainerHealthy(name,attempts=90){
  for(let i=0;i<attempts;i++){
    const state=docker("inspect","--format={{.State.Health.Status}}",name);
    if(state==="healthy")return;
    await sleep(1000);
  }
  throw new Error("Container did not become healthy: "+name);
}

async function json(path,method="GET",body,token,idempotencyKey){
  const response=await fetch(base+path,{
    method,
    headers:{
      ...(token?{authorization:"Bearer "+token}:{}),
      ...(body?{"content-type":"application/json"}:{}),
      ...(idempotencyKey?{"idempotency-key":idempotencyKey}:{}),
    },
    body:body?JSON.stringify(body):undefined,
  });
  const text=await response.text();
  const value=text?JSON.parse(text):undefined;
  if(!response.ok)throw new Error(method+" "+path+" "+response.status+" "+text);
  return {status:response.status,value};
}

const stamp=Date.now();
let token,companyId,minioPaused=false;
try{
  await waitHealthy(base+"/health");
  const login=await json("/auth/login","POST",{email,password});
  token=login.value.tokens.accessToken;
  const company=await json("/companies","POST",{name:"File delete recovery "+stamp},token,"file-delete-company-"+stamp);
  companyId=company.value.id;
  const upload=await json(
    "/companies/"+companyId+"/knowledge/documents",
    "POST",
    {filename:"delete-recovery.txt",mimeType:"text/plain",data:Buffer.from("NPATI delete recovery "+stamp).toString("base64")},
    token,
    "file-delete-document-"+stamp,
  );
  const documentId=upload.value.id;
  const fileRow=sql("select f.id||'|'||f.bucket||'|'||f.object_key from files f join company_knowledge_documents d on d.file_id=f.id where d.id='"+documentId+"';");
  const [fileId,bucket,objectKey]=fileRow.split("|");
  if(!fileId||!bucket||!objectKey)throw new Error("Uploaded file metadata was not found");

  // Pause is deterministic: unlike graceful stop it cannot finish an already
  // pooled keep-alive request, so the API must hit its MinIO operation timeout.
  docker("pause","npati-agent-minio");
  minioPaused=true;
  const deleted=await json("/companies/"+companyId+"/knowledge/documents/"+documentId,"DELETE",undefined,token);
  if(deleted.status!==204)throw new Error("DELETE status="+deleted.status);
  const pending=sql("select (deleted_at is not null)||'|'||(storage_deleted_at is null) from files where id='"+fileId+"';");
  if(pending!=="true|true"&&pending!=="t|t")throw new Error("Delete was not retained as pending: "+pending);
  const failedAudit=sql("select outcome from file_audit where file_id='"+fileId+"' and action='delete' order by created_at desc limit 1;");
  if(failedAudit!=="failed")throw new Error("Expected failed delete audit, got: "+failedAudit);

  docker("unpause","npati-agent-minio");
  minioPaused=false;
  await waitContainerHealthy("npati-agent-minio");
  docker("restart","npati-agent-api");
  await waitHealthy(base+"/health");
  let recovered="";
  for(let i=0;i<30;i++){
    recovered=sql("select (storage_deleted_at is not null) from files where id='"+fileId+"';");
    if(recovered==="t"||recovered==="true")break;
    await sleep(1000);
  }
  if(recovered!=="t"&&recovered!=="true")throw new Error("Pending delete was not recovered after restart");
  const stat=spawnSync("docker",["exec","npati-agent-minio","mc","stat","/data/"+bucket+"/"+objectKey],{encoding:"utf8"});
  if(stat.status===0)throw new Error("MinIO object still exists after recovered cleanup");
  const cleanupAudit=sql("select outcome from file_audit where file_id='"+fileId+"' and action='cleanup' order by created_at desc limit 1;");
  if(cleanupAudit!=="succeeded")throw new Error("Expected successful cleanup audit, got: "+cleanupAudit);

  await json("/companies/"+companyId,"DELETE",undefined,token);
  companyId=undefined;
  console.log(JSON.stringify({strictAuth:true,deleteStatus:204,pendingAfterMinioFailure:true,failedDeleteAudited:true,recoveredAfterRestart:true,minioObjectRemoved:true,cleanupAudited:true},null,2));
}finally{
  if(minioPaused){try{docker("unpause","npati-agent-minio");await waitContainerHealthy("npati-agent-minio");}catch{}}
  try{await waitHealthy(base+"/health",10);}catch{try{docker("restart","npati-agent-api");await waitHealthy(base+"/health");}catch{}}
  if(companyId&&token){try{await json("/companies/"+companyId,"DELETE",undefined,token);}catch{}}
}
