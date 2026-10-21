import { readFile } from "node:fs/promises";
import { createHmac,randomUUID } from "node:crypto";
import { Pool } from "pg";
import { detectProjectStack } from "../apps/agent-api/src/project-preview-stack";
import { projectRuntimeCommandPort } from "../apps/agent-api/src/shared-project-runtime-provider";

const entries=JSON.parse((await readFile(process.argv[2]!,"utf8")).trim());
const pool=new Pool({connectionString:process.env.DATABASE_URL});
async function runner(operation:string,payload:any){
 const body=JSON.stringify({operation,payload}),timestamp=String(Date.now()),nonce=randomUUID();
 const signature=createHmac("sha256",process.env.NPATI_SANDBOX_RUNNER_SECRET!).update(timestamp+"."+nonce+"."+body).digest("hex");
 const r=await fetch(process.env.NPATI_SANDBOX_RUNNER_URL!+"/v1/sandbox",{method:"POST",headers:{"content-type":"application/json","x-npati-timestamp":timestamp,"x-npati-nonce":nonce,"x-npati-signature":signature},body,signal:AbortSignal.timeout(20000)});
 const data=await r.json();if(!r.ok)throw Error(data.error?.message||String(r.status));return data.result;
}
try{
 for(const entry of entries){
  const found=await pool.query("SELECT id,workspace_id,created_by,company_id,sandbox_id,framework,preview_port,last_build_status FROM projects WHERE id=$1 AND workspace_id=$2 AND company_id=$3 AND created_by=$4 AND sandbox_id=$5 AND status='previewing'",[entry.scope.projectId,entry.scope.workspaceId,entry.scope.companyId,entry.scope.userId,entry.id]);
  if(!found.rowCount)continue;
  const project=found.rows[0],base={scope:entry.scope,sandboxId:entry.id};
  let ready=false;
  for(let i=0;i<30;i++){try{await runner("getStatus",base);ready=true;break;}catch{await new Promise(r=>setTimeout(r,1000));}}
  if(!ready)throw Error("Runtime unavailable");
  const proxy={port:entry.port,path:"/",method:"GET",headers:{}};
  let response=await runner("proxyPreview",{...base,options:proxy}).catch(()=>null);
  if(!response||response.status>=500){
   const files=await runner("downloadFiles",base);
   const contents=new Map<string,string>(files.map((f:any)=>[f.path,f.content]));
   const stack=await detectProjectStack(files,async p=>contents.get(p)??"");
   const exposed=await runner("exposePort",{...base,port:project.preview_port||stack.port});
   const command=projectRuntimeCommandPort(project.last_build_status==="ready"&&stack.productionCommand?stack.productionCommand:stack.command,exposed.port);
   const started=await runner("startProcess",{...base,command,options:{timeoutMs:120000,outputLimitBytes:64000}});
   for(let i=0;i<45;i++){response=await runner("proxyPreview",{...base,options:{...proxy,port:exposed.port}}).catch(()=>null);if(response?.status<500)break;await new Promise(r=>setTimeout(r,1000));}
   if(!response||response.status>=500)throw Error("Could not restore Preview: "+project.id);
   await pool.query("INSERT INTO project_terminal_events(id,workspace_id,company_id,project_id,user_id,agent_id,sandbox_id,process_id,command_summary,risk_level,status,exit_code,output,duration_ms,created_at) VALUES($1,$2,$3,$4,$5,'system',$6,$7,$8,'controlled','running',NULL,'Preview resumed after local runtime update',0,now())",[randomUUID(),entry.scope.workspaceId,entry.scope.companyId,project.id,entry.scope.userId,entry.id,started.processId,command]);
  }
  console.info(JSON.stringify({projectId:project.id,previewStatus:response.status}));
 }
}finally{await pool.end();}
